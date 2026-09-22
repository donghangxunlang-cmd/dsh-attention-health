# 开发、测试与发布

> 面向要改这个仓库的人（包括未来的自己）。项目常驻约定与踩过的坑见 [`AGENTS.md`](../AGENTS.md)；
> 本文是"从零到发布"的一条线。

## 0. 前置

- **Node ≥ 22.19**（会话日志解码用 `zlib.zstdDecompressSync`；夹具生成用 `zstdCompressSync`）；
- DSH（DeepSeek Harness）本机可跑；
- 包管理器：本机开发用 **pnpm 11**（装进 profile 时必须与 profile 记录的 pnpm 主版本一致，
  否则报 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`）；
- Windows 下**.ps1 必须 UTF-8 带 BOM**，`.md` / `.js` / `.mjs` 必须**无 BOM + LF**
  （`.gitattributes` 已钉死 LF；BOM 靠自觉与 `deploy.ps1` 的自检）。

## 1. 仓库布局

仓库根 = npm 包根。源码全在 `lib/`；`test/` `tools/` `docs/` `work/` 只进公开仓库，
不进 npm 包（`files` 白名单）。

开发仓库与公开仓库是**两份东西**：开发仓库是完整档案（含真实会话 ID 的实测证据注释、
`DEPLOYMENT-NOTES-20260915.md`、`HANDOFF.md`、`work/`）；公开仓库是 `tools/make-release.mjs`
生成的**脱敏产物**。两者的隐私边界见 `privacy.md`。

## 2. 跑自测

### 有真实语料（维护者本机，首选）

```powershell
.\test-all.ps1        # 自动指向线上标准安装；期望 719 项 0 失败
```

五套测试各自也以 `test/*.mjs -Dir` 或环境变量覆盖被测目录：

- 被测 host 半：`DSH_ATTENTION_HEALTH_DIR`（指向**含 index.js 的目录**，通常是 `lib/` 或安装包的 `lib/`）
- 被测 UI 包：`DSH_ATTENTION_HEALTH_UI_DIR`（指向包根，含 `package.json`）
- 数据目录：`DSH_HOME`（测试会临时改道，写盘一律 `mkdtemp`，不污染真实历史）

### 没有真实语料（CI / 新克隆 / 换机）

```bash
node tools/make-test-fixture.mjs "$RUNNER_TEMP/ah-home"   # 造两个合成会话（一富一空）
export DSH_HOME="$RUNNER_TEMP/ah-home"
export DSH_ATTENTION_HEALTH_DIR="$PWD/lib"
export DSH_ATTENTION_HEALTH_UI_DIR="$PWD"
for t in guard-test plugin-test ui-build-test handoff-test crosscheck-test; do node "test/$t.mjs"; done
# 期望 715 项 0 失败（少掉的 4 项是"依赖特定真实会话"的回归，会自动跳过并打印原因）
```

第二条会话是**故意**做的"最新但空"形态：审查清单 C1 的假失败根因就是
"渲染样本取最新会话"，而最新会话可能是个空会话 —— 夹具把该形态固化，
谁把样本选择改回"最新"，渲染断言当场变红。

## 3. 改判据的纪律

改判据 / 阈值 / 词表时，除五套自测外**必须重跑真实语料回归**：

| 改动面 | 回归工具 | 看什么 |
| --- | --- | --- |
| 实时守卫判据 | `work/q-blocks-scan.mjs` | 5,000+ 真实思考块的误报率（要求 0 误报） |
| 计划/评分判定 | `work/n9-scan-probe.mjs` | 全量判定分布 |
| 守卫线上形态 | `work/ag-live-fingerprint.mjs` | 重启后活代码核验（14 项 + 三组指纹） |

两条元规则：

1. **断言"某文案不出现"之前，先确认那条渲染路径真的被走到**（否则是"假通过"）；
2. 结论要有证据；拿不到的就写"不知道"，不确定就写"无法判断"。

## 4. 发布前检查清单

```powershell
.\test-all.ps1                  # 1) 五套自测 0 失败
node tools\make-release.mjs     # 2) 组装脱敏产物 + 身份闸门（0 命中才放行）
# 3) 对 npm 包形态跑生态审计（第三方标准，需联网）
cd <TOOLS>\DSH\留档\attention-health-release-<日期>
npm pack
tar -xzf dsh-attention-health-*.tgz -C <临时目录>
cd <临时目录>\package; npx dsh-vet .     # 期望 grade A
```

**要扫 npm 包，不要扫仓库根**：仓库里的 `test/` `tools/` 会引入与包无关的告警
（`obf.dynamic-require`、大批 `unreachable-files` 假告警）。

CI（`.github/workflows/ci.yml`）在公开仓库上自动跑同样四件事：语法检查、身份闸门、
五套自测（合成语料 715 项）、dsh-vet（A 级门）。推送后看一眼 Actions 结果即可。

### npm 发布（需人工登录）

```powershell
cd <脱敏产物目录>
.\tools\npm-publish.ps1              # 只检查：打包 + 解包 + 身份扫描
.\tools\npm-publish.ps1 -Publish     # 检查通过才真的 npm publish（需先 npm login）
```

⚠️ **铁律：npm 只能从脱敏产物打包**。在开发仓库直接 `npm pack` / `npm publish`
会命中真实会话 ID 与本机路径（实测 14 处 / 6 文件），`tools/npm-publish.ps1` 的闸门
会拦下这种操作。

## 5. 安装 / 换机

```powershell
.\install-package.ps1     # 打包（tgz 落在 <TOOLS>\DSH\留档\attention-health-pkg\）+ 装进 profile
.\restart-attention-health.ps1   # 改 host 半后重启 + 14 项运行时验证
```

- 线上形态是**标准插件包**（`$DSH_HOME\profiles\web\node_modules\dsh-attention-health`），
  **改 `lib/` 不会自动同步** —— 必须重新 install；
- 只改 `lib/client.js` 不需要重启，刷新页面即可；
- `deploy.ps1` 已退役为回退工具（检测到标准安装会拒绝运行），回退流程见 `AGENTS.md` §1；
- tgz 目录是**稳定目录**（profile 里记的是这个路径），别放进会被清理的临时目录。

## 6. 常见坑（速查）

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 测试测的不是线上那份 | 直接 `node test/xxx.mjs`，环境变量未设 | 用 `.\test-all.ps1` 或显式设 `DSH_ATTENTION_HEALTH_DIR` |
| `ERR_PNPM_ADDING_TO_ROOT` | `add` 少了 `-w` | `dsh plugin --profile web add -w <tgz>` |
| `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF` | 用错 pnpm 主版本 | 用与 profile 一致的 pnpm 11 |
| 组合 URL 里漏检 client bundle | 正则只认 `/pkg/client.js` | 组合 URL 是 `/plugins/??a/client.js&b/client.js`，第二条前是 `&` |
| 新克隆上两套测试崩 | `work/` 不在版本控制里（已修：测试自建） | 见 `tools/make-test-fixture.mjs` |

## 7. 相关

- 架构与判定链：`docs/architecture.md`
- 隐私与发布脱敏：`docs/privacy.md`
