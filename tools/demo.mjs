/**
 * 一分钟演示：合成思考流 → 实际 host 守卫 → 模拟取消 → 实际交接路由。
 * 不启动 DSH、不调用模型；所有读写隔离在临时 DSH_HOME，退出前清理。
 * 用法：node tools/demo.mjs [--out <尚不存在的目录>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out' && args[1])) {
  console.error('用法：node tools/demo.mjs [--out <尚不存在的目录>]');
  process.exit(2);
}
const outDir = args.length ? path.resolve(args[1]) : null;
if (outDir && fs.existsSync(outDir)) {
  console.error('输出目录已存在；请指定新目录，演示不会覆盖已有文件。');
  process.exit(2);
}

const tempRoot = path.resolve(os.tmpdir());
const home = fs.mkdtempSync(path.join(tempRoot, 'attention-health-demo-'));
const envKeys = ['DSH_HOME', 'DSH_ATTENTION_HEALTH_GUARD_TAIL'];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalError = console.error;
const hostLogs = [];
let completed = false;

try {
  process.env.DSH_HOME = home;
  delete process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
  console.error = (...parts) => hostLogs.push(parts.join(' '));
  // 设置隔离目录后才加载生产模块，避免读取调用者的会话或自定义价格。
  const { apply } = await import('../lib/index.js');
  const { readGuardTrips } = await import('../lib/guard-log.js');
  const { PLUGIN_VERSION } = await import('../lib/handoff-core.js');

  const sessionId = 'session-demo-synthetic';
  const routes = [];
  const listeners = new Map();
  let projection;
  let state;
  const events = [];
  const epoch = Date.UTC(2026, 0, 1);
  const session = {
    header: { id: sessionId, title: '合成演示：把未完成任务交给新会话', cwd: '/demo/project', createdAt: epoch },
    snapshotEvents: () => events,
  };
  const ctx = {
    sessionProjections: {
      register: (definition) => { projection = definition; },
      stateOf: () => state,
    },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: (name) => name === 'sessions'
      ? { get: (id) => id === sessionId ? session : undefined }
      : name === 'sessionProjections' ? ctx.sessionProjections : undefined,
    effect: (callback) => callback(),
    inject: (_deps, callback) => callback(ctx),
    on: (name, callback) => listeners.set(name, callback),
  };
  apply(ctx);
  assert.ok(projection, 'host 必须实际注册投影');
  assert.equal(routes.length, 1, 'host 必须实际注册交接路由');
  const stream = listeners.get('agent/assistant-stream');
  assert.equal(typeof stream, 'function', 'host 必须实际注册思考流守卫');
  state = projection.init();
  const event = (type, data) => {
    const entry = { type, seq: events.length + 1, time: epoch + (events.length + 1) * 1000, data };
    events.push(entry);
    state = projection.apply(state, entry);
  };
  // 模型名故意未知：演示只验证守卫与交接，避免成本参与交接判定（展示金额仍可能随时段变化）。
  event('request/context', { contextWindow: 1000000, model: 'demo-synthetic-model' });
  event('turn/start', { turn: 1 });
  const request = '请完成演示项目的输入校验，并补充空输入检查。';
  event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: request }] });
  event('assistant/message', {
    turn: 1,
    message: { content: [{ type: 'text', text: '决定先处理正常输入。已完成基础校验，下一步检查空输入。' }] },
    usage: { totalTokens: 500000, inputTokens: 1000, cacheReadTokens: 10000, outputTokens: 80 },
  });
  event('todo/write', { todos: [{ content: '补充空输入检查', status: 'pending' }] });

  function replay(attemptId, lines) {
    const cancellations = [];
    const agent = { sessionId, cancel: (reason) => cancellations.push(reason) };
    stream({ agent, frame: { type: 'start', attemptId } });
    for (const text of lines) {
      stream({ agent, frame: { type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', index: 0, text } } });
    }
    stream({ agent, frame: { type: 'end', attemptId } });
    return cancellations;
  }

  const normal = replay('demo-normal', [
    '先检查输入类型，确认字符串和空值的边界。\n',
    '再整理已经完成的修改与未完成的检查。\n',
    '最后给接手方列出可以复现的下一步。\n',
  ]);
  assert.equal(normal.length, 0, '正常样本不得被中止');
  assert.equal(readGuardTrips().length, 0, '正常样本不得写守卫命中记录');
  assert.equal(state.compactAdvice, 'continue', '仅规模偏大、无退化时应继续');

  const loopLine = '这是合成演示中的重复思考内容，尚未进入下一步。\n';
  const loop = Array.from({ length: 12 }, () => loopLine);
  const cancelled = replay('demo-loop-default', loop);
  assert.equal(cancelled.length, 1, '复读样本必须且只能调用一次取消接口');
  assert.equal(cancelled[0].kind, 'hook');
  const [defaultTrip] = readGuardTrips();
  assert.equal(defaultTrip?.kind, 'repeat-line');
  assert.ok(defaultTrip.tail.length > 0 && defaultTrip.tail.length <= 500);
  // DSH 宿主负责把 cancel 转成 turn/end；此处模拟该宿主契约。
  event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: cancelled[0] } });
  assert.equal(state.guardTripCount, 1);
  assert.equal(state.compactAdvice, 'handoff', '守卫命中必须进入交接建议');

  process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL = '0';
  assert.equal(replay('demo-loop-reduced', loop).length, 1, '减少留存不应关闭守卫');
  const trips = readGuardTrips();
  assert.equal(trips.length, 2);
  const reducedTrip = trips[1];
  assert.equal(reducedTrip.tail, '');
  assert.equal(reducedTrip.tailHash.length, 16);
  assert.equal(reducedTrip.tailHead.length, 40);
  assert.equal(reducedTrip.tailFoot.length, 40);
  assert.ok(reducedTrip.detail.sample, 'TAIL=0 仍保留命中样本，不能宣称零原文');

  const response = {
    status: 0, body: '',
    writeHead(status) { this.status = status; },
    end(body) { this.body = String(body); },
  };
  await routes[0].handler({
    method: 'GET',
    url: `/attention-health/handoff?sessionId=${sessionId}&profile=slim&record=0`,
    headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  }, response);
  assert.equal(response.status, 200, '实际交接路由必须生成文档');
  const handoff = JSON.parse(response.body);
  assert.equal(handoff.ok, true);
  assert.equal(handoff.stats.recorded, false);
  assert.equal(fs.existsSync(path.join(home, 'attention-health', 'handoff-history.jsonl')), false);
  for (const required of [request, '补充空输入检查', '建议机械交接', '分享给他人前请自行确认']) {
    assert.ok(handoff.markdown.includes(required), `交接文档缺少：${required}`);
  }
  assert.equal(hostLogs.some((line) => /失败|异常（已隔离）/.test(line)), false, hostLogs.join('\n'));

  const summary = {
    synthetic: true, pluginVersion: PLUGIN_VERSION,
    normalCancelled: normal.length, loopCancelled: cancelled.length,
    guardKind: defaultTrip.kind, advice: state.compactAdvice,
    handoffRecorded: handoff.stats.recorded,
    reducedTailStillContainsText: true,
  };
  if (outDir) {
    fs.mkdirSync(outDir);
    const saveJson = (name, value) => fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'HANDOFF.md'), handoff.markdown + '\n', 'utf8');
    saveJson('guard-default.json', defaultTrip);
    saveJson('guard-reduced.json', reducedTrip);
    saveJson('summary.json', summary);
  }
  console.log(`一分钟演示｜插件 ${PLUGIN_VERSION}｜全部内容为合成样本`);
  console.log('1. 正常思考：未中止，未写命中记录。');
  console.log(`2. 重复思考：${defaultTrip.reason} → 调用取消接口 1 次。`);
  console.log('3. 声明窗口占用 50% + 守卫命中：建议机械交接；文档含请求、进度和待办。');
  console.log('4. 减少留存：TAIL=0 仍保留首尾各 40 字和 detail.sample；不等于零原文。');
  console.log('5. 隔离验证：record=0，未写交接历史；无模型调用或网络请求。');
  console.log('边界：调用了实际插件代码；DSH 宿主、取消动作和会话事件由演示模拟。');
  if (outDir) console.log(`合成产物已保存：${outDir}`);
  else console.log('查看完整合成文档：node tools/demo.mjs --out ./demo-result（目录须尚不存在）。');
  completed = true;
} catch (error) {
  originalError('演示失败：', error?.message ?? error);
  process.exitCode = 1;
} finally {
  console.error = originalError;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // 只清理本次创建且位于临时根目录下的目录，不接收用户提供的清理路径。
  assert.equal(path.dirname(home), tempRoot);
  fs.rmSync(home, { recursive: true, force: true });
}
if (completed) console.log('完成：临时 DSH_HOME 已清理。');
