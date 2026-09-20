/**
 * 交接历史的**本地留痕**（2026-09-15 复核 N-6 建议 1：可回溯校准）。
 *
 * ## 为什么需要它
 *
 * 复核的核心批评：插件的阈值（30/50/65/70/80/90、扣分力度、压缩封顶、有效窗口 0.5 系数）
 * 全是**内部校准**出来的 —— 校准目标是"分数与等级自洽"，而不是"预测准确"。
 * 因此复核指出："真正需要注意的是别把评分当成测量结果。"
 *
 * 这一层用**零 token、纯本地**的方式把每次交接的现场记下来：
 *
 * ```
 * 时间 / 会话 / 评分 / 等级 / 有效占用 / 压缩次数 / 退化信号 / 文档字符数
 * ```
 *
 * 攒够样本后就能回答复核提的那个问题 ——
 * "评分 55 分时交接，新会话实际能撑多久？" —— 用真实数据反推阈值，
 * 把"校准"升级成"验证"。
 *
 * ## 边界
 *
 * - 写入位置：`<DSH_HOME>/attention-health/handoff-history.jsonl`，每行一个 JSON 对象。
 * - **只追加**，不修改、不上传、不联网。
 * - 记录失败绝不影响交接文档生成（`recordHandoff` 内部吞掉异常，返回 boolean）。
 *
 * @module history
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 追加写入 + 大小轮转（2026-09-18 第三方评审 P1-4）：这个文件此前**无限追加**。
import { appendJsonl } from './jsonl.js';

/** 历史文件的绝对路径（`DSH_HOME` 可覆盖，与插件其它落点一致）。 */
export function historyFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'attention-health', 'handoff-history.jsonl');
}

/**
 * 追加一条交接记录。
 *
 * @param {object} entry - 由调用方构造（评分 / 占用 / 压缩次数 / 文档规模等）
 * @returns {boolean} 是否写入成功（失败不抛错，避免影响交接本身）
 */
export function recordHandoff(entry) {
  // 写入走共享的 `appendJsonl`（含 512 KB 轮转）：磁盘占用恒定有界，
  // 最近样本永远在活动文件里；失败仍然只吞掉、不抛。
  return appendJsonl(historyFile(), entry);
}

/** 读取全部记录（坏行跳过，文件不存在返回空数组）。 */
export function readHistory() {
  let raw;
  try {
    raw = fs.readFileSync(historyFile(), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* 坏行跳过：历史文件是尽力而为的观测数据，不该让汇总整体失败 */
    }
  }
  return rows;
}

/** 格式化百分比。 */
const pct = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '未知');

/**
 * 汇总历史记录为可读报告（CLI `--calibration` 用）。
 *
 * @param {Array} [rows] - 记录数组；默认从磁盘读
 * @returns {string[]} 逐行文本
 */
export function summarizeHistory(rows = readHistory()) {
  const out = [];
  out.push(`交接历史记录：${rows.length} 次`);
  if (!rows.length) {
    out.push('（还没有记录。生成一次交接文档即可留下第一条 —— 记录零 token、纯本地。）');
    out.push(`文件：${historyFile()}`);
    return out;
  }

  const times = rows.map((r) => r.at).filter((t) => typeof t === 'number' && t > 0);
  if (times.length) {
    out.push(
      `时间范围：${new Date(Math.min(...times)).toLocaleString()} → ${new Date(Math.max(...times)).toLocaleString()}`,
    );
  }

  const band = (score) => (score >= 80 ? '80-100 正常' : score >= 60 ? '60-79 留意' : score >= 40 ? '40-59 偏大' : '0-39 过大');
  const counts = new Map();
  for (const r of rows) {
    if (typeof r.score !== 'number') continue;
    const k = band(r.score);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  out.push('');
  out.push('交接时的评分分布：');
  for (const k of ['80-100 正常', '60-79 留意', '40-59 偏大', '0-39 过大']) {
    if (counts.has(k)) out.push(`  ${k.padEnd(12)} ${counts.get(k)} 次`);
  }

  const effs = rows.map((r) => r.effectivePercent).filter((v) => typeof v === 'number');
  if (effs.length) {
    effs.sort((a, b) => a - b);
    const q = (p) => effs[Math.min(effs.length - 1, Math.floor(effs.length * p))];
    out.push('');
    out.push(`交接时有效占用：中位 ${pct(q(0.5))} / 最低 ${pct(effs[0])} / 最高 ${pct(effs.at(-1))}`);
  }

  const think = rows.filter((r) => (r.reasoningLoop ?? 0) + (r.reasoningFlags ?? 0) > 0).length;
  const lossy = rows.filter((r) => (r.summaryCount ?? 0) > 0).length;
  out.push('');
  out.push(`带思考异常的历史交接：${think} 次；带着有损压缩的：${lossy} 次`);

  out.push('');
  out.push(`最近 ${Math.min(10, rows.length)} 次：`);
  for (const r of rows.slice(-10)) {
    const when = typeof r.at === 'number' ? new Date(r.at).toLocaleString() : '时间未知';
    out.push(
      `  ${when}　评分 ${r.score ?? '?'}　有效占用 ${pct(r.effectivePercent)}` +
        `　压缩 ${r.summaryCount ?? 0} 次　思考异常 ${(r.reasoningLoop ?? 0) + (r.reasoningFlags ?? 0)} 次` +
        `　${r.profile ?? '?'} 档　${r.chars ?? '?'} 字符`,
    );
  }
  out.push('');
  out.push(`文件：${historyFile()}`);
  return out;
}
