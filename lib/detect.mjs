/**
 * 会话健康度检测 —— 从日志**机械推断**上下文退化风险。
 *
 * 零模型、纯规则。本模块的算法同时服务于两条线：
 *   1. 离线分析（`handoff.mjs --health`）—— 用于验证阈值、分析历史会话
 *   2. 在线插件（后续阶段）—— 同一套判据搬到 host 插件的 projection 里
 *
 * ## 检测的四个信号
 *
 * | 信号 | 数据来源 | 可靠性 |
 * |---|---|---|
 * | 上下文占用率 | 最后一次 `assistant/message` 的 `usage.totalTokens` ÷ `request/context.contextWindow` | 高（真实计量） |
 * | 重复工具调用 | `tool/call` 序列中连续相同的 `(name, arguments)` | 高（精确匹配，几乎不误报） |
 * | 输出退化 | `assistant/message` 的 `text` block：围栏不闭合 / 复读 / 符号堆砌 | 中（启发式） |
 * | **思考退化** | `assistant/message` 的 `reasoning` block：行重复率 ≥0.7 或单块 ≥10 万字符；<br>或 `usage.reasoningTokens` ≥ 16,000（**真实计量**，与字符数无关） | 高（有真实事故样本，门槛经 70 会话实测） |
 *
 * ## 设计立场
 *
 * 退化检测**宁可漏报也不要误报**。误报会让用户忽略提示，那比不提示更糟。
 *
 * ## 与插件的关系（2026-09-15 复核 N-5）
 *
 * 判据与评分**都在 `lib/handoff.js`**（`replyDegradeReasons` / `scanReasoning` /
 * `scoreContextHealth`）；本模块只负责"把日志事件扫一遍"，再把结果交给同一个评分函数。
 * 这里不再保留平行实现 —— 那正是历史上三次"两处口径分叉"的来源。
 *
 * @module detect
 */

import { eventSeq } from './session-log.mjs';
// 2026-09-15 复核 N-5：评分与退化判据**不再在本文件重复实现**。
//
// 本模块早于插件写成，长期持有一份平行实现（同一套 5 条规则 + 同一套扣分表 + 同一份
// 有效窗口系数）。插件每调整一次判据，这里就得手工跟上 —— 两步一走就会分叉，
// 而 `plugin-test` 的"与离线版一致"断言正是为此存在的。现在直接复用
// `lib/handoff.js` 的唯一实现：判据（`replyDegradeReasons` / `scanReasoning`）
// 与评分（`scoreContextHealth`）都从那里来，"一处修改、两处生效"。
import {
  COMPACT_DEFAULTS,
  blocksToText,
  contextTokensOf,
  replyDegradeReasons,
  scanReasoning,
  scoreContextHealth,
} from './handoff.js';

/** 重复工具调用的告警阈值（对齐 DSH 自带 repeat-tool-reminder 的默认值）。 */
const REPEAT_THRESHOLDS = [3, 5, 8];

/**
 * 有效窗口系数：模型**声明**的上下文窗口并不等于它能可靠工作的区间。
 *
 * Chroma 的 Context Rot 研究显示，宣称百万级窗口的模型其性能在
 * **声明窗口的 50%~60%** 处就已明显衰减（例如 GPT-4.1 声明 1M，危险线在 500K）。
 *
 * 因此风险判断基于「声明窗口 × 本系数」，而占声明窗口的原始百分比
 * 仍然如实呈现给用户 —— 事实与判断分开，避免误导。
 *
 * 唯一来源是 `lib/handoff.js` 的 `COMPACT_DEFAULTS.effectiveWindowRatio`。
 *
 * @type {number}
 */
// 2026-09-18 审查 B3：原为 `export const`，但全项目**没有任何外部引用**。
// 本模块内部（下面的 `analyzeSession` 默认参数）仍在用它，所以常量必须保留，
// 只把多余的 `export` 去掉。
const EFFECTIVE_WINDOW_RATIO = COMPACT_DEFAULTS.effectiveWindowRatio;

/** 插件判据键 → 本模块历史上的 issue 名（保持输出形状兼容）。 */
const DEGRADE_ISSUE_NAME = {
  fence: 'code-fence-unclosed',
  lineRepeat: 'repeated-line',
  paraRepeat: 'repeated-paragraph',
  symbolRun: 'symbol-run',
};

/** 截断并压平文本，用于展示。 */
function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// `contextTokensOf` 已上移到 `lib/handoff.js`（2026-09-15 复核）——
// 本文件曾与 `lib/index.js` 各持一份相同实现，正是"两处口径分叉"的温床。
// 现在与判据、评分一样走"一处修改、两处生效"。

/**
 * 检测单段文本里的退化特征。
 *
 * @param {string} text
 * @returns {string[]} 命中的特征标签
 */
function textDegradation(text) {
  // 判据本体在 `lib/handoff.js`（唯一实现）；这里只做键名映射，保持输出形状。
  //
  // 2026-09-15 复核 N-5 删除的判据：`language-drift`（中英严重混杂）——
  // 全量 73 会话实测 25 次命中、**25/25 全是误报**（中文说明 + 英文代码 / 路径是常态）。
  return replyDegradeReasons(text).map((key) => DEGRADE_ISSUE_NAME[key] ?? key);
}

/**
 * 分析一个会话的健康度。
 *
 * @param {{header: object, events: object[]}} session
 * @param {object} [options]
 * @param {number} [options.effectiveWindowRatio] - 有效窗口系数，默认 0.5
 * @returns {object} 健康报告
 */
export function analyzeSession(session, { effectiveWindowRatio = EFFECTIVE_WINDOW_RATIO } = {}) {
  const { events = [] } = session;

  // ---------- 1. 上下文占用 ----------
  let contextWindow;
  let lastContextTokens = 0;
  let maxContextTokens = 0;
  let replies = 0;

  // ---------- 2. 重复工具调用 ----------
  let prevKey = null;
  let streak = 1;
  let streakStart;
  let streakWorst = 0; // 真实"最长连续相同调用"（含未达告警阈值的 1、2 次）
  const repeatStreaks = [];
  const closeStreak = () => {
    if (!prevKey) return;
    // 口径必须与投影一致（2026-09-15 复核）：指数**真实最长连续次数**，
    // 而不是"只从 ≥3 的告警列表里取 max"。原先两者不一致 ——
    // 同一会话投影说"重复工具调用 1 次"、离线 CLI 说 0 次，
    // 正是项目历史上反复出现的"两处口径分叉"。
    if (streak > streakWorst) streakWorst = streak;
    if (streak >= REPEAT_THRESHOLDS[0]) {
      const [name, args] = prevKey.split('\u0000');
      repeatStreaks.push({ name, arguments: args, count: streak, seq: streakStart });
    }
  };

  // ---------- 3. 输出退化 ----------
  const degradedReplies = [];

  // ---------- 3b. 思考退化（2026-09-15 复核 N-5）----------
  // 实测事故：单个思考块把「好。」重复 69,667 次、`reasoningTokens` 打满 256,000，
  // 而同一轮最终回复完全正常 —— 旧版只读 `text` block，思考里的退化一个字都没检查。
  let reasoningLoop = 0;
  let reasoningFlags = 0;
  let reasoningWorstRepeat = 0;

  // ---------- 4. 有损压缩史（模型摘要次数）----------
  // 2026-09-15 复核【遗留-2】：压缩是"续命"（有损），不是治愈。只看 totalTokens 会让
  // 压缩后的会话直接回到 100 分 / ok，提示条随之消失。这里与 `lib/handoff.js` 的
  // `COMPACT_DEFAULTS.lossySummaryCaps` **保持同一组数值** —— plugin-test 的对齐断言
  // 会逐会话比较 score，两处一旦不一致会立刻失败。
  let summaryCount = 0;

  for (const event of events) {
    const data = event.data ?? {};

    if (event.type === 'request/context') {
      if (typeof data.contextWindow === 'number') contextWindow = data.contextWindow;
      continue;
    }

    if (event.type === 'assistant/message') {
      const tokens = contextTokensOf(data.usage);
      if (tokens > 0) {
        lastContextTokens = tokens;
        if (tokens > maxContextTokens) maxContextTokens = tokens;
      }
      replies += 1;

      const text = blocksToText(data.message?.content);
      const issues = textDegradation(text);
      if (issues.length) {
        degradedReplies.push({
          turn: data.turn,
          step: data.step,
          seq: eventSeq(event),
          issues,
          excerpt: clip(text, 120),
        });
      }

      // 思考退化：按条计数，打转优先归类（与插件同一口径）
      // usage 一并传入：`thinkBudget` 走的是 `reasoningTokens` 真实计量（消息级）。
      const think = scanReasoning(data.message?.content, data.usage);
      if (think.flagged) {
        // 与 lib/index.js / lib/handoff.js 同口径（2026-09-18 修复）：
        // `symbolRun`（符号堆砌）**不计入** `reasoningFlags` —— 它是精确率存疑的弱信号
        // （README 实测思考侧 22/22 落在代码 / 正则里），不该参与交接判定。
        // 三路径必须一致，否则 crosscheck-test 会红。
        if (think.reasons.includes('thinkLoop')) reasoningLoop += 1;
        else if (think.reasons.includes('thinkHuge')) reasoningFlags += 1;
        if (think.worstRepeat > reasoningWorstRepeat) reasoningWorstRepeat = think.worstRepeat;
      }
      continue;
    }

    if (event.type === 'compaction/summary') {
      summaryCount += 1;
      continue;
    }

    if (event.type === 'tool/call') {
      const key = `${data.name ?? '?'}\u0000${data.arguments ?? ''}`;
      if (key === prevKey) {
        streak += 1;
      } else {
        closeStreak();
        prevKey = key;
        streak = 1;
        streakStart = eventSeq(event);
      }
    }
  }
  closeStreak();

  // ---------- 评分（委托给 `lib/handoff.js` 的唯一实现）----------
  // 上下文规模随会话单调增长（压缩会使其下降），取最后一次读数；
  // 若最后一次缺失，回退到历史最大值。
  const usedTokens = lastContextTokens || maxContextTokens;
  const worstRepeat = streakWorst;

  const scored = scoreContextHealth({
    usedTokens,
    contextWindow,
    repeatWorst: worstRepeat,
    degradedReplies: degradedReplies.length,
    reasoningLoop,
    reasoningFlags,
    reasoningWorstRepeat,
    summaryCount,
    thresholds: { effectiveWindowRatio },
  });
  const { score, level, findings } = scored;
  const percent = scored.effectivePercent;
  const percentOfWindow = scored.windowPercent;
  const effectiveWindow = scored.effectiveWindow;

  return {
    context: {
      usedTokens,
      lastContextTokens,
      maxContextTokens,
      contextWindow,
      effectiveWindow,
      effectiveWindowRatio,
      percent,
      percentOfWindow,
    },
    repeats: {
      worst: worstRepeat,
      streaks: repeatStreaks.sort((a, b) => b.count - a.count).slice(0, 10),
    },
    degradation: {
      count: degradedReplies.length,
      samples: degradedReplies.slice(0, 8),
      // 思考退化（N-5）：与插件同源，打转优先归类
      reasoningLoop,
      reasoningFlags,
      reasoningWorstRepeat,
    },
    replies,
    score,
    level,
    findings,
  };
}

/** 健康等级的展示元数据（离线与在线共用同一套措辞）。 */
export const LEVEL_META = {
  ok: { label: '正常', hint: '会话状态健康，可以继续。' },
  watch: { label: '留意见', hint: '开始出现退化迹象，建议在完成当前子任务后准备交接。' },
  warn: { label: '建议交接', hint: '退化风险明显，建议现在生成交接文档并新开会话。' },
  critical: { label: '建议立即新开会话', hint: '风险很高，继续追问只会强化错误模式。请先落盘交接文档，再新开会话。' },
};
