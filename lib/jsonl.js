/**
 * JSONL 追加写入 + **大小轮转**（2026-09-18 第三方评审 P1-4）。
 *
 * ## 为什么需要它
 *
 * 两个落档文件（`handoff-history.jsonl` / `guard-trips.jsonl`）此前**无限追加**、
 * 从无清理。它们的用途是"攒样本做阈值回溯"，但没人希望它长到几十 MB ——
 * 而且这两个文件都在 `$DSH_HOME` 下，常被同步盘/备份带走。
 *
 * ## 规则
 *
 * 写入前检查大小；达到 `maxBytes`（默认 512 KB）就把当前文件**整体归档**为
 * `<name>.1.jsonl`（覆盖上一份归档），然后新建空文件继续写。
 * 于是磁盘占用恒定 `< 2 × maxBytes`，且**最近的样本永远在活动文件里**。
 *
 * ## 边界
 *
 * 失败一律吞掉（返回 `false`）—— 落档是观测手段，不该影响主流程
 * （与 `recordHandoff` / `recordGuardTrip` 的既有约定一致）。
 *
 * @module jsonl
 */

import fs from 'node:fs';
import path from 'node:path';

/** 默认轮转阈值：512 KB（评审建议值）。 */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/** 归档文件名：`foo.jsonl` → `foo.1.jsonl`（同目录，便于一起备份/清理）。 */
export function archivePath(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  return path.join(dir, `${base}.1.jsonl`);
}

/**
 * 超过阈值就把现有文件归档（只保留最近一份），保证**有界磁盘占用**。
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {boolean} 是否发生了归档
 */
export function rotateIfLarge(file, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return false;
    fs.renameSync(file, archivePath(file)); // 覆盖上一份归档（只留一份历史）
    return true;
  } catch {
    return false; // 文件不存在 / 权限问题 → 交给后续 append 处理
  }
}

/**
 * 追加一行 JSON（含轮转与目录创建）。
 *
 * @param {string} file
 * @param {object} entry
 * @param {number} [maxBytes]
 * @returns {boolean} 是否写入成功
 */
export function appendJsonl(file, entry, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file, maxBytes);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
