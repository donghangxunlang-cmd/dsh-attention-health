/**
 * attention-health-ui 本地验证。
 *
 * 目的：在挂载并重启 DSH **之前**证明 client bundle 不会导致启动失败或运行时报错。
 *
 * 覆盖：
 *   1. package.json 结构（MissingClientBundleError 的触发条件）
 *   2. client.js 能被求值并注册 factory
 *   3. factory 产出合法的 cordis 客户端插件（apply / inject）
 *   4. apply(mockCtx) 注册到期望的 slot
 *   5. 组件在各 health 取值下渲染不抛错
 *   6. 交接生成交互：点击 → 本地生成 → 新开会话 → 预填（不发送）
 *   7. 未知 require 会被暴露（提前发现基座外依赖）
 *
 * ⚠️ **被测目录是运行时的真实位置**：`profiles/node_modules/attention-health-ui`。
 * 早期版本把包放在 `profiles/web/attention-health-ui`，那是一份运行时不读取的
 * 死副本 —— 测它会得到"测试通过但跑的是另一份"的假象。
 *
 * 运行：node test/ui-build-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
// 两个位置都可用环境变量覆盖（2026-09-18 标准包化）：
// 门 2/门 3 把自测指向"刚装进去的那份包"（标准形态下 pkgDir = <profile>/node_modules/dsh-attention-health）。
// 默认值仍是本机现役的旧形态部署位置。
const pkgDir =
  process.env.DSH_ATTENTION_HEALTH_UI_DIR ?? path.join(profilesDir, 'node_modules', 'attention-health-ui');
const staleDir = path.join(profilesDir, 'web', 'attention-health-ui');

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

console.log('════════ 0. 被测位置 ════════');
console.log(`  运行时位置：${pkgDir}`);
if (fs.existsSync(staleDir)) {
  console.log(`  ⚠️ 发现历史残留副本（运行时不读取）：${staleDir}`);
}

console.log('\n════════ 1. package.json 结构（启动期校验点） ════════');
const pkgPath = path.join(pkgDir, 'package.json');
check('package.json 存在', fs.existsSync(pkgPath), pkgPath);

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  check('package.json 可解析', false, e.message);
  process.exit(1);
}
check('有 name 字段', typeof pkg.name === 'string' && pkg.name.length > 0, String(pkg.name));

// dsh-client-modules 只接受 exports["./client"] 的 string 或 { default: string }
const clientExport = pkg.exports?.['./client'];
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default;
check('exports["./client"] 存在且是字符串形式', typeof clientRel === 'string', JSON.stringify(clientExport));

const clientAbs = path.join(pkgDir, clientRel ?? '');
check('client 产物文件真实存在', fs.existsSync(clientAbs), clientAbs);

check('dsh.client.platform 已声明', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client));

const mainRel = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg.main;
check('node 半入口存在', fs.existsSync(path.join(pkgDir, mainRel ?? '')), String(mainRel));

console.log('\n════════ 2. 求值 client.js 并捕获 factory ════════');
let captured;
globalThis.window = {
  location: { search: '?token=test-token' },
  __ModuleLoader__: {
    load: (def) => {
      captured = def;
    },
  },
};

try {
  await import(pathToFileURL(clientAbs).href);
  check('client.js 求值成功', true);
} catch (e) {
  check('client.js 求值成功', false, e.message.slice(0, 200));
  process.exit(1);
}

check('注册了模块定义', Boolean(captured));
// 这条断言的口径是**规则本身**（`dsh-client-modules` 用「解析出的包名」当浏览器模块身份，
// 见 lib/index.js 的 graphRow(packageName, …)），而不是某个写死的名字：
//   · 旧形态部署 → 包名 attention-health-ui；
//   · 标准包形态 → 包名 dsh-attention-health。
// 写死任一个都会在另一种形态下假失败（2026-09-18 标准包化）。
check('模块 id == 包名（浏览器模块身份）', captured?.id === pkg.name, `${captured?.id} vs ${pkg.name}`);
check('提供了 factory', typeof captured?.factory === 'function');

console.log('\n════════ 3. 执行 factory（mock require） ════════');

/**
 * 最小 React 替身：
 *   - `createElement` 产出可遍历的元素树
 *   - `useState` 允许测试**预置**状态值（按调用顺序消费 stateQueue）
 *   - `useEffect` 只收集回调，由测试决定何时执行
 */
const effectCallbacks = [];
const stateWrites = [];
let stateQueue = [];
let stateCursor = 0;

const mockReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => {
    const index = stateCursor;
    const value = index < stateQueue.length ? stateQueue[index] : init;
    stateCursor += 1;
    // 记录 setter 调用，便于断言"界面确实显示了结果 / 错误"
    return [value, (next) => { stateWrites.push({ index, value: next }); }];
  },
  useEffect: (fn) => {
    effectCallbacks.push(fn);
  },
};

/** 渲染组件一次：states 预置 useState 返回值，返回元素树与本次注册的 effects。 */
function render(states, props) {
  stateQueue = states ?? [];
  stateCursor = 0;
  effectCallbacks.length = 0;
  stateWrites.length = 0;
  const out = registeredComponent(props);
  return { out, effects: [...effectCallbacks] };
}

/** 在元素树里深度优先找第一个 button。 */
function findButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button') return node;
  for (const child of node.children ?? []) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node 24 的 globalThis.navigator 只有 getter，必须 defineProperty 才能覆盖。 */
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const asked = new Set();
let mod;
try {
  mod = captured.factory((name) => {
    asked.add(name);
    if (name === 'react') return mockReact;
    // 如实暴露意外的依赖 —— 基座外模块会变成真实运行时错误
    throw new Error(`未预期的 require: ${name}`);
  });
  check('factory 执行成功', true);
} catch (e) {
  check('factory 执行成功', false, e.message.slice(0, 200));
  process.exit(1);
}

check('只依赖基座内的模块', [...asked].every((n) => n === 'react'), [...asked].join(', '));
check('导出 apply', typeof mod?.apply === 'function');
check('导出 inject 数组', Array.isArray(mod?.inject));
check('inject 含 slots', mod?.inject?.includes('slots'), JSON.stringify(mod?.inject));

console.log('\n════════ 4. apply(mockCtx) 注册 slot ════════');
const registered = [];
let registeredComponent = null;

const makeCtx = (services = {}) => ({
  get: (name) => services[name],
  slots: {
    inject: (key, cb) => cb(),
    register: (options, component) => {
      registered.push({ options, component });
      registeredComponent = component;
      return () => {};
    },
  },
});

try {
  mod.apply(makeCtx());
  check('apply 执行无异常', true);
} catch (e) {
  check('apply 执行无异常', false, e.message.slice(0, 200));
}

const reg = registered[0];
check('注册了组件', typeof reg?.component === 'function');
check('slot id 为 attention-health（与 stats 并存）', reg?.options?.id === 'attention-health', String(reg?.options?.id));
check('注册声明了正确的 slot name', reg?.options?.name === 'conversation.composer.dock');

console.log('\n════════ 5. 组件渲染（各 health 取值） ════════');
const cases = [
  ['无投影数据', undefined],
  ['ok（健康 → 只留轻入口）', { level: 'ok', score: 95, usedTokens: 1000, effectivePercent: 10, shouldNotify: false }],
  ['watch', { level: 'watch', score: 75, usedTokens: 300000, effectivePercent: 55, findings: ['有效上下文占用 55.0%'], repeatWorst: 0, degradedReplies: 0, shouldNotify: true }],
  ['warn', { level: 'warn', score: 55, usedTokens: 400000, effectivePercent: 78, findings: ['a', 'b'], repeatWorst: 3, degradedReplies: 1, shouldNotify: true }],
  ['critical', { level: 'critical', score: 20, usedTokens: 500000, effectivePercent: 100, findings: ['已超出有效窗口'], repeatWorst: 8, degradedReplies: 4, shouldNotify: true }],
];

for (const [label, health] of cases) {
  try {
    const { out } = render([false], { useProjection: () => health });
    if (health === undefined) {
      check(`${label} → 返回 null（不占位）`, out === null, JSON.stringify(out)?.slice(0, 60));
    } else if (health.shouldNotify === false) {
      // P3-4（2026-09-15 审查）：健康时不再整条消失，而是留一个极轻的常驻入口
      check(`${label} → 渲染轻入口且带按钮`, out !== null && findButton(out) !== null);
      check(`${label} → 轻入口不展开详情行`, !JSON.stringify(out).includes('有效占用'));
    } else {
      check(`${label} → 渲染出元素`, out && typeof out === 'object', JSON.stringify(out)?.slice(0, 60));
      check(`${label} → 折叠态不含操作按钮`, findButton(out) === null);
    }
  } catch (e) {
    check(`${label} → 渲染不抛错`, false, e.message.slice(0, 160));
  }
}

// 健康时的轻入口必须真的可用（能点、能拿到 sessionId）
const lightEntry = render([false], {
  useProjection: () => ({ level: 'ok', score: 98, shouldNotify: false, effectivePercent: 5 }),
  sessionId: 'sess-light',
});
check('轻入口按钮可点击', typeof findButton(lightEntry.out)?.props?.onClick === 'function');
check(
  '轻入口按钮文案为「复制交接内容」',
  JSON.stringify(findButton(lightEntry.out)?.children ?? '').includes('复制交接内容'),
);

// 缺 useProjection（slot 未注入时）也必须安全
try {
  const { out } = render([false], {});
  check('props 缺 useProjection 时安全返回 null', out === null);
} catch (e) {
  check('props 缺 useProjection 时安全返回 null', false, e.message.slice(0, 160));
}

console.log('\n════════ 5b. 口径一致性：界面只允许出现一个行动建议 ════════');
// 2026-09-15 用户实测截图反馈：顶部标题说"建议交接"、下面结论说"建议先 /compact"，
// 两条行动建议打架。修法是等级只描述规模、行动建议唯一来源 = 双维度结论。
const clientSource = fs.readFileSync(clientAbs, 'utf8');
check(
  '等级文案不再自带行动建议（LEVEL_META 无「建议交接」）',
  !/label:\s*'建议交接'/.test(clientSource),
  '等级只由上下文规模推出，不该直接给行动建议',
);
check(
  '折叠行改用双维度最终结论（adviceLabel）',
  clientSource.includes('const adviceLabel = health.compactAdviceText'),
);
check('顶部提示不再写无条件结论「退化风险明显」', !clientSource.includes('退化风险明显'));

const adviceProbe = render([false], {
  useProjection: () => ({
    level: 'warn',
    score: 55,
    usedTokens: 391012,
    effectivePercent: 78.2,
    windowPercent: 39.1,
    findings: [],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'compact',
    compactAdviceText: '建议先手动 /compact 再继续',
    compactBand: 'recommend',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 0,
  }),
});
const foldedText = JSON.stringify(adviceProbe.out);
check(
  '折叠行显示的是最终结论',
  foldedText.includes('建议先手动 /compact 再继续'),
  foldedText.slice(0, 160),
);
check('折叠行不再出现「建议交接」', !foldedText.includes('建议交接'), foldedText.slice(0, 160));

// ── 5c. 展开区排版：每一类信息只出现一次（2026-09-15 用户截图反馈）──
// 旧版把同一信息渲染了两遍：折叠行有建议、「建议：」行又有一遍；「有效占用」在事实行
// 与维度 A 各出现一次；等级说明里的 `**` 没被渲染，直接漏出星号。
const expandedProbe = render([true], {
  useProjection: () => ({
    level: 'warn',
    score: 55,
    usedTokens: 391012,
    effectivePercent: 78.2,
    windowPercent: 39.1,
    findings: ['进入有效窗口的偏大区，未检出退化信号（仍在可靠区间，注意观察；评分 −45）'],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'compact',
    compactAdviceText: '建议先手动 /compact 再继续',
    compactBand: 'recommend',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 0,
    summaryCount: 0,
    compactSavingPerRound: 23786,
    headroomToOfficial: 408988,
    headroomRounds: 177,
  }),
});
const expandedText = JSON.stringify(expandedProbe.out);
const countOf = (hay, needle) => hay.split(needle).length - 1;

check('展开态渲染出元素', expandedProbe.out !== null);
// 2026-09-18 L 节：展开区多了一行「建议」标题，所以整条提示条里行动建议最多出现**两次**
// —— 折叠行 1 次 + 展开区 1 次，正是 L.2 写下的上限（出现第三次就说明又在堆砌）。
check(
  '行动建议在整条提示条里最多出现两次（折叠行 + 展开区标题，L.2 上限）',
  countOf(expandedText, '建议先手动 /compact 再继续') === 2,
  `出现 ${countOf(expandedText, '建议先手动 /compact 再继续')} 次`,
);
check('展开区不再有「建议：」重复行', !expandedText.includes('建议：'));
check(
  '有效占用只出现一次（并入规模行）',
  countOf(expandedText, '有效占用') === 1,
  `出现 ${countOf(expandedText, '有效占用')} 次`,
);
check(
  '两个口径各自标注且同屏（L 节合并为一行：有效窗口与声明窗口不混用，且不出现"维度A/B"）',
  expandedText.includes('有效占用') &&
    expandedText.includes('声明窗口') &&
    !expandedText.includes('维度A') &&
    !expandedText.includes('维度B'),
);
check('展开区不出现未渲染的 Markdown 星号', !expandedText.includes('**'), expandedText.slice(0, 200));

// ── 5d. 异常现场明细（2026-09-18 H.8）────────────────────────────────────
// 用户诉求："点击异常提醒，能看看出问题的地方长什么样"。
// 真跳转 DSH 没有公开 API，所以是**就地展开**：host 下发「轮次 + 摘录」，界面列出来。
/** 在元素树里深度优先找"直接子节点含 needle 文本"的第一个节点。
 *
 * ⚠️ 必须处理**数组节点**：`children.map(...)` 在 mock React 里就是一个嵌套数组
 * （真实 React 会把它展平），不递归进数组就会"明明渲染了却找不到"。
 */
function findNodeByText(node, needle) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNodeByText(child, needle);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const kids = node.children ?? [];
  if (kids.some((c) => typeof c === 'string' && c.includes(needle))) return node;
  for (const child of kids) {
    const found = findNodeByText(child, needle);
    if (found) return found;
  }
  return null;
}

const samplesHealth = () => ({
  level: 'critical',
  score: 0,
  usedTokens: 729320,
  effectivePercent: 100,
  windowPercent: 60,
  findings: [],
  repeatWorst: 0,
  degradedReplies: 2,
  reasoningLoop: 7,
  shouldNotify: true,
  compactAdvice: 'handoff',
  compactAdviceText: '建议机械交接 + 新开会话',
  degradedSamples: [
    { turn: 12, kind: 'reasoning', excerpt: '做。 **（Go.）** 做。 **（Go.）** 做。' },
    { turn: 0, kind: 'guard', excerpt: '思考空转 —— 最近 60 个短行里有 32 行是「做。」' },
  ],
});
// useState 顺序：open / busy / notice / error / openSample
const samplesProbe = render([true, false, '', '', -1], { useProjection: samplesHealth });
const samplesText = JSON.stringify(samplesProbe.out);
check('展开区列出异常现场（H.8）', samplesText.includes('异常现场'), samplesText.slice(0, 200));
check('现场条目带轮次', samplesText.includes('第 12 轮'));
check('轮次未知时如实显示（host 约定 turn = 0）', samplesText.includes('轮次未知'));
check(
  '现场条目带类型标签',
  samplesText.includes('思考异常') && samplesText.includes('已中止空转'),
);
check('收起态显示原文预览', samplesText.includes('做。'));

// 反例：没有异常明细时整块不渲染（无异常 = 不占版面）
const noSamplesProbe = render([true], {
  useProjection: () => ({
    level: 'warn',
    score: 55,
    usedTokens: 300000,
    effectivePercent: 70,
    shouldNotify: true,
    repeatWorst: 0,
    degradedReplies: 0,
    reasoningLoop: 0,
  }),
});
check(
  '无异常明细 → 不渲染"异常现场"块',
  !JSON.stringify(noSamplesProbe.out).includes('异常现场'),
);

// 原文未留存（思考正文没落盘、只有计数）时，展开要如实说明，而不是留一个空框
const emptyExcerptProbe = render([true, false, '', '', 0], {
  useProjection: () => ({
    level: 'critical',
    score: 10,
    usedTokens: 700000,
    effectivePercent: 95,
    shouldNotify: true,
    repeatWorst: 0,
    degradedReplies: 0,
    reasoningLoop: 3,
    degradedSamples: [{ turn: 5, kind: 'reasoning', excerpt: '' }],
  }),
});
check(
  '摘录为空时如实说明（不显示空框）',
  JSON.stringify(emptyExcerptProbe.out).includes('原文未留存'),
);

// 点击标题 → 切换 openSample（H.8 的核心交互）
const clickProbe = render([true, false, '', '', -1], {
  useProjection: () => ({
    level: 'critical',
    score: 10,
    usedTokens: 700000,
    effectivePercent: 95,
    shouldNotify: true,
    repeatWorst: 0,
    degradedReplies: 0,
    reasoningLoop: 3,
    degradedSamples: [{ turn: 5, kind: 'reasoning', excerpt: '重复内容'.repeat(30) }],
  }),
});
const sampleNode = findNodeByText(clickProbe.out, '第 5 轮');
check('现场标题可点击', typeof sampleNode?.props?.onClick === 'function');
if (typeof sampleNode?.props?.onClick === 'function') {
  sampleNode.props.onClick();
  check(
    '点击后展开该条（openSample = 0）',
    stateWrites.some((w) => w.value === 0),
    JSON.stringify(stateWrites),
  );
}

// 展开态必须能看到完整摘录 + 复制按钮
const openSampleProbe = render([true, false, '', '', 0], {
  useProjection: () => ({
    level: 'critical',
    score: 10,
    usedTokens: 700000,
    effectivePercent: 95,
    shouldNotify: true,
    repeatWorst: 0,
    degradedReplies: 0,
    reasoningLoop: 3,
    degradedSamples: [{ turn: 5, kind: 'reasoning', excerpt: '重复的现场原文' }],
  }),
});
const openSampleText = JSON.stringify(openSampleProbe.out);
check('展开态显示完整摘录', openSampleText.includes('重复的现场原文'));
check('展开态提供「复制片段」', openSampleText.includes('复制片段'));
check('评分依据作为末行小字出现', expandedText.includes('评分依据：'));
check(
  '关键数字保留（占声明 39.1% / 距官方线 408,988 / 约 177 轮）',
  expandedText.includes('39.1%') && expandedText.includes('408,988') && expandedText.includes('177'),
);

// ── 5d. 思考退化与启发式标注（2026-09-15 全量复核 N-5 / N-6）──
// N-5：旧界面只看最终回复，思考里的退化（实测事故：同一行重复 69,667 次、
//      烧掉 256K output token）在界面上完全没有痕迹。现在单列并带命中原因。
// N-6：评分是**启发式**指标，界面必须说出来，避免被当成测量结论。
const thinkProbe = render([true], {
  useProjection: () => ({
    level: 'warn',
    score: 50,
    usedTokens: 300000,
    effectivePercent: 60,
    windowPercent: 30,
    findings: ['思考过程出现打转：1 次（最长同一行重复 69,667 次）（评分 −25）'],
    repeatWorst: 0,
    degradedReplies: 2,
    replyReasons: [{ key: 'symbolRun', count: 2, label: '符号堆砌' }],
    reasoningLoop: 1,
    reasoningFlags: 0,
    reasoningWorstRepeat: 69667,
    reasoningReasons: [{ key: 'thinkLoop', count: 1, label: '思考打转' }],
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
    compactBand: 'recommend',
    qualityAdvice: 'handoff',
    compactWorthwhile: true,
    compactionCount: 1,
    summaryCount: 1,
    compactSavingPerRound: 12000,
    headroomToOfficial: 500000,
    headroomRounds: 100,
  }),
});
const thinkText = JSON.stringify(thinkProbe.out);
check(
  'N-5：折叠行不再用「思考异常 N 次」聚合写法（U 节起改为直接列具体信号）',
  !thinkText.includes('思考异常 1 次'),
  thinkText.slice(0, 220),
);
check(
  'N-5：展开区列出退化命中原因与次数',
  thinkText.includes('符号堆砌 ×2') && thinkText.includes('思考打转'),
  thinkText.slice(0, 400),
);
// 2026-09-18 UI 整理：不再用「思考异常 N 次（原因…）」聚合写法（与括号内计数重复），
// 改为直接列具体信号「思考打转 N 次」。
check('N-5：思考打转作为具体信号并列进质量维度', thinkText.includes('思考打转 1 次'));
check('N-5：没有思考异常时不显示该行', !expandedText.includes('思考异常'));
check('N-5：行动建议最多出现两次（折叠行 + 展开区标题）', countOf(thinkText, '建议机械交接 + 新开会话') === 2);
check('N-6：界面标注「评分为启发式指标」', thinkText.includes('启发式指标'), thinkText.slice(0, 300));
check(
  'N-6：界面标注「有效窗口 = 声明窗口 × 0.6」（系数由 host 下发）',
  thinkText.includes('声明窗口 × 0.6'),
  thinkText.slice(0, 300),
);

// ── 5e. 建议的「依据」与「三方案权衡」（2026-09-16 富化）──────────────────────
// 背景：host 早就算好了完整依据（`compactAdviceNote`）和三方案成本
// （继续 / 先压缩 / 机械交接），但界面只显示一句结论 —— 用户看得到"建议交接"，
// 看不到"为什么"，也看不到"另一条路要多少代价"。这是"权衡各项数据"最直接的落点。
const richPayload = {
  level: 'warn',
    score: 50,
    usedTokens: 260558,
    effectivePercent: 52.1,
    windowPercent: 26.1,
    findings: ['已过有效窗口一半（评分 −25）'],
    repeatWorst: 1,
    degradedReplies: 0,
    reasoningLoop: 0,
    reasoningFlags: 1,
    reasoningReasons: [{ key: 'thinkBudget', count: 1, label: '思考预算打满' }],
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
    // 故意塞进 Markdown 粗体：界面不渲染 Markdown，必须被剥掉（防漂移保险）
    compactAdviceNote: '已发生 3 次**有损摘要**，反复压缩收益递减',
    compactBand: 'mild',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 3,
    summaryCount: 3,
    continuePerRound: 26192,
    compactPerRound: 10477,
    compactSavingPerRound: 15715,
    compactBreakEvenRounds: 11,
    freshPerRound: 32000,
    cacheHitRate: 0.999,
    // ── 真实价格（元）口径（2026-09-16 接入）──
    costContinuePerRound: 0.0271,
    costCompactPerRound: 0.0152,
    costCompactOnce: 0.4058,
    costCompactAmortizedPerRound: 0.0378,
    costFreshPerRound: 0.023,
    costBreakEvenRounds: 21.3,
    // N 节（2026-09-18）：判定改成「交接回本轮数 + 1 轮余量 < 预计剩余轮数」，
    // 界面必须把这两个数露出来，用户才能自己核对结论。
    costFreshBreakEvenRounds: 1.8,
    costFreshWinMarginRounds: 12.5,
    costFreshWinsOnCost: false,
    costTotalContinue: 7.42,
    costTotalCompact: 8.57,
    costTotalFresh: 6.33,
    // S 节（2026-09-18）：正文要给出**具体节省额** —— 只给"建议交接"这个结论，
    // 用户无法区分"省 2 分"与"省 2 毛"（实测差 10 倍）。
    costSavingYuan: 1.09,
    costSavingEnough: true,
    // T 节（2026-09-18）：价格来源 / 日期 / 档位必须可见（否则调价或换模型后
    // 账已经算错，而界面看起来一样自信）。
    costPriceKnown: true,
    costPriceTier: 'offPeak',
    costPriceLabel: '价格：内置核对值 2026-09-18 · 空闲价',
    costHorizonRounds: 274,
    costHitRateKnown: true,
    avgOutputTokens: 600,
    headroomToOfficial: 539442,
    headroomRounds: 274,
  avgRoundGrowth: 68519,
};
const richProbe = render([true], { useProjection: () => richPayload });
const richText = JSON.stringify(richProbe.out);
check(
  '富化：轮数旁边给出**分母**（按每轮 +N；L 节后移入 ⓘ，仍可查到）',
  richText.includes('按每轮 +68,519'),
  richText.slice(0, 700),
);
check(
  '富化：展开区给出「依据」行（L 节由「判定依据」缩短为「依据」，省标签列宽度）',
  richText.includes('"依据"'),
  richText.slice(0, 300),
);
// ── 真实花费（元）：2026-09-16 起成本判定用真实价格，界面必须把它露出来 ──
check(
  // X 节（2026-09-18）：正文只留「继续 vs 交接」；命中率仍在 ⓘ 里（那是金额可不可信的依据）。
  '真实花费：正文显示元/轮（继续 vs 交接），命中率进 ⓘ',
  richText.includes('元/轮') &&
    richText.includes('¥0.027') &&
    richText.includes('¥0.023') &&
    richText.includes('命中率 99.9%'),
  richText.slice(0, 400),
);
// ── P1（审查）：界面不得自称"最省"与宿主判定分叉 ──
// 宿主判定带 1.5 倍容差并经优先级链；界面按绝对最小重算会出现
// "账面最小是新开、结论却是现在手动 /compact"的同屏打脸（实测 760k 场景）。
check(
  'P1：界面不宣称"最省"，总花费只并列「继续 vs 新开」（压缩已按 X 节移除）',
  richText.includes('到官方线前总花费') &&
    !richText.includes('最省') &&
    !/压缩 ¥/.test(richText) &&
    richText.includes('窗口 274 轮'),
  richText.slice(0, 400),
);
// L 节进一步收紧：旧版还会在 `costFreshWinsOnCost=true` 时说一句"新开明显更省"，
// 那是**界面在替宿主下判断**（宿主判定还带轮数余量与优先级链）。
// 现在无论该字段真假，界面都只说"谁更省以最终建议为准" —— 判定权完全留在宿主。
check(
  'P1：无论 costFreshWinsOnCost 真假，界面都不自称"最省"（判定权完全在宿主）',
  (() => {
    const p = render([true], {
      useProjection: () => ({ ...richPayload, costFreshWinsOnCost: true }),
    });
    const t = JSON.stringify(p.out);
    return !t.includes('明显更省') && !t.includes('最省');
  })(),
);
check('富化：依据由 host 提供（界面不自己编口径）', richText.includes('反复压缩收益递减'));
check('富化：依据里的 Markdown 粗体被剥掉（界面不渲染 Markdown）', !richText.includes('**'));
check(
  // X 节（2026-09-18 用户拍板）：成本行**只留「继续 vs 交接」**——
  // 压缩已退出行动域，列在成本行里不驱动任何行动（"读者能否据此行动？不能就删"）。
  'X：成本行只剩「继续 vs 交接」（压缩不再出现在成本行）',
  /继续 ¥0\.027/.test(richText) && /交接 ¥0\.023/.test(richText) && !/压缩 ¥/.test(richText),
  richText.slice(0, 700),
);
check(
  'S：正文给出具体节省额（让用户自己判断值不值，而不是只给结论）',
  richText.includes('可省 ¥1.090'),
  richText.slice(0, 420),
);
check(
  'T：价格口径（来源 / 日期 / 档位）在 ⓘ 里可见',
  richText.includes('价格：内置核对值 2026-09-18'),
  richText.slice(0, 420),
);
check(
  'T：模型不在价表 → 正文如实说「成本比较已跳过」，而不是给个假金额',
  (() => {
    const p = render([true], {
      useProjection: () => ({
        ...richPayload,
        costPriceKnown: false,
        costPriceLabel: '模型 foo 不在价表里 —— 成本比较已跳过（只保留质量判定）',
      }),
    });
    const t = JSON.stringify(p.out);
    return t.includes('成本比较已跳过') && !t.includes('交接回本');
  })(),
);
check(
  '富化：给出交接回本轮数与余量（N 节新判据的两个数，用户能自行核对）',
  richText.includes('交接回本 1.8 轮') && richText.includes('余量 12.5 轮'),
  richText.slice(0, 700),
);
check('富化：给出缓存命中率（成本折扣的依据）', richText.includes('99.9%'));
// AD 节（2026-09-20）：`freshBreakEvenRounds = 0.0457` 曾被 `toFixed(1)` 显示成
// 「交接回本 0.0 轮」—— 数值没错，但读起来像数据坏了（用户实测截图发起复核的就是这个）。
// 修法：< 0.1 轮说「首轮内」（不带"轮"字，避免"首轮内 轮"）。
{
  const adProbe = render([true], {
    useProjection: () => ({ ...richPayload, costFreshBreakEvenRounds: 0.0457, costFreshWinMarginRounds: 5.9 }),
  });
  const adText = JSON.stringify(adProbe.out);
  check(
    'AD：回本 < 0.1 轮 → 显示「交接回本 首轮内」，不再出现「0.0 轮」',
    adText.includes('交接回本 首轮内') && !adText.includes('0.0 轮'),
    adText.slice(0, 500),
  );
  const adZero = render([true], {
    useProjection: () => ({ ...richPayload, costFreshBreakEvenRounds: 0, costFreshWinMarginRounds: 9 }),
  });
  check(
    'AD：回本为 0 → 保持「首轮即摊平」（原有分支不回退）',
    JSON.stringify(adZero.out).includes('交接回本 首轮即摊平'),
  );
}

// ── AF.2（2026-09-20 用户需求）：建议颜色体系 + 新增中间档 `prepare` ──────────────
// 需求 1：`handoff` 从**红**改**黄** —— 交接是"优化建议"，不是"故障警报"；
//         红色留给规模异常（critical），质量异常用橙（hasSignal）。
// 需求 2：`prepare`（准备交接）与 handoff 都是黄，靠 **图形 + 字重** 区分：
//         prepare「○」普通字重、handoff「●」加粗。
{
  const styleOf = (node, text) => {
    // 在渲染树里找"文字包含 text"的 span，返回它的 style（用于断言颜色/字重/图标）
    let found = null;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      const kids = Array.isArray(n.children) ? n.children : [];
      for (const k of kids) {
        if (k && k.type === 'span' && Array.isArray(k.children)) {
          const t = k.children.join('');
          if (t.includes(text)) { found = k.props?.style ?? {}; return; }
        }
        walk(k);
      }
    };
    walk(node);
    return found;
  };
  const renderHead = (health) => render([false], { useProjection: () => health }).out;
  // ⚠️ 图标/颜色要挑**没有质量信号**的 fixture：`richPayload` 自带退化信号
  // → `hasSignal` 为真 → 图标统一是橙色「⚠」、颜色走橙色分支（第一版就是这么假失败的）。
  const QUIET = {
    ...richPayload,
    repeatWorst: 0,
    degradedReplies: 0,
    reasoningLoop: 0,
    reasoningFlags: 0,
    reasoningReasons: [],
  };

  const handoffHead = renderHead({
    ...QUIET,
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
  });
  const handoffStyle = styleOf(handoffHead, '建议机械交接');
  check(
    'AF.2 需求 1：handoff 建议用**黄**色（不再是红 #ef4444）',
    handoffStyle?.color === '#eab308',
    JSON.stringify(handoffStyle),
  );
  const handoffIcon = styleOf(handoffHead, '●');
  check('AF.2 需求 1：handoff 图标仍是实心点「●」', handoffIcon?.color === '#eab308', JSON.stringify(handoffIcon));

  const prepareHead = renderHead({
    ...QUIET,
    compactAdvice: 'prepare',
    compactAdviceText: '接近交接阈值 · 可在下一个任务边界交接',
    compactAdviceNote: '交接即将比继续更划算；继续仍可行，只是边界快到了',
  });
  const prepareStyle = styleOf(prepareHead, '接近交接阈值');
  const prepareIcon = styleOf(prepareHead, '○');
  check(
    'AF.2 需求 2：prepare 出现在折叠行，且用**浅一档黄**（与 handoff 区分）',
    prepareStyle?.color === '#facc15' && prepareStyle?.fontWeight === 500,
    JSON.stringify(prepareStyle),
  );
  check('AF.2 需求 2：prepare 图标是空心点「○」', prepareIcon?.color === '#facc15', JSON.stringify(prepareIcon));
  check(
    'AF.2 需求 2：prepare 文案不催促（含「可在下一个任务边界交接」）',
    JSON.stringify(prepareHead).includes('可在下一个任务边界交接'),
  );
  check(
    'AF.2 需求 1/2：三档颜色互不相同（绿 / 浅黄 / 黄）',
    new Set([handoffStyle?.color, prepareStyle?.color]).size === 2,
    `${handoffStyle?.color} vs ${prepareStyle?.color}`,
  );
}
check(
  '富化：行动建议最多出现两次（折叠行 + 展开区标题）',
  countOf(richText, '建议机械交接 + 新开会话') === 2,
  `出现 ${countOf(richText, '建议机械交接 + 新开会话')} 次`,
);
check('富化：有效占用仍然只出现一次', countOf(richText, '有效占用') === 1);

// ── 5i. L 节验收（2026-09-18）：展开区 ≤4 行核心信息 + 规则解释括号全部移除 ──────
// 用户截图反馈："展开区像内容固定、伪装成的一样"。L.5 给的验收是**硬指标**，
// 所以这里**数行数**而不是靠肉眼：详情容器的第一个子节点就是 detailLines 数组。
/** 数出展开区的核心信息行数（-1 = 结构不符合预期，就是要失败）。 */
const coreRows = (node) => {
  const kids = Array.isArray(node?.children) ? node.children : [];
  const detailNode = kids.find(
    (c) => c && typeof c === 'object' && Array.isArray(c.children) && Array.isArray(c.children[0]),
  );
  const rows = detailNode && detailNode.children[0];
  return Array.isArray(rows) ? rows.length : -1;
};
const expandedRows = coreRows(expandedProbe.out);
check('L 节：展开区核心信息 ≤4 行（L.5 第 1 条）', expandedRows > 0 && expandedRows <= 4, `实际 ${expandedRows} 行`);
const richRows = coreRows(richProbe.out);
check('L 节：信息最多的场景（成本-交接）也 ≤4 行', richRows > 0 && richRows <= 4, `实际 ${richRows} 行`);

// L.2 处置清单最后一条：括号里的**规则解释**要删掉（写给开发者的话归文档）。
// 口径标注（"有效占用 x%"）保留 —— 它是坐标，不是解释。
check(
  'L 节：规则解释类括号已从正文移除（L.5 第 3 条）',
  !expandedText.includes('（不计入判定）') &&
    !expandedText.includes('回本偏慢') &&
    !expandedText.includes('规模大本身不劝你换会话'),
  expandedText.slice(0, 400),
);

// ⚠️ 上面那条是**假通过**的典型：`expandedProbe` 的 compactAdviceNote 是 undefined，
// 依据行压根没渲染，于是"界面里没有这句话"永远成立 —— 等于什么都没测。
// 这句话的真实来源是 **host 的文案表**（`FINAL_NOTES`，界面只是把它显示出来），
// 所以这里直接查那张表。2026-09-18 L 节就清理了它和一处**过期表述**。
// host 半的位置同样走 `DSH_ATTENTION_HEALTH_DIR` 覆盖（标准包形态下 = <包>/lib）。
const hostHandoffPath = path.join(
  process.env.DSH_ATTENTION_HEALTH_DIR ?? path.join(profilesDir, 'web', 'attention-health'),
  'handoff.js',
);
const hostHandoff = await import(pathToFileURL(hostHandoffPath).href);
const noteDump = JSON.stringify(hostHandoff.FINAL_NOTES);
check(
  'L 节：host 文案表里没有规则解释括号（「规模大本身不劝你换会话」已移除）',
  !noteDump.includes('规模大本身不劝你换会话'),
  noteDump.slice(0, 240),
);
check(
  'L 节：host 文案表里没有过期表述「新会话缓存从零重建」（N 节已改分段计费）',
  !noteDump.includes('缓存从零重建'),
  noteDump.slice(0, 240),
);

// 但那批信息**没有丢**：评分扣分依据 + 启发式声明现在挂在 ⓘ 的悬停提示上。
check(
  'L 节：评分依据与启发式声明收进 ⓘ（悬停可见，不占正文）',
  expandedText.includes('ⓘ') &&
    expandedText.includes('评分依据：') &&
    expandedText.includes('启发式指标'),
  expandedText.slice(0, 300),
);
// U 节（2026-09-18 概念审计）：U.4 列的"不要信"必须写进界面 ——
// 此前只说"是启发式、不代表精确测量"，容易被读成"65 分 = 健康 65%"。
check(
  'U：免责说明覆盖「不是健康度百分比」与「不能跨会话比分数」',
  expandedText.includes('健康度百分比') && expandedText.includes('不能跨会话比分数'),
  expandedText.slice(0, 400),
);

// ── 5j. U.5 方案甲：折叠行改报「档位 + 信号」，合成分降级到展开区（2026-09-18）──
//
// 用户拍板的形态：
//   · 有信号 → `⚠ 上下文过大 + 思考打转 10 次 · 建议交接`（档位是状态、信号是"要不要动手"）
//   · 无信号 → `上下文规模：偏大`
//   · **折叠行不得出现裸分数**（用户明确要求的回归断言）——那个合成分没有严格依据（U.2），
//     留在最显眼处会被读成"健康度百分比"
const headTextOf = (health) => JSON.stringify(render([false], { useProjection: () => health }).out);
{
  const withSignal = headTextOf({
    level: 'critical',
    score: 0,
    shouldNotify: true,
    usedTokens: 700000,
    effectivePercent: 100,
    reasoningLoop: 10,
    guardTripCount: 1,
    summaryCount: 3,
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
  });
  check(
    'U 方案甲：折叠行**不出现裸分数**（合成分已降级到展开区）',
    !/\d+\/100/.test(withSignal),
    withSignal.slice(0, 260),
  );
  check(
    'U 方案甲：有信号 → 折叠行给出「档位 + 信号 + 建议」',
    withSignal.includes('⚠') &&
      withSignal.includes('上下文过大') &&
      withSignal.includes('思考打转 10 次') &&
      withSignal.includes('建议机械交接 + 新开会话'),
    withSignal.slice(0, 260),
  );

  const noSignal = headTextOf({
    level: 'watch',
    score: 75,
    // W.6（2026-09-18）：无异常 → host 下发 shouldNotify=false，界面走**中性静默入口**。
    shouldNotify: false,
    usedTokens: 300000,
    effectivePercent: 60,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续（暂不必压缩）',
  });
  check(
    'W.6：无异常 → 静默入口中性（不出现规模档位词、也不出现建议）',
    noSignal.includes('● 无异常') &&
      !/偏大|较大|过大/.test(noSignal) &&
      !noSignal.includes('可以继续'),
    noSignal.slice(0, 260),
  );

  // ⚠️ 这条是**真问题**：无退化但成本通道判了交接（`level=ok`）时，
  // 折叠行若因"没信号"而不显示建议，用户就完全看不到该行动（2026-09-15 修过的老问题）。
  const costOnly = headTextOf({
    level: 'ok',
    score: 90,
    shouldNotify: true,
    usedTokens: 600000,
    effectivePercent: 100,
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
  });
  check(
    'U 方案甲：无信号但结论是交接（成本驱动）→ 折叠行仍显示建议',
    costOnly.includes('建议机械交接 + 新开会话'),
    costOnly.slice(0, 260),
  );

  check(
    'U 方案甲：分数移到展开区并标注"启发式 / 仅供同会话趋势"',
    expandedText.includes('/100（启发式') && expandedText.includes('仅供同会话趋势'),
    expandedText.slice(0, 300),
  );
}

// ── 5k. X 节（2026-09-18 用户拍板）：界面只呈现「现在是什么」与「可以做什么」 ──
//
// 原则：**设计决策的解释属于文档，不属于界面。**
// 判定标准：读者能否据此采取行动？不能 —— 就删。
// 下面这组是"不得出现"的钉子（沿用"界面不出现未渲染 Markdown"那套做法）。
const BANNED_IN_UI = [
  '摊不完',
  '摊不回来',
  '仅作对照',
  'P25~P75',
  '重定位',
  '压缩每轮省',
  '一次性成本',
  '此表',
  // 实施时照着原则又清掉的两处（用户没点名，但同属"解释设计"）：
  '精确率存疑',
  '不参与交接判定',
  '无损裁剪',
];
for (const word of BANNED_IN_UI) {
  const where = expandedText.includes(word) ? 'expandedText' : richText.includes(word) ? 'richText' : '';
  check(`X：界面不得出现「${word}」（死信息）`, where === '', where ? `出现在 ${where}` : '');
}
check(
  'X：界面不得出现时间戳式自我说明（如「2026-09-16 重定位」）',
  !/20\d\d-\d\d-\d\d\s*重定位/.test(expandedText) && !/20\d\d-\d\d-\d\d\s*重定位/.test(richText),
);
// 要留的：压缩历史是**事实**（说明这段上下文有损），不是对设计的说明。
check(
  'X：压缩历史仍在折叠行（事实，不是说明）',
  headTextOf({
    level: 'watch',
    score: 75,
    shouldNotify: true,
    usedTokens: 300000,
    effectivePercent: 60,
    summaryCount: 3,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续',
  }).includes('有损压缩 3 次'),
);

// ── 5f. 边界：缺窗口 / 缺用量时**不许假装知道**（2026-09-16）────────────────
// 旧版在 `usedTokens = 0`、`contextWindow` 缺失时照样渲染 "0 token · 有效占用 未知"，
// 维度行还会给出 "可继续" / "继续" 这种**编造出来的结论** —— 真相是"没有数据可判"。
const noWindowProbe = render([true], {
  useProjection: () => ({
    level: 'watch',
    score: 79,
    shouldNotify: true,
    usedTokens: 0,
    effectivePercent: null,
    windowPercent: null,
    findings: ['已经历 1 次模型摘要（有损）：原始内容已被摘要替换，细节可能已丢失（评分据此封顶 79）'],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'continue',
    compactAdviceText: '数据不足：暂无法判断（按现状继续即可）',
    compactAdviceNote: '缺窗口或用量数据，只能按现状继续',
    compactBand: 'continue',
    qualityAdvice: 'continue',
    compactionCount: 1,
    summaryCount: 1,
  }),
});
const noWindowText = JSON.stringify(noWindowProbe.out);
check('边界：规模未知时不显示 "0 token"', !noWindowText.includes('0 token'), noWindowText.slice(0, 320));
// L 节把"未知"统一成"无法判断（缺窗口或用量数据）" —— 都是**不编造**，只是措辞更明确。
check('边界：明确说"无法判断"而不是给个假数字', noWindowText.includes('无法判断'));
check(
  '边界：规模行如实说"无法判断（缺窗口或用量数据）"（不编造档位结论）',
  noWindowText.includes('无法判断（缺窗口或用量数据）'),
  noWindowText.slice(0, 320),
);
check('边界：建议行也如实说"暂无法判断"', noWindowText.includes('数据不足：暂无法判断'));
check('边界：不再出现编造的"可继续"', !noWindowText.includes('可继续'));
check('边界：仍如实交代"为什么"（缺数据）', noWindowText.includes('缺窗口或用量数据，只能按现状继续'));
check(
  // U 节（2026-09-18 方案甲）：折叠行只在**有信号**或**结论不是"继续"**时才带建议；
  // 本场景无退化、结论是"继续" → 折叠行只报规模档位，建议只在展开区出现一次。
  '边界：建议出现一次（无信号且结论是"继续"时折叠行只报档位）',
  countOf(noWindowText, '数据不足：暂无法判断（按现状继续即可）') === 1,
  `出现 ${countOf(noWindowText, '数据不足：暂无法判断（按现状继续即可）')} 次`,
);

// ── 5g. 向后兼容：host 还没重启（缺新字段）时界面不能更难看（2026-09-16）──────
// 刷新页面会立刻用上新渲染，而 host 要等重启才提供 `freshPerRound` / `cacheHitRate`。
// 缺字段时必须**省略该列**，而不是渲染"机械交接 未知（无损）"。
const oldHostProbe = render([true], {
  useProjection: () => ({
    level: 'warn',
    score: 55,
    usedTokens: 391012,
    effectivePercent: 78.2,
    windowPercent: 39.1,
    findings: ['进入有效窗口的偏大区（评分 −45）'],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'compact',
    compactAdviceText: '建议先手动 /compact 再继续',
    compactBand: 'recommend',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 0,
    summaryCount: 0,
    compactSavingPerRound: 23786,
    headroomToOfficial: 408988,
    headroomRounds: 177,
    // 刻意不给：compactAdviceNote / freshPerRound / compactBreakEvenRounds / cacheHitRate
  }),
});
const oldHostText = JSON.stringify(oldHostProbe.out);
check(
  '向后兼容：缺 freshPerRound 时省略"机械交接"列（不显示"未知（无损）"）',
  !oldHostText.includes('未知（无损）') && !oldHostText.includes('机械交接 未知'),
  oldHostText.slice(0, 600),
);
check('向后兼容：缺 compactAdviceNote 时不渲染空的「依据」行', !oldHostText.includes('"依据"'));
check(
  '向后兼容：规模信息仍然照常显示（不再依赖成本块）',
  oldHostText.includes('408,988'),
  oldHostText.slice(0, 300),
);
check(
  '收缩：结论不是「交接」时不渲染成本明细（成本展示让给 dsh-context）',
  !oldHostText.includes('23,786'),
  oldHostText.slice(0, 400),
);
check(
  '向后兼容：行动建议最多出现两次（折叠行 + 展开区标题）',
  countOf(oldHostText, '建议先手动 /compact 再继续') === 2,
  `出现 ${countOf(oldHostText, '建议先手动 /compact 再继续')} 次`,
);

// ── 5h. P1（Codex 审查）：结论是"别压"时，不得出现省钱的暗示（2026-09-16）──────
// 复现：刚压缩过、可压缩余量只占 6.3% → host 结论 continue、依据"收益 ≈ 0"，
// 但 `savingPerRound` 算术上仍为正（2,562）；旧 UI 先命中 `saving > 0`，
// 渲染出"压缩每轮省 2,562" —— 与结论打架，等于劝用户再压一次。
const noWorthProbe = render([true], {
  useProjection: () => ({
    level: 'watch',
    score: 75,
    shouldNotify: true,
    usedTokens: 320000,
    effectivePercent: 64,
    windowPercent: 32,
    findings: ['已过有效窗口一半（评分 −25）'],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续（暂不必压缩；接近官方线或阶段结束再压）',
    compactAdviceNote: '当前只占声明窗口 32.0%（官方线在 80%），现在不必压缩',
    compactBand: 'mild',
    qualityAdvice: 'continue',
    compactWorthwhile: false,
    compactionCount: 1,
    summaryCount: 1,
    compactSavingPerRound: 2562,
    compactBreakEvenRounds: null,
    compactTotalOnce: 409000,
    continuePerRound: 41000,
    compactPerRound: 38438,
    freshPerRound: 32000,
    cacheHitRate: 0.969,
    headroomToOfficial: 480000,
  }),
});
const noWorthText = JSON.stringify(noWorthProbe.out);
check(
  '收缩：结论「别压」时**不得**出现任何成本明细（含「压缩每轮省」与回本语境）',
  !noWorthText.includes('压缩每轮省') &&
    !noWorthText.includes('压缩收益 ≈ 0') &&
    !noWorthText.includes('抵消不了一次性成本'),
  noWorthText.slice(0, 700),
);
check(
  // 同"边界"那条：无信号 + 结论"继续" → 折叠行只报档位，建议在展开区出现一次。
  'P1：行动建议出现一次（折叠行只报档位）',
  countOf(noWorthText, '可以继续（暂不必压缩；接近官方线或阶段结束再压）') === 1,
  `出现 ${countOf(noWorthText, '可以继续（暂不必压缩；接近官方线或阶段结束再压）')} 次`,
);

// O3（Codex 建议）：回本很慢时补语境，避免"约 88 轮回本"被读成"值得压"
const slowPayback = render([true], {
  useProjection: () => ({
    level: 'watch',
    score: 65,
    usedTokens: 20178,
    effectivePercent: 4,
    windowPercent: 2,
    findings: [],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续（无需压缩，也无需交接）',
    compactBand: 'continue',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 0,
    summaryCount: 0,
    continuePerRound: 2221,
    compactPerRound: 1913,
    compactSavingPerRound: 308,
    compactBreakEvenRounds: 88,
    compactTotalOnce: 27000,
    freshPerRound: 32000,
    cacheHitRate: 0.989,
    headroomToOfficial: 779822,
    headroomRounds: 487,
    avgRoundGrowth: 1600,
  }),
});
const slowText = JSON.stringify(slowPayback.out);
check(
  '收缩：结论是「继续」时不再渲染回本语境（压缩已退出行动域）',
  !slowText.includes('88 轮回本') && !slowText.includes('回本偏慢'),
  slowText.slice(0, 700),
);

// ── 5i. P2（Codex 审查）：stripMd 必须能剥掉反引号与单星号 ────────────────────
const mdProbe = render([true], {
  useProjection: () => ({
    level: 'warn',
    score: 55,
    usedTokens: 300000,
    effectivePercent: 60,
    windowPercent: 30,
    findings: [],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续（无需压缩，也无需交接）',
    compactAdviceNote: '已发生 3 次**有损摘要**，`/compact` 收益递减*明显*',
    compactBand: 'mild',
    qualityAdvice: 'continue',
    compactWorthwhile: true,
    compactionCount: 3,
    summaryCount: 3,
  }),
});
const mdText = JSON.stringify(mdProbe.out);
check(
  'P2：note 里的 `**`、反引号、单星号全部被剥掉',
  !mdText.includes('**') && !mdText.includes('`') && !mdText.includes('*'),
  mdText.slice(0, 500),
);
check('P2：剥离后文本仍然可读', mdText.includes('已发生 3 次有损摘要'));

// P1-1（2026-09-15 审查修复）：等级与建议脱钩 —— level=ok 但最终建议是交接时，
// 旧渲染条件（`level !== 'ok'`）会让整条提示条连同复制按钮一起消失。
const okButHandoff = render([false], {
  useProjection: () => ({
    level: 'ok',
    score: 92,
    shouldNotify: true,
    usedTokens: 200000,
    effectivePercent: 40,
    windowPercent: 20,
    findings: [],
    repeatWorst: 0,
    degradedReplies: 0,
    compactAdvice: 'handoff',
    compactAdviceText: '建议机械交接 + 新开会话',
    compactBand: 'continue',
    qualityAdvice: 'continue',
    compactionCount: 2,
    summaryCount: 2,
    compactWorthwhile: true,
  }),
});
check('level=ok 但建议交接 → 提示条仍出现', okButHandoff.out !== null);
check(
  'level=ok 但建议交接 → 折叠行显示交接结论',
  JSON.stringify(okButHandoff.out ?? '').includes('建议机械交接'),
);

const okContinue = render([false], {
  useProjection: () => ({
    level: 'ok',
    score: 100,
    shouldNotify: false,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续（无需压缩，也无需交接）',
  }),
});
// P3-4 之后：健康时不再整条消失，而是留一个极轻的常驻入口（不展开详情）
check(
  'level=ok 且建议继续 → 只渲染轻入口',
  okContinue.out !== null && findButton(okContinue.out) !== null,
);
check('level=ok 且建议继续 → 轻入口不含详情', !JSON.stringify(okContinue.out).includes('有效占用'));

// ── W 节（2026-09-18 用户拍板）：静默态也要"想看就展开" ──────────────────────
// 静默现在覆盖两种情况：真健康，以及"仅规模偏大但无退化、成本也不过门槛"。
// 后者仍有信息价值（规模多少、账怎么算），所以入口上加一个展开。
{
  const okText = JSON.stringify(okContinue.out);
  check('W：静默态提供「详情 ▾」展开入口', okText.includes('详情 ▾'), okText.slice(0, 240));
  check(
    // W.6（2026-09-18 用户反馈）：入口**只能中性** —— 写"● 上下文规模：过大"
    // 会自己打自己的脸（判定说"不需要打扰"，字面却像警报）。规模档位只在展开区。
    'W.6：静默入口为中性文案「● 无异常」，且不出现裸分数',
    okText.includes('● 无异常') && !/\d+\/100/.test(okText),
    okText.slice(0, 240),
  );
  // 用户验收点名的场景：规模很大（critical）、但无任何异常 → 入口仍必须中性
  const silentBig = headTextOf({
    level: 'critical',
    score: 25,
    shouldNotify: false,
    usedTokens: 696000,
    effectivePercent: 100,
    compactAdvice: 'continue',
    compactAdviceText: '可以继续',
  });
  check(
    'W.6：规模很大但无异常 → 入口不出现任何规模档位词（用户验收）',
    silentBig.includes('● 无异常') && !/偏大|较大|过大/.test(silentBig),
    silentBig.slice(0, 260),
  );

  // 展开后能看到规模与账（同一个组件在 open=true 时渲染完整详情）
  const opened = render([true], {
    useProjection: () => ({
      level: 'watch',
      score: 75,
      shouldNotify: false,
      usedTokens: 417000,
      contextWindow: 1000000,
      effectivePercent: 69,
      windowPercent: 41.7,
      compactAdvice: 'continue',
      compactAdviceText: '可以继续（无需压缩，也无需交接）',
      findings: [],
      repeatWorst: 0,
      degradedReplies: 0,
    }),
  });
  const openedText = JSON.stringify(opened.out);
  check(
    'W：静默态展开后可见规模与评分（信息没丢，只是默认不打扰）',
    openedText.includes('417,000') && openedText.includes('/100（启发式'),
    openedText.slice(0, 300),
  );
}

console.log('\n════════ 6. 交接生成交互（生成 → 复制到剪贴板） ════════');
const calls = { fetch: [], copied: [] };

globalThis.fetch = async (url) => {
  calls.fetch.push(String(url));
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ ok: true, markdown: '# 会话交接内容\n\n- 演示交接正文', stats: { events: 5, ms: 3 } }),
  };
};

const healthWarn = {
  level: 'warn',
  score: 55,
  usedTokens: 400000,
  effectivePercent: 78,
  repeatWorst: 0,
  degradedReplies: 0,
  findings: ['演示'],
};

// 剪贴板主路径：异步 API
setGlobal('navigator', { clipboard: { writeText: async (text) => { calls.copied.push(text); } } });
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: '' }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => false,
};

// ① 展开态 → 出现按钮
const expanded = render([true], { useProjection: () => healthWarn, sessionId: 'sess-1' });
const button = findButton(expanded.out);
check('展开后出现操作按钮', Boolean(button));

// 两档输出（2026-09-15 用户选择）：默认精简档 + 「复制完整版」
const allButtons = [];
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'button') allButtons.push(node);
  for (const child of node.children ?? []) walk(child);
})(expanded.out);
check('展开后有两个按钮（精简档 + 完整档）', allButtons.length === 2, `实际 ${allButtons.length}`);
check(
  '第二个按钮是「复制完整版」',
  JSON.stringify(allButtons[1]?.children ?? '').includes('复制完整版'),
);
check(
  '按钮文案为「复制交接内容」',
  // 本测试的 mock createElement 把 children 收在元素对象的 children 上
  JSON.stringify(button?.children ?? '').includes('复制交接内容'),
  JSON.stringify(button?.children),
);

// ② 点击 → 请求本地接口 → 内容进剪贴板 → 界面提示成功
button.props.onClick();
await sleep(30);
check(
  '点击后请求了本地生成接口',
  calls.fetch.length === 1 && calls.fetch[0].startsWith('/attention-health/handoff'),
  calls.fetch[0],
);
check('请求携带会话 id', calls.fetch[0]?.includes('sessionId=sess-1'), calls.fetch[0]);
check(
  '默认走精简档（profile=slim）',
  calls.fetch[0]?.includes('profile=slim'),
  calls.fetch[0],
);
check('请求携带页面 token', calls.fetch[0]?.includes('token=test-token'), calls.fetch[0]);
check('内容已写入剪贴板', calls.copied.length === 1, String(calls.copied.length));
check(
  '剪贴板内容是交接正文',
  typeof calls.copied[0] === 'string' && calls.copied[0].includes('会话交接内容'),
  String(calls.copied[0]).slice(0, 40),
);
check(
  '界面显示了成功提示（notice 状态被写入）',
  stateWrites.some((w) => w.index === 2 && typeof w.value === 'string' && w.value.includes('已复制')),
  JSON.stringify(stateWrites.map((w) => w.index)),
);

// ③ 后端失败 → 不写剪贴板 + 界面显示错误
globalThis.fetch = async () => ({
  ok: false,
  status: 500,
  text: async () => JSON.stringify({ ok: false, error: '模拟后端失败' }),
});
calls.copied.length = 0;
const failButton = findButton(render([true], { useProjection: () => healthWarn, sessionId: 'sess-1' }).out);
failButton.props.onClick();
await sleep(30);
check('后端失败时不写剪贴板', calls.copied.length === 0, JSON.stringify(calls.copied));
check(
  '界面显示了失败原因（error 状态被写入）',
  stateWrites.some((w) => w.index === 3 && typeof w.value === 'string' && w.value.includes('模拟后端失败')),
  JSON.stringify(stateWrites),
);

// ④ 异步剪贴板被拒 → 回退 execCommand
globalThis.fetch = async (url) => {
  calls.fetch.push(String(url));
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, markdown: '兜底正文' }) };
};
const fallback = [];
setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } });
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: '' }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: (cmd) => { fallback.push(cmd); return true; },
};
const fbButton = findButton(render([true], { useProjection: () => healthWarn, sessionId: 'sess-1' }).out);
fbButton.props.onClick();
await sleep(30);
check('剪贴板 API 被拒时回退 execCommand', fallback.includes('copy'), JSON.stringify(fallback));

// ⑤ 两条路径都失败 → 明确报错（不假装成功、也不抛异常）
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: '' }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => false,
};
let threw = false;
const badButton = findButton(render([true], { useProjection: () => healthWarn, sessionId: 'sess-1' }).out);
try {
  badButton.props.onClick();
  await sleep(30);
} catch (_error) {
  threw = true;
}
check('两条剪贴板路径都失败时不抛异常（错误走界面）', threw === false);
check(
  '两条路径都失败时界面给出错误',
  stateWrites.some((w) => w.index === 3 && typeof w.value === 'string' && w.value.length > 0),
  JSON.stringify(stateWrites),
);

console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
process.exit(fail === 0 ? 0 : 1);
