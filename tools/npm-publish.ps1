# npm-publish.ps1 —— 带**闸门**的 npm 发布（2026-09-20 AE/T6 补）
#
# 为什么需要它：`npm publish` **不走 git**，所以 pre-push 闸门管不到它。
# 而实测对比很直接（同一台机器、同一份源码）：
#   · 在**脱敏产物目录**打包 → 扫描 0 命中；
#   · 在**开发仓**打包       → 13 处命中 / 6 个文件（lib/ 注释里的真实会话 ID、`<TOOLS>` 路径）。
# 也就是说"顺手在开发仓里 npm publish"会把 identity 直接发上 npm —— 而 git 那边看着一切正常。
#
# 因此本脚本把安全路径变成默认路径：**先打包 → 解包 → 扫描 → 0 命中才允许发布**。
#
# 用法：
#   .\tools\npm-publish.ps1                 # 只做检查（打包 + 扫描），打印发布命令
#   .\tools\npm-publish.ps1 -Publish        # 检查通过后真的执行 npm publish（需要先 npm login）
#   .\tools\npm-publish.ps1 -Dir <目录>      # 指定要发布的目录（默认：本脚本所在仓库根）
#
# ⚠️ 在开发仓里跑它会**被拦下**（那正是它的作用）；正式发布应在脱敏产物目录里跑。
# ⚠️ 需要 node 与 npm 能被找到：优先 `DSH_NODE_EXE` / `DSH_NPM_CMD`（或 `DSH_NODE_DIR`
#    指向同时含 node.exe 与 npm.cmd 的目录），其次 PATH。
#    （**不要**在本文件里写死本机工具目录 —— 公开产物会把它脱敏成占位符，脚本当场失效；
#     2026-09-22 实测踩到：发布产物里的本脚本报"找不到 npm.cmd"。）

[CmdletBinding()]
param(
    [string]$Dir,
    [switch]$Publish,
    [string]$DistTag
)

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $toolsDir
if (-not $Dir) { $Dir = $repoRoot }
if (-not (Test-Path -LiteralPath (Join-Path $Dir 'package.json'))) {
    throw "不是包目录（没有 package.json）：$Dir"
}

function Resolve-Exe {
    param([string[]]$Candidates, [string]$Name)
    foreach ($c in $Candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "找不到 $Name（可设环境变量指定，或把它加入 PATH）"
}

$node = Resolve-Exe @(
    $env:DSH_NODE_EXE,
    $(if ($env:DSH_NODE_DIR) { Join-Path $env:DSH_NODE_DIR 'node.exe' })
) 'node'
$npm = Resolve-Exe @(
    $env:DSH_NPM_CMD,
    $(if ($env:DSH_NODE_DIR) { Join-Path $env:DSH_NODE_DIR 'npm.cmd' })
) 'npm.cmd'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ah-npm-gate-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    Write-Host ''
    Write-Host '── 1/3 打包（在待发布目录里 npm pack）' -ForegroundColor Cyan
    Push-Location $Dir
    try {
        & $npm pack --pack-destination $tmp --silent | Out-Null
    } finally { Pop-Location }
    $tgz = Get-ChildItem $tmp -Filter '*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $tgz) { throw '打包失败：没有生成 tgz' }
    Write-Host ("   [OK]   {0}（{1:N0} KB）" -f $tgz.Name, ($tgz.Length / 1KB)) -ForegroundColor Green

    Write-Host ''
    Write-Host '── 2/3 解包 + 身份类扫描（闸门）' -ForegroundColor Cyan
    $ex = Join-Path $tmp 'package'
    New-Item -ItemType Directory -Force -Path $ex | Out-Null
    & tar.exe -xzf $tgz.FullName -C $tmp
    if (-not (Test-Path -LiteralPath $ex)) { throw '解包失败：没有 package 目录' }
    $files = (Get-ChildItem $ex -Recurse -File).Count
    & $node (Join-Path $toolsDir 'scan-identity.mjs') $ex
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host ("   [FAIL] 包里 {0} 个文件含身份类信息 —— **拒绝发布**。" -f $files) -ForegroundColor Red
        Write-Host '   正确做法：先在**脱敏产物目录**里出包（node tools/make-release.mjs），再在那里发布。' -ForegroundColor Yellow
        exit 1
    }
    Write-Host ("   [OK]   包内 {0} 个文件，身份类命中 0" -f $files) -ForegroundColor Green

    Write-Host ''
    Write-Host '── 3/3 发布' -ForegroundColor Cyan
    # ⚠️ 必须显式 UTF-8 读：本机 PowerShell 的 `Get-Content -Raw` 按 ANSI 解码，
    # 中文 description / author / 路径会变乱码，甚至把引号吃掉导致 JSON 解析失败（实测踩到）。
    $meta = [System.IO.File]::ReadAllText(
        (Join-Path $Dir 'package.json'),
        [System.Text.UTF8Encoding]::new($false)
    ) | ConvertFrom-Json
    $tagArg = if ($DistTag) { @('--tag', $DistTag) } else { @() }
    if ($Publish) {
        & $npm publish $tgz.FullName '--access' 'public' @tagArg
        if ($LASTEXITCODE -ne 0) { throw "npm publish 失败（exit=$LASTEXITCODE）—— 是否已 npm login？" }
        Write-Host ("   [OK]   已发布 {0}@{1}" -f $meta.name, $meta.version) -ForegroundColor Green
    } else {
        Write-Host '   （未加 -Publish，只做了检查）真要发布请执行：'
        Write-Host ''
        Write-Host ("   cd `"{0}`"" -f $Dir)
        Write-Host ("   npm publish --access public{0}" -f $(if ($DistTag) { " --tag $DistTag" } else { '' }))
        Write-Host ''
        Write-Host '   （直接就 `npm publish` 即可：npm 会就地打包，而**这个目录**的包刚才已被证明 0 命中。'
        Write-Host '     上面那个临时 tgz 会在脚本结束时删除，别照抄它的路径。）'
        Write-Host '   前提：npm login（走你的 2FA）。发布后 72 小时内可以 unpublish。'
        Write-Host ("   包名/版本：{0}@{1}" -f $meta.name, $meta.version)
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
