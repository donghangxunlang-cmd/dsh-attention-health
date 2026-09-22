# 架构：两条执行路径，一套判据

> 面向读代码的人。用户向的说明在 [`README.md`](../README.md)；
> 本文只讲"代码怎么组织的、改动时哪些不变式不能破"。

## 1. 两个半身

插件是一个标准 DSH bundle，一次装入两面：

| 半身 | 入口 | 运行位置 | 干什么 |
| --- | --- | --- | --- |
| host 半 | `lib/index.js` | DSH 主进程（Cordis 插件） | 注册 `attentionHealth` 投影、接 `agent/assistant-stream` 实时守卫、提供 `GET /attention-health/handoff` 路由、写本地留痕 |
| 浏览器半 | `lib/client.js` | web 外壳（`dsh-client-modules` 加载） | 渲染健康提示条、四档建议、复制交接内容、请求 host 生成交接文档 |

挂载只有一行（`cordis.patch.yml`）：按**包名**解析到 `package.json`，
host 半走 `main`，浏览器半走 `dsh.client.platform: web` + `exports["./client"]`。
浏览器半的模块身份 = 包名，所以改包名要同步改两处。

## 2. 两条执行路径（同一个答案）

同一份会话数据，代码里有三条实现路径 —— 这是本项目历史上出过事故的地方，
现在由 `test/crosscheck-test.mjs` 全量对拍：

```
                      ┌─ A. 活会话热路径      lib/index.js  foldEvent       ← 提示条真正走的
同一份会话事件流 ──────┼─ B. 冷会话折叠路径    lib/handoff-fold.js foldSession ← 交接文档走的
                      └─ C. 离线 CLI 路径     lib/detect.mjs analyzeSession ← handoff --health 走的
```

- A 与 B **必须给出同样的请求数 / 轮次 / 文件 / 错误 / token / 待办 / 未闭合轮次**；
- C 只负责"扫日志 + 调用同一套判据"，不自持实现；
- 交接文档的渲染**只有一份实现**（`lib/handoff-render.js` 的 `buildHandoff`），
  CLI（`handoff.mjs`）直接 import 它 —— 历史上 CLI 与插件各持一套渲染，
  第二批修复只落到一边，同一会话会产出两种质量的文档（审查清单 B2 的由来）。

## 3. 判定链的单一来源（改判据只改这里）

| 概念 | 唯一实现 | 备注 |
| --- | --- | --- |
| 退化判据（输出/思考） | `lib/handoff-judge.js` | `replyDegradeReasons()` / `scanReasoning()` |
| 评分与阈值 | `lib/handoff-core.js` | `scoreContextHealth()`；阈值/词表只在 `COMPACT_DEFAULTS` |
| 计划推导（继续/压缩/交接） | `lib/handoff-plan.js` | `deriveCompactionPlan()`；四档建议 `continue / costNote / prepare / handoff` |
| 计划入参构造 | `lib/handoff-render.js` 的 `compactionInputOf()` | 测试与探针**都必须用它**，手抄字段会得出假结论（审查清单 §51.4） |
| 价格与峰谷 | `lib/prices.js` | 可被 `$DSH_HOME/attention-health/prices.json` 覆盖 |
| 评分封顶（有损压缩） | `lib/handoff-core.js` | 1 次模型摘要 → ≤79、2 次 → ≤65、≥3 次 → ≤50 |

退化信号进入 `plan.quality.degraded` 的判据同样只有一处：
`guardTripCount > 0` / `reasoningLoop > 0` / `reasoningFlags > 0` /
`degradedReplies ≥ 阈值` / `repeatWorst ≥ 阈值`。

## 4. 实时守卫

`lib/guard.js` 挂在 `ctx.on('agent/assistant-stream')` 上逐帧看思考流，
命中"机械复读/空转"时用 `agent.cancel({ kind: 'hook', reason })` 中止当轮。
设计取向是**宁漏不误杀**（误杀比不提示更糟），所以判据都带"连续次数 + 字符数 +
唯一率"的多重条件；命中现场交给 `lib/guard-log.js` 落档（见 `privacy.md`）。

守卫隔离性：每 attempt 一个实例、按 `attemptId` 索引，`start` 建 / `end` 删 /
命中即删；没有 attemptId 的帧不介入；整个回调 try/catch 包住 —— 守卫本身
绝不能把 DSH 主流程搞挂。

## 5. 数据流与磁盘

```
$DSH_HOME/sessions/**/session[.vN].jsonl.zstd    ← DSH 自己的会话日志（只读）
        │  lib/zstd-frames.mjs（多帧 zstd 逐帧解压）
        │  lib/session-log.mjs（代际选择：只读数值最高的那一代）
        ▼
   事件流 ──► 折叠（A/B/C 三路径）──► 判定链 ──► 投影（UI）/ 交接文档 / 离线自检
        │
        └──► $DSH_HOME/attention-health/
               handoff-history.jsonl   每次交接一行统计（不含原文）
               guard-trips.jsonl       守卫命中现场（默认含思考尾部 500 字）
               prices.json             可选价格覆盖
             （JSONL 由 lib/jsonl.js 统一 512 KB 轮转，磁盘占用有界）
```

## 6. 关键契约（改代码前先看这些）

- `usage.inputTokens` **不是**上下文规模，要用 `totalTokens`（`contextTokensOf()` 已封装）；
- 会话日志有多代际（`session.jsonl.zstd` / `session.v2…` / `session.v3…`），只读最高版本；
- 日志是**多帧** zstd，Node 内置流式解压解不完（会报 `ZSTD_error_prefix_unknown`），
  必须走 `lib/zstd-frames.mjs`（帧边界逻辑移植自官方 `@deepseek-ai/dsh-session-persistence-jsonl`）；
- `todo` 投影每轮清空；`user/message` 要按 `source.kind` 过滤；
- 插件的 HTTP 路由由 `isTrustedHandoffRequest` 把守（Host + `sec-fetch-site` + Origin +
  `remoteAddress`），**不校验 token**（官方 `isTrustedApiRequest` 同样不校验，原因见 `privacy.md`）；
- 输出体积上限：附录 A 20,000 字符 / 附录 B 12,000 字符 / 精简档另有 900 字符级封顶，
  改渲染时不要绕过 `sectionChars` 系列的守卫断言。

## 7. 相关

- 部署与换机：`docs/development.md`
- 数据去向、隐私开关、发布脱敏流水线：`docs/privacy.md`
- 项目常驻约定（踩过的坑清单）：`AGENTS.md`
