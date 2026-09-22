# 安全策略（Security Policy）

> attention-health 是 DSH（DeepSeek Harness）的**本地会话健康监测**插件。
> 它自身**不调用任何模型、不向外部端点发送任何数据**。
> 本文件说明它的能力面、数据去向与漏洞报告渠道 —— 供你在"允许运行前检查"时使用
> （对齐官方 `SAFETY.zh.md` 的立场）。

## 1. 能力面（Capability surface）

按生态审计标准 [`dsh-vet`](https://github.com/rogerdigital/dsh-vet) 的口径，本插件在
`package.json` 的 `dsh.seams` 里**显式声明**自己使用的能力：

```json
{ "dsh": { "seams": ["fs", "web"] } }
```

| seam | 用途 | 边界 |
| --- | --- | --- |
| `fs` | 读会话日志（**只读**）、写本地历史与守卫现场 | 只碰 `$DSH_HOME` 与当前项目目录 |
| `web` | 浏览器半向**本机同源**路由取健康数据 | 只打 `127.0.0.1`，**无外部端点** |

**不使用的能力**：不 spawn 子进程、不 `eval` / 不动态 `require`、不读凭据、
不写 `$DSH_HOME` 以外的持久文件。

## 2. 数据去向（Data flow）

- **零模型调用**：全部判据都是本地规则（阈值与词表在 `lib/handoff-core.js` 一处定义）。
- **零外部网络**：插件不向任何外部地址发送数据。浏览器半的 `fetch` 只请求本机 DSH 服务的
  **同源**路由（`/attention-health/handoff`），且该路由由 `isTrustedHandoffRequest`
  校验 Host / Origin / `sec-fetch-site` / `remoteAddress`。
- **本地落盘**（根目录可用 `DSH_HOME` 覆盖）：

  | 文件 | 内容 | 轮转 |
  | --- | --- | --- |
  | `attention-health/handoff-history.jsonl` | 交接历史留痕（阈值回溯素材） | 512 KB |
  | `attention-health/guard-trips.jsonl` | 思考守卫的现场记录 | 512 KB |
  | `attention-health/prices.json` | 价格表覆盖（可选，用户手写） | — |

- ⚠️ **守卫现场默认保留思考原文尾部 500 字** —— 其中可能含个人信息。
  设环境变量 `DSH_ATTENTION_HEALTH_GUARD_TAIL=0` 可切到**隐私模式**
  （只存哈希 + 长度 + 首尾各 40 字）。
- **不外发**：以上数据不会离开本机。

## 3. 运行前建议检查什么（对齐官方 SAFETY.md）

1. 读 `lib/`：单层目录、纯 ESM、无第三方依赖（除 `zod`）；
2. 确认 `dsh.seams` 只声明你接受的能力（见上表）；
3. 确认 npm 包内容 = `lib/` + `handoff.mjs` + `cordis.patch.yml` + `README.md` + `LICENSE`
   （`package.json` 的 `files` 白名单，测试与构建工具**不进包**）；
4. 自证一遍：`npx dsh-vet dsh-attention-health`（或对本地目录 `npx dsh-vet .`）。

## 4. 报告漏洞

- **首选**：开 [GitHub Issue](https://github.com/donghangxunlang-cmd/dsh-attention-health/issues)。
  若涉及尚未修复的敏感细节，请只描述**影响面**，我们换渠道对接。
- 请尽量附上：插件版本、`npx dsh-vet --json <specifier>` 的报告、复现步骤。
- **响应期望**：个人维护的开源项目，不承诺 SLA；但安全问题**优先于功能开发**处理。

## 5. 已知边界（刻意不做的事）

- 插件**只提示、不自动压缩、不改官方 compaction 配置**（见 README 的边界声明）；
- 不读取模型凭据或任何网络凭据；
- **不做遥测**：无 analytics、无上报、无"检查更新"之内的外联；
- 不修改会话日志：`$DSH_HOME/sessions/**` 全程**只读**。
