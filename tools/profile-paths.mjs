/**
 * profile 探测 —— 单一来源（2026-10-01 新增）。
 *
 * 为什么需要它：`DSH_HOME\profiles\<profile>` 里的 **profile 名不是固定的**。
 * 2026-09-20 门 3 时线上是 `web`，脚本与测试就把 `profiles\web` 写死了；
 * 2026-09-30 本机改用 `desktop` profile 之后，这些写死的位置**全部失配**，
 * 于是自测回退到一份**旧的残留副本**（`profiles\node_modules\attention-health-ui`），
 * 报出 3 套失败 —— 那是"测错了对象"，不是代码退化（2026-10-01 实测）。
 *
 * 探测依据是 **profile 自己的 `package.json`**（依赖里声明了本插件），
 * 不是目录名、也不是时间戳：`web` / `desktop` / 以后任何名字都能命中，
 * 且**只有一个 profile 声明依赖时**结果唯一。
 *
 * 环境变量优先级（显式总高于探测）：
 *   `DSH_HOME`      → 不设则 `~/.dsh`
 *   `DSH_PROFILE`   → 指定 profile 名，跳过自动选择
 *   `DSH_ATTENTION_HEALTH_DIR` / `DSH_ATTENTION_HEALTH_UI_DIR` → 直接指定被测目录（最高优先级）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'dsh-attention-health';

/** `$DSH_HOME`（本模块只读，不写）。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `profiles\` 下的 profile 名（排除 `node_modules`、`.plugin-manager` 这类非 profile 目录）。 */
export function listProfiles(home = dshHome()) {
  const dir = path.join(home, 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name);
}

/** profile 的 package.json 是否把本插件声明为依赖（自动探测的判据）。 */
function declaresPlugin(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json'));
  if (!pkg) return false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (pkg[field]?.[PLUGIN_NAME]) return true;
  }
  return false;
}

/**
 * 标准插件包安装位置：`<profile>\node_modules\dsh-attention-health`（门 3 之后的线上形态）。
 * 返回 `{ profile, pkgDir, libDir, version }`；没有则 `null`。
 * 多个 profile 都声明依赖时：`DSH_PROFILE` 指的那个优先，否则取 profile 目录修改时间最新的。
 */
export function findStandardInstall(home = dshHome()) {
  const wanted = process.env.DSH_PROFILE;
  const candidates = [];
  for (const profile of listProfiles(home)) {
    if (wanted && profile !== wanted) continue;
    const profileDir = path.join(home, 'profiles', profile);
    const pkgDir = path.join(profileDir, 'node_modules', PLUGIN_NAME);
    if (!fs.existsSync(path.join(pkgDir, 'lib', 'index.js'))) continue;
    if (!declaresPlugin(profileDir)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(profileDir, 'package.json')).mtimeMs;
    } catch {
      mtime = 0;
    }
    candidates.push({
      profile,
      pkgDir,
      libDir: path.join(pkgDir, 'lib'),
      version: readJson(path.join(pkgDir, 'package.json'))?.version ?? null,
      mtime,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

/**
 * 旧形态部署目录：`<profile>\attention-health\index.js`（回退线，`deploy.ps1 -Force` 用）。
 * 返回 `{ profile, dir }`；没有则 `null`。
 */
export function findLegacyInstall(home = dshHome()) {
  const wanted = process.env.DSH_PROFILE;
  for (const profile of listProfiles(home)) {
    if (wanted && profile !== wanted) continue;
    const dir = path.join(home, 'profiles', profile, 'attention-health');
    if (fs.existsSync(path.join(dir, 'index.js'))) return { profile, dir };
  }
  return null;
}

/** 旧形态的 UI 包位置（早期版本用过 `profiles\node_modules\attention-health-ui`）。 */
export function findLegacyUi(home = dshHome()) {
  const dir = path.join(home, 'profiles', 'node_modules', 'attention-health-ui');
  return isDir(dir) ? dir : null;
}

/**
 * 被测 host 半目录：`DSH_ATTENTION_HEALTH_DIR` → 标准包 `lib\` → 旧形态目录 → `null`（调用方回退源码）。
 */
export function resolveHostDir(home = dshHome()) {
  if (process.env.DSH_ATTENTION_HEALTH_DIR) return process.env.DSH_ATTENTION_HEALTH_DIR;
  const standard = findStandardInstall(home);
  if (standard) return standard.libDir;
  const legacy = findLegacyInstall(home);
  if (legacy) return legacy.dir;
  return null;
}

/**
 * 被测 UI 包目录：`DSH_ATTENTION_HEALTH_UI_DIR` → 标准包根（浏览器半的模块 id 等于包名）→
 * 旧形态 UI 包 → `null`。
 */
export function resolveUiDir(home = dshHome()) {
  if (process.env.DSH_ATTENTION_HEALTH_UI_DIR) return process.env.DSH_ATTENTION_HEALTH_UI_DIR;
  const standard = findStandardInstall(home);
  if (standard) return standard.pkgDir;
  return findLegacyUi(home);
}

/** 给日志用的一句话说明：测的是哪一份（"测的是哪一份"比"全绿"更重要）。 */
export function describeTarget(home = dshHome()) {
  const standard = findStandardInstall(home);
  if (standard) {
    return `标准插件包 · profile=${standard.profile} · 版本 ${standard.version ?? '未知'}（${standard.pkgDir}）`;
  }
  const legacy = findLegacyInstall(home);
  if (legacy) return `旧形态部署目录 · profile=${legacy.profile}（${legacy.dir}）—— 过渡/回退形态`;
  return '未发现任何安装（将回退到源码路径，结果不能代表线上）';
}

// ── CLI：`node tools/profile-paths.mjs [--json]` —— 供 `*.ps1` 复用同一套探测（避免两处漂移）──
const invokedDirectly = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const home = dshHome();
  const standard = findStandardInstall(home);
  const legacy = findLegacyInstall(home);
  const info = {
    dshHome: home,
    profiles: listProfiles(home),
    standard,
    legacy,
    hostDir: resolveHostDir(home),
    uiDir: resolveUiDir(home),
    description: describeTarget(home),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`DSH_HOME   ：${info.dshHome}`);
    console.log(`profile    ：${info.profiles.join(', ') || '（无）'}`);
    console.log(`被测形态   ：${info.description}`);
    console.log(`host 半目录：${info.hostDir ?? '（无）'}`);
    console.log(`UI 包目录  ：${info.uiDir ?? '（无）'}`);
  }
}
