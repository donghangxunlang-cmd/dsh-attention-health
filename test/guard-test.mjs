/**
 * `lib/guard.js` 的单元测试：实时「思考复读 / 空转」守卫。
 *
 * 这个守卫会**中断正在进行的生成**，所以"不误杀"比"多抓住"重要得多 ——
 * 用例里正例（该抓）与反例（不该抓）同等重要。
 *
 * 运行：node test/guard-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const projectFile = path.join(projectRoot, 'lib', 'guard.js');
// 部署目录可用环境变量覆盖（2026-09-18 标准包化）：临时 profile 实验靠它指向刚装进去的那份。
const deployedDir =
  process.env.DSH_ATTENTION_HEALTH_DIR ??
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'attention-health');
const deployedFile = path.join(deployedDir, 'guard.js');
const target = fs.existsSync(deployedFile) ? deployedFile : projectFile;
console.log(`  被测文件：${target}${target === projectFile ? '（部署副本不存在，回退源码）' : '（部署副本）'}`);

const { createLoopGuard, GUARD_DEFAULTS } = await import(pathToFileURL(target).href);

/** 把若干片段依次喂进去，返回首次命中的结果（没有命中返回 null）。 */
const feed = (guard, pieces) => {
  for (const p of pieces) {
    const hit = guard.push(p);
    if (hit) return hit;
  }
  return null;
};

console.log('\n════════ 1. 反例：正常思考不得被打断 ════════');
// 正常推理：行行不同、有长有短、有代码块
{
  const g = createLoopGuard();
  const normal = [
    '让我先看看这个文件的结构。\n',
    '第一段是导入语句，看起来没问题。\n',
    '接下来检查第 42 行的边界条件。\n',
    '```js\n',
    'if (!event || typeof event !== "object") return state;\n',
    '```\n',
    '这里的防御是必要的，因为事件流里可能出现 null。\n',
    '我需要在 index.js 里也加同样的守卫。\n',
  ];
  check('正常推理（行行不同）不触发', feed(g, normal) === null);
}
{
  // 大量正常递增内容：100 行各不相同
  const g = createLoopGuard();
  const lines = [];
  for (let i = 0; i < 100; i += 1) lines.push(`第 ${i} 个步骤：检查模块 ${i} 的导出与依赖关系\n`);
  check('100 行各不相同的长思考不触发', feed(g, lines) === null);
}
{
  // 短行**偶尔**出现（代码块结尾、分隔线）——不该被当成复读。
  // 注：2026-09-18 H.5 起，"密集短行"（同一短行 ≥30 次）**会**触发 ——
  // 那是短行交替空转的真实特征（见下方 H.1 现场用例）。
  // 这里保留的防御意图是：**短行本身**不构成复读，只有密度才构成。
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 40; i += 1) {
    pieces.push(`检查第 ${i} 项是否成立，确认边界情况都已覆盖\n`);
    if (i % 10 === 0) pieces.push('```\n', '---\n', '}\n', ');\n');
  }
  check('短行偶尔出现（``` / --- / } / );）不触发', feed(g, pieces) === null);
}
{
  // 同一个词在正常句子里重复出现（不是整行重复）
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 30; i += 1) pieces.push(`我认为 cache 很重要，第 ${i} 次确认 cache 的行为。\n`);
  check('同一关键词在不同句子里反复出现不触发', feed(g, pieces) === null);
}

console.log('\n════════ 2. 正例：越界重复必须被抓到 ════════');
{
  const g = createLoopGuard();
  const line = '我需要重新考虑这个问题，因为前面的推理可能存在一些问题\n';
  const hit = feed(g, Array.from({ length: GUARD_DEFAULTS.streakLimit }, () => line));
  check('同一行连续重复 8 次 → 命中 repeat-line', hit !== null && hit.kind === 'repeat-line', JSON.stringify(hit));
}
{
  const g = createLoopGuard();
  const hit = feed(g, Array.from({ length: 20 }, () => 'aaaa'));
  check('行内片段连续重复（无换行）→ 命中 repeat-inline', hit !== null && hit.kind === 'repeat-inline', JSON.stringify(hit));
}
{
  // ── 2026-09-18 H.1 真实现场：**短行交替复读** ──
  // 形态：`做。` 与 `**（Go.）**` / `**（执行。）**` 这类短行 A/B/A/B 交替。
  // 它躲开了原有两条规则（短行被 minLineChars 挡掉、不进旧窗口），守卫全程未触发。
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 40; i += 1) {
    pieces.push('做。\n', '**（Go.）**\n', '做。\n', '**（执行。）**\n');
  }
  const hit = feed(g, pieces);
  check(
    'H.1 现场｜短行交替复读必须触发（短行高频 / 窗口空转）',
    hit !== null && (hit.kind === 'short-line-repeat' || hit.kind === 'spinning'),
    JSON.stringify(hit),
  );
}
{
  // 反例：正常推理里短句**偶尔**点缀（"好。"每 12 行长行才出现一次）
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 60; i += 1) {
    pieces.push(`第 ${i} 步：检查模块 ${i} 的导出与依赖关系，确认没有循环引用问题\n`);
    if (i % 12 === 0) pieces.push('好。\n');
  }
  check('H.5 反例｜正常推理里偶尔出现短句不触发', feed(g, pieces) === null);
}
{
  // 反例：代码短行 / 分隔线**偶尔**出现（真实思考的常态，不是密集堆叠）
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 60; i += 1) {
    pieces.push(`检查第 ${i} 个条件是否成立，确认边界情况都已经覆盖\n`);
    if (i % 15 === 0) pieces.push('```\n', '}\n', '---\n');
  }
  check('H.5 反例｜代码短行 / 装饰线偶尔出现不触发', feed(g, pieces) === null);
}
{
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 80; i += 1) pieces.push(`只有三种内容的空转行，这是其中第 ${i % 3} 种写法\n`);
  const hit = feed(g, pieces);
  check('窗口内几乎全是重复行 → 命中 spinning', hit !== null && hit.kind === 'spinning', JSON.stringify(hit));
}
{
  // 真实事故形态：同一行重复数万次
  const g = createLoopGuard();
  const line = '我们需要再仔细想想这个问题，重新审视一下前面的结论是否正确\n';
  let hit = null;
  let fed = 0;
  for (let i = 0; i < 500 && !hit; i += 1) {
    hit = g.push(line);
    fed += 1;
  }
  check(
    '真实事故形态（同行重复上万次）在很早处就被抓住',
    hit !== null && fed <= GUARD_DEFAULTS.streakLimit + 1,
    `第 ${fed} 次喂入时命中`,
  );
}

console.log('\n════════ 2b. Q 节（2026-09-18）：行内复读判据的方向性缺陷 ════════');
// 旧实现只试 [8, 16, 32] 三个**固定**单元长度并按该长度对齐向前比对，两个方向都错：
//   · 纯符号串（长分隔线）天然周期 → **误杀**（2026-09-18 05:24 真实中断了一次正常生成）；
//   · 有意义的句子（11 / 25 字单元）与 8/16/32 对不齐 → **漏报**。
// 修法 = 周期扫描（[2,40] 全试）+ 语义门槛（单元必须含字母/数字/汉字）。
{
  const symbols = [
    ['─'.repeat(80), '长分隔线 ─ ×80'],
    ['-'.repeat(80), 'ASCII 连字符 - ×80'],
    ['='.repeat(80), '等号 = ×80'],
    ['_'.repeat(80), '下划线 _ ×80'],
    ['|---|---|'.repeat(12), 'markdown 表格分隔行 ×12'],
    ['。'.repeat(80), '中文句号 ×80'],
  ];
  for (const [text, label] of symbols) {
    const g = createLoopGuard();
    check(`Q 反例｜${label} 不得触发（纯符号不是空转）`, g.push(text) === null, JSON.stringify(g.push(text)));
  }
}
{
  const zh = '这是一行会被重复的内容'.repeat(10);
  const g1 = createLoopGuard();
  const hit1 = g1.push(zh);
  check(
    'Q 正例｜中文句子 ×10 必须触发（旧实现漏报）',
    hit1 !== null && hit1.kind === 'repeat-inline',
    JSON.stringify(hit1),
  );

  const en = 'this line repeats itself '.repeat(10);
  const g2 = createLoopGuard();
  const hit2 = g2.push(en);
  check(
    'Q 正例｜英文句子 ×10 必须触发（旧实现漏报）',
    hit2 !== null && hit2.kind === 'repeat-inline',
    JSON.stringify(hit2),
  );
}
{
  // 回归：H.1 真实现场走 `short-line-repeat` / `spinning` 通道，不受本次修改影响
  const g = createLoopGuard();
  const pieces = [];
  for (let i = 0; i < 40; i += 1) pieces.push('做。\n', '**（Go.）**\n', '做。\n', '**（执行。）**\n');
  const hit = feed(g, pieces);
  check(
    'Q 回归｜H.1 真实现场（做。交替）仍触发',
    hit !== null && (hit.kind === 'short-line-repeat' || hit.kind === 'spinning'),
    JSON.stringify(hit),
  );
}
{
  // 含语义字符但周期很长（>40）的重复 → 不该由本判据处理（避免把长段落复制当机械复读）
  const g = createLoopGuard();
  const longUnit = '这是一个远远超过四十个字符的重复单元，它描述的事情相当完整而且彼此连贯，不该被当作机械复读处理。';
  check('Q 边界｜超长单元（>inlineMaxPeriod）不触发', g.push(longUnit.repeat(10)) === null);
}

console.log('\n════════ 2c. Q-3：守卫现场落档（append-only，失败不影响守卫）════════');
{
  // 用项目内 work/ 作临时 DSH_HOME（不写 C 盘，符合用户约定）
  const tmpHome = fs.mkdtempSync(path.join(projectRoot, 'work', 'guardlog-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const logMod = await import(pathToFileURL(path.join(path.dirname(target), 'guard-log.js')).href);
    const ok1 = logMod.recordGuardTrip({
      kind: 'repeat-inline',
      reason: '同一片段连续重复 10 次（单元 11 字符）',
      detail: { repeat: 10, unitChars: 11, sample: '这是一行会被重复的内容' },
      tail: '做。做。做。',
      sessionId: 'session-test',
    });
    logMod.recordGuardTrip({ kind: 'repeat-line', reason: '第二条', detail: {}, tail: 'x', sessionId: null });
    const rows = logMod.readGuardTrips();

    check('落档文件写入成功', ok1 === true && fs.existsSync(logMod.guardTripsFile()));
    check('两条记录都在（append-only，不覆盖）', rows.length === 2, `实际 ${rows.length} 条`);
    check(
      '记录含**现场尾部**与判定详情（这是事后复核的关键）',
      rows[0]?.tail === '做。做。做。' && rows[0]?.detail?.unitChars === 11,
      JSON.stringify(rows[0]),
    );
    check('记录带时间戳', typeof rows[0]?.at === 'number', String(rows[0]?.at));
    check('记录可解析为 JSON 行（坏行跳过不整体失败）', rows.every((r) => typeof r === 'object'));
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

console.log('\n════════ 2d. 评审 P1-4：两个 JSONL 的大小轮转（磁盘占用有界）════════');
{
  const tmpHome = fs.mkdtempSync(path.join(projectRoot, 'work', 'jsonl-rot-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const jsonl = await import(pathToFileURL(path.join(path.dirname(target), 'jsonl.js')).href);
    const file = path.join(tmpHome, 'attention-health', 'demo.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 未超阈值 → 不归档
    fs.writeFileSync(file, 'a'.repeat(10), 'utf8');
    check('P1-4：未达阈值 → 不归档', jsonl.rotateIfLarge(file, 50) === false && fs.existsSync(file));

    // 达到阈值 → 归档为 <name>.1.jsonl（原文件让位给新写入）
    fs.writeFileSync(file, 'a'.repeat(100), 'utf8');
    const didRotate = jsonl.rotateIfLarge(file, 50);
    check(
      'P1-4：达到阈值 → 归档为 .1.jsonl，磁盘占用有界',
      didRotate === true && fs.existsSync(jsonl.archivePath(file)) && !fs.existsSync(file),
      jsonl.archivePath(file),
    );

    // 端到端：appendJsonl 自己会创建目录、轮转、追加
    jsonl.appendJsonl(file, { hello: 'world' }, 1024);
    check('P1-4：appendJsonl 追加成功', fs.readFileSync(file, 'utf8').includes('{"hello":"world"}'));
    check('P1-4：默认阈值是 512 KB（评审建议值）', jsonl.DEFAULT_MAX_BYTES === 512 * 1024, String(jsonl.DEFAULT_MAX_BYTES));
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

console.log('\n════════ 2e. Z.5：现场尾部保留量与隐私模式 ════════');
{
  // 为什么默认 500：Q-3 的"误杀要能事后复核"全靠尾部原文（实测至今真实命中 0 次、
  // 该文件为空，隐私面为 0）。为什么还要留一个 0 档：让用户能一键切到
  // "不落原文、只留指纹"，而不必改代码。
  const logMod = await import(pathToFileURL(path.join(path.dirname(target), 'guard-log.js')).href);
  const prevTail = process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
  try {
    check('默认保留 500 字', logMod.DEFAULT_TRIP_TAIL_CHARS === 500, String(logMod.DEFAULT_TRIP_TAIL_CHARS));

    delete process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
    check('未设置环境变量 → 500（维持现状）', logMod.guardTripTailChars() === 500);

    process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = '0';
    check('设为 0 → 隐私模式', logMod.guardTripTailChars() === 0);

    process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = '120';
    check('设为 120 → 生效', logMod.guardTripTailChars() === 120);

    process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = '-1';
    check('非法值 -1 → 回落 500（不静默变 0，0 是"隐私模式"这个语义）', logMod.guardTripTailChars() === 500);
    process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = 'abc';
    check('非法值 abc → 回落 500', logMod.guardTripTailChars() === 500);

    const longText = '甲乙丙丁戊己庚辛壬癸'.repeat(60); // 600 字
    delete process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
    const shaped = logMod.shapeGuardTail(longText);
    check(
      '常规档：只留尾部 500 字（长文本被截断）',
      shaped.tail === longText.slice(-500) && shaped.tail.length === 500,
      `实际 ${shaped.tail?.length} 字`,
    );
    check('常规档：不额外带指纹字段（省体积）', shaped.tailHash === undefined);

    process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = '0';
    const privateShaped = logMod.shapeGuardTail(longText);
    check('隐私档：不落原文', privateShaped.tail === '');
    check('隐私档：保留长度与哈希（能证明是同一段）', privateShaped.tailChars === 600 && typeof privateShaped.tailHash === 'string' && privateShaped.tailHash.length === 16);
    check(
      '隐私档：首尾 40 字特征仍在（足够人工认出是哪次）',
      privateShaped.tailHead === longText.slice(0, 40) && privateShaped.tailFoot === longText.slice(-40),
    );
    check(
      '隐私档：同文本哈希稳定、异文本不同（否则指纹没意义）',
      logMod.shapeGuardTail(longText).tailHash === privateShaped.tailHash &&
        logMod.shapeGuardTail(`${longText}？`).tailHash !== privateShaped.tailHash,
    );

    delete process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
    check('空 tail 安全（不抛错）', typeof logMod.shapeGuardTail(null).tail === 'string');
  } finally {
    if (prevTail === undefined) delete process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
    else process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = prevTail;
  }
}

console.log('\n════════ 3. 边界与健壮性 ════════');
check('enabled=false 时一律不触发', (() => {
  const g = createLoopGuard({ enabled: false });
  return feed(g, Array.from({ length: 50 }, () => '重复的一行内容，足够长以便通过长度门槛\n')) === null;
})());
check('非字符串 / 空片段安全', (() => {
  const g = createLoopGuard();
  return g.push(null) === null && g.push(undefined) === null && g.push('') === null && g.push(123) === null;
})());
check('一次喂入超大片段不崩', (() => {
  const g = createLoopGuard();
  return g.push('x'.repeat(500000)) !== undefined;
})());
check('stats() 可观测（便于回溯误报）', (() => {
  const g = createLoopGuard();
  g.push('第一行内容足够长以便统计\n第二行内容也足够长\n');
  const s = g.stats();
  return typeof s.totalChars === 'number' && typeof s.lineCount === 'number';
})());

console.log('\n════════ 4. 性能：逐 delta 调用必须廉价 ════════');
{
  const g = createLoopGuard();
  const t0 = process.hrtime.bigint();
  // 模拟一次长思考：20000 个 delta，每个 ~40 字符
  for (let i = 0; i < 20000; i += 1) {
    g.push(`这是第 ${i} 个思考片段的正常内容，长度大约四十个字符左右。\n`);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  20000 个 delta（约 80 万字符）耗时 ${ms.toFixed(1)} ms`);
  check('逐 delta 累计代价 < 2 秒（不拖慢生成）', ms < 2000, `${ms.toFixed(1)} ms`);
}

console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
process.exit(fail > 0 ? 1 : 0);
