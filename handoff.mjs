#!/usr/bin/env node
/**
 * 离线交接文档生成器。
 *
 * 从 DSH 会话日志（`$DSH_HOME/sessions/<项目>/<会话>/session*.jsonl.zstd`）**机械提炼**一份
 * 结构化交接文档，**不调用任何模型**。
 *
 * ## 用法
 *
 * ```bash
 * node handoff.mjs                      # 对「当前工作目录的最新会话」生成，打印到 stdout
 * node handoff.mjs --list               # 列出最近会话
 * node handoff.mjs <id-or-prefix>       # 指定会话（支持前缀匹配）
 * node handoff.mjs -o out.md            # 写入文件
 * node handoff.mjs --current -o out.md  # 显式指定当前工作目录的会话
 * node handoff.mjs --stats              # 额外打印解析统计
 * node handoff.mjs --health             # 只做健康自检（评分 / 退化信号），不生成文档
 * node handoff.mjs --calibration        # 汇总历史交接记录（阈值回溯素材，零 token）
 * node handoff.mjs --max-turns 20       # 限制输出规模
 * ```
 *
 * @module handoff-cli
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { listSessions, readSession, dshHome, sessionsRoot } from './lib/session-log.mjs';
import { scanZstdFrames } from './lib/zstd-frames.mjs';
// 2026-09-15 全量复核 N-1：**渲染层不再自持一份实现**。
//
// 离线 CLI 原先走 `lib/extract.mjs` 的 `extractHandoff/renderHandoff`，而插件走
// `lib/handoff.js` 的 `buildHandoff` —— 第二批修的 12 项只落到了插件里，于是
// **同一会话会产出两种质量的文档**（表格可能错位、附录 B 无上限、"最新目标"可能仍是"继续"）。
// 现有测试只对齐了折叠指标，没对齐渲染输出，所以一直没拦住。
//
// `lib/handoff.js`（barrel）及其 6 个兄弟模块是**自包含 ESM**：只彼此 import、
// 无第三方依赖、不读环境变量，CLI 可以直接复用 ——
// 从此"一处修改、两处生效"，漂移在结构上不可能再发生。
import {
  COMPACT_DEFAULTS,
  LEVEL_LABEL,
  buildHandoff,
  foldSession,
  scoreContextHealth,
} from './lib/handoff.js';
// 交接历史留痕（2026-09-15 复核 N-6 建议 1）：纯本地、零 token 的阈值回溯素材。
import { historyFile, recordHandoff, summarizeHistory } from './lib/history.js';

/** 只解压第一帧（header），用于快速读取会话的 cwd，避免解压整个日志。 */
function readHeaderOnly(file) {
  try {
    const buffer = fs.readFileSync(file);
    const { frames } = scanZstdFrames(buffer, 1);
    if (!frames.length) return undefined;
    const text = zlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8');
    const firstLine = text.split('\n').find((l) => l.trim());
    return firstLine ? JSON.parse(firstLine) : undefined;
  } catch {
    return undefined;
  }
}

/** 极简参数解析。 */
function parseArgs(argv) {
  const opts = { list: false, current: false, stats: false, healthOnly: false, calibration: false, out: undefined, target: undefined };
  const limits = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--current') opts.current = true;
    else if (a === '--stats') opts.stats = true;
    else if (a === '--health') opts.healthOnly = true;
    else if (a === '--calibration') opts.calibration = true;
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--max-turns') limits.maxTurns = Number(argv[++i]);
    else if (a === '--max-requests') limits.maxRequests = Number(argv[++i]);
    else if (a === '--max-files') limits.maxFiles = Number(argv[++i]);
    else if (a === '--home') opts.home = argv[++i];
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}`);
    else if (!opts.target) opts.target = a;
    else throw new Error(`多余的参数：${a}`);
  }
  return { opts, limits };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function main() {
  const { opts, limits } = parseArgs(process.argv.slice(2));
  const root = sessionsRoot(opts.home ?? dshHome());
  const sessions = listSessions({ root });

  // ---- 校准模式：汇总历史交接记录（N-6 建议 1，不需要会话）----
  if (opts.calibration) {
    for (const line of summarizeHistory()) console.log(line);
    return;
  }

  if (!sessions.length) {
    console.error(`未在 ${root} 找到任何会话日志。`);
    process.exit(1);
  }

  // ---- 列表模式 ----
  if (opts.list) {
    console.log(`会话根目录：${root}`);
    console.log(`共 ${sessions.length} 个会话（按最近活动排序，显示前 20 个）\n`);
    console.log('  最近活动            代际   大小     工作目录 / ID');
    for (const s of sessions.slice(0, 20)) {
      const header = readHeaderOnly(s.file);
      const when = new Date(s.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
      const cwd = header?.cwd ?? '?';
      console.log(`  ${when}  v${String(s.generation).padEnd(4)}  ${humanSize(s.size).padStart(7)}  ${cwd}`);
      console.log(`  ${' '.repeat(16)}  ${' '.repeat(6)}  ${' '.repeat(7)}  └ ${s.id}`);
    }
    return;
  }

  // ---- 选择目标会话 ----
  let target;
  if (opts.target) {
    const matches = sessions.filter((s) => s.id === opts.target || s.id.includes(opts.target));
    if (!matches.length) {
      console.error(`找不到匹配 "${opts.target}" 的会话。用 --list 查看。`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`"${opts.target}" 匹配到 ${matches.length} 个会话，请给更长的前缀：`);
      for (const m of matches.slice(0, 10)) console.error(`  ${m.id}`);
      process.exit(1);
    }
    target = matches[0];
  } else {
    // 默认（或 --current）：按当前工作目录匹配最新会话
    const cwd = process.cwd();
    const withHeader = [];
    for (const s of sessions) {
      const header = readHeaderOnly(s.file);
      if (header?.cwd) withHeader.push({ ...s, cwd: header.cwd });
      if (withHeader.length >= 40) break; // 足够找到当前项目的会话
    }
    const sameCwd = withHeader.filter((s) => path.resolve(s.cwd) === path.resolve(cwd));
    target = sameCwd[0] ?? sessions[0];

    if (!sameCwd.length) {
      console.error(
        `⚠️  当前工作目录（${cwd}）下没找到会话，改用最近活动会话 ${target.id}。\n` +
          `    用 --list 查看全部会话，或显式传入会话 ID。\n`,
      );
    }
  }

  // ---- 读取与提炼（全部走插件那份唯一实现）----
  const session = readSession(target.file);
  const x = foldSession(session.events);
  const scored = scoreContextHealth({
    usedTokens: x.usage?.lastContextTokens ?? 0,
    contextWindow: x.requestContext?.contextWindow ?? null,
    repeatWorst: x.repeatWorst,
    degradedReplies: x.degradedReplies,
    // N-5：思考退化也参与评分（真事故里唯一能看到的信号）
    reasoningLoop: x.reasoningLoop,
    reasoningFlags: x.reasoningFlags,
    reasoningWorstRepeat: x.reasoningWorstRepeat,
    summaryCount: x.summaryCount,
  });

  // ---- --health：只做健康自检，不生成文档 ----
  if (opts.healthOnly) {
    const used = x.usage?.lastContextTokens ?? 0;
    const cw = x.requestContext?.contextWindow ?? null;
    console.log(`会话        ：${target.id}`);
    console.log(`健康评分    ：${scored.score} / 100 — ${LEVEL_LABEL[scored.level] ?? scored.level}`);
    if (used) console.log(`上下文规模  ：${used.toLocaleString()} token`);
    if (cw && scored.windowPercent !== null) {
      console.log(`占声明窗口  ：${scored.windowPercent.toFixed(1)}%（窗口 ${cw.toLocaleString()}）`);
    }
    if (scored.effectivePercent !== null && scored.effectiveWindow) {
      console.log(
        `有效占用    ：${scored.effectivePercent.toFixed(1)}%` +
          `（有效窗口 ${scored.effectiveWindow.toLocaleString()}，系数 ${COMPACT_DEFAULTS.effectiveWindowRatio}）`,
      );
    }
    if (!used) console.log(`上下文占用  ：无法确定`);
    if (x.repeatWorst >= 3) {
      console.log(`重复工具调用：最长连续 ${x.repeatWorst} 次`);
    }
    if (x.degradedReplies > 0) {
      console.log(`输出退化    ：${x.degradedReplies} 条回复出现异常特征`);
    }
    const thinkTotal = (x.reasoningLoop ?? 0) + (x.reasoningFlags ?? 0);
    if (thinkTotal > 0) {
      console.log(
        `思考异常    ：${thinkTotal} 次（打转 ${x.reasoningLoop ?? 0} / 其他 ${x.reasoningFlags ?? 0}）` +
          (x.reasoningWorstRepeat >= 10
            ? `，最长同一行重复 ${x.reasoningWorstRepeat.toLocaleString('en-US')} 次`
            : ''),
      );
    }
    if (scored.findings.length) {
      console.log('发现：');
      for (const f of scored.findings) console.log(`  - ${f}`);
    }
    return;
  }

  // ---- 生成文档：与插件走**完全同一条**渲染路径 ----
  const built = buildHandoff({
    events: session.events,
    header: session.header ?? {},
    source: 'log',
    generation: `v${session.generation}`,
    options: limits,
  });
  const markdown = built.markdown;

  // ── 交接历史留痕（N-6 建议 1）：零 token、纯本地，日后可据此反推阈值 ──
  recordHandoff({
    at: Date.now(),
    sessionId: target.id,
    via: 'cli',
    profile: built.stats.profile,
    score: scored.score,
    level: scored.level,
    effectivePercent: scored.effectivePercent,
    windowPercent: scored.windowPercent,
    usedTokens: x.usage?.lastContextTokens ?? 0,
    summaryCount: x.summaryCount ?? 0,
    degradedReplies: x.degradedReplies ?? 0,
    reasoningLoop: x.reasoningLoop ?? 0,
    reasoningFlags: x.reasoningFlags ?? 0,
    chars: built.stats.chars,
  });

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
    console.error(`✅ 交接文档已写入：${outPath}`);
  } else {
    process.stdout.write(markdown);
  }

  if (opts.stats) {
    console.error('');
    console.error('--- 解析统计 ---');
    console.error(`日志文件   : ${target.file}`);
    console.error(`代际       : v${session.generation}`);
    console.error(`zstd 帧数  : ${session.frameCount}`);
    console.error(`解压后     : ${humanSize(session.bytes)}`);
    console.error(`事件数     : ${session.events.length}`);
    console.error(`帧解压失败 : ${session.failedFrames}`);
    console.error(`JSON 解析错误: ${session.parseErrors}`);
    console.error(`用户请求   : ${x.userRequests.length}`);
    console.error(`轮次       : ${x.turns.length}`);
    console.error(`工具调用   : ${x.toolCounts.reduce((s, [, n]) => s + n, 0)}`);
    console.error(`涉及文件   : ${x.files.length}`);
    console.error(`错误       : ${x.errors.length}`);
    console.error(`健康评分   : ${scored.score}/100 (${scored.level})`);
    console.error(`思考异常   : 打转 ${x.reasoningLoop ?? 0} / 其他 ${x.reasoningFlags ?? 0}`);
    console.error(
      `决策抽取   : ${x.decisions.length} 条${x.broadFallback ? '（主词表不足，已用通用结论词兜底）' : ''}`,
    );
    console.error(`文档字符   : ${built.stats.chars}（与插件同一渲染路径）`);
  }
}

main();
