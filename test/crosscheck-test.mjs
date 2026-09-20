/**
 * 多方面求证（一）：**同一份会话数据，三条实现路径必须给出同一个答案**。
 *
 * 为什么是这三条：
 *   A. `lib/index.js` 的 `foldEvent`  —— 活会话热路径（提示条真正用的那条）
 *   B. `lib/handoff.js` 的 `foldSession` —— 冷会话日志折叠（交接文档用的那条）
 *   C. `lib/detect.mjs` 的 `analyzeSession` —— 离线 CLI（--health 用的那条）
 *
 * 项目历史上"两处口径分叉"出现过 **3 次**（UI 改了文档没改、投影 5 条 vs 折叠 3 条、
 * 离线 CLI 自持一套渲染）。既有测试只抽查 6 个会话；这里跑**全部**会话，
 * 并且额外做不变量检查与鲁棒性/性能体检。
 *
 * 加载的是**已部署副本**（真正在跑的那份），而不是源码 —— 所以它同时验证
 * "部署是否到位"：源码改了没部署，这里会红。
 *
 * 本套件由 `deploy.ps1` 的自测阶段自动运行（2026-09-15 收编为常驻验证）。
 * 它**抓出过 5 个真实缺陷**（2 处口径分叉、2 类畸形输入崩溃、1 处重复实现导致的分叉），
 * 详见 `DEPLOYMENT-NOTES-20260915.md` 第 23 节。
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 项目根由本文件位置推出（不再硬编码本机路径），换台机器也能跑。
const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 部署目录可用环境变量覆盖（2026-09-18 标准包化）：临时 profile 实验靠它指向刚装进去的那份。
const DEPLOYED =
  process.env.DSH_ATTENTION_HEALTH_DIR ??
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'attention-health');

const sessionLog = await import(pathToFileURL(path.join(SRC, 'lib', 'session-log.mjs')).href);
const detect = await import(pathToFileURL(path.join(SRC, 'lib', 'detect.mjs')).href);
const plugin = await import(pathToFileURL(path.join(DEPLOYED, 'index.js')).href);
const handoff = await import(pathToFileURL(path.join(DEPLOYED, 'handoff.js')).href);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ── 拿到投影定义（与 plugin-test 同一套 mock ctx）──────────────────────────
const registry = [];
plugin.apply({
  sessionProjections: { register: (d) => registry.push(d) },
  get: () => undefined,
  effect: () => () => {},
  inject: () => {},
});
const def = registry[0];
if (!def) throw new Error('未注册投影，无法继续');

// ── 1. 三路径全量交叉验证 ──────────────────────────────────────────────────
console.log('\n════════ 1. 三条实现路径 · 全量会话交叉验证 ════════');
const sessions = sessionLog.listSessions();
const mismatches = [];
const rows = [];
let okCount = 0;

for (const meta of sessions) {
  let session;
  try {
    session = sessionLog.readSession(meta.file);
  } catch {
    continue;
  }
  const sid = path.basename(path.dirname(meta.file ?? '')) || meta.file || '(?)';

  // A：热路径
  let state = def.init();
  for (const event of session.events) state = def.apply(state, event);

  // B：冷路径
  const fold = handoff.foldSession(session.events);

  // C：离线
  const offline = detect.analyzeSession(session);

  const diffs = [];
  const cmp = (name, a, b) => {
    if (a !== b) diffs.push(`${name}[A=${a} ${name.includes('/B') ? 'B' : 'C'}=${b}]`);
  };
  // A（投影）vs C（离线 CLI）—— 两者都能给出完整评分
  cmp('usedTokens(A/C)', state.usedTokens, offline.context.usedTokens);
  cmp('score(A/C)', state.score, offline.score);
  cmp('level(A/C)', state.level, offline.level);
  cmp('repeatWorst(A/C)', state.repeatWorst, offline.repeats.worst);
  cmp('degradedReplies(A/C)', state.degradedReplies, offline.degradation.count);
  cmp('reasoningLoop(A/C)', state.reasoningLoop, offline.degradation.reasoningLoop);
  cmp('reasoningFlags(A/C)', state.reasoningFlags, offline.degradation.reasoningFlags);
  cmp('reasoningWorstRepeat(A/C)', state.reasoningWorstRepeat, offline.degradation.reasoningWorstRepeat);
  // A（投影）vs B（日志折叠）—— 折叠不产出评分，只比对它确实产出的退化计数与规模
  cmp('usedTokens(A/B)', state.usedTokens, fold.usage?.lastContextTokens);
  cmp('repeatWorst(A/B)', state.repeatWorst, fold.repeatWorst);
  cmp('degradedReplies(A/B)', state.degradedReplies, fold.degradedReplies);
  cmp('reasoningLoop(A/B)', state.reasoningLoop, fold.reasoningLoop);
  cmp('reasoningFlags(A/B)', state.reasoningFlags, fold.reasoningFlags);
  cmp('reasoningWorstRepeat(A/B)', state.reasoningWorstRepeat, fold.reasoningWorstRepeat);
  // 轮次增长口径（2026-09-16 统一）：投影与文档必须给出**同一个**"平均每轮增长"。
  // 这条是补的 —— 原来的交叉验证没比这个字段，于是"投影说还能撑 259 轮、文档说 14 轮"
  // （按消息 vs 按轮，实测差 2.4×~48×）长期没被发现，而它直接决定压缩建议。
  const endedTurns = fold.turns.filter(
    (t) => t.turn !== fold.openTurn && typeof t.contextTokens === 'number',
  );
  const ds = [];
  for (let i = 1; i < endedTurns.length; i += 1) {
    const d = endedTurns[i].contextTokens - endedTurns[i - 1].contextTokens;
    if (d > 0) ds.push(d);
  }
  // 注意用**原始均值**（不四舍五入）：host 内部把 `growthSum / growthCount` 原样交给
  // 成本模型，只有**展示**用的 `avgRoundGrowth` 才取整。用取整值去反推轮数会在边界上差 1 轮。
  const rawAvgGrowth = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  cmp('avgRoundGrowth(A/B)', state.avgRoundGrowth, Math.round(rawAvgGrowth));
  cmp(
    'headroomRounds(A/B)',
    state.headroomRounds,
    rawAvgGrowth > 0 ? Math.floor(Math.max(0, (state.officialLine ?? 0) - state.usedTokens) / rawAvgGrowth) : null,
  );

  if (diffs.length) mismatches.push({ sid, diffs });
  else okCount += 1;
  rows.push({ sid, events: session.events.length, score: state.score, level: state.level });
}

console.log(`  会话总数 ${rows.length}（可读 ${okCount + mismatches.length}）`);
check(
  `全部 ${okCount + mismatches.length} 个会话：热路径 / 冷路径 / 离线 CLI 三者逐项一致`,
  mismatches.length === 0,
  mismatches.length ? `${mismatches.length} 个会话不一致` : '',
);
for (const m of mismatches.slice(0, 12)) {
  console.log(`      [不一致] ${m.sid.slice(0, 30)}  ${m.diffs.join('  ')}`);
}

// ── 2. 不变量（与具体实现无关的硬约束）────────────────────────────────────
console.log('\n════════ 2. 全量不变量检查 ════════');
const inv = {
  scoreRange: 0,
  levelMatch: 0,
  negativeCount: 0,
  percentRange: 0,
  capWorks: 0,
  schemaOk: 0,
};
for (const meta of sessions) {
  let session;
  try {
    session = sessionLog.readSession(meta.file);
  } catch {
    continue;
  }
  let state = def.init();
  for (const event of session.events) state = def.apply(state, event);

  if (!(state.score >= 0 && state.score <= 100)) inv.scoreRange += 1;
  const wantLevel = state.score >= 80 ? 'ok' : state.score >= 60 ? 'watch' : state.score >= 40 ? 'warn' : 'critical';
  if (state.level !== wantLevel) inv.levelMatch += 1;
  for (const k of ['usedTokens', 'repeatWorst', 'degradedReplies', 'reasoningLoop', 'reasoningFlags', 'reasoningWorstRepeat']) {
    if (!(state[k] >= 0)) inv.negativeCount += 1;
  }
  const p = state.effectivePercent;
  if (p !== null && !(p >= 0 && p <= 100)) inv.percentRange += 1;
  if (state.cap !== null && state.score > state.cap) inv.capWorks += 1;
  try {
    def.stateSchema.parse(state);
    def.wire.viewSchema.parse(def.wire.view(state));
  } catch {
    inv.schemaOk += 1;
  }
}
check('score 恒在 [0,100]', inv.scoreRange === 0, `${inv.scoreRange} 个越界`);
check('level 与 score 阈值恒一致', inv.levelMatch === 0, `${inv.levelMatch} 个不符`);
check('所有计数恒非负', inv.negativeCount === 0, `${inv.negativeCount} 个为负`);
check('有效占用百分比恒在 [0,100]', inv.percentRange === 0, `${inv.percentRange} 个越界`);
check('有损压缩封顶恒生效（score ≤ cap）', inv.capWorks === 0, `${inv.capWorks} 个越过封顶`);
check('全量 state 通过 schema 且 view 可序列化', inv.schemaOk === 0, `${inv.schemaOk} 个失败`);

// ── 3. 鲁棒性：畸形事件不得抛异常（host 插件抛异常会拖垮会话）──────────────
console.log('\n════════ 3. 鲁棒性（畸形输入不得抛异常）════════');
const nasty = [
  ['null 事件', null],
  ['undefined 事件', undefined],
  ['空对象', {}],
  ['无 type', { data: {} }],
  ['data 为 null', { type: 'assistant/message', data: null }],
  ['content 是字符串', { type: 'assistant/message', data: { message: { content: 'abc' } } }],
  ['content 含 null 项', { type: 'assistant/message', data: { message: { content: [null, 1, 'x'] } } }],
  ['text 为 null', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: null }] } } }],
  ['usage 为 null', { type: 'assistant/message', data: { usage: null, message: { content: [] } } }],
  ['usage 含 NaN', { type: 'assistant/message', data: { usage: { totalTokens: NaN, reasoningTokens: NaN }, message: { content: [] } } }],
  ['usage 只有 inputTokens=NaN', { type: 'assistant/message', data: { usage: { inputTokens: NaN }, message: { content: [] } } }],
  ['usage 含 Infinity', { type: 'assistant/message', data: { usage: { totalTokens: Infinity }, message: { content: [] } } }],
  ['usage 含 -Infinity', { type: 'assistant/message', data: { usage: { inputTokens: -Infinity }, message: { content: [] } } }],
  ['data 是字符串', { type: 'assistant/message', data: 'oops' }],
  ['contextWindow 为 NaN', { type: 'request/context', data: { contextWindow: NaN } }],
  ['contextWindow 为 Infinity', { type: 'request/context', data: { contextWindow: Infinity } }],
  ['usage 含负数', { type: 'assistant/message', data: { usage: { totalTokens: -5, reasoningTokens: -1 }, message: { content: [] } } }],
  ['compaction/summary 全 NaN', { type: 'compaction/summary', data: { shadowedTokenCount: NaN, usage: { outputTokens: NaN, inputTokens: NaN }, summary: 'x' }, time: NaN }],
  ['compaction/prune 全 NaN', { type: 'compaction/prune', data: { shadowedTokenCount: NaN }, time: NaN }],
  ['compaction summary 的 summary 是对象', { type: 'compaction/summary', data: { summary: { nope: 1 }, usage: null } }],
  ['usage 含字符串', { type: 'assistant/message', data: { usage: { totalTokens: '999', reasoningTokens: '256000' }, message: { content: [] } } }],
  ['contextWindow 为 0', { type: 'request/context', data: { contextWindow: 0 } }],
  ['contextWindow 为负', { type: 'request/context', data: { contextWindow: -1 } }],
  ['contextWindow 为字符串', { type: 'request/context', data: { contextWindow: '1M' } }],
  ['tool/call arguments 是对象', { type: 'tool/call', data: { name: 'edit', arguments: { a: 1 } } }],
  ['tool/call 无 name', { type: 'tool/call', data: {} }],
  ['未知事件类型', { type: 'wat/ever', data: { x: 1 } }],
];
let thrown = 0;
for (const [label, ev] of nasty) {
  try {
    let s = def.init();
    s = def.apply(s, ev);
    def.wire.viewSchema.parse(def.wire.view(s));
  } catch (e) {
    thrown += 1;
    console.log(`      [抛异常] ${label}: ${e.message.slice(0, 90)}`);
  }
}
check(`畸形输入 ${nasty.length} 例全部不抛异常且 view 合法`, thrown === 0, `${thrown} 例抛异常`);

// 空事件序列 / 只有 request/context
try {
  let s = def.init();
  def.wire.viewSchema.parse(def.wire.view(s));
  s = def.apply(s, { type: 'request/context', data: { contextWindow: 1000000 } });
  def.wire.viewSchema.parse(def.wire.view(s));
  check('空会话与"只有 contextWindow"的会话均可序列化', true);
} catch (e) {
  check('空会话与"只有 contextWindow"的会话均可序列化', false, e.message.slice(0, 90));
}

// ── 4. 性能：折叠代价是否随事件数线性（防止 O(n²)）────────────────────────
console.log('\n════════ 4. 性能体检（全量折叠耗时）════════');
const perf = [];
for (const meta of sessions) {
  let session;
  try {
    session = sessionLog.readSession(meta.file);
  } catch {
    continue;
  }
  const t0 = process.hrtime.bigint();
  let s = def.init();
  for (const event of session.events) s = def.apply(s, event);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  perf.push({ events: session.events.length, ms });
}
perf.sort((a, b) => a.events - b.events);
const big = perf[perf.length - 1];
const mid = perf[Math.floor(perf.length / 2)];
const perEventBig = big.events ? big.ms / big.events : 0;
const perEventMid = mid.events ? mid.ms / mid.events : 0;
console.log(`  最大会话 ${big.events} 事件 → ${big.ms.toFixed(1)} ms（${(perEventBig * 1000).toFixed(1)} µs/事件）`);
console.log(`  中位会话 ${mid.events} 事件 → ${mid.ms.toFixed(1)} ms（${(perEventMid * 1000).toFixed(1)} µs/事件）`);
check(
  '单位事件耗时没有随规模显著劣化（无 O(n²) 迹象）',
  perEventBig <= perEventMid * 4 + 5,
  `大 ${(perEventBig * 1000).toFixed(1)} µs/事件 vs 中位 ${(perEventMid * 1000).toFixed(1)} µs/事件`,
);
check(`最大真实会话折叠 < 2 秒（实测 ${big.ms.toFixed(0)} ms）`, big.ms < 2000);

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
process.exit(fail > 0 ? 1 : 0);
