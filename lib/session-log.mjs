/**
 * 会话日志的定位与读取。
 *
 * ## 目录布局
 *
 * ```
 * <DSH_HOME>/sessions/
 *   --<encoded-cwd>--/                 # 可读的项目目录名，如 --E-~4E1C~5BD2~4E91~6D6A-Documents--
 *     <encoded-session-id>/
 *       session.jsonl.zstd             # v0
 *       session.v2.jsonl.zstd          # v2
 *       session.v3.jsonl.zstd          # v3（当前代际）
 * ```
 *
 * ## 重要约束
 *
 * - 日志默认是 zstd 压缩，**不能按行直接读**（见 `zstd-frames.mjs`）。
 * - **同一个会话可能有多个代际文件**，必须只读**数值最高的 generation**；
 *   旧代际的词汇表不同（v0 有 `assistant/chunk`、`reasoning-chunks` 等事件，
 *   且字段名是 `seq0`/`time0`）。
 *
 * @module session-log
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decodeSessionLog, parseJsonl } from './zstd-frames.mjs';

/** 解析 DSH_HOME，允许环境变量覆盖。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 会话日志根目录。 */
export function sessionsRoot(home = dshHome()) {
  return path.join(home, 'sessions');
}

/**
 * 从文件名解析代际版本号。`session.jsonl.zstd` → 0；`session.v3.jsonl.zstd` → 3。
 *
 * @param {string} filename
 * @returns {number|undefined} 不是会话日志时返回 undefined
 */
export function parseGeneration(filename) {
  if (filename === 'session.jsonl.zstd' || filename === 'session.jsonl') return 0;
  const m = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(filename);
  return m ? Number(m[1]) : undefined;
}

/**
 * 在一个会话目录中选出数值最高的代际文件。
 *
 * @param {string} dir - 单个会话目录
 * @returns {{file: string, generation: number, size: number}|undefined}
 */
export function pickGeneration(dir) {
  let best;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const generation = parseGeneration(entry.name);
    if (generation === undefined) continue;
    const file = path.join(dir, entry.name);
    const size = fs.statSync(file).size;
    if (!best || generation > best.generation) best = { file, generation, size };
  }
  return best;
}

/**
 * 列出全部会话。
 *
 * @param {object} [options]
 * @param {string} [options.root] - 覆盖 sessions 根目录
 * @param {string} [options.sessionId] - 只返回该会话
 * @returns {Array<{id: string, dir: string, project: string, generation: number, file: string, size: number, mtimeMs: number}>}
 */
export function listSessions({ root = sessionsRoot(), sessionId } = {}) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let sessions;
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      if (sessionId && session.name !== sessionId) continue;
      const dir = path.join(projectDir, session.name);
      const picked = pickGeneration(dir);
      if (!picked) continue;
      out.push({
        id: session.name,
        dir,
        project: project.name,
        generation: picked.generation,
        file: picked.file,
        size: picked.size,
        mtimeMs: fs.statSync(picked.file).mtimeMs,
      });
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 读取一个会话：解压、解析，并拆出 header 与事件。
 *
 * @param {string} dir - 会话目录（或直接指向日志文件）
 * @returns {{header: object, events: object[], file: string, generation: number,
 *            frameCount: number, failedFrames: number, parseErrors: number, bytes: number}}
 */
export function readSession(dir) {
  const target = fs.statSync(dir).isDirectory()
    ? pickGeneration(dir)
    : { file: dir, generation: parseGeneration(path.basename(dir)) ?? -1 };
  if (!target) throw new Error(`no session log found in ${dir}`);

  const buffer = fs.readFileSync(target.file);
  const { plaintext, frameCount, failedFrames, bytes } = decodeSessionLog(buffer);
  const { records, parseErrors } = parseJsonl(plaintext);

  let header;
  const events = [];
  for (const record of records) {
    if (!header && record.type === 'session') {
      header = record;
      continue;
    }
    events.push(record);
  }

  return {
    header: header ?? {},
    events,
    file: target.file,
    generation: target.generation,
    frameCount,
    failedFrames,
    parseErrors,
    bytes,
  };
}

/** 把事件的时间戳格式化为本地时间字符串。 */
export function formatTime(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 取事件的 seq（兼容 v0 旧代际的 seq0）。 */
export function eventSeq(event) {
  return event.seq ?? event.seq0;
}

/** 取事件的时间（兼容 v0 旧代际的 time0）。 */
export function eventTime(event) {
  return event.time ?? event.time0;
}
