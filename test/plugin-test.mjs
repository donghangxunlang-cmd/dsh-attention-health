/**
 * attention-health 插件测试。
 *
 * 目标：在**挂载到运行中的 DSH 之前**证明插件不会崩，且检测结果与离线版一致。
 *
 * 注意：插件实体从 $DSH_HOME/profiles/web/ 加载（那里才能解析 zod），
 * 离线模块从本项目加载。
 *
 * 运行：node test/plugin-test.mjs
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listSessions, readSession } from '../lib/session-log.mjs';
import { analyzeSession } from '../lib/detect.mjs';

// 部署目录可用环境变量覆盖（2026-09-18 标准包化）：
// 门 2 的临时 profile 实验就是靠它把五套自测指向"刚装进去的那份"，
// 而不是"当前 web profile 里那份"。默认值 = 本机现役的旧形态部署目录。
const pluginDir =
  process.env.DSH_ATTENTION_HEALTH_DIR ??
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'attention-health');
const pluginPath = path.join(pluginDir, 'index.js');

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

console.log('════════ 1. 加载插件 ════════');
const plugin = await import(pathToFileURL(pluginPath).href);
// 退化判据的唯一实现所在处（用于交叉比对）
const hf = await import(pathToFileURL(path.join(path.dirname(pluginPath), 'handoff.js')).href);
check('导出 apply', typeof plugin.apply === 'function');
check('导出 name', plugin.name === 'attention-health', String(plugin.name));
check('导出 inject', Array.isArray(plugin.inject) && plugin.inject.includes('sessionProjections'));

console.log('\n════════ 2. 注册投影 ════════');
const registry = [];
// 路由注册改用 cordis 的 ctx.inject（等服务就绪的回调）。
// 这里模拟「webServer 尚未就绪」—— inject 回调不执行，验证投影注册完全不受影响。
const mockCtx = {
  sessionProjections: { register: (def) => registry.push(def) },
  get: () => undefined,
  effect: () => () => {},
  inject: () => {},
};
plugin.apply(mockCtx);
check('注册了恰好 1 个投影', registry.length === 1, `实际 ${registry.length}`);

const def = registry[0];
check('key 正确', def.key === 'attentionHealth', String(def.key));
check('stateVersion 是正整数', Number.isInteger(def.stateVersion) && def.stateVersion > 0);
check('有 stateSchema.parse', typeof def.stateSchema?.parse === 'function');
check('有 wire.viewSchema.parse', typeof def.wire?.viewSchema?.parse === 'function');
check('有 wire.view', typeof def.wire?.view === 'function');

// ── AG（2026-09-22）：`final.advice` 取值的**单一来源**守卫 ────────────────────
// 这个取值曾在两处各写一份（判定链的 `finalText` vs `viewSchema` 手写枚举），
// AG 新增 `costNote` 时就脱节了。漏一档的后果**不是"那一档降级"，而是整条 view 校验失败**；
// 而它在真实语料上触发 0 次（`work/ag-gradient-scan.mjs` 实测 82 个会话），
// 测试与线上都看不出来 —— 只有真出现一个"省额很小"的会话才会炸。
// 现在 schema 直接引用 `ADVICE_VALUES`，这条守卫负责"以后别再手写回去"。
{
  const advSchema = def.wire.viewSchema.shape.compactAdvice;
  const enumValues = advSchema?.options ?? advSchema?._def?.values ?? [];
  const values = hf.ADVICE_VALUES;
  check(
    'AG：viewSchema 的 compactAdvice 引用 ADVICE_VALUES（不再手写第二份清单）',
    Array.isArray(values) &&
      values.length > 0 &&
      enumValues.length === values.length &&
      values.every((v) => enumValues.includes(v)),
    `enum=${JSON.stringify(enumValues)} / ADVICE_VALUES=${JSON.stringify(values)}`,
  );
  check(
    'AG：`costNote`（新增最轻档）在 wire 契约里 —— 漏了会让整条 view 校验失败',
    enumValues.includes('costNote') && Array.isArray(values) && values.includes('costNote'),
    JSON.stringify(enumValues),
  );
}

// ── 实时思考守卫：中止原因必须被正确识别（2026-09-16 用户新增）──
// host 侧 `agent.cancel({ kind:'hook', reason })` 会把原因写进 `turn/end` 的 aborted reason，
// 投影据此把它记成"插件主动止损"，界面才能显示确切原因。
{
  const GUARD_REASON = 'attention-health：思考空转 —— 同一行连续重复 12 次';
  let s = def.init();
  s = def.apply(s, { type: 'turn/start', data: { turn: 1 } });
  s = def.apply(s, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: GUARD_REASON } } },
  });
  check('守卫中止被计入 guardTripCount', s.guardTripCount === 1, String(s.guardTripCount));
  check(
    '守卫中止原因被保存且剥掉插件前缀',
    s.lastGuardReason === '思考空转 —— 同一行连续重复 12 次',
    String(s.lastGuardReason),
  );
  check('守卫中止的轮次被记录', s.lastGuardTurn === 1, String(s.lastGuardTurn));
  check('view 暴露 guardTripCount / lastGuardReason 供界面显示', (() => {
    const v = def.wire.view(s);
    return v.guardTripCount === 1 && typeof v.lastGuardReason === 'string';
  })());
}
{
  // 用户主动中止（kind:'user'）不得被算成守卫中止 —— 否则界面会谎称"插件帮你停了"
  let s = def.init();
  s = def.apply(s, { type: 'turn/start', data: { turn: 1 } });
  s = def.apply(s, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });
  check('用户主动中止不计入守卫中止', s.guardTripCount === 0, String(s.guardTripCount));
  check('用户主动中止不写 lastGuardReason', s.lastGuardReason === null, String(s.lastGuardReason));
}

// ── 异常现场明细 degradedSamples（2026-09-18 H.8）──
// 用户诉求："点击异常提醒，能看看出问题的地方长什么样"。
// 真跳转（滚动到聊天流对应消息并高亮）DSH **没有**公开 API，所以做的是**就地展开**：
// host 采集「轮次 + 摘录」→ wire 下发 → 界面列出（点击看原文）。
{
  // 思考打转：30 行里 28 行是同一句（重复率 0.93 ≥ 判据 0.7，且行数 ≥ 判据 30）
  const loopLines = ['开头是像模像样的分析'];
  for (let i = 0; i < 28; i += 1) loopLines.push('做。');
  loopLines.push('结尾也想收一下');

  let s = def.init();
  s = def.apply(s, { type: 'turn/start', data: { turn: 7 } });
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 7,
      usage: { totalTokens: 1000 },
      message: { content: [{ type: 'reasoning', text: loopLines.join('\n') }] },
    },
  });

  const sample = s.degradedSamples?.[0] ?? {};
  check(
    '思考打转 → 留下一条现场明细',
    s.degradedSamples.length === 1,
    JSON.stringify(s.degradedSamples).slice(0, 140),
  );
  check('现场明细带轮次（取自事件的 data.turn）', sample.turn === 7, String(sample.turn));
  check('现场明细类型是 reasoning', sample.kind === 'reasoning', String(sample.kind));
  check(
    '摘录从复读起点开始，而不是块开头',
    typeof sample.excerpt === 'string' && !sample.excerpt.startsWith('开头是像模像样的分析'),
    String(sample.excerpt).slice(0, 40),
  );
  check(
    '摘录是单行且 ≤200 字符',
    typeof sample.excerpt === 'string' &&
      !/[\r\n]/.test(sample.excerpt) &&
      sample.excerpt.length <= 200,
    `长度 ${sample.excerpt?.length}`,
  );
  check(
    'view 下发 degradedSamples 供界面显示',
    Array.isArray(def.wire.view(s).degradedSamples) && def.wire.view(s).degradedSamples.length === 1,
  );
  let schemaOk = true;
  try {
    def.stateSchema.parse(s);
  } catch {
    schemaOk = false;
  }
  check('含现场明细的 state 仍通过 schema', schemaOk);
}
{
  // 输出退化（同一行连续重复 3 次）→ reply 现场，摘录就是回复原文
  let s = def.init();
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 3,
      usage: { totalTokens: 500 },
      message: {
        content: [{ type: 'text', text: ['这是同一句话。', '这是同一句话。', '这是同一句话。'].join('\n') }],
      },
    },
  });
  check(
    '输出退化 → 留下 reply 现场',
    s.degradedSamples.length === 1 && s.degradedSamples[0].kind === 'reply',
    JSON.stringify(s.degradedSamples).slice(0, 140),
  );
  check(
    'reply 现场摘录是回复原文',
    String(s.degradedSamples[0]?.excerpt).includes('这是同一句话。'),
    String(s.degradedSamples[0]?.excerpt),
  );
}
{
  // 守卫中止 → guard 现场。
  // ⚠️ 摘录是**守卫的判定描述**（含被复读的那一行），不是思考原文 —— 守卫在流式
  //    生成过程中就中止了，原文片段在 turn/end 时已拿不到（结构性限制，见实现注释）。
  const GUARD_REASON = 'attention-health：思考空转 —— 最近 60 个短行里有 32 行是「做。」';
  let s = def.init();
  s = def.apply(s, { type: 'turn/start', data: { turn: 9 } });
  s = def.apply(s, {
    type: 'turn/end',
    data: { turn: 9, reason: { kind: 'aborted', reason: { kind: 'hook', reason: GUARD_REASON } } },
  });
  check(
    '守卫中止 → 留下 guard 现场',
    s.degradedSamples.length === 1 && s.degradedSamples[0].kind === 'guard',
    JSON.stringify(s.degradedSamples).slice(0, 140),
  );
  check('guard 现场带轮次', s.degradedSamples[0]?.turn === 9, String(s.degradedSamples[0]?.turn));
  check(
    'guard 现场摘录剥掉插件前缀且保留现场描述',
    String(s.degradedSamples[0]?.excerpt).startsWith('思考空转') &&
      String(s.degradedSamples[0]?.excerpt).includes('做。'),
    String(s.degradedSamples[0]?.excerpt),
  );
}
{
  // 反例：正常消息**不产生**现场明细，且必须保持同一引用
  // （`foldEvent` 靠引用相等做 unchanged 早退，这里新建数组必须是"真的变了"）
  let s = def.init();
  const before = s.degradedSamples;
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 1,
      usage: { totalTokens: 900 },
      message: { content: [{ type: 'text', text: '正常回复，没有任何退化特征。' }] },
    },
  });
  check('正常消息不产生现场明细', s.degradedSamples.length === 0, JSON.stringify(s.degradedSamples));
  check('无命中时保持同一引用（unchanged 早退）', s.degradedSamples === before);
}
{
  // 上限与去重：一个轮次里可能有几十条 assistant/message，
  // 不去重的话 5 个名额会全被同一轮占满，别的轮次全看不见。
  let s = def.init();
  const badAt = (turn) => ({
    type: 'assistant/message',
    data: {
      turn,
      usage: { totalTokens: 100 * turn },
      message: { content: [{ type: 'text', text: ['重复的话。', '重复的话。', '重复的话。'].join('\n') }] },
    },
  });
  for (let turn = 1; turn <= 8; turn += 1) s = def.apply(s, badAt(turn));
  check('现场明细最多保留 5 条', s.degradedSamples.length === 5, String(s.degradedSamples.length));
  check(
    '保留的是最近 5 个轮次',
    s.degradedSamples.map((x) => x.turn).join(',') === '4,5,6,7,8',
    s.degradedSamples.map((x) => x.turn).join(','),
  );

  const beforeLen = s.degradedSamples.length;
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 8,
      usage: { totalTokens: 9999 },
      message: { content: [{ type: 'text', text: ['换了一句话。', '换了一句话。', '换了一句话。'].join('\n') }] },
    },
  });
  check('同一轮同类再命中 → 覆盖而不是新增', s.degradedSamples.length === beforeLen, `${beforeLen} → ${s.degradedSamples.length}`);
  const last = s.degradedSamples[s.degradedSamples.length - 1];
  check('覆盖后摘录更新为新现场', String(last?.excerpt).includes('换了一句话。'), String(last?.excerpt));
  check('覆盖不改变该条的轮次', last?.turn === 8, String(last?.turn));
}
{
  // 边界：事件没带 turn → 记 0（"轮次未知"），**不拿别的数字顶上**
  let s = def.init();
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      usage: { totalTokens: 300 },
      message: {
        content: [{ type: 'text', text: ['未知轮次的重复。', '未知轮次的重复。', '未知轮次的重复。'].join('\n') }],
      },
    },
  });
  check('事件缺 turn → 轮次记 0（未知），不编造', s.degradedSamples[0]?.turn === 0, String(s.degradedSamples[0]?.turn));
}
{
  // 一条消息同时命中思考与输出退化 → 两条现场（各自的名额互不挤占）
  let s = def.init();
  const loopLines = [];
  for (let i = 0; i < 28; i += 1) loopLines.push('打转中的同一行');
  loopLines.push('收尾');
  loopLines.push('再收尾');
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 4,
      usage: { totalTokens: 800 },
      message: {
        content: [
          { type: 'reasoning', text: loopLines.join('\n') },
          { type: 'text', text: ['同一段话。', '同一段话。', '同一段话。'].join('\n') },
        ],
      },
    },
  });
  const kinds = s.degradedSamples.map((x) => x.kind).sort().join(',');
  check('同一轮同时命中思考与输出 → 两条现场', kinds === 'reasoning,reply', kinds);
}

// ── W 节（2026-09-18 用户拍板）：**无异常即静默** ────────────────────────────
//
// 修改前 `shouldNotify = level !== 'ok' || advice !== 'continue'` —— 规模偏大就常亮。
// 但"上下文过大"本身没有行动价值（手动压缩在钱上摊不回来、自动压缩官方自己会做、
// 交接要么有退化要么过成本门槛），还会**稀释真正的信号**。
// 现在只有"有退化 / 守卫"或"有行动建议"才打扰用户；规模只作展开区的背景信息。
{
  // ① 规模很大、但无退化、无建议 → 静默
  let s = def.init();
  s = def.apply(s, { type: 'request/context', data: { contextWindow: 1000000 } });
  s = def.apply(s, {
    type: 'assistant/message',
    data: { turn: 1, usage: { totalTokens: 700000 }, message: { content: [{ type: 'text', text: '正常回复，没有退化特征。' }] } },
  });
  check(
    'W：规模很大但无退化、无建议 → 不打扰（shouldNotify=false）',
    s.shouldNotify === false,
    `level=${s.level} advice=${s.compactAdvice} shouldNotify=${s.shouldNotify}`,
  );
  check(
    'W：但规模信息仍在（展开区可见，只是默认不打扰）',
    s.level !== 'ok' && s.usedTokens === 700000,
    `${s.level} / ${s.usedTokens}`,
  );
}
{
  // ② 守卫掐断过 → 打扰
  let s = def.init();
  s = def.apply(s, { type: 'turn/start', data: { turn: 1 } });
  s = def.apply(s, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'attention-health：思考空转 —— 测试' } } },
  });
  check('W：守卫掐断过 → 打扰（shouldNotify=true）', s.shouldNotify === true, String(s.shouldNotify));
}
{
  // ③ 思考打转 → 打扰
  const loop = ['开头'].concat(Array.from({ length: 28 }, () => '做。')).concat(['收尾', '再收尾']).join('\n');
  let s = def.init();
  s = def.apply(s, {
    type: 'assistant/message',
    data: { turn: 1, usage: { totalTokens: 50000 }, message: { content: [{ type: 'reasoning', text: loop }] } },
  });
  check('W：思考打转 → 打扰（shouldNotify=true）', s.shouldNotify === true, String(s.shouldNotify));
}
{
  // ④ 正常小会话 → 静默
  let s = def.init();
  s = def.apply(s, {
    type: 'assistant/message',
    data: { turn: 1, usage: { totalTokens: 5000 }, message: { content: [{ type: 'text', text: '正常。' }] } },
  });
  check('W：正常会话 → 静默（shouldNotify=false）', s.shouldNotify === false, String(s.shouldNotify));
}

console.log('\n════════ 3. 初始状态与 schema ════════');
const init = def.init();
check('init 返回对象', init && typeof init === 'object');
try {
  def.stateSchema.parse(init);
  check('stateSchema.parse(init) 通过', true);
} catch (e) {
  check('stateSchema.parse(init) 通过', false, e.message.slice(0, 160));
}
try {
  def.wire.viewSchema.parse(def.wire.view(init));
  check('viewSchema.parse(view(init)) 通过（内部字段已剥离）', true);
} catch (e) {
  check('viewSchema.parse(view(init)) 通过（内部字段已剥离）', false, e.message.slice(0, 160));
}

// O1（2026-09-16 Codex 审查建议）：**键集合必须完全一致**。
// 本项目加一个 wire 字段要改三处（viewSchema 声明 + finalize 赋值 + view() 序列化），
// 本轮就漏过 `view()`：schema 断言只说"解析失败"，不告诉你少了哪个键。
// 这条断言直接把缺失/多余的键名打出来。
{
  const schemaKeys = Object.keys(def.wire.viewSchema.shape ?? {}).sort();
  const viewKeys = Object.keys(def.wire.view(init)).sort();
  const missing = schemaKeys.filter((k) => !viewKeys.includes(k));
  const extra = viewKeys.filter((k) => !schemaKeys.includes(k));
  check(
    `wire 契约键集合一致（schema ${schemaKeys.length} 键 = view ${viewKeys.length} 键）`,
    missing.length === 0 && extra.length === 0,
    `schema 有而 view 缺：[${missing.join(', ')}]；view 有而 schema 无：[${extra.join(', ')}]`,
  );
}

console.log('\n════════ 4. 折叠契约 ════════');
const unrelated = { type: 'some/unrelated-event', data: { foo: 1 } };
check('无关事件返回同一引用', def.apply(init, unrelated) === init);
check('null 事件安全', def.apply(init, {}) === init);
const toolA = { type: 'tool/call', data: { name: 'grep', arguments: '{"pattern":"x"}' } };
const s1 = def.apply(init, toolA);
const s2 = def.apply(s1, toolA);
const s3 = def.apply(s2, toolA);
check('连续 3 次相同调用 → repeatWorst = 3', s3.repeatWorst === 3, String(s3.repeatWorst));
check('换一个调用后 streak 重置为 1', def.apply(s3, { type: 'tool/call', data: { name: 'read', arguments: '{}' } }).callStreak === 1);

console.log('\n════════ 5. 真实会话回放（对比离线版） ════════');
const sessions = listSessions();
const targets = sessions.slice(0, 6);
let mismatch = 0;
/** H.8：回放会话里产生的异常明细总数（用于确认真实数据上确实采得到）。 */
let sampleTotal = 0;

console.log('  会话                        事件   插件token   离线token  插件分 离线分  等级');
for (const s of targets) {
  const session = readSession(s.file);

  // 插件折叠
  let state = def.init();
  for (const event of session.events) state = def.apply(state, event);

  // schema 必须通过，否则 DSH 会报错
  let schemaOk = true;
  let schemaErr = '';
  let viewNow;
  try {
    def.stateSchema.parse(state);
    viewNow = def.wire.view(state);
    def.wire.viewSchema.parse(viewNow);
  } catch (e) {
    schemaOk = false;
    schemaErr = e.message.slice(0, 120);
  }

  // H.8：异常现场明细必须与退化计数**自洽** ——
  //   · 有退化却无明细 = 用户点了却看不到东西；
  //   · 无退化却有明细 = 凭空产生现场（"每条结论都要有证据"的反面）。
  // 这两条是"就地展开"的正确性底线，所以放进每次部署都要跑的真实会话回放里把关。
  const viewSamples = Array.isArray(viewNow?.degradedSamples) ? viewNow.degradedSamples : [];
  const degradedTotal =
    (viewNow?.reasoningLoop ?? 0) +
    (viewNow?.reasoningFlags ?? 0) +
    (viewNow?.degradedReplies ?? 0) +
    (viewNow?.guardTripCount ?? 0);
  const sampleIssues = [];
  if (viewSamples.length > 0 && degradedTotal === 0) sampleIssues.push('无退化却有明细');
  if (viewSamples.length === 0 && degradedTotal > 0) sampleIssues.push('有退化却无明细');
  for (const sample of viewSamples) {
    if (sample.excerpt.length > 200) sampleIssues.push('摘录超 200 字符');
    if (/[\r\n]/.test(sample.excerpt)) sampleIssues.push('摘录含换行');
  }
  if (sampleIssues.length) mismatch += 1;
  sampleTotal += viewSamples.length;

  // 离线版
  const offline = analyzeSession(session);

  // 2026-09-15 复核：原先只比 `usedTokens` 与 `score`，于是**"重复工具调用次数"两处口径
  // 分叉**（投影说 1 次、离线说 0 次）长期没被发现。等级与退化计数一并纳入比对。
  const pairs = [
    ['usedTokens', state.usedTokens, offline.context.usedTokens],
    ['score', state.score, offline.score],
    ['level', state.level, offline.level],
    ['repeatWorst', state.repeatWorst, offline.repeats.worst],
    ['degradedReplies', state.degradedReplies, offline.degradation.count],
    ['reasoningLoop', state.reasoningLoop, offline.degradation.reasoningLoop],
    ['reasoningFlags', state.reasoningFlags, offline.degradation.reasoningFlags],
    ['reasoningWorstRepeat', state.reasoningWorstRepeat, offline.degradation.reasoningWorstRepeat],
  ];
  const bad = pairs.filter(([, a, b]) => a !== b);
  if (!schemaOk || bad.length) mismatch += 1;

  console.log(
    `  ${s.id.slice(0, 24).padEnd(26)} ${String(session.events.length).padStart(5)} ` +
      `${String(state.usedTokens).padStart(10)} ${String(offline.context.usedTokens).padStart(10)} ` +
      `${String(state.score).padStart(6)} ${String(offline.score).padStart(6)}  ${state.level}`,
  );
  if (!schemaOk) console.log(`      ⚠️ schema 失败: ${schemaErr}`);
  if (bad.length) {
    console.log(`      ⚠️ 口径不一致：${bad.map(([n, a, b]) => `${n}[插件=${a} 离线=${b}]`).join(' ')}`);
  }
  if (sampleIssues.length) {
    console.log(`      ⚠️ 异常现场明细不自洽：${sampleIssues.join(' ')}`);
  }
}

check(`全部 ${targets.length} 个会话：schema 通过 且 与离线版一致`, mismatch === 0, `${mismatch} 个不一致`);
console.log(`  异常现场明细合计 ${sampleTotal} 条（H.8：只有真有退化的会话才该有）`);

console.log('\n════════ 6. 边界情况 ════════');
const emptyFold = def.init();
check('空 init 的 findings 为空数组', Array.isArray(emptyFold.findings) && emptyFold.findings.length === 0);
check('空 init 的 score = 100', emptyFold.score === 100);

const noUsage = def.apply(init, { type: 'assistant/message', data: { message: { content: [] } } });
check('assistant/message 缺 usage 不崩', noUsage && typeof noUsage.score === 'number');

// ── 6b. 加固回归（2026-09-15 复核：多功能求证挖出的两类真实崩溃）────────────
// 依据：host 插件里一次未捕获异常可能连累整个投影（历史上 REQUEST_EXTENSION
// 就是这样把每一轮请求都打断的）。以下都是当时**真的会抛/会产出非法 state** 的输入。
check('null 事件原样返回（不抛异常）', def.apply(init, null) === init);
check('undefined 事件原样返回', def.apply(init, undefined) === init);
check('非对象事件原样返回', def.apply(init, 42) === init);
check('无 type 的对象事件原样返回', def.apply(init, {}) === init);
check('data 为 null 不崩', def.apply(init, { type: 'assistant/message', data: null }) !== undefined);
const cwZero = def.apply(init, { type: 'request/context', data: { contextWindow: 0 } });
check('contextWindow 为 0 不污染状态（否则投影 schema 校验失败）', cwZero.contextWindow === null);
check(
  'contextWindow 为负 / NaN / Infinity 均不污染状态',
  def.apply(init, { type: 'request/context', data: { contextWindow: -5 } }).contextWindow === null &&
    def.apply(init, { type: 'request/context', data: { contextWindow: NaN } }).contextWindow === null &&
    def.apply(init, { type: 'request/context', data: { contextWindow: Infinity } }).contextWindow === null,
);
const nanUsage = def.apply(init, {
  type: 'assistant/message',
  data: { usage: { inputTokens: NaN }, message: { content: [] } },
});
check('usage 为 NaN 不产生非法 state', Number.isFinite(nanUsage.usedTokens));
const infUsage = def.apply(init, {
  type: 'assistant/message',
  data: { usage: { totalTokens: Infinity }, message: { content: [] } },
});
check('usage 为 Infinity 不产生非法 state', Number.isFinite(infUsage.usedTokens));
try {
  def.stateSchema.parse(cwZero);
  def.stateSchema.parse(nanUsage);
  def.stateSchema.parse(infUsage);
  check('上述加固后的 state 全部通过 schema', true);
} catch (e) {
  check('上述加固后的 state 全部通过 schema', false, e.message.slice(0, 100));
}

const badUsage = def.apply(init, {
  type: 'assistant/message',
  data: { usage: { inputTokens: 142, cacheReadTokens: 258944, outputTokens: 110, totalTokens: 259196 } },
});
check(
  '正确使用 totalTokens（而非 inputTokens）',
  badUsage.usedTokens === 259196,
  `实际 ${badUsage.usedTokens}`,
);

const ctxEv = def.apply(init, { type: 'request/context', data: { contextWindow: 1000000 } });
check('request/context 记录窗口', ctxEv.contextWindow === 1000000);

const big = def.apply(ctxEv, {
  type: 'assistant/message',
  data: { usage: { totalTokens: 750000 }, message: { content: [] } },
});
check(
  '75 万 / 100 万窗口 → 有效占用夹到 100%（75% × 1/0.6 = 125%）',
  Math.round(big.effectivePercent) === 100,
  `实际 ${big.effectivePercent}`,
);
check('75 万在有效窗口下判为 critical', big.level === 'critical', `实际 ${big.level}`);

// ── 口径一致性（2026-09-15 用户实测截图反馈）──
// 等级/规模文案**不得自带行动建议**，否则会出现"上面劝交接、下面劝压缩"的自相矛盾。
// 行动建议的唯一来源是双维度结论（compactAdvice）。
// 2026-09-16 边界设定：质量维度只在**同时检出退化信号**时才给交接结论，所以
// 这里用 50% 声明窗口（= 有效 83%，已进"偏大区"）来验证"无退化 → 不催交接"。
const nearLimit = def.apply(ctxEv, {
  type: 'assistant/message',
  data: { usage: { totalTokens: 500000 }, message: { content: [] } },
});
check(
  '有效 83% / 无退化 → findings 不出现「建议交接」',
  !nearLimit.findings.some((f) => String(f).includes('建议交接')),
  JSON.stringify(nearLimit.findings),
);
check(
  '有效 83% / 无退化 → findings 说明未检出退化信号',
  nearLimit.findings.some((f) => String(f).includes('未检出退化信号')),
  JSON.stringify(nearLimit.findings),
);
check(
  '有效 83% / 无退化 / 距官方线尚远 → 继续（压缩已退出行动域）',
  nearLimit.compactAdvice === 'continue' && nearLimit.compactAdviceText.includes('无需交接'),
  `${nearLimit.compactAdvice} / ${nearLimit.compactAdviceText}`,
);

// 对照（2026-09-16 用户反馈后细化）：判据不是"离官方线越近越该压"，而是要
// **回本能在官方线之前兑现**：`breakEvenRounds <= headroomRounds < compactDeferMinRounds`。
// 这里造 avgGrowth = 10,000 → 距官方线 140,000/10,000 = 14 轮（回本约 2 轮）→ 该建议压缩。
// 注意必须给出**轮次边界**（turn/start、turn/end）：增长按轮结算，与交接文档同口径。
const fastGrowth = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, usage: { totalTokens: 650000 }, message: { content: [] } } },
  { type: 'turn/end', data: { turn: 1 } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'assistant/message', data: { turn: 2, usage: { totalTokens: 660000 }, message: { content: [] } } },
  { type: 'turn/end', data: { turn: 2 } },
].reduce((s, e) => def.apply(s, e), ctxEv);
check(
  '对照：真实价格下"压缩在官方线前摊不完"→ 继续（2026-09-16 接入实际价后结论变了）',
  fastGrowth.compactAdvice === 'continue',
  `${fastGrowth.compactAdvice} / headroomRounds=${fastGrowth.headroomRounds} / avgGrowth=${fastGrowth.avgRoundGrowth}`,
);

let degradedState = ctxEv;
for (const i of [1, 2, 3]) {
  degradedState = def.apply(degradedState, {
    type: 'tool/call',
    data: { turn: 1, name: 'read', callId: 'c' + i, arguments: '{"file_path":"E:/x.txt"}' },
  });
}
degradedState = def.apply(degradedState, {
  type: 'assistant/message',
  data: { usage: { totalTokens: 500000 }, message: { content: [] } },
});
check(
  '有效 83% / 有退化 → findings 指出退化信号',
  degradedState.findings.some((f) => String(f).includes('退化')),
  JSON.stringify(degradedState.findings),
);
check(
  '有效 83% / 有退化 → 最终建议改为交接',
  degradedState.compactAdvice === 'handoff',
  `实际 ${degradedState.compactAdvice}`,
);

// ── 退化判据必须**全项目唯一**（2026-09-15 审查修复；N-5 起含思考判据）──
// 原来投影与交接折叠各有一份实现（5 条 vs 3 条），热会话与冷会话的退化计数会不一致，
// 交接文档里的健康度可能与当时看到的提示条自相矛盾。
//
// N-5（2026-09-15 全量复核）删掉了「中英严重混杂」—— 全量 73 会话里它触发 25 次、
// **25/25 全是误报**。所以 mixedText 从"正例"变成**反例**：两处都必须判正常。
const mixedText = 'This is a mostly English paragraph with 少量中文 inside it, '.repeat(8) + 'end.';
const symLong = '这是一段回复文字，后面接一串符号：' + '★☆●▲■◆○◇□※'.repeat(3) + '以此结尾。';
// 思考打转的真实事故形态（session-SAMPLE-bfd2b142：同一行反复 6.9 万次）
const loopThink = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? '好。' : '执行。')).join('\n');

const contentOf = (text, kind) =>
  kind === 'reasoning' ? [{ type: 'reasoning', text }] : [{ type: 'text', text }];

/** 走**日志折叠**（冷会话）路径取某个计数字段。 */
const foldCount = (text, kind, field) =>
  hf.foldSession([
    {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        message: { content: contentOf(text, kind) },
        usage: { totalTokens: 1000, outputTokens: 10 },
      },
    },
  ])[field];

/** 走**投影**（热会话）路径取同一个计数字段。 */
const projectCount = (text, kind, field) =>
  def.apply(def.init(), {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: { content: contentOf(text, kind) },
      usage: { totalTokens: 1000, outputTokens: 10 },
    },
  })[field];

for (const [name, text, kind, field] of [
  ['输出退化·符号堆砌', symLong, 'text', 'degradedReplies'],
  ['思考打转（N-5）', loopThink, 'reasoning', 'reasoningLoop'],
]) {
  const viaProjection = projectCount(text, kind, field);
  const viaFold = foldCount(text, kind, field);
  check(`退化判据一致｜${name}`, viaProjection === viaFold, `投影 ${viaProjection} / 折叠 ${viaFold}`);
}
check(
  '退化判据｜符号堆砌两处都检出',
  projectCount(symLong, 'text', 'degradedReplies') === 1 && foldCount(symLong, 'text', 'degradedReplies') === 1,
);
check(
  'N-5｜中英混杂两处都**不**再检出（该判据 25/25 全误报，已删除）',
  mixedText.length > 400 &&
    projectCount(mixedText, 'text', 'degradedReplies') === 0 &&
    foldCount(mixedText, 'text', 'degradedReplies') === 0,
  `投影 ${projectCount(mixedText, 'text', 'degradedReplies')} / 折叠 ${foldCount(mixedText, 'text', 'degradedReplies')}`,
);
check(
  'N-5｜思考打转两处都检出',
  projectCount(loopThink, 'reasoning', 'reasoningLoop') === 1 &&
    foldCount(loopThink, 'reasoning', 'reasoningLoop') === 1,
);
check(
  'N-5｜思考异常不影响输出退化计数（两类信号分开计）',
  projectCount(loopThink, 'reasoning', 'degradedReplies') === 0,
);
const thinkState = def.apply(def.init(), {
  type: 'assistant/message',
  data: {
    turn: 1,
    message: { content: [{ type: 'reasoning', text: loopThink }] },
    usage: { totalTokens: 1000, outputTokens: 10 },
  },
});
check('N-5｜投影广播思考退化字段', thinkState.reasoningLoop === 1 && Array.isArray(thinkState.reasoningReasons));
check(
  'N-5｜思考退化的命中原因带中文标签（提示条要显示）',
  thinkState.reasoningReasons.some((r) => r.key === 'thinkLoop' && r.label === '思考打转'),
  JSON.stringify(thinkState.reasoningReasons),
);
check(
  'N-5｜思考打转参与评分（findings 里能看到）',
  thinkState.findings.some((f) => f.includes('打转')),
  thinkState.findings.join(' | '),
);

// ── 2026-09-18 修复的回归保护：思考退化信号必须同时进「评分」与「判定链」──
// 现场：有效占用 100% + 思考打转 7 次，被判成「可以继续」。
// 根因：`deriveCompactionPlan()` 的调用**漏传** reasoningLoop / reasoningFlags，
// 而**相邻的** `scoreContextHealth()` 传了 —— 于是评分照扣 −50，判定链完全看不见。
// 两个调用相邻且形似，grep 会先命中上面那个，造成"已经传了"的错觉。
// 这条断言同时要求"评分看到"与"判定也看到"，堵住只改一处的可能。
{
  let s = def.init();
  s = def.apply(s, { type: 'request/context', data: { contextWindow: 1000000 } });
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 1,
      // 700k /（1000k × 0.6）= 117% → 有效占用封顶 100%，跨过「立即新开」的 90% 线
      usage: { totalTokens: 700000, inputTokens: 7000, cacheReadTokens: 693000, outputTokens: 100 },
      message: { content: [{ type: 'reasoning', text: loopThink }] },
    },
  });
  check(
    '回归｜思考打转必须同时进「评分」与「判定链」（不能只进评分）',
    s.reasoningLoop === 1 &&
      s.findings.some((f) => f.includes('打转')) &&
      s.qualityAdvice !== 'continue',
    `reasoningLoop=${s.reasoningLoop} effectivePercent=${s.effectivePercent} ` +
      `qualityAdvice=${s.qualityAdvice} compactAdvice=${s.compactAdvice}`,
  );
}

console.log('\n════════ 7. 交接生成路由（webServer 可用时） ════════');
// 路由成功会写一条**交接历史**（2026-09-15 复核 N-6）。测试不该污染真实历史文件，
// 所以把 DSH_HOME 临时指到临时目录 —— `history.js` 在调用时才读该环境变量。
const realDshHome = process.env.DSH_HOME;
const testDshHome = path.join(os.tmpdir(), `ah-route-${Date.now()}`);
process.env.DSH_HOME = testDshHome;

const routes = [];
const fakeEvents = [
  { type: 'session/title', data: { title: '路由测试会话' } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这件事做完' }] } },
  { type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{"file_path":"E:/tmp/a.js"}' } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
const fakeSession = { header: { id: 'session-route-test', cwd: 'E:/tmp' }, snapshotEvents: () => fakeEvents };
const fakeHealth = {
  score: 62,
  level: 'warn',
  usedTokens: 300000,
  contextWindow: 1000000,
  effectivePercent: 60,
  windowPercent: 30,
  repeatWorst: 0,
  degradedReplies: 0,
  findings: ['演示用发现'],
};

const injectedDeps = [];
const routeCtx = {
  sessionProjections: {
    register: () => {},
    stateOf: (_session, key) => (key === 'attentionHealth' ? fakeHealth : undefined),
  },
  // webServer **只通过 inject 暴露**：get('webServer') 故意返回 undefined，
  // 以此守住"不能退回一次性 ctx.get"这条线（那正是加载顺序丢路由的原因）。
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === 'session-route-test' ? fakeSession : undefined) };
    // 真实 ctx.get 会拿到已注册的服务；handler 正是这样取健康度的
    if (name === 'sessionProjections') return routeCtx.sessionProjections;
    return undefined; // sessionQuery 等不可用
  },
  effect: (cb) => { cb(); return () => {}; },
  inject: (deps, callback) => {
    injectedDeps.push(...[].concat(deps));
    callback(routeCtx);
    return { dispose: () => {} };
  },
};
plugin.apply(routeCtx);

check(
  '通过 ctx.inject 等待 webServer（而非一次性 ctx.get）',
  injectedDeps.includes('webServer'),
  injectedDeps.join(', '),
);
check('注册了 1 条路由', routes.length === 1, `实际 ${routes.length}`);
check(
  '路由为 prefix + /attention-health',
  routes[0]?.kind === 'prefix' && routes[0]?.path === '/attention-health',
  JSON.stringify({ kind: routes[0]?.kind, path: routes[0]?.path }),
);

const makeRes = () => ({
  status: 0,
  headers: null,
  body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
});

const handler = routes[0].handler;

// 请求夹具：默认带 loopback Host **与 loopback 连接来源**（真实浏览器 / curl /
// 自动验证脚本两者都成立），需要测鉴权时再覆盖单个头或来源地址。
// Z.3 起 `isTrustedHandoffRequest` 还会看 `socket.remoteAddress` —— 夹具漏了它，
// 所有"应当放行"的用例都会假失败（或反过来掩盖真问题）。
const req = (url, headers = {}, remoteAddress = '127.0.0.1') => ({
  url,
  headers: { host: '127.0.0.1:3080', ...headers },
  socket: { remoteAddress },
});

const okRes = makeRes();
await handler(req('/attention-health/handoff?sessionId=session-route-test'), okRes);
check('正常请求返回 200', okRes.status === 200, `实际 ${okRes.status}`);
let payload = null;
try { payload = JSON.parse(okRes.body); } catch { /* 下面按 null 处理 */ }
check('返回合法 JSON', payload !== null);
check('ok = true', payload?.ok === true);
check(
  'markdown 含会话 ID',
  typeof payload?.markdown === 'string' && payload.markdown.includes('session-route-test'),
);
check(
  'markdown 含用户请求原文',
  typeof payload?.markdown === 'string' && payload.markdown.includes('把这件事做完'),
);
check('markdown 含健康度评分', typeof payload?.markdown === 'string' && payload.markdown.includes('62/100'));
check('stats.source = live（活会话优先）', payload?.stats?.source === 'live', String(payload?.stats?.source));
check('stats.events 与事件数一致', payload?.stats?.events === fakeEvents.length, String(payload?.stats?.events));
check('stats.ms 为数字（耗时可观测）', typeof payload?.stats?.ms === 'number');
check('响应头声明 JSON', String(okRes.headers?.['content-type']).startsWith('application/json'));

// ── 只读开关 record=0：自动化验证不得污染校准样本 ──
// 背景（2026-09-15 全量复核第七节待办 1）：`restart-attention-health.ps1` 的端到端验证与
// `work/verify-round3.mjs` 都走这条真实路由，于是"验证用的交接"混进了 history.jsonl。
// 这里断言开关确实生效，防止将来被改回去。
check('默认请求会记账（stats.recorded = true）', payload?.stats?.recorded === true, String(payload?.stats?.recorded));
const noRecordRes = makeRes();
await handler(req('/attention-health/handoff?sessionId=session-route-test&record=0'), noRecordRes);
let noRecordPayload = null;
try { noRecordPayload = JSON.parse(noRecordRes.body); } catch { /* 下面按 null 处理 */ }
check('record=0：文档照常生成（只影响记账）', noRecordRes.status === 200, `实际 ${noRecordRes.status}`);
check(
  'record=0：markdown 与默认请求同样完整',
  typeof noRecordPayload?.markdown === 'string' && noRecordPayload.markdown.includes('把这件事做完'),
);
check(
  'record=0：stats.recorded = false',
  noRecordPayload?.stats?.recorded === false,
  String(noRecordPayload?.stats?.recorded),
);

const missingRes = makeRes();
await handler(req('/attention-health/handoff'), missingRes);
check('缺 sessionId → 400', missingRes.status === 400, `实际 ${missingRes.status}`);

const wrongRes = makeRes();
await handler(req('/attention-health/other'), wrongRes);
check('未知路径 → 404', wrongRes.status === 404, `实际 ${wrongRes.status}`);

const coldRes = makeRes();
await handler(req('/attention-health/handoff?sessionId=session-not-loaded'), coldRes);
check('冷会话且无 sessionQuery → 503（明确失败，不静默降级）', coldRes.status === 503, `实际 ${coldRes.status}`);

// ── 路由鉴权 + 输入校验（2026-09-15 审查修复）──
// webServer.register 是裸路由，官方鉴权只包在它自己的路由外面；这里复刻同款判断。
const forbiddenHost = makeRes();
await handler(req('/attention-health/handoff?sessionId=session-route-test', { host: 'evil.example.com' }), forbiddenHost);
check('外域 Host → 403', forbiddenHost.status === 403, `实际 ${forbiddenHost.status}`);

const crossSite = makeRes();
await handler(
  req('/attention-health/handoff?sessionId=session-route-test', { 'sec-fetch-site': 'cross-site' }),
  crossSite,
);
check('cross-site 请求 → 403（DNS rebinding 形态）', crossSite.status === 403, `实际 ${crossSite.status}`);

const badOrigin = makeRes();
await handler(
  req('/attention-health/handoff?sessionId=session-route-test', { origin: 'http://evil.example.com' }),
  badOrigin,
);
check('跨源 Origin → 403', badOrigin.status === 403, `实际 ${badOrigin.status}`);

const sameOrigin = makeRes();
await handler(
  req('/attention-health/handoff?sessionId=session-route-test', { origin: 'http://127.0.0.1:3080' }),
  sameOrigin,
);
check('同源 Origin → 正常放行', sameOrigin.status === 200, `实际 ${sameOrigin.status}`);

// ── 连接来源层（2026-09-18 Z.3 复核侧裁决）──
// 为什么不用 token：官方 `isTrustedApiRequest` 也不校验 token（token 校验在 browser-auth 层，
// 值存在模块私有的 `PROCESS_LAUNCH_TOKENS` WeakMap 里，插件拿不到），所以"不发明新机制"。
// 但 **Host 头可以伪造、`remoteAddress` 不能** —— 这一层现在无副作用（只绑 127.0.0.1），
// 将来若开放局域网，它能挡住"外部伪造 Host"。四条用例守住三种合法写法与一种非法来源。
const remoteCases = [
  ['127.0.0.1', true, 'IPv4 loopback'],
  ['::1', true, 'IPv6 loopback'],
  ['::ffff:127.0.0.1', true, 'IPv4-mapped loopback'],
  ['127.0.0.53', true, '整个 127/8 都算本机'],
  ['192.168.1.7', false, '局域网地址'],
  ['10.0.0.9', false, '内网地址'],
  ['<IP>', false, '公网地址'],
  ['', false, '拿不到来源（未连接）→ 一律拒'],
];
for (const [addr, allow, label] of remoteCases) {
  const res = makeRes();
  await handler(req('/attention-health/handoff?sessionId=session-route-test', {}, addr), res);
  check(
    `remoteAddress=${addr || '(空)'} → ${allow ? '放行' : '403'}（${label}）`,
    res.status === (allow ? 200 : 403),
    `实际 ${res.status}`,
  );
}

// 直接断言判定函数本身：路由级用例只证明"某一种请求被拒"，
// 而鉴权是"多层与关系"（Host && sec-fetch-site && Origin && remoteAddress）。
if (typeof plugin.isTrustedHandoffRequest === 'function') {
  const trusted = plugin.isTrustedHandoffRequest;
  const okReq = { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } };
  check('判定函数：基准请求为真', trusted(okReq) === true);
  check(
    '判定函数：缺 Host → 假（不能只看来源）',
    trusted({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }) === false,
  );
  check(
    '判定函数：Host 合法但来源非 loopback → 假（Host 可伪造，来源不可）',
    trusted({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '192.168.1.7' } }) === false,
  );
  check('判定函数：无参数不抛错', trusted(undefined) === false);
} else {
  check('判定函数：isTrustedHandoffRequest 已导出（供逐层断言）', false, '未导出');
}

const badId = makeRes();
await handler(req('/attention-health/handoff?sessionId=bad@@@id'), badId);
check('非法 sessionId → 400', badId.status === 400, `实际 ${badId.status}`);

const longId = makeRes();
await handler(req(`/attention-health/handoff?sessionId=${'a'.repeat(400)}`), longId);
check('超长 sessionId → 400', longId.status === 400, `实际 ${longId.status}`);
check('400 响应不回显超长输入', longId.body.length < 200, `${longId.body.length} 字符`);

// 会话不存在 → 404（按官方 error code 判断，不匹配错误文案）
const nfRoutes = [];
const nfCtx = {
  sessionProjections: { register: () => {}, stateOf: () => undefined },
  webServer: { register: (r) => { nfRoutes.push(r); return () => {}; } },
  get: (name) => {
    if (name === 'sessions') return { get: () => undefined };
    if (name === 'sessionQuery') {
      return {
        readSession: async () => {
          const e = new Error('session not found');
          e.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
          throw e;
        },
      };
    }
    return undefined;
  },
  effect: (cb) => { cb(); return () => {}; },
  inject: (_deps, cb) => { cb(nfCtx); return { dispose: () => {} }; },
};
plugin.apply(nfCtx);
const nfRes = makeRes();
await nfRoutes[0].handler(
  req('/attention-health/handoff?sessionId=session-SAMPLE-e00c78c7'),
  nfRes,
);
check('会话不存在 → 404（而不是 500）', nfRes.status === 404, `实际 ${nfRes.status}`);

// 还原环境变量并清理路由测试期间产生的历史文件
if (realDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = realDshHome;
fs.rmSync(testDshHome, { recursive: true, force: true });

console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
process.exit(fail === 0 ? 0 : 1);
