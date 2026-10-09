# AGENTS.md —— dsh-attention-health 项目常驻约定

> 给**每次新会话**的接手方（人或 AI）。这里的每一条都是**踩过的坑**；
> 完整经过在 `DEPLOYMENT-NOTES-20260915.md`（很大，按需检索，**别整篇塞进上下文**）。
> 存在的理由：用项目自己的机制解决"跨会话失忆"—— BOM 那条坑正是因此踩了三次。

## 1. 部署与生效（2026-09-20 门 3 之后：**线上是标准插件包**）

> ⚠️ **2026-10-01 环境变更**：本机 DSH 已换成**桌面版**（Electron `DeepSeek Harness.exe`）+
> **`desktop` profile**（2026-09-30 起；`profiles\web` 已不存在）。两条后果必须知道：
> 1. **profile 名不写死** —— 探测统一走 `tools\profile-paths.mjs`（依据 profile 的
>    `package.json` 是否声明本插件）。写死 `profiles\web` 会让自测静默测到**旧残留副本**
>    而报假失败（2026-10-01 实测：3 套失败；修好后 723 全绿）；多个 profile 装了用
>    `DSH_PROFILE` 指定。
> 2. **桌面版不暴露 `dsh` CLI**（打包在 `app.asar` 内）—— `install-package.ps1` 的入口探测
>    会落空（已给出明确指引）；`restart-attention-health.ps1` 检测到 `DeepSeek Harness.exe`
>    会**拒绝运行并退出码 3**（它是 web 形态重启器：按 `node.exe + dsh\lib\bin` 找进程、
>    按端口 3080 判活，在桌面版下会误判并再拉起一个实例）。桌面版请用**插件管理界面**
>    安装、重启桌面应用使 host 半生效；`.\test-all.ps1` 不受影响，照常可用。

- **源码只有一个目录**：`lib/` —— host 半（`index.js` / `handoff*.js` / `history.js` /
  `guard.js` / `guard-log.js` / `prices.js` / `jsonl.js`）与浏览器半（`client.js`）都在里面；
  仓库根就是 npm 包根（`package.json` + `cordis.patch.yml`）。
- **线上形态 = 安装产物**：`$DSH_HOME\profiles\<profile>\node_modules\dsh-attention-health`，
  由 `dsh plugin --profile <profile> add -w <tgz>` 装进去，层栈记在 profile 的 `dsh.profile.bundles`。
  ⚠️ **改 `lib/` 不会自动同步到线上** —— 旧形态时"跑一次 deploy 就同步"已经失效。
- 一条命令完成"打包 + 安装"：`.\install-package.ps1`（tgz 落在 `-PkgDir` →
  `$env:DSH_ATTENTION_HEALTH_PKG_DIR` → `<DSH_HOME>\attention-health-pkg` 三者中第一个给出的目录；
  **必须是稳定目录**：profile 里记的是这个路径，放进"临时"被清理后再 install 会找不到）。
- **工具路径一律走环境变量**（`DSH_NODE_DIR` / `DSH_BIN` / `DSH_ATTENTION_HEALTH_PKG_DIR` /
  `DSH_NODE_EXE` / `DSH_NPM_CMD`）—— 脚本里**不许写死本机路径**：公开产物会把这类路径
  脱敏成 `<TOOLS>` 占位符，产物里的脚本当场失效（2026-09-22 实测：产物版 `npm-publish.ps1`
  报"找不到 npm.cmd"）。本机已设好前三个用户级变量。
- 改完 host 半 → **web 形态**：`.\restart-attention-health.ps1`（重启 + 运行时验证）；
  **桌面版**：重启桌面应用（脚本会拒绝运行，见上方变更说明）。只改 `client.js` → 刷新页面即可。
- 自测：`.\test-all.ps1`（**自动探测并打印被测形态**，指向线上那份标准包；也可 `-Dir` / `-UiDir`
  指到任意一份，例如临时 profile 的安装；`DSH_PROFILE` 可在多 profile 都装了时指定）。
  五套测试脚本的默认路径同样走 `tools/profile-paths.mjs` 自动探测，不再写死 profile 名。
- **没有真实语料的环境**（CI / 新克隆 / 换机）：先 `node tools\make-test-fixture.mjs <DSH_HOME>`
  造合成会话（一富一空，空的那个故意做成"最新"—— 钉住审查清单 C1 的样本选择回归），
  再设 `DSH_HOME` / `DSH_ATTENTION_HEALTH_DIR` / `DSH_ATTENTION_HEALTH_UI_DIR` 跑五套，
  数量以实际汇总为准，必须 **0 失败**（4 项依赖特定真实会话的回归会跳过并打印原因）。
- `.\deploy.ps1` 已**退役为回退工具**：检测到标准安装就拒绝运行（`-Force` 才绕过）。
  它部署的是旧形态挂载线（`profiles\web\attention-health\` +
  `profiles\node_modules\attention-health-ui\`）—— 两个目录与 patch 里的两条旧行**都还留着**，
  所以回退只需：`remove` 标准包 → 恢复 patch 快照 → `.\deploy.ps1 -Force` → 重启。
  快照在 `<TOOLS>\DSH\留档\attention-health-发布前快照-20260920\`。
- 新增 host 模块（`lib/*.js`）：标准形态由 `files: ["lib/"]` 自动包含；
  **回退线仍要能跑**，所以也要加进 `deploy.ps1` 的复制清单。
- `handoff.js` 是 **barrel**（显式导出名单）：新增导出要同步那一行。
- **浏览器半的模块 id 必须等于它所属包的包名**（`dsh-client-modules` 用解析出的包名当模块身份）：
  标准包里是 `dsh-attention-health`；`deploy.ps1` 走旧形态时会把它改写成 `attention-health-ui`
  （改写前断言"恰好出现一次"）。
- **两个必踩的 pnpm 坑**：
  1. `add` 必须带 `-w` —— profile 自身就是 workspace 根，否则 `ERR_PNPM_ADDING_TO_ROOT`；
  2. **pnpm 主版本要对得上** —— profile 的 `node_modules\.modules.yaml` 记着创建它的 pnpm
     （本机 web profile 是 `pnpm@11.19.0` / `virtualStoreDirMaxLength=60`），
     用 pnpm 9 去 `add` 会报 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`。**用 pnpm 11**。
- **组合 URL 的坑**：客户端 bundle 走 `/plugins/??a/client.js&b/client.js&rev=…` ——
  **只有第一条前面是 `??`，后面的前面是 `&`**。用正则找包名时别写 `/<名字>/client.js`
  （2026-09-20 切标准包后立刻漏检，4 项假失败）。

## 2. 编码与换行（踩过三次的坑）

- **`.ps1` 必须 UTF-8 带 BOM**；`edit` 工具会剥掉 BOM —— 改完立刻补，或跑 `deploy.ps1`
  的第 0 步自检（注意：`deploy.ps1` 自己丢了 BOM 时，那一步也跑不到）。
- `.md` / `.js` / `.mjs`：**无 BOM + LF**（`.gitattributes` 已钉死）。

## 3. 判定链的口径只有一处

- `deriveCompactionPlan` 的入参由 **`compactionInputOf(x, meta)`**（`handoff-render.js` 导出）
  统一构造 —— 测试与探针**都用它**，不要手抄字段（抄漏一个就会得出假结论，§51.4 踩过）。
- 退化信号的判据实现只有一处：`plan.quality.degraded`
  （`guardTripCount > 0` / `reasoningLoop > 0` / `reasoningFlags > 0` /
  `degradedReplies ≥ 阈值` / `repeatWorst ≥ 阈值`）。
- 阈值与词表只在 `handoff-core.js` 的 `COMPACT_DEFAULTS`；价格在 `lib/prices.js`；
  界面文案的取舍原则见 `DEPLOYMENT-NOTES` §56（X 节：UI 不解释设计决策）。

## 4. 数据与落盘

- 落点全部在 `$DSH_HOME/attention-health/`：`handoff-history.jsonl`、`guard-trips.jsonl`、
  `prices.json`（JSONL 由 `lib/jsonl.js` 统一做 **512 KB 轮转**，磁盘占用有界）。
- 守卫现场默认保留思考原文**尾部 500 字**；`DSH_ATTENTION_HEALTH_GUARD_TAIL=0` 切减少留存模式
  （仍存尾部片段的哈希、长度、首尾各 40 字；reason / detail 也可能含原文，不是零原文模式）。
- **写路径纪律**：测试/验证脚本一律 `mkdtemp` + 临时 `DSH_HOME` + 用完即删；
  自动化验证写历史样本时传 `record=0`（否则污染校准数据）。

## 5. 验证的习惯

- **改判据 → 必须重跑真实语料回归**：守卫改动用 `work/q-blocks-scan.mjs`
  （5,000+ 真实思考块的误报率）；判定改动用 `work/n9-scan-probe.mjs`（全量判定分布）。
- **断言"某文案不出现"之前，先确认那条渲染路径真的被走到**（§49.4 的"假通过"教训）。
- 结论要有证据；拿不到的就写"不知道"，不确定就写"无法判断"。

## 6. 已知的 DSH 契约

- `usage.inputTokens` **不是**上下文规模（要用 `totalTokens`）。
- 会话日志有**多代际**（`session.v3.jsonl.zstd` 等）：只读最高版本；
  zstd 是**多帧**，要逐帧解压（`lib/zstd-frames.mjs`，已加资源上限）。
- `todo` 投影每轮清空。
- 插件的 HTTP 路由是**裸路由**，由 `isTrustedHandoffRequest` 把守：Host +
  `sec-fetch-site` + Origin + `remoteAddress`。
  **不校验 token** —— 官方 `isTrustedApiRequest` 同样不校验（token 校验在 `browser-auth` 层，
  值存在模块私有的 `PROCESS_LAUNCH_TOKENS` WeakMap 里，插件拿不到）。
- 插件能力面比想象的大：`ctx.on('agent/assistant-stream')` 可逐帧拿到思考流，
  `agent.cancel({ kind:'hook', reason })` 可中止活动 turn（守卫就建立在这两个之上）。

## 7. 发布与隐私（2026-09-22 生态审计后新增）

### 7.1 发布前检查清单（每次发布都跑）

```powershell
.\test-all.ps1                 # 五套自测（必须 0 失败）
node tools\make-release.mjs    # 组装产物 + 脱敏 + **身份闸门**（0 命中才放行）
# 生态审计（第三方标准，需联网；**对 npm 包扫，不要对仓库根扫**）：
npm pack                       # → dsh-attention-health-x.y.z.tgz
tar -xzf dsh-attention-health-x.y.z.tgz -C <临时目录>
cd <临时目录>\package; npx dsh-vet .   # 期望 grade A（0 critical / high / medium）
```

- **CI 会自动跑**（`.github/workflows/ci.yml`，公开仓库每次 push / PR）：语法检查、
  身份闸门、五套自测（合成语料，数量以实际输出为准）、dsh-vet A 级门 —— 推送后看一眼 Actions 结果即可，
  不必在本机重复这四件事。
- **发布产物内容 = `tools/make-release.mjs` 的 `PUBLISH` 白名单**（含 `docs/`、`.github/`）；
  新增要公开的目录/文件时**必须同步改白名单**，否则它只会留在开发仓库（AJ.7 的
  `SECURITY.md` 漏项就是这么来的）。
- **要扫 npm 包，不要扫仓库根**：`test/` `tools/` 不进包，对仓库根扫会得到
  `obf.dynamic-require` 与一大批 `unreachable-files` 的**假告警**（见 `DEPLOYMENT-NOTES` §70.5）。
- 报告存档：`<TOOLS>\DSH\留档\attention-health-dsh-vet\`（用 `--json`）。

### 7.2 三条隐私教训（两次同类事故换来的，见审查清单 §AI）

1. **ALLOW 放行 = 扫描盲区**：任何"文件级放行"都要对被放行内容做**人工复核** ——
   自检样本尤其危险：它天然长得像"该命中的样本"，于是它自身的命中被 `ALLOW` 放行、
   文件又被 `NO_SANITIZE` 原样复制，**两条防线同时失效**；
2. **规则修完必须自证覆盖**：改脱敏/扫描规则前，先列出**所有已知形态**
   （纯短 ID / 短前缀 / 完整 UUID / 公网 IP / 真实盘符路径…）逐一对测 ——
   事故入口正是"规则能吃的形态"与"实际出现的形态"不一致（16 位 vs 12 位 vs 8 位）；
3. **引述即泄露**：解释"某值曾被泄露"时**不要复述原值**（第一遍修复就在注释里又写了一次
   真实前缀，第二次扫描当场抓出）。注释里只写**形态**，不写值。

### 7.3 能力声明（`dsh.seams`）

`package.json` 的 `dsh.seams` 是**对外声明**（审计工具据此比对"声明 vs 实际"）：
本插件声明 `["fs", "web"]`（本地 JSONL 读写 + 浏览器半同源取数）。
**改代码时若新增能力（子进程 / 外部网络 / worker），必须同步更新它** ——
声明与实际不符会被 `perm.seam-mismatch` 报 medium 并拉低评级。
（`env` / `homedir` 不映射到任何 seam，无需声明；本插件没有 `child_process`，故不需要 `shell`。）

## 8. 审查文档：**每轮先读它，并按它更新**（2026-10-01 用户要求）

- 审查侧维护一份**持续追加**的《attention-health 审查清单与修复任务（2026-09-18）》，
  按字母分节（`A`…`AX`…），**新结论总是追加在末尾**。用户 2026-10-01 明确要求：
  **以后每一轮都按这份文档的最新节去更新** —— 它是待修项的来源，不只是历史记录。
  ⚠️ 2026-10-01 的教训：接手时只读了仓库内文档（本文件 / README / docs），**漏了它**，
  结果自己"独立发现"的问题（桌面版守卫误停）审查侧当天已经写成待修项（AX 节）——
  重复劳动不说，还差点把已完成的分析当成新结论汇报。
- 位置在用户四区约定的**成品/留档区**（文件名含 `审查清单与修复任务`），由用户提供；
  **不要在公开产物里写死它的绝对路径**（发布脱敏会变成 `<TOOLS>` 占位符）。
- 怎么用：文档约 3900 行 —— **只读最新几节 + 按关键词检索**，别整篇载入
  （与 `DEPLOYMENT-NOTES-20260915.md` 同一条纪律）。每轮开工前先看末尾有没有新节。
- 已完成/未完成以它为准，例如 AX 节（2026-10-01）的桌面版守卫误停：
  **档位 0（结构重复放行）已实现**；档位 1/2/3 的阈值它自己标注为"待验证的候选值"，未实现。
- 分工（**2026-10-02 用户更新**）：审查文档的**裁决与复核节**仍由审查侧维护，开发侧**不改动已有内容**；
  但**开发侧每轮的改动和修复也要追加进审查文档** —— 在末尾追加「开发侧完成报告」节
  （延续字母编号，如 `BF`），只追加、并在节首标明"本节由开发侧写、性质是回执而非裁决"。
  开发仓自己的详细记录照旧写 `DEPLOYMENT-NOTES-20260915.md`（两条线各自留痕）。
  ⚠️ 为什么改：2026-10-02 发现 §86–§90 五个提交**两边都没留痕**，审查侧无从跟进
  （BE.4 把 `§90` 已经做掉的"档位 1/2"仍列为"待完成"）。
