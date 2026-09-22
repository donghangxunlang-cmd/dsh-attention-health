# 数据、隐私与发布脱敏

> 这个插件的核心卖点是**全程本地**：零模型调用、零 token、不联网、不启动子进程。
> 但它确实会写盘、确实会读到会话原文。本文把"数据去哪、怎么关、发布时怎么保证不泄漏"
> 一次说清。用户向摘要见 [`README.md`](../README.md) 的「隐私与威胁模型」。

## 1. 落盘清单（全部在 `$DSH_HOME/attention-health/`）

| 文件 | 内容 | 上限 |
| --- | --- | --- |
| `handoff-history.jsonl` | 每次交接一行统计（评分、建议、成本口径，**不含对话原文**） | 512 KB 轮转为 `.1.jsonl`，共两份 |
| `guard-trips.jsonl` | 守卫命中的种类、理由、`detail`，以及**当时的思考原文尾部** | 同上 |
| `prices.json` | 可选价格覆盖表（没有就用内置价） | 手工维护，无轮转 |

`DSH_HOME` 环境变量可整体改道；删掉 `$DSH_HOME/attention-health/` 目录即完成清理
（没有索引、没有外部副本，插件下次用到会重建）。

### 守卫现场：唯一会落"原始文本"的地方

守卫会**中断正在进行的生成**，所以"抓错了必须能事后复核"是硬需求 —— 默认保留
思考原文**尾部 500 字**。开关：

```powershell
$env:DSH_ATTENTION_HEALTH_GUARD_TAIL = '0'    # 隐私模式：只存哈希 + 总长度 + 首尾各 40 字
$env:DSH_ATTENTION_HEALTH_GUARD_TAIL = '120'  # 保留尾部 120 字
```

非法值回落到 500。

## 2. 路由与威胁模型

`GET /attention-health/handoff` 是**本机通道**，四层条件同时成立才放行：
Host 是 loopback、`sec-fetch-site` 非 cross-site、Origin（若带）与 Host 同源、
连接来源 `remoteAddress` 是 loopback。

**为什么不校验 token**：官方 `isTrustedApiRequest` 同样不校验；token 校验在
`browser-auth` 层，值存在模块私有的 `PROCESS_LAUNCH_TOKENS` WeakMap 里，
插件拿不到。`remoteAddress` 是唯一不可伪造的一层（Host 头可以伪造）。
由此得到的边界：**能访问这条路由的本机进程，本来就能直接读会话日志** ——
交接文档的全部素材都来自那里，所以这条路不额外扩大暴露面。

## 3. 发布侧的隐私工程（做对了什么、踩过什么）

### 3.1 两份东西，一条流水线

```
开发仓库（完整档案：真实 ID 是证据链的一部分）
   │  tools/make-release.mjs
   │    1) PUBLISH 白名单：只挑该公开的（源码/README/LICENSE/测试/工具/文档）
   │    2) 脱敏：tools/scan-identity.mjs 的规则替换身份类信息
   │    3) 闸门：对**产物**再扫一遍，0 命中才放行
   ▼
脱敏产物 ──► 公开仓库（git push）
          └─► npm 包（tools/npm-publish.ps1 再验一次闸门）
```

身份类规则覆盖：本机项目路径、本机工具路径、Windows 用户目录、**会话 ID 三种形态**
（纯短 ID / 短前缀 / 完整 UUID）、裸 UUID、用户名、邮箱、公网 IP。

### 3.2 四条防线（任何一条失效都不会静默放行）

1. `tools/make-release.mjs` —— 组装期脱敏 + 产物闸门；
2. `tools/pre-push-gate.ps1` —— 公开仓库推送前的检查；
3. `tools/npm-publish.ps1` —— npm 发布前的打包 → 解包 → 扫描闸门（npm 不走 git，git 闸门管不到它）；
4. `.github/workflows/ci.yml` —— 公开仓库每次 push 都跑 `scan-identity --selftest`
   + 全仓 0 命中检查。

### 3.3 三条教训（两次真实事故换来的）

1. **ALLOW 放行 = 扫描盲区**：任何"文件级放行"都要对被放行内容做**人工复核**。
   自检样本尤其危险 —— 它天然长得像"该命中的样本"，于是命中被放行、文件又被原样复制，
   **两条防线同时失效**（真实事故：扫描器自检样例里写着真实会话 ID 前缀，被原样发布）。
2. **规则修完必须自证覆盖**：改脱敏/扫描规则前，先列出**所有已知形态**逐一对测。
   事故入口正是"规则能吃的形态"与"实际出现的形态"不一致（16 位 vs 12 位 vs 8 位）。
3. **引述即泄露**：解释"某值曾被泄露"时**不要复述原值** —— 第一遍修复就在注释里
   又写了一次真实前缀，第二次扫描当场抓出。注释里只写形态，不写值。

## 4. 换机使用者的检查清单

想把这份插件发给别人 / 换一台机器用：

- 只分发**脱敏产物**（`make-release` 的输出）或 **npm 包**，不要直接分发开发仓库；
- 收到仓库的人可先跑 `node tools/scan-identity.mjs .`（期望 0 命中）；
- 威胁模型是**单机、单用户**：官方 DSH 若将来支持多用户 / 远程访问，
  "不校验 token"的边界需要重新评估。

## 5. 相关

- 架构与数据流：`docs/architecture.md`
- 发布流程与闸门用法：`docs/development.md`
