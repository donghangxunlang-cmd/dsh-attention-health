/**
 * attention-health —— DSH 上下文健康监测（host 半）
 *
 * ## 零 token 保证
 *
 * 本插件**只注册一个 session projection**，不注入任何模型可见内容：
 *   - 不返回 `additionalContexts`
 *   - 不调用 `agent.inject()`
 *   - 不 `session.append()` 任何事件
 *
 * 依据：投影注册表"只为已入日志的会话状态提供面向客户端的读模型，
 * 不注册任何模型可见内容"（`@deepseek-ai/dsh-session-projection/README.zh.md`）。
 * 投影"从不组装或发送提供方请求"，KV Cache 影响为无。
 *
 * ## 数据流
 *
 * ```
 * session/event ──► projection.apply(state, event)   （同步纯折叠）
 *                        │
 *                        ▼
 *                   wire.view(state)  ──► 浏览器 ProjectionValueStore
 *                                              │
 *                                              ▼
 *                                        useProjection('attentionHealth')
 * ```
 *
 * 客户端**零代码**即自动同步；UI 侧只需消费这个 key。
 *
 * ## 部署
 *
 * 本文件必须位于 `$DSH_HOME/profiles/web/` 树内 —— 它 `import 'zod'`，
 * 而 Node 的模块解析需要向上找到 `$DSH_HOME/profiles/node_modules`（实测可行）。
 * 用 `deploy.ps1` 复制过去，或直接在 profile 目录维护。
 *
 * ## 挂载
 *
 * 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：
 *
 * ```yaml
 * - insert:
 *     - id: attention-health
 *       name: './attention-health/index.js'
 * ```
 *
 * ⚠️ **新增/更新插件行不会热加载，必须重启 DSH**（实测；见
 * `DEPLOYMENT-NOTES-20260915.md` 第 2.1 节）。`patchReload: live` 只让**已加载**插件的
 * patch 片段变化即时生效，不负责挂载新行。
 *
 * ## 交接内容生成（2026-09-15 新增）
 *
 * UI 半提示条展开后有一个「生成交接内容」按钮；点击后浏览器调用本文件注册的
 * 本地路由 `GET /attention-health/handoff?sessionId=...`，由 `handoff.js` 纯规则
 * 折叠日志并返回精简 Markdown，页面再把它预填进**新会话**的输入框（保持未发送）。
 * 全过程零模型调用、零 token。
 *
 * 为什么用 HTTP 而不是 Remote Service：官方 `@Remote` / `ctx.remote` 需要 typert
 * 生成链（本机没有源码 checkout，无法构建），而 `webServer.register` 是原生的
 * `(req, res)` 通道，零额外依赖、当场可用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import {
  COMPACT_DEFAULTS,
  DEGRADE_LABELS,
  HIT_RATE_WINDOW,
  blocksToText,
  buildHandoff,
  contextTokensOf,
  deriveCompactionPlan,
  replyDegradeReasons,
  scanReasoning,
  scoreContextHealth,
} from './handoff.js';
// 交接历史留痕（2026-09-15 复核 N-6 建议 1）：纯本地、零 token 的阈值回溯素材。
import { recordHandoff } from './history.js';
// 实时思考守卫（2026-09-16 用户新增）：检测到思考复读 / 空转就**立刻中止本轮生成**。
import { GUARD_DEFAULTS, createLoopGuard } from './guard.js';
// 守卫现场的本地落档（2026-09-18 Q-3）：让"误杀"这件事以后**能查**。
// Z.5（2026-09-18 复核侧裁决）：尾部原文默认保留 500 字，可用环境变量切到隐私模式。
import { recordGuardTrip, shapeGuardTail } from './guard-log.js';

/** 落档时保留的思考原文尾部字符数（Q-3）。500 足够看出"当时在重复什么"。 */
const GUARD_TAIL_CHARS = 500;

/** 交接生成路由（前缀路由，实际只应答这一个精确路径）。 */
const ROUTE_PATH = '/attention-health/handoff';

/**
 * 探测某个会话在磁盘上的日志代际（如 `v3`），供交接文档头部的可追溯信息使用。
 *
 * 活会话读的是内存，磁盘代际只是参考；找不到就返回 undefined ——
 * 探测失败绝不能影响生成（整段都包在 try 里）。
 */
function detectLogGeneration(sessionId) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const root = path.join(home, 'sessions');
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name, sessionId);
      if (!fs.existsSync(dir)) continue;
      let best;
      for (const entry of fs.readdirSync(dir)) {
        const m = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(entry);
        if (!m) continue;
        const gen = m[1] ? Number(m[1]) : 0;
        if (best === undefined || gen > best) best = gen;
      }
      if (best !== undefined) return `v${best}`;
    }
  } catch {
    /* 探测失败不影响生成 */
  }
  return undefined;
}

/** Cordis 插件名。 */
export const name = 'attention-health';

/** 只依赖投影注册表；不需要 tokenMeter / fs / llm。 */
export const inject = ['sessionProjections'];

// 有效窗口系数（声明窗口 × ratio，2026-09-16 起为 0.6）的**唯一来源**是 `handoff.js` 的
// `COMPACT_DEFAULTS.effectiveWindowRatio`；本文件不再自留一份副本
// （2026-09-15 复核 P3-2：这里原来是第三个硬编码的 0.5，另有 `lib/detect.mjs`
// 保留着老版本实现）。评分与有效占用一律由 `scoreContextHealth` 计算。

/** 退化回复计数的上限，避免状态字段无限增长。 */
const DEGRADED_CAP = 99;

/** 轮次计数的上限（AB 节 2026-09-20）：只用来算 `stepsPerTurn` 这个比值，无需无限增长。 */
const TURN_COUNT_CAP = 9999;

// ────────────────── 异常现场明细（2026-09-18 H.8） ──────────────────
//
// 用户诉求：「点击异常提醒，能看看出问题的地方长什么样」。
// 真跳转（滚动到聊天流对应消息并高亮）**不可行** —— DSH 没有暴露任何滚动 / 定位
// 客户端 API，硬做只能玩 DOM 查询，官方一升级就碎（审查清单 H.8 的调研结论）。
// 就地展开原文则完全可行：数据本来就在会话事件里，插件自己就能读，不需要新 API。
//
// 代价与克制：明细要过 wire 发给客户端，所以**只留最近的现场、每条只留一小段**。

/** 异常明细保留的条数上限（防 wire 膨胀）。 */
const DEGRADED_SAMPLE_CAP = 5;

/** 单条摘录的字符上限（与 `viewSchema` 的 `excerpt` 约束必须一致）。 */
const DEGRADED_EXCERPT_CHARS = 200;

/**
 * 把任意文本压成"单行摘录"：折叠空白（含换行）→ 去首尾空白 → 超长截断。
 *
 * 折叠换行是**为了界面**：明细是一行一条，原文里的换行会让每条占掉很多行。
 * 审查清单 H.8 给的展示形态就是 `做。 / （Go。） / 做。 / …`（换行变成分隔符）。
 */
function toExcerpt(text, max = DEGRADED_EXCERPT_CHARS) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) : one;
}

/**
 * 取"最能说明问题"的思考现场。
 *
 * 为什么不直接取开头 200 字：打转往往发生在块的**中后段**，取开头只能看到一段
 * 正常推理（实测 H.1 那次 14,911 字符的块，开头是像模像样的分析）。
 * 所以先找该块里**出现次数最多的非空行**，从它第一次出现的位置开始截 ——
 * 那里就是复读的起点。
 *
 * 没有重复行时（如"思考异常长"但内容不重复）退回取开头，**不编造现场**。
 *
 * @param {Array|string} content - `data.message.content`
 * @returns {string} 单行摘录（≤ `DEGRADED_EXCERPT_CHARS`）
 */
function reasoningExcerpt(content) {
  const blocks = Array.isArray(content)
    ? content.filter((b) => b?.type === 'reasoning' && typeof b.text === 'string' && b.text.trim())
    : [];
  if (!blocks.length) return '';
  // 多个 reasoning 块时取最长的那个（现场信息量最大）
  let longest = blocks[0];
  for (const b of blocks) if (b.text.length > longest.text.length) longest = b;
  const text = longest.text;

  const counts = new Map();
  let topLine = '';
  let topCount = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // 单字符行（`}`、`）` 之类）即使重复也不说明问题，跳过
    if (line.length < 2) continue;
    const n = (counts.get(line) ?? 0) + 1;
    counts.set(line, n);
    if (n > topCount) {
      topCount = n;
      topLine = line;
    }
  }
  // 至少重复 3 次才算"打转现场"：2 次重复在正常推理里很常见，不该被当成现场起点
  const at = topCount >= 3 ? text.indexOf(topLine) : -1;
  return toExcerpt(at > 0 ? text.slice(at) : text);
}

/**
 * 追加一条异常明细。
 *
 * 两条规则，都是为了让 5 个名额装下**5 个不同现场**：
 *   · **同轮同类去重** —— 一个轮次里可能有几十条 `assistant/message`，
 *     不去重的话 5 条会全是同一轮的重复条目，别的轮次全被挤掉；
 *   · **只留最近 CAP 条** —— 防 wire 膨胀（H.8 方案写明上限 5）。
 *
 * 注意：只在**确有命中**时调用，没命中就原样传回旧数组 —— `foldEvent` 靠
 * 引用相等做 `unchanged` 早退，这里新建数组必须是"真的变了"。
 */
function withSample(list, sample) {
  const kept = (Array.isArray(list) ? list : []).filter(
    (s) => !(s.turn === sample.turn && s.kind === sample.kind),
  );
  kept.push(sample);
  return kept.slice(-DEGRADED_SAMPLE_CAP);
}

// ─────────────────────────── wire 契约 ───────────────────────────

/** 退化命中原因（wire 形状）。 */
const degradeReasonSchema = z
  .object({
    key: z.string(),
    count: z.number().int().nonnegative(),
    label: z.string(),
  })
  .strict();

/**
 * 一条"异常现场"（2026-09-18 H.8）。
 *
 * `turn` 为 **0 表示轮次未知** —— 事件没带 turn 时如实表达"不知道是哪一轮"，
 * 而不是拿别的数字顶上（界面据此渲染"轮次未知"）。
 */
const degradedSampleSchema = z
  .object({
    /** 出问题的轮次；0 = 未知。 */
    turn: z.number().int().nonnegative(),
    /** 现场类型：思考退化 / 输出退化 / 守卫中止。 */
    kind: z.enum(['reasoning', 'reply', 'guard']),
    /** 现场摘录（单行、已折叠空白、≤200 字符）。 */
    excerpt: z.string().max(DEGRADED_EXCERPT_CHARS),
  })
  .strict();

/** 离开 host 的负载（客户端消费的形状）。 */
const viewSchema = z
  .object({
    /** 0–100 综合健康分。 */
    score: z.number().int().min(0).max(100),
    /** 风险等级。 */
    level: z.enum(['ok', 'watch', 'warn', 'critical']),
    /** 当前上下文 token 规模（来自最后一次请求的 totalTokens）。 */
    usedTokens: z.number().nonnegative(),
    /** 模型声明的窗口；未知时为 null。 */
    contextWindow: z.number().positive().nullable(),
    /** 占**有效窗口**的百分比（用于风险判断）；未知时为 null。 */
    effectivePercent: z.number().nullable(),
    /** 有效窗口系数（有效窗口 = 声明窗口 × 本值）—— 界面据它渲染口径文案，避免再硬编码一处。 */
    effectiveWindowRatio: z.number().positive(),
    /** 占**声明窗口**的百分比（客观事实）；未知时为 null。 */
    windowPercent: z.number().nullable(),
    /** 最长连续相同工具调用次数。 */
    repeatWorst: z.number().int().nonnegative(),
    /** 检测到退化特征的回复数（只统计最终回复）。 */
    degradedReplies: z.number().int().nonnegative(),
    /** 回复退化的命中原因（key / 次数 / 中文标签）。 */
    replyReasons: z.array(degradeReasonSchema),
    /** 思考打转次数（同一行反复重复 —— 实测事故里唯一能看到的信号）。 */
    reasoningLoop: z.number().int().nonnegative(),
    /** 思考其他异常次数（异常长 / 预算打满 / 符号堆砌）。 */
    reasoningFlags: z.number().int().nonnegative(),
    /** 思考里同一行重复的最高次数（0 = 未观测到）。 */
    reasoningWorstRepeat: z.number().int().nonnegative(),
    /** 思考退化的命中原因。 */
    reasoningReasons: z.array(degradeReasonSchema),
    /** 人类可读的风险说明。 */
    findings: z.array(z.string()),
    // ── 压缩 / 交接建议（需求补充 1/2，纯本地估算）──
    /** 官方自动压缩线（声明窗口 × 80%）；窗口未知时为 null。 */
    officialLine: z.number().nullable(),
    /** 距官方压缩线的余量 token；未知时为 null。 */
    headroomToOfficial: z.number().nullable(),
    /** 按平均每轮增长，距压缩线还能撑多少轮；未知时为 null。 */
    headroomRounds: z.number().int().nullable(),
    /** 平均每轮上下文增长（token）—— `headroomRounds` 的分母，界面据此解释轮数怎么来的。 */
    avgRoundGrowth: z.number().nonnegative(),
    /** 已经压缩过几次（模型摘要 + 零 token 裁剪）。 */
    compactionCount: z.number().int().nonnegative(),
    /** 最近一次压缩是否调用了模型。 */
    lastCompactionWasModel: z.boolean(),
    /** 维度 A｜质量结论（口径：**有效窗口**；2026-09-16 起两个阈值都需伴随退化信号）。 */
    qualityAdvice: z.enum(['continue', 'handoff', 'immediate']),
    /** 维度 B｜压缩档位（档位口径：**声明窗口**，与官方 80% 硬线同坐标）。 */
    compactBand: z.enum(['continue', 'mild', 'recommend', 'urgent']),
    /** 最终建议（质量优先于压缩）：继续 / 准备交接 / 机械交接。 */
    compactAdvice: z.enum(['continue', 'compact', 'prepare', 'handoff']),
    /** 最终建议文案（一句话）。 */
    compactAdviceText: z.string(),
    /** 最终建议理由（短）。 */
    compactReason: z.string(),
    /** 界面用的一句话依据：无 Markdown、不复述已有数字（`compactReason` 是给文档的完整论证）。 */
    compactAdviceNote: z.string(),
    /** 三方案每轮成本估算（token 当量）。 */
    continuePerRound: z.number().nonnegative(),
    compactPerRound: z.number().nonnegative(),
    compactSavingPerRound: z.number(),
    /** 方案 C｜机械交接后新会话的每轮成本。 */
    freshPerRound: z.number().nonnegative(),
    /** 方案 B｜压缩一次性成本（摘要重读 + 缓存重建）。 */
    compactTotalOnce: z.number().nonnegative(),
    /** 方案 B｜回本轮数（压缩省下的每轮成本摊掉一次性成本所需轮数）；不可算时为 null。 */
    compactBreakEvenRounds: z.number().int().nullable(),
    /** 最近一次请求的前缀缓存命中率（0~1）—— 决定"每轮实付"相对全价的折扣。 */
    cacheHitRate: z.number().min(0).max(1),
    // ── 真实价格（元）口径（2026-09-16 接入）──
    /** 继续：每轮真实花费（元）。 */
    costContinuePerRound: z.number().nonnegative(),
    /** 压缩后：每轮真实花费（元）。 */
    costCompactPerRound: z.number().nonnegative(),
    /** 压缩：一次性真实花费（元）= 摘要重读 + 摘要输出 + 缓存重建。 */
    costCompactOnce: z.number().nonnegative(),
    /** 压缩一次性成本按"距官方线剩余轮数"摊销后的每轮总成本（元）。 */
    costCompactAmortizedPerRound: z.number().nonnegative(),
    /** 新开会话：**第 2 轮起**每轮（元）—— 首轮输入已落盘为缓存前缀单元，按**命中价**算。 */
    costFreshPerRound: z.number().nonnegative(),
    /** 真实价格下的回本轮数（未取整，便于显示小数）；不可算时为 null。 */
    costBreakEvenRounds: z.number().nullable(),
    /** **交接**回本轮数（首轮溢价 ÷ 每轮节省）；null = 交接每轮并不更省。2026-09-18 新增。 */
    costFreshBreakEvenRounds: z.number().nullable(),
    /** 交接回本后还能剩几轮；负数 = 到官方线前摊不回来。null 同上。 */
    costFreshWinMarginRounds: z.number().nullable(),
    /** 跨会话公共前缀的实测命中率（方案 C 首轮分段计费的依据，2026-09-18 新增）。 */
    costHandoffBaseHitRate: z.number(),
    /** 是否已判定"压缩在钱上输给新开"（界面据此解释为什么改推新开）。 */
    costFreshWinsOnCost: z.boolean(),
    /** 交接相对继续的**绝对节省额**（元）—— 界面显示"到官方线前可省 ¥X"（S 节 2026-09-18）。 */
    costSavingYuan: z.number(),
    /** 是否达到最小节省额门槛（false = 钱上支持换、但差额小到不值得折腾）。 */
    costSavingEnough: z.boolean(),
    // ── 价格来源与档位（T 节 2026-09-18）：界面据此**如实标注**，而不是看起来一样自信 ──
    /** 价格是否可用于裁决（false = 模型不认识，成本比较已跳过）。 */
    costPriceKnown: z.boolean(),
    /** 当前价格档位：高峰（工作日 9-12 / 14-18）| 空闲。 */
    costPriceTier: z.enum(['peak', 'offPeak']),
    /** 一句话价格说明（host 拼好：来源 / 日期 / 档位 / 模型是否已知）。 */
    costPriceLabel: z.string(),
    /** 三方案在"到官方线为止"窗口内的总花费（元）。 */
    costTotalContinue: z.number().nonnegative(),
    costTotalCompact: z.number().nonnegative(),
    costTotalFresh: z.number().nonnegative(),
    /** 该窗口的轮数（= 距官方线还能撑几轮；估不出时为保守默认值）。 */
    costHorizonRounds: z.number().int().nonnegative(),
    /** 命中率是否有实测依据；false = 金额只是按假设命中率估的，不可作为决策依据。 */
    costHitRateKnown: z.boolean(),
    /** 每轮平均输出 token（输出 4 元/百万，是未命中输入的 4 倍，必须单独算钱）。 */
    avgOutputTokens: z.number().nonnegative(),
    /** 现在压缩是否还有可压余量（false = 刚压缩过 / 几乎全是压不动的骨架）。 */
    compactWorthwhile: z.boolean(),
    /** 是否应该打扰用户（= level 非 ok，或最终建议不是"继续"）。 */
    shouldNotify: z.boolean(),
    /** 实时思考守卫的中止计数与最近原因（2026-09-16 新增，界面要显示）。 */
    guardTripCount: z.number().int().nonnegative(),
    lastGuardReason: z.string().nullable(),
    /**
     * 异常现场明细（2026-09-18 H.8）：最近 5 条退化的「轮次 + 摘录」。
     * 界面据它在展开区就地列出"出问题的地方长什么样"（真滚动跳转 DSH 没这 API）。
     */
    degradedSamples: z.array(degradedSampleSchema),
    /** 模型摘要次数（有损）；压缩次数里真正会累积信息损失的那部分。 */
    summaryCount: z.number().int().nonnegative(),
  })
  .strict();

/** host 侧折叠态 = wire 负载 + 折叠所需的内部字段。 */
const stateSchema = viewSchema
  .extend({
    /** 上一次工具调用的规范化键，用于连续重复检测。 */
    lastCallKey: z.string().nullable(),
    /** 当前连续重复计数。 */
    callStreak: z.number().int().nonnegative(),
    /** 模型摘要次数（消耗 token、有损）。 */
    summaryCount: z.number().int().nonnegative(),
    /** 零 token 裁剪次数。 */
    pruneCount: z.number().int().nonnegative(),
    /** 最近一次压缩的事实。 */
    lastCompactionAt: z.number().nullable(),
    lastCompactionKind: z.enum(['summary', 'prune']).nullable(),
    lastCompactionShadowedTokens: z.number().nonnegative(),
    lastCompactionSummaryTokens: z.number().nonnegative(),
    lastCompactionSummaryInputTokens: z.number().nonnegative(),
    lastCompactionManual: z.boolean(),
    /** 压缩**前**那一刻的上下文规模（token），用于展示"压缩前 → 压缩后"。 */
    lastCompactionPreTokens: z.number().nonnegative(),
    /** 压缩后首次请求的**实测**上下文规模（token）= 不可压缩基线；0 表示未观测到。 */
    lastCompactionAfterTokens: z.number().nonnegative(),
    /** 压缩后首次请求的**声明窗口**占比（%）；未观测到为 null。 */
    afterCompactionPercent: z.number().nullable(),
    /** 是否在等"压缩后第一次请求"落地。 */
    awaitingCompactionAfter: z.boolean(),
    /** 最后一次请求的缓存命中 / 未命中输入 token。 */
    cacheReadTokens: z.number().nonnegative(),
    cacheMissTokens: z.number().nonnegative(),
    /** 输出 token 的累计与计数（成本模型按全会话平均输出算输出费）。 */
    outputTokensSum: z.number().nonnegative(),
    outputTokensCount: z.number().int().nonnegative(),
    /** 带 usage 的请求次数（审查 P2：区分"缓存还没建立"与"缓存崩了"）。 */
    usageCount: z.number().int().nonnegative(),
    /**
     * 已开始的**轮次数**（AB 节 2026-09-20）。
     *
     * 内部字段（不进 wire）：`stepsPerTurn = usageCount / turnCount` 是成本口径的分母 ——
     * 一个"轮"里可能发多次请求，而 `cost.continuePerRound` 这类对外量的名字写着"每轮"，
     * 不换算就会把"每次请求"的钱当成"每轮"的钱用（实测某会话差 2.27 倍）。
     * 取不到（0）时判定链退化为"每轮一次请求"，与旧口径等价。
     */
    turnCount: z.number().int().nonnegative(),
    /** 最近一次思考守卫中止发生在哪一轮（2026-09-16；内部状态，不进 wire 契约）。 */
    lastGuardTurn: z.number().int().nullable(),
    /**
     * 命中率尾窗（2026-09-16 实测新增）：最近 `HIT_RATE_WINDOW` 次请求的 `{ hit, total }`。
     * 成本判定用它的**累计**命中率 —— 单次快照会把"压缩后重建前缀"这类一次性事件
     * 误判成"缓存崩了"（实测 13 段触发里 10 段在 3 轮内自愈）。
     */
    recentUsage: z.array(z.object({ hit: z.number().nonnegative(), total: z.number().nonnegative() })),
    /** 每轮上下文增长样本（用于估算还能撑几轮）。 */
    growthSum: z.number().nonnegative(),
    growthCount: z.number().int().nonnegative(),
    /** 上一「已结束轮次」的上下文结束规模（按轮结算，与交接文档同口径）。 */
    growthTurnEndTotal: z.number().nonnegative(),
    /** 当前轮次的最新上下文读数。 */
    growthCurTurnTotal: z.number().nonnegative(),
    /** 退化命中原因的**内部**计数（plain object，wire 前由 `toReasonList` 转数组）。 */
    replyReasonCounts: z.record(z.string(), z.number().int().nonnegative()),
    reasoningReasonCounts: z.record(z.string(), z.number().int().nonnegative()),
    /**
     * 最近一次请求的**模型名**（T 节 2026-09-18）。
     *
     * 内部字段（不进 wire）：它的用途是让判定链拿到**正确的价表** ——
     * 换模型（flash → pro，价差 3~4.5 倍）时账必须跟着换，否则整套账静默算错。
     * 界面上要看到的是解析结果（档位 / 来源 / 日期），那些走 `costPrice*` 下发。
     */
    model: z.string().nullable(),
  })
  .strict();

// ─────────────────────────── 折叠逻辑 ───────────────────────────

// `contextTokensOf` 已上移到 `handoff.js`（2026-09-15 复核）—— 与 `lib/detect.mjs`
// 各持一份拷贝正是"两处口径分叉"的温床，理由同下方 `textOf` 的删除。此处不再保留实现。

/**
 * 取一个"**有限非负数**"，否则用回退值。
 *
 * 为什么必须用它：`typeof NaN === 'number'` 为**真**。所以直觉写法
 * `typeof x === 'number' ? x : fallback` 会把 `NaN` / `Infinity` 放进状态，
 * 而 wire schema 是 `z.number().nonnegative()`（拒收 NaN）——
 * 一条畸形的 usage 就能让**投影发布失败**。
 *
 * 2026-09-15 多功能交叉验证实测：本文件有 **5 处** 这种写法会漏过 NaN
 * （缓存 token ×2、压缩 shadowed/summary ×3）。全部改走本函数。
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 把"命中原因计数"（内部用 plain object 存，便于做不可变比较）转成 wire 契约要的数组。
 *
 * 2026-09-15 复核 N-5：提示条原来只说"输出异常 N 条"，用户无从判断这条提示可不可信；
 * 现在带上命中的判据名（如"符号堆砌 ×2"）。
 */
function toReasonList(counts) {
  return Object.entries(counts ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([key, count]) => ({ key, count, label: DEGRADE_LABELS[key] ?? key }));
}

// 注：本文件原有的 `textOf()` 已删除（2026-09-15 复核 N-5）。它只认 `text` block，
// 而 `handoff.js` 导出的 `blocksToText()` 是同一职责的**唯一实现** —— 两边各留一份
// 会让热会话（投影）与冷会话（日志折叠）的退化计数分叉。

/**
 * 检测单段文本的退化特征。
 *
 * 立场：**宁可漏报也不要误报** —— 误报会让用户忽略提示，比不提示更糟。
 * 因此只捕获特征明显的形态。
 *
 * @param {string} text
 * @returns {boolean} 是否出现退化特征
 */
// 本地重复实现已删除（2026-09-15 审查修复）：
// 这里原来有一份 5 条规则的退化判断，而 `handoff.js` 里另有一份 3 条规则的实现，
// 导致**热会话（投影）与冷会话（日志折叠）的退化计数不一致** —— 交接文档里的健康度
// 可能与当时看到的提示条自相矛盾。现在统一由 `handoff.js` 导出的唯一实现，
// 本文件顶部 `import { looksDegraded }` 直接复用。

/**
 * 由原始指标重算评分、等级与说明。
 *
 * 2026-09-15 复核 P3-2 / P3-3：评分与有效窗口口径**不再在本文件实现** ——
 * 抽出的 `scoreContextHealth` 由热会话（本函数）与冷会话（`handoff.js` 渲染时
 * 用日志折叠结果补算）共用，既避免两处评分分叉，也顺手消掉了本地那份 0.5 系数。
 * 结构化行所需的 `effectivePercent` / `windowPercent` 一并由它返回。
 */
function finalize(base) {
  const { usedTokens, contextWindow, repeatWorst, degradedReplies } = base;

  const { score, level, findings, effectivePercent, windowPercent } = scoreContextHealth({
    usedTokens,
    contextWindow,
    repeatWorst,
    degradedReplies,
    // 思考退化（2026-09-15 复核 N-5）：真实事故里唯一能看到的信号，必须参与评分。
    reasoningLoop: base.reasoningLoop,
    reasoningFlags: base.reasoningFlags,
    reasoningWorstRepeat: base.reasoningWorstRepeat,
    // 有损压缩史参与评分上限（2026-09-15 复核【遗留-2】）：压缩是续命，不是治愈。
    summaryCount: base.summaryCount,
  });

  // ── 压缩 / 交接三态建议（纯本地算术，与交接文档复用同一份模型）──
  const avgGrowth = base.growthCount > 0 ? base.growthSum / base.growthCount : 0;
  const plan = deriveCompactionPlan({
    contextWindow,
    usedTokens,
    cacheReadTokens: base.cacheReadTokens,
    cacheMissTokens: base.cacheMissTokens,
    // 每轮平均输出 token（真实价格口径要算输出费）
    avgOutputTokens:
      base.outputTokensCount > 0 ? base.outputTokensSum / base.outputTokensCount : 0,
    // 请求次数（审查 P2：区分"缓存还没建立"与"缓存崩了"）
    usageCount: base.usageCount ?? 0,
    // 轮次数（AB 节 2026-09-20）：成本口径的 `stepsPerTurn` 分母，见 stateSchema 注释。
    turnCount: base.turnCount ?? 0,
    // 命中率尾窗（2026-09-16）：成本判定用**累计**命中率，见 handoff.js 的 HIT_RATE_WINDOW
    recentUsage: base.recentUsage ?? [],
    avgRoundGrowth: avgGrowth,
    compactionCount: base.summaryCount + base.pruneCount,
    summaryCount: base.summaryCount,
    pruneCount: base.pruneCount,
    // 维度 A 的退化信号（口径：有效窗口）
    //
    // ⚠️ 2026-09-18 修复：这里原本**只传了 `repeatWorst` / `degradedReplies`**，
    // 漏掉思考侧三个字段 —— 而 `degraded` 判定里含 `reasoningLoop > 0`，
    // 于是"有效占用 100% + 思考打转 7 次"被判成「可以继续」（用户截图的现场）。
    //
    // 漏传的原因值得记下来：上面 `scoreContextHealth()` 是**另一个调用**，
    // 它一直传着这三个值（所以评分照扣 −50），**判定链却看不见** ——
    // 两个调用相邻且形似，grep `reasoningLoop:` 会先命中上面那个，造成"已经传了"的错觉。
    repeatWorst,
    degradedReplies,
    reasoningLoop: base.reasoningLoop,
    reasoningFlags: base.reasoningFlags,
    reasoningWorstRepeat: base.reasoningWorstRepeat,
    // R 节（2026-09-18）：守卫中止次数也是**判定输入** —— 此前它只用于界面显示，
    // 于是"被掐断 4 次"的会话质量维度仍说"继续"，最终只靠成本当理由。
    guardTripCount: base.guardTripCount,
    // T 节（2026-09-18）：模型名决定用哪张价表（flash / pro 差 3~4.5 倍）。
    model: base.model,
    lastCompaction:
      base.lastCompactionShadowedTokens > 0 || base.lastCompactionSummaryTokens > 0
        ? {
            shadowedTokens: base.lastCompactionShadowedTokens,
            summaryTokens: base.lastCompactionSummaryTokens,
            summaryInputTokens: base.lastCompactionSummaryInputTokens,
            preUsedTokens: base.lastCompactionPreTokens,
            afterUsedTokens: base.lastCompactionAfterTokens,
          }
        : undefined,
    afterCompactionPercent: base.afterCompactionPercent,
  });

  return {
    ...base,
    score,
    level,
    findings,
    effectivePercent,
    windowPercent,
    // 界面口径文案用的系数：从 `COMPACT_DEFAULTS` **单向下发**，界面不再自己写死。
    // 注意 `stateSchema = viewSchema.extend(...)`，所以它必须同时存在于 state 与 view，
    // 否则每一条投影都会因缺字段被 zod 拒绝（这里加错一次就会全线崩，见 O1 键集合断言）。
    effectiveWindowRatio: COMPACT_DEFAULTS.effectiveWindowRatio,
    compactionCount: base.summaryCount + base.pruneCount,
    officialLine: plan.window.officialLine,
    headroomToOfficial: plan.window.headroomToOfficial,
    headroomRounds: plan.window.headroomRounds,
    avgRoundGrowth: Math.round(avgGrowth),
    qualityAdvice: plan.quality.advice,
    compactBand: plan.compact.band,
    compactAdvice: plan.final.advice,
    compactAdviceText: plan.final.adviceText,
    compactReason: plan.final.reason,
    compactAdviceNote: plan.final.note,
    continuePerRound: plan.plans.continue.perRound,
    compactPerRound: plan.plans.compact.perRound,
    compactSavingPerRound: plan.plans.compact.savingPerRound,
    freshPerRound: plan.plans.handoff.perRound,
    compactTotalOnce: plan.plans.compact.totalOnce,
    compactBreakEvenRounds: plan.plans.compact.breakEvenRounds,
    cacheHitRate: plan.usage.hitRate,
    // ── 真实价格（元）口径（2026-09-16）────────────────────────────────────
    // token 当量只能横向比较，回答不了"到底该花谁的钱"。这几个字段是**元**，
    // 由 `COMPACT_DEFAULTS.prices`（DeepSeek flash 空闲价）算出，判定"该不该新开"用的就是它。
    costContinuePerRound: plan.cost.continuePerRound,
    costCompactPerRound: plan.cost.compactPerRound,
    costCompactOnce: plan.cost.compactOnce,
    costCompactAmortizedPerRound: plan.cost.compactAmortizedPerRound,
    costFreshPerRound: plan.cost.freshPerRound,
    costBreakEvenRounds: plan.cost.breakEvenRounds,
    costFreshBreakEvenRounds: plan.cost.freshBreakEvenRounds,
    costFreshWinMarginRounds: plan.cost.freshWinMarginRounds,
    costHandoffBaseHitRate: plan.cost.handoffBaseHitRate,
    costFreshWinsOnCost: plan.cost.freshWinsOnCost,
    costSavingYuan: plan.cost.savingYuan,
    costSavingEnough: plan.cost.savingEnough,
    costPriceKnown: plan.cost.priceKnown,
    costPriceTier: plan.cost.priceTier,
    costPriceLabel: plan.cost.priceLabel,
    avgOutputTokens: plan.cost.avgOutputTokens,
    // 三方案在"到官方线为止"窗口内的总花费（元）—— 界面据此解释"为什么改推新开"
    costTotalContinue: plan.cost.totalContinue,
    costTotalCompact: plan.cost.totalCompact,
    costTotalFresh: plan.cost.totalFresh,
    costHorizonRounds: plan.cost.horizonRounds,
    /** 命中率是否有实测依据（false = 金额只是按假设命中率估的，不能作为决策依据）。 */
    costHitRateKnown: plan.cost.hitRateKnown,
    compactWorthwhile: plan.plans.compact.worthCompacting,
    // ── "要不要打扰用户"的判据（2026-09-18 W 节，用户拍板：**无异常即静默**）──
    //
    // 修改前是 `level !== 'ok' || advice !== 'continue'`，即**规模偏大就会常亮**。
    // 但单独的"上下文过大"没有行动价值：手动压缩在钱上摊不回来、自动压缩官方自己会做，
    // 而交接要么有退化、要么过成本门槛 —— 它还与 composer 旁的占用圆环重复。
    // 更要紧的是：无事可做时常亮的提示条会**稀释真正的信号**。
    //
    // 现在的判据分两半，各自对应一件"真有事"：
    //   · `plan.quality.degraded` —— 有退化 / 守卫（它就是那批信号的**唯一实现**：
    //     guardTripCount > 0 / reasoningLoop > 0 / reasoningFlags > 0 /
    //     degradedReplies ≥ 阈值 / repeatWorst ≥ 阈值）；
    //   · `plan.final.advice !== 'continue'` —— 有行动建议（交接）。
    // `level`（规模档位）**不再参与**，它只作展开区的背景信息。
    shouldNotify: plan.quality.degraded === true || plan.final.advice !== 'continue',
    replyReasons: toReasonList(base.replyReasonCounts),
    reasoningReasons: toReasonList(base.reasoningReasonCounts),
    lastCompactionWasModel: base.lastCompactionKind === 'summary',
  };
}

/** 初始状态：无任何数据时的健康态。 */
function initialState() {
  return finalize({
    score: 100,
    level: 'ok',
    usedTokens: 0,
    contextWindow: null,
    // 内部字段（不进 wire）：模型名 —— 判定链用它选价表（T 节 2026-09-18）
    model: null,
    effectivePercent: null,
    windowPercent: null,
    repeatWorst: 0,
    degradedReplies: 0,
    replyReasonCounts: {},
    reasoningLoop: 0,
    reasoningFlags: 0,
    reasoningWorstRepeat: 0,
    reasoningReasonCounts: {},
    findings: [],
    lastCallKey: null,
    callStreak: 0,
    summaryCount: 0,
    pruneCount: 0,
    lastCompactionAt: null,
    lastCompactionKind: null,
    lastCompactionShadowedTokens: 0,
    lastCompactionSummaryTokens: 0,
    lastCompactionSummaryInputTokens: 0,
    lastCompactionManual: false,
    lastCompactionPreTokens: 0,
    lastCompactionAfterTokens: 0,
    afterCompactionPercent: null,
    awaitingCompactionAfter: false,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    outputTokensSum: 0,
    outputTokensCount: 0,
    usageCount: 0,
    turnCount: 0,
    recentUsage: [],
    guardTripCount: 0,
    lastGuardReason: null,
    // H.8：异常现场明细（初始为空 —— 界面按"有值才渲染"处理，无异常时整块不出现）
    degradedSamples: [],
    /** 最近一次守卫中止发生在哪一轮（内部状态，不进 wire 契约）。 */
    lastGuardTurn: null,
    growthSum: 0,
    growthCount: 0,
    growthTurnEndTotal: 0,
    growthCurTurnTotal: 0,
  });
}

/**
 * 纯同步折叠：state + event → 新 state。
 *
 * **契约**（`dsh-session-projection` README）：无关事件必须返回**同一引用**，
 * 引用不变即表示零下游工作。这里严格遵守。
 *
 * @param {object} state
 * @param {object} event
 * @returns {object}
 */
/**
 * 结算「上一轮」的上下文增长（在轮次边界调用）。
 *
 * 为什么**按轮**而不是按消息：`headroomRounds`（距官方压缩线还能撑几轮）以 `avgGrowth` 为分母，
 * 而一个轮次里可能有几十条 `assistant/message` —— 逐条累加会把分母缩小十几倍，
 * 于是同一条会话出现"交接文档说还能撑 14 轮、提示条说 274 轮"（2026-09-16 实测相差
 * 2.4×~48×，且**永远偏向乐观**）。
 *
 * 口径与交接文档的 `contextDelta` 一致：相邻两轮**结束规模**之差、**排除第一轮**
 * （第一轮的绝对值不是"增长"，把它算进去会反过来高估）。
 */
function settleTurn(state) {
  const cur = state.growthCurTurnTotal;
  if (!(cur > 0)) return state;
  const prev = state.growthTurnEndTotal;
  const grew = prev > 0 && cur > prev;
  return {
    ...state,
    growthSum: grew ? state.growthSum + (cur - prev) : state.growthSum,
    growthCount: grew ? state.growthCount + 1 : state.growthCount,
    growthTurnEndTotal: cur,
    growthCurTurnTotal: 0,
  };
}

function foldEvent(state, event) {
  // 防御（2026-09-15 复核）：DSH 正常不会给 null / 非对象事件，但 host 插件里
  // 一次未捕获异常可能连累整个投影 —— 历史上 REQUEST_EXTENSION 就是这样把
  // 每一轮请求都打断的。判据本身是纯函数，遇到不认识的输入原样返回，不做猜测。
  if (!event || typeof event !== 'object') return state;
  const data = event.data ?? {};

  switch (event.type) {
    // 轮次边界：结算上一轮的上下文增长（2026-09-16 口径修复）。
    // 靠 `growthCurTurnTotal` 清零保证幂等 —— `turn/end` 与下一个 `turn/start` 都调用它，
    // 第二次拿到 0 会原样返回，不会重复计数。
    case 'turn/start':
    case 'turn/end': {
      const settled = settleTurn(state);
      // 2026-09-16 新增：识别「被实时思考守卫中止」的轮次。
      // `agent.cancel({ kind:'hook', reason })` 会写进 `turn/end` 的
      // `reason = { kind:'aborted', reason:{ kind:'hook', reason:'…' } }` ——
      // 所以界面能显示**确切原因**，不必靠猜。
      let next = settled;
      if (event.type === 'turn/end') {
        const r = data.reason;
        const hookReason =
          r && r.kind === 'aborted' && r.reason && r.reason.kind === 'hook'
            ? String(r.reason.reason ?? '')
            : '';
        if (hookReason.includes('attention-health')) {
          const guardNote = hookReason.replace(/^\s*attention-health[：:]\s*/, '');
          const guardTurn =
            typeof data.turn === 'number' && data.turn >= 0
              ? Math.floor(data.turn)
              : (settled.lastGuardTurn ?? 0);
          next = {
            ...settled,
            guardTripCount: Math.min(DEGRADED_CAP, (settled.guardTripCount ?? 0) + 1),
            lastGuardReason: guardNote,
            lastGuardTurn:
              typeof data.turn === 'number' ? data.turn : (settled.lastGuardTurn ?? null),
            // H.8：守卫中止也留一条现场。
            //
            // ⚠️ 摘录用的是**守卫的判定描述**（其中含被复读的那一行，例如
            //    `最近 60 个短行里有 32 行是「做。」`），不是思考原文。
            //    原因是结构性的：守卫在**流式生成过程中**就中止了本轮，原文片段留在
            //    `agent/assistant-stream` 的回调里，而 `turn/end` 时已经拿不到它。
            //    要拿到就得建一个跨回调的旁路缓存（按 attemptId 索引），而多会话并行时
            //    那玩意儿会串 —— **宁可少给一点，也不给错**。
            degradedSamples: withSample(settled.degradedSamples, {
              turn: guardTurn,
              kind: 'guard',
              excerpt: toExcerpt(guardNote),
            }),
          };
        }
      }
      // AB 节（2026-09-20）：轮次计数 —— 成本口径 `stepsPerTurn = usageCount / turnCount`。
      // 只在 `turn/start` 自增（`turn/end` 已经是同一轮的收尾），重放同一条事件流结果相同。
      const withTurn =
        event.type === 'turn/start'
          ? { ...next, turnCount: Math.min(TURN_COUNT_CAP, (next.turnCount ?? 0) + 1) }
          : next;
      return withTurn === state ? state : finalize(withTurn);
    }

    case 'request/context': {
      // 只接受**有限正数**：schema 是 `z.number().positive().nullable()`，
      // 而 `data.contextWindow` 为 0 / 负数 / NaN 会让 state 直接违反自己的 schema
      // （投影发布失败）。非正数一律沿用上一个已知窗口。
      const cw =
        typeof data.contextWindow === 'number' &&
        Number.isFinite(data.contextWindow) &&
        data.contextWindow > 0
          ? data.contextWindow
          : state.contextWindow;
      // T 节（2026-09-18）：模型名是**选价表的依据**（实测该事件确实带 `model` 字段）。
      // 取不到就沿用上一个已知值 —— 与 `contextWindow` 同样的"沿用"策略。
      const model = typeof data.model === 'string' && data.model ? data.model : state.model;
      if (cw === state.contextWindow && model === state.model) return state;
      return finalize({ ...state, contextWindow: cw, model });
    }

    case 'assistant/message': {
      const usage = data.usage ?? {};
      const tokens = contextTokensOf(usage);
      const content = data.message?.content;
      const replyText = blocksToText(content);
      const replyReasons = replyDegradeReasons(replyText);
      const think = scanReasoning(content, usage);

      const usedTokens = tokens > 0 ? tokens : state.usedTokens;
      const degradedReplies = replyReasons.length
        ? Math.min(DEGRADED_CAP, state.degradedReplies + 1)
        : state.degradedReplies;

      // 命中原因计数（N-5）：只在有命中时新建对象，其余情况保持同一引用（便于 unchanged 早退）。
      let replyReasonCounts = state.replyReasonCounts;
      if (replyReasons.length) {
        replyReasonCounts = { ...replyReasonCounts };
        for (const key of replyReasons) {
          replyReasonCounts[key] = (replyReasonCounts[key] ?? 0) + 1;
        }
      }

      // 思考退化（N-5）：打转优先归类 —— 它可能同时满足"异常长"，但严重度不同。
      let reasoningLoop = state.reasoningLoop;
      let reasoningFlags = state.reasoningFlags;
      let reasoningWorstRepeat = state.reasoningWorstRepeat;
      let reasoningReasonCounts = state.reasoningReasonCounts;
      if (think.flagged) {
        // 2026-09-18 修复（截图反馈 + README「二次复核：符号堆砌在思考里 100% 是误报」）：
        // `symbolRun`（符号堆砌）**不再计入 `reasoningFlags`**。
        //
        // 理由：它在思考侧实测 22/22 全部落在代码 / 正则里（修复后仍有非 ASCII 残留，
        // README 自己写明"属可接受的止损"）；而 `reasoningFlags > 0` 会直接参与
        // 「有效占用 ≥90% → 立即新开会话」的判定。用精确率存疑的信号劝人丢掉整个上下文，
        // 代价与收益严重不对称 —— 误报要用户换会话，漏报只是少提醒一次。
        //
        // 它仍会进 `reasoningReasonCounts`（展开区可见，标注为"疑似"），只是不再有判定力。
        if (think.reasons.includes('thinkLoop')) {
          reasoningLoop = Math.min(DEGRADED_CAP, reasoningLoop + 1);
        } else if (think.reasons.includes('thinkHuge')) {
          reasoningFlags = Math.min(DEGRADED_CAP, reasoningFlags + 1);
        }
        reasoningReasonCounts = { ...reasoningReasonCounts };
        for (const key of think.reasons) {
          reasoningReasonCounts[key] = (reasoningReasonCounts[key] ?? 0) + 1;
        }
        if (think.worstRepeat > reasoningWorstRepeat) reasoningWorstRepeat = think.worstRepeat;
      }

      // 异常现场明细（2026-09-18 H.8）：把"出问题的那一段"留下来，供界面就地展开。
      //
      // 只给**参与判定**的两类思考退化留现场：`symbolRun`（符号堆砌）是"疑似"、
      // 已从判定里摘出（见上方注释），不该占用 5 个名额；输出侧以 `replyReasons`
      // 非空为准 —— 与 `degradedReplies` 的计数口径完全一致。
      //
      // `turn` 取事件自带的 `data.turn`（实测 `assistant/message` 都带）；缺失时记 0 =
      // "轮次未知"，**不拿别的数字顶上**。
      const sampleTurn =
        typeof data.turn === 'number' && data.turn >= 0 ? Math.floor(data.turn) : 0;
      let degradedSamples = state.degradedSamples;
      if (think.reasons.includes('thinkLoop') || think.reasons.includes('thinkHuge')) {
        degradedSamples = withSample(degradedSamples, {
          turn: sampleTurn,
          kind: 'reasoning',
          excerpt: reasoningExcerpt(content),
        });
      }
      if (replyReasons.length) {
        degradedSamples = withSample(degradedSamples, {
          turn: sampleTurn,
          kind: 'reply',
          excerpt: toExcerpt(replyText),
        });
      }

      // 真实用量：缓存命中 / 未命中（三方案成本估算的输入）
      const cacheReadTokens = finiteOr(usage.cacheReadTokens, state.cacheReadTokens);
      const cacheMissTokens = finiteOr(usage.inputTokens, state.cacheMissTokens);
      // 输出 token 累计（2026-09-16 接入真实价格）：输出 4 元/百万是未命中输入价的 4 倍，
      // 旧成本模型只算输入、不算输出，等于漏掉最贵的那部分。这里按**全会话累计**求平均。
      const usageOutTokens = finiteOr(usage.outputTokens, 0);
      const outputTokensSum = usageOutTokens > 0 ? state.outputTokensSum + usageOutTokens : state.outputTokensSum;
      const outputTokensCount = usageOutTokens > 0 ? state.outputTokensCount + 1 : state.outputTokensCount;
      // 请求次数（审查 P2）：首轮 cacheRead=0 是常态，不能当"缓存崩了"
      const usageCount = state.usageCount + 1;
      // 命中率尾窗（2026-09-16）：成本判定用最近 N 次的**累计**命中率，
      // 而不是最后一次的读数（见 stateSchema 里 `recentUsage` 的注释）。
      // 只在这一轮**确实带用量**时入窗，避免把上一轮的旧值重复计入。
      let recentUsage = state.recentUsage;
      if (typeof usage.cacheReadTokens === 'number' || typeof usage.inputTokens === 'number') {
        const wHit = Math.max(0, cacheReadTokens);
        const wTotal = wHit + Math.max(0, cacheMissTokens);
        if (wTotal > 0) {
          recentUsage = [...state.recentUsage, { hit: wHit, total: wTotal }].slice(-HIT_RATE_WINDOW);
        }
      }

      // 本轮上下文读数（**按轮**结算，见 settleTurn）
      const growthCurTurnTotal = tokens > 0 ? tokens : state.growthCurTurnTotal;

      // 压缩后的第一次请求 → 记录"压缩后占用"，判断压缩是否救得回来
      let afterCompactionPercent = state.afterCompactionPercent;
      let awaitingCompactionAfter = state.awaitingCompactionAfter;
      let lastCompactionAfterTokens = state.lastCompactionAfterTokens;
      if (awaitingCompactionAfter && tokens > 0 && state.contextWindow) {
        afterCompactionPercent = (tokens / state.contextWindow) * 100;
        // 实测的"不可压缩基线"：成本模型靠它判断"再压一次还有多少可压"
        lastCompactionAfterTokens = tokens;
        awaitingCompactionAfter = false;
      }

      const unchanged =
        usedTokens === state.usedTokens &&
        degradedReplies === state.degradedReplies &&
        degradedSamples === state.degradedSamples &&
        replyReasonCounts === state.replyReasonCounts &&
        reasoningLoop === state.reasoningLoop &&
        reasoningFlags === state.reasoningFlags &&
        reasoningWorstRepeat === state.reasoningWorstRepeat &&
        reasoningReasonCounts === state.reasoningReasonCounts &&
        cacheReadTokens === state.cacheReadTokens &&
        cacheMissTokens === state.cacheMissTokens &&
        outputTokensSum === state.outputTokensSum &&
        outputTokensCount === state.outputTokensCount &&
        usageCount === state.usageCount &&
        recentUsage === state.recentUsage &&
        growthCurTurnTotal === state.growthCurTurnTotal &&
        afterCompactionPercent === state.afterCompactionPercent &&
        lastCompactionAfterTokens === state.lastCompactionAfterTokens &&
        awaitingCompactionAfter === state.awaitingCompactionAfter;
      if (unchanged) return state;

      return finalize({
        ...state,
        usedTokens,
        degradedReplies,
        degradedSamples,
        replyReasonCounts,
        reasoningLoop,
        reasoningFlags,
        reasoningWorstRepeat,
        reasoningReasonCounts,
        cacheReadTokens,
        cacheMissTokens,
        outputTokensSum,
        outputTokensCount,
        usageCount,
        recentUsage,
        growthCurTurnTotal,
        afterCompactionPercent,
        lastCompactionAfterTokens,
        awaitingCompactionAfter,
      });
    }

    case 'compaction/summary': {
      // 模型摘要：消耗 token、有损。shadowedTokenCount 是被替换内容的精确 token 价。
      const shadowed = finiteOr(data.shadowedTokenCount, 0);
      const usageOut = finiteOr(data.usage?.outputTokens, 0);
      const summaryText = blocksToText(data.summary);
      const summaryTokens = usageOut > 0 ? usageOut : Math.round(summaryText.length / 4);
      const summaryInput = finiteOr(data.usage?.inputTokens, shadowed);

      return finalize({
        ...state,
        summaryCount: state.summaryCount + 1,
        lastCompactionAt: finiteOr(event.time, state.lastCompactionAt),
        lastCompactionKind: 'summary',
        lastCompactionShadowedTokens: shadowed,
        lastCompactionSummaryTokens: summaryTokens,
        lastCompactionSummaryInputTokens: summaryInput,
        lastCompactionManual: Boolean(data.sourceCommandId),
        lastCompactionPreTokens: state.usedTokens,
        awaitingCompactionAfter: true,
      });
    }

    case 'compaction/prune': {
      // 零 token 裁剪（不调模型）：工具结果修剪等
      const shadowed = finiteOr(data.shadowedTokenCount, 0);
      return finalize({
        ...state,
        pruneCount: state.pruneCount + 1,
        lastCompactionAt: finiteOr(event.time, state.lastCompactionAt),
        lastCompactionKind: 'prune',
        lastCompactionShadowedTokens: shadowed,
        lastCompactionSummaryTokens: 0,
        lastCompactionSummaryInputTokens: 0,
        lastCompactionPreTokens: state.usedTokens,
        // 手动 /compact 若只触发裁剪，别被标成"自动"（2026-09-15 审查修复）
        lastCompactionManual: Boolean(data.sourceCommandId),
        awaitingCompactionAfter: true,
      });
    }

    case 'tool/call': {
      const key = `${data.name ?? '?'}\u0000${data.arguments ?? ''}`;
      const callStreak = key === state.lastCallKey ? state.callStreak + 1 : 1;
      const repeatWorst = Math.max(state.repeatWorst, callStreak);
      // 原来这里有个 `key === lastCallKey && callStreak === state.callStreak` 的提前返回，
      // 但同 key 时 callStreak 必然等于 state.callStreak + 1，条件**恒为假**
      // （2026-09-15 审查发现），已删除。
      return finalize({ ...state, lastCallKey: key, callStreak, repeatWorst });
    }

    default:
      // 无关事件：必须返回同一引用
      return state;
  }
}

/** projection 单元定义。 */
const attentionHealthProjection = {
  key: 'attentionHealth',
  // v4：加入思考退化信号（reasoningLoop / reasoningFlags / reasoningReasons），
  //     并把退化命中原因一并广播（2026-09-15 复核 N-5）；state 形状变了必须递增。
  // v5：加入异常现场明细 degradedSamples（2026-09-18 H.8）—— state 与 wire 都多了一个键。
  stateVersion: 5,
  stateSchema,
  init: () => initialState(),
  apply: foldEvent,
  wire: {
    viewSchema,
    // ⚠️ 必须剥离内部折叠字段（lastCallKey / callStreak 以及压缩相关的内部量）。
    // viewSchema 是 .strict() 的，直接 `view: (state) => state` 会被 zod 拒绝：
    //   ZodError: unrecognized_keys ["lastCallKey","callStreak"]
    // （这是实测踩到的，若直接挂载，DSH 每次发布投影都会报错。）
    view: (state) => ({
      score: state.score,
      level: state.level,
      usedTokens: state.usedTokens,
      contextWindow: state.contextWindow,
      effectivePercent: state.effectivePercent,
      effectiveWindowRatio: state.effectiveWindowRatio,
      windowPercent: state.windowPercent,
      repeatWorst: state.repeatWorst,
      degradedReplies: state.degradedReplies,
      replyReasons: state.replyReasons,
      reasoningLoop: state.reasoningLoop,
      reasoningFlags: state.reasoningFlags,
      reasoningWorstRepeat: state.reasoningWorstRepeat,
      reasoningReasons: state.reasoningReasons,
      findings: state.findings,
      officialLine: state.officialLine,
      headroomToOfficial: state.headroomToOfficial,
      headroomRounds: state.headroomRounds,
      avgRoundGrowth: state.avgRoundGrowth,
      compactionCount: state.summaryCount + state.pruneCount,
      lastCompactionWasModel: state.lastCompactionKind === 'summary',
      qualityAdvice: state.qualityAdvice,
      compactBand: state.compactBand,
      compactAdvice: state.compactAdvice,
      compactAdviceText: state.compactAdviceText,
      compactReason: state.compactReason,
      compactAdviceNote: state.compactAdviceNote,
      continuePerRound: state.continuePerRound,
      compactPerRound: state.compactPerRound,
      compactSavingPerRound: state.compactSavingPerRound,
      freshPerRound: state.freshPerRound,
      compactTotalOnce: state.compactTotalOnce,
      compactBreakEvenRounds: state.compactBreakEvenRounds,
      cacheHitRate: state.cacheHitRate,
      costContinuePerRound: state.costContinuePerRound,
      costCompactPerRound: state.costCompactPerRound,
      costCompactOnce: state.costCompactOnce,
      costCompactAmortizedPerRound: state.costCompactAmortizedPerRound,
      costFreshPerRound: state.costFreshPerRound,
      costBreakEvenRounds: state.costBreakEvenRounds,
      costFreshBreakEvenRounds: state.costFreshBreakEvenRounds,
      costFreshWinMarginRounds: state.costFreshWinMarginRounds,
      costHandoffBaseHitRate: state.costHandoffBaseHitRate,
      costFreshWinsOnCost: state.costFreshWinsOnCost,
      costSavingYuan: state.costSavingYuan,
      costSavingEnough: state.costSavingEnough,
      costPriceKnown: state.costPriceKnown,
      costPriceTier: state.costPriceTier,
      costPriceLabel: state.costPriceLabel,
      costTotalContinue: state.costTotalContinue,
      costTotalCompact: state.costTotalCompact,
      costTotalFresh: state.costTotalFresh,
      costHorizonRounds: state.costHorizonRounds,
      costHitRateKnown: state.costHitRateKnown,
      avgOutputTokens: state.avgOutputTokens,
      // 注意：`recentUsage`（命中率尾窗）是**判定用的内部状态**，不进 view ——
      // UI 只需要 `cacheHitRate`。放进来会让 viewSchema 的键集合与实际输出不一致
      // （实测：schema 50 键 vs view 51 键，全量 view 校验失败）。
      compactWorthwhile: state.compactWorthwhile,
      shouldNotify: state.shouldNotify,
      guardTripCount: state.guardTripCount,
      lastGuardReason: state.lastGuardReason,
      // H.8：异常现场明细（最近 5 条）。数组本身直接下发（元素是纯数据，无 Host 引用）。
      degradedSamples: state.degradedSamples,
      summaryCount: state.summaryCount,
    }),
  },
};

// ─────────────────────── 交接生成（UI → host 的本地通道） ───────────────────────

/**
 * `sessionId` 白名单：DSH 的会话 id 实际形态是 `session-<uuid>`，
 * 字符集只有字母、数字与连字符。
 *
 * 2026-09-18 审查 G1 收窄：原模式还允许 `.`，于是 `..` 这类纯点串也是合法输入
 * （虽然它不含 `/`、`\`、`:`，路径穿越其实不可达，且 DSH 内部还有一层校验，
 * 但白名单本身就该只放行真实形态）。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 路由可达性检查（2026-09-15 审查修复）。
 *
 * `webServer.register()` 是**裸路由**，只做 gzip 与最长前缀匹配；官方把 Host/Origin 检查
 * 与 token 交换放在 `dsh-client-connection` 自己注册的路由外面（那里的 `isTrustedApiRequest`
 * 会拒 401/403）。插件的 `/attention-health/handoff` 不属于那两类，三种保护一个都没有 ——
 * 本机其它进程、或浏览器 DNS rebinding 场景可以不带凭据访问它。
 *
 * 这里复刻官方的判断口径：Host 必须是 loopback，且 Origin（若带）必须与 Host 同源、
 * `sec-fetch-site` 不得为 cross-site。浏览器正常点击带的是同源 Origin，命令行工具
 * （curl / Invoke-WebRequest / 自动验证脚本）不带 Origin，两者都放行。
 *
 * 导出它**只是为了测试能直接断言判定本身**（2026-09-18 Z.3）：
 * 路由级用例只能证明"某一种请求被拒"，而鉴权是"多层与关系"，逐层单独断言
 * 才能保证将来收紧/放松任一层时不会悄悄失效。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isTrustedHandoffRequest(req) {
  const headers = req?.headers ?? {};
  const host = String(headers.host ?? '').toLowerCase();
  if (!host) return false;

  const hostname = host.replace(/:\d+$/, '');
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  if (!isLoopback) return false;

  // 浏览器发起的跨站请求：直接拒（这正是 DNS rebinding 的形态）
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;

  // 带 Origin 时要求与 Host 同源
  const origin = headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false;
    } catch (_error) {
      return false;
    }
  }

  // ── 连接来源也必须是 loopback（2026-09-18 Z.3 复核侧裁决）──────────────────
  // 为什么不校验 token：官方 `isTrustedApiRequest` 同样不校验（token 校验在 `browser-auth`
  // 层，值存在模块私有的 `PROCESS_LAUNCH_TOKENS` WeakMap 里，插件**拿不到**）——
  // 所以"不发明新机制"（Z.3 原话）。
  // 但 **Host 头可以伪造、`remoteAddress` 不能**：当前只绑 127.0.0.1 时这层无副作用；
  // 将来若开放局域网，它能挡住"外部伪造 Host"这一类。
  // 兼容三种写法：`127.0.0.1` / `::1` / IPv4-mapped 的 `::ffff:127.0.0.1`（以及整个 127/8）。
  const remote = String(req?.socket?.remoteAddress ?? '');
  const remoteIsLoopback =
    remote.startsWith('127.') || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!remoteIsLoopback) return false;

  return true;
}

/**
 * 应答 `GET /attention-health/handoff?sessionId=<id>`。
 *
 * 数据来源策略：**活会话优先，冷会话回落磁盘**。
 *   - 活会话：`ctx.sessions.get(id)` → `session.snapshotEvents()`（内存中最新，含未落盘部分）
 *   - 冷会话：`ctx.sessionQuery.readSession(id)`（统一读取，内部处理 zstd 多帧日志）
 *
 * 返回纯 JSON：`{ ok, markdown, stats }`。全程不同模型打交道。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleHandoffRequest(ctx, req, res) {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (!isTrustedHandoffRequest(req)) {
    return send(403, { ok: false, error: 'forbidden' });
  }

  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== ROUTE_PATH) return send(404, { ok: false, error: 'unknown path' });

    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return send(400, { ok: false, error: 'sessionId is required' });

    // 白名单校验：不校验时非法输入会一路走到 readSession 才抛错，既给不出正确语义，
    // 又会把超长输入原样回显进响应体（2026-09-15 审查实测：400 字符 id → 500 + 445 字符回显）。
    // 输出档位：slim（默认，精简）| full（完整留档）
    const profile = url.searchParams.get('profile') === 'full' ? 'full' : 'slim';
    /**
     * 是否写校准记录（`history.js`）。默认写；`record=0` 表示"这次不是真实交接"。
     *
     * 为什么需要（2026-09-15 全量复核第七节待办 1，采用其"方案 2：只读开关"）：
     * 校准的价值全在样本干净，而这条路由会被**自动化验证**调用 ——
     *   · `restart-attention-health.ps1` 的端到端检查会打一个真实会话；
     *   · `work/verify-round3.mjs` 同样走真实 HTTP；
     *   · 批量探测脚本（逐个会话找活会话 ID）。
     * 于是"验证用的交接"和"人真的交接"混在一起，稀释了校准样本。
     *
     * ⚠️ 备查：`test/plugin-test.mjs` 的路由测试**没有**这个问题 ——
     * 它把 `DSH_HOME` 指向临时目录并在结束时删除，记录写在临时目录里。
     * （这一点 2026-09-16 复核时先判断错了，核对 `history.js` 的动态 `DSH_HOME`
     *  解析与测试的清理逻辑后才纠正过来。）
     *
     * 调用方声明 `record=0` 即可：**只影响记账，不影响文档生成**。
     */
    const record = url.searchParams.get('record') !== '0';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return send(400, { ok: false, error: 'invalid sessionId' });
    }

    const sessions = ctx.get('sessions');
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;

    let header = {};
    let events = [];
    let source = 'log';

    if (live) {
      header = live.header ?? {};
      events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : [];
      source = 'live';
    } else {
      const sessionQuery = ctx.get('sessionQuery');
      if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
        return send(503, { ok: false, error: 'no session reader available' });
      }
      const snapshot = await sessionQuery.readSession(sessionId);
      header = snapshot?.session ?? {};
      events = snapshot?.events ?? [];
    }

    // 健康度：只有活会话才有投影状态；冷会话留空（渲染时会注明）
    let health = null;
    if (live) {
      const projections = ctx.get('sessionProjections');
      const state = projections && typeof projections.stateOf === 'function'
        ? projections.stateOf(live, 'attentionHealth')
        : undefined;
      if (state) {
        health = {
          score: state.score,
          level: state.level,
          usedTokens: state.usedTokens,
          contextWindow: state.contextWindow,
          effectivePercent: state.effectivePercent,
          windowPercent: state.windowPercent,
          repeatWorst: state.repeatWorst,
          degradedReplies: state.degradedReplies,
          replyReasons: state.replyReasons,
          reasoningLoop: state.reasoningLoop,
          reasoningFlags: state.reasoningFlags,
          reasoningWorstRepeat: state.reasoningWorstRepeat,
          reasoningReasons: state.reasoningReasons,
          findings: state.findings,
        };
      }
    }

    const startedAt = Date.now();
    const generation = detectLogGeneration(sessionId);
    const { markdown, stats } = buildHandoff({
      events,
      header,
      health,
      source,
      generation,
      options: { profile },
    });

    // 交接历史留痕（N-6 建议 1）：记下"交接当时的现场"，累积后可反推阈值。
    // 零 token、纯本地，且**失败绝不影响交接**（recordHandoff 内部吞异常）。
    // `record=0` 时不写：自动化探测与自测不该混进校准样本（见上方 `record` 的说明）。
    if (record) {
      recordHandoff({
        at: startedAt,
        sessionId,
        via: 'route',
        profile,
        source,
        score: stats.score,
        level: stats.level,
        effectivePercent: stats.effectivePercent,
        windowPercent: stats.windowPercent,
        usedTokens: stats.usedTokens,
        summaryCount: stats.summaryCount,
        degradedReplies: stats.degradedReplies,
        reasoningLoop: stats.reasoningLoop,
        reasoningFlags: stats.reasoningFlags,
        broadFallback: stats.broadFallback,
        chars: stats.chars,
      });
    }

    return send(200, {
      ok: true,
      markdown,
      // `recorded` 让调用方能确认自己有没有写脏校准样本（自测会断言它）
      stats: { ...stats, source, profile, recorded: record, ms: Date.now() - startedAt },
    });
  } catch (error) {
    // 会话不存在属于**客户端问题**，不该报 500；按官方 error code 判断，不匹配文案。
    const code = error?.code ?? error?.name;
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'ENOENT') {
      return send(404, { ok: false, error: 'session not found' });
    }
    // 其余异常不回显原文（可能含超长输入或内部路径），只写进 err.log
    console.error('[attention-health] handoff failed:', error?.stack ?? error);
    return send(500, { ok: false, error: 'internal error while building handoff' });
  }
}

/**
 * 插件入口。
 *
 * ── 兼容性防护（2026-09-16 用户要求：「换个电脑、或 DSH 更新后不要崩」）────────────
 * 本插件挂在 DSH 的几个**内部契约**上：投影注册表、会话读取、webServer 路由。
 * 官方升级有可能改名或改签名，而"插件抛异常"与"插件少干活"是两种完全不同的后果 ——
 * 前者会顺着 Cordis 的加载链把 profile 一起拖坏，后者只是提示条不出现。
 * 因此这里的原则是：**每一步都单独兜住，失败只写日志，绝不向外抛**。
 * 日志统一带 `[attention-health]` 前缀，落在 DSH 的 stderr（`dsh-node.err.log`），
 * 出问题时能一眼看出是哪一步、哪个契约不在了。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** 把"某一步失败"降级成一条日志。返回 undefined 而不是抛出。 */
  const guard = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      console.error(
        `[attention-health] ${label} 失败（DSH 契约可能已变化，本插件将跳过该功能）：`,
        error?.message ?? error,
      );
      return undefined;
    }
  };

  // 一行契约自检：DSH 升级后先看这行，就知道哪个依赖还在、哪个没了。
  // 只检查 **apply 阶段就一定有定论**的项 —— sessions / sessionQuery / webServer 是延迟就绪的，
  // 此刻为 undefined 属正常，列进来会造成"契约丢了"的误判。
  guard('契约自检', () => {
    const probe = {
      'ctx.sessionProjections.register': typeof ctx.sessionProjections?.register,
      'ctx.get': typeof ctx.get,
      'ctx.inject': typeof ctx.inject,
    };
    console.error(
      '[attention-health] 契约自检: ' +
        Object.entries(probe)
          .map(([k, v]) => `${k}=${v}`)
          .join('  '),
    );
  });

  guard('注册投影', () => {
    // 首选 `inject: ['sessionProjections']` 保证的那份；`ctx.get` 只作兜底
    // （apply 阶段其他服务可能还没起来，用 ctx.get 当主路径会静默丢掉投影）。
    const projections = ctx.sessionProjections ?? ctx.get?.('sessionProjections');
    if (!projections || typeof projections.register !== 'function') {
      console.error(
        '[attention-health] 找不到 sessionProjections.register —— 提示条不会出现。' +
          '若刚升级过 DSH，请检查该服务的名字是否变了。',
      );
      return;
    }
    projections.register(attentionHealthProjection);
    // 一行启动日志：便于确认插件已加载（DSH 的 stderr 落在 dsh-node.err.log）。
    console.error('[attention-health] projection "attentionHealth" registered');
  });

  // 交接生成通道。
  //
  // ⚠️ 必须用 **ctx.inject**，不能写成 `ctx.get('webServer')`：
  // profile 的加载条目是**并行**初始化的，本插件很可能在 webserver 之前跑完 apply，
  // 那一刻 `ctx.get('webServer')` 只会拿到 undefined —— 实测就是这么丢掉路由的：
  //   err.log 出现「webServer 不可用」，浏览器点「生成交接内容」直接 HTTP 404。
  // ctx.inject 会等服务出现后再执行回调；投影注册照旧立即生效，不受影响。
  guard('注册交接路由', () => {
    ctx.inject(['webServer'], (scope) => {
      try {
        scope.effect(() =>
          scope.webServer.register({
            kind: 'prefix',
            path: '/attention-health',
            handler: (req, res) => handleHandoffRequest(scope, req, res),
          }),
        );
        console.error(`[attention-health] handoff route registered: ${ROUTE_PATH}`);
      } catch (error) {
        console.error(
          '[attention-health] webServer.register 失败（DSH 契约可能已变化）：',
          error?.message ?? error,
        );
      }
    });
  });

  // ── 实时思考守卫（2026-09-16 用户新增）──────────────────────────────────────
  // 需求原文：「如果检测到模型思考开始复读空转就立刻停止并提示」。
  //
  // 为什么做得到（已核对官方类型定义，见 `lib/guard.js` 的模块注释）：
  //   · `agent/assistant-stream` 逐帧发布 `frame.chunk`，其中 `reasoning-delta`
  //     就是**正在生成**的思考片段；
  //   · `agent.cancel({ kind: 'hook', reason })` 能中止活动 turn，而 reason 会作为
  //     `turn/end` 的 `aborted` 原因落进日志 —— 于是提示条能显示确切原因。
  //
  // 代价与克制：中断一次生成会丢掉这一轮的工作，所以判据刻意保守
  // （只抓"正常思考绝不会出现"的越界重复，见 guard.js），且**只在思考里**判、
  // 不碰正文与工具调用。任何异常都只写日志，绝不影响生成链路。
  guard('注册思考守卫', () => {
    /** attemptId → 该次尝试的守卫实例（一次尝试一个，结束即弃）。 */
    const attempts = new Map();
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      try {
        const key = String(frame?.attemptId ?? '');
        if (!key) return;
        if (frame.type === 'start') {
          // `tail`：这次尝试最近若干字符的思考原文 —— Q-3 要落档的"现场"。
          attempts.set(key, { guard: createLoopGuard(GUARD_DEFAULTS), tail: '' });
          return;
        }
        if (frame.type === 'end') {
          attempts.delete(key);
          return;
        }
        if (frame.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (!chunk || chunk.type !== 'reasoning-delta' || typeof chunk.text !== 'string') return;
        const slot = attempts.get(key);
        if (!slot) return; // 没有对应的 start（插件后加载 / 已被清理）→ 不介入
        // Q-3：在内存里保留"现场尾部"，命中时一并落档。
        slot.tail = (slot.tail + chunk.text).slice(-GUARD_TAIL_CHARS);
        const hit = slot.guard.push(chunk.text);
        if (!hit) return;
        attempts.delete(key);
        const stats = slot.guard.stats();
        console.error(
          `[attention-health] 思考空转 → 中止本轮生成：${hit.reason}` +
            `（累计 ${stats.totalChars.toLocaleString()} 字符 / ${stats.lineCount} 行，` +
            `kind=${hit.kind} ${JSON.stringify(hit.detail)}）`,
        );
        // Q-3（2026-09-18）：把现场**追加**写入独立文件。
        // 动机是一次真实误杀无法事后复核 —— turn/end 的 reason 只有一句话，
        // 而 console.error 的完整日志写在 dsh-node.err.log、**每次重启覆盖**：
        // 那次误杀的现场就在 65 秒后的重启里被冲掉了（审查清单 Q.1）。
        recordGuardTrip({
          kind: hit.kind,
          reason: hit.reason,
          detail: hit.detail,
          // Z.5：按当前配置加工尾部 —— 默认保留 500 字；
          // `DSH_ATTENTION_HEALTH_GUARD_TAIL=0` 时只存哈希 + 长度 + 首尾 40 字特征。
          ...shapeGuardTail(slot.tail),
          sessionId: agent?.sessionId ?? agent?.id ?? null,
        });
        agent.cancel({
          kind: 'hook',
          reason: `attention-health：思考空转 —— ${hit.reason}`,
        });
      } catch (error) {
        // 守卫出问题绝不能影响生成链路
        console.error('[attention-health] 思考守卫异常（已隔离）：', error?.message ?? error);
      }
    });
    console.error('[attention-health] 思考守卫已注册（实时检测思考复读 / 空转并中止）');
  });
}
