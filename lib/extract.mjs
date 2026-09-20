/**
 * 从会话事件流**机械提炼**交接文档。
 *
 * ## 设计原则
 *
 * 1. **绝不调用任何模型**。要交接的时刻正是模型已经不可靠的时刻，
 *    所以交接文档必须由规则从日志推导，与模型状态无关。
 * 2. **只读**。不写会话、不注入上下文。
 * 3. **对缺失字段健壮**。不同代际、不同工具集产生的事件形状有差异。
 *
 * ## 数据来源（全部已验证）
 *
 * | 字段 | 事件 |
 * |---|---|
 * | 会话元信息 | header 行 + `request/context` |
 * | 目标 | `goal/change`（无则退化为首条人类 user/message） |
 * | 用户请求 | `user/message`（`source.kind === 'user'`） |
 * | 各轮概要 | `turn/start` / `turn/end` / `assistant/message` |
 * | 工具使用 | `tool/call` |
 * | 文件修改 | `tool/call` 的 arguments（`path` / `file_path`） |
 * | 错误 | `tool/result` 的 `isError` + `turn/end.reason` |
 * | 待办 | `todo/write` |
 *
 * @module extract
 */

import { eventSeq, eventTime } from './session-log.mjs';
import { LEVEL_META } from './detect.mjs';
// 上下文规模的定义**只有一处**（`lib/handoff.js` 的 `contextTokensOf`）。
// 2026-09-15 复核实测：本文件原先也只认 `usage.totalTokens`，而全量语料里只有 52% 的
// 消息带它 —— 于是同一会话会出现"提示条说 13,652、离线提取说 0"这种最难查的矛盾。
import { contextTokensOf } from './handoff.js';

/** 从各类 content block 数组中提取纯文本。 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      // tool/result 的嵌套结构：{type:'tool-result', content:[{type:'text', text}]}
      parts.push(blocksToText(block.content));
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

/** 截断文本，超出时加省略号并标注原始长度。 */
function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}… (${flat.length} 字)`;
}

/** 安全解析 tool/call 的 arguments（原始 JSON 字符串）。 */
function parseArguments(raw) {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 解析 `ask_user_question` 的结果，提取用户的真实回答。
 *
 * ⚠️ 这是重要的用户意图来源：用户对提问的回答**不会**进入 `user/message` 事件，
 * 而是作为**工具结果**返回。只统计 `user/message` 会漏掉这些交互
 * （实测：某会话 9 次人类输入中，有 3 次是这样来的）。
 *
 * 结果结构：`{"answers":[{"id":"...","selected":[...],"custom":"..."}]}`
 */
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

/** 判断一个 tool/call 是否修改了文件，并归一化出路径与操作。 */
function fileMutationOf(name, args) {
  // DSH 的文件工具在不同组合下名称不同，这里覆盖已知的几种
  const pathValue = args.path ?? args.file_path ?? args.filePath;
  if (typeof pathValue !== 'string' || !pathValue) return undefined;

  if (name === 'write') return { path: pathValue, op: 'create/overwrite' };
  if (name === 'edit') return { path: pathValue, op: 'edit' };

  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '');
    if (command === 'view') return undefined; // 只读查看，不算修改
    if (command === 'create') return { path: pathValue, op: 'create' };
    if (command === 'str_replace') return { path: pathValue, op: 'str_replace' };
    if (command === 'insert') return { path: pathValue, op: 'insert' };
    return { path: pathValue, op: command || 'edit' };
  }

  return undefined;
}

/**
 * 提炼一份交接数据。
 *
 * @param {{header: object, events: object[]}} session
 * @returns {object} 结构化交接数据（渲染见 `renderHandoff`）
 */
export function extractHandoff(session) {
  const { header = {}, events = [] } = session;

  const state = {
    title: undefined,
    goal: undefined,
    requestContext: undefined,
    userRequests: [],
    turns: [],
    toolCounts: new Map(),
    files: new Map(),
    errors: [],
    todos: undefined,
    todosTurn: undefined,
    usage: { outputTokens: 0, lastContextTokens: 0, replies: 0 },
    stepCount: 0,
    pendingCalls: new Map(),
    lastEventTime: undefined,
    openTurn: undefined,
    compactionCount: 0,
  };

  /** 按 turn 号索引正在收集的轮次。 */
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
      });
    }
    return turns.get(n);
  };

  // ---- 逐事件折叠 ----
  for (const event of events) {
    const type = event.type;
    const data = event.data ?? {};
    const time = eventTime(event);
    if (typeof time === 'number') state.lastEventTime = time;

    switch (type) {
      case 'session/title': {
        const t = data.title ?? data.text;
        if (typeof t === 'string' && t) state.title = t;
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
        // 每次都是完整快照或 clear 墓碑
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
        // 2026-09-18 审查 C1 修复：与 `lib/handoff.js` 的 `foldSession` **同口径** ——
        // 被实时思考守卫主动中止（`agent.cancel({kind:'hook'})`）**不算流程错误**，
        // 否则同一会话在这条"离线基准"路径上会多出 1 条 error，测试报"不一致"。
        const r = data.reason;
        const hookReason =
          r && r.kind === 'aborted' && r.reason && r.reason.kind === 'hook'
            ? String(r.reason.reason ?? '')
            : '';
        if (t.reason !== 'completed' && !hookReason.includes('attention-health')) {
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
        // 只有 source.kind === 'user' 才是真实人类输入；
        // 其余是 agent.inject() / 工具结果 / goal 续跑等合成消息
        const kind = data.source?.kind;
        const text = blocksToText(data.content);
        if (kind === 'user' && text) {
          state.userRequests.push({
            seq: eventSeq(event),
            time,
            text,
            turn: state.openTurn,
            via: 'message',
          });
          if (state.openTurn !== undefined) {
            const t = ensureTurn(state.openTurn);
            if (!t.prompt) t.prompt = text;
          }
        }
        break;
      }

      case 'assistant/message': {
        const text = blocksToText(data.message?.content);
        const usage = data.usage ?? {};
        // ⚠️ 不要累加 inputTokens：那只是未命中缓存的部分（实测可低至 142）。
        // 输出 token 累加有意义；上下文规模走**与热路径同一个定义**（含三项相加兜底）。
        if (typeof usage.outputTokens === 'number') state.usage.outputTokens += usage.outputTokens;
        const ctxTokens = contextTokensOf(usage);
        if (ctxTokens > 0) {
          state.usage.lastContextTokens = ctxTokens;
        }
        state.usage.replies += 1;

        const turnNo = data.turn;
        if (turnNo !== undefined && text) {
          ensureTurn(turnNo).response = text;
        }
        break;
      }

      case 'tool/call': {
        const name = String(data.name ?? 'unknown');
        if (data.callId) state.pendingCalls.set(data.callId, name);
        state.toolCounts.set(name, (state.toolCounts.get(name) ?? 0) + 1);
        if (data.turn !== undefined) ensureTurn(data.turn).tools += 1;

        const mutation = fileMutationOf(name, parseArguments(data.arguments));
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
        break;
      }

      case 'tool/result': {
        const block = data.message?.content?.[0];
        const isError = block?.isError === true || Boolean(data.error);

        // 用户对 ask_user_question 的回答走工具结果，必须单独提取
        if (!isError && state.pendingCalls.get(block?.toolCallId) === 'ask_user_question') {
          const answers = parseQuestionAnswers(blocksToText(data.message?.content));
          for (const text of answers) {
            state.userRequests.push({
              seq: eventSeq(event),
              time,
              text,
              turn: state.openTurn,
              via: 'question',
            });
          }
        }

        if (isError) {
          const detail = blocksToText(data.message?.content);
          state.errors.push({
            kind: 'tool',
            turn: data.turn,
            name: data.error?.name,
            code: data.error?.code,
            detail: clip(detail, 160),
          });
          if (data.turn !== undefined) ensureTurn(data.turn).errors += 1;
        }
        break;
      }

      case 'todo/write': {
        // ⚠️ todo 投影会在每个 turn/start 被重置为 null，
        // 所以这里自己折叠：记录最后一条 todo/write 及其所属轮次
        if (Array.isArray(data.todos)) {
          state.todos = data.todos;
          state.todosTurn = state.openTurn;
        }
        break;
      }

      case 'compaction/summary':
        state.compactionCount += 1;
        break;

      default:
        break;
    }
  }

  const turnList = [...turns.values()].sort((a, b) => a.turn - b.turn);

  return {
    header: {
      id: header.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      agentPreset: header.agentPreset,
      delegationDepth: header.delegationDepth,
      version: header.version,
    },
    title: state.title,
    goal: state.goal,
    requestContext: state.requestContext,
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
    errors: state.errors,
    todos: state.todos,
    todosTurn: state.todosTurn,
    usage: state.usage,
    stepCount: state.stepCount,
    lastEventTime: state.lastEventTime,
    openTurn: state.openTurn,
    compactionCount: state.compactionCount,
  };
}

// 2026-09-18 审查 B2：`renderHandoff()`（约 214 行）已在此删除 ——
// 它自 2026-09-15 起就标着 `@deprecated` 且**零调用者**（离线 CLI 与插件
// 都走 `lib/handoff.js` 的 `buildHandoff()`）。留着这份旧渲染实现，只会让
// 下一个读代码的人误以为存在调用关系 —— 而它早已和主实现漂移得很远。
// 注意：提取层的 `extractHandoff()` **保留**，`handoff-test` 仍用它做交叉基准。
