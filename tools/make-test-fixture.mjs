/**
 * 生成**合成会话夹具** —— 给没有真实 DSH 语料的机器（CI、新克隆、换机）用。
 *
 * 为什么需要它：`test/handoff-test.mjs` 与 `test/crosscheck-test.mjs` 以
 * `$DSH_HOME/sessions` 里的**真实会话日志**为回归语料（这是它们的价值所在 ——
 * 判据与渲染是拿真实数据标定的）。但 CI / 新电脑上没有这些日志，两套测试会直接崩。
 * 本工具造一份**虚构但结构完整**的日志（多帧 zstd，与 DSH 落盘格式一致），
 * 让这两套测试在没有真实语料的环境里也能跑出绝大多数断言。
 *
 * 用法：
 *   node tools/make-test-fixture.mjs <目标 DSH_HOME>
 *   # 之后设 DSH_HOME=<目标 DSH_HOME> 再跑 test/handoff-test.mjs
 *
 * 产出（两个会话，故意一富一空）：
 *   <DSH_HOME>/sessions/--fixture--/session-fixture-a0000001/session.v3.jsonl.zstd
 *   <DSH_HOME>/sessions/--fixture--/session-fixture-b0000002/session.v3.jsonl.zstd  ← 更新但只有 3 个事件
 *
 * ⚠️ 第二个会话是**故意**的：审查清单 C1 的假失败根因是"测试拿最新会话当渲染样本"，
 * 而最新会话可能是个空会话。夹具把"最新 = 空"这个形态固化下来 —— 谁把样本选择改回
 * "最新"，渲染断言当场变红。
 *
 * ⚠️ 隐私纪律：本文件与它生成的数据**一律不得包含真实会话片段**（真实 ID / 真实路径 /
 * 真实用户名）。用例值全部是虚构形态；`<TOOLS>` 这类本机路径**不能出现**，
 * 否则发布闸门（tools/scan-identity.mjs）会命中。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/make-test-fixture.mjs <目标 DSH_HOME>');
  process.exit(2);
}
if (typeof zlib.zstdCompressSync !== 'function') {
  console.error(`需要 Node ≥22.15（zstdCompressSync 不可用；当前 ${process.version}）`);
  process.exit(2);
}

const PROJECT_DIR = '--fixture--';
const T0 = 1758000000000; // 固定时间戳：夹具必须可复现（同输入同输出）

/** 写一个会话：每行一帧，与 DSH 的「header 帧 + 逐批 append 帧」落盘形态同构。 */
function writeSession(sessionId, header, events, mtimeMs) {
  const dir = path.join(target, 'sessions', PROJECT_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')));
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(frames));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

// ── 会话 1：内容丰富的"正常会话"（渲染样本应选它——事件最多） ──
const richHeader = {
  type: 'session',
  id: 'session-fixture-a0000001',
  title: '合成会话：CI 回归夹具',
  cwd: 'X:\\fixture\\work\\demo',
  createdAt: T0,
  version: 3,
};
const richEvents = [
  { type: 'request/context', seq: 1, time: T0 + 1000, data: { contextWindow: 1000000, provider: 'deepseek', model: 'deepseek-flash' } },
  { type: 'session/title', seq: 2, time: T0 + 2000, data: { title: '合成会话：CI 回归夹具' } },
  { type: 'turn/start', seq: 3, time: T0 + 10000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 4,
    time: T0 + 11000,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '让插件测试在没有真实会话的机器上也能跑' }] },
  },
  {
    type: 'assistant/message',
    seq: 5,
    time: T0 + 12000,
    data: {
      turn: 1,
      message: {
        content: [
          { type: 'text', text: '先看失败在哪。\n根因是夹具依赖本机会话。\n结论是用合成会话夹具替代 —— 判据仍由真实语料标定。' },
        ],
      },
      usage: { totalTokens: 250000, outputTokens: 120, cacheReadTokens: 240000, inputTokens: 900, reasoningTokens: 800 },
    },
  },
  {
    type: 'todo/write',
    seq: 6,
    time: T0 + 13000,
    data: { todos: [{ content: '加合成会话夹具', status: 'in_progress' }, { content: '接进 CI', status: 'pending' }] },
  },
  { type: 'tool/call', seq: 7, time: T0 + 14000, data: { turn: 1, name: 'read', callId: 'c1', arguments: '{"file_path":"test/handoff-test.mjs"}' } },
  { type: 'tool/result', seq: 8, time: T0 + 15000, data: { turn: 1, callId: 'c1', message: { content: [{ type: 'text', text: '（读到 3100 行）' }] } } },
  {
    type: 'tool/result',
    seq: 9,
    time: T0 + 16000,
    data: { turn: 1, callId: 'c2', error: { name: 'bash', code: 'ENOENT' }, message: { content: [{ type: 'text', text: 'missing' }] } },
  },
  { type: 'turn/end', seq: 10, time: T0 + 17000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 11, time: T0 + 20000, data: { turn: 2 } },
  { type: 'user/message', seq: 12, time: T0 + 21000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
  {
    type: 'assistant/message',
    seq: 13,
    time: T0 + 22000,
    data: {
      turn: 2,
      message: { content: [{ type: 'text', text: '夹具完成，接下来接进 CI。' }] },
      usage: { totalTokens: 400000, outputTokens: 200, cacheReadTokens: 390000, inputTokens: 500 },
    },
  },
  { type: 'turn/end', seq: 14, time: T0 + 23000, data: { turn: 2, reason: { kind: 'completed' } } },
];

// ── 会话 2：**更新但只有 3 个事件**的空会话（C1 的形态固化） ──
const emptyHeader = { type: 'session', id: 'session-fixture-b0000002', cwd: 'X:\\fixture\\work\\empty', createdAt: T0 + 100000, version: 3 };
const emptyEvents = [
  { type: 'turn/start', seq: 1, time: T0 + 101000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: T0 + 102000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '刚开的新会话' }] } },
  { type: 'turn/end', seq: 3, time: T0 + 103000, data: { turn: 1, reason: { kind: 'completed' } } },
];

const richFile = writeSession(richHeader.id, richHeader, richEvents, T0 + 23000);
const emptyFile = writeSession(emptyHeader.id, emptyHeader, emptyEvents, T0 + 103000);

console.log(`夹具已写入 ${path.join(target, 'sessions')}`);
console.log(`  · 丰富会话（旧）：${richFile}（${richEvents.length + 1} 行）`);
console.log(`  · 空会话（新）：  ${emptyFile}（${emptyEvents.length + 1} 行）← 故意做成"最新"`);
console.log('  下一步：export DSH_HOME=' + target + ' 再跑 test/*.mjs');
