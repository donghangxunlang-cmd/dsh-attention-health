/**
 * attention-health host 半「交接内容生成」测试。
 *
 * 目标：证明新功能（本地提炼交接内容）**正确、精简、够快**，且与离线 CLI
 * 用的同一套判据不漂移。
 *
 * 覆盖：
 *   1. 提炼正确性：与离线版 `lib/extract.mjs` 对真实会话的关键指标逐一对齐
 *   2. 渲染完整性：精简文档包含全部章节，以及规则推导的「下一步」
 *   3. 边界：空事件 / 脏事件 / 缺 header / 缺健康数据都不崩
 *   4. 性能：最大会话的单次生成远低于 2 秒（验收标准）
 *
 * 被测对象优先取**部署副本**（插件真正加载的那份），未部署时回退到项目源码。
 *
 * 运行：node test/handoff-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listSessions, readSession } from '../lib/session-log.mjs';
import { extractHandoff } from '../lib/extract.mjs';

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

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectFile = path.join(projectRoot, 'lib', 'handoff.js');
// 部署目录可用环境变量覆盖（2026-09-18 标准包化）：临时 profile 实验靠它指向刚装进去的那份。
const deployedDir =
  process.env.DSH_ATTENTION_HEALTH_DIR ??
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'attention-health');
const deployedFile = path.join(deployedDir, 'handoff.js');

const target = fs.existsSync(deployedFile) ? deployedFile : projectFile;
console.log(
  `  被测文件：${target}` +
    (target === projectFile ? '（部署副本不存在，回退到项目源码）' : '（部署副本）'),
);

const {
  LEVEL_LABEL,
  COMPACT_DEFAULTS,
  DEGRADE_LABELS,
  scoreContextHealth,
  foldSession,
  renderHandoff,
  contextTokensOf,
  deriveCompactionPlan,
  FINAL_NOTES,
  replyDegradeReasons,
  reasoningDegradeReasons,
  scanReasoning,
  buildHandoff: buildHandoffRaw,
  // S 节（2026-09-18）：`deriveCompactionPlan` 输入的**唯一实现** ——
  // 测试与渲染共用一份，免得测试自己手抄（抄漏字段会让验收变成假结论，§51.4 踩过）。
  compactionInputOf,
  // AD 节（2026-09-20）：回本显示的统一分档口径（三处显示点共用）。
  formatBreakEven,
} = await import(pathToFileURL(target).href);

// D3 拆分（2026-09-18）：barrel 只做转发，实现在 6 个兄弟模块里。
// 少任意一个的后果是**运行时** ERR_MODULE_NOT_FOUND（而 handoff.js 本身还在，
// 看起来一切正常），所以在这里把"文件齐不齐"钉成一条断言 —— 部署脚本漏复制、
// 或者有人删模块忘了改结构，都会在这里当场暴露。
{
  const MODULES = [
    'handoff-core.js',
    'handoff-text.js',
    'handoff-judge.js',
    'handoff-fold.js',
    'handoff-plan.js',
    'handoff-render.js',
  ];
  const dir = path.dirname(target);
  const absent = MODULES.filter((m) => !fs.existsSync(path.join(dir, m)));
  check(
    'D3：6 个拆分模块与 barrel 同目录（少一个就会运行时炸）',
    absent.length === 0,
    absent.length ? `缺：${absent.join(', ')}（目录 ${dir}）` : '',
  );
}

// 默认输出档位是「精简档」（2026-09-15 用户选择）；本套测试关注的是**提炼细节的正确性**，
// 所以统一走完整档，精简档另有专项断言（第 19 节）。
const buildHandoff = (input = {}) =>
  buildHandoffRaw({ ...input, options: { profile: 'full', ...(input.options ?? {}) } });

const sessions = listSessions();

console.log('\n════════ 1. 真实会话回放：与离线版逐项对齐 ════════');
const targets = sessions.slice(0, 6);
let mismatch = 0;

console.log('  会话                        事件   请求  轮次  文件  错误  步骤');
for (const s of targets) {
  const session = readSession(s.file);
  const x = foldSession(session.events);
  const offline = extractHandoff(session);

  const diffs = [];
  if (x.userRequests.length !== offline.userRequests.length) diffs.push('请求');
  if (x.turns.length !== offline.turns.length) diffs.push('轮次');
  if (x.files.length !== offline.files.length) diffs.push('文件');
  if (x.errors.length !== offline.errors.length) diffs.push('错误');
  if (x.stepCount !== offline.stepCount) diffs.push('步骤');
  if (x.usage.outputTokens !== offline.usage.outputTokens) diffs.push('输出token');
  if (x.usage.lastContextTokens !== offline.usage.lastContextTokens) diffs.push('上下文token');
  if ((x.todos?.length ?? 0) !== (offline.todos?.length ?? 0)) diffs.push('待办');
  if (x.openTurn !== offline.openTurn) diffs.push('未闭合轮次');
  if (diffs.length) mismatch += 1;

  console.log(
    `  ${s.id.slice(0, 24).padEnd(26)} ${String(session.events.length).padStart(5)} ` +
      `${String(x.userRequests.length).padStart(5)} ${String(x.turns.length).padStart(5)} ` +
      `${String(x.files.length).padStart(5)} ${String(x.errors.length).padStart(5)} ` +
      `${String(x.stepCount).padStart(5)}` +
      (diffs.length ? `   ⚠️ 不一致：${diffs.join('/')}` : ''),
  );
}
check(`全部 ${targets.length} 个会话的折叠结果与离线版一致`, mismatch === 0, `${mismatch} 个不一致`);

console.log('\n════════ 2. 渲染完整性 ════════');
// 渲染样本**不用 `targets[0]`**（2026-09-18 审查 C1）：
// 那是"最新会话"，可能只有 3~4 个事件的空会话（没有用量/退化数据），
// 会让"日志折算"之类的渲染断言**假失败** —— 而功能本身是正常的。
// 改用**日志文件最大**的会话：事件最多、内容最丰富，渲染断言才稳定。
const sample = readSession([...sessions].sort((a, b) => b.size - a.size)[0].file);
const health = {
  score: 62,
  level: 'warn',
  usedTokens: 300000,
  contextWindow: 1000000,
  effectivePercent: 60,
  windowPercent: 30,
  repeatWorst: 3,
  degradedReplies: 1,
  findings: ['有效上下文占用 60.0%，占声明窗口 30.0%'],
};
const { markdown, stats } = buildHandoff({
  events: sample.events,
  header: sample.header,
  health,
});

check('含标题', markdown.includes('# 会话交接内容'));
check('含健康度章节', markdown.includes('## 为什么交接'));
check('含会话标识', markdown.includes('## 会话'));
check('含最新目标章节', markdown.includes('## 最新目标'));
check('含用户请求主线', markdown.includes('## 用户请求主线'));
check('含各轮进度', markdown.includes('## 各轮进度'));
check('含涉及的文件', markdown.includes('## 涉及的文件'));
check('含待办', markdown.includes('## 待办'));
check('含错误章节', markdown.includes('## 遇到的错误'));
check('含规则推导的下一步', markdown.includes('## 下一步（规则推导，非模型建议）'));
check('含统计', markdown.includes('## 统计'));
check('显式声明零模型调用', markdown.includes('未调用任何模型'));
check('健康度分数渲染正确', markdown.includes('62/100'), '应出现 62/100');
check('stats.chars 与 markdown 长度一致', stats.chars === markdown.length);
// ── 输出体积守卫（2026-09-15 复核：把一条会漂移的断言换成不变式 + 确定性 fixture）──
// 原先是 `check('输出可控（< 40000 字符…）', markdown.length < 40000)`，而这里的 `markdown`
// 来自 `targets[0]` = **磁盘上最新的会话** —— 也就是"正在进行的那个会话"。实测：**不改任何代码**，
// 同一份代码 4 分钟内文档长度就从 40,204 漂到 40,190 字符。也就是说这条守卫测的是
// "今天干了多少活"，会自己变红；而时红时绿的守卫，最终只会教人忽略红色。
// 现在拆成两类都**不随当前工作量漂移**的断言：
//   (1) 不变式：附录 A / B 各自的上限必须守住 —— 会话再长也不该突破；
//   (2) 确定性 fixture：把请求主线 / 各轮进度 / 附录全部撑起来，总量仍须受控。
const sectionChars = (md, prefix) => {
  const start = md.indexOf(prefix);
  if (start < 0) return -1;
  const next = md.indexOf('\n## ', start + prefix.length);
  return (next < 0 ? md.length : next) - start;
};
const appendixA = sectionChars(markdown, '## 附录 A');
const appendixB = sectionChars(markdown, '## 附录 B');
check(
  `真实会话：附录 A 守住 20KB 上限（实测 ${appendixA} 字符）`,
  appendixA < 0 || appendixA <= 20200,
  String(appendixA),
);
check(
  `真实会话：附录 B 守住 12KB 上限（实测 ${appendixB} 字符）`,
  appendixB < 0 || appendixB <= 12200,
  String(appendixB),
);

const bulkEvents = [];
let bulkSeq = 1;
for (let i = 1; i <= 12; i += 1) {
  bulkEvents.push({ type: 'turn/start', seq: bulkSeq, time: 1000 * i, data: { turn: i } });
  bulkSeq += 1;
  bulkEvents.push({
    type: 'user/message',
    seq: bulkSeq,
    time: 1000 * i + 10,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 轮需求：${'需'.repeat(600)}` }] },
  });
  bulkSeq += 1;
  bulkEvents.push({
    type: 'assistant/message',
    seq: bulkSeq,
    time: 1000 * i + 20,
    data: {
      turn: i,
      message: { content: [{ type: 'text', text: `第 ${i} 轮回复：${'复'.repeat(i === 12 ? 30000 : 1500)}` }] },
      usage: { totalTokens: 200000 + i * 1000, outputTokens: 5000 },
    },
  });
  bulkSeq += 1;
  bulkEvents.push({
    type: 'turn/end',
    seq: bulkSeq,
    time: 1000 * i + 30,
    data: { turn: i, reason: { kind: 'completed' } },
  });
  bulkSeq += 1;
}
const bulkDoc = buildHandoff({ events: bulkEvents, header: { id: 'bulk', createdAt: 1000 } });
check(
  '输出可控（确定性超大 fixture 仍 < 40000 字符）',
  bulkDoc.markdown.length < 40000,
  `${bulkDoc.markdown.length} 字符`,
);
check('超大 fixture 同样触发附录截断标注', bulkDoc.markdown.includes('尾部内容被截断'));

console.log('\n════════ 3. 边界与健壮性 ════════');
const empty = buildHandoff({ events: [], header: {} });
check('空事件不崩且仍产出文档', empty.markdown.includes('# 会话交接内容'));
check('空事件 stats 归零', empty.stats.events === 0 && empty.stats.turns === 0 && empty.stats.errors === 0);

const dirty = buildHandoff({
  events: [
    null,
    undefined,
    {},
    { type: 'tool/call', data: {} },
    { type: 'user/message', data: { source: { kind: 'user' }, content: '纯字符串内容' } },
    { type: 'assistant/message', data: { message: { content: [] } } },
  ],
  header: null,
});
check('脏事件不崩', typeof dirty.markdown === 'string' && dirty.markdown.length > 0);
check('字符串 content 也能提取为用户请求', dirty.stats.userRequests === 1, `实际 ${dirty.stats.userRequests}`);

const noHealth = buildHandoff({ events: sample.events, header: sample.header, health: null });
check(
  '缺实时健康数据时改用日志口径补算并标注来源',
  noHealth.markdown.includes('（日志折算）'),
);
const noScaleDoc = buildHandoff({ events: [], header: {} });
check('连日志用量都没有时明确标注', noScaleDoc.markdown.includes('没有可用的上下文规模数据'));

const openTurn = buildHandoff({
  events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做一半的任务' }] } },
  ],
  header: { id: 'session-x' },
});
check('未闭合轮次进入「下一步」', openTurn.markdown.includes('尚未闭合'));

const withTodos = buildHandoff({
  events: [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'todo/write',
      data: {
        todos: [
          { content: '正在做的事', status: 'in_progress' },
          { content: '还没做的事', status: 'pending' },
        ],
      },
    },
  ],
  header: { id: 'session-y' },
});
check('进行中的待办进入「下一步」', withTodos.markdown.includes('标为进行中'));
check('待办清单渲染勾选框', withTodos.markdown.includes('- [ ] 还没做的事'));

console.log('\n════════ 4. 性能（验收：1~2 秒内完成） ════════');
const biggest = [...sessions].sort((a, b) => b.size - a.size)[0];
const bigSession = readSession(biggest.file);
const startedAt = Date.now();
const bigOut = buildHandoff({ events: bigSession.events, header: bigSession.header, health });
const elapsed = Date.now() - startedAt;
check(`最大会话（${bigSession.events.length} 事件）提炼 < 2000ms`, elapsed < 2000, `${elapsed}ms`);
console.log(`  ⏱  ${elapsed}ms，输出 ${bigOut.markdown.length} 字符`);

// ═════════ 以下为 2026-09-15「提炼质量增强」的用例 ═════════

// 2026-09-18 标准包化：版本号的"权威来源"是**包根**的 package.json
// （旧形态那份 `plugin/package.json` 已经取消，身份由包根承担）。
const pluginPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

console.log('\n════════ 5. 最新目标（需求 1） ════════');

const goalEvents = [
  { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最初我想给仓库加一套 CI' }] } },
  { type: 'goal/change', seq: 2, time: 2000, data: { goal: { objective: '给 DSH 写上下文健康插件', phase: 'executing', maxGoalRounds: 8 }, roundsStarted: 3 } },
  { type: 'user/message', seq: 3, time: 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '现在的重点是交接文档的提炼质量优化' }] } },
];
const goalDoc = buildHandoff({ events: goalEvents, header: { id: 'g1' } });
check('有 goal 时「最新目标」取 goal', goalDoc.markdown.includes('给 DSH 写上下文健康插件'));
check('有 goal 时不再分列「最初目标」', !goalDoc.markdown.includes('### 最初目标'));

const twoReqEvents = [
  { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写一个 Python 爬虫抓取商品价格并存入 Excel 表格' }] } },
  { type: 'turn/start', seq: 2, time: 1100, data: { turn: 1 } },
  { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } },
  { type: 'user/message', seq: 5, time: 2100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '算了，改成把 DSH 会话日志解析成交接文档，并加上健康度评分' }] } },
  { type: 'turn/end', seq: 6, time: 3000, data: { turn: 2, reason: { kind: 'completed' } } },
];
const twoDoc = buildHandoff({ events: twoReqEvents, header: { id: 'g2' } });
check('无 goal 且首尾差异大 → 分列「最初目标」', twoDoc.markdown.includes('### 最初目标'));
check('无 goal 且首尾差异大 → 分列「最新目标」', twoDoc.markdown.includes('### 最新目标'));
check('并提示以最新目标为准', twoDoc.markdown.includes('以最新目标为准'));

const sameReqEvents = [
  { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这件事做完就好' }] } },
  { type: 'user/message', seq: 2, time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这件事做完就好' }] } },
];
const sameDoc = buildHandoff({ events: sameReqEvents, header: { id: 'g3' } });
check(
  '无 goal 且首尾一致 → 只列一条',
  !sameDoc.markdown.includes('### 最初目标') && sameDoc.markdown.includes('与最初请求基本一致'),
);

console.log('\n════════ 6. 关键决策与未决问题（需求 2） ════════');
const decisionEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  {
    type: 'assistant/message',
    seq: 2,
    time: 1100,
    data: {
      turn: 1,
      message: { content: [{ type: 'text', text: '根因是插件在 webserver 之前完成初始化，路由因此没有注册。这个问题必须用 ctx.inject 解决。' }] },
      usage: { totalTokens: 1000, outputTokens: 50 },
    },
  },
  { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } },
  {
    type: 'assistant/message',
    seq: 5,
    time: 2100,
    data: {
      turn: 2,
      message: { content: [{ type: 'text', text: '下一步要把剪贴板方案接上。另外还有一点待确认：错误码聚合的阈值怎么定。' }] },
      usage: { totalTokens: 1500, outputTokens: 40 },
    },
  },
  { type: 'turn/end', seq: 6, time: 2200, data: { turn: 2, reason: { kind: 'completed' } } },
];
const decisionDoc = buildHandoff({ events: decisionEvents, header: { id: 'd1' } });
check('含「关键决策与未决问题」小节', decisionDoc.markdown.includes('## 关键决策与未决问题'));
check('抽到「根因」句', decisionDoc.markdown.includes('根因是插件在 webserver 之前完成初始化'));
check('抽到「必须」句', decisionDoc.markdown.includes('必须用 ctx.inject 解决'));
check('抽到「下一步」句', decisionDoc.markdown.includes('下一步要把剪贴板方案接上'));
check('抽到「待确认」句', decisionDoc.markdown.includes('待确认'));
check('标注来源轮次与角色', /第 1 轮·助手/.test(decisionDoc.markdown));
check('stats.decisions 与内容一致', decisionDoc.stats.decisions >= 4, String(decisionDoc.stats.decisions));

const dupDecisionEvents = [
  { type: 'assistant/message', seq: 1, time: 1000, data: { turn: 1, message: { content: [{ type: 'text', text: '根因是缓存没有失效，必须清掉。' }] } } },
  { type: 'assistant/message', seq: 2, time: 2000, data: { turn: 2, message: { content: [{ type: 'text', text: '根因是缓存没有失效，必须清掉。' }] } } },
];
const dupDoc = buildHandoff({ events: dupDecisionEvents, header: { id: 'd2' } });
check('重复句子去重（只保留一条）', dupDoc.stats.decisions === 1, String(dupDoc.stats.decisions));

console.log('\n════════ 7. 附录 A：最近轮次完整原文（需求 3） ════════');
const longReply = '这一段是助手的长回复内容，用于验证附录不做无谓截断。'.repeat(180);
const appendixEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请给出最后结论' }] } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1200,
    data: { turn: 1, message: { content: [{ type: 'text', text: longReply }] }, usage: { totalTokens: 9000, outputTokens: 3000 } },
  },
  { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
];
const appendixDoc = buildHandoff({ events: appendixEvents, header: { id: 'a1' } });
check('含「附录 A」小节', appendixDoc.markdown.includes('## 附录 A'));
check('长回复完整出现（未截断）', appendixDoc.markdown.includes(longReply));
check('标注原文字数', /原文 \d+ 字/.test(appendixDoc.markdown));
check('未超限时给出实际字符数', appendixDoc.markdown.includes('未超限'));

const hugeReply = 'Y'.repeat(30000);
const hugeEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '给个超长回复' }] } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1200,
    data: { turn: 1, message: { content: [{ type: 'text', text: hugeReply }] }, usage: { totalTokens: 40000, outputTokens: 9000 } },
  },
  { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
];
const hugeDoc = buildHandoff({ events: hugeEvents, header: { id: 'a2' } });
check('超长附录给出截断标注', hugeDoc.markdown.includes('尾部内容被截断'));
check('截断确实发生（不再含完整 30000 字）', !hugeDoc.markdown.includes(hugeReply));
check('标注了本段被截断', hugeDoc.markdown.includes('本段被截断'));

console.log('\n════════ 8. 错误清单聚合（需求 4） ════════');
const errEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'tool/result', seq: 2, time: 1100, data: { turn: 1, error: { name: 'read', code: 'FS_NOT_OBSERVED' }, message: { content: [{ type: 'text', text: 'file not observed' }] } } },
  { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } },
  { type: 'tool/result', seq: 5, time: 2100, data: { turn: 2, error: { name: 'read', code: 'FS_NOT_OBSERVED' }, message: { content: [{ type: 'text', text: 'file not observed' }] } } },
  { type: 'turn/end', seq: 6, time: 2200, data: { turn: 2, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 7, time: 3000, data: { turn: 3 } },
  { type: 'turn/end', seq: 8, time: 3100, data: { turn: 3, reason: { kind: 'completed' } } },
];
const errDoc = buildHandoff({ events: errEvents, header: { id: 'e1' } });
check('同错误码合并计数（× 2）', errDoc.markdown.includes('× 2'), '应出现 × 2');
check('标注错误出现的轮次', errDoc.markdown.includes('第 1、2 轮'));
check('判定「之后未再出现」', errDoc.markdown.includes('第 2 轮之后未再出现'));
check('stats.errorGroups 已聚合为 1 类', errDoc.stats.errorGroups === 1, String(errDoc.stats.errorGroups));

const activeErrEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'turn/end', seq: 2, time: 1100, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 3, time: 2000, data: { turn: 2 } },
  { type: 'tool/result', seq: 4, time: 2100, data: { turn: 2, error: { name: 'bash', code: 'ENOENT' }, message: { content: [{ type: 'text', text: 'missing' }] } } },
  { type: 'turn/end', seq: 5, time: 2200, data: { turn: 2, reason: { kind: 'completed' } } },
];
const activeDoc = buildHandoff({ events: activeErrEvents, header: { id: 'e2' } });
check('最近一轮仍出现 → 标注未解决', activeDoc.markdown.includes('最近一轮仍出现（未解决）'));
check('未解决错误进入「下一步」', activeDoc.markdown.includes('最近仍出现'));

console.log('\n════════ 9. 健康度机制说明（需求 5） ════════');
const healthDoc = buildHandoff({ events: sample.events, header: sample.header, health });
check('含「评分机制」说明', healthDoc.markdown.includes('**评分机制**'));
check('说明分数与时间无关', healthDoc.markdown.includes('与挂钟时间') && healthDoc.markdown.includes('无关'));
check('给出 70% / 90% 阈值', healthDoc.markdown.includes('≥70%') && healthDoc.markdown.includes('≥90%'));

console.log('\n════════ 10. 各轮 token 增长（需求 6） ════════');
const growEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'assistant/message', seq: 2, time: 1100, data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮回复' }] }, usage: { totalTokens: 10000, outputTokens: 200 } } },
  { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } },
  { type: 'tool/result', seq: 5, time: 2100, data: { turn: 2, message: { content: [{ type: 'text', text: 'Z'.repeat(400000) }] } } },
  { type: 'assistant/message', seq: 6, time: 2200, data: { turn: 2, message: { content: [{ type: 'text', text: '读完大文件了' }] }, usage: { totalTokens: 200000, outputTokens: 100 } } },
  { type: 'turn/end', seq: 7, time: 2300, data: { turn: 2, reason: { kind: 'completed' } } },
];
const growDoc = buildHandoff({ events: growEvents, header: { id: 'u1' } });
check('含「各轮上下文增长」表', growDoc.markdown.includes('### 各轮上下文增长'));
check('含「增长最快的轮次」', growDoc.markdown.includes('**增长最快的轮次**'));
check('增量计算正确（+190,000）', growDoc.markdown.includes('+190,000'), '第 2 轮增量应为 190,000');
check('识别为「大工具输出」', growDoc.markdown.includes('大工具输出'));

console.log('\n════════ 11. 命令写文件启发式（需求 7） ════════');
const cmdText = [
  "Set-Content -LiteralPath 'E:\\tmp\\a.txt' -Value 'hi'",
  "Copy-Item -Path x -Destination 'E:\\tmp\\b.txt'",
  'echo hi > E:\\tmp\\c.txt',
  'echo hi 2>&1',
].join('\n');
const cmdEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: 1100, data: { turn: 1, name: 'pwsh', callId: 'p1', arguments: JSON.stringify({ command: cmdText }) } },
  { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
];
const cmdDoc = buildHandoff({ events: cmdEvents, header: { id: 'c1' } });
check('含「可能涉及（来自命令）」小节', cmdDoc.markdown.includes('可能涉及（来自命令'));
check('识别 Set-Content 目标', cmdDoc.markdown.includes('a.txt'));
check('识别 Copy-Item 目标', cmdDoc.markdown.includes('b.txt'));
check('识别输出重定向目标', cmdDoc.markdown.includes('c.txt'));
check('未把 2>&1 误判为文件', !cmdDoc.markdown.includes('&1)'));
check('stats.commandFiles 统计正确', cmdDoc.stats.commandFiles === 3, String(cmdDoc.stats.commandFiles));

console.log('\n════════ 12. 标题取最新（需求 8） ════════');
const titleEvents = [
  { type: 'session/title', seq: 1, time: 1000, data: { title: '旧标题' } },
  { type: 'session/title', seq: 2, time: 2000, data: { title: '新标题' } },
];
const titleDoc = buildHandoff({ events: titleEvents, header: { id: 't1' } });
check('标题取最新', titleDoc.markdown.includes('- 标题（最新）：新标题'));
check('保留曾用标题', titleDoc.markdown.includes('曾用标题：旧标题'));

console.log('\n════════ 13. 超长请求压缩 + 附录 B（需求 9） ════════');
const longAsk = '这是一条很长的需求正文，包含若干要点与背景说明。'.repeat(40);
const longAskDoc = buildHandoff({
  events: [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: longAsk }] } },
    { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  header: { id: 'l1' },
});
check('主线给出「全文见附录 B」指引', longAskDoc.markdown.includes('全文见 **附录 B-1**'));
check(
  '含附录 B 且收录原文',
  longAskDoc.markdown.includes('## 附录 B：超长用户请求原文') && longAskDoc.markdown.includes(longAsk.slice(0, 120)),
);
// 注意：附录 A 会保留最近一轮的**完整**原文，所以这里只切「用户请求主线」这一段来判定
const mainSection = longAskDoc.markdown.split('## 用户请求主线')[1].split('## 关键决策')[0];
check('主线里不重复整段原文（已压缩）', !mainSection.includes(longAsk));

console.log('\n════════ 14. 头部元信息（需求 10） ════════');
const metaDoc = buildHandoff({
  events: sample.events,
  header: sample.header,
  health,
  source: 'live',
  generation: 'v3',
  now: Date.UTC(2026, 8, 15, 12, 0, 0),
});
check('含生成时间戳', /生成时间：2026-09-15/.test(metaDoc.markdown));
check('含插件版本且与 package.json 一致', metaDoc.markdown.includes(`插件版本：${pluginPkg.version}`));
check('含数据来源', metaDoc.markdown.includes('活会话内存'));
check('含磁盘日志代际', metaDoc.markdown.includes('代际：v3'));

// ═════════ 2026-09-15 合并需求：压缩成本 / 交接时机（双口径） ═════════

const CTX = {
  type: 'request/context',
  seq: 0,
  time: 1,
  data: { contextWindow: 1000000, provider: 'deepseek', model: 'v4' },
};
const usageEvent = (seq, totalTokens, opts = {}) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq * 100,
  data: {
    turn: opts.turn ?? 1,
    message: { content: [{ type: 'text', text: opts.text ?? '好的' }] },
    usage: {
      totalTokens,
      outputTokens: opts.out ?? 20,
      cacheReadTokens: opts.hit ?? Math.max(0, totalTokens - 1400),
      inputTokens: opts.miss ?? 1400,
    },
  },
});
const readCall = (seq) => ({
  type: 'tool/call',
  seq,
  time: 1000 + seq * 100,
  data: { turn: 1, name: 'read', callId: 'c' + seq, arguments: '{"file_path":"E:/x.txt"}' },
});

console.log('\n════════ 15. 压缩 / 交接双口径建议 ════════');

const okDoc = buildHandoff({ events: [CTX, usageEvent(1, 200000)], header: { id: 'k1' } });
check('三态｜继续（声明 20%）', okDoc.markdown.includes('**可以继续（无需交接）**'));

// 2026-09-16 边界设定：压缩档位改锚**声明窗口**，所以下面的 fixture 一律按
// "占声明窗口多少"来挑 usedTokens（旧测试是按"占有效窗口多少"挑的，全部失效）。
const midDoc = buildHandoff({ events: [CTX, usageEvent(1, 550000)], header: { id: 'k2' } });
// 550K/1M = 55% 声明（mild 档），且只有一条 usage → 估不出每轮增长；
// 此时走代理判据（<60% 声明）判"现在不必压"。
// 2026-09-18：成本模型修正后 `continueWinsOnCost` 收严（从"贵不过 1.5 倍"改为"每轮不更贵"），
// 本场景（550k、命中率 99.7%、估不出增长）不再走"推迟压缩"分支 —— 因为继续每轮 ¥0.0125
// 确实贵过新开 ¥0.0007，"等待不花钱"这个前提不成立。结论仍是**继续**（H 估不出 → 不做成本裁决），
// 只是理由从"距官方线尚远"变成"压缩摊不回来"。断言守住**结论**，不再钉措辞。
check(
  '三态｜55% 声明 + 估不出增长：结论仍是继续（不劝手动压缩）',
  midDoc.markdown.includes('可以继续') && !midDoc.markdown.includes('建议手动压缩'),
  midDoc.markdown.split('\n').filter((l) => l.includes('继续')).join(' | ').slice(0, 160),
);
check('压缩余量正确（距官方线 250,000）', midDoc.markdown.includes('250,000'));
check('含官方压缩线（800,000）', midDoc.markdown.includes('800,000'));

// 对照：66% 声明（recommend 档）+ 每轮涨 10,000 → 距官方线约 14 轮。
// **2026-09-16 接入真实价格后的结论变了**：压缩省下的那部分本来就按缓存命中价
// （0.02 元/百万）计费，而压缩后前缀缓存重建按未命中价（1 元/百万）——一次性 ¥0.41
// 要几十轮才摊得完，14 轮的窗口里继续明显更省。所以这里**不再建议现在压缩**。
const soonEvents = [CTX, usageEvent(1, 650000), usageEvent(2, 660000, { turn: 2 })];
const soonDoc = buildHandoff({
  events: soonEvents,
  header: { id: 'k2b' },
});
check(
  '三态｜真实价格下压缩摊不完 → 继续（不再建议现在压缩）',
  // X 节（2026-09-18）删掉了"摊不完 / 摊不回来"这类解释性文案，
  // 于是改为**直接断言结论**（plan 层），并顺带钉住那些字样不再出现在文档里。
  deriveCompactionPlan(compactionInputOf(foldSession(soonEvents))).final.advice === 'continue' &&
    !soonDoc.markdown.includes('摊不回来') &&
    !soonDoc.markdown.includes('摊不完'),
  soonDoc.markdown.split('\n').filter((l) => l.includes('compact')).join(' | ').slice(0, 200),
);

// 退化场景：50% 声明 = 有效 83%（≥70%）—— **规模 + 退化** 才判交接（本次边界设定的核心）。
const degDoc = buildHandoff({
  events: [CTX, usageEvent(1, 500000), readCall(2), readCall(3), readCall(4)],
  header: { id: 'k3' },
});
check('三态｜退化信号 → 建议交接', degDoc.markdown.includes('建议机械交接 + 新开会话'));
check('标注「退化信号优先于压缩」', degDoc.markdown.includes('退化信号优先于压缩'));

// 立即新开：60% 声明 = 有效 100%（≥90%）**且**有退化信号。
const immDoc = buildHandoff({
  events: [CTX, usageEvent(1, 600000), readCall(2), readCall(3), readCall(4)],
  header: { id: 'k4' },
});
check('三态｜有效 ≥90% 且退化 → 立即新开', immDoc.markdown.includes('建议立即新开会话'));

// 只规模大、**无退化**：不再因规模劝交接，而是交给压缩维度 —— 这正是旧口径下
// "官方线永远不可达"的根源（旧版这里会判 immediate/handoff）。
const bigNoDegDoc = buildHandoff({ events: [CTX, usageEvent(1, 600000)], header: { id: 'k4b' } });
check(
  '三态｜只规模大、无退化 → 不劝交接（交给压缩维度）',
  !bigNoDegDoc.markdown.includes('建议机械交接') && !bigNoDegDoc.markdown.includes('建议立即新开会话'),
  bigNoDegDoc.markdown.split('\n').filter((l) => l.includes('建议')).join(' | ').slice(0, 160),
);

// 官方线可达性（2026-09-16 用户重定位）：75% 声明（官方线 80% 的 5 个百分点预警带内）
// → **不再劝手动压缩**，改为说明"官方到线会先做零 token 修剪，无需你动手"。
// 理由：实测在该点手动压要 ¥0.5 一次性、回本 35 轮，而到官方线只剩几轮 —— 必然摊不完。
const officialDoc = buildHandoff({ events: [CTX, usageEvent(1, 750000)], header: { id: 'k4c' } });
check(
  '三态｜官方线附近：说明官方会自己处理，且不出现"手动 /compact"建议',
  officialDoc.markdown.includes('无需手动 `/compact`') &&
    !officialDoc.markdown.includes('现在手动 /compact'),
  officialDoc.markdown.split('\n').filter((l) => l.includes('compact')).join(' | ').slice(0, 160),
);

const twiceDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 200000),
    {
      type: 'compaction/summary',
      seq: 2,
      time: 3000,
      data: {
        compactionId: 'c1',
        shadowedTokenCount: 120000,
        summary: [{ type: 'text', text: '摘要一' }],
        provider: 'deepseek',
        model: 'v4',
        usage: { inputTokens: 120000, outputTokens: 1500 },
      },
    },
    usageEvent(3, 90000),
    {
      type: 'compaction/summary',
      seq: 4,
      time: 5000,
      data: {
        compactionId: 'c2',
        shadowedTokenCount: 60000,
        summary: [{ type: 'text', text: '摘要二' }],
        provider: 'deepseek',
        model: 'v4',
        usage: { inputTokens: 60000, outputTokens: 1200 },
      },
    },
    usageEvent(5, 40000),
  ],
  header: { id: 'k5' },
});
check('三态｜已压缩 2 次 → 建议交接', twiceDoc.markdown.includes('已压缩 2 次'));
check('含压缩历史表', twiceDoc.markdown.includes('### 压缩历史'));
check('历史标注「模型摘要」', twiceDoc.markdown.includes('模型摘要'));
check('历史记录被压缩 token', twiceDoc.markdown.includes('120,000'));

const pruneDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 200000),
    {
      type: 'compaction/prune',
      seq: 2,
      time: 3000,
      data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 80000 },
    },
    usageEvent(3, 130000),
  ],
  header: { id: 'k6' },
});
check('裁剪型压缩识别为「仅裁剪」', pruneDoc.markdown.includes('仅裁剪'));
check('裁剪标注「否（零 token）」', pruneDoc.markdown.includes('否（零 token）'));

check('并列显示维度 A（质量·有效窗口）', midDoc.markdown.includes('维度 A｜质量（口径：有效窗口'));
check(
  '并列显示维度 B（上下文占用·声明窗口 + 官方线）',
  midDoc.markdown.includes('维度 B｜上下文占用（口径：档位口径 = 声明窗口'),
);
check('显式提示两维度并列且不混用', midDoc.markdown.includes('并列展示，口径各自标注、不混用'));
check('维度 B 明示档位口径为声明窗口', midDoc.markdown.includes('按声明窗口分档'));
check('给出只提示不自动压缩的边界说明（X 节起缩到一句）', midDoc.markdown.includes('只提示，不自动操作'));

// ─────────────────────────────────────────────────────────────
// 16. 实测修复回归（2026-09-15 真机实测发现的问题）
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 16. 实测修复回归 ════════');

// 场景：一次真实压缩（200,000 → 90,000），紧接着再看"还能不能压"
const justCompacted = buildHandoff({
  events: [
    CTX,
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    usageEvent(2, 200000, { turn: 1 }),
    {
      type: 'compaction/summary',
      seq: 3,
      time: 3000,
      data: {
        compactionId: 'jc1',
        shadowedTokenCount: 120000,
        summary: [{ type: 'text', text: '压缩摘要' }],
        provider: 'deepseek',
        model: 'v4',
        // 真实事件里 inputTokens 是缓存未命中部分（很小），不能拿它当"被压缩历史"
        usage: { inputTokens: 380, outputTokens: 1500 },
      },
    },
    { type: 'turn/start', seq: 4, time: 4000, data: { turn: 2 } },
    usageEvent(5, 90000, { turn: 2 }),
  ],
  header: { id: 'k7' },
});

check(
  '刚压缩过｜识别出「没有可压缩余量」',
  justCompacted.markdown.includes('现在压缩的收益 ≈ 0'),
  '应提示再压缩收益≈0（不可压缩基线 = 上次压缩后的实测规模）',
);
check(
  '刚压缩过｜不再给出「N 轮回本」',
  !justCompacted.markdown.includes('轮回本'),
  '压缩后每轮成本应等于继续，saving=0，不该有回本结论',
);
// 第二批审查后，成本模型的"被压缩历史"改为**当前可压缩量**，不再沿用上次的 shadowedTokens。
// 这个场景刚压缩完（上下文 90,000 = 不可压缩基线），可压缩量为 0 → 成本只剩摘要输出 1,500。
check(
  '摘要成本 = 当前可压缩量×系数 + 摘要输出（不再用 summaryInputTokens）',
  !justCompacted.markdown.includes('3,205') && justCompacted.markdown.includes('1,500'),
  '旧实现用 summaryInputTokens(380) 会把成本低估到 3,205',
);
check(
  '成本拆解显示的是「当前可压缩量」',
  justCompacted.markdown.includes(`被压缩历史 0 × ${COMPACT_DEFAULTS.cacheFactor}`),
  '刚压缩完时可压缩量应为 0',
);
check('压缩历史含实测「压缩前 → 压缩后」', justCompacted.markdown.includes('200,000 → 90,000'));
check('压缩历史标注实际减少量', justCompacted.markdown.includes('−110,000'));
check(
  '压缩轮增量显示「压缩后重置」',
  justCompacted.markdown.includes('压缩后重置'),
  '旧实现用 Math.max(0,…) 把负增量夹成 +0，掩盖了压缩效果',
);

// 决策抽取：表格行 / 指标行必须滤掉，真正的决策句要留下
const noisyReply =
  '| 主机测试 | ✅ 24 通过 / 0 失败 |\n根因是 PowerShell 变量名不区分大小写，必须改名。';
const noiseDoc = buildHandoff({
  events: [
    CTX,
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2000,
      data: {
        turn: 1,
        message: { content: [{ type: 'text', text: noisyReply }] },
        usage: { totalTokens: 1000, outputTokens: 30, cacheReadTokens: 500, inputTokens: 500 },
      },
    },
  ],
  header: { id: 'k8' },
});
const decisionSection = noiseDoc.markdown.split('## 关键决策与未决问题')[1]?.split('\n## ')[0] ?? '';
check(
  '决策抽取｜滤掉表格 / 测试指标行',
  !decisionSection.includes('24 通过'),
  '过期的测试数字被当决策展示会误导接手方',
);
check('决策抽取｜保留真正的决策句', decisionSection.includes('根因是 PowerShell 变量名不区分大小写'));

// 待办：清单来自早期轮次时要提醒"此后未再更新"
const staleDoc = buildHandoff({
  events: [
    CTX,
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    usageEvent(2, 200000, { turn: 1 }),
    {
      type: 'todo/write',
      seq: 3,
      time: 3000,
      data: {
        todos: [
          { content: '统一双维度口径', status: 'in_progress' },
          { content: '写回归测试', status: 'pending' },
        ],
      },
    },
    { type: 'turn/start', seq: 4, time: 4000, data: { turn: 2 } },
    usageEvent(5, 210000, { turn: 2 }),
  ],
  header: { id: 'k9' },
});
check(
  '待办｜提醒「此后未再更新、很可能已完成」',
  staleDoc.markdown.includes('此后未再更新'),
  'todo 快照来自早期轮次时，直接列成"待办"会误导',
);
check('待办｜不再写「进行中」这种肯定语气', staleDoc.markdown.includes('当时标记为进行中'));

// ─────────────────────────────────────────────────────────────
// 17. 审查修复回归（2026-09-15，《修复任务书》）
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 17. 审查修复回归 ════════');

const compactionSummary = (seq, shadowed) => ({
  type: 'compaction/summary',
  seq,
  time: 3000 + seq * 10,
  data: {
    compactionId: 's' + seq,
    shadowedTokenCount: shadowed,
    summary: [{ type: 'text', text: '摘要' }],
    provider: 'p',
    model: 'm',
    usage: { inputTokens: 300, outputTokens: 1000 },
  },
});
const compactionPrune = (seq, shadowed) => ({
  type: 'compaction/prune',
  seq,
  time: 3000 + seq * 10,
  data: { shadowedTokenCount: shadowed },
});

// P1-2：官方自动压缩是「先 prune 再 summary」，一次就产生 2 条压缩事件；
// 按总数计入"已压缩 2 次"会让刚压缩过、上下文已降到 40% 的会话被判交接。
const hybridDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 900000),
    compactionSummary(2, 700000),
    compactionPrune(3, 100000),
    usageEvent(4, 200000),
  ],
  header: { id: 'a1' },
});
check(
  'P1-2｜1 摘要 + 1 裁剪（上下文已降到 40%）→ 不劝交接',
  hybridDoc.markdown.includes('可以继续'),
  '官方自动压缩会同时产生 prune 与 summary',
);

const pruneOnlyDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 900000),
    compactionPrune(2, 700000),
    compactionPrune(3, 100000),
    usageEvent(4, 200000),
  ],
  header: { id: 'a2' },
});
check('P1-2｜2 次纯裁剪（零损失）→ 不劝交接', pruneOnlyDoc.markdown.includes('可以继续'));

// P2-4：表格单元格转义（一个 | 就能把 6 列表格拆成 8 段）
const pipeDoc = buildHandoff({
  events: [
    CTX,
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1100,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看看这个' }] },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1200,
      data: {
        turn: 1,
        message: { content: [{ type: 'text', text: '对比：方案A | 方案B | 方案C，三者差异明显。' }] },
        usage: { totalTokens: 1000, outputTokens: 30 },
      },
    },
    { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  header: { id: 'a3' },
});
const pipeLine = pipeDoc.markdown
  .split('\n')
  .find((l) => l.startsWith('| 1 |') && l.includes('方案A'));
const pipeCells = (pipeLine ?? '').split(/(?<!\\)\|/).length - 2;
check('P2-4｜回复含 | 时表格列数不变（6 列）', pipeCells === 6, `实际 ${pipeCells} 列`);

// P2-3：附录 B 总量上限
const longReqEvents = [];
for (let i = 0; i < 8; i += 1) {
  longReqEvents.push({ type: 'turn/start', seq: i * 4 + 1, time: 1000 + i * 100, data: { turn: i + 1 } });
  longReqEvents.push({
    type: 'user/message',
    seq: i * 4 + 2,
    time: 1100 + i * 100,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `【需求${i + 1}】` + '这是一个很长的需求描述，'.repeat(250) }],
    },
  });
  longReqEvents.push({
    type: 'assistant/message',
    seq: i * 4 + 3,
    time: 1200 + i * 100,
    data: {
      turn: i + 1,
      message: { content: [{ type: 'text', text: '收到' }] },
      usage: { totalTokens: 1000 + i, outputTokens: 10 },
    },
  });
  longReqEvents.push({
    type: 'turn/end',
    seq: i * 4 + 4,
    time: 1300 + i * 100,
    data: { turn: i + 1, reason: { kind: 'completed' } },
  });
}
const longDoc = buildHandoff({ events: [CTX, ...longReqEvents], header: { id: 'a4' } });
const appBSection = longDoc.markdown.split('## 附录 B')[1] ?? '';
check(
  'P2-3｜附录 B 受总量上限约束（< 14,000 字符）',
  appBSection.length < 14000,
  `实际 ${appBSection.length} 字符（修复前 24,308）`,
);
check('P2-3｜截断处有明确标注', /另有 \d+ 条超长请求未展开|已截断/.test(appBSection));
check(
  'P2-3｜整篇文档明显变短',
  longDoc.markdown.length < 30000,
  `实际 ${longDoc.markdown.length} 字符（修复前 37,713）`,
);

// P3-6：决策章节的"关键词"文案必须与实现一致（已不再包含「失败」「注意」）
// 2026-09-18 审查 F.2：词表扩为中英双语，空态说明必须**如实注明**（否则英文会话
// 无从判断"是真没结论"还是"语言不支持"）。
const noDecisionDoc = buildHandoff({
  events: [CTX, usageEvent(1, 1000, { text: '今天的天气还不错，我们继续吧。' })],
  header: { id: 'a5' },
});
check(
  'P3-6｜未命中时的关键词提示与实现一致，且如实注明中英双语',
  !noDecisionDoc.markdown.includes('关键词：根因 / 失败') &&
    noDecisionDoc.markdown.includes('取舍词 根因 / 结论') &&
    noDecisionDoc.markdown.includes('通用结论词 发现') &&
    noDecisionDoc.markdown.includes('中英双语') &&
    noDecisionDoc.markdown.includes('decided to'),
  noDecisionDoc.markdown.split('\n').filter((l) => l.includes('未命中关键词句')).join(' | ').slice(0, 220),
);

// ── 英文提取的回归保护（2026-09-18 审查 F.2 / G.2 指出的缺口）──────────────
// 此前**完全没有英文断言**：词表全中文、大小写敏感、英文句号不参与分句 —— 三个缺陷
// 都因为没有测试而长期潜伏。下面三条各钉住其中一个。
{
  const enDoc = buildHandoff({
    events: [
      CTX,
      usageEvent(1, 1000, {
        text: 'We decided to switch the transport to stdio instead of HTTP. The conclusion is that multi-frame zstd needs a custom reader.',
      }),
    ],
    header: { id: 'en1' },
  });
  check(
    '英文①：decided to / conclusion 能命中决策句',
    enDoc.markdown.includes('decided to switch the transport') ||
      enDoc.markdown.includes('The conclusion is'),
    enDoc.markdown.split('\n').filter((l) => l.includes('[第 1 轮')).join(' | ').slice(0, 200),
  );
}
{
  // 句首大写的结论句 —— 钉住"大小写不敏感"（原实现 `s.includes(kw)` 会漏掉它）
  const capDoc = buildHandoff({
    events: [
      CTX,
      usageEvent(1, 1000, {
        text: 'The key difference: standard swaps tool-bash for tool-pwsh on win32, while minimal keeps a persistent PTY.',
      }),
    ],
    header: { id: 'en2' },
  });
  check(
    '英文②：句首大写的「The key difference」能命中（大小写不敏感）',
    capDoc.markdown.includes('The key difference'),
    capDoc.markdown.split('\n').filter((l) => l.includes('[第 1 轮')).join(' | ').slice(0, 200),
  );
}
{
  // 超长英文段落 —— 钉住"英文句号参与分句"：
  // 不按 `.` 切分时整段会超过 400 字符上限，结论句会随整段一起被丢弃。
  const filler = 'This paragraph explains background context in several ordinary sentences. ';
  const longEn =
    filler.repeat(6) +
    'We decided to keep the persistent bash PTY because it survives restarts. ' +
    filler.repeat(3);
  const longDoc = buildHandoff({
    events: [CTX, usageEvent(1, 1000, { text: longEn })],
    header: { id: 'en3' },
  });
  check(
    '英文③：超长段落（整段 >400 字符）仍能切出其中的结论句',
    longEn.length > 400 && longDoc.markdown.includes('decided to keep the persistent bash PTY'),
    `整段 ${longEn.length} 字符；` +
      (longDoc.markdown.split('\n').filter((l) => l.includes('[第 1 轮')).join(' | ').slice(0, 160) || '（未抽到）'),
  );
}

// ─────────────────────────────────────────────────────────────
// 18. 第二批审查修复回归（交接文档产出质量）
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 18. 第二批审查修复回归 ════════');

const userMsg = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq * 100,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

// 新-A：陈旧实测值（50 分钟前的压缩结果）不得参与成本模型
const staleCostDoc = buildHandoff({
  events: [
    CTX, // 窗口 1,000,000
    usageEvent(1, 900000),
    {
      type: 'compaction/summary',
      seq: 2,
      time: 3000,
      data: {
        compactionId: 'stale1',
        shadowedTokenCount: 700000,
        summary: [{ type: 'text', text: '摘要' }],
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 300, outputTokens: 1000 },
      },
    },
    usageEvent(3, 20000), // 压缩后 20K
    usageEvent(4, 300000), // 之后又积累了 28 万
  ],
  header: { id: 'b1' },
});
const historyLine = staleCostDoc.markdown.split('\n').find((l) => l.includes('被压缩历史')) ?? '';
const claimedCompacted = Number((/([\d,]+)\s*×/.exec(historyLine) ?? [])[1]?.replace(/,/g, '') ?? 0);
check(
  '新-A｜「被压缩历史」不得超过当前上下文',
  claimedCompacted > 0 && claimedCompacted <= 300000,
  `声称 ${claimedCompacted} / 当前 300,000`,
);
const afterMatch = /压缩后约 ([\d,]+) token 的前缀缓存失效/.exec(staleCostDoc.markdown);
const claimedAfter = afterMatch ? Number(afterMatch[1].replace(/,/g, '')) : 0;
check(
  '新-A｜「压缩后规模」重新估算（不再回落到 50 分钟前的 20K）',
  claimedAfter > 50000,
  `实际 ${claimedAfter}`,
);
check(
  '新-A｜压缩历史表仍如实展示上次实测（事实与预测分开）',
  staleCostDoc.markdown.includes('700,000') && staleCostDoc.markdown.includes('20,000'),
);

// 新-B：最后几条是控制指令时，"最新目标"必须回退到实质性请求
const ctrlDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 50000, { text: '收到' }),
    userMsg(2, '把交接文档的成本模型修好，它把上次压缩的数字当成现在的预测'),
    userMsg(4, '继续'),
    userMsg(5, '继续'),
  ],
  header: { id: 'b2' },
});
const goalSection = ctrlDoc.markdown.split('## 最新目标')[1]?.split('\n## ')[0] ?? '';
check(
  '新-B｜最新目标回退到最近一条实质性请求',
  goalSection.includes('把交接文档的成本模型修好'),
  goalSection.slice(0, 140),
);
check('新-B｜不把「继续」当成目标', !/\*\*继续\*\*/.test(goalSection));
check('新-B｜把「最后一条指令」作为事实单独标注', goalSection.includes('控制指令'));

// 新-C：决策句不得留下不配对的标记，编号不得断号
const numberedDoc = buildHandoff({
  events: [
    CTX,
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2000,
      data: {
        turn: 1,
        message: {
          content: [
            {
              type: 'text',
              text:
                '四件事必须记住：\n' +
                '① 插件行不热加载，改 host 源码必须重启；\n' +
                '② `.ps1` 必须保持 UTF-8 with BOM（编辑后要复查）；\n' +
                '③ 这一条没有任何关键词；\n' +
                '④ `err.log` 只属于最后启动的那个进程，必须复查。',
            },
          ],
        },
        usage: { totalTokens: 1000, outputTokens: 30 },
      },
    },
  ],
  header: { id: 'b3' },
});
const decSection = numberedDoc.markdown.split('## 关键决策与未决问题')[1]?.split('\n## ')[0] ?? '';
const decLines = decSection.split('\n').filter((l) => l.startsWith('- ['));
check(
  '新-C｜决策行里 ` 与 ** 都成对（不留孤立标记）',
  decLines.every(
    (l) => (l.split('`').length - 1) % 2 === 0 && (l.split('**').length - 1) % 2 === 0,
  ),
  decLines.join(' ｜ ').slice(0, 160),
);
check(
  '新-C｜编号序列不再断号（③ 被一起带上）',
  decLines.some((l) => l.includes('①') && l.includes('②') && l.includes('③') && l.includes('④')),
  decLines.join(' ｜ ').slice(0, 200),
);

// 可读性 2：流程性重试不进「未解决」清单
const retryDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 50000),
    {
      type: 'tool/result',
      seq: 2,
      time: 2000,
      data: {
        turn: 1,
        name: 'edit',
        isError: true,
        error: { name: 'FsError', code: 'FS_NOT_OBSERVED', message: 'file has not been read' },
        content: [{ type: 'text', text: 'Error: cannot modify "E:/x.js": file has not been read' }],
      },
    },
    usageEvent(3, 52000),
  ],
  header: { id: 'b4' },
});
check(
  '可读性2｜流程性重试被单独归类（不进「未解决需追查」）',
  retryDoc.markdown.includes('流程性重试'),
  retryDoc.markdown.split('\n').filter((l) => l.includes('FS_')).join(' ｜ ').slice(0, 200),
);
check(
  '可读性2｜不再把 FS_NOT_OBSERVED 说成「最近仍出现（未解决）」',
  !/类错误\*\*最近仍出现\*\*（[^）]*FS_NOT_OBSERVED/.test(retryDoc.markdown),
);

// 可读性 3 / 6：待办指引方向 + 不再叠加两个括号
const todoStaleDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 50000),
    {
      type: 'todo/write',
      seq: 2,
      time: 2000,
      data: { todos: [{ content: '统一口径', status: 'pending' }] },
    },
    usageEvent(3, 52000),
    usageEvent(4, 54000),
  ],
  header: { id: 'b5' },
});
check('可读性3｜待办指引指向「上方」', !todoStaleDoc.markdown.includes('见下方清单'));
const nextSection = todoStaleDoc.markdown.split('## 下一步')[1]?.split('\n## ')[0] ?? '';
check(
  '可读性6｜「很可能已完成」不再以两个括号叠加出现',
  !/）（/.test(nextSection),
  nextSection.slice(0, 200),
);

// 可读性 5：临时产物 / 复核脚本要被标注
const tmpDoc = buildHandoff({
  events: [
    CTX,
    usageEvent(1, 50000),
    {
      type: 'tool/call',
      seq: 2,
      time: 2000,
      data: { turn: 1, name: 'write', callId: 'w1', arguments: '{"file_path":"E:/下载/AI下载/.dsh-tmp/handoff-live2.md"}' },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: 2100,
      data: { turn: 1, name: 'write', callId: 'w2', arguments: `{"file_path":"${projectRoot.replace(/\\/g, '/')}/work/verify-audit.mjs"}` },
    },
    usageEvent(4, 52000),
  ],
  header: { id: 'b6' },
});
check('可读性5｜临时产物被标注', tmpDoc.markdown.includes('临时产物'), '');
check('可读性5｜复核/发布脚本被标注', tmpDoc.markdown.includes('复核/发布脚本'), '');

// ─────────────────────────────────────────────────────────────
// 19. 输出档位：精简档（默认）/ 完整档
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 19. 输出档位：精简档 / 完整档 ════════');

const slimDoc = buildHandoffRaw({ events: [CTX, ...longReqEvents], header: { id: 'c1' } });
const fullDoc = buildHandoffRaw({
  events: [CTX, ...longReqEvents],
  header: { id: 'c1' },
  options: { profile: 'full' },
});

check(
  '精简档明显更短（附录 B 只展开第 1 条）',
  slimDoc.markdown.length < fullDoc.markdown.length * 0.75,
  `精简 ${slimDoc.markdown.length} / 完整 ${fullDoc.markdown.length}`,
);
check('精简档标注了「只展开第 1 条」', slimDoc.markdown.includes('精简档只展开第 1 条'));
check(
  '完整档保留全量附录 B 上限',
  fullDoc.markdown.includes('上限 12,000 字符') && !fullDoc.markdown.includes('精简档只展开'),
);
check('精简档只留最近 1 轮原文', slimDoc.markdown.includes('## 附录 A：最近 1 轮完整原文'));
check('完整档留 2 轮原文', fullDoc.markdown.includes('## 附录 A：最近 2 轮完整原文'));
check(
  '完整档保留成本拆解说明，精简档压缩掉',
  fullDoc.markdown.includes('被压缩历史') && !slimDoc.markdown.includes('被压缩历史'),
  `完整 ${fullDoc.markdown.includes('被压缩历史')} / 精简 ${slimDoc.markdown.includes('被压缩历史')}`,
);

// 决策条数上限提到 25（2026-09-15 用户选择）
const manyDecisions = Array.from(
  { length: 30 },
  (_, i) => `第 ${i + 1} 条结论：必须保留这个决定，不再改动。`,
).join('\n');
const manyDoc = buildHandoffRaw({
  events: [
    CTX,
    {
      type: 'assistant/message',
      seq: 1,
      time: 1000,
      data: {
        turn: 1,
        message: { content: [{ type: 'text', text: manyDecisions }] },
        usage: { totalTokens: 1000, outputTokens: 10 },
      },
    },
  ],
  header: { id: 'c3' },
});
const shownDecisions = manyDoc.markdown
  .split('\n')
  .filter((l) => l.startsWith('- [') && l.includes('条结论')).length;
check('决策条数上限 25', shownDecisions === 25, `实际显示 ${shownDecisions} 条`);
check('超出部分有「另有 N 条」提示', /另有 \d+ 条/.test(manyDoc.markdown));

// ─────────────────────────────────────────────────────────────
// 20. 复核修复回归（2026-09-15 第三批）
//     等级口径 / 冷会话评分 / 隐私与局限说明
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 20. 复核修复回归（等级口径 / 冷会话评分 / 提示）════════');

// 【遗留-1】等级文案不得含行动建议 —— 与 UI 半 LEVEL_META 同一口径
const levelValues = Object.values(LEVEL_LABEL);
check(
  '等级文案不含「建议」二字（等级只描述规模）',
  levelValues.every((v) => !v.includes('建议')),
  levelValues.join(' / '),
);
check(
  '等级文案与 UI 半一致（上下文偏大 / 上下文过大）',
  LEVEL_LABEL.warn === '上下文偏大' && LEVEL_LABEL.critical === '上下文过大',
  `${LEVEL_LABEL.warn} / ${LEVEL_LABEL.critical}`,
);

const healthSection = markdown.split('## 为什么交接')[1]?.split('\n## ')[0] ?? '';
check('健康度节不再出现「建议交接」这类等级标签', !healthSection.includes('—— 建议交接'));
check('健康度节声明「不含行动建议」', /不含(任何)?行动建议/.test(healthSection));
check('行动建议来源明确（异常 + 命中率成本）', healthSection.includes('行动依据只看'));

// 【P3-3】冷会话（无实时 health）用日志口径补算同一个评分函数
const coldDoc = buildHandoffRaw({
  events: [CTX, usageEvent(1, 300000), usageEvent(2, 320000)],
  header: { id: 'cold1' },
});
check('冷会话仍渲染评分行', /- 评分 \*\*\d+\/100\*\* —— /.test(coldDoc.markdown));
check('冷会话评分标注「日志折算」', coldDoc.markdown.includes('（日志折算）'));
check(
  '冷会话评分与日志用量自洽（320K / 有效窗口 600K → 75 分）',
  coldDoc.markdown.includes('75/100'),
  coldDoc.markdown.split('\n').find((l) => l.includes('评分')) ?? '',
);

// 【P3-2】有效窗口系数单一来源（index.js 不再自留一份）
check(
  '有效窗口系数由 COMPACT_DEFAULTS 提供（2026-09-16 边界设定：0.6）',
  COMPACT_DEFAULTS.effectiveWindowRatio === 0.6,
  String(COMPACT_DEFAULTS.effectiveWindowRatio),
);

// 评分函数是热 / 冷两条路径的唯一实现 —— 固定输入必须得到固定分数
const scored = scoreContextHealth({
  usedTokens: 300000,
  contextWindow: 1000000,
  repeatWorst: 3,
  degradedReplies: 1,
});
check(
  'scoreContextHealth 固定输入 → 固定分数（61 分 / watch）',
  scored.score === 61 && scored.level === 'watch',
  `${scored.score}/${scored.level}`,
);
check(
  'scoreContextHealth 的有效占用按有效窗口折算（300K / 600K = 50%）',
  Math.abs(scored.effectivePercent - 50) < 0.001,
  String(scored.effectivePercent),
);
check('scoreContextHealth 不给行动建议', !scored.findings.join(' ').includes('建议'));

// 【跨领域结论 3】隐私提醒
check('文档头有个人信息提醒', markdown.includes('可能含个人信息'));
check('精简档同样有个人信息提醒', slimDoc.markdown.includes('可能含个人信息'));

// 【跨领域结论 2】决策节注明抽取依据与跨领域局限（不扩词表，改为显式声明局限）
// 2026-09-15 复核 N-5 附带：跨领域词表改为**会话级分级兜底**（不再是一句"可能漏抽"），
// 所以这里断言的是"抽取依据 + 兜底状态"是否写清楚。
check(
  '关键决策节注明抽取依据与兜底状态',
  markdown.includes('取舍 / 结论类关键词') &&
    (markdown.includes('已启用通用结论词兜底') || markdown.includes('未启用**通用词兜底')),
  markdown.split('\n').find((l) => l.includes('抽取依据')) ?? '(无该行)',
);
check('精简档决策节同样注明依据', slimDoc.markdown.includes('抽取依据'));

// ─────────────────────────────────────────────────────────────
// 21. 有损压缩不该"治愈"评分（2026-09-15 复核【遗留-2】A+B）
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 21. 有损压缩不该"治愈"评分（遗留-2 A+B）════════');

// A：模型摘要次数 → 评分上限，取值全部压在 ok 阈值（80）以下
for (const [n, wantScore, wantLevel] of [
  [1, 79, 'watch'],
  [2, 65, 'watch'],
  [3, 50, 'warn'],
  [4, 50, 'warn'],
]) {
  const s = scoreContextHealth({
    usedTokens: 20494, // 刚压缩完，占用只有 4.1%
    contextWindow: 1000000,
    summaryCount: n,
  });
  check(
    `压缩 ${n} 次 → 封顶 ${wantScore} 分（${wantLevel}），不再回满`,
    s.score === wantScore && s.level === wantLevel,
    `${s.score}/${s.level}`,
  );
}

const neverCompacted = scoreContextHealth({ usedTokens: 20494, contextWindow: 1000000 });
check(
  '没压缩过的低占用会话不受影响（仍 100/ok）',
  neverCompacted.score === 100 && neverCompacted.level === 'ok',
  `${neverCompacted.score}/${neverCompacted.level}`,
);
check('没压缩过就不产生压缩依据', !neverCompacted.findings.join(' ').includes('模型摘要'));

// B：压缩史进入评分依据
const withTwo = scoreContextHealth({ usedTokens: 20494, contextWindow: 1000000, summaryCount: 2 });
check(
  '压缩史进入评分依据（B）',
  withTwo.findings.some((f) => f.includes('已经历 2 次模型摘要')),
  withTwo.findings.join(' | '),
);
check('压缩过必然不再是 ok（提示条不会消失）', withTwo.level !== 'ok', withTwo.level);

// 上限只降不升：压缩过、但当前占用极高时仍按实际扣分
const highAndCompacted = scoreContextHealth({
  usedTokens: 900000,
  contextWindow: 1000000,
  summaryCount: 1,
});
check(
  '上限只降不升（高占用仍按实际扣分 = 25）',
  highAndCompacted.score === 25,
  `${highAndCompacted.score}/${highAndCompacted.level}`,
);

// 端到端：冷会话（无实时 health）走日志口径，同样要封顶并说明原因
const capDoc = buildHandoffRaw({
  events: [
    CTX,
    usageEvent(1, 543662),
    {
      type: 'compaction/summary',
      seq: 2,
      time: 3000,
      data: {
        compactionId: 'cap1',
        shadowedTokenCount: 523168,
        summary: [{ type: 'text', text: '摘要' }],
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 380, outputTokens: 3167 },
      },
    },
    usageEvent(3, 20494), // 压缩后只剩 2 万
  ],
  header: { id: 'cap1' },
});
check(
  '交接文档里的评分也被封顶（不再是 100）',
  capDoc.markdown.includes('79/100'),
  capDoc.markdown.split('\n').find((l) => l.startsWith('- 评分')) ?? '',
);
check('文档说明了封顶原因', capDoc.markdown.includes('已经历 1 次模型摘要'));

// ─────────────────────────────────────────────────────────────
// 22. 全量复核 N-1 / N-3 / N-4（2026-09-15）
// ─────────────────────────────────────────────────────────────
console.log('\n════════ 22. 全量复核 N-1 / N-3 / N-4 ════════');

// N-1：离线 CLI 必须复用插件这条唯一的渲染路径 —— 结构上消灭"两份实现漂移"
const cliSource = fs.readFileSync(path.join(projectRoot, 'handoff.mjs'), 'utf8');
check('N-1：CLI 复用 lib/handoff.js（2026-09-18 包化后路径）', cliSource.includes("from './lib/handoff.js'"));
check('N-1：CLI 不再自行渲染（无 renderHandoff 调用）', !/renderHandoff\s*\(/.test(cliSource));
check('N-1：CLI 走的就是 buildHandoff', /buildHandoff\(\{/.test(cliSource));
check('N-1：CLI 的 --health 用同一评分函数', cliSource.includes('scoreContextHealth'));
const extractSource = fs.readFileSync(path.join(projectRoot, 'lib', 'extract.mjs'), 'utf8');
check('N-1：旧渲染层已标注弃用', extractSource.includes('@deprecated'));

// N-3：文档头要有"给接手方（新会话 AI）"的操作指引
check('N-3：完整档有「给接手方」指引', markdown.includes('给接手方'));
check('N-3：精简档也有「给接手方」指引', slimDoc.markdown.includes('给接手方'));
check('N-3：明确写出「不要回灌全部历史」', markdown.includes('不要回灌全部历史'));
check(
  'N-3：指引排在零模型声明之前（接手方先看到）',
  markdown.indexOf('给接手方') < markdown.indexOf('未调用任何模型'),
);

// N-4：附录 A 跳过"继续 / 好了"这类指令型轮次
const mkTurn = (n, promptText) => [
  { type: 'turn/start', seq: n * 10, time: n * 1000, data: { turn: n } },
  {
    type: 'user/message',
    seq: n * 10 + 1,
    time: n * 1000 + 100,
    data: { turn: n, source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] },
  },
  {
    type: 'assistant/message',
    seq: n * 10 + 2,
    time: n * 1000 + 200,
    data: {
      turn: n,
      message: { content: [{ type: 'text', text: `第 ${n} 轮的回复内容。` }] },
      usage: { totalTokens: 1000 * n, outputTokens: 20 },
    },
  },
  { type: 'turn/end', seq: n * 10 + 3, time: n * 1000 + 300, data: { turn: n, reason: 'completed' } },
];

const ctrlLastDoc = buildHandoffRaw({
  events: [CTX, ...mkTurn(1, '帮我核对一下成本模型的数字'), ...mkTurn(2, '继续')],
  header: { id: 'n4a' },
});
check(
  'N-4：末轮是指令型 → 往前顺延并在标题注明',
  ctrlLastDoc.markdown.includes('## 附录 A：最近 1 轮完整原文（已跳过 1 轮指令型输入：第 2 轮）'),
  ctrlLastDoc.markdown.split('\n').find((l) => l.startsWith('## 附录 A')) ?? '',
);
check('N-4：被跳过的轮次不再全文展开', !ctrlLastDoc.markdown.includes('**用户请求（原文 2 字）**'));

const noCtrlDoc = buildHandoffRaw({
  events: [CTX, ...mkTurn(1, '帮我核对一下成本模型的数字'), ...mkTurn(2, '把结论写进 README')],
  header: { id: 'n4b' },
});
check(
  'N-4：无指令型轮次时标题保持原样（零回归）',
  noCtrlDoc.markdown.includes('## 附录 A：最近 1 轮完整原文\n'),
  noCtrlDoc.markdown.split('\n').find((l) => l.startsWith('## 附录 A')) ?? '',
);

// ──────────────────────────────────────────────────────────────
// 23. 退化判据重做 + 思考纳入检测 + 分级词表 + 校准留痕
//     （2026-09-15 全量复核 N-5 / N-6，判据全部由**实测数据**重定）
// ──────────────────────────────────────────────────────────────
console.log('\n════════ 23. 退化判据重做 / 思考检测 / 校准（N-5、N-6）════════');

// ── 23a. 删掉的误报源：全篇中英比例（旧规则 5）──
// 实测：全量 73 会话里唯一在真实数据中触发的就是这条，25 次命中 **25/25 全是误报**，
// 却每条扣 6 分、最多扣 30 分。这里用同一形态的样本钉死"不再误报"。
const techReply =
  ('这次修复的核心是把三个口径统一起来，具体做法是先改 `plugin/handoff.js` 里的 ' +
    '`scoreContextHealth()`，再让 `plugin/index.js` 从同一处 import。参考 ' +
    'https://example.com/docs/attention-health 以及 `<TOOLS>\\scripts\\dsh-official` 的写法，' +
    '最后用 `node test/plugin-test.mjs` 验证。README 里那句"与 lib/detect.mjs 刻意保持一致"也要跟着改。') .repeat(2);
const techCjk = (techReply.match(/[\u4e00-\u9fff]/g) ?? []).length;
const techRatio = techCjk / techReply.length;
check(
  'N-5：样本确实落在旧规则 5 的命中区间（否则这条回归没有意义）',
  techReply.length > 400 && techRatio > 0.05 && techRatio < 0.25,
  `len=${techReply.length} 中文占比=${(techRatio * 100).toFixed(1)}%`,
);
check(
  'N-5：中文说明 + 英文代码/路径/URL 判正常（旧规则 5 的 25 条误报形态）',
  replyDegradeReasons(techReply).length === 0,
  JSON.stringify(replyDegradeReasons(techReply)),
);

// ── 23b. 框线字符不再算"符号堆砌"（旧规则 4 的误报源）──
const boxArt = '╔══════════════╦═══╗\n║ 上下文健康 ║ 65 ║\n╚══════════════╩═══╝';
check(
  'N-5：Unicode 边框表格判正常（框线字符已排除）',
  replyDegradeReasons(boxArt).length === 0,
  JSON.stringify(replyDegradeReasons(boxArt)),
);

// ── 23c. 短文本的结构性判据（旧版被全局 80 字门槛挡住）──
const fenceShort = '```js\nconst a = 1;';
const symShort = '◆◇■□▲△▼▽◆◇■□▲△▼▽◆◇';
const lineShort = '这一行重复了。\n这一行重复了。\n这一行重复了。';
const paraShort =
  '上下文已经很大了，建议先做一次机械交接再继续干活吧。\n\n中间夹一句别的话。\n\n上下文已经很大了，建议先做一次机械交接再继续干活吧。';
check('N-5：短文本围栏不闭合也判退化（旧版被 80 字门槛挡掉）', replyDegradeReasons(fenceShort).includes('fence'));
check('N-5：短文本符号堆砌也判退化', replyDegradeReasons(symShort).includes('symbolRun'));
check('N-5：短文本同行复读也判退化', replyDegradeReasons(lineShort).includes('lineRepeat'));
check('N-5：中文短段落重复也判退化（阈值 60 → 25 字）', replyDegradeReasons(paraShort).includes('paraRepeat'));
check('N-5：正常短句不误报', replyDegradeReasons('好的，我这就改。').length === 0);
check(
  'N-5：判据键都有中文标签（提示条与文档要显示命中原因）',
  ['fence', 'lineRepeat', 'paraRepeat', 'symbolRun', 'thinkLoop', 'thinkHuge', 'thinkBudget'].every(
    (k) => typeof DEGRADE_LABELS[k] === 'string' && DEGRADE_LABELS[k].length > 0,
  ),
);

// ── 23d. 思考检测（真实事故形态）──
// 事故样本 session-SAMPLE-bfd2b142：535,355 字符 / 116,152 行 / 只有 56 个唯一行 /
// 「好。」×69,667、「执行。」×23,214、「（执行）」×23,205、reasoningTokens 打满 256,000。
// 按同一形态缩小到 60 行做回归（判据只看重复率与行数）。
const loopThink = Array.from({ length: 60 }, (_, i) =>
  i % 3 === 0 ? '好。' : i % 3 === 1 ? '执行。' : '（执行）',
).join('\n');
check('N-5：思考打转（同几行反复 60 行）判 thinkLoop', reasoningDegradeReasons(loopThink).includes('thinkLoop'));
const uniqueThink = Array.from(
  { length: 120 },
  (_, i) => `第 ${i} 步：检查 ${i} 号文件的输出，确认与预期一致。`,
).join('\n');
check('N-5：行数很多但每行唯一的思考判正常（不因"长"就报警）', reasoningDegradeReasons(uniqueThink).length === 0);
check('N-5：单块 ≥10 万字符判 thinkHuge', reasoningDegradeReasons('A'.repeat(100000)).includes('thinkHuge'));
const rate60 = Array.from({ length: 100 }, (_, i) => (i < 40 ? `唯一行 ${i}` : '重复的行')).join('\n');
check(
  'N-5：重复率 0.6 不判（阈值取 0.7 —— 实测 0.5 会带 2 个正常代码块假阳性）',
  !reasoningDegradeReasons(rate60).includes('thinkLoop'),
);
const scanMixed = scanReasoning([
  { type: 'reasoning', text: loopThink },
  { type: 'text', text: '结论：一切正常。' },
]);
check('N-5：scanReasoning 只扫 reasoning 块', scanMixed.flagged && scanMixed.reasons.includes('thinkLoop'));
check('N-5：scanReasoning 报告最长重复次数', scanMixed.worstRepeat >= 20, `实际 ${scanMixed.worstRepeat}`);
check(
  'N-5：没有 reasoning 块时不误报',
  scanReasoning([{ type: 'text', text: '好。\n好。\n好。' }]).flagged === false,
);

// ── 23d-2. 符号堆砌：代码 / 正则不是退化 ──────────────────────────────────────
// 2026-09-15 复核实测（70 会话 / 3,638 思考块 + 2,271 回复块）：
// `symbolRun` 在思考侧命中 21 次、回复侧 1 次，**22/22 全部落在代码里**
// （正则字面量、JS 字符串、生成 Markdown 表格的语句）。模型"思考正则"时标点密度
// 天然极高 —— 那不是退化。原先的判据等于**因为模型思考正则而扣它 12 分**。
const asciiJunk = '[{()}<>;:,.]|+=*?!&#@%~^$][{()}<>;:,.]|+=*?!';
const fenceWithJunk = '```js\nconst RE = ' + asciiJunk + ';\n```';
const garbage = '※★☆●▲■◆○◇※★☆●▲■◆○◇※★☆●▲■◆○◇';
check(
  '复核：围栏代码块里的标点长串**不**判符号堆砌（旧版误报源）',
  !replyDegradeReasons(fenceWithJunk).includes('symbolRun'),
  JSON.stringify(replyDegradeReasons(fenceWithJunk)),
);
check(
  '复核：行内代码里的标点长串**不**判符号堆砌',
  !replyDegradeReasons('用 `' + asciiJunk + '` 判断纯符号行。').includes('symbolRun'),
);
check(
  '复核：裸的 ASCII 标点长串**不**判符号堆砌（实测 100% 是代码/正则）',
  !replyDegradeReasons('if (' + asciiJunk + '.test(line)) { return; }').includes('symbolRun'),
);
check(
  '复核：真乱码（非 ASCII 符号堆）仍判符号堆砌 —— 安全网没被削掉',
  replyDegradeReasons(garbage).includes('symbolRun'),
  JSON.stringify(replyDegradeReasons(garbage)),
);

// ── 23d-3. 思考预算：真实计量判据（2026-09-15 复核新增）─────────────────────
// 依据：3,534 条带 `usage.reasoningTokens` 的消息 p99=4,237，真事故那条 = 256,000（打满上限）。
// 门槛取 16,000（≈4×p99），全量语料零误报。
const budgetBlocks = [{ type: 'reasoning', text: uniqueThink }];
check(
  '复核：reasoningTokens ≥ 16000 判 thinkBudget（真实计量，与字符数无关）',
  scanReasoning(budgetBlocks, { reasoningTokens: 16000 }).reasons.includes('thinkBudget'),
);
check(
  '复核：reasoningTokens 低于门槛不判（门槛 16000 是实测取的）',
  scanReasoning(budgetBlocks, { reasoningTokens: 15999 }).flagged === false,
);
check(
  '复核：思考正文没落盘也能判预算（只靠 usage，块为空也生效）',
  scanReasoning([], { reasoningTokens: 256000 }).reasons.includes('thinkBudget'),
);
check(
  '复核：缺 usage 时不做预算判定（向后兼容旧调用）',
  scanReasoning(budgetBlocks).flagged === false,
);

// ── 23d-4. 上下文规模：热 / 冷 / 离线三处必须同口径（2026-09-15 复核）──────────
// 多功能交叉验证实测：全量语料里**只有 52% 的 assistant/message 带 `usage.totalTokens`**，
// 而冷路径（本文件的 foldSession）与 lib/extract.mjs 原先都只认它 ——
// 于是同一会话会出现"提示条说 13,652、交接文档说 0 且判 100 分正常"。
const noTotalUsage = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1100,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1200,
    data: {
      turn: 1,
      message: { content: [{ type: 'text', text: '好' }] },
      usage: { inputTokens: 11308, cacheReadTokens: 1024, outputTokens: 1320 },
    },
  },
  { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
];
check(
  '复核：缺 totalTokens 时冷路径用"三项相加"（与热路径同口径）',
  foldSession(noTotalUsage).usage.lastContextTokens === 13652,
  String(foldSession(noTotalUsage).usage.lastContextTokens),
);
check('复核：contextTokensOf 优先 totalTokens', contextTokensOf({ totalTokens: 999, inputTokens: 1 }) === 999);
check(
  '复核：contextTokensOf 忽略 NaN / Infinity（否则会产出非法 state）',
  contextTokensOf({ totalTokens: NaN, inputTokens: Infinity }) === 0 &&
    contextTokensOf({ inputTokens: -Infinity }) === 0 &&
    contextTokensOf(null) === 0,
);
check(
  '复核：contextTokensOf 只接受有限正数（0 与负数按"无法判断"处理）',
  contextTokensOf({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }) === 0,
);

// ── 23d-5. 边界：缺数据时「继续」与「无法判断」必须分开（2026-09-16）──────────
// 旧实现把档位默认成 `continue`、文案写成"继续（有效窗口 <50%）"，于是在一个
// 从未记录过 `request/context` 的会话里，界面/文档会**言之凿凿地给出"继续"**，
// 而真相是"根本没有数据可判"。缺数据时说"无法判断"才是诚实的。
const noData = deriveCompactionPlan({ usedTokens: 0, contextWindow: null });
check(
  '边界：缺数据时档位文案说"无法判断"，而不是"继续（有效窗口 <50%）"',
  noData.compact.bandText.includes('无法判断'),
  noData.compact.bandText,
);
check('边界：缺数据时最终文案交代"数据不足"', noData.final.adviceText.includes('数据不足'), noData.final.adviceText);
check(
  '边界 P3：缺数据时界面依据说明**怎样才会有数据**，而不是复述结论',
  noData.final.note.includes('下一次请求后'),
  noData.final.note,
);
check('边界：缺数据仍判 continue（不无端打扰用户）', noData.final.advice === 'continue', noData.final.advice);

// 20% 声明窗口 → 档位 continue、质量 continue、最终"可以继续"（确保正常情况没被边界改掉）
const withData = deriveCompactionPlan({ usedTokens: 200000, contextWindow: 1000000 });
check(
  '对照：有数据时档位文案照旧（边界没有把正常情况也改掉）',
  withData.compact.bandText.includes('正常（占声明窗口 <50%）'),
  withData.compact.bandText,
);
check('对照：有数据时最终文案是"可以继续"', withData.final.adviceText.includes('可以继续'), withData.final.adviceText);

// ── 23d-6. 界面依据（`final.note`）：一句话、无 Markdown、Explain "为什么" ──
check('依据：note 是给界面的，不含 Markdown 粗体', !withData.final.note.includes('**'), withData.final.note);
check('依据：note 与给文档的 reason 分工不同（reason 才是完整论证）', typeof withData.final.reason === 'string' && withData.final.reason.length > 0);
// 55% 声明窗口（≥50%）且已发生 3 次**模型摘要**。
// 2026-09-16 用户报告「每次压缩后建议都变成机械交接 + 新开会话」→ 这条覆盖规则加了**成本闸门**：
//   · 钱支持新开（缓存真崩）→ 仍然交接（见下一组断言）；
//   · 钱不支持、或压根没有成本依据 → 降级为继续 + 一句事实提示，不再劫持按钱算出的结论。
const threeSummaries = deriveCompactionPlan({ usedTokens: 550000, contextWindow: 1000000, summaryCount: 3 });
check(
  '闸门：摘要 3 次但无成本依据 → 不再无条件判交接',
  threeSummaries.final.advice === 'continue',
  threeSummaries.final.advice,
);
check(
  '闸门：该情形仍把"有损摘要"这个事实写进 note（信息不丢失）',
  threeSummaries.final.note.includes('有损摘要'),
  threeSummaries.final.note,
);
check(
  '闸门：note 不含 Markdown（界面直接显示，不做二次清洗）',
  !threeSummaries.final.note.includes('**'),
  threeSummaries.final.note,
);

// 同一情形（摘要 3 次 + 55% 占用）但**缓存真崩了**（命中率 0%）→ 钱支持新开 → 覆盖规则仍然生效。
// 这条保证"加了闸门"不等于"废掉规则"：该劝交接的时候照样劝。
const threeSummariesCacheDead = deriveCompactionPlan({
  usedTokens: 550000,
  contextWindow: 1000000,
  summaryCount: 3,
  cacheReadTokens: 0,
  cacheMissTokens: 550000,
  usageCount: 500,
});
check(
  '闸门：缓存真崩（命中率 0%）时覆盖规则仍然生效 → 交接',
  threeSummariesCacheDead.final.advice === 'handoff',
  `${threeSummariesCacheDead.final.advice}/${threeSummariesCacheDead.final.drivenBy}`,
);
check(
  '依据：该情形的 note 点明"反复摘要收益递减"',
  threeSummariesCacheDead.final.note.includes('收益递减'),
  threeSummariesCacheDead.final.note,
);
check(
  '依据：note 不复述占用率（那是维度行的职责，避免同一信息渲染两遍）',
  !/\d+(\.\d+)?%/.test(threeSummariesCacheDead.final.note),
  threeSummariesCacheDead.final.note,
);
// 65% 声明窗口（recommend 档）但"可压缩余量"只剩 1.5%（基线 640k vs 当前 650k）
// → 压缩收益 ≈ 0，应退回"继续"并把原因写进 note。
// 注意要**给增长数据**：否则会先命中"估不出轮数 → 用声明窗口代理"那条规则，
// 测到的就不是本意了。avgRoundGrowth=20k → 距官方线 150k/20k = 7 轮 < 30，不推迟。
const noWorth = deriveCompactionPlan({
  usedTokens: 650000,
  contextWindow: 1000000,
  avgRoundGrowth: 20000,
  compactionCount: 1,
  summaryCount: 0,
  lastCompaction: { shadowedTokens: 1, afterUsedTokens: 640000 },
});
check('依据：可压缩余量太小时不硬推压缩', noWorth.final.advice === 'continue', noWorth.final.advice);
check(
  '依据：该情形的 note 说明"压缩收益 ≈ 0"',
  noWorth.final.note.includes('收益'),
  noWorth.final.note,
);

// ── 23d-7. 推迟压缩：距官方线还很远时不该催（2026-09-16 用户反馈）────────────
// 反馈场景原型：上下文不小、档位已到"推荐压缩"，**但距官方自动压缩线还有几百轮**。
// 判据是"压缩要能兑现收益"：官方线还很远 = 短期不会撞线 = 现在压是纯支出。
// 2026-09-16 边界设定后档位锚在**声明窗口**，所以这里用 68% 声明（recommend 档）。
const farLine = deriveCompactionPlan({ usedTokens: 680000, contextWindow: 1000000, avgRoundGrowth: 1000 });
check(
  '推迟：距官方线还有数百轮 → 不再建议现在压缩',
  farLine.final.advice === 'continue',
  `${farLine.final.advice} / ${farLine.final.note}`,
);
check('推迟：文案明确"无需交接"', farLine.final.adviceText.includes('无需交接'), farLine.final.adviceText);
check(
  '推迟：依据里给出具体轮数（用户能自己核对）',
  farLine.final.note.includes('轮') && farLine.final.note.includes('无需手动压缩'),
  farLine.final.note,
);
check(
  '推迟：档位信息仍然保留（只在展开区展示，不上升为行动项）',
  farLine.compact.band === 'recommend',
  farLine.compact.band,
);
check('推迟：note 不含 Markdown（界面用）', !farLine.final.note.includes('**'), farLine.final.note);

// 对照：同样 68% 声明 + 快速增长，但**没有命中率实测** → 不做成本裁决，保守判继续。
// （真实价格引入后，"该不该压"要花会算钱；没有命中率实测就无从算起，此时不许拿假设值劝人。）
const nearLine = deriveCompactionPlan({ usedTokens: 680000, contextWindow: 1000000, avgRoundGrowth: 20000 });
check(
  '对照：缺命中率实测 → 不做成本裁决，保守继续',
  nearLine.final.advice === 'continue',
  `${nearLine.final.advice} / ${nearLine.final.note}`,
);

// 对照 2（2026-09-16 用户重定位）：占声明 80%（官方线本身）→ **不再劝手动压缩**。
// 该点手动压要一次性 ¥0.5、回本 35 轮，而到官方线只剩 0~1 轮 —— 必然摊不完；
// 官方到线会先做零 token 无损修剪，可能根本不需要摘要。
const urgentBand = deriveCompactionPlan({ usedTokens: 800000, contextWindow: 1000000, avgRoundGrowth: 20000 });
check(
  '对照：到官方线（80% 声明）→ 继续（不劝手动压缩）',
  urgentBand.compact.band === 'urgent' && urgentBand.final.advice === 'continue',
  `${urgentBand.compact.band} / ${urgentBand.final.advice} / ${urgentBand.final.note}`,
);
check(
  '对照：该分支由 official 驱动（说明官方会自己处理）',
  urgentBand.final.drivenBy === 'official',
  String(urgentBand.final.drivenBy),
);
check(
  '对照：该情形的 note 说明"无需手动压缩"',
  urgentBand.final.note.includes('无需手动压缩'),
  urgentBand.final.note,
);
// 对照 2b：65% 声明（推荐档）但官方线还有 150 轮 → 推迟规则**同样适用于推荐档**（判据是成本，不是档位）
const urgentFar = deriveCompactionPlan({ usedTokens: 650000, contextWindow: 1000000, avgRoundGrowth: 1000 });
check(
  '对照：推荐档但官方线还有一百多轮 → 同样推迟（判据是成本，不是档位）',
  urgentFar.compact.band === 'recommend' && urgentFar.final.advice === 'continue',
  `${urgentFar.compact.band} / ${urgentFar.final.advice} / ${urgentFar.final.note}`,
);

// 对照 3：估不出轮数时用声明窗口占比作代理 —— 占 55% 声明（低于 60% 代理线）→ 推迟。
// 2026-09-16 边界设定：代理线从 50 → 60，否则它与档位起点（50）重合，这条判据永远不可达。
const noGrowth = deriveCompactionPlan({ usedTokens: 550000, contextWindow: 1000000 });
check(
  '对照：估不出轮数但只占声明窗口 55%（<60 代理线）→ 继续，且说明无需手动压缩',
  noGrowth.final.advice === 'continue' && noGrowth.final.note.includes('无需手动压缩'),
  `${noGrowth.final.advice} / ${noGrowth.final.note}`,
);

// ── M 节（2026-09-18）：压缩后"有历史退化 + 占用低"不许说"未检出 / 健康" ──
//
// 用户报告的真实场景：旧会话手动压缩后 765,582 → 21,090 token，
// 同一份文档里维度 A 写"思考打转 10 次 → 已检出"，最终理由却写"未检出退化信号"。
// 根因是两处文案**没看 `degraded`**、无条件写死。这里正反两例都钉住。
{
  const lowWithDegrade = deriveCompactionPlan({
    usedTokens: 21090,
    contextWindow: 1000000,
    reasoningLoop: 10,
    repeatWorst: 1,
  });
  const qr = String(lowWithDegrade.quality.reason ?? '');
  const fr = String(lowWithDegrade.final.reason ?? '');
  check('M：有退化 + 占用低 → 维度 A 不得写「质量维度健康」', !qr.includes('质量维度健康'), qr.slice(0, 130));
  check('M：有退化 + 占用低 → 最终理由不得写「未检出退化信号」', !fr.includes('未检出退化信号'), fr.slice(0, 150));
  check(
    'M：如实列出检出的信号（历史退化不被静默抹去）',
    qr.includes('思考打转 10 次') && fr.includes('思考打转 10 次'),
    `${qr.slice(0, 70)} … ${fr.slice(0, 70)}`,
  );

  // 反例：**无**退化 + 占用低 → 必须保留原意
  // （修文案最容易犯的错是"一刀切删掉"，把真健康也说成有问题 —— 那是另一种不诚实。）
  const lowClean = deriveCompactionPlan({ usedTokens: 21090, contextWindow: 1000000 });
  check(
    'M 反例：无退化 + 占用低 → 仍写「质量维度健康」',
    String(lowClean.quality.reason).includes('质量维度健康'),
    String(lowClean.quality.reason).slice(0, 130),
  );
  check(
    'M 反例：无退化 + 占用低 → 仍写「未检出退化信号」',
    String(lowClean.final.reason).includes('未检出退化信号'),
    String(lowClean.final.reason).slice(0, 130),
  );
}

// ── R 节（2026-09-18）：守卫信号必须进判定链（最硬的退化证据）────────────────
//
// 现场：`session-SAMPLE-bdde842b` 被守卫掐断 4 次（"做。"决策循环），有效占用只有 49.5% ——
// 旧实现里质量维度说"继续"，最终建议只能靠**成本**驱动，而成本上只省 ¥0.10，
// 界面理由被写成"继续会话已不划算"。**结论对、理由错。**
// 修法两条：守卫次数进 `degraded`；"反复掐断（≥2）"单列一条**不看规模**的门。
{
  const guardOnly = deriveCompactionPlan({
    usedTokens: 296987,
    contextWindow: 999000,
    // 质量信号全零 —— 只有守卫掐断
    guardTripCount: 4,
  });
  check(
    'R：守卫掐断 4 次 + 质量信号全零 → 判定为交接',
    guardOnly.final.advice === 'handoff',
    `${guardOnly.final.advice} / ${guardOnly.final.note}`,
  );
  check(
    'R：理由必须提到守卫 / 空转（不得只写「不划算」）',
    /守卫|空转/.test(String(guardOnly.final.reason)) && /守卫|空转/.test(String(guardOnly.quality.reason)),
    String(guardOnly.final.reason).slice(0, 170),
  );
  check(
    'R：界面依据点名守卫与次数',
    /守卫/.test(String(guardOnly.final.note)) && String(guardOnly.final.note).includes('4 次'),
    String(guardOnly.final.note),
  );
  check(
    'R：由守卫驱动时 drivenBy = quality（不再是成本）',
    guardOnly.final.drivenBy === 'quality',
    String(guardOnly.final.drivenBy),
  );
}
{
  // 反例：同样的会话**去掉守卫计数** → 行为必须不变（不得因修 R 而误伤）
  const noGuard = deriveCompactionPlan({ usedTokens: 296987, contextWindow: 999000 });
  check(
    'R 反例：guardTripCount=0 时行为不变（仍是继续）',
    noGuard.final.advice === 'continue',
    `${noGuard.final.advice} / ${noGuard.quality.reason}`,
  );
}
{
  // 边界①：只掐断 1 次 → 计入退化，但**不**走"不看规模"那条门（偶发不等于不可靠）
  // AF.2（2026-09-20）：这一档的结论从 `continue` 升为 `prepare` —— 语义正是"边界快到了"
  // （已检出退化信号、但还没到该交接的程度）；`degraded` 仍必须为真。
  const once = deriveCompactionPlan({ usedTokens: 296987, contextWindow: 999000, guardTripCount: 1 });
  check(
    'R 边界：只掐断 1 次不直接判交接，但已计入退化（AF.2 起结论是 prepare）',
    once.final.advice === 'prepare' && once.quality.degraded === true,
    `${once.final.advice} / degraded=${once.quality.degraded}`,
  );
  // 边界②：同样 1 次，但占用够高 → 双条件门的"退化"一侧成立 → 建议交接
  const onceBig = deriveCompactionPlan({ usedTokens: 500000, contextWindow: 999000, guardTripCount: 1 });
  check(
    'R 边界：占用 ≥70% 且掐断过 → 走双条件门判交接',
    onceBig.final.advice === 'handoff' && onceBig.quality.advice === 'handoff',
    `${onceBig.final.advice} / ${onceBig.quality.advice}`,
  );
}

// ── S 节（2026-09-18）：成本通道的「最小节省额」门槛 ────────────────────────
//
// 三个会话同样判"交接"，节省额却差 10 倍（¥0.023 / ¥0.100 / ¥0.235）——
// 只给结论不给金额，用户无从判断哪个值得听。修法：成本通道加 ¥0.15 门槛，
// **质量通道（退化 / 守卫）不受约束** —— 那是"能不能干活"，不是钱的问题。
check(
  'S：门槛常量存在（minSavingYuan = 0.15）',
  COMPACT_DEFAULTS.minSavingYuan === 0.15,
  String(COMPACT_DEFAULTS.minSavingYuan),
);
{
  // S.4 要求的**真实会话回归**（口径走 `compactionInputOf`，与渲染同一份实现）
  //
  // ⚠️ 2026-09-20 AB.3 口径修正后，**`fcafee61` 从"继续"翻成"交接"** —— 这不是回归，
  // 而是修正后的正确结果：旧口径把"每次请求"的钱当成"每轮"的钱，该会话省额被少算了
  // 约 40 倍（sp≈39.9：¥0.054 → **¥2.15**），于是被 ¥0.15 门槛挡在外面。
  // 复核侧 AB.3 的原话就是"该劝的会话没劝"；这里把期望值改成真值，并把原因写在标签里。
  const cases = [
    ['fcafee61', 'handoff', 'AB.3 口径修正后省额 ¥2.15（旧口径 ¥0.054 被门槛误挡）'],
    ['d346d3e8', 'handoff', '无退化 + 节省额过门槛'],
    ['d854e8b5', 'handoff', '守卫反复掐断 → 走质量通道（不受金额约束）'],
  ];
  const sessions = listSessions();
  for (const [key, want, why] of cases) {
    const s = sessions.find((x) => String(x.file ?? '').includes(key));
    if (!s) {
      console.log(`  ⚠️ 跳过 ${key}（本机没有这个会话）`);
      continue;
    }
    const x = foldSession(readSession(s.file).events);
    const endedTurns = x.turns.filter((t) => t.turn !== x.openTurn && typeof t.contextTokens === 'number');
    const deltas = [];
    for (let i = 1; i < endedTurns.length; i += 1) {
      const d = endedTurns[i].contextTokens - endedTurns[i - 1].contextTokens;
      if (d > 0) deltas.push(d);
    }
    const avgGrowth = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
    const plan = deriveCompactionPlan(compactionInputOf(x, { avgRoundGrowth: avgGrowth }));
    check(
      `S.4 真实会话 ${key}（${why}）→ ${want}`,
      plan.final.advice === want,
      `${plan.final.advice}（节省 ¥${plan.cost.savingYuan?.toFixed(3)} / 门槛通过=${plan.cost.savingEnough}）`,
    );
  }
}

// ── T 节（2026-09-18）：价格配置化 / 峰谷档位 / 模型感知 / 未知降级 ──────────
//
// 修改前的三处静默风险：价格硬编码（调价要改代码）、不感知模型（flash→pro 价差 3~4.5 倍）、
// 全程按空闲价（白天实际翻倍 → 用户干活时恰好低估一半）。
{
  const pricesMod = await import(pathToFileURL(path.join(path.dirname(target), 'prices.js')).href);
  const bj = (h) => new Date(Date.UTC(2026, 8, 18, h - 8, 0, 0)); // 2026-09-18 是周五
  check('T：工作日北京时间 10:00 → 高峰', pricesMod.isPeakTime(bj(10)) === true);
  check('T：工作日北京时间 15:00 → 高峰', pricesMod.isPeakTime(bj(15)) === true);
  check('T：工作日北京时间 13:00（午休）→ 空闲', pricesMod.isPeakTime(bj(13)) === false);
  check('T：工作日北京时间 20:00 → 空闲', pricesMod.isPeakTime(bj(20)) === false);
  check(
    'T：周六任意时刻 → 空闲',
    pricesMod.isPeakTime(new Date(Date.UTC(2026, 8, 19, 2, 0, 0))) === false,
  );

  const pro = pricesMod.resolvePrice('deepseek-v4-pro-expires-on-0910', bj(10));
  check(
    'T：pro 模型（含有效期后缀）→ 按 pro 高峰价（未命中 9 元）',
    pro.known === true && pro.modelMatched === true && pro.price.cacheMissPerMillion === 9,
    JSON.stringify(pro.price),
  );
  const flash = pricesMod.resolvePrice('deepseek-v4.1-flash-expires-on-0910', bj(20));
  check(
    'T：flash 模型 + 空闲档 → 未命中 1 元（与官方页一致）',
    flash.known === true && flash.price.cacheMissPerMillion === 1 && flash.price.outputPerMillion === 4,
    JSON.stringify(flash.price),
  );
  const unknown = pricesMod.resolvePrice('some-unknown-model', bj(20));
  check('T：未知模型 → known=false（成本通道将跳过）', unknown.known === false, JSON.stringify(unknown));
  const noModel = pricesMod.resolvePrice(null, bj(20));
  check(
    'T：缺模型名 → 仍能估算，但 modelMatched=false（如实标注）',
    noModel.known === true && noModel.modelMatched === false,
    JSON.stringify(noModel),
  );
}
{
  // 配置化：自定义 prices.json 生效；损坏 / 缺失 → 回落内置核对值且**不报错**
  const tmpHome = fs.mkdtempSync(path.join(projectRoot, 'work', 'prices-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const pricesMod = await import(pathToFileURL(path.join(path.dirname(target), 'prices.js')).href);
    pricesMod.resetPriceCache();
    const builtin = pricesMod.loadPrices();
    check('T：没有 prices.json → 用内置核对值', builtin.fromFile === false && builtin.models.length >= 2);

    fs.mkdirSync(path.join(tmpHome, 'attention-health'), { recursive: true });
    fs.writeFileSync(
      pricesMod.pricesFile(),
      JSON.stringify({
        fetchedAt: '2026-01-01',
        models: [{ prefix: 'deepseek-v4.1-flash', offPeak: { hit: 0.01, miss: 0.5, out: 2 }, peak: { hit: 0.02, miss: 1, out: 4 } }],
      }),
      'utf8',
    );
    pricesMod.resetPriceCache();
    const custom = pricesMod.loadPrices();
    check(
      'T：自定义 prices.json 生效（配置优先）',
      custom.fromFile === true && custom.fetchedAt === '2026-01-01',
      String(custom.fetchedAt),
    );
    check(
      'T：自定义价被实际采用',
      pricesMod.resolvePrice('deepseek-v4.1-flash', new Date(Date.UTC(2026, 8, 18, 12, 0, 0))).price.cacheMissPerMillion === 0.5,
    );

    fs.writeFileSync(pricesMod.pricesFile(), '{ 这不是合法 JSON', 'utf8');
    pricesMod.resetPriceCache();
    const broken = pricesMod.loadPrices();
    check('T：prices.json 损坏 → 回落内置值且不抛错', broken.fromFile === false);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    // 清掉缓存，免得后续用例读到临时目录的那份
    const pricesMod = await import(pathToFileURL(path.join(path.dirname(target), 'prices.js')).href);
    pricesMod.resetPriceCache();
  }
}
{
  // 峰谷影响金额：同一会话，高峰档的每轮成本应约为空闲档的两倍
  const base = {
    usedTokens: 500000,
    contextWindow: 999000,
    avgRoundGrowth: 20000,
    usageCount: 5,
    cacheReadTokens: 0,
    cacheMissTokens: 500000,
    avgOutputTokens: 600,
    model: 'deepseek-v4.1-flash',
  };
  const off = deriveCompactionPlan({ ...base, now: new Date(Date.UTC(2026, 8, 18, 12, 0, 0)) }); // 北京 20:00
  const peak = deriveCompactionPlan({ ...base, now: new Date(Date.UTC(2026, 8, 18, 2, 0, 0)) }); // 北京 10:00
  check(
    'T：高峰档的每轮金额约为空闲档的 2 倍（此前全程按空闲价 = 白天低估一半）',
    peak.cost.continuePerRound > off.cost.continuePerRound * 1.8,
    `${off.cost.continuePerRound} → ${peak.cost.continuePerRound}`,
  );
  check('T：档位与价格说明随之下发', peak.cost.priceTier === 'peak' && off.cost.priceTier === 'offPeak', `${peak.cost.priceTier}/${off.cost.priceTier}`);
  // AF.1（2026-09-20）：价表复核后 `fetchedAt` 从 09-18 更新为 09-20（同一次复核也重抓了官方定价页）
  check('T：价格说明含来源与日期', /2026-09-20/.test(String(peak.cost.priceLabel)), String(peak.cost.priceLabel));
}

// ── AF.1（2026-09-20）：外部核对清单 B1 / B2（复核侧独立验证 + 官方原文）────────
//
// B1：官方现行模型名是 `deepseek-flash`（旧名仍可调用但已下线，按 Flash 价计费）。
//     前缀表缺它 → `known=false` → **整条成本通道静默跳过**（不报错，最难发现的那种）。
// B2：官方口径是「周一至周五（**不含中国法定节假日**）9-12/14-18 为高峰」——
//     之前只有"星期几+小时"，国庆/春节白天被按高峰价 ×2。
{
  const pricesMod = await import(pathToFileURL(path.join(path.dirname(target), 'prices.js')).href);
  const bjEv = (h) => new Date(Date.UTC(2026, 8, 18, h - 8, 0, 0)); // 2026-09-18（周五）
  const utc = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h - 8, 0, 0)); // 北京 h 点

  // B1
  const cur = pricesMod.resolvePrice('deepseek-flash', bjEv(20));
  check(
    'B1：官方现行名 `deepseek-flash` → 认识且按 flash 空闲价（未命中 1 元）',
    cur.known === true && cur.modelMatched === true && cur.price.cacheMissPerMillion === 1,
    JSON.stringify({ known: cur.known, matched: cur.modelMatched, p: cur.price }),
  );
  check(
    'B1：旧名仍认识（`deepseek-v4-flash` / `deepseek-v4.1-flash-…`）—— 不能为补新名而删旧名',
    pricesMod.resolvePrice('deepseek-v4-flash', bjEv(20)).modelMatched === true &&
      pricesMod.resolvePrice('deepseek-v4.1-flash-expires-on-0910', bjEv(20)).modelMatched === true,
  );
  check(
    'B1：pro 系列不受影响（价差 4.5 倍仍按 pro 表）',
    pricesMod.resolvePrice('deepseek-v4-pro', bjEv(20)).price.cacheMissPerMillion === 4.5,
  );

  // B2
  check(
    'B2：国庆 10/1 上午 → 空闲（此前误判高峰、金额 ×2）',
    pricesMod.isPeakTime(utc(2026, 10, 1, 10)) === false,
    String(pricesMod.isPeakTime(utc(2026, 10, 1, 10))),
  );
  check('B2：春节 2/17 上午 → 空闲', pricesMod.isPeakTime(utc(2026, 2, 17, 10)) === false);
  check('B2：清明 4/6（周一）上午 → 空闲', pricesMod.isPeakTime(utc(2026, 4, 6, 10)) === false);
  check('B2：2027-01-01（周五，安排未公布但日期固定）→ 空闲', pricesMod.isPeakTime(utc(2027, 1, 1, 10)) === false);
  check(
    'B2：**不**把调休补班的周末算高峰（官方字面"周一至周五"）',
    pricesMod.isPeakTime(utc(2026, 1, 4, 10)) === false && pricesMod.isPeakTime(utc(2026, 10, 10, 10)) === false,
  );
  check(
    'B2：普通工作日未被误伤（2026-09-21 周一 10:00 → 高峰）',
    pricesMod.isPeakTime(utc(2026, 9, 21, 10)) === true,
  );
  check(
    'B2：节假日表可被调用方覆盖（prices.json 的 holidays 优先）',
    pricesMod.isPeakTime(utc(2026, 9, 21, 10), ['2026-09-21']) === false &&
      pricesMod.isPeakTime(utc(2026, 9, 21, 10), []) === true,
  );
  check(
    'B2：节假日档位会影响金额与说明（10/1 按空闲价，说明标注法定节假日）',
    (() => {
      const p = deriveCompactionPlan({
        usedTokens: 500000,
        contextWindow: 999000,
        usageCount: 5,
        cacheReadTokens: 0,
        cacheMissTokens: 500000,
        avgOutputTokens: 600,
        model: 'deepseek-flash',
        now: utc(2026, 10, 1, 10),
      });
      return p.cost.priceTier === 'offPeak' && /法定节假日/.test(String(p.cost.priceLabel));
    })(),
  );
}
{
  // 未知模型 → 成本通道**不裁决**（T-6）
  const p = deriveCompactionPlan({
    usedTokens: 500000,
    contextWindow: 999000,
    avgRoundGrowth: 20000,
    usageCount: 5,
    cacheReadTokens: 400000,
    cacheMissTokens: 100000,
    avgOutputTokens: 600,
    model: 'totally-unknown-model',
  });
  check(
    'T：未知模型 → 成本不裁决（freshWinsOnCost=false，priceKnown=false）',
    p.cost.freshWinsOnCost === false && p.cost.priceKnown === false,
    JSON.stringify({ fresh: p.cost.freshWinsOnCost, known: p.cost.priceKnown }),
  );
  check('T：未知模型的价格说明如实说"已跳过"', /跳过/.test(String(p.cost.priceLabel)), String(p.cost.priceLabel));
}

// ── 23d-8. 界面文案表：O2 / P2 / P3（2026-09-16 Codex 审查）──────────────────
check(
  'O2：界面依据已抽成 FINAL_NOTES 常量表',
  FINAL_NOTES && typeof FINAL_NOTES === 'object' && Object.keys(FINAL_NOTES).length >= 9,
  String(FINAL_NOTES ? Object.keys(FINAL_NOTES).length : 'undefined'),
);
// 表里的值可能是字符串，也可能是 (n)=>string 这样的工厂；两种都过一遍。
const noteValues = Object.entries(FINAL_NOTES ?? {}).map(([k, v]) => [
  k,
  typeof v === 'function' ? v(3) : v,
]);
check(
  'P2：所有界面依据都不含 Markdown 标记（host 侧自查）',
  noteValues.every(([, v]) => typeof v === 'string' && !/[`*]/.test(v)),
  JSON.stringify(noteValues.filter(([, v]) => typeof v !== 'string' || /[`*]/.test(v))),
);
check(
  'P3：缺数据那条依据说明"怎样才会有数据"',
  FINAL_NOTES.dataMissing.includes('下一次请求后'),
  FINAL_NOTES.dataMissing,
);
check(
  'P3：缺数据那条**不复述**"按现状继续"（结论已经在 adviceText 里）',
  !FINAL_NOTES.dataMissing.includes('继续'),
  FINAL_NOTES.dataMissing,
);

// P1 的**文档侧**守卫（2026-09-16 Codex 审查）：文档本来就靠 `breakEvenRounds !== null`
// 守住了"每轮省"那句，但那是隐式的 —— 补一条显式回归，免得以后被改坏。
// 场景：刚压缩过、可压缩余量只剩 6.25% → 结论"继续"，且不该出现任何省钱暗示。
const noWorthDoc = buildHandoff({
  events: [
    CTX,
    {
      type: 'compaction/summary',
      seq: 1,
      time: 500,
      data: { shadowedTokenCount: 20000, summary: 'x', usage: { outputTokens: 2000, inputTokens: 3000 } },
    },
    usageEvent(2, 300000, { turn: 1 }),
    usageEvent(3, 320000, { turn: 2 }),
  ],
  header: { id: 'k5' },
});
check(
  'P1 文档侧：可压缩余量太小时，文档不给出"每轮省"暗示',
  !noWorthDoc.markdown.includes('每轮省'),
  noWorthDoc.markdown.split('\n').filter((l) => l.includes('省')).join(' | ').slice(0, 200),
);
check(
  'P1 文档侧：该情形文档明确建议继续',
  noWorthDoc.markdown.includes('建议继续'),
  noWorthDoc.markdown.split('\n').filter((l) => l.includes('继续')).join(' | ').slice(0, 200),
);

// ── 23e. 思考退化参与评分 ──
const base300 = { usedTokens: 300000, contextWindow: 1000000 }; // 有效占用 60% → −25
const noThink = scoreContextHealth({ ...base300 });
const oneLoop = scoreContextHealth({ ...base300, reasoningLoop: 1, reasoningWorstRepeat: 69667 });
check(
  'N-5：思考打转一次扣 25 分',
  noThink.score - oneLoop.score === 25,
  `${noThink.score} → ${oneLoop.score}`,
);
check(
  'N-5：findings 说清打转次数与最长重复次数（事实，不含行动建议）',
  oneLoop.findings.some((f) => f.includes('打转') && f.includes('69,667')),
  oneLoop.findings.join(' | '),
);
const twoLoop = scoreContextHealth({ ...base300, reasoningLoop: 2 });
const fiveLoop = scoreContextHealth({ ...base300, reasoningLoop: 5 });
check('N-5：打转扣分有上限（−50）', fiveLoop.score === twoLoop.score, `${twoLoop.score} vs ${fiveLoop.score}`);
check(
  'N-5：findings 不含行动建议（"交接 / 压缩 / 新开"）',
  !oneLoop.findings.some((f) => /交接|压缩|新开/.test(f)),
  oneLoop.findings.join(' | '),
);
const thinkFlags = scoreContextHealth({ ...base300, reasoningFlags: 3 });
check('N-5：思考其他异常也扣分（−4/次，上限 −12）', noThink.score - thinkFlags.score === 12, `${noThink.score} → ${thinkFlags.score}`);

// ── 23f. 决策词表：会话级分级兜底（复核第三次提出的跨领域词表）──
const mkEvt = (n, promptText, replyText, tokens = 1000) => [
  { type: 'turn/start', seq: n * 10, time: n * 1000, data: { turn: n } },
  {
    type: 'user/message',
    seq: n * 10 + 1,
    time: n * 1000 + 100,
    data: { turn: n, source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] },
  },
  {
    type: 'assistant/message',
    seq: n * 10 + 2,
    time: n * 1000 + 200,
    data: {
      turn: n,
      message: { content: [{ type: 'text', text: replyText }] },
      usage: { totalTokens: tokens, outputTokens: 30 },
    },
  },
  { type: 'turn/end', seq: n * 10 + 3, time: n * 1000 + 300, data: { turn: n, reason: 'completed' } },
];
// ── 实时思考守卫：冷路径必须与 host 同口径（2026-09-16 用户新增）──
// 否则会出现"提示条说被中止、交接文档只字未提"的分叉 —— 本项目反复踩过的那类坑。
{
  const x = foldSession([
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'turn/end',
      data: {
        turn: 1,
        reason: {
          kind: 'aborted',
          reason: { kind: 'hook', reason: 'attention-health：思考空转 —— 同一行连续重复 9 次' },
        },
      },
    },
  ]);
  check('foldSession 同样识别守卫中止', x.guardTripCount === 1, String(x.guardTripCount));
  check(
    'foldSession 保存了中止原因',
    String(x.lastGuardReason).includes('同一行连续重复 9 次'),
    String(x.lastGuardReason),
  );
  check(
    '守卫中止不污染 errors（主动保护不是流程故障）',
    !x.errors.some((e) => e.reason === 'aborted'),
    JSON.stringify(x.errors),
  );
}
{
  const x2 = foldSession([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]);
  check(
    '用户主动中止仍照常记入 errors（只有守卫中止被豁免）',
    x2.errors.some((e) => e.reason === 'aborted'),
    JSON.stringify(x2.errors),
  );
}

const broadX = foldSession([
  CTX,
  ...mkEvt(1, '帮我算一下这个月食材开销，其他不要动。', '按市场价中位散件**合计约 11900 元**，装机店报整机价大概 1.2 万。'),
]);
check(
  'N-5附带：主词表命中不足时启用通用结论词兜底',
  broadX.broadFallback === true && broadX.decisions.length > 0,
  `broadFallback=${broadX.broadFallback} decisions=${broadX.decisions.length}`,
);
const primaryX = foldSession([
  CTX,
  ...mkEvt(1, '这个方案确定吗？', '结论：选方案 A，放弃方案 B。'),
  ...mkEvt(2, '还有别的选择吗？', '根因是缓存失效，必须改成显式刷新。'),
  ...mkEvt(3, '就这样吧。', '定案：采用方案 A，不再讨论。'),
]);
check(
  'N-5附带：主词表够用时**不**启用兜底（工程会话输出不变）',
  primaryX.broadFallback === false,
  `decisions=${primaryX.decisions.length}`,
);

// ── 23g. 文档渲染：思考异常 / 启发式标注 / 0.5 系数（N-5、N-6）──
const n6Doc = buildHandoff({
  events: [
    CTX,
    ...mkTurn(1, '帮我看看这个会话还健康吗'),
    ...mkTurn(2, '把结论写进 README'),
  ],
  header: { id: 'n6-doc' },
  health: {
    score: 50,
    level: 'warn',
    usedTokens: 300000,
    contextWindow: 1000000,
    effectivePercent: 60,
    windowPercent: 30,
    repeatWorst: 0,
    degradedReplies: 0,
    replyReasons: [],
    reasoningLoop: 1,
    reasoningFlags: 0,
    reasoningWorstRepeat: 69667,
    reasoningReasons: [{ key: 'thinkLoop', count: 1, label: DEGRADE_LABELS.thinkLoop }],
    summaryCount: 0,
    findings: ['思考过程出现打转：1 次（最长同一行重复 69,667 次）（评分 −25）'],
  },
});
check(
  'N-5：交接文档把思考异常与命中原因写出来',
  n6Doc.markdown.includes('思考异常') && n6Doc.markdown.includes('思考打转'),
  n6Doc.markdown.split('\n').find((l) => l.includes('思考异常')) ?? '(无该行)',
);
check(
  'N-5：维度 A 的退化信号并列四个来源',
  n6Doc.markdown.includes('思考打转 1 次') && n6Doc.markdown.includes('输出退化 0 条'),
);
check(
  'N-6：文档写明评分是**启发式指标**、未做回溯验证',
  n6Doc.markdown.includes('启发式') && n6Doc.markdown.includes('回溯验证'),
);
check(
  'N-6：文档把有效窗口的 0.6 系数写成可调项',
  n6Doc.markdown.includes(`${COMPACT_DEFAULTS.effectiveWindowRatio} 系数`),
);

// ── 23h. 校准留痕：交接历史（N-6 建议 1）──
const realHome = process.env.DSH_HOME;
const tmpHome = path.join(os.tmpdir(), `ah-history-${Date.now()}`);
process.env.DSH_HOME = tmpHome;
try {
  const hist = await import(pathToFileURL(path.join(path.dirname(target), 'history.js')).href);
  const wrote = hist.recordHandoff({
    at: Date.now(),
    sessionId: 'session-test',
    via: 'test',
    score: 65,
    level: 'watch',
    effectivePercent: 30,
    windowPercent: 15,
    summaryCount: 1,
    reasoningLoop: 0,
    reasoningFlags: 0,
    chars: 12345,
  });
  check('N-6：记录一条交接历史', wrote === true);
  const rows = hist.readHistory();
  check('N-6：读回记录且字段完整', rows.length === 1 && rows[0].score === 65 && rows[0].chars === 12345);
  const lines = hist.summarizeHistory(rows);
  check(
    'N-6：汇总输出含评分分布与文件路径',
    lines.some((l) => l.includes('评分分布')) && lines.some((l) => l.includes('handoff-history.jsonl')),
  );
  await import('node:fs').then((m) => m.default.rmSync(tmpHome, { recursive: true, force: true }));
} finally {
  if (realHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realHome;
}

// ─────────────────────────────────────────────────────────────
// 24. 边界可达性守卫（2026-09-16 边界设定）
// ─────────────────────────────────────────────────────────────
// 这一节守的是"**每一条边界都真的能被触发**"。它是本轮修掉的两个硬缺陷的永久回归：
//   ① 官方线建议（"现在手动 /compact，否则官方即将自动压缩"）在旧口径下**永远不可达**：
//      质量维度只看规模，而"有效 ≥90%"= 声明 45% 早于官方线 80%，于是全区间都被 handoff 顶替；
//   ② 压缩档位锚在有效窗口时，声明 40% 起全落进 urgent，且常规增长下被 defer 整片吃掉。
// 做法：在"声明窗口占用 × 每轮增长"的二维网格上扫描，断言每个档位/结论/驱动源都出现过。
console.log('\n════════ 24. 边界可达性守卫 ════════');
const BW = 1000000;
/**
 * 边界网格的统一构造器。**默认带上实测命中率（97%）**：2026-09-16 接入真实价格后，
 * 成本裁决要求 `hitRateKnown`，缺用量数据时会一律保守判"继续"——
 * 那样网格里就只剩 continue/urgent-compact 两种结果，测不出真正的档位可达性。
 */
const atBoundary = (pct, growth = 8000, extra = {}) => {
  const used = Math.round((BW * pct) / 100);
  return deriveCompactionPlan({
    usedTokens: used,
    contextWindow: BW,
    avgRoundGrowth: growth,
    cacheReadTokens: Math.round(used * 0.97),
    cacheMissTokens: used - Math.round(used * 0.97),
    avgOutputTokens: 600,
    ...extra,
  });
};

const GRID = [];
for (let pct = 5; pct <= 100; pct += 5) {
  for (const growth of [0, 500, 2000, 8000, 20000]) GRID.push(atBoundary(pct, growth));
}
const bands = new Set(GRID.map((p) => p.compact.band));
const advices = new Set(GRID.map((p) => p.final.advice));
const driven = new Set(GRID.map((p) => p.final.drivenBy));
check(
  '边界可达：四个压缩档位在网格上都出现过',
  ['continue', 'mild', 'recommend', 'urgent'].every((b) => bands.has(b)),
  [...bands].join(', '),
);
// 2026-09-18：成本判据修好分段计费后**真的会触发**（改前对任何 H>0 都无解、恒为假），
// 所以"网格上出现 handoff"是预期结果。断言改为守住**驱动源**：该网格无退化信号，
// 因此任何 handoff 都必须由成本驱动。
check(
  '边界可达：无退化网格上不出现 compact；handoff 一律由成本驱动（2026-09-18 成本判据生效）',
  !advices.has('compact') &&
    GRID.filter((p) => p.final.advice === 'handoff').every((p) => p.final.drivenBy === 'cost'),
  [...advices].join(', ') + ' / drivenBy=' + [...driven].join(', '),
);
check(
  '边界可达：官方线分支（drivenBy=official）真的会被触发',
  driven.has('official'),
  [...driven].join(', '),
);

// 驱动源必须各归其位：质量（退化）、官方线、成本。
check(
  '边界：官方线 80% 声明（无退化）→ continue，且 drivenBy=official（官方会自己处理）',
  atBoundary(80).final.advice === 'continue' && atBoundary(80).final.drivenBy === 'official',
  `${atBoundary(80).final.advice} / ${atBoundary(80).final.drivenBy}`,
);
check(
  '边界：75% 声明（官方线预警带内）→ continue（不劝手动压缩）',
  atBoundary(75).final.advice === 'continue',
  atBoundary(75).final.advice,
);
// 2026-09-18：原断言防的是**质量维度凭规模早触发**（旧口径在此判 immediate，把 35 万 token
// 余量劝掉）。成本判据修好后，45% 可以由**成本**独立判交接 —— 那是另一条通道，不是这条要防的。
// 实测：quality.advice=continue、final.drivenBy=cost。
check(
  '边界：45% 声明、无退化 → **质量维度不触发**（成本维度可独立判定）',
  atBoundary(45).quality.advice === 'continue',
  `quality=${atBoundary(45).quality.advice} / final=${atBoundary(45).final.advice}/${atBoundary(45).final.drivenBy}`,
);
check(
  '边界：urgent 档（≥80% 声明）不再产出压缩建议 —— 官方到线会自己处理',
  GRID.filter((p) => p.compact.band === 'urgent').every((p) => p.final.advice === 'continue'),
  GRID.filter((p) => p.compact.band === 'urgent' && p.final.advice !== 'continue').length + ' 例例外',
);
check(
  '边界：压缩建议已完全退出行动域（用户 2026-09-16 重定位：只留 继续 / 交接）',
  !GRID.some((p) => p.final.advice === 'compact'),
  [...advices].join(', '),
);
check(
  '边界：缺命中率实测时不做成本裁决 —— 不拿假设值劝人压缩或换会话',
  atBoundary(68, 20000, { cacheReadTokens: 0, cacheMissTokens: 0 }).final.advice === 'continue',
  atBoundary(68, 20000, { cacheReadTokens: 0, cacheMissTokens: 0 }).final.advice,
);
check(
  '边界：命中率崩塌（0%）+ 大上下文 → 由成本改判新开（这是本轮新增的判据）',
  atBoundary(50, 8000, { cacheReadTokens: 0, cacheMissTokens: 500000, usageCount: 3 }).final.advice ===
    'handoff',
  atBoundary(50, 8000, { cacheReadTokens: 0, cacheMissTokens: 500000, usageCount: 3 }).final.advice,
);

// 质量维度：规模 + 退化 才动手（这是让官方线可达的前提）
check(
  '边界：规模大 + 有退化 → 交接',
  atBoundary(60, 8000, { repeatWorst: 3 }).final.advice === 'handoff',
  atBoundary(60, 8000, { repeatWorst: 3 }).final.advice,
);
check(
  '边界：有效 ≥90%（60% 声明 = 有效 100%）+ 退化 → 立即新开',
  atBoundary(60, 8000, { repeatWorst: 3 }).quality.advice === 'immediate',
  atBoundary(60, 8000, { repeatWorst: 3 }).quality.advice,
);
// 2026-09-18 拆成两条（用户裁定）：质量与成本是**两条独立通道**，界面已用 `drivenBy` 区分。
// ① 质量维度仍守"退化也要规模到线才换会话"（第 28 节原意，不改）；
//    实测 35% 声明 = 有效 58% < 70% → quality.advice=continue。
check(
  '边界：规模未到（35% 声明 = 有效 58%）+ 有退化 → **质量维度**不触发交接（退化也要规模到线）',
  atBoundary(35, 8000, { repeatWorst: 3 }).quality.advice === 'continue',
  atBoundary(35, 8000, { repeatWorst: 3 }).quality.advice,
);
// ② 成本维度是独立通道：35% 已过 20% 门槛，按回本判据该交接就交接（用户最高指令是"省钱"）。
check(
  '边界：规模未到（35% 声明）+ 有退化 → **成本维度**独立判交接，drivenBy=cost',
  atBoundary(35, 8000, { repeatWorst: 3 }).final.advice === 'handoff' &&
    atBoundary(35, 8000, { repeatWorst: 3 }).final.drivenBy === 'cost',
  `${atBoundary(35, 8000, { repeatWorst: 3 }).final.advice}/${atBoundary(35, 8000, { repeatWorst: 3 }).final.drivenBy}`,
);

// ── brokenCache 独立通道的正反例（2026-09-18 用户要求）───────────────────────
// 这条通道的意义：缓存崩了时继续每轮按未命中价重付**全部**上下文（550k/0% → ¥0.55/轮），
// 新会话只有首轮冷启动 —— **第 1 轮就回本**，所以它不看 `H`（上一条「闸门」的 fixture 故意不给增速）。
// 正例：命中率 0%，且**估不出增长** → 仍必须交接。
{
  const pad = (n, label) => ({
    usedTokens: 550000,
    contextWindow: 1000000,
    summaryCount: 3,
    cacheReadTokens: Math.round(550000 * n),
    cacheMissTokens: 550000 - Math.round(550000 * n),
    usageCount: 500,
  });
  const dead = deriveCompactionPlan(pad(0, 'dead'));
  check(
    'brokenCache 正例：命中率 0% + 估不出增长 → 交接（不看 H）',
    dead.final.advice === 'handoff' && dead.cost.freshWinsOnCost === true,
    `${dead.final.advice}/${dead.final.drivenBy} wins=${dead.cost.freshWinsOnCost}`,
  );
  const healthy = deriveCompactionPlan(pad(0.6, 'healthy'));
  check(
    'brokenCache 反例：命中率 60% > 阈值 0.5 → 不因该通道判交接',
    healthy.cost.freshWinsOnCost === false,
    `wins=${healthy.cost.freshWinsOnCost}（阈值 ${COMPACT_DEFAULTS.brokenCacheHitRate}）`,
  );
  const justBelow = deriveCompactionPlan(pad(0.49, 'below'));
  check(
    'brokenCache 边界：命中率 49% < 阈值 → 该通道生效',
    justBelow.cost.freshWinsOnCost === true,
    `wins=${justBelow.cost.freshWinsOnCost}`,
  );
}

// ── 三道防御的**直接**守卫（2026-09-18 用户要求逐条显式化）────────────────────
// 在此之前，这三条门槛只被网格扫描间接覆盖；显式钉住后，任何一条被放松都会当场红灯。
{
  const mk = (over = {}) =>
    deriveCompactionPlan({
      usedTokens: 200000,
      contextWindow: 1000000,
      avgRoundGrowth: 8000,
      cacheReadTokens: 194000,
      cacheMissTokens: 6000,
      avgOutputTokens: 600,
      ...over,
    });

  // ① 规模门槛：声明窗口 ≥ 20% 才进成本裁决。
  //    负例同时要求"回本判据本身成立"（be 非 null）—— 否则 false 可能来自别的原因，
  //    测不出到底是门槛在起作用。
  const below20 = mk({ usedTokens: 199000, cacheReadTokens: 193030, cacheMissTokens: 5970 });
  check(
    '门槛①规模：声明窗口 19.9% → 不进成本裁决（回本判据本会成立）',
    below20.cost.freshWinsOnCost === false && below20.cost.freshBreakEvenRounds !== null,
    `wins=${below20.cost.freshWinsOnCost} be=${below20.cost.freshBreakEvenRounds} H=${below20.cost.horizonRounds}`,
  );
  const at20 = mk({ usedTokens: 200000 });
  check(
    '门槛①规模：声明窗口 20.0% → 进成本裁决',
    at20.cost.freshWinsOnCost === true,
    `wins=${at20.cost.freshWinsOnCost} be=${at20.cost.freshBreakEvenRounds}`,
  );

  // ② brokenCache 的"缓存已建立"前提（沿用 P2 口径 `hit > 0 || usageCount >= 2`）。
  //    首轮零命中是"缓存还没建立"，不是"崩了"—— 拿它劝人换会话正是 P2 修过的老 bug。
  const deadBase = {
    usedTokens: 550000,
    contextWindow: 1000000,
    summaryCount: 3,
    cacheReadTokens: 0,
    cacheMissTokens: 550000,
  };
  check(
    '门槛②brokenCache：首轮零命中（usageCount=1）→ 不算崩，不裁决',
    deriveCompactionPlan({ ...deadBase, usageCount: 1 }).cost.freshWinsOnCost === false,
    'P2：首轮零命中是常态',
  );
  check(
    '门槛②brokenCache：多轮仍零命中（usageCount=3）→ 允许裁决',
    deriveCompactionPlan({ ...deadBase, usageCount: 3 }).cost.freshWinsOnCost === true,
    'P2：多轮零命中才说明缓存真没起作用',
  );

  // ②b **规模门槛对 brokenCache 同样适用**（2026-09-18 复查修的真 bug）。
  // 反例逐字取自真实日志 `session-SAMPLE-dbe8e0b8`：used=2,914 / 命中率 32.6%。
  // 缓存确实"崩"了，但上下文太小 —— 继续每轮仅 ¥0.0026，而新开首轮是固定 ¥0.018
  // （交接文档），回本要 12.3 轮。旧实现放它过 → 判"建议交接"，界面余量显示 -2.27 轮。
  const tinyBroken = deriveCompactionPlan({
    usedTokens: 2914,
    contextWindow: 1000000,
    avgRoundGrowth: 0,
    cacheReadTokens: 951,
    cacheMissTokens: 1963,
    avgOutputTokens: 20,
    usageCount: 3,
  });
  check(
    '门槛②b：小会话（2,914 token / 命中率 32.6%）虽"崩"但不劝交接',
    tinyBroken.cost.freshWinsOnCost === false,
    `wins=${tinyBroken.cost.freshWinsOnCost} wp=${tinyBroken.window.windowPercent}%`,
  );
  const bigBroken = deriveCompactionPlan({ ...deadBase, usageCount: 3 });
  check(
    '门槛②b对照：同样命中率、上下文 ≥20% → 该通道仍生效（第 1 轮就摊平）',
    bigBroken.cost.freshWinsOnCost === true,
    '大上下文时"缓存崩了第 1 轮就回本"成立',
  );
  // ④ 不变量：凡判「新开更省」，回本余量**不得为负**（判定与展示的账必须自洽）。
  //    `session-SAMPLE-dbe8e0b8` 破坏的正是这条：判 handoff 却显示余量 -2.27 轮。
  check(
    '门槛④不变量：brokenCache 生效时回本余量仍必须为正（判定与账自洽）',
    bigBroken.cost.freshWinMarginRounds !== null && bigBroken.cost.freshWinMarginRounds > 0,
    `margin=${bigBroken.cost.freshWinMarginRounds}`,
  );

  // ③ H 上限与增速样本不足（用户括号里的两种情形都要挡）。
  check(
    '门槛③H：无 avgRoundGrowth（样本不足）→ 不外推、不裁决',
    deriveCompactionPlan({
      usedTokens: 200000,
      contextWindow: 1000000,
      cacheReadTokens: 194000,
      cacheMissTokens: 6000,
      avgOutputTokens: 600,
      // 故意不传 avgRoundGrowth：headroomRounds 会退到兜底 remainingRounds
    }).cost.freshWinsOnCost === false,
    'headroomRounds=null → 不做外推',
  );
  const slow = mk({
    usedTokens: 300000,
    cacheReadTokens: 291000,
    cacheMissTokens: 9000,
    avgRoundGrowth: 100, // → headroom 500000/100 = 5000 轮 > 200
  });
  check(
    '门槛③H：外推 H=5000 > 200 → 不裁决',
    slow.cost.freshWinsOnCost === false && slow.cost.horizonRounds > 200,
    `wins=${slow.cost.freshWinsOnCost} H=${slow.cost.horizonRounds}`,
  );
}

// 常量之间的**结构性关系**：这类错误不会让任何单点测试失败，却会让整条判据不可达。
check(
  '边界常量：代理线必须**大于**档位起点，否则"估不出轮数就推迟"永远不可达（本轮踩过）',
  COMPACT_DEFAULTS.compactDeferBelowDeclaredPercent > COMPACT_DEFAULTS.compactMildFrom,
  `${COMPACT_DEFAULTS.compactDeferBelowDeclaredPercent} vs ${COMPACT_DEFAULTS.compactMildFrom}`,
);
check(
  '边界常量：有效窗口系数在合理区间（0.5 ~ 1）',
  COMPACT_DEFAULTS.effectiveWindowRatio >= 0.5 && COMPACT_DEFAULTS.effectiveWindowRatio < 1,
  String(COMPACT_DEFAULTS.effectiveWindowRatio),
);
check(
  '边界常量：档位阈值递增',
  COMPACT_DEFAULTS.compactMildFrom < COMPACT_DEFAULTS.compactRecommendFrom &&
    COMPACT_DEFAULTS.compactRecommendFrom < COMPACT_DEFAULTS.compactUrgentFrom,
  `${COMPACT_DEFAULTS.compactMildFrom}/${COMPACT_DEFAULTS.compactRecommendFrom}/${COMPACT_DEFAULTS.compactUrgentFrom}`,
);
check(
  '边界常量：质量"立即新开"的声明落点在官方线之前（口径换算：90% × ratio）',
  COMPACT_DEFAULTS.qualityImmediatePercent * COMPACT_DEFAULTS.effectiveWindowRatio <
    COMPACT_DEFAULTS.officialCompactPercent,
  `${COMPACT_DEFAULTS.qualityImmediatePercent * COMPACT_DEFAULTS.effectiveWindowRatio}% vs ${COMPACT_DEFAULTS.officialCompactPercent}%`,
);

// ── 审查 P2：首轮零命中 ≠ 缓存崩了（两者被混为一谈会误判）──
check(
  'P2：首轮零命中（usageCount=1、hit=0）不做成本裁决 —— 零命中在首轮是常态',
  deriveCompactionPlan({
    usedTokens: 200000,
    contextWindow: 1000000,
    cacheReadTokens: 0,
    cacheMissTokens: 200000,
    usageCount: 1,
  }).final.drivenBy !== 'cost',
);
check(
  'P2：多轮仍零命中（usageCount=3）→ 认定缓存确实没起作用，允许成本裁决',
  deriveCompactionPlan({
    usedTokens: 500000,
    contextWindow: 1000000,
    avgRoundGrowth: 8000,
    cacheReadTokens: 0,
    cacheMissTokens: 500000,
    usageCount: 3,
  }).final.advice === 'handoff',
);
check(
  '边界常量：`cacheFactor` 必须等于 `prices` 的命中/未命中价之比（两处漂移会让判定与展示打架）',
  Math.abs(
    COMPACT_DEFAULTS.cacheFactor -
      COMPACT_DEFAULTS.prices.cacheHitPerMillion / COMPACT_DEFAULTS.prices.cacheMissPerMillion,
  ) < 1e-9,
  `${COMPACT_DEFAULTS.cacheFactor} vs ${COMPACT_DEFAULTS.prices.cacheHitPerMillion}/${COMPACT_DEFAULTS.prices.cacheMissPerMillion}`,
);
check(
  '边界常量：价格三项递增（命中 < 未命中 ≤ 输出），否则成本模型的直觉会反',
  COMPACT_DEFAULTS.prices.cacheHitPerMillion < COMPACT_DEFAULTS.prices.cacheMissPerMillion &&
    COMPACT_DEFAULTS.prices.cacheMissPerMillion <= COMPACT_DEFAULTS.prices.outputPerMillion,
  JSON.stringify(COMPACT_DEFAULTS.prices),
);
// ── 第三方评审 P1-5（2026-09-18）：zstd 解码的资源上限 ─────────────────────
//
// 原实现把整个文件读进内存、逐帧全解压、再拼一个**无上限**的明文 ——
// 而本项目自己的语料里就有单块 53 万字符的思考块，解压放大不可控。
{
  const zf = await import(pathToFileURL(path.join(projectRoot, 'lib', 'zstd-frames.mjs')).href);
  check(
    'P1-5：提供了三个维度的资源上限常量',
    typeof zf.DECODE_LIMITS?.maxFrames === 'number' &&
      zf.DECODE_LIMITS.maxInputBytes > 0 &&
      zf.DECODE_LIMITS.maxPlaintextBytes > 0,
    JSON.stringify(zf.DECODE_LIMITS),
  );
  const tooBig = zf.decodeSessionLog(Buffer.alloc(100), { maxInputBytes: 50 });
  check(
    'P1-5：输入超限 → 不解码且**如实报告**（skipped=input-too-large）',
    tooBig.skipped === 'input-too-large' && tooBig.plaintext === '' && tooBig.bytes === 0,
    JSON.stringify({ skipped: tooBig.skipped, bytes: tooBig.bytes }),
  );
  const tiny = zf.decodeSessionLog(Buffer.alloc(0));
  check(
    'P1-5：正常输入不受影响（空 buffer 照常返回）',
    tiny.skipped === undefined && tiny.plaintext === '' && tiny.frameCount === 0,
    JSON.stringify(tiny),
  );
}

console.log('\n════════ 25. AB 节：成本文案分通道 + 「每轮」口径修正（2026-09-20）════════');
// 复核侧用真实会话 `session-SAMPLE-b983cfac` 复算出两处问题：
//   AB.2 文案说假话：99.7% 命中率被写成"前缀复用已经失效 / 按未命中价重付全部上下文"；
//   AB.3 口径错位：`*PerRoundYuan` 实为**每次请求**的钱，总额却乘"轮数" → 少算 stepsPerTurn 倍。
// 这里用同一会话的关键数字做 fixture（与探针 `work/check-258k-verdict.mjs` 同源）。
const AB_NOW = new Date(Date.UTC(2026, 8, 19, 2, 0, 0)); // 周六 → 空闲价，结果可复现
const AB_REQ = {
  usedTokens: 258366,
  contextWindow: 1000000,
  // 尾窗 20 次累计命中率 99.70%（复核侧给出的实测值）
  cacheReadTokens: 256640,
  cacheMissTokens: 190,
  recentUsage: [
    { hit: 249984, total: 250548 },
    { hit: 256640, total: 256830 },
  ],
  avgOutputTokens: 1287.1470588235295,
  usageCount: 68,
  turnCount: 30,
  avgRoundGrowth: 6046,
  model: 'deepseek-v4-flash-expires-on-0910',
  now: AB_NOW,
};
{
  const plan = deriveCompactionPlan(AB_REQ);
  const reason = String(plan.final.reason ?? '');
  // 先确认**真的走到了那条分支**（否则"文案里没有某词"永远成立 —— §49.4 的假通过教训）
  check(
    'AB.2：高命中率会话确实走成本通道（advice=handoff / drivenBy=cost）',
    plan.final.advice === 'handoff' && plan.final.drivenBy === 'cost',
    `${plan.final.advice} / ${plan.final.drivenBy}`,
  );
  check('AB.2：命中率 99.7% 时不得出现"失效"', !reason.includes('失效'), reason.slice(0, 160));
  check(
    'AB.2：命中率 99.7% 时不得出现"重付全部上下文"',
    !reason.includes('重付全部上下文'),
    reason.slice(0, 160),
  );
  check('AB.2：改为如实说明"存量规模"差异', reason.includes('存量'), reason.slice(0, 160));
  check(
    'AB.2：如实给出命中率数值（与 cost.hitRate 同值）',
    reason.includes(`${(plan.cost.hitRate * 100).toFixed(1)}%`),
    `hitRate=${(plan.cost.hitRate * 100).toFixed(1)}% / ${reason.slice(0, 160)}`,
  );

  // ── AB.3：口径 ──
  const H = plan.cost.horizonRounds;
  check(
    'AB.3：stepsPerTurn = usageCount / turnCount（68/30 ≈ 2.27）',
    Math.abs(plan.cost.stepsPerTurn - 68 / 30) < 1e-9,
    String(plan.cost.stepsPerTurn),
  );
  check(
    'AB.3：总额 = 每轮成本 × 轮数（口径一致，不再少算请求数）',
    Math.abs(plan.cost.totalContinue - plan.cost.continuePerRound * H) < 1e-9 &&
      Math.abs(
        plan.cost.totalFresh - (plan.cost.freshFirstTurn + plan.cost.freshPerRound * Math.max(0, H - 1)),
      ) < 1e-9,
    `totalContinue=${plan.cost.totalContinue} / continuePerRound=${plan.cost.continuePerRound} / H=${H}`,
  );
  check(
    'AB.3：回本轮数 = 首轮溢价 ÷ 每轮节省（分子分母同口径）',
    Math.abs(
      plan.cost.freshBreakEvenRounds -
        plan.cost.freshFirstRoundPremium / plan.cost.freshSavingPerRound,
    ) < 1e-9,
    String(plan.cost.freshBreakEvenRounds),
  );
  check(
    'AB.3：回本 ≈ 1.4 轮（旧口径 3.1 —— 复核侧给出的真值）',
    plan.cost.freshBreakEvenRounds > 1.2 && plan.cost.freshBreakEvenRounds < 1.6,
    plan.cost.freshBreakEvenRounds.toFixed(3),
  );
  check(
    'AB.3：到官方线前可省 ≈ ¥1.0（旧口径 ¥0.455 —— 复核侧给出的真值）',
    plan.cost.savingYuan > 0.9 && plan.cost.savingYuan < 1.2,
    plan.cost.savingYuan.toFixed(3),
  );
  check(
    'AB.3：每轮成本含 stepsPerTurn 次请求（与"每次请求"明显不同）',
    plan.cost.continuePerRound > plan.cost.continuePerRound / plan.cost.stepsPerTurn * 2,
    String(plan.cost.continuePerRound),
  );

  // ── 老输入不退化：没有 turnCount 时等价于"每轮一次请求" ──
  const noTurn = deriveCompactionPlan({ ...AB_REQ, turnCount: undefined });
  check(
    'AB.3 兼容：缺 turnCount → stepsPerTurn=1，口径退回旧值（不会因新字段缺失而崩）',
    noTurn.cost.stepsPerTurn === 1 && noTurn.cost.savingYuan < plan.cost.savingYuan / 2,
    `sp=${noTurn.cost.stepsPerTurn} / saving=${noTurn.cost.savingYuan.toFixed(3)}`,
  );

  // ── AB.2 反例：缓存**真的**崩了（命中率 0%）时必须保留强措辞 ──
  const broken = deriveCompactionPlan({
    ...AB_REQ,
    cacheReadTokens: 0,
    cacheMissTokens: 250000,
  });
  const brokenReason = String(broken.final.reason ?? '');
  check(
    'AB.2 反例：命中率 0% 时仍然说"失效 / 重付全部上下文"（真话不能删）',
    broken.final.advice === 'handoff' &&
      brokenReason.includes('失效') &&
      brokenReason.includes('重付全部上下文'),
    `${broken.final.advice} / ${brokenReason.slice(0, 120)}`,
  );
}

console.log('\n════════ 26. AD 节：「交接回本 0.0 轮」显示修复（2026-09-20）════════');
// 用户截图的那条：`freshBreakEvenRounds = 0.0457` 被 `toFixed(1)` 写成「0.0 轮」/「约 0.0 轮摊平」——
// **数值没错**（冷启动溢价在一轮之内就摊平），但读者会以为数据坏了。修法：< 0.1 轮说「首轮内」。
// fixture 用真实会话的量级（434,643 token / 854 次请求 / 20 轮），靠 `handoffDocTokens` 调回本量级。
{
  const AD_BASE = {
    usedTokens: 434643,
    contextWindow: 1000000,
    cacheReadTokens: 430000,
    cacheMissTokens: 900,
    recentUsage: [{ hit: 430000, total: 430900 }],
    avgOutputTokens: 1400,
    usageCount: 854,
    turnCount: 20,
    avgRoundGrowth: 9000,
    model: 'deepseek-v4-flash-expires-on-0910',
    now: new Date(Date.UTC(2026, 8, 19, 2, 0, 0)), // 周六 → 空闲价，结果可复现
  };
  const tiny = deriveCompactionPlan({ ...AD_BASE, handoffDocTokens: 0 });
  const tinyBe = tiny.cost.freshBreakEvenRounds;
  check(
    'AD：fixture 确实落在「回本 < 0.1 轮」区间（否则下面那条是假通过）',
    typeof tinyBe === 'number' && tinyBe > 0 && tinyBe < 0.1,
    String(tinyBe),
  );
  check(
    'AD：长文说「首轮内即摊平」，不再出现「0.0 轮」',
    // ⚠️ 不能用 /0\.0 轮/ 全串匹配：余量文案「还剩约 40.0 轮」会被误伤
    //（2026-09-20 实测：fixture 余量恰为 40.0 → 这条断言假失败）。只盯「回本」文案本身。
    String(tiny.final.reason).includes('首轮内即摊平') &&
      !String(tiny.final.reason).includes('0.0 轮摊平'),
    String(tiny.final.reason).slice(0, 200),
  );

  const big = deriveCompactionPlan({ ...AD_BASE, handoffDocTokens: 60000 });
  check(
    'AD：回本 ≥ 0.1 轮仍是一位小数（「约 N.N 轮摊平」，格式不回退）',
    big.cost.freshBreakEvenRounds >= 0.1 && /约 \d+\.\d 轮摊平/.test(String(big.final.reason)),
    `be=${big.cost.freshBreakEvenRounds} / ${String(big.final.reason).slice(0, 160)}`,
  );

  // ── 第三处显示点（AD 首版漏掉的那处）：交接**文档**里的成本表说明 ──
  // 实测发现：折叠行与长文都改了，用户文档里仍写着「交接摊平 ≈ 0.0 轮」。
  // 现在三处共用 `formatBreakEven`，这里做两层守卫：口径单元 + 源码里不许再自带 toFixed(1)。
  check(
    'AD：formatBreakEven 三档口径（≤0 / <0.1 / 其余）',
    formatBreakEven(0).short === '首轮即摊平' &&
      formatBreakEven(-1).short === '首轮即摊平' &&
      formatBreakEven(0.0457).short === '首轮内' &&
      formatBreakEven(0.0457).ledger === '首轮内即摊平' &&
      formatBreakEven(1.8).short === '1.8 轮' &&
      formatBreakEven(null) === null,
    JSON.stringify([formatBreakEven(0), formatBreakEven(0.0457), formatBreakEven(1.8)]),
  );
  const renderSrc = fs.readFileSync(path.join(path.dirname(target), 'handoff-render.js'), 'utf8');
  // 只看**代码行**：注释里为了说明历史会提到 `be.toFixed(1)` 这个写法本身，那是解释不是实现
  const renderCode = renderSrc
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  check(
    'AD：文档那处不再自带 `be.toFixed(1)`（防止第三处显示点再次漂移）',
    !/be\.toFixed\(1\)/.test(renderCode) && renderSrc.includes('formatBreakEven'),
  );
  // 真实会话回归（本机有就用真数据；没有就跳过 —— 与 S.4 同一策略）
  {
    const s = listSessions().find((x) => String(x.file ?? '').includes('fcafee61'));
    if (!s) {
      console.log('  ⚠️ 跳过 AD 真实文档回归（本机没有 session-SAMPLE-1bd48cbb）');
    } else {
      const events = readSession(s.file).events;
      const md = buildHandoff({ events, header: { id: s.id } }).markdown ?? '';
      const line = md.split('\n').find((l) => l.includes('摊平')) ?? '';
      const shown = (line.match(/摊平 ≈ ([^）]+)/) ?? [])[1]?.trim() ?? '';
      check(
        'AD：真实会话文档里的回本显示不是「0.0 轮」（首版漏掉的正是这处）',
        shown !== '' && shown !== '0.0 轮' && !/^0\.0/.test(shown),
        `${shown} | ${line.slice(0, 140)}`,
      );
    }
  }
}

console.log('\n════════ 27. AF 节：中间档 `prepare`（2026-09-20 用户需求 2）════════');
// 语义：**不催促、不否定继续**，只给"心理准备 + 边界选择权"。
// 两个通道各一条触发带，且都只把原本的 continue 升级，不动已经想清楚的结论：
//   ① 成本：回本已落在窗口内、但余量 ≤ prepareMarginRounds（交接要求余量 > 1）
//   ② 质量：已检出退化信号，但没到该交接的程度（原先文案就是"继续即可，但请留意……"）
{
  const AF_BASE = {
    usedTokens: 258366,
    contextWindow: 1000000,
    cacheReadTokens: 256640,
    cacheMissTokens: 190,
    recentUsage: [{ hit: 249984, total: 250548 }],
    avgOutputTokens: 1287,
    usageCount: 68,
    turnCount: 30,
    model: 'deepseek-flash',
    now: new Date(Date.UTC(2026, 8, 19, 2, 0, 0)),
    handoffDocTokens: 12000,
  };

  // ① 成本通道：avgRoundGrowth 拉到 200000 → H=2，回本 1.54 → 余量 0.46 轮（差一点）
  const thin = deriveCompactionPlan({ ...AF_BASE, avgRoundGrowth: 200000 });
  check(
    'AF：成本接近（余量 0.46 轮 ≤ prepareMarginRounds=2）→ prepare（drivenBy=cost）',
    thin.final.advice === 'prepare' && thin.final.drivenBy === 'cost',
    `${thin.final.advice} / ${thin.final.drivenBy} / margin=${thin.cost.freshWinMarginRounds}`,
  );
  check(
    'AF：prepare 文案是"不催促"的那句（接近阈值 · 可在下一个任务边界交接）',
    thin.final.adviceText === '接近交接阈值 · 可在下一个任务边界交接',
    String(thin.final.adviceText),
  );
  check(
    'AF：prepare 的理由里明确"继续也完全可以"（不否定继续）',
    String(thin.final.reason).includes('继续也完全可以') &&
      String(thin.final.reason).includes('按当前增速外推'),
    String(thin.final.reason).slice(0, 180),
  );
  check(
    'AF：prepare 的 note 不再是"无需额外操作"',
    thin.final.note === FINAL_NOTES.prepareHandoff,
    String(thin.final.note),
  );

  // 反例：同样成本接近，但余量充足（7.5 轮）→ **不许**误报"可交接"。
  // AG 节（2026-09-22）后这条口径微调：这个 fixture 的省额落在"很小但为正"的带里，
  // 现在会被**最轻档 `costNote`** 接住（它只是状态陈述、不点亮提示条，也不是建议）
  // —— 所以断言的是"**不升到 prepare / handoff**"，而不是"必须是 continue"。
  const ample = deriveCompactionPlan({ ...AF_BASE, avgRoundGrowth: 60000 });
  check(
    'AF 反例：余量充足但未达交接 → 不判 prepare / handoff（中间档不越界；最轻档 costNote 允许）',
    (ample.final.advice === 'continue' || ample.final.advice === 'costNote') &&
      ample.cost.freshWinMarginRounds > 2,
    `${ample.final.advice} / margin=${ample.cost.freshWinMarginRounds}`,
  );
  // 反例：已经是 handoff 的会话不会被降级成 prepare
  const winning = deriveCompactionPlan({ ...AF_BASE, avgRoundGrowth: 6000 });
  check(
    'AF 反例：本就该交接 → 保持 handoff（不被降级/覆盖）',
    winning.final.advice === 'handoff',
    String(winning.final.advice),
  );

  // ② 质量通道：检出退化 + 规模没到 → prepare（原先的"继续即可，但请留意……"）
  const degradedNear = deriveCompactionPlan({
    usedTokens: 21090,
    contextWindow: 1000000,
    repeatWorst: 5,
    avgRoundGrowth: 1400,
    usageCount: 20,
    turnCount: 5,
    model: 'deepseek-flash',
    now: new Date(Date.UTC(2026, 8, 19, 2, 0, 0)),
  });
  check(
    'AF：质量接近（已检出退化但未达交接）→ prepare（drivenBy=quality）',
    degradedNear.final.advice === 'prepare' && degradedNear.final.drivenBy === 'quality',
    `${degradedNear.final.advice} / ${degradedNear.final.drivenBy} / degraded=${degradedNear.quality.degraded}`,
  );
  check(
    'AF：质量档 prepare 的理由保留"具体是哪几条退化信号"（M-2 的成果不回退）',
    String(degradedNear.final.reason).includes('已检出退化信号') &&
      String(degradedNear.final.reason).includes('若再次出现打转'),
    String(degradedNear.final.reason).slice(0, 180),
  );
}

console.log('\n════════ 28. AG 节：四档梯度 + 会话成熟线（2026-09-22 用户实测）════════');
// 现场（用户原话）：「对话才 6 轮插件就建议机械交接了，这会导致任务会变得繁琐」。
// 复核确认数字全成立（省 ¥2.58），但**任务刚展开**就劝换会话会把任务切成碎片，
// 而"任务连续性 / 重建理解"这些代价不在成本模型里。
// 规则：轮数 < `matureSessionTurns`（15）时**成本通道**最高判 `prepare`；
//       **质量通道**（退化 / 守卫）不受限 —— 那是止损，不是打扰。
{
  const AG_BASE = {
    usedTokens: 258366,
    contextWindow: 1000000,
    cacheReadTokens: 256640,
    cacheMissTokens: 190,
    recentUsage: [{ hit: 249984, total: 250548 }],
    avgOutputTokens: 1287,
    usageCount: 68,
    model: 'deepseek-flash',
    now: new Date(Date.UTC(2026, 8, 19, 2, 0, 0)),
    handoffDocTokens: 12000,
  };

  // ① 成熟线：**同一份账**，只改轮数
  const mature = deriveCompactionPlan({ ...AG_BASE, avgRoundGrowth: 6000, turnCount: 30 });
  check(
    `AG：成熟会话（30 轮 ≥ ${COMPACT_DEFAULTS.matureSessionTurns}）成本划算 → 仍判 handoff（原判定不变）`,
    mature.final.advice === 'handoff' && mature.final.drivenBy === 'cost',
    `${mature.final.advice} / ${mature.final.drivenBy}`,
  );
  const early = deriveCompactionPlan({ ...AG_BASE, avgRoundGrowth: 6000, turnCount: 8 });
  check(
    'AG：同一份账但会话还早（8 轮 < 15）→ 降为 prepare（不催促、任务不被打断）',
    early.final.advice === 'prepare' && early.final.drivenBy === 'cost',
    `${early.final.advice} / ${early.final.drivenBy} / turns=8`,
  );
  check(
    'AG：降级后**账照给**（理由里仍能看到省了多少轮），依据是"会话还早"而不是"钱不够"',
    String(early.final.reason).includes('成熟线') &&
      String(early.final.reason).includes('8 轮') &&
      String(early.final.note) === FINAL_NOTES.immatureCostHandoff,
    `${early.final.note} | ${String(early.final.reason).slice(0, 120)}`,
  );
  check(
    'AG：降级后的建议文案不含"建议机械交接"这类命令性措辞',
    !String(early.final.adviceText).includes('建议机械交接') &&
      String(early.final.adviceText).includes('任务边界'),
    String(early.final.adviceText),
  );
  // 实测踩到（`session-SAMPLE-8f723845` 的真实理由）：`fmtFreshLedger()` 里**已经含**
  // "新开首轮 ¥X → 之后 ¥Y/轮，约 Z 轮摊平"整句，第一版又在它前面手写了一遍 → 同一句出现两次。
  // 这条断言把"别手写第二遍"钉住（这类重复只有跑真实会话才看得出来）。
  check(
    'AG：降级理由里"新开首轮"只出现一次（`fmtFreshLedger()` 已含该句，不得再手写）',
    (String(early.final.reason).match(/新开首轮/g) ?? []).length === 1,
    String(early.final.reason).slice(0, 200),
  );

  // ② 质量通道**不受成熟线限制**：4 轮、但被实时守卫掐断 4 次 → 照旧判交接
  const qEarly = deriveCompactionPlan({ ...AG_BASE, guardTripCount: 4, turnCount: 4 });
  check(
    'AG：质量通道不受成熟线限制（4 轮 + 守卫 4 次 → 仍判 handoff，drivenBy=quality）',
    qEarly.final.advice === 'handoff' && qEarly.final.drivenBy === 'quality',
    `${qEarly.final.advice} / ${qEarly.final.drivenBy} / turns=4`,
  );

  // ③ 最轻档 `costNote`：省额为正、但连门槛的 60% 都不到 → 只说事实，不劝动作
  const note = deriveCompactionPlan({ ...AG_BASE, avgRoundGrowth: 60000 });
  check(
    'AG：省额未达门槛 60% → costNote（最轻档，不是建议）',
    note.final.advice === 'costNote' && note.final.drivenBy === 'cost' && note.cost.savingYuan > 0,
    `${note.final.advice} / saving=¥${Number(note.cost.savingYuan).toFixed(4)}`,
  );
  check(
    'AG：costNote 文案不催促（无"建议 / 应当 / 立即 / 请"这类命令性措辞）',
    !/建议|应当|立即|请/.test(String(note.final.adviceText) + String(note.final.note)),
    `${note.final.adviceText} / ${note.final.note}`,
  );
  check(
    'AG：costNote 的 note 明说"继续没问题"（它是状态陈述，不是行动）',
    String(note.final.note).includes('继续没问题') && String(note.final.adviceText).includes('可继续'),
    `${note.final.adviceText} / ${note.final.note}`,
  );

  // ④ 老输入不变差：轮数拿不到（turnCount=0）时**不启用**成熟线 —— 无从判断成熟度，
  //    保持原判，而不是把"缺数据"当成"会话还早"。
  const noTurns = deriveCompactionPlan({ ...AG_BASE, avgRoundGrowth: 6000, turnCount: 0 });
  check(
    'AG：缺轮数（turnCount=0）时不降级 —— 缺数据不改变已有结论',
    noTurns.final.advice === 'handoff',
    `${noTurns.final.advice}（turnCount=0）`,
  );
}

console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
process.exit(fail === 0 ? 0 : 1);
