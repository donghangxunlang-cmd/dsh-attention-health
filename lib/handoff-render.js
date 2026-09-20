/**
 * handoff · Markdown 渲染（交接文档）
 *
 * 把事实与结论渲染成交接文档：`renderHandoff` 负责排版，
 * `buildHandoff` 是插件与离线 CLI 共用的入口（折叠 → 评分 → 决策 → 渲染）。
 *
 * 依赖全部上游模块。**渲染只有这一份实现** —— 离线 CLI 也走这里，
 * 免得"同一会话产出两种质量的文档"。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 2747–3656 行（共 910 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 */
import { APPENDIX_B_MAX_CHARS, APPENDIX_MAX_CHARS, COMPACT_DEFAULTS, DECISION_BROAD_TRIGGER, DECISION_KEYWORDS, DECISION_KEYWORDS_ALL, DECISION_KEYWORDS_BROAD_ALL, DECISION_KEYWORDS_EN, LEVEL_LABEL, PLUGIN_VERSION, REQUEST_SUMMARY_CHARS, scoreContextHealth } from './handoff-core.js';
import { cell, clip, degradeReasonText, isoLocal, plain, sanitizeInline, tempTag } from './handoff-text.js';
import { THINK_BUDGET_TOKENS } from './handoff-judge.js';
import { foldSession } from './handoff-fold.js';
import { HANDOFF_CHARS_PER_TOKEN, REBUILD_ROUNDS, aggregateErrors, deriveCompactionPlan, deriveGoal, deriveGrowth, deriveNextSteps, formatBreakEven, isControlRequest, summarize } from './handoff-plan.js';
// ─────────────────────────── 渲染 ───────────────────────────

/**
 * 把 `foldSession` 的结果整理成 `deriveCompactionPlan` 的入参（**唯一实现**）。
 *
 * 2026-09-18 S 节抽出来：这段构造原先内联在 `renderHandoff` 里，而验收探针与测试
 * 只能**手抄**一遍 —— 抄漏一个字段就会得出错误结论。§51.4 就踩过：
 * R 节给 render 加了 `guardTripCount`，探针没跟上，于是扫描显示
 * "退化信号检出=false"，我一度以为修复没生效。现在渲染、测试、探针共用这一份。
 *
 * ⚠️ 新增判定输入字段时，**只改这里**（再同步 `plugin/index.js` 的热路径调用）。
 *
 * @param {object} x - `foldSession` 的结果
 * @param {object} [meta] - `{ health, avgRoundGrowth, handoffDocTokens }`
 * @returns {object} `deriveCompactionPlan` 的入参
 */
export function compactionInputOf(x, meta = {}) {
  const health = meta.health ?? null;
  return {
    contextWindow: health?.contextWindow ?? x.requestContext?.contextWindow ?? null,
    usedTokens: health?.usedTokens ?? x.usage.lastContextTokens ?? 0,
    cacheReadTokens: x.cacheReadTokens,
    cacheMissTokens: x.cacheMissTokens,
    // 与 host 热路径对齐（2026-09-16 用户报告压缩后建议异常时发现）：
    // 离线路径原本漏传这两个参数，于是 `usageCount` 恒为 0，
    // "命中率是否可信"的判据与 UI 提示条不是同一套 —— 交接文档与提示条会给出不同结论。
    avgOutputTokens: x.avgOutputTokens,
    usageCount: x.usageCount,
    // AB 节（2026-09-20）：**轮次数**是成本口径的分母（`stepsPerTurn = usageCount / turnCount`）。
    // 与 host 热路径同义：host 数的是 `turn/start` 次数，这里数折叠出来的 turns。
    turnCount: Array.isArray(x.turns) ? x.turns.length : 0,
    // 命中率尾窗（2026-09-16）：离线路径必须与 host 同口径。
    recentUsage: x.recentUsage,
    avgRoundGrowth: meta.avgRoundGrowth ?? 0,
    compactionCount: x.compactionCount,
    summaryCount: x.summaryCount,
    pruneCount: x.pruneCount,
    lastCompaction: x.lastCompaction,
    afterCompactionPercent: x.afterCompactionPercent,
    // 维度 A 的退化信号：活会话直接用 projection 的值（与提示条同源），冷会话用日志折叠值
    repeatWorst: health?.repeatWorst ?? x.repeatWorst ?? 0,
    degradedReplies: health?.degradedReplies ?? x.degradedReplies ?? 0,
    reasoningLoop: health?.reasoningLoop ?? x.reasoningLoop ?? 0,
    reasoningFlags: health?.reasoningFlags ?? x.reasoningFlags ?? 0,
    // R 节（2026-09-18）：离线和热路径都必须传守卫次数。
    guardTripCount: health?.guardTripCount ?? x.guardTripCount ?? 0,
    // 交接文档自身 token（成本表方案 C 用）；由 buildHandoff 两遍渲染回填实测值
    handoffDocTokens: meta.handoffDocTokens,
    // T 节（2026-09-18）：模型名决定用哪张价表（flash / pro 差 3~4.5 倍）。
    // 冷路径从 `foldSession` 的 request/context 折叠值里取；热路径由 host 下发。
    model: health?.model ?? x.requestContext?.model ?? null,
  };
}

/**
 * 渲染交接内容（Markdown）。
 *
 * @param {object} x - `foldSession` 的结果
 * @param {object} [meta]
 * @param {object} [meta.header] - 会话 header
 * @param {object|null} [meta.health] - projection 健康态（活会话才有）
 * @param {object} [meta.options] - 规模上限
 * @param {string} [meta.source] - 'live' | 'log'
 * @param {string} [meta.generation] - 磁盘日志代际，如 'v3'
 * @param {number} [meta.now] - 生成时间（测试注入）
 * @returns {string} Markdown
 */
export function renderHandoff(x, meta = {}) {
  const { header = {} } = meta;
  let health = meta.health ?? null;
  const options = meta.options ?? {};
  const maxRequests = options.maxRequests ?? 10;
  const maxTurns = options.maxTurns ?? 10;
  const maxFiles = options.maxFiles ?? 15;
  const maxErrors = options.maxErrors ?? 10;
  const maxTools = options.maxTools ?? 8;
  // 「精简档」（2026-09-15 用户选择）：默认只给结论 + 待办 + 文件 + 最近 1 轮原文；
  // 元说明压成一行、附录 B 只展开第 1 条。`profile: 'full'` 切回完整档。
  const slim = (options.profile ?? 'slim') === 'slim';
  const maxDecisions = options.maxDecisions ?? 25;
  const recentTurns = options.recentTurns ?? (slim ? 1 : 2);

  const L = [];
  const push = (s = '') => L.push(s);

  const created = header.createdAt ? isoLocal(header.createdAt) : '未知';
  const lastSeen = x.lastEventTime ? isoLocal(x.lastEventTime) : '未知';
  const durationMin =
    header.createdAt && x.lastEventTime ? Math.round((x.lastEventTime - header.createdAt) / 60000) : undefined;

  push('# 会话交接内容');
  push();
  // N-3（2026-09-15 全量复核）：这份文档的**实际用法**是"粘贴到新会话、交给另一个 AI 接着干"，
  // 而原先头部几行都是写给人的（谁生成的、什么时间、什么来源）。实测贴进新会话后，
  // 对方常常要先反问一句"需要我做什么"。所以补一行**面向接手方**的操作指引 ——
  // 它不额外占 token（本来就在文档里），却能省掉新会话第一轮的来回确认。
  if (slim) {
    push(
      '> 📌 **给接手方**：这是上一个会话的交接材料；先读「最新目标」「待办」「下一步」，' +
        '需要细节再查附录 A/B。**不要回灌全部历史**。',
    );
  } else {
    push('> 📌 **给接手方（新会话的 AI）**：这是上一个会话的交接材料。请先读「最新目标」「待办」「下一步」，');
    push(`> 需要细节时再查「附录 A / B」或原会话日志（\`${header.id ?? '未知'}\`）。**不要回灌全部历史**。`);
  }
  push();
  push('> 由 attention-health 插件从本会话日志**机械提炼**，未调用任何模型、零 token、不联网。');
  push('>');
  push('> ⚠️ 提炼自**完整会话原文**，可能含个人信息（健康 / 财务 / 私事等）；分享给他人前请自行确认。');
  push('>');
  push(`> 生成时间：${isoLocal(meta.now ?? Date.now())}　插件版本：${PLUGIN_VERSION}`);
  push(
    `> 数据来源：${meta.source === 'live' ? '活会话内存（最新）' : '磁盘会话日志快照'}${
      meta.generation ? `　磁盘日志代际：${meta.generation}` : ''
    }`,
  );
  push();

  // ---- 健康度（需求 5：补机制说明）----
  push('## 为什么交接（健康度）');
  push();
  // 冷会话（进程重启后 / 非当前会话）没有实时投影状态。此前这里直接留空不显示评分，
  // 于是同一份文档在"活会话内存"与"磁盘日志"两种来源下会少一行（2026-09-15 复核 P3-3）。
  // 现在用**日志口径**补算，评分函数与热会话共用同一个 `scoreContextHealth`。
  const healthFromLog = health === null;
  if (healthFromLog) {
    const scored = scoreContextHealth({
      usedTokens: x.usage?.lastContextTokens ?? 0,
      contextWindow: x.requestContext?.contextWindow ?? null,
      repeatWorst: x.repeatWorst,
      degradedReplies: x.degradedReplies,
      reasoningLoop: x.reasoningLoop,
      reasoningFlags: x.reasoningFlags,
      reasoningWorstRepeat: x.reasoningWorstRepeat,
      summaryCount: x.summaryCount,
    });
    if (
      scored.effectivePercent !== null ||
      x.repeatWorst > 0 ||
      x.degradedReplies > 0 ||
      (x.reasoningLoop ?? 0) > 0 ||
      (x.reasoningFlags ?? 0) > 0 ||
      (x.summaryCount ?? 0) > 0
    ) {
      health = {
        score: scored.score,
        level: scored.level,
        findings: scored.findings,
        usedTokens: x.usage?.lastContextTokens ?? 0,
        contextWindow: x.requestContext?.contextWindow ?? null,
        effectivePercent: scored.effectivePercent,
        windowPercent: scored.windowPercent,
        repeatWorst: x.repeatWorst,
        degradedReplies: x.degradedReplies,
        replyReasons: x.replyReasons,
        reasoningLoop: x.reasoningLoop,
        reasoningFlags: x.reasoningFlags,
        reasoningWorstRepeat: x.reasoningWorstRepeat,
        reasoningReasons: x.reasoningReasons,
        summaryCount: scored.summaryCount,
      };
    }
  }
  if (health) {
    const label = LEVEL_LABEL[health.level] ?? health.level ?? '未知';
    push(`- 评分 **${health.score}/100** —— ${label}${healthFromLog ? '（日志折算）' : ''}`);
    if (health.usedTokens) push(`- 上下文规模：${health.usedTokens.toLocaleString()} token`);
    if (typeof health.effectivePercent === 'number') {
      const wp =
        typeof health.windowPercent === 'number' ? `，占声明窗口 ${health.windowPercent.toFixed(1)}%` : '';
      push(`- **有效占用 ${health.effectivePercent.toFixed(1)}%**${wp}`);
    }
    if (health.repeatWorst >= 3) push(`- 重复工具调用：最长连续 ${health.repeatWorst} 次`);
    if (health.degradedReplies > 0) {
      push(`- 输出异常：${health.degradedReplies} 条回复出现复读/格式漂移${degradeReasonText(health.replyReasons)}`);
    }
    const thinkTotal = (health.reasoningLoop ?? 0) + (health.reasoningFlags ?? 0);
    if (thinkTotal > 0) {
      const facts = [];
      if ((health.reasoningWorstRepeat ?? 0) >= 10) {
        facts.push(`最长同一行重复 ${health.reasoningWorstRepeat.toLocaleString('en-US')} 次`);
      }
      // 只在**真的越过预算门槛**时才写这个数 —— 否则"烧掉 3.0K token"是纯噪音。
      if ((health.reasoningWorstTokens ?? 0) >= THINK_BUDGET_TOKENS) {
        facts.push(`单次思考最长烧掉 ${(health.reasoningWorstTokens / 1000).toFixed(1)}K token`);
      }
      push(
        `- 思考异常：${thinkTotal} 次${degradeReasonText(health.reasoningReasons)}` +
          (facts.length ? `，${facts.join('，')}` : ''),
      );
    }
    for (const f of health.findings ?? []) push(`- ${f}`);
  } else {
    push('- （本会话日志里没有可用的上下文规模数据；以下内容仍从日志机械提炼）');
  }
  push();
  if (slim) {
    push('> 等级只描述**上下文规模**（与时间、轮数无关），不含行动建议；行动依据看下面的双维度结论。');
    push('> 评分为**启发式指标**（阈值内部校准，未做回溯验证）：看**同一会话的变化趋势**可以，**不代表精确测量**。');
  } else {
    push('> **评分机制**：分数只由**单会话的上下文规模**驱动（`totalTokens` 相对有效窗口的占比），');
    push('> 与挂钟时间、对话轮数、模型状态都无关。所以"才做不久就掉分"通常意味着**单次塞进上下文的量很大**');
    push('> （大文件读取、长工具输出），而不是"用得太久"。');
    push();
    push('> **等级只描述规模**（正常 / 留意上下文 / 上下文偏大 / 上下文过大），**不含任何行动建议**：');
    push('> 行动依据只看「维度 A 质量（异常信号）」与「命中率成本」两项 —— 维度 B 只描述规模，不构成建议。');
    push();
    push('> ⚠️ **评分只是背景**：官方 `dsh-compaction-basic` 要到');
    push(
      `> **声明窗口的 ${COMPACT_DEFAULTS.officialCompactPercent}%** 才自动压缩 —— 所以压缩档位与它同坐标（都用声明窗口），`,
    );
    push('> 质量维度另外用**有效窗口**判断可靠性，但**只在同时检出退化信号时**才给出交接结论，');
    push('> 避免"规模刚到一半就劝换会话"把中间的余量白白浪费掉。');
    push();
    push('> 🧪 **这套数字是什么性质**（2026-09-15 复核 N-6）：评分、等级阈值与扣分力度都是**启发式**——');
    push('> 校准目标是"分数与等级自洽"，**没有用真实数据做过回溯验证**。用途是**比较同一会话的变化趋势**，');
    push(
      `> 不是精确测量。有效窗口的 **${COMPACT_DEFAULTS.effectiveWindowRatio} 系数**同理：方向有研究支撑（上下文越长质量越差），`,
    );
    push('> 具体数值是本插件的经验取值；改它就是改全局判定，`COMPACT_DEFAULTS.effectiveWindowRatio` 一处生效。');
  }
  push();

  // ---- 压缩余量与三种方案（需求补充 1/2）----
  // 平均每轮增长：**相邻两轮结束规模之差、排除第一轮**（与投影同一口径，2026-09-16 统一）。
  // 旧实现直接用 `t.contextDelta`，而它把**第一轮的绝对值**（从 0 算起）也算成"一轮增长"：
  // 既高估增长、又和投影的"按消息"口径差 2.4×~48×（实测同一会话 2166 轮 vs 138 轮）。
  // 同时排除**未闭合的那一轮** —— 投影在 `turn/end` 才结算，两边都只算已结束的轮次。
  const endedTurns = x.turns.filter(
    (t) => t.turn !== x.openTurn && typeof t.contextTokens === 'number',
  );
  const deltas = [];
  for (let i = 1; i < endedTurns.length; i += 1) {
    const d = endedTurns[i].contextTokens - endedTurns[i - 1].contextTokens;
    if (d > 0) deltas.push(d);
  }
  const avgGrowth = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
  const fmtPct = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '未知');

  // 输入构造抽成了 `compactionInputOf`（S 节 2026-09-18）—— 渲染 / 测试 / 探针共用一份，
  // 免得再出现"探针手抄口径、抄漏字段"那类假结论（§51.4 踩过）。
  const plan = deriveCompactionPlan(
    compactionInputOf(x, {
      health,
      avgRoundGrowth: avgGrowth,
      handoffDocTokens: meta.handoffDocTokens,
    }),
  );

  const w = plan.window;
  push('## 交接判断（本地估算，零模型调用）');
  push();
  push('> **两个维度并列展示，口径各自标注、不混用**：');
  if (slim) {
    push('> **维度 A（质量 / 异常）**用**有效窗口**；**维度 B（上下文占用）**用**声明窗口**（与官方线同坐标）。');
  } else {
    push('> **维度 A（质量 / 异常）**以**有效窗口**（声明 × ' + plan.thresholds.effectiveWindowRatio + '）为口径；');
    push('> **维度 B（上下文占用）**按声明窗口分档（与官方线同一坐标系）；');
    push(
      `> 该档位只描述**规模**，不给"该不该压缩"的建议：到声明窗口的 ` +
        `${plan.thresholds.officialCompactPercent}% 官方会自动压缩。`,
    );
  }
  push();

  // ── 维度 A：质量（有效窗口）──
  push(`### 维度 A｜质量（口径：${plan.quality.basis}）`);
  push();
  push(
    `- 有效占用：**${fmtPct(plan.quality.effectivePercent)}**（阈值：≥${plan.thresholds.qualityHandoffPercent}% **且检出退化信号** → 建议交接；≥${plan.thresholds.qualityImmediatePercent}% **且检出退化信号** → 立即新开；只有规模偏大、无退化 → 本维度不给结论）`,
  );
  push(
    `- 退化信号：重复工具调用 ${plan.quality.signals.repeatWorst} 次 / 输出退化 ${plan.quality.signals.degradedReplies} 条 / 思考打转 ${plan.quality.signals.reasoningLoop} 次 / 思考异常长 ${plan.quality.signals.reasoningFlags} 次 → **${
      plan.quality.degraded ? '已检出' : '未检出'
    }**`,
  );
  push(
    `- 维度结论：**${
      plan.quality.advice === 'immediate' ? '立即新开会话' : plan.quality.advice === 'handoff' ? '建议交接' : '可继续'
    }**`,
  );
  push(`- 理由：${plan.quality.reason}`);
  push();

  // ── 维度 B：压缩时机（声明窗口）──
  push(`### 维度 B｜上下文占用（口径：${plan.compact.basis}）`);
  push();
  push(`- 占声明窗口：**${fmtPct(plan.compact.windowPercent)}**（当前上下文 ${w.usedTokens.toLocaleString()} token）`);
  if (w.officialLine !== null) {
    push(
      `- 官方自动压缩线（声明 ${plan.thresholds.officialCompactPercent}%）：${w.officialLine.toLocaleString()} token　` +
        `**距离余量 ${w.headroomToOfficial.toLocaleString()} token**` +
        `${w.headroomRounds !== null ? `（按平均每轮 +${w.avgRoundGrowth.toLocaleString()}，约还能撑 ${w.headroomRounds} 轮）` : ''}`,
    );
  }
  push(
    `- 缓存命中率：**${(plan.usage.hitRate * 100).toFixed(1)}%**` +
      (plan.usage.hitRateBasis === 'tail'
        ? `（最近 ${plan.usage.windowSamples} 次请求累计；最近一次为 命中 ${plan.usage.lastCacheReadTokens.toLocaleString()} / 未命中 ${plan.usage.lastCacheMissTokens.toLocaleString()}）`
        : `（请求数不足 3 次，暂取最近一次：命中 ${plan.usage.lastCacheReadTokens.toLocaleString()} / 未命中 ${plan.usage.lastCacheMissTokens.toLocaleString()}）`),
  );
  push(
    slim
      ? `- 档位：**${plan.compact.bandText}**（口径：**声明窗口**，与官方 ${plan.thresholds.officialCompactPercent}% 线同坐标）`
      : `- 档位：**${plan.compact.bandText}**　(按**声明窗口**分档：<${plan.thresholds.compactMildFrom}% 继续；` +
          `${plan.thresholds.compactMildFrom}~${plan.thresholds.compactRecommendFrom}% 轻度提示；` +
          `${plan.thresholds.compactRecommendFrom}~${plan.thresholds.compactUrgentFrom}% 推荐压缩；` +
          `≥${plan.thresholds.compactUrgentFrom}% 紧急。现场即官方 ${plan.thresholds.officialCompactPercent}% 线附近)`,
  );
  push(`- 理由：${plan.compact.reason}`);
  push();
  push('| 方案 | 一次性成本 | 每轮成本 | 代价 / 说明 |');
  push('|---|---|---|---|');
  push(
    `| **A 继续** | — | ≈ ${plan.plans.continue.perRound.toLocaleString()} | 撑到官方压缩线约 ${w.headroomRounds ?? '?'} 轮 |`,
  );
  push(
    `| **B 先 \`/compact\`** | ≈ ${plan.plans.compact.totalOnce.toLocaleString()}（摘要 ${plan.plans.compact.once.toLocaleString()} + 缓存重建 ${plan.plans.compact.rebuild.toLocaleString()}） | ≈ ${plan.plans.compact.perRound.toLocaleString()} | **有损**：摘要是模型写的，可能丢细节；缓存需重建 |`,
  );
  push(
    `| **C 机械交接 + 新会话** | ≈ ${plan.plans.handoff.once.toLocaleString()}（交接文档冷启动） | ≈ ${plan.plans.handoff.perRound.toLocaleString()} | **无损**：交接文档是事实底座；代价是人工衔接 |`,
  );
  push();
  // ── 真实价格（元）口径（2026-09-16 审查 P3）──────────────────────────────
  // 原来这里只有 token 当量，而**判定用的是元** —— 用户带走的文档里看不到钱；
  // 且"非官方价格"的措辞已经过期：`cacheFactor` 现在就是官方命中价 ÷ 未命中价。
  const yuanFmt = (v) => `¥${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`;
  push('| 方案（真实价格） | 一次性 | 每轮 | 到官方线前总花费 |');
  push('|---|---|---|---|');
  push(`| **A 继续** | — | ${yuanFmt(plan.cost.continuePerRound)} | ${yuanFmt(plan.cost.totalContinue)} |`);
  push(
    `| **B 先 \`/compact\`** | ${yuanFmt(plan.cost.compactOnce)} | ${yuanFmt(plan.cost.compactPerRound)} | ${yuanFmt(plan.cost.totalCompact)} |`,
  );
  push(
    // AB.3（2026-09-20）：C 行的"一次性"是**首轮整轮**（`freshFirstTurn`），
    // 不是首轮第一次请求那一次（`freshOnce`）—— 一轮里通常有多次请求。
    `| **C 机械交接 + 新会话** | ${yuanFmt(plan.cost.freshFirstTurn ?? plan.cost.freshOnce)} | ${yuanFmt(plan.cost.freshPerRound)} | ${yuanFmt(plan.cost.totalFresh)} |`,
  );
  push(
    `> 单价：命中 ${plan.cost.price.cacheHitPerMillion} / 未命中 ${plan.cost.price.cacheMissPerMillion} / ` +
      `输出 ${plan.cost.price.outputPerMillion}（元每百万 token，DeepSeek flash 空闲价）。窗口 = 距官方线 ` +
      `${plan.cost.horizonRounds} 轮（每轮平均输出约 ${Math.round(plan.cost.avgOutputTokens * (plan.cost.stepsPerTurn ?? 1))} token）。` +
      // AB.3：整张表的"每轮"都含 `stepsPerTurn` 次请求 —— 不写出来，读者会把它当成"一次请求的钱"。
      (plan.cost.stepsPerTurn > 1.01
        ? `**每轮平均 ${plan.cost.stepsPerTurn.toFixed(2)} 次请求**（${plan.cost.turnCount} 轮 / 成本口径已按此换算）。`
        : ''),
  );
  // 方案 C 的分段计费（2026-09-18 修正）：首轮**不是**全未命中，第 2 轮起也**不是**未命中价。
  // 这段说明是留证据，避免下次又被"新开会话缓存从零重建"改回去。
  if (typeof plan.cost.handoffBaseHitRate === 'number') {
    push(
      `> **新开会话是分段计费的**：首轮 = 跨会话公共前缀（系统提示 + 工具 schema，实测命中率 ` +
        `${(plan.cost.handoffBaseHitRate * 100).toFixed(0)}%）加权 + **交接文档按未命中价**；` +
        '**第 2 轮起**首轮输入已落盘为缓存前缀单元 → 按命中价。',
    );
  }
  if (typeof plan.cost.freshBreakEvenRounds === 'number') {
    const be = plan.cost.freshBreakEvenRounds;
    const margin = plan.cost.freshWinMarginRounds;
    // AD 节（2026-09-20）：这里原先是**第三处**被漏掉的显示点 —— `be.toFixed(1)` 在
    // `be = 0.0457` 时写成「交接摊平 ≈ 0.0 轮」，用户文档里照样是那句话（实测发现）。
    // 现在与 `handoff-plan.js` 的 `fmtFreshLedger`、`client.js` 的折叠行共用同一套分档口径；
    // 外层已用 `typeof be === 'number'` 兜住，所以 helper 必返回非空。
    const beText = formatBreakEven(be).short;
    push(
      `> **交接摊平 ≈ ${beText}**（首轮溢价 ${yuanFmt(plan.cost.freshFirstRoundPremium)} ÷ ` +
        `每轮节省 ${yuanFmt(plan.cost.freshSavingPerRound)}）；窗口 ${plan.cost.horizonRounds} 轮 —— ` +
        (margin >= 0
          ? `回本后还剩约 **${margin.toFixed(1)} 轮**。`
          : `**差 ${(-margin).toFixed(1)} 轮摊不回来**。`) +
        '判定要求回本后再留 1 轮余量。',
    );
  }
  push(
    plan.cost.hitRateKnown
      ? `> 缓存命中率实测 **${(plan.cost.hitRate * 100).toFixed(1)}%**；上表即为判定依据。`
      : '> ⚠️ 本会话**尚无可信的命中率实测**（首轮零命中是常态，不算"缓存崩了"）—— ' +
        '上表金额按假设命中率估算，**不作为判定依据**。',
  );
  push();
  if (slim) {
    push(`> 上面两张表：先 token 当量（横向比较用），后真实价格（判定用）。系数 ${plan.thresholds.cacheFactor} = 官方命中价 ÷ 未命中价。`);
  } else {
    push(
      `> 方案 B 的"摘要" = 被压缩历史 ${plan.plans.compact.compactedTokens.toLocaleString()} × ${plan.thresholds.cacheFactor}` +
        ` + 摘要输出 ${plan.plans.compact.summaryOutput.toLocaleString()}（全价）；` +
        `"缓存重建" = 压缩后约 ${plan.plans.compact.baseline.toLocaleString()} token 的前缀缓存失效，按 ${REBUILD_ROUNDS} 轮估。`,
    );
    push(
      `> 两张表分工：**token 当量**用于横向比较（不受价格变动影响）；**真实价格**用于判定。` +
        `系数 ${plan.thresholds.cacheFactor} = 官方命中价 ÷ 未命中价（0.02），不是估计值。`,
    );
  }
  if (!plan.plans.compact.worthCompacting && plan.window.usedTokens > 0) {
    push(
      `> ⚠️ **现在压缩的收益 ≈ 0**：当前 ${plan.window.usedTokens.toLocaleString()} token 里只能压掉约 ` +
        `${plan.plans.compact.compressibleNow.toLocaleString()} token（不可压缩基线约 ${plan.plans.compact.baseline.toLocaleString()}` +
        ' = 系统提示 + 摘要 + 工具 schema）。刚压缩过、或上下文几乎全是压不动的骨架时就是这样 —— ' +
        '此时再压只会丢掉刚积累的工作，**建议继续**。',
    );
  }
  if (plan.compact.breakEvenRounds !== null) {
    push(
      `> 方案 B 每轮省 ≈ ${plan.plans.compact.savingPerRound.toLocaleString()}，约 **${plan.compact.breakEvenRounds} 轮**回本。`,
    );
  }
  push();

  // ── 最终建议（质量优先）──
  push('### 最终建议（质量优先于压缩）');
  push();
  push(`**${plan.final.adviceText}**`);
  push();
  push(`理由：${plan.final.reason}`);
  push();
  push(
    '> 边界：本插件只提示，不自动操作（不自动压缩、不改官方 compaction 配置）。',
  );
  push();

  if (x.compactions.length) {
    push('### 压缩历史');
    push();
    push('| 时间 | 类型 | 调用模型 | 被压缩 token | 摘要输出 | 上下文（压缩前 → 压缩后） | 触发 |');
    push('|---|---|---|---|---|---|---|');
    for (const c of x.compactions.slice(-8)) {
      const kind = c.kind === 'summary' ? '模型摘要' : '仅裁剪';
      const modelText = c.kind === 'summary' ? `是${c.model ? `（${c.model}）` : ''}` : '否（零 token）';
      const pre = typeof c.preUsedTokens === 'number' ? c.preUsedTokens.toLocaleString() : '—';
      const post = typeof c.afterUsedTokens === 'number' ? c.afterUsedTokens.toLocaleString() : '—';
      const drop =
        typeof c.preUsedTokens === 'number' && typeof c.afterUsedTokens === 'number' && c.preUsedTokens > c.afterUsedTokens
          ? `（−${(c.preUsedTokens - c.afterUsedTokens).toLocaleString()}）`
          : '';
      push(
        `| ${cell(isoLocal(c.time))} | ${cell(kind)} | ${cell(modelText)} | ${cell((c.shadowedTokens ?? 0).toLocaleString())} | ${
          c.summaryTokens ? c.summaryTokens.toLocaleString() : '—'
        } | ${cell(`${pre} → ${post} ${drop}`)} | ${cell(`${c.manual ? '人工 /compact' : '自动'}${c.error ? ' · 失败' : ''}`)} |`,
      );
    }
    push();
    push('> 注：`被压缩 token` 是官方事件里的 `shadowedTokenCount`（被摘要替换掉的历史量）；');
    push('> `压缩前 → 压缩后` 是**实测的上下文规模**。两者口径不同，判断实际效果请看后者。');
    push();
    push(
      `> 本次会话已压缩 ${x.summaryCount} 次模型摘要 + ${x.pruneCount} 次零 token 裁剪。` +
        '**反复压缩收益递减且信息累积损失** —— 到第 ' +
        plan.thresholds.handoffAtCompactionCount +
        ' 次就该考虑机械交接了。',
    );
    push();
  }
  // 实时思考守卫的止损记录（2026-09-18 审查 C2 修复）。
  // 数据早已收集（`guardTripCount` / `lastGuardReason`），只是**漏了渲染** ——
  // 结果是"提示条说被中止、交接文档只字未提"，正是第 38 节写明要避免的那种分叉。
  if ((x.guardTripCount ?? 0) > 0) {
    push(
      `- **思考守卫**：已中止空转 **${x.guardTripCount} 次**` +
        (x.lastGuardReason ? `（最近一次：${x.lastGuardReason}）` : '') +
        ' —— 由插件在生成过程中**主动中止**（避免空转烧 token），不是流程故障。',
    );
    push();
  }
  push();

  // ---- 会话标识（需求 8：最新标题 + 曾用标题）----
  push('## 会话');
  push();
  push(`- ID：\`${header.id ?? '未知'}\``);
  if (x.title) {
    push(`- 标题（最新）：${x.title}`);
    const old = x.titleHistory.slice(0, -1).map((t) => t.title).filter(Boolean);
    if (old.length) push(`- 曾用标题：${old.join(' → ')}`);
  }
  push(`- 工作目录：\`${header.cwd ?? '未知'}\``);
  if (header.agentPreset) push(`- Agent Preset：${header.agentPreset}`);
  push(`- 创建：${created}　最后活动：${lastSeen}${durationMin !== undefined ? `（约 ${durationMin} 分钟）` : ''}`);
  if (x.requestContext) {
    const rc = x.requestContext;
    const win = rc.contextWindow ? `${(rc.contextWindow / 1000).toLocaleString()}K` : '未知';
    push(`- 模型：${rc.provider ?? '?'} / ${rc.model ?? '?'}（窗口 ${win}）`);
  }
  push();

  // ---- 目标（需求 1：最新目标）----
  push('## 最新目标');
  push();
  const goal = deriveGoal(x);
  if (!goal) {
    push('（日志中没有目标信息）');
  } else if (goal.kind === 'goal') {
    push(`**${clip(goal.latest, 400)}**`);
    push();
    push(`- 阶段：\`${goal.goal.phase ?? '未知'}\``);
    if (goal.goal.roundsStarted !== undefined) {
      push(`- 已完成轮次：${goal.goal.roundsStarted}${goal.goal.maxGoalRounds ? ` / ${goal.goal.maxGoalRounds}` : ''}`);
    }
    if (goal.goal.blockedReason) push(`- ⚠️ 阻塞：${goal.goal.blockedReason}`);
  } else if (goal.same) {
    push(`**${clip(goal.latest, 400)}**`);
    push();
    push('（本会话未设置 goal，取最近一条**实质性**请求；与最初请求基本一致）');
    if (goal.lastControl) {
      push();
      push(
        `> 说明：其后还有控制指令（第 ${goal.lastControlTurn ?? '?'} 轮：\`${clip(goal.lastControl, 60)}\`），那只是"继续做"，不承载任务意图。`,
      );
    }
  } else {
    push('### 最初目标');
    push();
    push(`**${clip(goal.first, 300)}**`);
    push();
    push('### 最新目标');
    push();
    push(`**${clip(goal.latest, 400)}**`);
    push();
    push(`> 两者差异较大（相似度 ${(goal.similarity * 100).toFixed(0)}%）—— **以最新目标为准**，最初目标只作背景。`);
    if (goal.lastControl) {
      push('>');
      push(
        `> 说明：最新目标取的是**最近一条实质性请求** —— 其后还有控制指令（第 ${goal.lastControlTurn ?? '?'} 轮：\`${clip(goal.lastControl, 60)}\`），那只是"继续做"，不承载任务意图。`,
      );
    }
  }
  push();

  // ---- 用户请求主线（需求 9：超长压缩）----
  const longRequests = x.userRequests.filter((r) => String(r.text).length > REQUEST_SUMMARY_CHARS);
  push(`## 用户请求主线（共 ${x.userRequests.length} 条）`);
  push();
  if (!x.userRequests.length) {
    push('（无）');
  } else {
    x.userRequests.slice(0, maxRequests).forEach((r, i) => {
      const tag = r.via === 'question' ? '**[问答回答]** ' : '';
      const raw = String(r.text);
      const body =
        raw.length > REQUEST_SUMMARY_CHARS
          ? `${summarize(raw, REQUEST_SUMMARY_CHARS)}\n   → 全文见 **附录 B-${i + 1}**`
          : raw.replace(/\s+/g, ' ').trim();
      push(`${i + 1}. ${tag}${body}`);
    });
    if (x.userRequests.length > maxRequests) {
      push(`- …另有 ${x.userRequests.length - maxRequests} 条（未展开）`);
    }
    if (longRequests.length) {
      push();
      push(`> 其中 ${longRequests.length} 条为超长正文（>${REQUEST_SUMMARY_CHARS} 字），此处只给摘要，原文在附录 B。`);
    }
  }
  push();

  // ---- 关键决策与未决问题（需求 2）----
  push(`## 关键决策与未决问题（规则抽取，共 ${x.decisions.length} 条）`);
  push();
  // 抽取依据与局限（2026-09-15 跨领域复核结论 2 + N-5 附带）：
  // 主词表是工程 / 取舍语境，咨询、报表、生活对话里的"数字结论"会整体漏抽
  // （实测"散件合计约 11900 元"、"更推荐去本地口碑好的维修店"）。
  // 上一轮曾直接否决扩充（早期收「失败 / 原因 / 注意 / 修复 / 坑」这类泛词，
  // 74 条里大半是表格行与过期数字）；这一轮实测了复核给的具体词表，质量可用，
  // 故改为**会话级兜底**：主词表命中不足 3 条时才启用，只影响 19/67 个会话。
  // 2026-09-18 审查 F.2：词表已扩为**中英双语**，说明文字必须如实反映 ——
  // 否则英文会话看到"未命中关键词句"时，无法判断"是真没结论"还是"语言不支持"。
  if (slim) {
    push(
      `> 抽取依据：命中「${DECISION_KEYWORDS.slice(0, 2).join(' / ')}」等**中英双语**取舍类关键词` +
        (x.broadFallback
          ? `；本会话取舍词不足 ${DECISION_BROAD_TRIGGER} 条，已用通用结论词兜底补抽（${DECISION_KEYWORDS_BROAD_ALL.join(' / ')}）。`
          : '。'),
    );
  } else {
    push(
      `> 抽取依据：句子命中「${DECISION_KEYWORDS.slice(0, 4).join(' / ')} / ${DECISION_KEYWORDS_EN.slice(0, 3).join(' / ')}」等共 ${DECISION_KEYWORDS_ALL.length} 个` +
        '**取舍 / 结论类关键词**（**中英双语**；噪声模式已过滤）。' +
        '中文表偏工程与调试语境；英文表刻意只用高精度短语（避开 because / therefore 这类高频误报词）。',
    );
    push(
      x.broadFallback
        ? `> 本会话取舍词命中不足 ${DECISION_BROAD_TRIGGER} 条，因此**已启用通用结论词兜底**（${DECISION_KEYWORDS_BROAD_ALL.join(' / ')}）——` +
            '咨询、报表、生活对话里的数字结论，以及英文会话的结论句都靠这一级补回；仍然过滤表格行、命令行与状态标记。'
        : `> 本会话取舍词命中充足（≥${DECISION_BROAD_TRIGGER} 条），**未启用**通用词兜底；` +
            '漏掉的内容请以「用户请求主线」与附录原文为准。',
    );
  }
  push();
  if (!x.decisions.length) {
    push(
      `（未命中关键词句。词表为**中英双语**：取舍词 ${DECISION_KEYWORDS.slice(0, 6).join(' / ')} / ` +
        `${DECISION_KEYWORDS_EN.slice(0, 4).join(' / ')}；通用结论词 ${DECISION_KEYWORDS_BROAD_ALL.join(' / ')}。` +
        ' 本会话正文可能确实没有结论句，或结论句用了这两张表都没收的措辞。）',
    );
  } else {
    for (const d of x.decisions.slice(0, maxDecisions)) {
      const where = d.turns.length ? `第 ${d.turns.join('、')} 轮` : '轮次未知';
      const who = d.role === 'assistant' ? '助手' : d.role === 'user-answer' ? '用户回答' : '用户';
      push(`- [${where}·${who}] ${sanitizeInline(clip(d.text, 240))}`);
    }
    if (x.decisions.length > maxDecisions) push(`- …另有 ${x.decisions.length - maxDecisions} 条`);
  }
  push();

  // ---- 各轮进度 ----
  push(`## 各轮进度（共 ${x.turns.length} 轮，下表为最近 ${Math.min(maxTurns, x.turns.length)} 轮）`);
  push();
  if (!x.turns.length) {
    push('（无）');
  } else {
    push('| 轮 | 请求 | 结果 | 工具 | 错误 | 结束 |');
    push('|---|---|---|---|---|---|');
    for (const t of x.turns.slice(-maxTurns)) {
      push(
        `| ${cell(t.turn)} | ${cell(plain(t.prompt ?? '—', 44))} | ${cell(plain(t.response ?? '—', 56))} | ${cell(t.tools)} | ${
          cell(t.errors || '—')
        } | ${cell(t.reason ?? '**未闭合**')} |`,
      );
    }
  }
  push();

  // ---- 涉及文件（需求 7）----
  push(`## 涉及的文件（文件工具 ${x.files.length} 个）`);
  push();
  if (!x.files.length) {
    push('（未检测到文件工具修改）');
  } else {
    push('> 只覆盖 DSH 文件工具（`write` / `edit` / `str_replace_editor`）的改动。');
    push();
    for (const f of x.files.slice(0, maxFiles)) {
      push(`- \`${f.path}\` — ${f.ops.map(([op, n]) => `${op}×${n}`).join(', ')}${tempTag(f.path)}`);
    }
    if (x.files.length > maxFiles) push(`- …另有 ${x.files.length - maxFiles} 个`);
  }
  push();
  if (x.commandFiles.length) {
    push(`### 可能涉及（来自命令，启发式 ${x.commandFiles.length} 条）`);
    push();
    push('> 从 `pwsh`/`bash` 命令文本里挑出的写文件动作（`Set-Content` / `Add-Content` / `Out-File` /');
    push('> `New-Item` / `Copy-Item` / `>` 重定向）。**仅供参考**，可能包含临时文件或漏判。');
    push();
    for (const c of x.commandFiles.slice(0, 12)) {
      const turns = c.turns.length ? `（第 ${c.turns.join('、')} 轮）` : '';
      push(`- \`${c.path}\` — ${c.op}×${c.count} ${turns}`);
    }
    if (x.commandFiles.length > 12) push(`- …另有 ${x.commandFiles.length - 12} 条`);
    push();
  }

  // ---- 待办 ----
  const todos = Array.isArray(x.todos) ? x.todos : [];
  push('## 待办');
  push();
  if (!todos.length) {
    push('（日志中无 todo 记录）');
  } else {
    const lastTurnNo = x.turns.length ? x.turns[x.turns.length - 1].turn : undefined;
    const staleTodos = x.todosTurn !== undefined && lastTurnNo !== undefined && x.todosTurn < lastTurnNo;
    if (x.todosTurn !== undefined) {
      push(
        staleTodos
          ? `（来自第 ${x.todosTurn} 轮的 \`todo_write\`，**此后未再更新** —— 下列状态只是当时的快照，其中多项**很可能已经做完**，请先核实工作区实际状态）`
          : `（来自第 ${x.todosTurn} 轮）`,
      );
    }
    push();
    for (const todo of todos) {
      const mark = todo.status === 'completed' ? 'x' : ' ';
      push(`- [${mark}] ${todo.content}${todo.status === 'in_progress' ? ' ← 当时标记为进行中' : ''}`);
    }
  }
  push();

  // ---- 错误（需求 4：聚合）----
  const errorGroups = aggregateErrors(x);
  push(`## 遇到的错误（原始 ${x.errors.length} 条，聚合为 ${errorGroups.length} 类）`);
  push();
  if (!errorGroups.length) {
    push('（无）');
  } else {
    for (const g of errorGroups.slice(0, maxErrors)) {
      const turns = g.turns.length ? `第 ${g.turns.join('、')} 轮` : '轮次未知';
      push(`- **${g.label}** × ${g.count} —— 出现在 ${turns}；${g.resolution}`);
      for (const d of g.details) push(`  - 示例：${clip(d, 160)}`);
    }
    if (errorGroups.length > maxErrors) push(`- …另有 ${errorGroups.length - maxErrors} 类`);
  }
  push();

  // ---- 下一步 ----
  push('## 下一步（规则推导，非模型建议）');
  push();
  for (const step of deriveNextSteps(x)) push(`- ${step}`);
  push();

  // ---- 统计（需求 6：各轮增长）----
  const toolTotal = x.toolCounts.reduce((sum, [, n]) => sum + n, 0);
  const growth = deriveGrowth(x);
  push('## 统计');
  push();
  push(`- 用户轮次 ${x.turns.length}　Agent 步骤 ${x.stepCount}　助手回复 ${x.usage.replies}`);
  push(`- 工具调用 ${toolTotal}　输出 token 累计 ${x.usage.outputTokens.toLocaleString()}`);
  if (x.usage.lastContextTokens) push(`- 末尾上下文 ${x.usage.lastContextTokens.toLocaleString()} token`);
  if (x.compactionCount) push(`- 会话中发生过 ${x.compactionCount} 次压缩`);
  push();

  if (growth.rows.length) {
    push('### 各轮上下文增长（定位膨胀来源）');
    push();
    push('| 轮 | 上下文规模 | 本轮增量 | 输出 token | 工具结果字符 | 主要来源 |');
    push('|---|---|---|---|---|---|');
    for (const r of growth.rows.slice(-maxTurns)) {
      const delta = r.compacted
        ? `**${r.delta.toLocaleString()}**（压缩后重置）`
        : `+${r.delta.toLocaleString()}`;
      push(
        `| ${cell(r.turn)} | ${cell(r.contextTokens.toLocaleString())} | ${cell(delta)} | ${cell(r.outputTokens.toLocaleString())} | ${cell(r.toolResultChars.toLocaleString())} | ${cell(r.cause)} |`,
      );
    }
    push();
    if (growth.top.length) {
      const shownTurns = new Set(growth.rows.slice(-maxTurns).map((r) => r.turn));
      push(
        `**增长最快的轮次**：${growth.top
          .map(
            (r) =>
              `第 ${r.turn} 轮（+${r.delta.toLocaleString()}，${r.cause}${
                shownTurns.has(r.turn) ? '' : `，该轮规模 ${r.contextTokens.toLocaleString()}`
              }）`,
          )
          .join('、')}`,
      );
      // 审查可读性 4：top3 里可能有轮次不在上表（表只列最近 N 轮），读者查不到就以为错了
      const offTable = growth.top.filter((r) => !shownTurns.has(r.turn));
      if (offTable.length) {
        push(
          `> 注：上表只列最近 ${maxTurns} 轮，${offTable
            .map((r) => `第 ${r.turn} 轮`)
            .join('、')}不在表内（数字取自完整增长表）。`,
        );
      }
      const biggest = growth.top[0];
      push(
        `> 判定依据：该轮工具结果约 ${biggest.toolResultTokensEst.toLocaleString()} token 量级（按 4 字符/token 估算），` +
          `模型输出 ${biggest.outputTokens.toLocaleString()} token —— 膨胀主要来自${
            biggest.cause === '大工具输出'
              ? '**工具输出**（读大文件 / 长命令回显）'
              : biggest.cause === '模型长输出'
                ? '**模型长输出**'
                : '两者混合'
          }。`,
      );
    }
    push();
  }

  if (x.toolCounts.length) {
    push(`工具分布：${x.toolCounts.slice(0, maxTools).map(([n, c]) => `\`${n}\`×${c}`).join('、')}`);
    push();
  }

  // ---- 附录 A：最近 N 轮完整原文（需求 3）----
  // N-4（2026-09-15 全量复核）：原先直接 `x.turns.slice(-recentTurns)` —— 末轮哪怕是
  // 用户只打了「继续」（2 字）、助手回了 42 字，也会被当"临场细节"全文展开：占篇幅、零信息。
  // 现在复用 `isControlRequest()` 从末尾往前挑**实质性轮次**，并注明跳过了哪几轮。
  const recent = [];
  const skippedTurns = [];
  for (let i = x.turns.length - 1; i >= 0 && recent.length < recentTurns; i -= 1) {
    const t = x.turns[i];
    const asksOfTurn = x.userRequests.filter((r) => r.turn === t.turn);
    const promptText = asksOfTurn.length ? asksOfTurn.map((r) => r.text).join(' ') : (t.prompt ?? '');
    if (promptText && isControlRequest(promptText)) {
      skippedTurns.push(t.turn);
      continue;
    }
    recent.push(t);
  }
  // 整段会话都是控制型输入（极少见）：仍然给出最后一轮，避免出现空附录
  if (!recent.length && x.turns.length) {
    recent.push(x.turns[x.turns.length - 1]);
    skippedTurns.pop();
  }
  skippedTurns.reverse();

  push(
    `## 附录 A：最近 ${recent.length} 轮完整原文` +
      (skippedTurns.length
        ? `（已跳过 ${skippedTurns.length} 轮指令型输入：第 ${skippedTurns.join('、')} 轮）`
        : ''),
  );
  push();
  push(`> 目的：保留接手所需的临场细节。总长上限 ${APPENDIX_MAX_CHARS.toLocaleString()} 字符，超出在尾部截断。`);
  push();

  let appendixChars = 0;
  let truncated = false;

  for (const t of recent) {
    if (truncated) break;
    push(`### 第 ${t.turn} 轮${t.reason ? `（${t.reason}）` : '（未闭合）'}`);
    push();

    const asks = x.userRequests.filter((r) => r.turn === t.turn);
    const askText = asks.length ? asks.map((r) => r.text).join('\n\n---\n\n') : t.prompt ?? '';
    const askFull = askText ? String(askText) : '（该轮没有 user/message 记录）';
    const replyFull = t.response ?? '';

    // 真正按上限裁剪：先给用户请求，再给助手回复，超出部分切掉并标注
    let remaining = APPENDIX_MAX_CHARS - appendixChars;
    const askShown = askFull.length > remaining ? askFull.slice(0, Math.max(0, remaining)) : askFull;
    const askCut = askShown.length < askFull.length;
    remaining -= askShown.length;

    let replyShown = replyFull;
    let replyCut = false;
    if (remaining <= 0) {
      replyShown = '';
      replyCut = replyFull.length > 0;
    } else if (replyFull.length > remaining) {
      replyShown = replyFull.slice(0, remaining);
      replyCut = true;
    }

    push(`**用户请求（原文 ${askFull.length.toLocaleString()} 字）**`);
    push();
    push(askShown || '（该轮没有 user/message 记录）');
    if (askCut) push('\n…（本段被截断，命中附录上限）');
    push();

    push(`**助手最终回复（原文 ${replyFull.length.toLocaleString()} 字）**`);
    push();
    push(replyShown || (replyFull ? '（本段因附录上限被完全截断）' : '（该轮没有助手文本回复）'));
    if (replyCut && replyShown) push('\n…（本段被截断，命中附录上限）');
    push();

    appendixChars += askShown.length + replyShown.length;
    if (askCut || replyCut) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    push(
      `> ⚠️ 附录已达 ${APPENDIX_MAX_CHARS.toLocaleString()} 字符上限，**尾部内容被截断**（上文按轮次倒序保留）。`,
    );
  } else {
    push(`> 附录实际 ${appendixChars.toLocaleString()} 字符（未超限）。`);
  }
  push();

  // ---- 附录 B：超长用户请求原文（需求 9）----
  //
  // 精简档只展开**第 1 条**（约 900 字符），其余只报条数 —— 2026-09-15 用户选择：
  // 附录 B 是篇幅大头（实测 159 行 / 约 12,000 字符），精简后整篇能降三成。
  // 完整档（`profile: 'full'`）仍按 APPENDIX_B_MAX_CHARS 全量留档。
  if (longRequests.length) {
    const limitB = slim ? 900 : APPENDIX_B_MAX_CHARS;
    push(
      `## 附录 B：超长用户请求原文（共 ${longRequests.length} 条，上限 ${limitB.toLocaleString()} 字符${slim ? '，精简档只展开第 1 条' : ''}）`,
    );
    push();
    let appendixBChars = 0;
    let keptB = 0;
    for (const r of longRequests) {
      if (appendixBChars >= limitB) break;
      const body = String(r.text ?? '');
      const idx = x.userRequests.indexOf(r) + 1;
      const room = limitB - appendixBChars;
      const truncated = body.length > room;
      const shown = truncated
        ? `${body.slice(0, Math.max(0, room - 60))}\n\n…（本条已截断，原始 ${body.length.toLocaleString()} 字）`
        : body;
      push(
        `### B-${idx}（第 ${r.turn ?? '?'} 轮，${body.length.toLocaleString()} 字${truncated ? '，已截断' : ''}）`,
      );
      push();
      push(shown);
      push();
      appendixBChars += shown.length;
      keptB += 1;
    }
    const omittedB = longRequests.length - keptB;
    if (omittedB > 0) {
      push(
        `> ⚠️ 附录 B 已达 ${limitB.toLocaleString()} 字符上限，**另有 ${omittedB} 条超长请求未展开**` +
          `${slim ? '（需要全文请用「复制完整版」）' : '（完整原文见会话日志）'}。`,
      );
      push();
    }
  }

  push('---');
  push();
  push('*以上全部由本地规则从会话日志提炼，未调用任何模型、零 token、不联网。*');

  return L.join('\n');
}

/**
 * 一步到位：事件流 → 交接 Markdown。
 *
 * @param {object} input
 * @param {object[]} input.events - 会话原始事件
 * @param {object} [input.header] - 会话 header
 * @param {object|null} [input.health] - projection 健康态
 * @param {object} [input.options] - 渲染规模上限
 * @param {string} [input.source] - 'live' | 'log'
 * @param {string} [input.generation] - 磁盘日志代际
 * @param {number} [input.now] - 生成时间（测试注入）
 * @returns {{markdown: string, stats: object}}
 */
export function buildHandoff(input) {
  const events = Array.isArray(input?.events) ? input.events : [];
  const x = foldSession(events);
  const baseMeta = {
    header: input?.header ?? {},
    health: input?.health ?? null,
    options: input?.options ?? {},
    source: input?.source,
    generation: input?.generation,
    now: input?.now,
  };

  // 两遍渲染：成本表里方案 C 需要「交接文档自身」的 token 量，而它又取决于文档长度。
  // 第一遍用估算值拿到真实字符数，第二遍用实测长度重算 —— 纯本地算术，代价可忽略。
  const preview = renderHandoff(x, { ...baseMeta, handoffDocTokens: 6000 });
  const handoffDocTokens = Math.max(500, Math.round(preview.length / HANDOFF_CHARS_PER_TOKEN));
  const markdown = renderHandoff(x, { ...baseMeta, handoffDocTokens });

  // 交接历史留痕（N-6 建议 1）：把"交接当时的评分现场"一并带进 stats，
  // 供 host 路由 / CLI 落盘。冷会话没有投影状态，这里用与渲染完全相同的日志口径重算
  // （纯本地算术，代价可忽略；避免调用方为了记录再算一遍而分叉）。
  const healthState = input?.health ?? null;
  const historyScore = scoreContextHealth({
    usedTokens: healthState?.usedTokens ?? x.usage?.lastContextTokens ?? 0,
    contextWindow: healthState?.contextWindow ?? x.requestContext?.contextWindow ?? null,
    repeatWorst: healthState?.repeatWorst ?? x.repeatWorst,
    degradedReplies: healthState?.degradedReplies ?? x.degradedReplies,
    reasoningLoop: healthState?.reasoningLoop ?? x.reasoningLoop,
    reasoningFlags: healthState?.reasoningFlags ?? x.reasoningFlags,
    reasoningWorstRepeat: healthState?.reasoningWorstRepeat ?? x.reasoningWorstRepeat,
    summaryCount: healthState?.summaryCount ?? x.summaryCount,
  });

  return {
    markdown,
    stats: {
      events: events.length,
      userRequests: x.userRequests.length,
      turns: x.turns.length,
      files: x.files.length,
      commandFiles: x.commandFiles.length,
      errors: x.errors.length,
      errorGroups: aggregateErrors(x).length,
      decisions: x.decisions.length,
      chars: markdown.length,
      handoffDocTokens,
      // ── 校准留痕所需的现场量（N-5 / N-6）──
      broadFallback: Boolean(x.broadFallback),
      profile: baseMeta.options?.profile ?? 'slim',
      score: historyScore.score,
      level: historyScore.level,
      effectivePercent: historyScore.effectivePercent,
      windowPercent: historyScore.windowPercent,
      usedTokens: healthState?.usedTokens ?? x.usage?.lastContextTokens ?? 0,
      summaryCount: x.summaryCount ?? 0,
      degradedReplies: x.degradedReplies ?? 0,
      reasoningLoop: x.reasoningLoop ?? 0,
      reasoningFlags: x.reasoningFlags ?? 0,
    },
  };
}

