# install-package.ps1 —— 把**当前源码**打成标准插件包并装进 profile（2026-09-20 门 3 之后新增）
#
# 为什么需要它：门 3 之后线上形态是**标准插件包**（`profiles\web\node_modules\dsh-attention-health`），
# 它由 pnpm 从 tgz 安装 —— 也就是说：
#
#   ⚠️ **改 `lib/` 里的源码不会自动影响线上**（旧形态时 `deploy.ps1` 一对拷就同步了）。
#      必须「重新打包 → 重新安装 → 重启（host 改动）」，本脚本把前两步合成一条命令。
#
# 用法：
#   .\install-package.ps1                     # 打包 + 装进 profiles\web（线上 profile）
#   .\install-package.ps1 -Profile ah-exp     # 装进别的 profile（实验用）
#   .\install-package.ps1 -NoInstall          # 只打包，不动任何 profile
#   .\install-package.ps1 -PkgDir <目录>      # 指定 tgz 落地目录（默认见下）
#
# 落地位置（按优先级）：`-PkgDir` 参数 → `$env:DSH_ATTENTION_HEALTH_PKG_DIR` →
# `<DSH_HOME>\attention-health-pkg`。⚠️ **必须是稳定目录** —— profile 的 package.json 里
# 记的是这个 tgz 的路径，放进"临时"目录被清理后再 install 会找不到。
#
# 工具定位（**本文件不得写死本机路径**：公开产物会把本机路径脱敏成占位符 → 脚本失效）：
#   · node：`DSH_NODE_EXE` → `DSH_NODE_DIR\node.exe` → Program Files / LOCALAPPDATA → PATH
#   · pnpm：`DSH_NODE_DIR` 前置到 PATH 后从 PATH 找（也可全局装 pnpm 11）
#   · dsh  ：`DSH_BIN`（bin.js 全路径）→ `%APPDATA%\npm\...\dsh\lib\bin.js` → PATH 里的 dsh shim

[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$PkgDir,
    [switch]$NoInstall,
    [switch]$SkipPack
)

$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

# ── 工具位置（与 deploy.ps1 同一套探测顺序）─────────────────────────────────
$nodeDir = $env:DSH_NODE_DIR
# 最后一档兜底（2026-09-22 开发侧 review 补）：本进程若由 node 启动（最典型就是在 DSH 的
# pwsh 工具里跑），父进程的可执行文件就是现成可用的 node。理由与 `test-all.ps1` 同一份：
# 用户级环境变量要"新开终端"才生效，而 DSH 是长驻进程，它 spawn 的 pwsh 拿到的是启动时的
# 环境快照；从父进程推导既不写死本机路径（写死的会被脱敏成 `<TOOLS>`），也不依赖本机约定。
function Get-ParentNodeExe {
    try {
        $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop
        if (-not $me) { return $null }
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $me.ParentProcessId) -ErrorAction Stop
        if ($parent -and $parent.Name -eq 'node.exe' -and $parent.ExecutablePath -and
            (Test-Path -LiteralPath $parent.ExecutablePath)) {
            return $parent.ExecutablePath
        }
    } catch {
        # WMI 不可用 → 静默跳过
    }
    return $null
}

function Resolve-NodeExe {
    foreach ($c in @(
            $env:DSH_NODE_EXE,
            $(if ($nodeDir) { Join-Path $nodeDir 'node.exe' }),
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
        )) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fromParent = Get-ParentNodeExe
    if ($fromParent) { return $fromParent }
    throw '找不到 node.exe（可设 $env:DSH_NODE_EXE 或 $env:DSH_NODE_DIR 指定）'
}
# dsh 入口的最后一档兜底（2026-09-22 开发侧 review 补）：DSH 是用
# `@deepseek-ai/dsh-subprocess-local` 的 `runner.js` 启动子进程的 —— 从**父进程命令行**里
# 那个 runner.js 的路径，就能推出同一个 `node_modules` 树里的 dsh 入口。
# 于是在 DSH 的 pwsh 工具里跑本脚本**不需要任何环境变量**，也不必写死任何本机路径。
function Get-DshBinFromAncestors {
    try {
        $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop
        if (-not $me) { return $null }
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $me.ParentProcessId) -ErrorAction Stop
        if (-not $parent) { return $null }
        # ⚠️ 按 **token** 切分后逐段判断，**不要**用"从字符串开头非贪婪匹配路径"的正则 ——
        # 后者会把 `node.exe` 那一段也吞进同一个匹配（实测踩到：组 1 变成
        # `…\nodejs\node.exe …\dsh-official`，推导出的路径根本不存在，于是这一档静默失效）。
        $suffix = '\node_modules\@deepseek-ai\dsh-subprocess-local\lib\runner.js'
        foreach ($tok in ([string]$parent.CommandLine -replace '"', '' -split '\s+')) {
            if ($tok.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $root = $tok.Substring(0, $tok.Length - $suffix.Length)
                $guess = Join-Path $root 'node_modules\@deepseek-ai\dsh\lib\bin.js'
                if (Test-Path -LiteralPath $guess) { return $guess }
            }
        }
    } catch {
        # WMI 不可用 → 静默跳过
    }
    return $null
}

function Resolve-DshBin {
    foreach ($c in @(
            $env:DSH_BIN,
            (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js')
        )) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    # PATH 里的 dsh shim → 推导同级的 bin.js
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) {
        $guess = Join-Path (Split-Path -Parent $cmd.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path -LiteralPath $guess) { return $guess }
    }
    $fromParent = Get-DshBinFromAncestors
    if ($fromParent) { return $fromParent }
    throw '找不到 dsh 的 bin.js（可设 $env:DSH_BIN 指定，或把 dsh 加入 PATH）'
}
$nodeExe = Resolve-NodeExe
$dshBin  = Resolve-DshBin

# `$nodeDir` 来自环境变量，可能为空（例如在 DSH 会话里用户级变量还没生效）。
# 此时从**最终解析到的 node.exe** 反推它的目录 —— `pnpm.cmd` / `npm.cmd` 都是它的
# **同目录伙伴**，所以"父进程兜底找到 node"的场景也能顺带找到 pnpm（2026-09-22 review 补）。
if (-not $nodeDir -and $nodeExe) { $nodeDir = Split-Path -Parent $nodeExe }

# pnpm 必须能被 `dsh plugin` 的子进程找到 → 本进程临时前置 node 目录（不永久改系统 PATH）
if (Test-Path -LiteralPath (Join-Path $nodeDir 'pnpm.cmd')) {
    $env:PATH = "$nodeDir;$env:PATH"
}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) { throw '找不到 pnpm（可设 $env:DSH_NODE_DIR 指向含 pnpm.cmd 的目录，或先 npm i -g pnpm@11）' }

$pkgOut = if ($PkgDir) { $PkgDir }
elseif ($env:DSH_ATTENTION_HEALTH_PKG_DIR) { $env:DSH_ATTENTION_HEALTH_PKG_DIR }
else { Join-Path $dshHome 'attention-health-pkg' }
# 精确的 C 盘防御（2026-09-22 review 补）：兜底目录跟着 `$DSH_HOME`，而本机 `$DSH_HOME` 就在
# C 盘 —— 一旦环境变量没生效（例如在 DSH 会话里），产物就会安静地落进 C 盘，
# 既违反"产物不进 C 盘"的约定，又会**换掉 profile 记住的那个稳定路径**（换位置后再 install 找不到）。
if ($pkgOut -match '^[Cc]:') {
    Write-Warning ("产物目录落在 C 盘（{0}）。本项目约定产物不进 C 盘，且 profile 里记的就是这个路径 —— 请用 -PkgDir 或环境变量 DSH_ATTENTION_HEALTH_PKG_DIR 指到一个稳定目录。" -f $pkgOut)
}
New-Item -ItemType Directory -Force -Path $pkgOut | Out-Null

Write-Host ''
Write-Host '── 1/3 打包（pnpm pack）' -ForegroundColor Cyan
$tgz = ''
if ($SkipPack) {
    $tgz = (Get-ChildItem $pkgOut -Filter 'dsh-attention-health-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    if (-not $tgz) { throw "跳过打包但 $pkgOut 里没有现成的 tgz" }
    Write-Host ("   [SKIP] 复用现有包：{0}" -f $tgz)
} else {
    Remove-Item (Join-Path $pkgOut '*.tgz') -Force -ErrorAction SilentlyContinue
    Push-Location $root
    try { & pnpm pack --pack-destination $pkgOut | Out-Null } finally { Pop-Location }
    $tgz = (Get-ChildItem $pkgOut -Filter 'dsh-attention-health-*.tgz' | Select-Object -First 1).FullName
    if (-not $tgz) { throw '打包失败：没找到 tgz' }
    $kb = [math]::Round((Get-Item -LiteralPath $tgz).Length / 1KB)
    Write-Host ("   [OK]   {0}（{1} KB）" -f $tgz, $kb) -ForegroundColor Green
}

if ($NoInstall) {
    Write-Host ''
    Write-Host '── 2/3 安装：已跳过（-NoInstall）' -ForegroundColor Yellow
    Write-Host '── 3/3 完成'
    exit 0
}

Write-Host ''
Write-Host ("── 2/3 装进 profile：{0}" -f $Profile) -ForegroundColor Cyan
Write-Host '   （pnpm 11 才能匹配 profile 里 .modules.yaml 记录的布局；-w 是因为 profile 自身是 workspace 根）'
# ⚠️ **必须先 remove 再 add**（2026-09-20 实测踩到）：版本号不变而 tgz 内容变了时，
# pnpm 会说 "Already up to date" 并把**旧内容**留在 node_modules 里 —— 于是
# "我改了源码、也跑了安装脚本"与"线上其实还是旧的"同时成立（AD 修复后五套自测全红才发现）。
& $nodeExe $dshBin plugin --profile $Profile remove -w dsh-attention-health 2>&1 | Out-Null
& $nodeExe $dshBin plugin --profile $Profile add -w $tgz --registry=https://registry.npmmirror.com
if ($LASTEXITCODE -ne 0) { throw "安装失败（exit=$LASTEXITCODE）" }

$manifest = Join-Path $dshHome "profiles\$Profile\package.json"
# ⚠️ 显式 UTF-8 读（`Get-Content -Raw` 在本机按 ANSI 解码；profile 里的 `file:` 路径含中文目录名）
$json = [System.IO.File]::ReadAllText($manifest, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-attention-health') {
    throw "安装后 $Profile 的 dsh.profile.bundles 里没有 dsh-attention-health —— 包可能没声明 dsh.bundle.patch"
}
Write-Host ("   [OK]   层栈：{0}" -f ($bundles -join ' → ')) -ForegroundColor Green

Write-Host ''
Write-Host '── 3/3 核对：装进去的就是当前源码（lib/ 逐个 sha256）' -ForegroundColor Cyan
$instLib = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-attention-health\lib"
$mismatch = @()
foreach ($f in Get-ChildItem (Join-Path $root 'lib') -File) {
    $dst = Join-Path $instLib $f.Name
    if (-not (Test-Path -LiteralPath $dst)) { $mismatch += "$($f.Name)（缺失）"; continue }
    $a = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    $b = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
    if ($a -ne $b) { $mismatch += "$($f.Name)（内容不同）" }
}
if ($mismatch.Count -gt 0) {
    Write-Host ("   [FAIL] 有 {0} 个文件与源码不一致：{1}" -f $mismatch.Count, ($mismatch -join '、')) -ForegroundColor Red
    throw '安装内容与当前源码不一致 —— 不要继续（否则测/用到的都不是你刚改的代码）'
}
Write-Host ("   [OK]   lib/ 全部 {0} 个文件与当前源码一致" -f (Get-ChildItem (Join-Path $root 'lib') -File).Count) -ForegroundColor Green

Write-Host ''
Write-Host '── 4/4 下一步' -ForegroundColor Cyan
Write-Host '   · host 半（lib\*.js）改动 → 必须重启才生效： .\restart-attention-health.ps1'
Write-Host '   · 只有 client.js 改动 → 刷新页面即可'
Write-Host '   · 自测： .\test-all.ps1'
