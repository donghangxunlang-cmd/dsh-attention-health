/**
 * handoff · 事件流折叠（冷会话日志 → 结构化事实）
 *
 * 把 append-only 的会话事件流折叠成"这次会话发生了什么"：目标、决策、错误、
 * 文件改动、上下文增长、退化计数、守卫中止。
 *
 * 依赖 core（口径与词表）、text（文本整理）、judge（退化判据）、plan（`HIT_RATE_WINDOW`）。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 1065–1762 行（共 698 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 */
import { COMMAND_TOOLS, DECISION_BROAD_TRIGGER, DECISION_KEYWORDS_BROAD_ALL, blocksToText, contextTokensOf } from './handoff-core.js';
import { clip, extractDecisionSentences, normalize, parseArguments, seqOf, timeOf } from './handoff-text.js';
import { DEGRADE_LABELS, replyDegradeReasons, scanReasoning } from './handoff-judge.js';
import { HIT_RATE_WINDOW } from './handoff-plan.js';
// ─────────────────────────── 命令写文件解析 ───────────────────────────

/**
 * 从一条命令行里挑出"可能在写文件"的动作。
 *
 * ⚠️ 这是**启发式**：DSH 文件工具（write/edit）能精确记录改动，但通过 `pwsh`/`bash`
 * 直接写文件不会被结构化记录。这里尽力挑出来，渲染时单独标注「可能涉及（来自命令）」，
 * 不与文件工具清单混为一谈。
 */
function commandFileWrites(command) {
  const text = String(command ?? '');
  if (!text) return [];

  const found = new Map();
  const add = (p, op) => {
    const clean = String(p ?? '').replace(/^["']|["']$/g, '').trim();
    if (!clean || clean.length > 260) return;
    if (!/[\\/.]/.test(clean)) return;
    if (/^(nul|\/dev\/null|con)$/i.test(clean)) return;
    const key = `${clean}\u0000${op}`;
    if (!found.has(key)) found.set(key, { path: clean, op });
  };

  const rules = [
    [/\bSet-Content\s+(?:-LiteralPath\s+|-Path\s+|-FilePath\s+)?["']([^"'\r\n]+)["']/gi, 'set-content'],
    [/\bAdd-Content\s+(?:-LiteralPath\s+|-Path\s+|-FilePath\s+)?["']([^"'\r\n]+)["']/gi, 'add-content'],
    [/\bOut-File\s+(?:-LiteralPath\s+|-FilePath\s+|-Path\s+)?["']([^"'\r\n]+)["']/gi, 'out-file'],
    [/\bNew-Item\b[^|;\r\n]*?-Path\s+["']([^"'\r\n]+)["']/gi, 'new-item'],
    [/\bCopy-Item\b[^|;\r\n]*?-Destination\s+["']([^"'\r\n]+)["']/gi, 'copy-item'],
    [/\bMove-Item\b[^|;\r\n]*?-Destination\s+["']([^"'\r\n]+)["']/gi, 'move-item'],
    [/(?:^|[\s|;])>+\s*["']?([^"'\s|;&>]+)["']?/g, 'redirect'],
  ];

  for (const [re, op] of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) add(m[1], op);
  }

  return [...found.values()];
}

function fileMutationOf(name, args) {
  const pathValue = args.path ?? args.file_path ?? args.filePath;
  if (typeof pathValue !== 'string' || !pathValue) return undefined;

  if (name === 'write') return { path: pathValue, op: 'create/overwrite' };
  if (name === 'edit') return { path: pathValue, op: 'edit' };

  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '');
    if (command === 'view') return undefined;
    if (command === 'create') return { path: pathValue, op: 'create' };
    if (command === 'str_replace') return { path: pathValue, op: 'str_replace' };
    if (command === 'insert') return { path: pathValue, op: 'insert' };
    return { path: pathValue, op: command || 'edit' };
  }

  return undefined;
}

function parseQuestionAnswers(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.answers)) return [];
    const out = [];
    for (const answer of obj.answers) {
      const parts = [];
      if (Array.isArray(answer.selected) && answer.selected.length) {
        parts.push(answer.selected.join('、'));
      }
      if (typeof answer.custom === 'string' && answer.custom.trim()) {
        parts.push(answer.custom.trim());
      }
      if (parts.length) out.push(parts.join(' —— '));
    }
    return out;
  } catch {
    return [];
  }
}

// ─────────────────────────── 折叠 ───────────────────────────

/**
 * 把事件流折叠成结构化交接数据。与 `lib/extract.mjs` 同构，额外收集本次增强所需信息。
 *
 * @param {object[]} events - DSH 会话原始事件
 * @returns {object} 结构化交接数据
 */
export function foldSession(events) {
  const list = Array.isArray(events) ? events : [];

  const state = {
    title: undefined,
    titleHistory: [],
    goal: undefined,
    requestContext: undefined,
    userRequests: [],
    toolCounts: new Map(),
    files: new Map(),
    commandFiles: new Map(),
    errors: [],
    decisions: new Map(),
    todos: undefined,
    todosTurn: undefined,
    usage: { outputTokens: 0, lastContextTokens: 0, replies: 0 },
    stepCount: 0,
    pendingCalls: new Map(),
    lastEventTime: undefined,
    openTurn: undefined,
    compactionCount: 0,
    // ── 压缩事实（需求补充 1/2）：只记账，绝不干预官方 compaction ──
    compactions: [],
    summaryCount: 0,
    pruneCount: 0,
    pendingCompaction: undefined,
    awaitingCompactionAfter: false,
    afterCompactionPercent: undefined,
    lastCompactionAfterTokens: undefined,
    lastCompactionPreTokens: undefined,
    lastCompaction: undefined,
    // ── 真实用量（成本估算用最后一次请求的缓存命中/未命中）──
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    /**
     * 输出 token 的**累计与计数**（2026-09-16 接入真实价格后新增）。
     *
     * 为什么必须单独统计：输出 4 元/百万，是未命中输入价（1 元）的 4 倍，
     * 而旧成本模型只算输入、完全不算输出 —— 等于把最贵的那部分钱漏掉了。
     * 取**全会话平均**而不是最后一次：单次输出波动极大（思考打转那一次能到 25 万），
     * 拿它当"每轮输出"会把后续每一轮的成本都算飞。
     */
    outputTokensSum: 0,
    outputTokensCount: 0,
    /**
     * 带 `usage` 的请求次数（2026-09-16 审查 P2 新增）。
     *
     * 用来把"**缓存还没建立**"与"**缓存崩了**"分开：新会话第一次请求
     * `cacheReadTokens` 必然是 0（那时前缀还没被缓存过），这与"用着用着缓存整体失效"
     * 是两件完全不同的事。只看"有没有数据"会把前者误判成后者，
     * 于是在首轮读了个大文件的会话上直接给出"该压缩/该新开"的错误建议。
     */
    usageCount: 0,
    /**
     * 尾部窗口的用量读数（2026-09-16 实测新增）：最近 `HIT_RATE_WINDOW` 次请求的
     * `{ hit, total }`。**成本判定用它的累计命中率，而不是最后一次的读数。**
     *
     * 依据（`work/hitrate-recovery-probe.mjs`）：在 13 段"会触发交接"的时刻里，
     * **10 段在 3 轮内自愈**（0.0% → 96%~99.9%）—— 那些"崩塌"是单次事件
     * （压缩重建前缀、大文件读入改写前缀），拿单次快照推断"往后每轮都按未命中价付"
     * 会系统性高估继续成本、误报交接。而**持续**低命中会随窗口滑出逐步降下来，照样能触发。
     */
    recentUsage: [],
    /** 实时思考守卫的中止记录（2026-09-16 新增，与 host 投影同口径）。 */
    guardTripCount: 0,
    lastGuardReason: null,
    lastGuardTurn: null,
    // ── 维度 A 的退化信号（冷会话没有 projection 时，由日志折叠得出）──
    lastCallKey: undefined,
    callStreak: 0,
    repeatWorst: 0,
    degradedReplies: 0,
    // 命中原因计数（N-5）：提示条与交接文档都要说明"为什么判退化"
    replyReasons: new Map(),
    reasoningFlags: 0,
    reasoningLoop: 0,
    reasoningWorstRepeat: 0,
    reasoningWorstTokens: 0,
    reasoningReasons: new Map(),
    // 决策句兜底重抽的文本来源（N-5 附带）：不进返回值，只在 foldSession 末尾用一次。
    decisionSources: [],
    broadFallback: false,
  };

  const turns = new Map();
  const ensureTurn = (n) => {
    if (!turns.has(n)) {
      turns.set(n, {
        turn: n,
        prompt: undefined,
        response: undefined,
        tools: 0,
        errors: 0,
        reason: undefined,
        startedAt: undefined,
        endedAt: undefined,
        outputTokens: 0,
        toolResultChars: 0,
        contextTokens: undefined,
      });
    }
    return turns.get(n);
  };

  const rememberDecision = (sentence, role, turn, seq, time) => {
    const key = normalize(sentence);
    if (!key) return;
    const existing = state.decisions.get(key);
    if (existing) {
      if (turn !== undefined && !existing.turns.includes(turn)) existing.turns.push(turn);
      return;
    }
    state.decisions.set(key, {
      text: sentence,
      role,
      turn,
      turns: turn === undefined ? [] : [turn],
      seq,
      time,
    });
  };

  for (const event of list) {
    const type = event?.type;
    const data = event?.data ?? {};
    const time = timeOf(event);
    if (typeof time === 'number') state.lastEventTime = time;

    switch (type) {
      case 'session/title': {
        const t = data.title ?? data.text;
        if (typeof t === 'string' && t && t !== state.title) {
          state.title = t;
          state.titleHistory.push({ seq: seqOf(event), time, title: t });
        }
        break;
      }

      case 'request/context': {
        state.requestContext = {
          provider: data.provider,
          model: data.model,
          contextWindow: data.contextWindow,
        };
        break;
      }

      case 'goal/change': {
        if (data.operation === 'clear' || !data.goal) {
          state.goal = undefined;
        } else {
          const g = data.goal;
          state.goal = {
            objective: g.objective,
            phase: g.phase,
            blockedReason: g.blockedReason?.message,
            roundsStarted: data.roundsStarted,
            maxGoalRounds: g.maxGoalRounds,
          };
        }
        break;
      }

      case 'turn/start': {
        const t = ensureTurn(data.turn);
        t.startedAt = time;
        state.openTurn = data.turn;
        break;
      }

      case 'turn/end': {
        const t = ensureTurn(data.turn);
        t.endedAt = time;
        t.reason = data.reason?.kind ?? 'unknown';
        // 2026-09-16：识别「被实时思考守卫中止」——必须与 host 投影同口径，
        // 否则会出现"提示条说被中止、交接文档只字未提"的分叉。
        const r = data.reason;
        const hookReason =
          r && r.kind === 'aborted' && r.reason && r.reason.kind === 'hook'
            ? String(r.reason.reason ?? '')
            : '';
        const guardTrip = hookReason.includes('attention-health');
        if (guardTrip) {
          state.guardTripCount = Math.min(99, (state.guardTripCount ?? 0) + 1);
          state.lastGuardReason = hookReason.replace(/^\s*attention-health[：:]\s*/, '');
          state.lastGuardTurn = data.turn;
        }
        // 主动保护**不算错误**：它是有意的止损，不是流程故障。
        // （旧实现会把每一次守卫中止都塞进"未解决技术问题"，属于误分类。）
        if (t.reason !== 'completed' && !guardTrip) {
          state.errors.push({
            kind: 'turn',
            turn: data.turn,
            reason: t.reason,
            detail: data.reason?.error?.message,
          });
        }
        state.openTurn = undefined;
        break;
      }

      case 'step/start':
        state.stepCount += 1;
        break;

      case 'user/message': {
        const kind = data.source?.kind;
        const text = blocksToText(data.content);
        if (kind === 'user' && text) {
          state.userRequests.push({
            seq: seqOf(event),
            time,
            text,
            turn: state.openTurn,
            via: 'message',
          });
          if (state.openTurn !== undefined) {
            const t = ensureTurn(state.openTurn);
            if (!t.prompt) t.prompt = text;
          }
          // 用户自己写的话里也可能有"决定/待确认"；只对长文本抽，保信噪比
          if (text.length > 80) {
            for (const s of extractDecisionSentences(text)) {
              rememberDecision(s, 'user', state.openTurn, seqOf(event), time);
            }
            state.decisionSources.push({
              text,
              role: 'user',
              turn: state.openTurn,
              seq: seqOf(event),
              time,
            });
          }
        }
        break;
      }

      case 'assistant/message': {
        const text = blocksToText(data.message?.content);
        const usage = data.usage ?? {};
        if (typeof usage.outputTokens === 'number') state.usage.outputTokens += usage.outputTokens;
        // 上下文规模：**与热路径同一个定义**（`contextTokensOf`，含"三项相加"兜底）。
        // 2026-09-15 复核实测：原先只认 `usage.totalTokens`，而全量语料里只有 52% 的消息带它 ——
        // 于是同一会话会出现"提示条说 13,652、交接文档说 0 且判 100 分正常"，
        // 正是本项目反复吃亏的"两处口径分叉"里最难查的一种。
        const ctxTokens = contextTokensOf(usage);
        if (ctxTokens > 0) {
          state.usage.lastContextTokens = ctxTokens;
        }
        // 缓存命中 / 未命中：取**最后一次**请求的真实值（成本估算的输入）
        if (typeof usage.cacheReadTokens === 'number') state.cacheReadTokens = usage.cacheReadTokens;
        if (typeof usage.inputTokens === 'number') state.cacheMissTokens = usage.inputTokens;
        // 输出 token：**累计求和**（成本模型按全会话平均输出算钱，见字段注释）
        if (Number.isFinite(usage.outputTokens) && usage.outputTokens > 0) {
          state.outputTokensSum += usage.outputTokens;
          state.outputTokensCount += 1;
        }
        // 请求次数（审查 P2）：用于判断"缓存是否已经建立"（首轮零命中是常态）
        state.usageCount += 1;
        // 尾窗读数（2026-09-16 实测新增）：成本判定用最近 N 次的累计命中率。
        // 只在这一轮**确实带用量**时计入（否则会把上一轮的旧值重复入窗）。
        if (typeof usage.cacheReadTokens === 'number' || typeof usage.inputTokens === 'number') {
          const wHit = Math.max(0, state.cacheReadTokens);
          const wTotal = wHit + Math.max(0, state.cacheMissTokens);
          if (wTotal > 0) {
            state.recentUsage.push({ hit: wHit, total: wTotal });
            if (state.recentUsage.length > HIT_RATE_WINDOW) state.recentUsage.shift();
          }
        }
        // 压缩后的第一次请求 → 记下"压缩后占用"（百分比 + 真实 token）。
        // 真实 token 是"不可压缩基线"的实测值，用来判断压缩是否救得回来、
        // 以及估算"再压一次还能压掉多少"（避免在刚压缩过的会话上误报压缩收益）。
        if (state.awaitingCompactionAfter && ctxTokens > 0) {
          const cw = state.requestContext?.contextWindow;
          if (typeof cw === 'number' && cw > 0) state.afterCompactionPercent = (ctxTokens / cw) * 100;
          state.lastCompactionAfterTokens = ctxTokens;
          if (state.lastCompaction) state.lastCompaction.afterUsedTokens = ctxTokens;
          state.awaitingCompactionAfter = false;
        }
        state.usage.replies += 1;

        const turnNo = data.turn ?? state.openTurn;
        if (turnNo !== undefined) {
          const t = ensureTurn(turnNo);
          if (typeof usage.outputTokens === 'number') t.outputTokens += usage.outputTokens;
          if (ctxTokens > 0) {
            t.contextTokens = ctxTokens;
          }
          if (text) t.response = text;
        }

        if (text) {
          // 退化信号 ②：输出退化（复读 / 代码块不闭合 / 段落重复 / 符号堆砌）
          const replyReasons = replyDegradeReasons(text);
          if (replyReasons.length) {
            state.degradedReplies += 1;
            for (const key of replyReasons) {
              state.replyReasons.set(key, (state.replyReasons.get(key) ?? 0) + 1);
            }
          }
          for (const s of extractDecisionSentences(text)) {
            rememberDecision(s, 'assistant', turnNo, seqOf(event), time);
          }
          state.decisionSources.push({ text, role: 'assistant', turn: turnNo, seq: seqOf(event), time });
        }

        // 退化信号 ③：思考过程退化（N-5）—— 真实事故里唯一能看到的信号。
        // 打转优先归类（它同时可能满足"异常长"，但严重度不同）。
        {
          const scan = scanReasoning(data.message?.content, usage);
          if (scan.flagged) {
            // 与 plugin/index.js 同口径（2026-09-18 修复）：`symbolRun` 不计入
            // `reasoningFlags` —— 它是精确率存疑的弱信号，不该参与交接判定。
            // 详见 index.js 同处的长注释与 README「二次复核」一节。
            if (scan.reasons.includes('thinkLoop')) state.reasoningLoop += 1;
            else if (scan.reasons.includes('thinkHuge')) state.reasoningFlags += 1;
            for (const key of scan.reasons) {
              state.reasoningReasons.set(key, (state.reasoningReasons.get(key) ?? 0) + 1);
            }
            if (scan.worstRepeat > state.reasoningWorstRepeat) {
              state.reasoningWorstRepeat = scan.worstRepeat;
            }
            // 真实计量峰值：用于在文档里说明"单次思考最长烧掉多少 token"
            if (scan.reasoningTokens > state.reasoningWorstTokens) {
              state.reasoningWorstTokens = scan.reasoningTokens;
            }
          }
        }
        break;
      }

      case 'tool/call': {
        const name = String(data.name ?? 'unknown');
        if (data.callId) state.pendingCalls.set(data.callId, name);
        state.toolCounts.set(name, (state.toolCounts.get(name) ?? 0) + 1);
        const turnNo = data.turn ?? state.openTurn;
        if (turnNo !== undefined) ensureTurn(turnNo).tools += 1;

        // 退化信号 ①：连续完全相同的工具调用（与 projection 同一判据）
        const callKey = `${name}\u0000${data.arguments ?? ''}`;
        state.callStreak = callKey === state.lastCallKey ? state.callStreak + 1 : 1;
        state.repeatWorst = Math.max(state.repeatWorst, state.callStreak);
        state.lastCallKey = callKey;

        const args = parseArguments(data.arguments);

        // ① 文件工具：结构化、可信
        const mutation = fileMutationOf(name, args);
        if (mutation) {
          const entry = state.files.get(mutation.path) ?? {
            path: mutation.path,
            ops: new Map(),
            count: 0,
          };
          entry.count += 1;
          entry.ops.set(mutation.op, (entry.ops.get(mutation.op) ?? 0) + 1);
          state.files.set(mutation.path, entry);
        }

        // ② 命令行：启发式、单独归类
        if (COMMAND_TOOLS.has(name)) {
          for (const write of commandFileWrites(args.command)) {
            const key = `${write.path}\u0000${write.op}`;
            const entry = state.commandFiles.get(key) ?? {
              path: write.path,
              op: write.op,
              count: 0,
              turns: [],
            };
            entry.count += 1;
            if (turnNo !== undefined && !entry.turns.includes(turnNo)) entry.turns.push(turnNo);
            state.commandFiles.set(key, entry);
          }
        }
        break;
      }

      case 'tool/result': {
        const block = data.message?.content?.[0];
        const isError = block?.isError === true || Boolean(data.error);
        const bodyText = blocksToText(data.message?.content);

        const turnNo = data.turn ?? state.openTurn;
        if (turnNo !== undefined && bodyText) {
          ensureTurn(turnNo).toolResultChars += bodyText.length;
        }

        if (!isError && state.pendingCalls.get(block?.toolCallId) === 'ask_user_question') {
          const answers = parseQuestionAnswers(bodyText);
          for (const text of answers) {
            state.userRequests.push({
              seq: seqOf(event),
              time,
              text,
              turn: state.openTurn,
              via: 'question',
            });
            for (const s of extractDecisionSentences(text)) {
              rememberDecision(s, 'user-answer', state.openTurn, seqOf(event), time);
            }
          }
        }

        if (isError) {
          state.errors.push({
            kind: 'tool',
            turn: turnNo,
            name: data.error?.name ?? block?.toolName,
            code: data.error?.code,
            detail: clip(bodyText, 160),
          });
          if (turnNo !== undefined) ensureTurn(turnNo).errors += 1;
        }
        break;
      }

      case 'todo/write': {
        if (Array.isArray(data.todos)) {
          state.todos = data.todos;
          state.todosTurn = state.openTurn;
        }
        break;
      }

      case 'compaction/start': {
        // 只记标记；事实在 summary / prune 落地。sourceCommandId 存在 = 人工 /compact
        state.pendingCompaction = {
          id: data.compactionId,
          manual: Boolean(data.sourceCommandId),
          turn: data.turn ?? state.openTurn,
          time,
          seq: seqOf(event),
        };
        break;
      }

      case 'compaction/summary': {
        // 模型摘要：消耗 token、有损。shadowedTokenCount 是被替换掉的精确 token 数。
        const pending = state.pendingCompaction ?? {};
        const shadowed = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0;
        const summaryText = blocksToText(data.summary);
        const usageOut = typeof data.usage?.outputTokens === 'number' ? data.usage.outputTokens : 0;
        const summaryInput =
          typeof data.usage?.inputTokens === 'number' ? data.usage.inputTokens : shadowed;

        state.compactionCount += 1;
        state.summaryCount += 1;
        state.awaitingCompactionAfter = true;
        state.lastCompaction = {
          seq: seqOf(event),
          time,
          kind: 'summary',
          manual: Boolean(data.sourceCommandId) || Boolean(pending.manual),
          model: typeof data.model === 'string' ? data.model : undefined,
          provider: typeof data.provider === 'string' ? data.provider : undefined,
          shadowedTokens: shadowed,
          summaryTokens: usageOut > 0 ? usageOut : Math.round(summaryText.length / 4),
          summaryInputTokens: summaryInput,
          preUsedTokens: state.usage.lastContextTokens,
          summaryChars: summaryText.length,
          turn: pending.turn ?? state.openTurn,
        };
        state.compactions.push(state.lastCompaction);
        state.pendingCompaction = undefined;
        break;
      }

      case 'compaction/prune': {
        // 零 token 裁剪（不调模型）：工具结果修剪等。同样带被替换范围的启发式 token 价。
        const shadowed = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0;
        const pendingPrune = state.pendingCompaction ?? {};
        state.compactionCount += 1;
        state.pruneCount += 1;
        state.awaitingCompactionAfter = true;
        state.lastCompaction = {
          seq: seqOf(event),
          time,
          kind: 'prune',
          // 手动 /compact 若只触发裁剪，别被标成"自动"（2026-09-15 审查修复）
          manual: Boolean(data.sourceCommandId) || Boolean(pendingPrune.manual),
          model: undefined,
          provider: undefined,
          shadowedTokens: shadowed,
          summaryTokens: 0,
          summaryInputTokens: 0,
          preUsedTokens: state.usage.lastContextTokens,
          summaryChars: 0,
          turn: state.openTurn,
        };
        state.compactions.push(state.lastCompaction);
        state.pendingCompaction = undefined;
        break;
      }

      case 'compaction/end': {
        // 失败的压缩会带 error：标注到最后一条压缩记录上，便于区分"压缩失败"
        if (data.error && state.lastCompaction) state.lastCompaction.error = String(data.error);
        state.pendingCompaction = undefined;
        break;
      }

      default:
        break;
    }
  }

  const turnList = [...turns.values()].sort((a, b) => a.turn - b.turn);

  // 每轮上下文增量：本轮结束规模 − 上一轮结束规模。
  // 压缩会让规模**掉下去**（负增量），这里保留负值并标记该轮发生压缩 —— 早期版本用
  // Math.max(0, ...) 夹成 0，压缩轮会显示"+0"，把压缩省下的量藏了起来。
  // 2026-09-16 修正：**第一轮没有前一轮，不该把它的绝对值当成"增量"** ——
  // 旧写法从 0 起算，于是首轮显示一个巨大的"+"，并污染"增长最快的轮次"。
  let previous = null;
  for (const t of turnList) {
    if (t.contextTokens === undefined) {
      t.contextDelta = undefined;
      continue;
    }
    const current = t.contextTokens;
    if (previous === null) {
      t.contextDelta = undefined; // 无前轮可比
    } else {
      t.contextDelta = current - previous;
      if (t.contextDelta < 0) t.compacted = true;
    }
    previous = current;
  }

  // ── 决策句的**会话级分级兜底**（N-5 附带，复核第三次提出的跨领域词表）──
  // 主词表偏工程 / 取舍语境，实测咨询、报表、生活对话常常一条都抽不到
  // （"散件合计约 11900 元"、"更推荐去本地口碑好的维修店"这类数字结论会整体漏掉）。
  // 整场会话主词表命中不足 `DECISION_BROAD_TRIGGER` 条时，才用通用结论词重抽一遍。
  // 实测只影响 19/67 个会话、全量多 16 条，主词表够用的会话输出完全不变。
  if (state.decisions.size < DECISION_BROAD_TRIGGER) {
    state.broadFallback = true;
    for (const src of state.decisionSources) {
      for (const s of extractDecisionSentences(src.text, DECISION_KEYWORDS_BROAD_ALL)) {
        rememberDecision(s, src.role, src.turn, src.seq, src.time);
      }
    }
  }

  return {
    userRequests: state.userRequests,
    turns: turnList,
    toolCounts: [...state.toolCounts.entries()].sort((a, b) => b[1] - a[1]),
    files: [...state.files.values()]
      .map((f) => ({
        path: f.path,
        count: f.count,
        ops: [...f.ops.entries()].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.count - a.count),
    commandFiles: [...state.commandFiles.values()].sort((a, b) => b.count - a.count),
    errors: state.errors,
    decisions: [...state.decisions.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    todos: state.todos,
    todosTurn: state.todosTurn,
    usage: state.usage,
    stepCount: state.stepCount,
    lastEventTime: state.lastEventTime,
    openTurn: state.openTurn,
    compactionCount: state.compactionCount,
    compactions: state.compactions,
    summaryCount: state.summaryCount,
    pruneCount: state.pruneCount,
    afterCompactionPercent: state.afterCompactionPercent,
    lastCompactionAfterTokens: state.lastCompactionAfterTokens,
    lastCompaction: state.lastCompaction,
    cacheReadTokens: state.cacheReadTokens,
    cacheMissTokens: state.cacheMissTokens,
    // 每轮平均输出 token（真实价格口径要算输出费；0 时由 COMPACT_DEFAULTS 兜底）
    avgOutputTokens:
      state.outputTokensCount > 0 ? state.outputTokensSum / state.outputTokensCount : 0,
    // 请求次数（审查 P2：用于区分"缓存还没建立"与"缓存崩了"）
    usageCount: state.usageCount,
    // 尾部窗口用量（2026-09-16）：成本判定用累计命中率，见 state.recentUsage 的注释
    recentUsage: state.recentUsage,
    // 实时思考守卫的中止记录（2026-09-16）
    guardTripCount: state.guardTripCount,
    lastGuardReason: state.lastGuardReason,
    lastGuardTurn: state.lastGuardTurn,
    repeatWorst: state.repeatWorst,
    degradedReplies: state.degradedReplies,
    replyReasons: [...state.replyReasons.entries()].map(([key, count]) => ({
      key,
      count,
      label: DEGRADE_LABELS[key] ?? key,
    })),
    reasoningLoop: state.reasoningLoop,
    reasoningFlags: state.reasoningFlags,
    reasoningWorstRepeat: state.reasoningWorstRepeat,
    reasoningWorstTokens: state.reasoningWorstTokens,
    reasoningReasons: [...state.reasoningReasons.entries()].map(([key, count]) => ({
      key,
      count,
      label: DEGRADE_LABELS[key] ?? key,
    })),
    title: state.title,
    titleHistory: state.titleHistory,
    goal: state.goal,
    requestContext: state.requestContext,
    broadFallback: state.broadFallback,
  };
}

