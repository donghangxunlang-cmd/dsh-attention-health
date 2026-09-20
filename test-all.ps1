# test-all.ps1 —— 五套自测的统一入口（2026-09-20 门 3 之后新增）
#
# 为什么需要它：门 3 把线上形态换成了**标准插件包**（`profiles\web\node_modules\dsh-attention-health`），
# 于是 `deploy.ps1` 不再是日常工具（它部署的是旧形态挂载线，已加自保会拒绝运行）。
# 自测仍然每天要跑，这个脚本只管一件事：**把五套自测指向正确的那一份代码**。
#
# 它自己判断被测目标（并把结果显示出来 —— "测的是哪一份"比"全绿"更重要）：
#   1. `profiles\web\node_modules\dsh-attention-health`（标准安装，**当前线上形态**）
#   2. 否则回落到旧形态部署目录 `profiles\web\attention-health`（过渡/回退期）
#   3. 都找不到 → 用测试自带的源码回退路径（会打印警告）
#
# 用法：
#   .\test-all.ps1
#   .\test-all.ps1 -Dir <host 半目录> -UiDir <UI 包目录>    # 指定任意一份（如临时 profile 的安装）
#
# 判据与 deploy.ps1 一致：**统计行的失败数为 0**（不硬编码总数，补测试不必改这里）。

[CmdletBinding()]
param(
    [string]$Dir,
    [string]$UiDir
)

$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

function Resolve-NodeExe {
    foreach ($c in @(
            $env:DSH_NODE_EXE,
            '<TOOLS>\scripts\nodejs\node.exe',
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
        )) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw '找不到 node.exe（可设 $env:DSH_NODE_EXE 指定）'
}
$nodeExe = Resolve-NodeExe

$script:fails = 0
function Ok   ([string]$m) { Write-Host "   [OK]   $m" -ForegroundColor Green }
function Bad  ([string]$m) { Write-Host "   [FAIL] $m" -ForegroundColor Red; $script:fails++ }
function Say  ([string]$m) { Write-Host $m }

if (-not $Dir) {
    $std = Join-Path $dshHome 'profiles\web\node_modules\dsh-attention-health'
    $legacy = Join-Path $dshHome 'profiles\web\attention-health'
    if (Test-Path -LiteralPath (Join-Path $std 'lib\index.js')) {
        $Dir = Join-Path $std 'lib'
        $UiDir = $std
        Say '被测形态：标准插件包（profiles\web\node_modules\dsh-attention-health）'
    } elseif (Test-Path -LiteralPath (Join-Path $legacy 'index.js')) {
        Say '被测形态：旧形态部署目录（profiles\web\attention-health）'
        Say '  ⚠️ 这是过渡/回退形态；门 3 之后线上应是标准包。'
    } else {
        Say '⚠️ 两种部署位置都不存在 —— 测试会回退到源码路径（结果不能代表线上）。'
    }
}

if ($Dir) {
    $env:DSH_ATTENTION_HEALTH_DIR = $Dir
    Say ("  host 半：{0}" -f $Dir)
}
if ($UiDir) {
    $env:DSH_ATTENTION_HEALTH_UI_DIR = $UiDir
    Say ("  UI 包： {0}" -f $UiDir)
}

$cases = @(
    @{ file = 'test\plugin-test.mjs';     label = 'host 插件测试' },
    @{ file = 'test\ui-build-test.mjs';   label = 'UI 包测试' },
    @{ file = 'test\handoff-test.mjs';    label = '交接提炼测试' },
    @{ file = 'test\guard-test.mjs';      label = '思考守卫测试' },
    @{ file = 'test\crosscheck-test.mjs'; label = '多路交叉验证' }
)
$tmpDir  = if ($env:TEMP) { $env:TEMP } else { $dshHome }
# ⚠️ 临时文件名必须**每次不同**：固定名 `ah-test-run.log` 在一次跑动被中断/杀进程后
# 可能仍被占用，下一次直接 `IOException: being used by another process`（2026-09-20 实测）。
$runTag  = '{0}-{1}' -f $PID, ([guid]::NewGuid().ToString('N').Substring(0, 6))
$total   = 0

foreach ($c in $cases) {
    $path = Join-Path $root $c.file
    if (-not (Test-Path -LiteralPath $path)) { Bad "$($c.label)：找不到 $path"; continue }
    $tmpFile = Join-Path $tmpDir ("ah-test-run-$runTag.log")

    # node 会往 stderr 写插件的 console.error 日志；本脚本是 Stop 策略，
    # native 命令的 stderr 会被提升为终止错误 —— 把所有流落进临时文件再读。
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $nodeExe $path *> $tmpFile
        $code = $LASTEXITCODE
        $out  = if (Test-Path -LiteralPath $tmpFile) { Get-Content -LiteralPath $tmpFile -Raw -Encoding UTF8 } else { '' }
    } finally {
        $ErrorActionPreference = $saved
    }
    Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue

    $sm     = [regex]::Match($out, '结果：\s*(\d+) 通过 / (\d+) 失败')
    $passed = if ($sm.Success) { [int]$sm.Groups[1].Value } else { -1 }
    $failed = if ($sm.Success) { [int]$sm.Groups[2].Value } else { -1 }
    if ($code -eq 0 -and $sm.Success -and $failed -eq 0) {
        Ok ("{0}：{1} 通过 / 0 失败" -f $c.label, $passed)
        $total += $passed
    } else {
        Bad ("{0} 未通过（exit={1}；{2}）" -f $c.label, $code, $(if ($sm.Success) { "$passed 通过 / $failed 失败" } else { '未解析到统计行' }))
        ($out -split "`r?`n" | Where-Object { $_ -match '❌|结果：' }) | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
    }
}

Say ''
if ($script:fails -eq 0) {
    Write-Host ("五套自测全部通过：{0} 项。" -f $total) -ForegroundColor Green
} else {
    Write-Host ("自测存在 {0} 个问题。" -f $script:fails) -ForegroundColor Red
}
exit ([int]($script:fails -gt 0))
