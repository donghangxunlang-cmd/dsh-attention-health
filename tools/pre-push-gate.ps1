# pre-push-gate.ps1 —— 推送前的身份类闸门（2026-09-20，AE 节）
#
# 背景：2026-09-20 那次推送把**开发档案本体**推上了 GitHub（133 处身份类信息），
# 根因是"推送路径绕过了 make-release.mjs 的脱敏设计"。本脚本把同一把闸门装到
# **推送那一刻**：扫描**将要推送的提交内容**（`git archive HEAD`），有命中就拒绝。
#
# 装法（两步，第二步不进库）：
#   1. 本文件随仓库一起公开（tools/pre-push-gate.ps1）；
#   2. 在本机 .git/hooks/pre-push 里调用它 —— 该文件**不进库**，因此可以写本机 node 路径：
#
#        #!/bin/sh
#        cd "$(git rev-parse --show-toplevel)" || exit 2
#        DSH_NODE_EXE='<node.exe 的完整路径（正斜杠）>'
#        export DSH_NODE_EXE
#        exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools/pre-push-gate.ps1"
#
# ⚠️ 本文件会公开，**不得写任何本机路径**——写了会被 scan-identity 的 [tools-path]
#    规则命中，变成"闸门自己拦自己"（原报告 §9.3 实测踩过）。
# ⚠️ 存盘必须带 UTF-8 BOM（无 BOM 时 Windows PowerShell 按 GBK 解码中文注释会解析失败）。
#
# 用法：
#   .\tools\pre-push-gate.ps1                # 扫将要推送的提交（git archive HEAD）
#   .\tools\pre-push-gate.ps1 -Ref <ref>     # 指定 ref
#   .\tools\pre-push-gate.ps1 -Path <目录>   # 扫指定目录（手工用）
#   .\tools\pre-push-gate.ps1 -SelfTest      # 规则表自检
#
# 退出码：0 = 放行；1 = 有命中；2 = 用法/环境问题。

[CmdletBinding()]
param(
    [string]$Path,
    [string]$Ref = 'HEAD',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $toolsDir

# node：环境变量优先，其次常见安装位置与 PATH（本文件公开，不写本机路径）
$node = $null
foreach ($c in @($env:DSH_NODE_EXE, (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    Write-Host 'pre-push-gate: 找不到 node.exe（可设 $env:DSH_NODE_EXE）' -ForegroundColor Red
    exit 2
}

$scanner = Join-Path $toolsDir 'scan-identity.mjs'

if ($SelfTest) {
    & $node $scanner --selftest
    exit $LASTEXITCODE
}

if ($Path) {
    Write-Host ("pre-push-gate: 扫描目录 {0}" -f $Path)
    & $node $scanner $Path
    $code = $LASTEXITCODE
} else {
    # 默认：只扫**将要推送的提交内容**（= 推送的实际情况；work/ 等未跟踪目录不参与）
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-gate-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $tar = Join-Path $tmp 'head.tar'
        Push-Location $repoRoot
        try {
            & git archive -o $tar $Ref
            if ($LASTEXITCODE -ne 0) {
                Write-Host ("pre-push-gate: git archive 失败（{0}）" -f $Ref) -ForegroundColor Red
                exit 2
            }
            & tar -xf $tar -C $tmp
            if ($LASTEXITCODE -ne 0) {
                Write-Host 'pre-push-gate: 解包失败' -ForegroundColor Red
                exit 2
            }
        } finally { Pop-Location }
        Write-Host ("pre-push-gate: 扫描提交内容 {0}" -f $Ref)
        & $node $scanner $tmp
        $code = $LASTEXITCODE
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($code -eq 0) {
    Write-Host 'pre-push-gate: 放行（身份类命中 0）' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host 'pre-push-gate: **已拦下** —— 待推送内容里有身份类信息。' -ForegroundColor Red
    Write-Host '  修法：确认这些内容是否该公开；该公开的下游产物请用 `node tools/make-release.mjs` 生成。'
}
exit $code
