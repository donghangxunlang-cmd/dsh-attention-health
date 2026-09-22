/**
 * 发布产物组装 + 脱敏 + 闸门（2026-09-20，审查清单 Z.2 / AC.2 第 2 轮第 4 条）。
 *
 * 三件事，一次做完：
 *   1. **组装**：只挑"该公开的"文件（源码 / README / LICENSE / 测试 / 工具 / 常驻约定）；
 *   2. **脱敏**：按 `tools/scan-identity.mjs` 的同一套规则替换身份类信息；
 *   3. **闸门**：对**产物**再扫一遍，**0 命中才算通过**（不是"仓库里应该没问题"）。
 *
 * 为什么不在仓库里就地脱敏：仓库是**开发档案**（`DEPLOYMENT-NOTES` 里的真实会话 ID
 * 是证据链的一部分，删了就回溯不了）。发布的是一份**派生产物**，两者分开才既保真又干净。
 *
 * 用法：
 *   node tools/make-release.mjs [输出目录]
 *   默认输出：<TOOLS>\DSH\留档\attention-health-release-<日期>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPath, sanitizeText, listTextFiles } from './scan-identity.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 该公开的（相对仓库根）。刻意**不含**：DEPLOYMENT-NOTES / HANDOFF.md / work/。
 *  `*.ps1` 只带**通用**的两个（打包安装、跑自测）；`deploy.ps1` / `restart-attention-health.ps1`
 *  是本机开发工具（内含本机 DSH 安装布局），不公开 —— README 里已写明这一点。 */
const PUBLISH = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'AGENTS.md',
  '.gitattributes',
  'handoff.mjs',
  'install-package.ps1',
  'test-all.ps1',
  'lib/',
  'test/',
  'tools/',
];
/** 不该出现在发布产物里的（防御性检查：万一 PUBLISH 写错也不至于悄悄泄漏）。 */
const FORBIDDEN = ['DEPLOYMENT-NOTES', 'HANDOFF.md', 'work/', '.git/', 'attention-health-pkg'];

/**
 * **原样复制**（不做脱敏）的文件。
 *
 * 只有扫描器自己：它的 `--selftest` fixture 里必然写着"该命中"的**合成样本**
 * （`C:\Users\<USER>`、`<TOOLS>\...`、`session-SAMPLE-213dfec6`、示例 IP）——
 * 一旦被脱敏，发布出去的自检就自己打自己脸（实测：5 条失败）。
 * 它本身不含任何真实身份，且扫描器对它的放行只限这几类（用户名 / 项目路径 / UUID / 邮箱仍会抓）。
 */
const NO_SANITIZE = new Set(['tools/scan-identity.mjs']);

const outDir =
  process.argv[2] ??
  path.join('<TOOLS>\\DSH\\留档', `attention-health-release-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);

// ── 1) 组装 + 脱敏 ──
const copied = [];
for (const entry of PUBLISH) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) {
    console.log(`  ⚠️ 跳过（不存在）：${entry}`);
    continue;
  }
  const files = fs.statSync(src).isDirectory() ? listTextFiles(src) : [src];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const raw = fs.readFileSync(f, 'utf8');
    // 传 relPath：署名文件（LICENSE / package.json）跳过 user-name 替换 —— 署名是有意的
    const text = NO_SANITIZE.has(rel.split(path.sep).join('/'))
      ? raw
      : sanitizeText(raw, { relPath: rel });
    fs.writeFileSync(dst, text, 'utf8');
    copied.push(rel);
  }
}
console.log(`组装：${copied.length} 个文件 → ${outDir}`);

// ── 2) 防御性检查：不该出现的东西一个都不能有 ──
const leaked = copied.filter((rel) => FORBIDDEN.some((bad) => rel.includes(bad)));
if (leaked.length) {
  console.error('❌ 发布产物里出现了本不该公开的文件：');
  for (const l of leaked) console.error(`   - ${l}`);
  process.exit(1);
}

// ── 3) 闸门：对**产物**扫描，0 命中才放行 ──
const results = scanPath(outDir);
const total = results.reduce((n, r) => n + r.hits.length, 0);
if (total > 0) {
  console.error(`❌ 脱敏后仍有身份类命中：${total} 处（${results.length} 个文件）`);
  for (const r of results) {
    console.error(`   ${r.file}`);
    for (const h of r.hits.slice(0, 5)) console.error(`     L${h.line} [${h.kind}] ${JSON.stringify(h.value)}`);
  }
  process.exit(1);
}
console.log(`✅ 闸门通过：发布产物身份类命中 0（共扫 ${listTextFiles(outDir).length} 个文件）`);
console.log('   下一步：把该目录作为公开仓库内容（或直接用它核对 GitHub 推送内容）。');
