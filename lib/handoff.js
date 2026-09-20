/**
 * attention-health —— 交接内容提炼与精简渲染（host 半，纯本地、零模型）
 *
 * ## 为什么是规则而不是模型
 *
 * 要交接的时刻，正是模型已经不可靠的时刻。让退化的模型去总结它退化的过程，
 * 产出必然是垃圾。会话日志是 append-only 的事件溯源记录，数据本身完好，
 * 与模型状态无关 —— 所以这里**没有任何模型调用、零 token 消耗、不联网**。
 *
 * ## 与离线工具的关系
 *
 * 折叠逻辑移植自项目里的 `lib/extract.mjs`（离线 CLI `handoff.mjs` 用的同一套判据），
 * 渲染是**交接专用**版本。`test/handoff-test.mjs` 会把两者的关键指标逐一对齐，防止漂移。
 *
 * ## 2026-09-15 提炼质量增强（全部为本地规则）
 *
 * 1. 「最新目标」取代「当前目标」：优先最新 `goal/change`；无 goal 时取**最近一条**
 *    用户请求；首条与最新差异较大时并列「最初目标 / 最新目标」。
 * 2. 新增「关键决策与未决问题」：从助手文本与问答回答里按关键词抽句，按时间排序并标轮次。
 * 3. 新增「附录 A：最近 1~2 轮完整原文」（不截断，总长上限 20KB）。
 * 4. 错误清单**聚合**：同错误码合并计数、标注出现轮次、判断后续是否复现。
 * 5. 健康度段补充**评分机制说明**（分数由单会话上下文规模驱动，与时间无关）。
 * 6. 统计新增「各轮上下文增长」表，标出增长最快的轮次并判断是长输出还是大工具结果。
 * 7. 文件清单新增「可能涉及（来自命令）」：从 `pwsh`/`bash` 命令文本里挑出写文件动作。
 * 8. 标题取**最新** `session/title`，并保留曾用标题。
 * 9. 超长用户请求默认压缩成摘要，原文进附录 B。
 * 10. 文档头部加生成时间戳、插件版本、数据来源与磁盘日志代际。
 *
 * @module attention-health/handoff（barrel）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-18 D3：本文件已拆分为 6 个模块，这里只做**转发**。
//
// 为什么拆：单文件 3,656 行，判据 / 折叠 / 计划 / 渲染挤在一起，
// 改一处判据要在 3,000 行里找依赖（C1 那次"符号堆砌误报"正是这种结构的产物）。
//
// 为什么保留本文件：`plugin/index.js`、`lib/detect.mjs`、`lib/extract.mjs`、
// 离线 CLI `handoff.mjs` 与两套测试都按路径 import 它。保留同名的 barrel，
// 拆分对它们**完全透明** —— 这是"行为零变化"最容易验证的一种做法。
//
// 依赖方向（无环，由 `work/d3-sections.mjs` 验证）：
//   handoff-core.js ─┬─► handoff-text.js ─► handoff-plan.js ─► handoff-fold.js ─┐
//   handoff-judge.js ┘                                                          ├─► handoff-render.js
//                                                             handoff-core.js ──┘
//
// ⚠️ 导出名单是**显式列举**的，不是 `export *`：跨模块共享需要给一些内部函数
//    加 `export`，用 `export *` 会把它们也漏出去，公开 API 就变了。
// ─────────────────────────────────────────────────────────────────────────────

export { PLUGIN_VERSION, LEVEL_LABEL, COMPACT_DEFAULTS, scoreContextHealth, contextTokensOf, blocksToText } from './handoff-core.js';
export { DEGRADE_LABELS, replyDegradeReasons, reasoningDegradeReasons, scanReasoning, looksDegraded } from './handoff-judge.js';
export { foldSession } from './handoff-fold.js';
export { HIT_RATE_WINDOW, FINAL_NOTES, deriveCompactionPlan, formatBreakEven } from './handoff-plan.js';
export { renderHandoff, buildHandoff, compactionInputOf } from './handoff-render.js';
