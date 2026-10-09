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
import { resolveHostDir } from '../tools/profile-paths.mjs';

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
// 被测目录：环境变量 → 自动探测到的标准安装（profile 名不写死）→ 本仓库源码（回退）。
const deployedDir = resolveHostDir();
const deployedFile = deployedDir ? path.join(deployedDir, 'guard.js') : projectFile;
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
  // AX.5 档位 3：要 50 次 × 4 字符 = 200 字才越线（旧写法 `'aaaa' ×20` 只有 80 字，已不中止）。
  const hit = feed(g, Array.from({ length: 50 }, () => 'abcd'));
  check('行内片段连续重复（无换行，50 次 / 200 字）→ 命中 repeat-inline', hit !== null && hit.kind === 'repeat-inline', JSON.stringify(hit));
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

// ── AX 节（2026-10-01）：结构重复（命令参数 / 序号 / 数值列）也不得触发 ──────────
// 起因是本机**首条真实守卫记录**（也是唯一一条）：模型正常地写"连按 N 次同一按键清空输入框"
// 的命令，同一个按键码被连续写出十几次 → 行内周期判据把命令参数当成复读，**在流式生成中途
// 中止了那一轮**。审查侧裁决（AX.5 档位 0）：纯数字参数、序号、表格分隔符属于正常结构重复。
// 合成复现（不含任何真实原文）：work/guard-repro-inline-cmd.mjs。
// ⚠️ 这里只用**合成**命令与数值，真实原文不进测试夹具（审查侧 AX.2 的要求）。
{
  const structural = [
    ['& $adb shell "input keyevent ' + '67 '.repeat(20), 'AX 反例｜命令参数：同一按键码 ×20（真实误停形态）'],
    ['1 2 3 '.repeat(20), 'AX 反例｜纯数字序列 ×20'],
    ['| --- '.repeat(20), 'AX 反例｜表格分隔列 ×20'],
  ];
  for (const [text, label] of structural) {
    const g = createLoopGuard();
    const hit = g.push(text);
    check(`${label} 不得触发（结构重复不是思考空转）`, hit === null, JSON.stringify(hit));
  }

  // BG：桌面旧版把 Windows 启动项的十六进制字节列表当成空转。
  // 40 个字节超过新版 16 次 / 160 字门槛；测试必须证明是结构识别在起作用。
  for (const [label, bytes] of [
    ['小写逗号', '0x00,'.repeat(40)],
    ['大写加空格', '0XFF, '.repeat(40)],
    ['无分隔符', '0x00'.repeat(50)],
  ]) {
    const input = '[byte[]](0x03,' + bytes;
    for (const chunk of [0, 1, 5, 64]) {
      const g = createLoopGuard();
      let hit = null;
      if (chunk === 0) hit = g.push(input);
      else for (let i = 0; i < input.length && !hit; i += chunk) hit = g.push(input.slice(i, i + chunk));
      check(`BG 反例｜十六进制字节 ${label}（${chunk ? `每 ${chunk} 字分片` : '整段'}）不得中止`, hit === null, JSON.stringify(hit));
    }
  }

  // 边界（防"放宽过头"）：单元**含字母或汉字**时仍然要抓 —— 门槛只排除"无字母"的单元。
  // ⚠️ AX.5 档位 3 要求**两个条件同时满足**：重复 ≥16 次**且**累计 ≥160 字。
  // 60 次 × 3 字符 = 180 字 → 越线（同时越过 `inlineMinPendingChars`(64) 的检查前置门槛）。
  const mixed = 'x1 '.repeat(60);
  const gm = createLoopGuard();
  const hitMixed = gm.push(mixed);
  check(
    'AX 正例｜字母+数字混合单元 ×60（180 字）仍必须触发（放行只针对无字母单元）',
    hitMixed !== null && hitMixed.kind === 'repeat-inline',
    JSON.stringify(hitMixed),
  );

  // 两条**下限**都要单独钉住 —— 否则"提高门槛"会悄悄变成"关掉判据"：
  const shortEnough = 'x1 '.repeat(16); // 16 次，但只有 48 字 < 160
  const gShort = createLoopGuard();
  const hitShort = gShort.push(shortEnough);
  check(
    'AX 档位 3｜16 次但累计仅 48 字（<160）→ 不得中止',
    hitShort === null,
    JSON.stringify(hitShort),
  );
  const fewButLong = 'abcdefghijkl '.repeat(15); // 累计 195 字 ≥160，但只有 15 次 < 16
  const gFew = createLoopGuard();
  const hitFew = gFew.push(fewButLong);
  check(
    'AX 档位 3｜累计 195 字但只有 15 次（<16）→ 不得中止',
    hitFew === null,
    JSON.stringify(hitFew),
  );
}
// ── AY.2（2026-10-01 审查侧复核）：**流式分片喂入必须与整段喂入同结果** ──────────
// 缺陷形态：探测窗扩到 `inlineMaxPeriod × 16`(640) 字，而流式喂入时未闭合行仍按
// `inlineMaxPeriod × streakLimit`(320) 字裁剪 → 长周期在凑齐 16 次之前被丢掉：
// 同一段内容**整段喂命中、每 5 字分片喂漏检**（DSH 实际就是逐帧喂）。
// 这里覆盖周期上/下界（2 / 21 / 40 字，含恰好在 `inlineMaxPeriod` 边界的 40）与分片粒度 1 / 5 / 64。
{
  // 用互不相同的汉字构造单元（保证最短周期恰好等于 size，且能过"必须含字母或汉字"的门槛）
  const unitOf = (size) => Array.from({ length: size }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
  for (const size of [2, 21, 40]) {
    const unit = unitOf(size);
    const reps = Math.max(16, Math.ceil(160 / size) + 1); // 同时满足 ≥16 次与 ≥160 字
    const text = unit.repeat(reps);

    const whole = createLoopGuard().push(text);
    check(
      `AY.2｜整段喂入命中（单元 ${size} 字 × ${reps} 次）`,
      whole !== null && whole.kind === 'repeat-inline',
      JSON.stringify(whole),
    );

    for (const chunk of [1, 5, 64]) {
      const g = createLoopGuard();
      let hit = null;
      for (let i = 0; i < text.length && !hit; i += chunk) hit = g.push(text.slice(i, i + chunk));
      check(
        `AY.2｜每 ${chunk} 字分片喂入必须同样命中（单元 ${size} 字，逐帧形态）`,
        hit !== null && hit.kind === 'repeat-inline',
        JSON.stringify(hit),
      );
    }
  }

  // 档位 0 不回退：纯数字命令参数**分片**喂入也必须放行（这是误停的原始形态）
  const cmd = '& $adb shell "input keyevent ' + '67 '.repeat(40);
  const gc = createLoopGuard();
  let hitCmd = null;
  for (let i = 0; i < cmd.length && !hitCmd; i += 5) hitCmd = gc.push(cmd.slice(i, i + 5));
  check('AY.2｜纯数字命令参数分片喂入仍须放行（档位 0 不回退）', hitCmd === null, JSON.stringify(hitCmd));
}
// ── AZ.2 / BA.4（2026-10-01 审查侧）：**围栏行结构**保护 + 已知未结案项 ──────────
// 反例形态：正常 JS 字符串字面量里把一个英文词加空格重复 40 次（单元 6 字），按 5 字分片喂入时
// 会在第 27 次命中 repeat-inline。围栏**内**的这类重复属于代码内容 → 豁免；
// 而**没有围栏**的同类内容目前仍会中止 —— BA.2 明确：那是**尚未结案的误停**，不是正确行为，
// 所以下面第 5 条刻意写成"现状（未结案）"，等保守规则落地后必须翻成"不得中止"。
{
  const rep = 'hello '.repeat(40);

  // 1) 标准三反引号围栏内 → 不得中止（分片喂入，含跨分片开闭）
  const fenced = '```js\nconst s = "' + rep + '";\n```\n';
  {
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < fenced.length && !hit; i += 5) hit = g.push(fenced.slice(i, i + 5));
    check('BA.4｜``` 围栏内字符串重复（分片喂入）不得中止', hit === null, JSON.stringify(hit));
  }

  // 2) 四个反引号开启、内部出现三反引号 → 首版实现误判为"已关闭"（BA.3 误关），必须仍豁免
  const fourFence = '````md\n```\n' + rep + '\n````\n';
  {
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < fourFence.length && !hit; i += 5) hit = g.push(fourFence.slice(i, i + 5));
    check('BA.4｜四反引号围栏（内部含三反引号）不得中止（BA.3 误关已修）', hit === null, JSON.stringify(hit));
  }

  // 3) 波浪线围栏（~~~）同样要识别 → 首版完全没识别（BA.3 漏识）
  const tildeFence = '~~~js\nconst s = "' + rep + '";\n~~~\n';
  {
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < tildeFence.length && !hit; i += 5) hit = g.push(tildeFence.slice(i, i + 5));
    check('BA.4｜~~~ 围栏内字符串重复不得中止（BA.3 漏识已修）', hit === null, JSON.stringify(hit));
  }

  // 4) 反面：**正文里提到**"三个反引号"不算开围栏 → 其后的自然语言复读必须照常中止（BA.3 误开）
  const proseMentionsFence =
    '这里用 ' + '```' + ' 表示代码块。\n' + '这是一行会被重复的内容'.repeat(20) + '\n';
  {
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < proseMentionsFence.length && !hit; i += 5) hit = g.push(proseMentionsFence.slice(i, i + 5));
    check(
      'BA.4｜正文提到反引号不得误开围栏（其后自然语言复读仍须中止）',
      hit !== null && hit.kind === 'repeat-inline',
      JSON.stringify(hit),
    );
  }

  // 5) BA.2 **选项 A**（BE 节复核后收紧为"代码字符串区间"）：区间内的重复静默豁免；
  //    区间外（含字符串已闭合、普通英文叙述里出现 return/function 这类词）仍必须中止。
  //    未闭合行与带尾随换行的完整行分别验证，防止分片方式改变判定。
  const repInline = 'hello '.repeat(40);
  {
    // 5a) **未闭合**字符串字面量里的重复 → 豁免（这才是 AZ 的原始反例形态）
    const unclosed = 'const s = "' + repInline;
    const whole = createLoopGuard().push(unclosed);
    check('BA.2-A｜未闭合代码字符串整段喂入（无尾随换行）不得中止', whole === null, JSON.stringify(whole));
    for (const chunk of [1, 5, 64]) {
      const g = createLoopGuard();
      let hit = null;
      for (let i = 0; i < unclosed.length && !hit; i += chunk) hit = g.push(unclosed.slice(i, i + chunk));
      check(`BA.2-A｜未闭合代码字符串每 ${chunk} 字分片喂入不得中止`, hit === null, JSON.stringify(hit));
    }
  }
  {
    // 5b) BE.2 ②：字符串**已闭合**，后面的普通叙述不得继承豁免
    const afterString = 'const s = "ok"; now I am stuck: ' + repInline;
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < afterString.length && !hit; i += 5) hit = g.push(afterString.slice(i, i + 5));
    check(
      'BA.2-A｜代码字符串闭合后的普通叙述复读必须中止（BE.2 ②）',
      hit !== null && hit.kind === 'repeat-inline',
      JSON.stringify(hit),
    );
  }
  {
    // 5c) BE.2 ①：自然语言里的 `return` / `function` **不再是**代码特征
    for (const [label, text] of [
      ['return', 'I will return to this. ' + repInline],
      ['function', 'The function is described here. ' + repInline],
    ]) {
      const g = createLoopGuard();
      let hit = null;
      for (let i = 0; i < text.length && !hit; i += 5) hit = g.push(text.slice(i, i + 5));
      check(
        `BA.2-A｜普通英文叙述里的 "${label}" 不得触发豁免（复读仍须中止）`,
        hit !== null && hit.kind === 'repeat-inline',
        JSON.stringify(hit),
      );
    }
  }
  {
    // 5d) BE.3：赋值出现在第 300 字之后也要能识别（首版缓冲只收本行最初 300 字）。
    // ⚠️ 前缀必须**无周期**，否则它自己就先触发 repeat-inline（首版样本用 `'x'.repeat(400)`
    //    就踩了这个：单元 `xx` 被判成复读，测试失败的原因与赋值识别无关）。
    const prefix = Array.from({ length: 400 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
    const lateAssign = prefix + ' const s = "' + repInline;
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < lateAssign.length && !hit; i += 64) hit = g.push(lateAssign.slice(i, i + 64));
    check('BA.2-A｜赋值起始于第 300 字之后仍须识别（BE.3）', hit === null, JSON.stringify(hit));
  }
  {
    // 5e) 状态清理（BD.2 ④）：代码行之后另起一行的自然语言复读必须中止
    const codeThenProse = 'const s = "' + repInline + '";\n' + '这是一行会被重复的内容'.repeat(20);
    const g = createLoopGuard();
    let hit = null;
    for (let i = 0; i < codeThenProse.length && !hit; i += 5) hit = g.push(codeThenProse.slice(i, i + 5));
    check(
      'BA.2-A｜代码行之后换行的自然语言复读必须中止（状态清理）',
      hit !== null && hit.kind === 'repeat-inline',
      JSON.stringify(hit),
    );
  }
  {
    // BE.2 ③：后出现的代码语法不得追溯性地豁免前面的自然语言复读。
    const lateCode = repInline + ' const s = "later"';
    for (const chunk of [lateCode.length, 1, 5, 64]) {
      const g = createLoopGuard();
      let hit = null;
      for (let i = 0; i < lateCode.length && !hit; i += chunk) hit = g.push(lateCode.slice(i, i + chunk));
      check(`BE.2 ③｜后置代码前的正文复读每 ${chunk} 字分片仍须中止`, hit?.kind === 'repeat-inline', JSON.stringify(hit));
    }
  }
  {
    // BE.3：换行前必须检查行内复读；代码字符串内的重复仍须豁免。
    for (const [label, input, shouldTrip] of [
      ['普通正文', repInline + '\n', true],
      ['未闭合代码字符串', 'const s = "' + repInline + '\n', false],
    ]) {
      for (const chunk of [input.length, 1, 5, 64]) {
        const g = createLoopGuard();
        let hit = null;
        for (let i = 0; i < input.length && !hit; i += chunk) hit = g.push(input.slice(i, i + chunk));
        check(`BE.3｜${label}带尾随换行每 ${chunk} 字分片判定一致`, shouldTrip ? hit?.kind === 'repeat-inline' : hit === null, JSON.stringify(hit));
      }
    }
  }
  {
    // BE.3：&& 不是整行豁免标志，后面的自然语言复读仍按原判据检查。
    const afterCommand = 'echo ready && ' + repInline;
    for (const chunk of [afterCommand.length, 1, 5, 64]) {
      const g = createLoopGuard();
      let hit = null;
      for (let i = 0; i < afterCommand.length && !hit; i += chunk) hit = g.push(afterCommand.slice(i, i + chunk));
      check(`BE.3｜&& 后复读每 ${chunk} 字分片仍须中止`, hit?.kind === 'repeat-inline', JSON.stringify(hit));
    }
  }
}
{
  // Q 正例（防漏报）：够长够多的自然语言行内复读仍必须中止 —— 取 AX.5 档位 3 门槛之上。
  const zh = '这是一行会被重复的内容'.repeat(20); // 11 字 × 20 = 220 字
  const g1 = createLoopGuard();
  const hit1 = g1.push(zh);
  check(
    'Q 正例｜中文句子 ×20（220 字）必须触发（旧实现漏报）',
    hit1 !== null && hit1.kind === 'repeat-inline',
    JSON.stringify(hit1),
  );

  const en = 'this line repeats itself '.repeat(20); // 25 字 × 20 = 500 字
  const g2 = createLoopGuard();
  const hit2 = g2.push(en);
  check(
    'Q 正例｜英文句子 ×20（500 字）必须触发（旧实现漏报）',
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
  // ⚠️ `work/` 是不跟踪目录（git 不保存空目录）——新克隆 / CI 里它不存在，
  //    直接 mkdtemp 会 ENOENT 崩掉整套测试（审查清单 J.6 的"治本修法"）。
  fs.mkdirSync(path.join(projectRoot, 'work'), { recursive: true });
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
  fs.mkdirSync(path.join(projectRoot, 'work'), { recursive: true });
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
  // 为什么默认 500：Q-3 的"误杀要能事后复核"全靠尾部原文（设计初期真实命中长期为 0、
  // 该文件一直为空；2026-10-01 本机已有真实命中，尾部原文成了复核依据）。
  // 为什么还要留一个 0 档：让用户能一键切到"不留尾部原文、只留指纹"，而不必改代码。
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
