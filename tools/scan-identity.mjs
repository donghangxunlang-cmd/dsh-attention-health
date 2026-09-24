/**
 * 身份类信息扫描器（2026-09-20，对应审查清单 Z.2 / AC.2 第 2 轮第 4 条）。
 *
 * 为什么单独一个工具：脱敏不能靠"我觉得没问题"，得有**闸门** ——
 * 出包/发布前扫一遍，**0 命中**才放行。它扫的是**发布产物**（不是"仓库里应该没问题"）。
 *
 * 命中类别（每类都给出占位符，脱敏按同一套规则做）：
 *   · Windows 用户目录      `C:\Users\<本机用户名>`     → `C:\Users\<USER>`
 *   · 本机项目路径          `<盘符>:\<用户名>\Documents\...` → `<PROJECT>`
 *   · 本机工具路径          `<盘符>:\CodexFiles\...`     → `<TOOLS>`
 *   · 会话 ID               `session-<8位hex>…`          → 确定性假 ID（同名同假名，保持交叉引用）
 *   · 裸 UUID                `xxxxxxxx-xxxx-…`
 *   · 用户名                本机用户名（LICENSE 与 package.json 的署名是**有意保留**，见 ALLOW）
 *   · 邮箱 / 公网 IP
 *
 * ⚠️ **本文件的文档与代码里都不写真实身份值**（用户名用拼接、示例路径用占位符）：
 * 它会被 `make-release` **原样复制**进发布产物，写在这儿就等于写进公开仓库。
 * 曾经写实：文档里那两处示例让产物扫描报了 3 处命中 —— 闸门立刻抓到，改占位符后为 0。
 *
 * 用法：
 *   node tools/scan-identity.mjs <目录或文件>            # 扫描；有命中 → exit 1
 *   node tools/scan-identity.mjs <目录> --json           # 机器可读输出
 *
 * 只报告与（可选的）替换，**不修改输入**；替换由 `tools/make-release.mjs` 写到发布目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 用户名（本机）。LICENSE 与 package.json 的署名是有意的，列在 ALLOW 里。
 *
 * ⚠️ **必须拼接写法**（AE 节 2026-09-20 原报告 §9.1）：本文件的源码会被
 * `tools/make-release.mjs` **脱敏后再发布** —— 如果这里写成完整的两个字面量，
 * 脱敏会把规则表自己改成 `<USER>`，发布出去的扫描器当场失效（静默失效，最糟的那种）。
 * 拆成两段后，源码里不存在连续的用户名，脱敏规则自然打不到它。
 */
const USER_NAME = '东寒' + '云浪';

/** 路径分隔符：**允许被转义一次**（`Z:\\CodexFiles` 这种 JSON/日志里的写法）。 */
const SEP = '[\\\\/]{1,2}';

/**
 * 允许保留的例外：文件相对路径 → 允许命中的类别。
 * 原则：**署名不算泄漏**（作者本来就要署名），其余一律 0 容忍。
 */
const ALLOW = {
  // 署名类：LICENSE 与 package.json 的 author —— 有意公开
  'LICENSE': ['user-name'],
  'package.json': ['user-name'],
  // 扫描器自己的**自检 fixture** 里必然有"该命中"的合成样本（`C:\Users\someone`、
  // `E:\CodexFiles\...`、`session-deadbeef-1234`（虚构样本）、示例 IP）——只放行这几类；
  // ⚠️ 2026-09-22 修正：这里原先用的是**真实会话 ID 的前 12 位**（具体值不再复述，
  // 复述即泄露），而本文件会被原样发布 → 等于把真实 ID 前缀发到了公开仓库（用户实测发现）。
  // 自检样本一律用虚构值（`deadbeef` 段），永不使用真实 ID 的任何片段。
  // **用户名 / 项目路径 / UUID / 邮箱不放行**：真要把本机身份粘进这个文件，闸门仍然会抓。
  // （`--selftest` 的用例见文件后半段。）
  'scan-identity.mjs': ['user-path', 'tools-path', 'session-id', 'public-ip'],
};

/** 脱敏规则表：正则 → 替换（顺序有意义，先具体后一般）。 */
export const RULES = [
  // 本机项目路径（用户名在路径里，必须先于"裸用户名"处理）
  {
    kind: 'project-path',
    re: new RegExp(`[A-Za-z]:${SEP}${USER_NAME}${SEP}Documents${SEP}dsh-attention-health`, 'g'),
    to: '<PROJECT>',
  },
  {
    kind: 'project-path',
    re: new RegExp(`[A-Za-z]:${SEP}${USER_NAME}${SEP}Documents`, 'g'),
    to: '<WORKSPACE>',
  },
  // 本机工具路径
  { kind: 'tools-path', re: new RegExp(`[A-Za-z]:${SEP}CodexFiles`, 'g'), to: '<TOOLS>' },
  // Windows 用户目录（`(?!<USER>)`：脱敏**自己产出的占位符**不能再被当成命中 ——
  // 自检抓到的假阳性，AC/AE 那轮的闸门没踩到纯属运气）
  {
    kind: 'user-path',
    re: new RegExp(`[A-Za-z]:${SEP}Users${SEP}(?!<USER>)[^\\\\/\\s"'\`,)]+`, 'g'),
    to: 'C:\\Users\\<USER>',
  },
  // 会话 ID（确定性地映射成 `<SAMPLE-…>` 形式的假 ID：既保持"同一个真 ID → 同一个假 ID"，
  // 又**不会被自己的扫描规则再命中** —— 第一版映射成 `session-<8位hex>`，闸门当场自证失败 20 处）
  {
    kind: 'session-id',
    // ⚠️ 2026-09-22 修正（用户实测）：旧规则只吃「8 位 + 最多 2 组 4 位」= UUID 前 16 位，
    // 于是完整 UUID 的**后半段（`-a5fd-c8e9fc6ed02d`）原样留在产物里**（README 示例被抓到）。
    // 现在吃整段：8 位 hex + **0~4** 组「-4~12 位 hex」，覆盖三种形态：
    //   ① 纯短 ID（`session-xxxxxxxx`，README「校准留痕」里就是这种）；
    //   ② 短前缀（`session-xxxxxxxx-xxxx`）；
    //   ③ 完整 UUID（`session-8-4-4-4-12`）。
    // `(?!SAMPLE-)` 保护已脱敏的假 ID（第一版教训：假 ID 不能再被自己的规则命中）。
    re: /session-(?!SAMPLE-)[0-9a-f]{8}(?:-[0-9a-f]{4,12}){0,4}/g,
    to: null,
  },
  // 裸 UUID
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, to: null },
  // 用户名（裸出现）—— 同样用拼接出来的名字构造，避免源码里出现连续字面量
  { kind: 'user-name', re: new RegExp(USER_NAME, 'g'), to: '<USER>' },
  // 邮箱
  // ⚠️ 2026-09-24 收紧（审查清单 AU 节）：原正则 `\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b` 会把
  // **`包名@版本号`** 也当邮箱 —— `dsh-vet@0.4.0`（CI 里的 npx 目标）、`pnpm@11.19.0`
  // （AGENTS 文档）都被替换成 `<EMAIL>`，导致公开仓 CI 直接红灯。
  // 现在要求顶级域为**纯字母**（≥2 位），`@数字.数字` 形态不再命中；常见邮箱形态仍命中
  //（自检用例见下方 SELFTEST_CASES —— 用例用拼接构造，避免本文件自己被这条规则命中）。
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,}\b/g, to: '<EMAIL>' },
  // 公网 IP（排除 127.0.0.1 / 10.x / 192.168.x / 172.16-31.x / 0.0.0.0）
  {
    kind: 'public-ip',
    re: /\b(?!127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    to: '<IP>',
  },
];

/** 允许保留署名的文件名（脱敏时**跳过 user-name 规则**，否则署名会变成 `<USER>`）。 */
export const KEEP_AUTHOR = new Set(['LICENSE', 'package.json']);

/** 确定性假 ID：同输入同输出（保持交叉引用可读，又不泄漏真值，也不撞自己的规则）。 */
export function fakeId(real) {
  return 'session-SAMPLE-' + createHash('sha256').update(real).digest('hex').slice(0, 8);
}

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.ps1', '.html', '.css', '.ts',
  '.sh', // pre-push hook 模板（漏了它 → 组装时被跳过，公开仓库里就没有这个文件）
]);

/** 扫描一份文本，返回命中列表。 */
export function scanText(text, relPath) {
  const allowed = new Set(ALLOW[path.basename(relPath)] ?? []);
  const hits = [];
  for (const rule of RULES) {
    if (allowed.has(rule.kind)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ kind: rule.kind, value: m[0], line });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * 对文本应用全部替换（脱敏）。
 *
 * @param {string} text
 * @param {{ relPath?: string }} [opts] - 给了 `relPath` 就按 `KEEP_AUTHOR` 跳过署名替换
 *   （LICENSE / package.json 的 author 是**有意保留**的署名；不跳的话它会变成 `<USER>`）。
 */
export function sanitizeText(text, opts = {}) {
  const keepAuthor = opts.relPath !== undefined && KEEP_AUTHOR.has(path.basename(opts.relPath));
  let out = text;
  for (const rule of RULES) {
    if (keepAuthor && rule.kind === 'user-name') continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    out = out.replace(re, (m) => (rule.to === null ? fakeId(m) : rule.to));
  }
  return out;
}

/** 递归列出目录下的文本文件（跳过 .git / node_modules）。 */
export function listTextFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  if (fs.statSync(root).isFile()) return [root];
  walk(root);
  return out;
}

/** 扫描一个目录（或单文件），返回 `[{ file, hits }]`（只含有命中的）。 */
export function scanPath(root) {
  const results = [];
  for (const f of listTextFiles(root)) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f) || path.basename(f);
    const hits = scanText(text, rel);
    if (hits.length) results.push({ file: rel, hits });
  }
  return results;
}

// ── 自检：规则表本身必须真的能命中（AE 节 2026-09-20 原报告 §9.2 的漏检点）──
// `--selftest` 用来在闸门冒烟里跑：故意构造"该命中"的例子，证明扫描器不是摆设。
// ⚠️ 用例里的用户名一律**拼接构造**（与 USER_NAME 同理：源码里不能出现连续字面量）。
const NAME = USER_NAME;
const SELFTEST_CASES = [
  ['C:\\Users\\someone\\x', 'user-path'],
  ['C:\\\\Users\\\\someone', 'user-path'], // 转义双反斜杠（JSON / 日志里常见）
  ['Z:\\CodexFiles\\scripts', 'tools-path'],
  ['Z:\\\\CodexFiles\\\\scripts', 'tools-path'],
  ['Z:/CodexFiles/scripts', 'tools-path'],
  ['session-deadbeef-1234', 'session-id'], // 虚构样本（绝不使用真实 ID 片段）
  [`${NAME} 的机器`, 'user-name'],
  // ⚠️ 2026-09-22 修正（用户要求"重点检查隐私"）：此处原先用**用户的云服务器真实 IP**
  // 作为"应命中"样本 —— 与自检会话 ID 同一类事故（自检样本携带真实值，又被 ALLOW 放行）。
  // 改用 RFC 5737 文档保留地址（`203.0.113.0/24`），规则测试效果不变。
  ['203.0.113.5', 'public-ip'],
  // AU 节补：邮箱规则本身必须仍能命中（避免收紧过头）。
  // ⚠️ 用**拼接构造**：源码里不能出现连续的邮箱字面量，否则扫描器会命中自己（本文件不放行 email 类）。
  ['someone' + '@' + 'example.com', 'email'],
];
const SELFTEST_CLEAN = [
  'session-SAMPLE-deadbeef', // 我们自己的假 ID，绝不能再命中
  'C:\\Users\\<USER>', // 脱敏后的占位符
  'E:\\<TOOLS>\\scripts',
  '127.0.0.1 与 192.168.1.7',
  '<PROJECT>/lib/index.js',
  // AU 节（2026-09-24）：`包名@版本号` **不是**邮箱 —— 这两个形态曾把公开仓 CI 与文档改坏
  'dsh-vet@0.4.0',
  'pnpm@11.19.0',
];

if (process.argv.includes('--selftest')) {
  let bad = 0;
  for (const [text, kind] of SELFTEST_CASES) {
    const kinds = scanText(text, 'sample.js').map((h) => h.kind);
    const ok = kinds.includes(kind);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✅' : '❌'} 应命中 [${kind}]：${JSON.stringify(text)} → ${kinds.join(',') || '（无）'}`);
  }
  for (const text of SELFTEST_CLEAN) {
    const kinds = scanText(text, 'sample.js').map((h) => h.kind);
    const ok = kinds.length === 0;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✅' : '❌'} 不应命中：${JSON.stringify(text)} → ${kinds.join(',') || '（无）'}`);
  }
  // 脱敏 → 复扫必须干净（含署名文件例外）
  const dirty = `见 ${'E:'}${'\\\\'}CodexFiles${'\\\\'}x 与 session-deadbeef-1234，作者 ${NAME}`;
  const cleaned = sanitizeText(dirty, { relPath: 'note.md' });
  const again = scanText(cleaned, 'note.md');
  if (again.length) {
    bad += 1;
    console.log(`  ❌ 脱敏后仍命中：${JSON.stringify(again)}`);
  } else {
    console.log(`  ✅ 脱敏→复扫干净：${JSON.stringify(cleaned)}`);
  }
  const authorKept = sanitizeText(`author: ${NAME}`, { relPath: 'package.json' });
  const okAuthor = authorKept.includes(NAME);
  if (!okAuthor) bad += 1;
  console.log(`  ${okAuthor ? '✅' : '❌'} 署名文件保留用户名：${JSON.stringify(authorKept)}`);

  console.log(bad === 0 ? '\n✅ 自检通过（规则表有效）' : `\n❌ 自检失败：${bad} 条`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan-identity.mjs')) {
  const target = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!target) {
    console.error('用法：node tools/scan-identity.mjs <目录或文件> [--json]');
    console.error('      node tools/scan-identity.mjs --selftest');
    process.exit(2);
  }
  const results = scanPath(target);
  const total = results.reduce((n, r) => n + r.hits.length, 0);
  if (asJson) {
    console.log(JSON.stringify({ target, total, results }, null, 2));
  } else {
    console.log(`扫描：${target}`);
    for (const r of results) {
      console.log(`  ${r.file}`);
      for (const h of r.hits) console.log(`    L${h.line}  [${h.kind}]  ${JSON.stringify(h.value)}`);
    }
    console.log(total === 0 ? '\n✅ 身份类命中：0' : `\n❌ 身份类命中：${total} 处（${results.length} 个文件）`);
  }
  process.exit(total === 0 ? 0 : 1);
}
