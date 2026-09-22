/**
 * handoff · 计划推导（评分 → 继续 / 压缩 / 交接）
 *
 * 从折叠结果推出**行动结论**：`deriveCompactionPlan`（质量维度 + 规模维度 +
 * 成本维度 → 最终建议）、`deriveNextSteps`（待办）、`summarize`（长请求摘要）。
 *
 * 依赖 text（`clip` / `similarity`）。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 1763–2746 行（共 984 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 */
import { COMPACT_DEFAULTS } from './handoff-core.js';
import { clip, similarity } from './handoff-text.js';
// 价格与峰谷档位（T 节 2026-09-18）：价格不再是硬编码常量，而是按「模型 + 时刻」解析。
import { resolvePrice } from './prices.js';
// ─────────────────────────── 派生视图 ───────────────────────────

/**
 * 控制指令（不承载任务意图）：很短，或命中这些模式。
 *
 * 2026-09-15 审查实测：最后一条用户请求若是"继续""完成了？"，文档的「最新目标」
 * 就会变成那两个字，接手方按"以最新目标为准"去理解任务会完全跑偏。
 */
const CONTROL_PHRASES = [
  '继续', '接着', '好', '可以', '行', '嗯', 'ok', '下一步', '你看着办',
  '完成了？', '完成了吗', '别的ai', '其它ai', '其他ai', 'go on', 'continue',
];

/** 判断一条用户请求是不是"控制指令"而非任务描述。 */
export function isControlRequest(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (t.length <= 16 && CONTROL_PHRASES.some((p) => lower.includes(p.toLowerCase()))) return true;
  return false;
}

/**
 * 目标候选：优先最新 goal；否则取「最近一条**实质性**请求」。
 *
 * 实质性 = 跳过控制指令。同时把"最后一条指令"作为事实单独报出来（与插件的双口径风格一致），
 * 让读者能自己判断，而不是把"继续"当成目标。
 */
export function deriveGoal(x) {
  if (x.goal) {
    return { kind: 'goal', latest: x.goal.objective ?? '（无描述）', goal: x.goal };
  }
  const reqs = x.userRequests;
  if (!reqs.length) return null;

  const first = reqs[0];
  const lastReq = reqs[reqs.length - 1];

  let latest = lastReq;
  for (let i = reqs.length - 1; i >= 0; i -= 1) {
    if (!isControlRequest(reqs[i].text)) {
      latest = reqs[i];
      break;
    }
    if (i === 0) latest = reqs[0]; // 全是控制指令时退回第一条
  }

  const skippedControl = latest !== lastReq;
  const sim = similarity(first.text, latest.text);
  return {
    kind: 'request',
    latest: latest.text,
    first: first.text,
    same: sim >= 0.5,
    similarity: sim,
    latestTurn: latest.turn,
    firstTurn: first.turn,
    lastControl: skippedControl ? lastReq.text : undefined,
    lastControlTurn: skippedControl ? lastReq.turn : undefined,
  };
}

/**
 * 流程性重试：工具使用顺序导致的报错，**不是技术故障**。
 *
 * 2026-09-15 审查指出：`FS_NOT_OBSERVED`（改文件前没先读文件）这类会累积到十几条，
 * 被当作"最近仍出现（未解决）"列进"下一步"，会误导接手方去追一个根本不存在的问题。
 */
const PROCEDURAL_CODES = ['FS_NOT_OBSERVED', 'FS_EDIT_NOT_FOUND', 'FS_AMBIGUOUS_MATCH'];

/** 判断一组错误是否属于流程性重试。 */
function isProceduralRetry(group) {
  const code = String(group?.code ?? '');
  return PROCEDURAL_CODES.some((c) => code.includes(c));
}

/** 错误聚合：同类合并计数 + 轮次 + 是否仍复现。 */
export function aggregateErrors(x) {
  const groups = new Map();
  const maxTurn = x.turns.length ? x.turns[x.turns.length - 1].turn : undefined;

  for (const e of x.errors) {
    const key = e.kind === 'tool' ? `tool:${e.name ?? '?'}:${e.code ?? ''}` : `turn:${e.reason ?? '?'}`;
    const g = groups.get(key) ?? {
      key,
      kind: e.kind,
      name: e.name,
      code: e.code,
      reason: e.reason,
      count: 0,
      turns: [],
      details: [],
      firstTurn: undefined,
      lastTurn: undefined,
    };
    g.count += 1;
    if (e.turn !== undefined) {
      if (!g.turns.includes(e.turn)) g.turns.push(e.turn);
      if (g.firstTurn === undefined || e.turn < g.firstTurn) g.firstTurn = e.turn;
      if (g.lastTurn === undefined || e.turn > g.lastTurn) g.lastTurn = e.turn;
    }
    if (e.detail && g.details.length < 2 && !g.details.includes(e.detail)) g.details.push(e.detail);
    groups.set(key, g);
  }

  const list = [...groups.values()];
  for (const g of list) {
    g.turns.sort((a, b) => a - b);
    if (g.lastTurn === undefined || maxTurn === undefined) {
      g.stillActive = true;
      g.resolution = '无法判断（缺少轮次信息）';
    } else if (g.lastTurn >= maxTurn) {
      g.stillActive = true;
      g.resolution = '**最近一轮仍出现（未解决）**';
    } else {
      g.stillActive = false;
      g.resolution = `第 ${g.lastTurn} 轮之后未再出现（其后 ${maxTurn - g.lastTurn} 轮无复现）`;
    }
    g.label =
      g.kind === 'tool'
        ? `${g.name ?? '工具'}${g.code ? ` \`${g.code}\`` : ''}`
        : `轮次异常结束 \`${g.reason}\``;
  }

  return list.sort((a, b) => b.count - a.count);
}

/** 每轮上下文增长：返回全表与最快的 3 轮。 */
export function deriveGrowth(x) {
  const rows = x.turns
    .filter((t) => typeof t.contextDelta === 'number')
    .map((t) => ({
      turn: t.turn,
      contextTokens: t.contextTokens,
      delta: t.contextDelta,
      compacted: Boolean(t.compacted),
      outputTokens: t.outputTokens,
      toolResultChars: t.toolResultChars,
      toolResultTokensEst: Math.round(t.toolResultChars / 4), // 4 字符 ≈ 1 token（对齐 DSH 启发式）
      cause:
        t.toolResultChars / 4 > t.outputTokens * 2
          ? '大工具输出'
          : t.outputTokens > (t.toolResultChars / 4) * 2
            ? '模型长输出'
            : '混合',
    }));

  const top = [...rows].sort((a, b) => b.delta - a.delta).slice(0, 3);
  return { rows, top };
}

/** 压缩后需要重建前缀缓存的轮数（1~2 轮取中值）。 */
export const REBUILD_ROUNDS = 1.5;

/**
 * 交接文档的「字符 → token」换算系数（中英混排，取 2 字符/token 的保守值）。
 * 用于把「方案 C 的一次性成本」从写死的 12,000 换成**由实测文档长度回填**。
 */
export const HANDOFF_CHARS_PER_TOKEN = 2;

/** 判定"接近官方压缩线"的缓冲（声明窗口百分点）。 */
const OFFICIAL_LINE_MARGIN = 5;

/**
 * 命中率**尾部窗口**长度（2026-09-16 实测新增）。
 *
 * 成本判定用"最近 N 次请求的**累计**命中率"，而不是最后一次请求的读数 —— 依据见
 * `foldSession` 的 `recentUsage` 注释与 `work/hitrate-recovery-probe.mjs`。
 *
 * 取 20 的理由：单次抖动只占 5% 权重（不足以把结论拨到交接），两次连续抖动 10%
 * （仍然不够）；而**真的**持续崩塌会在约第 5~10 次之后把累计拉进触发区。
 * 这个延迟是刻意的 —— 先确认它不是一次性抖动，再劝人换会话。
 */
export const HIT_RATE_WINDOW = 20;

/**
 * 「压缩 vs 交接」成本模型与三态建议（需求补充 1/2）。
 *
 * 纯本地算术，**零模型调用**：用最后一次请求的真实 usage（缓存命中/未命中）、
 * 官方自动压缩线位置（声明窗口 × 80%）与压缩历史，估算三种方案的成本，
 * 再按阈值给出结论。**只提示，绝不自动执行压缩，也不改官方 compaction 配置。**
 *
 * @param {object} input
 * @param {number|null} [input.contextWindow] - 声明窗口
 * @param {number} [input.usedTokens] - 当前上下文规模
 * @param {number} [input.cacheReadTokens] - 最后一次请求命中的缓存 token
 * @param {number} [input.cacheMissTokens] - 最后一次请求未命中的输入 token
 * @param {number} [input.avgRoundGrowth] - 平均每轮上下文增长
 * @param {number} [input.compactionCount]
 * @param {object} [input.lastCompaction]
 * @param {number|null} [input.afterCompactionPercent] - 上次压缩后的**声明**窗口占比
 * @param {number} [input.handoffDocTokens] - 交接文档自身 token（冷启动全价）
 * @param {object} [input.thresholds] - 覆盖 COMPACT_DEFAULTS
 * @returns {object} 四个量 + 三方案成本 + 建议
 */
/**
 * 界面用的「一句话依据」文案表（2026-09-16 Codex 审查 O2：抽成常量，便于统一评审与断言）。
 *
 * 定位分工：
 *   · `final.reason` → **给交接文档**：完整论证，含数字与 Markdown 粗体，可以长；
 *   · `FINAL_NOTES.*` → **给界面**：无 Markdown、不复述已有数字，只说决策逻辑。
 * 缺数据那条刻意**不复述"按现状继续"**（结论已经在 `adviceText` 里），
 * 而是说明"怎样才会有数据" —— note 的职责是补充依据，不是改写结论。
 */
export const FINAL_NOTES = {
  overReliableRange: '已超出可靠工作区间且检出退化信号',
  /**
   * R-2（2026-09-18）：**守卫反复掐断**时的界面依据。
   *
   * 旧行为：这类会话靠成本驱动，界面显示的是"退化信号优先于压缩：压缩只腾空间，不修复退化"
   * —— 一句通用话术，用户看不出真实原因（模型在打转、被实时掐断）。现在直接点名守卫与次数。
   */
  guardTripped: (n) =>
    `本会话已 ${n} 次被实时守卫掐断思考空转（模型反复陷入循环）—— 建议交接后在新会话继续`,
  degradeBeatsCompact: '退化信号优先于压缩：压缩只腾空间，不修复退化',
  // 2026-09-16 用户重定位：行动建议只保留「继续 / 交接」。压缩降级为**信息**，
  // 下面两条是"到官方线也无需你手动干预"的说法（官方会自己压，且先做零 token 修剪）。
  officialWillHandle: '已接近官方自动压缩线；到线官方会先做零 token 修剪，无需手动压缩',
  noManualCompact: '无需手动压缩',
  repeatedSummary: (n) => `已发生 ${n} 次有损摘要，反复压缩收益递减`,
  afterCompactionStillHigh: '上次压缩后仍高于声明窗口的 60%，压缩已经压不动了',
  // 2026-09-16 用户报告「每次压缩后建议都变成机械交接 + 新开会话」后的两条"被成本拦下"提示：
  // 事实（摘要次数多 / 压缩压不动）照说不误，但既然钱上继续更省，就不改判行动建议。
  repeatedSummaryButCheaper: (n) =>
    `已发生 ${n} 次有损摘要（信息有累积损失），但按真实价格算继续更省 —— 换会话反而多花钱，先继续`,
  compactionStalledButCheaper:
    '上次压缩后仍高于声明窗口的 60%（压缩已压不动），但按真实价格算继续更省，先继续',
  deferCompaction: (where) => `${where}，现在不必压缩`,
  noCompressibleRoom: '当前可压缩余量太小，现在压缩的收益 ≈ 0',
  // ⚠️ 2026-09-18：这里原先带"（新会话缓存从零重建）"—— N 节把新开会话改成**分段计费**
  // （首轮公共前缀按实测命中率 76% + 交接文档按未命中价，第 2 轮起按命中价）之后，
  // 那句话已经不成立，留着就是界面在说假话，删掉。
  costFavorsFresh: '按真实价格算，继续已经比新开会话更贵',
  continueBeatsCompact: '继续比压缩更便宜',
  // AF.2（2026-09-20 需求 2）：中间档 —— 只说"边界快到了"，并明确"继续也完全可以"（不催促）。
  prepareHandoff: '交接即将比继续更划算；继续仍可行，只是边界快到了',
  // AG（2026-09-22）：成本通道判了交接，但**会话还没到成熟线**（任务可能刚展开）。
  // 与 `prepareHandoff` 的区别：那条是"钱差点意思"，这条是"钱够了、时候没到"——
  // 界面依据必须说清是哪一个，否则用户会以为门槛没到。
  immatureCostHandoff: '钱上交接已划算，但会话还早 —— 建议在任务 / 阶段完成时交接',
  // AG（2026-09-22）新增最轻档：成本偏高，但**连"差一点"都算不上**（省额 < 门槛的 60%）。
  // 刻意不给任何动作建议、不复述金额（金额在展开区的成本行里）—— 它只是"留意一下"，不是"该做点什么"。
  costNotePerTurn: '本会话每轮成本偏高（继续没问题）—— 留意单次塞入的内容量',
  takeControl: '把压缩时机握在自己手里，而不是等官方自动触发',
  dataMissing: '本会话尚未记录到用量，下一次请求后即可判断',
  stillReliable: '规模仍在可靠区间，无需额外操作',
};

/**
 * 所有可能的 `final.advice` 取值 —— **wire 契约的单一来源**。
 *
 * 为什么要有它：这个取值同时活在三个地方 ——
 *   ① 判定链（本文件，`finalText` 的键）；
 *   ② host 的 `viewSchema`（`z.enum(...)`）；
 *   ③ 浏览器半的颜色 / 图形映射（`client.js` 的 `ADVICE_COLOR` / `ADVICE_GLYPH`）。
 *
 * AG 节（2026-09-22）新增 `costNote` 时就在 ② 上踩了一次：判定链产出了新取值，
 * 而 `viewSchema` 的枚举没跟上 —— 后果不是"那一档降级"，而是**整条 view 校验失败**。
 * 更麻烦的是它**只在边界才现形**：真实语料上 `costNote` 触发 0 次
 * （`work/ag-gradient-scan.mjs`），测试与线上都看不出来，直到真出现一个"省额很小"的会话。
 *
 * 现在 ② 直接引用这份清单；① 由 `handoff-test` 覆盖（每档断言文字）、
 * ③ 由 `ui-build-test` 覆盖（每档断言颜色）—— 三处不再各自漂移。
 * 源码级守卫见 `test/plugin-test.mjs`（enum 与这份清单双向一致）。
 *
 * `compact` 是**历史遗留值**：判定链不再产生它，保留是为了让读到旧数据的情形
 * 取它时不会拿到 undefined（`finalText` 里仍留着那条兼容文案）。
 */
export const ADVICE_VALUES = ['continue', 'costNote', 'prepare', 'handoff', 'compact'];

/**
 * 「交接回本」的**统一显示口径**（AD 节 2026-09-20）。
 *
 * 为什么抽成函数：这个数有**三个**显示点 —— 交接文档的成本表说明（`handoff-render.js`）、
 * 计划里的依据长文（本文件的 `fmtFreshLedger`）、界面折叠行（`client.js`）。
 * AD 那轮只改了两处，**漏了文档那一处** —— 用户会话的文档里仍然写着「交接摊平 ≈ 0.0 轮」
 * （实测发现）。三处必须共用一个定义，别再各写一遍 `toFixed(1)`。
 *
 * 分档：`≤0`（首轮即摊平）/ `<0.1`（一轮之内，别显示 0.0）/ 其余一位小数。
 * ⚠️ `client.js` 是**独立的浏览器 bundle**，不能 import 本文件 —— 那边保留一份同口径实现，
 * 由 `ui-build-test` 用同一组输入钉住（0.0457 → 「首轮内」、0 → 「首轮即摊平」、1.8 → 「1.8 轮」）。
 *
 * @param {number|null} be - `freshBreakEvenRounds`
 * @returns {{short: string, ledger: string}|null} short 用于"≈ X 轮"式短语；ledger 用于整句
 */
export function formatBreakEven(be) {
  if (typeof be !== 'number' || !Number.isFinite(be)) return null;
  if (be <= 0) return { short: '首轮即摊平', ledger: '首轮即摊平' };
  if (be < 0.1) return { short: '首轮内', ledger: '首轮内即摊平' };
  return { short: `${be.toFixed(1)} 轮`, ledger: `约 ${be.toFixed(1)} 轮摊平` };
}

export function deriveCompactionPlan(input = {}) {
  const T = { ...COMPACT_DEFAULTS, ...(input.thresholds ?? {}) };

  const contextWindow =
    typeof input.contextWindow === 'number' && input.contextWindow > 0 ? input.contextWindow : null;
  const usedTokens = typeof input.usedTokens === 'number' && input.usedTokens > 0 ? input.usedTokens : 0;
  const effectiveWindow = contextWindow ? Math.round(contextWindow * T.effectiveWindowRatio) : null;

  const windowPercent = contextWindow && usedTokens ? (usedTokens / contextWindow) * 100 : null;
  const effectivePercent =
    effectiveWindow && usedTokens ? Math.min(100, (usedTokens / effectiveWindow) * 100) : null;

  // ── 边界（2026-09-15 复核）：**"继续"与"无法判断"必须分开** ──
  // 旧实现把 `band` 默认成 `continue`、档位文案写成"继续（占声明窗口 <50%）"，
  // 于是在一个从未记录过 `request/context` 的会话里（现象：`contextWindow` 缺失），
  // 界面会**言之凿凿地给出"继续"这个结论**，而真相是"根本没有数据可判"。
  // 缺数据时说"无法判断"才是诚实的 —— 这也是"权衡边界"的一部分。
  const dataMissing = effectivePercent === null;

  // 四个量之一：距离官方压缩线（声明窗口 × 80%）还剩多少
  const officialLine = contextWindow ? Math.round((contextWindow * T.officialCompactPercent) / 100) : null;
  const headroomToOfficial = officialLine !== null ? Math.max(0, officialLine - usedTokens) : null;
  const avgGrowth = typeof input.avgRoundGrowth === 'number' && input.avgRoundGrowth > 0 ? input.avgRoundGrowth : 0;
  const headroomRounds = headroomToOfficial !== null && avgGrowth > 0 ? Math.floor(headroomToOfficial / avgGrowth) : null;

  // 缓存命中率与"每轮真实单价因子"
  //
  // ⚠️ 成本判定用**尾部窗口的累计命中率**，而不是最后一次请求的读数（2026-09-16 实测）：
  // `work/hitrate-recovery-probe.mjs` 显示 13 段触发里 10 段在 3 轮内自愈
  // （0.0% → 96%~99.9%），单次快照会把"压缩后重建前缀"这类一次性事件误判成"缓存崩了"。
  // 窗口样本不足 3 次时回退到单次读数（新会话开头本来就没有历史可比）。
  const lastHit = Math.max(0, input.cacheReadTokens ?? 0);
  const lastMiss = Math.max(0, input.cacheMissTokens ?? 0);
  const tail = Array.isArray(input.recentUsage) ? input.recentUsage : [];
  const tailTotal = tail.reduce((a, b) => a + (Number.isFinite(b?.total) ? b.total : 0), 0);
  const tailHit = tail.reduce((a, b) => a + (Number.isFinite(b?.hit) ? b.hit : 0), 0);
  const useTail = tail.length >= 3 && tailTotal > 0;
  const hit = useTail ? tailHit : lastHit;
  const miss = useTail ? tailTotal - tailHit : lastMiss;
  const totalInput = hit + miss;
  const hitRate = totalInput > 0 ? hit / totalInput : 0;
  /**
   * 命中率是否**可信到能用来做成本裁决**（2026-09-16 审查 P2 收严）。
   *
   * 原判据 `totalInput > 0` 只回答"有没有数据"，但**新会话第一次请求的
   * `cacheReadTokens` 必然是 0** —— 那时前缀还没被缓存过，零命中是常态而非异常。
   * 实测（`work/audit-p1p2-probe.mjs`）：used 只要 > 49,000，首轮零命中就会直接把结论
   * 拨到 `drivenBy=cost` 的"该压缩/该新开"。
   *
   * 现在要求二选一：
   *   · `hit > 0` —— 缓存确实建立过（命中率有实测意义）；
   *   · `usageCount >= 2` —— 至少两轮读数，此时"仍然 0 命中"才说明缓存真的没起作用。
   * 只满足"刚开新会话、第一条 usage"时判 `false`：不下成本结论。
   */
  const usageCount = Number.isFinite(input.usageCount) ? input.usageCount : 0;
  const cacheEstablished = hit > 0 || usageCount >= 2;
  const hitRateKnown = totalInput > 0 && cacheEstablished;
  const perRoundFactor = hitRate * T.cacheFactor + (1 - hitRate) * 1;

  // ── 真实价格口径（2026-09-16，用户指令"一切基于省钱"）──────────────────────
  // 上面那个 `perRoundFactor` 是"token 当量"（相对量，便于文档里横向比较）；
  // 这一段是**元**（绝对量），用来回答"到底该花谁的钱"。
  //
  // ── 价格与峰谷档位（T 节 2026-09-18）────────────────────────────────────
  // 价格**不再硬编码在判定链里**：由 `prices.js` 按「模型名 + 当前时刻」解析 ——
  //   · 官方调价后改 `prices.json` 即可（不必改代码、不必重新部署）；
  //   · 白天（工作日 9-12 / 14-18）自动切到高峰价（全部单价 ×2）——
  //     此前全程按空闲价算，等于在**用户白天干活时恰好低估一半**。
  // `input.now` 可注入，供测试 mock 时段（T.7.4 验收要求）。
  const priceInfo = resolvePrice(input.model, input.now);
  const P = priceInfo.price;
  /**
   * 价格是否**可用于裁决**（T-6）。
   *
   * `false` = 模型名存在但不认识（例如切到插件没见过的模型）—— 此时**跳过成本裁决**、
   * 只保留质量通道，与既有 `hitRateKnown === false` 不裁决是同一原则：
   * **不确定就不判**，比"用错的价瞎判"好。
   */
  const priceUsable = priceInfo.known;
  const yuan = (tokens, perMillion) => (Math.max(0, tokens) * perMillion) / 1e6;
  /**
   * 每轮平均输出 token。**输出必须算钱**：4 元/百万是未命中输入价的 4 倍，
   * 而思考打转这类异常恰恰烧的就是输出 —— 漏掉它等于漏掉最贵的那部分。
   */
  const avgOutputTokens =
    typeof input.avgOutputTokens === 'number' && input.avgOutputTokens > 0
      ? input.avgOutputTokens
      : T.fallbackOutputTokens;
  /** 用于金额估算的命中率（缺实测时用 `assumedHitRate`，仅影响展示，不影响判定）。 */
  const effectiveHitRate = hitRateKnown ? hitRate : T.assumedHitRate;
  /** 每轮输入部分的混合单价（元/百万 token）：命中与未命中按命中率加权。 */
  const blendedInputPrice =
    effectiveHitRate * P.cacheHitPerMillion + (1 - effectiveHitRate) * P.cacheMissPerMillion;
  const fmtYuan = (v) => `¥${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`;

  /**
   * 每轮里的**请求次数**（steps per turn）—— AB 节（2026-09-20 复核侧实测）。
   *
   * 一个"轮"里可能发**多次**请求（每次工具调用都会开一次新请求），而下面这些变量名字
   * 都写着"每轮"、算出来的却是**每次请求**的钱（输入取单次请求的 `usedTokens`，
   * 输出取"输出总量 ÷ 请求数"）。总额乘 H（**轮**）时就少算了 `stepsPerTurn` 倍：
   *   实测会话 `session-SAMPLE-b983cfac` —— 68 次请求 / 30 轮 = **2.27**，
   *   于是"到官方线前可省 ¥0.455"被系统性低估（真值 ≈ ¥1.03）、"回本 3.1 轮"被高估
   *   （真值 ≈ 1.4 轮）。金额门槛 `minSavingYuan` 也因此被实际收紧了约 2.3 倍。
   *
   * 口径在此**定死一处**：
   *   · 内部变量保持"每次请求"（它们出自单次 usage，物理意义清楚，不换算）；
   *   · **对外暴露的量**（`cost.*PerRound`、三方案总额、回本/余量、plans.*.perRound）
   *     一律换算到"轮" —— 名字里写的是"轮"，值就必须是"轮"。
   * 取不到轮数时退化为 1（= 每轮一次请求），此时新旧口径完全等价 —— 老输入不会变差。
   */
  const turnCount = Number.isFinite(input.turnCount) ? Math.max(0, Math.floor(input.turnCount)) : 0;
  const stepsPerTurn = turnCount > 0 && usageCount > 0 ? Math.max(1, usageCount / turnCount) : 1;

  // ── 方案 A：继续 ──
  const continuePerRound = Math.round(usedTokens * perRoundFactor);
  /** 继续：每轮真实花费（元）= 输入（加权）+ 输出。 */
  const continuePerRoundYuan = yuan(usedTokens, blendedInputPrice) + yuan(avgOutputTokens, P.outputPerMillion);

  // ── 方案 B：先压缩再继续 ──
  //
  // 关键：`usedTokens` 是**此刻**的上下文，而 `last.shadowedTokens` 是**上一次压缩当时**
  // 被替换掉的量 —— 两者不在同一时点。早期版本直接算 `usedTokens - shadowedTokens`，
  // 在"刚压缩完"的会话里会得到负数并被夹到 0，于是渲染出"压缩后每轮成本 ≈ 0、每轮省一大截、
  // 两轮回本"，等于劝用户去压缩一个刚压缩过的会话，反而丢掉刚积累的工作。
  //
  // 正确模型：压缩只能压掉"不可压缩基线之上的部分"。
  //   基线 = 系统提示 + 摘要 + 工具 schema，压不动；有实测就用上次压缩后的真实规模。
  //   于是：可压缩量 = 当前上下文 − 基线，压缩后规模 = 基线。
  const last = input.lastCompaction ?? {};
  const hasMeasured = (input.compactionCount ?? 0) > 0 && (last.shadowedTokens ?? 0) > 0;
  const measuredBaseline =
    hasMeasured && typeof last.afterUsedTokens === 'number' && last.afterUsedTokens > 0
      ? last.afterUsedTokens
      : null;
  // ── AH-B6（2026-09-22）：压缩后的规模**锚窗口**，而不是"压掉固定比例" ──────────
  // 官方 `dsh-compaction-basic` 的保留量是 `floor(window × retainRatio)`（实测 0.16），
  // 也就是**与窗口挂钩**的；而 `compressibleRatio`（压掉 60%）把"压缩后规模"写成了
  // `usedTokens × 0.4` —— 一个与窗口无关的假设。两者在 1M 窗口上差得很远：
  // 实测 `fcafee61` 的假设值 ≈ 267k，而官方机制给出的保留量 ≈ 160k，
  // 于是"压缩后每轮成本"被系统性高估、压缩方案显得比实际更差。
  //
  // ⚠️ 第一版实现（直接 `max(窗口基准, usedTokens × 0.4)`）**踩了坑，已修**：
  // 那个 `usedTokens × 0.4` 是"骨架基准"的旧代言，它与规模成正比，在 900k 的会话上
  // 会给出 360k —— 反而**盖过**窗口基准，等于没改；更糟的是对小于 `window × 0.16`
  // 的会话（1M 窗口下即 <160k），窗口基准直接大于当前上下文，`compressibleNow` 被夹成 0，
  // 实测 82 个真实会话里 **65 个**被判"可压缩量 0"（`work/ah-b6-probe.mjs` 复现），
  // 文档会写出"当前可压缩量仅约 0 token"这种荒谬句子。
  //
  // 现在的两条规则：
  //   ① **窗口基准只在它真的适用时说话**：`usedTokens > window × retainRatio`。
  //      否则说明这次压缩根本不会把上下文压到那个水平（官方在 80% 线才触发，
  //      小会话压根不压缩），此时退回按比例估算 —— 老会话的数字不会变差。
  //   ② 骨架下界用**跨会话公共前缀**（系统提示 + 工具 schema，实测约 20k），
  //      而不是 `usedTokens × 0.4` —— 压缩压不到公共前缀以下，而它是与规模无关的量。
  const retainAnchor = T.retainRatio ?? 0.16;
  const windowApplies = contextWindow !== null && usedTokens > contextWindow * retainAnchor;
  const estimatedBaseline = windowApplies
    ? Math.max(Math.round(contextWindow * retainAnchor), T.freshSessionBaseTokens ?? 0)
    : Math.round(usedTokens * (1 - T.compressibleRatio));
  // 陈旧实测基线（2026-09-15 审查修复）：实测值只在"没被后续积累冲淡"时可信。
  // 若当前上下文已经远超它（> 3 倍），说明中间长出了大量新工作，压缩不可能再回到那个规模 ——
  // 此时必须改用估算，否则会算出一张把"50 分钟前的压缩结果"当预测的成本表。
  const staleBaseline = measuredBaseline !== null && usedTokens > measuredBaseline * 3;
  const baseline = Math.min(
    usedTokens,
    Math.max(staleBaseline ? 0 : (measuredBaseline ?? 0), estimatedBaseline),
  );
  const compressibleNow = Math.max(0, usedTokens - baseline);
  const afterUsed = Math.max(0, baseline);
  // 可压缩量太小（不到一成的）就不值得再压一次
  const worthCompacting = usedTokens > 0 && compressibleNow > usedTokens * 0.1;

  // 被压缩历史（成本模型的输入）：**一律用当前可压缩量**。
  // `last.shadowedTokens` 是"上一次压缩当时"被替换掉的量，会话又长了很久之后再拿它当预测，
  // 会算出"被压缩历史 > 当前上下文"这种自相矛盾的数字（2026-09-15 审查实测：
  // 当前上下文 318,115，文档却写"被压缩历史 360,158"，并据此得出"2 轮回本"）。
  // 实测值仍然用于**展示**（见压缩历史表），但不再作为这次的成本输入。
  const compactedTokens = Math.min(compressibleNow, usedTokens);
  // 摘要成本 = **被压缩历史 × 缓存价系数 + 摘要输出 × 全价**（需求补充 2 给定的公式）。
  // 摘要要重读一遍被压缩内容，而这些内容刚在上下文里被读过，故按缓存价计。
  const summaryOutput = hasMeasured && last.summaryTokens ? last.summaryTokens : T.summaryOutputTokens;
  const compactOnceCost = Math.round(compactedTokens * T.cacheFactor + summaryOutput);
  const compactPerRound = Math.round(afterUsed * perRoundFactor);
  // 压缩后面临 1~2 轮前缀缓存重建（按全价差额估）
  const rebuildCost = Math.round(afterUsed * (1 - T.cacheFactor) * REBUILD_ROUNDS);
  // AB.3（2026-09-20）：上面两个 token 当量也是"每次请求"算出来的 —— 对外要乘回每轮请求数。
  const continuePerTurn = Math.round(continuePerRound * stepsPerTurn);
  const compactPerTurn = Math.round(compactPerRound * stepsPerTurn);
  const savingPerRound = continuePerTurn - compactPerTurn;
  const compactTotalOnce = compactOnceCost + rebuildCost;
  const breakEvenRounds =
    savingPerRound > 0 && worthCompacting ? Math.ceil(compactTotalOnce / savingPerRound) : null;

  // 真实价格（元）口径的三笔账
  //   一次性：摘要要重读一遍被压缩内容（这些刚读过 → 按**命中价**）+ 摘要输出（**输出价**）
  //           + 压缩后前缀缓存失效、需按**未命中价**重建 1.5 轮
  //   每轮：压缩后的上下文 × 加权输入价 + 输出
  const compactOnceYuan =
    yuan(compactedTokens, P.cacheHitPerMillion) +
    yuan(summaryOutput, P.outputPerMillion) +
    yuan(afterUsed * REBUILD_ROUNDS, P.cacheMissPerMillion);
  const compactPerRoundYuan =
    yuan(afterUsed, blendedInputPrice) + yuan(avgOutputTokens, P.outputPerMillion);
  const compactSavingPerRoundYuan = continuePerRoundYuan - compactPerRoundYuan;
  /** 每轮口径的压缩节省额（元）—— `compactOnceYuan` 是一次性支出，除以"每轮"省多少才是轮数。 */
  const compactSavingPerTurnYuan = compactSavingPerRoundYuan * stepsPerTurn;
  /** 真实价格下的回本轮数 —— 注意它比 token 当量口径**慢得多**（实测 21 轮 vs 8 轮）。 */
  const breakEvenRoundsYuan =
    compactSavingPerTurnYuan > 0 && worthCompacting
      ? compactOnceYuan / compactSavingPerTurnYuan
      : null;

  // ── 方案 C：机械交接 + 新会话 ──
  //
  // 2026-09-18 重写（原实现"每轮一律按未命中价"是**错的**，且让判定恒为假）。
  //
  // 旧注释的理由是"新开会话会导致缓存命中重新算"—— 这话只有**首轮**成立：
  //   · 官方机制：每次请求的**用户输入结束位置**会落盘为一个"缓存前缀单元"，
  //     后续请求只要**完整匹配**它即可命中。新会话第 2 轮的输入 = 首轮全部 + 新增，
  //     正好完整匹配首轮那个单元 → **第 2 轮起命中**。
  //   · 本项目自己的实测也是这个形状（`HIT_RATE_WINDOW` 引入时测的 13 段里 10 段 3 轮内自愈，
  //     典型 0% → 96% → 99.3% → 99.9%）。新会话首轮 0% 命中属于"一次性事件"。
  //   · 拿首轮快照推断"往后每轮都按未命中价付"，正是 `handoff-fold.js` 注释里
  //     已经批判过的那种"系统性高估"——只是这个批判当时没被应用到方案 C。
  //
  // 另一处修正（2026-09-18，72 样本实测）：首轮**也不是全未命中**。
  //   `freshSessionBaseTokens`（系统提示 + 工具 schema ≈ 20k）是**跨会话公共前缀**，
  //   实测 72 个会话首轮命中率中位数 **76%**（`T.handoffBaseHitRate`）。
  //   所以首轮要**分段计费**：公共前缀按加权价、交接文档按未命中价。
  const handoffDocTokens = Math.max(0, Math.round(input.handoffDocTokens ?? 12000));
  const handoffOnceCost = handoffDocTokens; // token 当量口径：冷启动要重读这么多
  const freshPerRound = T.freshSessionBaseTokens + handoffDocTokens;

  // 真实价格（元）
  const freshRoundTokens = T.freshSessionBaseTokens + handoffDocTokens;
  const baseHitRate = T.handoffBaseHitRate ?? 0.76;
  /** 公共前缀的混合单价：按跨会话实测命中率加权（不是未命中价，也不是当前会话的命中价）。 */
  const basePrefixPrice =
    baseHitRate * P.cacheHitPerMillion + (1 - baseHitRate) * P.cacheMissPerMillion;
  /** 首轮：公共前缀按加权价 + 交接文档（全新）按未命中价 + 输出。**一次性**。 */
  const handoffOnceYuan =
    yuan(T.freshSessionBaseTokens, basePrefixPrice) +
    yuan(handoffDocTokens, P.cacheMissPerMillion) +
    yuan(avgOutputTokens, P.outputPerMillion);
  /** 第 2 轮起：首轮全部输入都已落盘成缓存前缀单元 → 存量按**命中价** + 输出。 */
  const freshPerRoundYuan =
    yuan(freshRoundTokens, P.cacheHitPerMillion) + yuan(avgOutputTokens, P.outputPerMillion);

  // ── AB.3（2026-09-20）：换算到「每轮」——对外量的**唯一出口** ───────────────
  // 上面 `*PerRoundYuan` 全是"每次请求"（名字有误导，保留是为了**少改一行就少一次风险**；
  // 它们的调用者现在只剩下面几行与内部比值）。凡是会走出这个函数的，一律用这一组。
  const continuePerTurnYuan = continuePerRoundYuan * stepsPerTurn;
  const compactPerTurnYuan = compactPerRoundYuan * stepsPerTurn;
  const freshPerTurnYuan = freshPerRoundYuan * stepsPerTurn;
  /**
   * 新开**第一轮**的总额 = 交接到文档那一次请求 + 本轮其余 `stepsPerTurn − 1` 次
   * （文档已在上下文里 → 按第 2 轮起的命中价）。
   *
   * 为什么不直接 `handoffOnceYuan × stepsPerTurn`：交接文档只发一次，
   * 乘上去等于把"一次性"当成"每轮都付"，会把新开算贵。
   */
  const freshFirstTurnYuan = handoffOnceYuan + freshPerRoundYuan * (stepsPerTurn - 1);

  // ── 成本驱动的三方案裁决（2026-09-16 用户指令："一切基于省钱"）──────────────
  //
  // 原话："如果压缩后价格因为异常之类的开始比不上直接新开，就推荐新开。"
  //
  // 做法：把三个方案放到**同一个时间窗**里比总花费（元）。窗口取"到官方压缩线为止"
  // （`headroomRounds`）—— 过了官方线，官方会先做零 token 的 prune（**仍会丢弃工具结果中段**），
  // 游戏规则就变了。
  //
  // ⚠️ AH-B7（2026-09-22）：这里的"官方线"是**三条压缩路径里最早到的那条**，不是一个时刻。
  // 官方 `dsh-compaction-basic` 的自动压缩有三个触发源（第四版问题清单 B7 逐行读源码核实）：
  //   ① `pressure` —— 占用越过 `thresholdTokens = floor(window × 0.8)`；
  //   ② `overflowRetries` —— 请求溢出重试，**可能先于 pressure 发生**；
  //   ③ `sourceCommandId` —— 用户手动 `/compact`（本插件的判定不产生它）。
  // 本插件能算的只有 ①（`contextWindow × officialCompactPercent`），所以 `headroomRounds`
  // 是**上界估计**：实际压缩可能更早。实测 `fcafee61` 就是 overflow 先到 —— 压后只剩
  // 19,365 token，远低于 pressure 路径会保留的 160,000，且事件里没有 `sourceCommandId`。
  // 结论的实际含义因此是"**不晚于**这个轮数"，而不是"恰好那时"；这也让"提前手动压缩
  // 摊不回本"的判断更保守（只会更成立，不会更松）。
  //
  // 为什么用**总花费**而不是"摊销成每轮"：三个方案的一次性结构完全不同
  // （继续没有、压缩有摘要+缓存重建、新开有交接文档冷启动），摊成每轮会掩盖
  // "一次性成本要几轮才摊完"这件事。直接比总额，谁便宜一目了然。
  const horizonRounds = headroomRounds ?? T.remainingRounds;
  const H = Math.max(1, horizonRounds);
  // AB.3：H 是**轮数**，成本必须也是"每轮"—— 三个总额都按上面换算好的每轮量算。
  const totalContinueYuan = continuePerTurnYuan * H;
  const totalCompactYuan = compactOnceYuan + compactPerTurnYuan * H;
  const totalFreshYuan = freshFirstTurnYuan + freshPerTurnYuan * Math.max(0, H - 1);
  /**
   * 不看新开时，继续与压缩谁更省。
   *
   * ⚠️ 2026-09-16 用户重定位后，**"是否换会话"的判定只跟"继续"比**（压缩不再是候选方案），
   * 这个值不再参与 `freshWinsOnCost`，仅保留供文档/成本表做三方案对照。
   */
  const cheaperOfContinueCompact = Math.min(totalContinueYuan, totalCompactYuan);

  // ── 交接回本：把账摊出来，而不是替用户下结论（2026-09-18）────────────────
  //
  // 原判据是"新开总花费 × 1.5 < 继续总花费"。两个问题：
  //   ① C 行按未命中价算出 `freshPerRound ≈ ¥0.034/轮`，而 A 行是 ¥0.018/轮 ——
  //      不等式 `0.018 + 0.051H < 0.0181H` 对**任何** H>0 都无解，
  //      成本维度等于被钉死，永远不会推荐交接（不只是"偏高"）；
  //   ② 那个 1.5 倍是为"人工衔接成本"设的，而机械交接**零 token、零人工**。
  //
  // 改为**回本轮数**口径：首轮溢价 ÷ 每轮节省，再与预计剩余轮数 H 比。
  // 这样"还需几轮才回本"是用户能自己核对的数，而不是一个被余量扭曲的布尔值。
  // AB.3 修正（2026-09-20）：分子仍是"首轮一次性溢价"，分母换成**每轮**节省 ——
  // 原来分子分母都是"每次请求"，比值单位其实是"请求数"，却被当成"轮数"与 H 比较。
  // 换算后：`premium` 与 `stepsPerTurn` 无关（文档只发一次），分母乘回片数 →
  // 回本轮数 = 原值 ÷ stepsPerTurn（实测 3.1 → 1.4 轮）。
  const freshFirstRoundPremium = freshFirstTurnYuan - freshPerTurnYuan;
  const freshSavingPerRound = continuePerTurnYuan - freshPerTurnYuan;
  /** 交接回本轮数；`null` = 交接每轮并不更省，回本无从谈起。 */
  const freshBreakEvenRounds =
    freshSavingPerRound > 1e-12 ? freshFirstRoundPremium / freshSavingPerRound : null;
  /** 回本后还能剩几轮（负数 = 到官方线前摊不回来）。`null` 同上。 */
  const freshWinMarginRounds = freshBreakEvenRounds === null ? null : H - freshBreakEvenRounds;
  /**
   * 新开在钱上是否胜出：**回本 + `handoffMarginRounds` 轮余量**都要落在窗口内。
   *
   * 用轮数余量而非金额倍数的理由见 `COMPACT_DEFAULTS.handoffMarginRounds`：
   * 剩余轮数由增速外推，而实测增速 P25~P75 差 2.4 倍，回本后剩不下 1 轮就不该下结论。
   * `hitRateKnown === false` 时不下结论：缺用量数据 ≠ 缓存崩了（见 `continueWinsOnCost`）。
   */
  /**
   * 两道**防御门槛**（2026-09-18 用户拍板）—— 修好分段计费后，76 个真实会话里 66 个翻转成
   * "新开更省"，但其中大量是 `H` 的荒谬外推（小上下文 + 线性外推 = 1318/5214 轮）。
   * 成本维度在这些会话上裁决没有意义，所以加门槛，而不是让它从"总是继续"变成"总是交接"。
   *   · `handoffMinWindowPercent`（20%）：挡住小上下文；
   *   · `handoffMaxHorizonRounds`（200）：挡住"上下文不小但增速极慢"的外推。
   *
   * 第三道（2026-09-18 部署后测试暴露）：**`headroomRounds` 估不出时必须不裁决**。
   * 那种情况下 `H` 用的是兜底 `T.remainingRounds`（10 轮）—— 拿一个凭空的轮数去做
   * "回本 < H" 的判定，等于把"估不出"当成了"只剩 10 轮"。这违反本插件既有的
   * "估不出就不下结论"原则（见下方 `headroomRoundsKnown`）。
   */
  const windowPercentOK = (windowPercent ?? 0) >= (T.handoffMinWindowPercent ?? 20);
  const horizonOK = H <= (T.handoffMaxHorizonRounds ?? 200);
  /** 交接相对"继续"的**绝对节省额**（元）—— 同时下发到界面（S-3）。 */
  const savingYuan = totalContinueYuan - totalFreshYuan;
  /**
   * 第四道门槛：**最小节省额**（2026-09-18 S 节）。
   *
   * 前三道挡的是"算不出来的会话"，这一道挡的是"算得出来、但不值一提"的 ——
   * 实测三个会话同样判"交接"，节省额差 10 倍：`fcafee61` **¥0.023**、
   * `d854e8b5` ¥0.100、`d346d3e8` **¥0.235**。为 2 分钱劝人换会话是错的：
   * 人工衔接成本是那 2 分钱的几百倍，而且这类会话往往**没有质量理由**。
   *
   * ⚠️ 只约束**成本通道**；退化 / 守卫触发的质量通道不受金额约束（S-2）。
   */
  const savingEnough = savingYuan >= (T.minSavingYuan ?? 0.15);
  const freshWinsOnCost =
    // T-6（2026-09-18）：模型不认识 → 价格不可用 → 成本通道**不裁决**
    priceUsable &&
    hitRateKnown &&
    usedTokens > 0 &&
    // 同 `headroomRoundsKnown` 的口径（该常量在本块之后才定义，故此处直接判类型）
    typeof headroomRounds === 'number' &&
    windowPercentOK &&
    horizonOK &&
    savingEnough &&
    freshBreakEvenRounds !== null &&
    freshBreakEvenRounds + (T.handoffMarginRounds ?? 1) < H;
  /**
   * true = 继续每轮**没有**贵过新开。
   *
   * ⚠️ `hitRateKnown === false` 时**一律视为"继续没输"**：会话里没有
   * `cacheReadTokens`/`inputTokens`（老数据、合成输入、刚开的新会话）时，
   * `hitRate` 会被算成 0 —— 那等于假设"每轮都按未命中价重付全部上下文"，
   * 于是每个会话都会被误判成"继续比新开贵 15 倍"。缺数据与"缓存真的崩了"必须分开。
   */
  const continueWinsOnCost = !hitRateKnown || freshSavingPerRound <= 0;
  /**
   * 成本维度的**第二条通道：缓存崩了**（2026-09-18）。
   *
   * 与回本判据互补：回本判据要可信的 `H`（且要过窗口 / H≤200 两道门槛），
   * 而"缓存崩了"是**更强的信号** —— 继续每轮按未命中价重付全部上下文，第 1 轮就回本，
   * 不需要知道还要跑几轮。`handoff-test` 那条「闸门：缓存真崩 → 交接」的 fixture
   * 故意不给增速（`avgRoundGrowth`），守的就是这里。
   */
  const brokenCacheWins =
    // ⚠️ **P2 前提，显式写出**（2026-09-18 用户要求）：`hitRateKnown` 内部已含
    // `cacheEstablished`（`hit > 0 || usageCount >= 2`），但这里必须让它**看得见** ——
    // 首轮零命中是"缓存还没建立"，不是"缓存崩了"，拿它劝人换会话是 P2 修过的老 bug。
    // 显式列出后，日后若有人放松 `hitRateKnown` 的口径，这条仍能独立挡住。
    priceUsable &&
    cacheEstablished &&
    hitRateKnown &&
    usedTokens > 0 &&
    hitRate < (T.brokenCacheHitRate ?? 0.5) &&
    freshSavingPerRound > 0 &&
    // ⚠️ **规模门槛同样适用**（2026-09-18 复查修的真 bug）：
    // 新开首轮是**固定**成本（交接文档 ≈ ¥0.018），而"继续"每轮与上下文规模成正比。
    // 所以"缓存崩了第 1 轮就回本"**只在大上下文成立**。
    // 实测反例：`session-SAMPLE-dbe8e0b8`（used=2,914 / 命中率 32.6%）—— 继续每轮仅 ¥0.0026、
    // 回本要 12.3 轮，却因为命中本通道被判"建议交接"，且界面余量显示 **-2.27 轮**（自相矛盾）。
    windowPercentOK &&
    // S 节：金额门槛对**两条成本通道**一视同仁 —— 缓存崩了但只省几分钱，同样不值得换。
    savingEnough;
  /** 成本维度的**最终**判据 = 正常回本判据 **或** 缓存崩了。覆盖规则与行动建议都用它。 */
  const freshWinsOnCostAny = freshWinsOnCost || brokenCacheWins;
  /**
   * 把方案 C 的账摊成一句人话（2026-09-18）：首轮多少、之后每轮多少、几轮回本、
   * 窗口内还剩几轮余量。**判定之外还要能看到这个数** —— 用户实测增速跨临界
   * （P25/P50/P75 → H = 4.2/2.4/1.7 轮），一个布尔值不足以支撑决定。
   */
  const fmtFreshLedger = () => {
    const head = `新开首轮 ${fmtYuan(freshFirstTurnYuan)} → 之后 ${fmtYuan(freshPerTurnYuan)}/轮`;
    if (freshBreakEvenRounds === null) return `${head}（新开每轮并不更省，回本无从谈起）`;
    // AD 节（2026-09-20）：`0.0457` 被 `toFixed(1)` 写成「约 0.0 轮摊平」——
    // **数值没错**（交接冷启动溢价在一轮之内就被摊平），但读者会以为数据坏了
    // （用户实测截图正是因此发起复核）。分档口径见 `formatBreakEven`（三处显示点共用）。
    const beText = formatBreakEven(freshBreakEvenRounds).ledger;
    const marginText =
      freshWinMarginRounds >= 0
        ? `，回本后还剩约 ${freshWinMarginRounds.toFixed(1)} 轮`
        : `，到官方线前差 ${(-freshWinMarginRounds).toFixed(1)} 轮摊不回来`;
    return `${head}，${beText}${marginText}（窗口 ${H} 轮）`;
  };

  const fmt = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '未知');

  // ── 维度 A：质量（口径 = **有效窗口**）──
  const signals = {
    repeatWorst: input.repeatWorst ?? 0,
    degradedReplies: input.degradedReplies ?? 0,
    reasoningLoop: input.reasoningLoop ?? 0,
    reasoningFlags: input.reasoningFlags ?? 0,
    // R 节（2026-09-18）：守卫**实时掐断**的次数 —— 判定链里最硬的一条退化证据。
    // 此前它只被渲染层用来显示"已中止空转 N 次"，完全没参与判定。
    guardTripCount: input.guardTripCount ?? 0,
  };
  const degraded =
    // 守卫当场判定并掐断过 = 确凿的退化（有现场），比事后统计更硬
    signals.guardTripCount > 0 ||
    signals.repeatWorst >= T.qualityRepeatThreshold ||
    signals.degradedReplies >= T.qualityDegradedThreshold ||
    signals.reasoningLoop > 0 ||
    signals.reasoningFlags > 0;
  /**
   * 反复被守卫掐断（≥ `qualityGuardTripHandoff`）→ **不看占用规模**也该交接。
   * 与 `degraded` 的区别：那条要走"规模 + 退化"的双条件门，这条不走。
   */
  const guardRepeated = signals.guardTripCount >= T.qualityGuardTripHandoff;

  /**
   * 退化信号的文字清单（维度 A 的几处文案共用一份）。
   *
   * 2026-09-18 M 节修复时抽出来的：原先同样的四行清单被**手写三遍**，
   * 而 M 节要修的恰恰是"其中一处忘了看 `degraded`"——
   * 同一份事实抄三遍，迟早会有一处跟另两处说的不一样。
   */
  const degradeSignalsText = () =>
    [
      // 守卫中止放最前：它是**实时验证**过的退化（检测器当场判定并掐断），
      // 比后面几条事后统计更硬 —— 文案里也该先被看到。
      signals.guardTripCount > 0 ? `守卫中止空转 ${signals.guardTripCount} 次` : '',
      signals.repeatWorst >= T.qualityRepeatThreshold ? `重复工具调用 ${signals.repeatWorst} 次` : '',
      signals.degradedReplies >= T.qualityDegradedThreshold ? `输出退化 ${signals.degradedReplies} 条` : '',
      signals.reasoningLoop > 0 ? `思考打转 ${signals.reasoningLoop} 次` : '',
      signals.reasoningFlags > 0 ? `思考异常长 ${signals.reasoningFlags} 次` : '',
    ]
      .filter(Boolean)
      .join('、');

  let qualityAdvice = 'continue';
  let qualityReason = '';
  if (effectivePercent === null) {
    qualityReason = '（缺窗口或用量数据，质量维度无法判断）';
  } else if (effectivePercent >= T.qualityImmediatePercent && degraded) {
    const whyImm = degradeSignalsText();
    qualityAdvice = 'immediate';
    qualityReason = `有效占用 ${effectivePercent.toFixed(0)}%（≥${T.qualityImmediatePercent}%）**且检出退化信号**（${whyImm}）—— 已超出可靠工作区间，且退化不是压缩能修的，建议立即新开会话。`;
  } else if (guardRepeated) {
    // ── R 节（2026-09-18）：反复被守卫掐断 → **不看占用规模** ──────────────
    // 实测现场 `session-SAMPLE-bdde842b`：守卫掐断 4 次（"做。"决策循环，规模递增
    // 298→411→447 行），但有效占用只有 49.5% —— 双条件门进不去，质量维度说"继续"，
    // 最终建议只能靠成本驱动，而成本上只省 ¥0.10，理由被写成"继续会话已不划算"。
    // 结论其实是对的（模型反复陷入循环 = 执行能力不可靠），**但插件说不出这个理由**。
    qualityAdvice = 'handoff';
    qualityReason =
      `本会话已 **${signals.guardTripCount} 次**触发思考空转守卫（模型反复陷入循环、被实时掐断）——` +
      `这是**实时验证过的**退化证据（有现场记录），不是事后统计；` +
      `有效占用 ${effectivePercent === null ? '未知' : effectivePercent.toFixed(0) + '%'} 虽然不算高，` +
      `但反复掐断说明执行能力已经不可靠，**建议交接后在新会话继续**。`;
  } else if (effectivePercent >= T.qualityHandoffPercent && degraded) {
    const why = degradeSignalsText();
    qualityAdvice = 'handoff';
    qualityReason = `有效占用 ${effectivePercent.toFixed(0)}%（≥${T.qualityHandoffPercent}%）**且检出退化信号**（${why}）—— 退化不会被压缩修好，建议交接。`;
  } else if (effectivePercent >= T.qualityHandoffPercent) {
    // 2026-09-16 边界设定：规模大但**没退化**时，本维度**不给出行动建议**。
    // 旧版这里会由 `qualityImmediatePercent` 单独因规模判"立即新开"，把官方线遮蔽掉。
    qualityReason = `有效占用 ${effectivePercent.toFixed(0)}%（≥${T.qualityHandoffPercent}%）但**未检出退化信号** —— 规模偏大本身不构成交接理由（压缩只腾空间、不修退化；反过来没有退化就不必换会话），时机交给压缩维度判断。`;
  } else if (degraded) {
    // 2026-09-18 M 节修复（用户报告：压缩后文档说"未检出退化信号"，
    // 可同一份文档里明明写着"思考打转 10 次 → 已检出"）。
    //
    // 压缩会让占用骤降（实测 765,582 → 21,090 token），但**历史退化计数不会因此消失**。
    // 旧版这个分支无条件写"质量维度健康" —— 于是在"占用低 + 有历史退化"时说了假话：
    // "规模安全"是真的，"健康"不是。对以"诚实声明"为立场的插件，这类事实陈述错误必须修。
    // （M-2：历史退化不该被静默抹去，所以把具体是哪几条摆出来，而不是只说"有退化"。）
    qualityReason = `有效占用 ${effectivePercent.toFixed(0)}%（<${T.qualityHandoffPercent}%）—— **规模安全**，但**此前检出退化信号**（${degradeSignalsText()}）：当前上下文规模不足以据此改判交接，**建议继续观察**；若新交互中再次出现打转，就该交接了。`;
  } else {
    qualityReason = `有效占用 ${effectivePercent.toFixed(0)}%（<${T.qualityHandoffPercent}%）—— 质量维度健康。`;
  }

  // ── 维度 B：压缩时机 ──
  // 主档位锚定在**声明窗口**（与官方自动压缩线同一坐标系，2026-09-16 边界设定）。
  // 质量维度用的是有效窗口（= 声明 × ratio），两者口径不同、互不换算，
  // 运行时必须分开展示并各自标注口径。
  let band = 'continue';
  if (windowPercent !== null) {
    if (windowPercent >= T.compactUrgentFrom) band = 'urgent';
    else if (windowPercent >= T.compactRecommendFrom) band = 'recommend';
    else if (windowPercent >= T.compactMildFrom) band = 'mild';
  }
  const nearOfficial =
    windowPercent !== null && windowPercent >= T.officialCompactPercent - OFFICIAL_LINE_MARGIN;
  if (nearOfficial) band = 'urgent';

  // 档位文案只描述**规模事实**。2026-09-16 用户重定位后压缩不再是行动建议，
  // 所以旧文案里的"轻度提示 / 推荐手动压缩 / 即将自动压缩"这类行动号召全部去掉，
  // 改为中性的规模描述（信息仍然保留，只是不劝人做任何事）。
  const bandText = dataMissing
    ? '无法判断（缺窗口或用量数据）'
    : {
        continue: `正常（占声明窗口 <${T.compactMildFrom}%）`,
        mild: `偏大（占声明窗口 ${T.compactMildFrom}~${T.compactRecommendFrom}%）`,
        recommend: `较大（占声明窗口 ${T.compactRecommendFrom}~${T.compactUrgentFrom}%）`,
        urgent: nearOfficial
          ? `接近官方自动压缩线（已过声明窗口 ${T.officialCompactPercent - OFFICIAL_LINE_MARGIN}%）`
          : `占声明窗口 ≥${T.compactUrgentFrom}%`,
      }[band];

  // 档位理由：同样只讲事实（距官方线多远、到线会发生什么），不给"该不该压缩"的建议。
  const compactReason = {
    continue: `占声明窗口 ${fmt(windowPercent)}（<${T.compactMildFrom}%）—— 距官方压缩线还有 ${headroomToOfficial?.toLocaleString() ?? '?'} token。`,
    mild: `占声明窗口 ${fmt(windowPercent)}（${T.compactMildFrom}~${T.compactRecommendFrom}%）—— 距官方自动压缩线仍有余量，无需手动处理。`,
    recommend: `占声明窗口 ${fmt(windowPercent)}（${T.compactRecommendFrom}~${T.compactUrgentFrom}%）—— 压不压都不影响继续；到官方线官方会先做零 token 裁剪（仍会丢弃工具结果中段）。`,
    urgent: nearOfficial
      ? `占声明窗口 ${fmt(windowPercent)}，已接近官方自动压缩线（${T.officialCompactPercent}%）—— 到线官方会先做零 token 裁剪（仍会丢弃工具结果中段）；裁剪不够时，**主要压缩量仍由有损摘要承担**。`
      : `占声明窗口 ${fmt(windowPercent)}（≥${T.compactUrgentFrom}%）。`,
  }[band];

  // ── 覆盖规则与最终结论（质量优先于压缩）──
  const compactCount = input.compactionCount ?? 0;
  // 「收益递减」只该由**有损**的模型摘要次数驱动；零 token 的裁剪压几次都不丢信息。
  const measuredSummaryCount = input.summaryCount ?? 0;
  const afterPercent = typeof input.afterCompactionPercent === 'number' ? input.afterCompactionPercent : null;

  // ── 「现在还不必压缩」的推迟判定（2026-09-16 用户反馈）────────────────────
  // 档位（声明窗口）说明"风险在升高"，但**该不该现在动手**要看两件事：
  //   ① 官方自动压缩线还有多远（`headroomRounds`）；
  //   ② 这次压缩要几轮才回本（`breakEvenRounds`）。
  // 只有在"回本能在官方线到来之前兑现"、且官方线不算太远时，现在压才划算。
  //
  // 为什么"回本慢于官方线"就该推迟（这不是省事的借口，是有依据的）：
  // 官方 `dsh-compaction-basic` 到线时**先做零 token 裁剪（prune；仍会丢弃工具结果中段）**，
  // 只有裁剪不够才调模型生成摘要；而手动 `/compact` 是**立刻**调模型、立刻付全价、立刻承担有损。
  // 所以当"回本要 11 轮、官方线 5 轮后就到"时，提前压属于纯支出。
  const headroomRoundsKnown = typeof headroomRounds === 'number';
  // ⚠️ 2026-09-16 修掉的真 bug：这里原来比的是 **token 当量**口径的回本轮数（8 轮），
  // 而真实价格下回本要约 21 轮 —— 于是在 65%~70% 声明窗口处，"回本比官方线还慢"明明成立，
  // 推迟规则却判它不成立，照样推荐"现在压缩"。而那一刻压缩恰恰是三个方案里最贵的：
  // 一次性 ¥0.44 要 21 轮才回本，可距官方线只剩 12 轮。
  const breakEvenSlowerThanLine =
    breakEvenRoundsYuan !== null && headroomRoundsKnown && breakEvenRoundsYuan > headroomRounds;
  const deferCompaction =
    !nearOfficial &&
    (band === 'mild' || band === 'recommend' || band === 'urgent') &&
    // 2026-09-16：如果"继续"按真实价格已经比新开还贵（典型是缓存命中率崩了），
    // 那就没有"再等等"的空间了 —— 推迟的前提是等待本身不花钱，而这个前提不成立。
    continueWinsOnCost &&
    (headroomRoundsKnown
      ? headroomRounds >= T.compactDeferMinRounds || breakEvenSlowerThanLine
      : windowPercent !== null && windowPercent < T.compactDeferBelowDeclaredPercent);

  let finalAdvice = 'continue';
  let finalReason = '';
  // `finalNote` 是给**界面**的一句话依据：无 Markdown、不复述已有数字。
  // `finalReason` 是给**交接文档**的完整论证（含数字与粗体）。
  // 两者分工不同 —— 界面空间小且不渲染 Markdown，直接把 reason 塞进去会既重复又露出 `**`。
  let finalNote = '';
  let drivenBy = 'stable';

  if (qualityAdvice === 'immediate') {
    finalAdvice = 'handoff';
    drivenBy = 'quality';
    finalReason = qualityReason;
    finalNote = FINAL_NOTES.overReliableRange;
  } else if (qualityAdvice === 'handoff') {
    finalAdvice = 'handoff';
    drivenBy = 'quality';
    finalReason = `${qualityReason}（**退化信号优先于压缩**：压缩只腾空间，不修复退化。）`;
    // R-2：理由要说真话 —— 驱动因素是"反复被守卫掐断"时，界面依据不能还写
    // "压缩只腾空间"这种通用话术，得直接说守卫（用户才知道**为什么**该换）。
    finalNote = guardRepeated
      ? FINAL_NOTES.guardTripped(signals.guardTripCount)
      : FINAL_NOTES.degradeBeatsCompact;
  } else if (
    measuredSummaryCount >= T.handoffAtCompactionCount &&
    windowPercent !== null &&
    windowPercent >= T.compactMildFrom &&
    // ── 成本闸门（2026-09-16 用户报告「每次压缩后建议都变成机械交接 + 新开会话」）──
    // 这条覆盖规则原本**完全不看钱**：摘要累计到 2 次后，只要占用回到声明窗口的 50%，
    // 无论缓存命中率 99%、继续每轮只要一两分钱，都无条件劝人「机械交接 + 新开会话」，
    // 而且这个状态会一直持续（占用越涨越"该交接"）。
    // 用户最高指令是"一切基于省钱"，故加闸门：**钱不支持新开时不改判**，
    // 只在最终 note 里保留"反复摘要有损"这个事实（见下方 CROSS_NOTES 段）。
    freshWinsOnCostAny
  ) {
    // 这条覆盖规则有两个必须同时满足的条件（2026-09-15 审查修复）：
    //   1) 只数**模型摘要**。`compaction/prune` 零 token，但**并非无损** —— 官方 pruner 会把
    //      工具结果的**中段**替换成省略标记（`[... tool result middle pruned ...]`，
    //      实测 `fcafee61` 的 9 次 prune 合计丢弃 30,725 token）。不据此劝人交接的理由是
    //      **它不消耗模型、损失远小于摘要**，而不是"它不丢内容"。官方到线是
    //      **先 prune 再 summary**，一次正常自动压缩就产生 2 条压缩事件 —— 按总数计数
    //      会让"刚被自动压缩、上下文已经降到 40%"的会话直接判交接。
    //   2) 上下文仍然偏高。若压缩已经把占用降下来了，就不存在"收益递减"问题。
    // 2026-09-16：口径随维度 B 一起改锚**声明窗口**（原来比的是有效窗口）。
    finalAdvice = 'handoff';
    drivenBy = 'override';
    finalReason =
      `已发生 ${measuredSummaryCount} 次**模型摘要**（有损），且上下文仍占声明窗口 ` +
      `${windowPercent.toFixed(0)}%（≥${T.compactMildFrom}%）—— 反复摘要收益递减、信息有累积损失；` +
      '同时按真实价格继续会话已经不划算，机械交接（无损事实底座）更值得。';
    finalNote = FINAL_NOTES.repeatedSummary(measuredSummaryCount);
  } else if (
    afterPercent !== null &&
    afterPercent > T.handoffAfterWindowPercent &&
    // 同上：压缩压不动是事实，但"压不动"只说明压缩这条路收益低，
    // 并不说明换会话更省。按"一切基于省钱"，钱不支持新开时降级为提示。
    freshWinsOnCostAny
  ) {
    finalAdvice = 'handoff';
    drivenBy = 'override';
    finalReason = `上次压缩后仍占声明窗口 ${afterPercent.toFixed(0)}%（>${T.handoffAfterWindowPercent}%）—— 压缩已压不动，且按真实价格继续会话不划算，建议机械交接。`;
    finalNote = FINAL_NOTES.afterCompactionStillHigh;
  } else if (nearOfficial) {
    // ── 官方线（2026-09-16 重定位：从"抢控制权"改为"告知官方会处理"）─────────
    // 实测：在 79~80% 处手动压，一次性约 ¥0.5、回本要 35 轮，而到官方线只剩 0~1 轮
    // —— 必然摊不完。官方到线会**先做零 token 的工具结果修剪**，修剪后低于阈值就跳过摘要。
    // 所以这里不再劝手动 /compact，只把事实说清楚：官方会处理，你不需要动手。
    finalAdvice = 'continue';
    drivenBy = 'official';
    finalReason =
      `占声明窗口 ${fmt(windowPercent)}，已接近官方自动压缩线（${T.officialCompactPercent}%）。` +
      '到线时官方会**先做零 token 裁剪**（超大工具结果的中段会被丢弃），修剪后低于阈值就完全跳过摘要；' +
      '即便要摘要也是同一套引擎、同样的钱，且不必付"提前重建缓存"那一笔。' +
      '因此无需手动 `/compact`。';
    finalNote = FINAL_NOTES.officialWillHandle;
  } else if (band === 'recommend' || band === 'mild' || band === 'urgent') {
    // 先看"现在要不要动手"：官方线还很远就别催。
    if (deferCompaction) {
      const where = !headroomRoundsKnown
        ? `当前只占声明窗口 ${windowPercent.toFixed(1)}%（官方线在 ${T.officialCompactPercent}%）`
        : breakEvenSlowerThanLine
          ? `距官方自动压缩线约 ${headroomRounds.toLocaleString()} 轮，而这次压缩要约 ${Math.ceil(breakEvenRoundsYuan)} 轮才回本`
          : `距官方自动压缩线还有约 ${headroomRounds.toLocaleString()} 轮`;
      finalAdvice = 'continue';
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}（${where}）—— 无需手动压缩：` +
        '压缩的一次性成本要先付、摘要有损，而按真实价格它到官方线前摊不回来；' +
        '到线官方会自动处理，且**先做零 token 裁剪**（仍会丢弃工具结果中段）。';
      // note 里保留"距官方线还有几轮"，用户能自己核对（`where` 在已知轮数时含该信息）。
      finalNote = headroomRoundsKnown
        ? `${FINAL_NOTES.noManualCompact}（${where}）`
        : FINAL_NOTES.noManualCompact;
    } else if (!worthCompacting && !nearOfficial) {
      // 可压缩余量太小（刚压缩过 / 上下文几乎全是压不动的骨架）→ 压缩没有收益。
      // 但"压缩没收益"**不等于**"该继续"：再用真实价格比一次总花费 ——
      //   继续 vs 新开（**分段计费**：首轮 = 公共前缀命中价 + 交接文档未命中价；第 2 轮起命中价）
      // 新开明显更省时才改判（2026-09-16 用户指令；2026-09-18 N 节改口径）。
      if (freshWinsOnCostAny) {
        finalAdvice = 'handoff';
        drivenBy = 'cost';
        finalReason =
          `${compactReason}（但当前可压缩量仅约 ${compressibleNow.toLocaleString()} token。` +
          `按真实价格比较到官方线前的总花费：继续 ≈ ${fmtYuan(totalContinueYuan)}、` +
          `**新开 ≈ ${fmtYuan(totalFreshYuan)}** —— ${fmtFreshLedger()}。` +
          '新开会话更省，建议机械交接。）';
        finalNote = FINAL_NOTES.costFavorsFresh;
      } else {
        finalAdvice = 'continue';
        finalReason =
          `占声明窗口 ${fmt(windowPercent)}；当前可压缩量仅约 ${compressibleNow.toLocaleString()} token，` +
          '压缩的收益接近 0，继续即可。';
        finalNote = FINAL_NOTES.noCompressibleRoom;
      }
    } else if (freshWinsOnCostAny) {
      // 三方案总花费比较里，**新开明显最省**。
      // 最典型的场景：**缓存命中率崩了**（某个改动让前缀缓存整体失效）——
      // 继续每一轮都按未命中价重付全部上下文；压缩只是把数字变小，变小后仍按未命中价付；
      // 而新会话虽然也要重建缓存，但它的上下文本身就只有 20k + 交接文档。
      // 实测：500k 上下文、命中率 0% 时，继续 ¥0.50/轮、压缩后仍 ¥0.21/轮，新开只要 ¥0.034/轮。
      finalAdvice = 'handoff';
      drivenBy = 'cost';
      finalReason =
        `${compactReason}（但按真实价格比较三方案在到官方线前的总花费：` +
        `继续 ≈ ${fmtYuan(totalContinueYuan)}、压缩 ≈ ${fmtYuan(totalCompactYuan)}、` +
        `**新开 ≈ ${fmtYuan(totalFreshYuan)}** —— ${fmtFreshLedger()}。` +
        '新开会话最省，建议机械交接。）';
      finalNote = FINAL_NOTES.costFavorsFresh;
    } else if (hitRateKnown && totalCompactYuan < totalContinueYuan) {
      // 压缩在**钱上**比继续便宜，但它不再构成行动建议（原因见本节开头）。
      // 新开也没有明显更省（`freshWinsOnCost` 为假），所以结论是继续，
      // 把"压缩账面更省"作为信息留在 reason 里。
      finalAdvice = 'continue';
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}。账面看压缩比继续便宜` +
        `（压缩 ≈ ${fmtYuan(totalCompactYuan)} vs 继续 ≈ ${fmtYuan(totalContinueYuan)}，${H} 轮口径），` +
        '但它是一次性支出 + 有损，且到官方线前摊不回来；新开也没有明显更省，继续即可。';
      finalNote = FINAL_NOTES.noManualCompact;
    } else {
      // 两种情形都落到这里：
      //   ① 有实测命中率，但**压缩在官方线前摊不完**（真实价格下这是常态 ——
      //      压缩省下的那部分本来就按命中价计费 0.02 元/百万，而重建按未命中价 1 元/百万）；
      //   ② **缺命中率实测** —— 不做成本裁决（拿假设值劝人换会话不合适），保守判继续。
      finalAdvice = 'continue';
      drivenBy = 'cost';
      // X 节（2026-09-18 用户拍板）：删掉"为什么这么算"的解释（压缩一次性多少、
      // 每轮多少、为什么摊不完）—— **界面与文档只呈现"现在是什么"和"可以做什么"**，
      // 算法细节属于 DEPLOYMENT-NOTES。这里只留窗口内的两个总额（可核对的事实）。
      finalReason = hitRateKnown
        ? `${compactReason}（真实价格下，距官方线的 ${H} 轮里：压缩 ${fmtYuan(totalCompactYuan)} vs 继续 ${fmtYuan(totalContinueYuan)}。）`
        : `${compactReason}（本会话还没有缓存命中率的实测值，**不做成本推断**，保守判继续。）`;
      finalNote = FINAL_NOTES.continueBeatsCompact;
    }
  } else if (!continueWinsOnCost) {
    // 上下文规模还没进档位（声明窗口 <50%），但**最近一次请求的缓存命中率崩了**：
    // 继续每轮实付反而明显高于新开。此时"继续"是三个方案里最贵的那个，
    // 不能因为"规模不大"就默认它最省 —— 规模小、但每一轮都按全价付，照样烧钱。
    drivenBy = 'cost';
    if (freshWinsOnCostAny) {
      finalAdvice = 'handoff';
      finalNote = FINAL_NOTES.costFavorsFresh;
    } else {
      // 继续比新开贵（`continueWinsOnCost === false`），但**回本 + 余量没落进窗口** ——
      // 交接的钱省不回来（2026-09-18：判据从"1.5 倍金额容差"改为"回本轮数 + 轮数余量"）。
      // （压缩不再是选项：它同样摊不回来，也不修复退化。）
      finalAdvice = 'continue';
      finalNote = FINAL_NOTES.noManualCompact;
    }
    // AB.2（2026-09-20 复核侧实测）：这段措辞原先**不分通道** —— 普通成本通道
    // （"继续每轮比新开贵"）也套用了给"缓存崩了"写的那句话，于是 99.70% 命中率的会话
    // 被写成「命中率只有 99.7%，前缀复用已经失效，继续等于按未命中价重付全部上下文」，
    // **语义与事实完全相反**。该会话真实原因只有一个：**存量规模差异**
    // （继续每次请求都要发 258k 存量，新会话只有 32k），缓存本身好得很。
    //
    // 现在按命中率是否低于 `brokenCacheHitRate` 分两句，各说各自成立的真话 ——
    // "失效 / 重付全部上下文"这类强断言只留给真的崩了的会话（验收见 AB.2）。
    const hitRateText = useTail
      ? `最近 ${tail.length} 次请求的累计命中率`
      : '最近一次请求的缓存命中率';
    const cacheBroken = hitRate < (T.brokenCacheHitRate ?? 0.5);
    finalReason = cacheBroken
      ? `${compactReason}（但按真实价格算：继续每轮约 **${fmtYuan(continuePerTurnYuan)}**，` +
        `${fmtFreshLedger()} —— ${hitRateText}只有 ${(hitRate * 100).toFixed(1)}%，` +
        '前缀复用**已经失效**：继续等于按未命中价重付全部上下文，' +
        `而新会话的存量只有 ${freshRoundTokens.toLocaleString()} token。）`
      : `${compactReason}（但按真实价格算：继续每轮约 **${fmtYuan(continuePerTurnYuan)}**，` +
        `每次请求都要重付 ${usedTokens.toLocaleString()} 存量；${fmtFreshLedger()} —— ` +
        `差距来自**存量规模**，不是缓存：${hitRateText} ${(hitRate * 100).toFixed(1)}% 属正常，` +
        `而新会话的存量只有 ${freshRoundTokens.toLocaleString()} token。）`;
  } else {
    // 两条交接判据（异常 / 成本）都没触发 → 继续。
    finalAdvice = 'continue';
    if (dataMissing) {
      finalReason = '本会话尚未记录到用量；下一次请求后即可判断是否需要交接。';
    } else if (degraded) {
      // 2026-09-18 M 节修复：这里原先把"未检出退化信号"**写死**，
      // 于是在"有退化、但占用低 / 成本也不划算"（压缩后最常见）时说假话 ——
      // 同一屏上维度 A 写"已检出（思考打转 10 次）"、最终理由写"未检出"，自相矛盾。
      // 现在按 `degraded` 分支，并把**具体是哪几条**摆出来（M-2：历史退化不该被静默抹去）。
      //
      // AF.2 需求 2（2026-09-20）：这一档正好是"**边界快到了**"——
      // 已经检出退化、但还没到该交接的程度。原先的措辞是"继续即可，但请留意……"，
      // 语义上就是中间档，所以这里直接升为 `prepare`（不催促、不否定继续）。
      finalAdvice = 'prepare';
      drivenBy = 'quality';
      const scope =
        effectivePercent === null
          ? '但缺窗口或用量数据，规模风险无法判断'
          : `但有效占用仍只有 ${fmt(effectivePercent)}（<${T.qualityHandoffPercent}%）`;
      finalReason =
        `已检出退化信号（${degradeSignalsText()}），${scope}，按真实价格继续也未见不划算 —— ` +
        `**继续即可**，但边界快到了：**若再次出现打转，本次会话就该交接了**（可在下一个任务边界交接）。` +
        `到官方自动压缩线（${T.officialCompactPercent}%）时官方会自己处理（**先做零 token 裁剪**，仍会丢弃工具结果中段）。`;
    } else {
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}，未检出退化信号，按真实价格继续也未见不划算 —— 继续即可。` +
        `到官方自动压缩线（${T.officialCompactPercent}%）时官方会自己处理（**先做零 token 裁剪**，仍会丢弃工具结果中段）。`;
    }
    finalNote = dataMissing
      ? FINAL_NOTES.dataMissing
      : finalAdvice === 'prepare'
        ? FINAL_NOTES.prepareHandoff
        : FINAL_NOTES.stillReliable;
  }

  // ── 成本通道的**三级软化**（AF.2 需求 2 + AG 节 2026-09-22）──────────────────
  //
  // 第一版（AF.2）为什么不够：只有 `continue` 与 `handoff` 两档时，"**差一点**"的情况被
  // 归进"可以继续"，用户既看不出边界快到了，也没有"在任务边界顺手交接"的余地。
  //
  // AG 节（2026-09-22 用户实测：「对话才 6 轮插件就建议机械交接了」）暴露了另一半问题：
  // 光是加一个"中间档"不够 —— 一个 **7 轮**的会话被判 `handoff` 时，数字全对
  // （10 次请求/轮 × 235k 存量，到官方线前省 ¥2.38），但**任务刚展开就劝人换会话**
  // 会把任务切成碎片；照做之后新会话以同样增速 7 轮又触发，形成循环。
  // 所以这一档扩成**三级**（`costNote` 是新增的最轻一级）：
  //
  //   · `handoff`（黄 ●）  ：钱上划算 **且** 会话已成熟（`轮数 ≥ matureSessionTurns`）；
  //   · `prepare`（浅黄 ○）：钱上划算但**会话还早**（成熟线拦截），或省额 / 余量"差一点"；
  //   · `costNote`（浅蓝 ·）：省额连"差一点"都算不上 —— 只说"每轮成本偏高"，不劝动作。
  //
  // ⚠️ 全部只在**成本通道**成立：不覆盖质量 / 官方线 / 推迟压缩这些已经想清楚的结论
  // （第一版就在这里踩过 —— 它把官方线决策覆盖了，两条边界用例当场报红）。
  {
    const costGatesOpen =
      priceUsable &&
      hitRateKnown &&
      usedTokens > 0 &&
      typeof headroomRounds === 'number' &&
      windowPercentOK &&
      horizonOK;
    const minSaving = T.minSavingYuan ?? 0.15;
    const savingRatio = T.prepareSavingRatio ?? 0.6;
    const matureTurns = T.matureSessionTurns ?? 15;
    /**
     * 会话是否**还没到成熟线**。
     *
     * `turnCount === 0`（轮数拿不到）时判 `false` = **不降级** —— 无从判断成熟度时
     * 保持原判，老输入 / 合成输入的行为不变（与 `stepsPerTurn` 缺轮数时退化为 1 同一条原则：
     * 缺数据不改变已有结论，只让新机制闭嘴）。
     */
    const immatureSession = turnCount > 0 && turnCount < matureTurns;
    const nearSavingGate =
      savingYuan > 0 && savingYuan < minSaving && savingYuan >= minSaving * savingRatio;
    const thinMargin =
      freshBreakEvenRounds !== null &&
      freshWinMarginRounds !== null &&
      freshWinMarginRounds >= 0 &&
      freshWinMarginRounds <= (T.prepareMarginRounds ?? 2);
    if (
      // ① **成熟线**（AG.3）：成本通道已经判"该交接"，但会话还没跑够 → 降级为软提示。
      //    质量通道不在此列（`drivenBy !== 'cost'`），真异常该说就说。
      finalAdvice === 'handoff' &&
      drivenBy === 'cost' &&
      immatureSession
    ) {
      finalAdvice = 'prepare';
      // 理由要说真话：压住这一档的是"任务可能刚展开"，**不是钱不够** ——
      // 钱上它确实划算（数字照给），只是现在打断的代价不在成本模型里。
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}，成本上交接**已经划算**：继续每轮约 ` +
        `${fmtYuan(continuePerTurnYuan)}，${fmtFreshLedger()}。` +
        `但本会话只跑了 **${turnCount} 轮**（成熟线 ${matureTurns} 轮）—— 任务可能刚展开，` +
        '此刻换会话容易把任务切成碎片。**建议在自然边界（任务 / 阶段完成时）交接**，' +
        '不必现在打断：继续下去规模更大、每轮差额更大，这笔账只会更划算。';
      finalNote = FINAL_NOTES.immatureCostHandoff;
    } else if (
      finalAdvice === 'continue' &&
      // ⚠️ **不覆盖已经想清楚的结论**（实测踩到）：官方线决策（`drivenBy='official'`，
      // 结论是"到线官方会自己先做零 token 裁剪，无需手动操作"）与质量强制覆盖（`override`）
      // 都有自己的道理，中间档只该把"因为钱不够所以继续"抬成"准备交接"。
      drivenBy !== 'official' &&
      drivenBy !== 'override' &&
      !freshWinsOnCostAny &&
      costGatesOpen &&
      (thinMargin || nearSavingGate)
    ) {
      finalAdvice = 'prepare';
      drivenBy = 'cost';
      const marginText =
        freshWinMarginRounds === null ? '' : `，窗口 ${H} 轮内只剩 ${freshWinMarginRounds.toFixed(1)} 轮余量`;
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}，按真实价格继续仍可行，但交接**已经接近划算**：` +
        `继续每轮约 ${fmtYuan(continuePerTurnYuan)}、新开首轮 ${fmtYuan(freshFirstTurnYuan)} → ` +
        `之后 ${fmtYuan(freshPerTurnYuan)}/轮，${
          freshBreakEvenRounds === null ? '回本无从谈起' : formatBreakEven(freshBreakEvenRounds).ledger
        }${marginText}。**可在下一个任务边界交接**（继续也完全可以）。` +
        `（按当前增速外推，样本 P25~P75 差约 2.4 倍。）`;
      finalNote = FINAL_NOTES.prepareHandoff;
    } else if (
      // ③ `costNote`（AG.3 新增最轻档）：成本**偏高、但连"差一点"都算不上**。
      //    放在最后：既不覆盖上面已想清楚的结论，也不抢 `prepare` 的位置。
      //    只陈述事实（每轮多少、窗口内省多少、不划算），**不给任何动作建议**。
      finalAdvice === 'continue' &&
      drivenBy !== 'official' &&
      drivenBy !== 'override' &&
      !freshWinsOnCostAny &&
      costGatesOpen &&
      savingYuan > 0 &&
      savingYuan < minSaving * savingRatio
    ) {
      finalAdvice = 'costNote';
      drivenBy = 'cost';
      finalReason =
        `占声明窗口 ${fmt(windowPercent)}，按真实价格继续仍是最稳妥的选择：继续每轮约 ` +
        `${fmtYuan(continuePerTurnYuan)}（新开首轮 ${fmtYuan(freshFirstTurnYuan)} → 之后 ` +
        `${fmtYuan(freshPerTurnYuan)}/轮，${
          freshBreakEvenRounds === null ? '新开每轮并不更省' : formatBreakEven(freshBreakEvenRounds).ledger
        }），到官方线前合计只省 ${fmtYuan(savingYuan)} —— 低于换会话的门槛（${fmtYuan(minSaving)}），` +
        '换过去并不划算。**留意单次塞入的内容量**即可，无需其他操作。';
      finalNote = FINAL_NOTES.costNotePerTurn;
    }
  }

  // ── 压缩相关的**事实提示**：只说事实，不改判 ──────────────────────────────
  // 「反复摘要有损」「压缩压不动」都是信息，不是行动理由 —— 压缩在钱上摊不回来、
  // 在异常上也不修复退化（用户 2026-09-16 重定位）。它们只在结论不是交接时作为 note 附上。
  // （若钱上确实支持换会话，那条判据已在上面的 `freshWinsOnCost` 分支处理。）
  if (finalAdvice !== 'handoff') {
    const summaryStalled =
      measuredSummaryCount >= T.handoffAtCompactionCount &&
      windowPercent !== null &&
      windowPercent >= T.compactMildFrom;
    const compactionStalled = afterPercent !== null && afterPercent > T.handoffAfterWindowPercent;
    const extra = summaryStalled
      ? FINAL_NOTES.repeatedSummaryButCheaper(measuredSummaryCount)
      : compactionStalled
        ? FINAL_NOTES.compactionStalledButCheaper
        : '';
    if (extra) finalNote = finalNote ? `${finalNote}；${extra}` : extra;
  }

  // 行动建议文案（2026-09-16 重定位；2026-09-20 AF.2 增加 prepare 中间档）。
  const finalText = {
    continue: dataMissing
      ? '数据不足：暂无法判断（按现状继续即可）'
      : '可以继续（无需交接）',
    // AF.2 需求 2：**不催促**的中间档 —— 说明"边界快到了"，同时明确"继续也完全可以"。
    prepare: '接近交接阈值 · 可在下一个任务边界交接',
    // AG（2026-09-22）：最轻一档 —— 只说"成本偏高"，绿色/黄色的行动语义都不适用。
    costNote: '每轮成本偏高（可继续）',
    handoff:
      drivenBy === 'quality'
        ? '建议机械交接 + 新开会话'
        : '建议机械交接 + 新开会话（继续会话已不划算）',
    // 兼容位：`compact` 不再是可能的取值。保留键是为了让**旧客户端**
    // （或读到历史数据的情形）取它时不至于拿到 undefined。
    compact: '无需手动压缩（到官方线官方会自动处理）',
  }[finalAdvice];

  const freshPerTurn = Math.round(freshPerRound * stepsPerTurn);

  const plans = {
    continue: { perRound: continuePerTurn, remainingRounds: T.remainingRounds },
    compact: {
      once: compactOnceCost,
      rebuild: rebuildCost,
      totalOnce: compactTotalOnce,
      perRound: compactPerTurn,
      savingPerRound,
      breakEvenRounds,
      compactedTokens,
      // 摘要成本拆解：被压缩历史按缓存价 + 摘要输出按全价
      summaryInputCost: Math.round(compactedTokens * T.cacheFactor),
      summaryOutput,
      // 压缩收益的现实约束：只能压掉"不可压缩基线"之上的部分
      baseline,
      compressibleNow,
      worthCompacting,
      lossy: true,
    },
    handoff: {
      once: handoffOnceCost,
      perRound: freshPerTurn,
      lossless: true,
      docTokens: handoffDocTokens,
    },
  };

  /**
   * 真实价格口径（元）—— 全部由上方 `P`（`COMPACT_DEFAULTS.prices`）算出。
   *
   * 为什么要有第二套账：token 当量只能横向比较，回答不了"到底该花谁的钱"。
   * 接入真实价格后立刻暴露两件事（2026-09-16 实测）：
   *   ① 高命中率下"继续"极便宜 —— 600k 上下文约 ¥0.03/轮；
   *   ② 压缩的真实回本比原口径慢 2.5 倍（21 轮 vs 8 轮），因为省下的那部分本来就按命中价计费。
   */
  const costYuan = {
    currency: 'CNY',
    /** 单价表（元/百万 token），原样带出以便界面与文档标注口径。 */
    price: {
      cacheHitPerMillion: P.cacheHitPerMillion,
      cacheMissPerMillion: P.cacheMissPerMillion,
      outputPerMillion: P.outputPerMillion,
    },
    /** 每轮平均输出 token（输出按 4 元/百万计，是未命中输入的 4 倍）。 */
    avgOutputTokens,
    hitRate,
    /** 命中率是否有实测依据；false = 缺用量数据，界面不要显示金额结论。 */
    hitRateKnown,
    /** 跨会话公共前缀的实测命中率（方案 C 首轮分段计费的依据，2026-09-18）。 */
    handoffBaseHitRate: baseHitRate,
    blendedInputPrice,
    // ── AB.3（2026-09-20）：下面所有 `*PerRound` 都是**每轮**（= 每次请求 × stepsPerTurn）──
    /** 一轮里的平均请求次数（一个"轮"可能发多次请求，工具调用会开新请求）。 */
    stepsPerTurn,
    /** 有实测的轮次数（`stepsPerTurn` 的分母；0 = 取不到，此时退化按 1 处理）。 */
    turnCount,
    continuePerRound: continuePerTurnYuan,
    compactPerRound: compactPerTurnYuan,
    compactOnce: compactOnceYuan,
    /** 压缩一次性成本按"距官方线剩余轮数"摊销后的每轮总成本（展示用）。 */
    compactAmortizedPerRound: compactOnceYuan / H + compactPerTurnYuan,
    horizonRounds,
    compactSavingPerRound: compactSavingPerTurnYuan,
    /** 真实价格下的回本轮数（未四舍五入，便于文档显示小数）。 */
    breakEvenRounds: breakEvenRoundsYuan,
    /**
     * 新开会话**第 2 轮起**的每轮成本：首轮的全部输入已落盘为缓存前缀单元 → 按**命中价**。
     * （2026-09-18 前这里按未命中价，是错的，见 `freshOnce` 与 `freshBreakEvenRounds`。）
     */
    freshPerRound: freshPerTurnYuan,
    /**
     * 新开会话**首轮**（一次性）：跨会话公共前缀按实测命中率加权 + 交接文档按未命中价 + 输出。
     */
    freshOnce: handoffOnceYuan,
    /** 新开**首轮整轮**的总额（= `freshOnce` + 本轮其余请求）—— 界面"新开首轮 ¥X"取它。 */
    freshFirstTurn: freshFirstTurnYuan,
    /** 交接**回本轮数** = 首轮溢价 ÷ 每轮节省；`null` = 交接每轮并不更省。 */
    freshBreakEvenRounds,
    /** 回本后还能剩几轮；负数 = 到官方线前摊不回来。界面据此把账摊给用户。 */
    freshWinMarginRounds,
    /** 首轮相对后续每轮的溢价（元）—— 回本的分子，展示用。 */
    freshFirstRoundPremium,
    /** 交接每轮相对继续省多少（元）—— 回本的分母，展示用。 */
    freshSavingPerRound,
    // ── 三方案在"到官方线为止"这个窗口内的总花费（元）—— 裁决用的就是这三个数 ──
    totalContinue: totalContinueYuan,
    totalCompact: totalCompactYuan,
    totalFresh: totalFreshYuan,
    /** 交接相对继续的绝对节省额（元）—— 界面显示"新开可省 ¥X"用（S-3）。 */
    savingYuan,
    /** 是否达到最小节省额门槛（S-1）。false = 钱上支持换、但差额小到不值得折腾。 */
    savingEnough,
    // ── 价格来源与档位（T 节 2026-09-18）——让界面能如实标注
    //    "这账是按哪天的价、哪一档算的"，而不是看起来一样自信 ──
    /** 价格是否可用于裁决（false = 模型不认识，成本通道已跳过）。 */
    priceKnown: priceInfo.known,
    /** 当前档位：'peak'（工作日 9-12 / 14-18）| 'offPeak'。 */
    priceTier: priceInfo.tier,
    /** 价格数据来源：'内置核对值' | 'prices.json'。 */
    priceSource: priceInfo.source,
    /** 价格数据日期（如 '2026-09-18'）。 */
    priceDate: priceInfo.date,
    /** 解析到的模型名（缺失时为 null）。 */
    priceModel: priceInfo.model,
    /** 模型名是否匹配到价表（false = 模型未知，按第一张表估算且不可用于决策）。 */
    priceModelMatched: priceInfo.modelMatched,
    /**
     * 给界面/文档的一句话价格说明（**host 拼好**，界面不自己拼）——
     * T-9 / T-10：让用户看得见"这账是按哪天的价、哪一档、哪个模型算的"。
     */
    priceLabel: priceInfo.known
      ? `价格：${priceInfo.source} ${priceInfo.date} · ` +
        (priceInfo.onHoliday
          ? `法定节假日（全天空闲价，节假日表 ${priceInfo.holidaysFetchedAt ?? '—'}）`
          : priceInfo.tier === 'peak'
            ? '高峰价（工作日 9-12/14-18）'
            : '空闲价') +
        (priceInfo.modelMatched ? '' : '（模型未知，按默认模型估算）')
      : `模型 ${priceInfo.model ?? '?'} 不在价表里 —— 成本比较已跳过（只保留质量判定）`,
    /** 结论：新开在钱上胜出 —— 回本判据**或**缓存崩了（见 `freshWinsOnCostAny`）。 */
    freshWinsOnCost: freshWinsOnCostAny,
    /** 结论：继续每轮没有贵过新开。 */
    continueWinsOnCost,
  };

  return {
    thresholds: T,
    window: {
      contextWindow,
      effectiveWindow,
      usedTokens,
      windowPercent,
      effectivePercent,
      officialLine,
      headroomToOfficial,
      headroomRounds,
      avgRoundGrowth: avgGrowth,
    },
    usage: {
      // 判定口径：尾窗累计（`hitRateBasis='last'` 表示样本不足，回退到最近一次读数）
      cacheReadTokens: hit,
      cacheMissTokens: miss,
      hitRate,
      perRoundFactor,
      hitRateBasis: useTail ? 'tail' : 'last',
      windowSamples: tail.length,
      // 最近一次请求的原始读数（展示"最近一次命中多少"这类文案时取它）
      lastCacheReadTokens: lastHit,
      lastCacheMissTokens: lastMiss,
    },
    // 维度 A（口径：有效窗口；2026-09-16 起判据需伴随退化信号）
    quality: {
      basis: `有效窗口 = ${T.effectiveWindowRatio}×声明 = ${effectiveWindow?.toLocaleString() ?? '?'} token`,
      effectivePercent,
      signals,
      degraded,
      advice: qualityAdvice,
      reason: qualityReason,
    },
    // 维度 B（档位口径：**声明窗口**，与官方线同一坐标系）
    compact: {
      basis: `档位口径 = 声明窗口；官方声明线 ${officialLine?.toLocaleString() ?? '?'}（有效窗口 ${T.effectiveWindowRatio}×声明 = ${effectiveWindow?.toLocaleString() ?? '?'} 仅用于质量维度）`,
      windowPercent,
      band,
      bandText,
      reason: compactReason,
      officialLine,
      headroomToOfficial,
      headroomRounds,
      plans,
      savingPerRound,
      breakEvenRounds,
    },
    // 最终结论
    final: { advice: finalAdvice, adviceText: finalText, reason: finalReason, note: finalNote, drivenBy },
    history: {
      count: compactCount,
      summaryCount: input.summaryCount ?? 0,
      pruneCount: input.pruneCount ?? 0,
      last: input.lastCompaction ?? null,
      afterCompactionPercent: afterPercent,
    },
    plans,
    /** 真实价格（元）口径的三方案账 —— 判定"该不该新开"用的就是它。 */
    cost: costYuan,
    // 兼容旧调用点
    advice: finalAdvice,
    adviceText: finalText,
    reason: finalReason,
  };
}

/** 规则推导「下一步」。 */
export function deriveNextSteps(x) {
  const out = [];

  if (x.openTurn !== undefined) {
    out.push(`第 ${x.openTurn} 轮**尚未闭合** —— 会话是在任务进行中被中断的，先确认该轮产物是否完整。`);
  }

  const badTurns = x.turns.filter((t) => t.reason && t.reason !== 'completed');
  if (badTurns.length) {
    const last = badTurns[badTurns.length - 1];
    out.push(`第 ${last.turn} 轮以 \`${last.reason}\` 结束，需要判断是否重做这一轮。`);
  }

  const todos = Array.isArray(x.todos) ? x.todos : [];
  const lastTurnNo = x.turns.length ? x.turns[x.turns.length - 1].turn : undefined;
  const staleTodos = x.todosTurn !== undefined && lastTurnNo !== undefined && x.todosTurn < lastTurnNo;
  for (const t of todos.filter((t) => t.status === 'in_progress').slice(0, 3)) {
    out.push(`待办清单里标为进行中：**${clip(t.content, 120)}**`);
  }
  const pending = todos.filter((t) => t.status === 'pending');
  if (pending.length) {
    // 快照过期时不要以确定语气断言"未完成"（2026-09-15 审查：旧文案两个括号叠在一起）
    out.push(
      staleTodos
        ? `待办快照停留在第 ${x.todosTurn} 轮，其后又过了 ${(lastTurnNo ?? x.todosTurn) - x.todosTurn} 轮 —— 下列 ${pending.length} 项**请以工作区实际状态为准**（见上方「待办」）。`
        : `待办清单里还有 ${pending.length} 项未勾选（见上方「待办」清单）。`,
    );
  }

  // 流程性重试（如"改文件前没先读文件"）不算技术故障，不进"未解决需追查"清单
  const allGroups = aggregateErrors(x);
  const unresolved = allGroups.filter((g) => g.stillActive && !isProceduralRetry(g));
  if (unresolved.length) {
    out.push(
      `有 ${unresolved.length} 类错误**最近仍出现**（${unresolved.map((g) => g.label).join('、')}），接手前先判断是否要继续追。`,
    );
  }
  const procedural = allGroups.filter((g) => isProceduralRetry(g));
  if (procedural.length) {
    const n = procedural.reduce((sum, g) => sum + g.count, 0);
    out.push(
      `另有 ${n} 次**流程性重试**（${procedural.map((g) => g.label).join('、')}）—— 工具使用顺序问题，不是技术故障，无需追查。`,
    );
  }

  const lastReq = x.userRequests[x.userRequests.length - 1];
  // 与「最新目标」同一套筛选：控制指令不算"最近一条请求"（2026-09-15 审查修复）
  const lastSubstantive = [...x.userRequests].reverse().find((r) => !isControlRequest(r.text)) ?? lastReq;
  if (lastSubstantive) {
    const tail =
      lastSubstantive !== lastReq ? `（其后还有控制指令，最后一条：\`${clip(lastReq.text, 40)}\`）` : '';
    out.push(`最近一条实质性请求：${clip(lastSubstantive.text, 200)}${tail}`);
  }

  if (x.files.length) {
    out.push(
      `本次会话改过 ${x.files.length} 个文件；接手前先确认工作区真实状态（git status / 直接读文件），不要只信上面的清单。`,
    );
  }

  if (x.usage.lastContextTokens) {
    out.push(
      `会话末尾上下文约 ${x.usage.lastContextTokens.toLocaleString()} token；新会话建议从「最新目标」与「待办」起步，不要回灌全部历史。`,
    );
  }

  if (!out.length) out.push('日志中未见未闭合状态，可直接依据上面的主线继续。');
  return out;
}

/** 超长文本摘要：按段落累积到上限，并标注全文长度。 */
export function summarize(text, maxChars) {
  const flat = String(text ?? '').replace(/\r/g, '');
  if (flat.length <= maxChars) return flat.replace(/\s+/g, ' ').trim();

  const parts = flat.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    const oneLine = p.replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    const next = out ? `${out}\n   ${oneLine}` : oneLine;
    if (next.length > maxChars) break;
    out = next;
  }
  if (!out) out = flat.replace(/\s+/g, ' ').slice(0, maxChars);
  return `${out}\n   （全文 ${flat.length.toLocaleString()} 字）`;
}

