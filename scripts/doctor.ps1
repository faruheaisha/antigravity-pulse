param(
    [switch]$NonInteractive,
    [switch]$Json
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $Json) {
    try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter 6 项健康诊断工具' } catch {}
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host '   Antigravity TokenMeter 6 项内嵌与 Sidecar 健康诊断' -ForegroundColor Cyan
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host ''
}

$HomeDir = if ($env:AG_TEST_HOME) { $env:AG_TEST_HOME } else { $env:USERPROFILE }
$AppDataDir = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HomeDir 'AppData\Roaming' }
$LocalDir = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HomeDir 'AppData\Local' }

$PluginDir = Join-Path $HomeDir '.gemini\config\plugins\antigravity-token-meter'
$ConfigFile = Join-Path $HomeDir '.gemini\config\config.json'
$SettingsFile = Join-Path $LocalDir 'AntigravityTokenMeter\settings.json'
$ActivePortFile = Join-Path $AppDataDir 'Antigravity\DevToolsActivePort'
$StatusFile = Join-Path $HomeDir '.gemini\antigravity\sidecar_data\antigravity-token-meter\meter\data\integration-status.json'

$checks = @()
$failCount = 0

function Add-Check([string]$id, [string]$status, [string]$detail, [string]$hint = '') {
    $script:checks += [PSCustomObject]@{ id = $id; status = $status; detail = $detail; hint = $hint }
    if ($status -eq 'fail') { $script:failCount++ }
    if (-not $Json) {
        $color = switch ($status) { 'pass' { 'Green' } 'warn' { 'Yellow' } default { 'Red' } }
        Write-Host ("[$($status.ToUpper())] $id - $detail") -ForegroundColor $color
        if ($hint) { Write-Host ("       修复建议: $hint") -ForegroundColor Yellow }
    }
}

# 1. 插件包完整性（含 LICENSE）
$pkgOk = (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\main.mjs') -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $PluginDir 'plugin.json') -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $PluginDir 'LICENSE') -PathType Leaf)
if ($pkgOk) { Add-Check '1/6 插件文件' 'pass' '插件核心文件与 MIT LICENSE 完整' }
else { Add-Check '1/6 插件文件' 'fail' '插件目录缺失关键文件' '请先双击「一键安装插件(Windows双击运行).bat」重新部署。' }

# 2 & 3. 分别校验 plugin 启用与 sidecar 启用（P0-01 关键区分）
$pluginEnabled = $false
$sidecarEnabled = $false
if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
    try {
        $cfg = ([System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        if ($cfg.plugins.'antigravity-token-meter'.enabled -eq $true) { $pluginEnabled = $true }
        if ($cfg.sidecars.'antigravity-token-meter/meter'.enabled -eq $true) { $sidecarEnabled = $true }
    } catch {}
}
if ($pluginEnabled) { Add-Check '2/6 插件注册' 'pass' 'config.json 已启用 plugins.antigravity-token-meter' }
else { Add-Check '2/6 插件注册' 'fail' 'config.json 中插件未启用' '彻底退出 Antigravity 后重新运行安装器。' }

if ($sidecarEnabled) { Add-Check '3/6 Sidecar 启用' 'pass' 'config.json 已启用 sidecars["antigravity-token-meter/meter"]' }
else { Add-Check '3/6 Sidecar 启用' 'fail' 'config.json 未启用 sidecar 进程' '彻底退出 Antigravity 后运行新版安装器补齐 sidecars 启用项。' }

# 读取实验内嵌开关
$inlineWanted = $false
if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
    try {
        $stSet = ([System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        if ($stSet.inline -eq $true) { $inlineWanted = $true }
    } catch {}
}

# 4. 运行中主进程检查
$guiProcs = @()
try {
    $guiProcs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop | Where-Object {
        $_.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--type='
    })
} catch {
    Add-Check '4/6 主进程参数' 'fail' '无法查询本机进程列表（可能权限不足）'
}

if ($guiProcs.Count -eq 0) {
    Add-Check '4/6 主进程参数' 'warn' '未检测到运行中的 Antigravity 主界面' '请双击「启动Antigravity(带Token监控).bat」启动客户端。'
} elseif ($guiProcs | Where-Object { $_.CommandLine -match '(?:^|\s)--remote-debugging-port=\d+' }) {
    Add-Check '4/6 主进程参数' 'pass' 'Antigravity 主进程已携带 --remote-debugging-port 启动参数'
} elseif (-not $inlineWanted) {
    Add-Check '4/6 主进程参数' 'pass' '当前为纯侧边栏模式（未开启实验内嵌，无需调试端口）'
} else {
    Add-Check '4/6 主进程参数' 'fail' 'Antigravity 主进程未携带 --remote-debugging-port=0' '请右键系统托盘彻底退出 Antigravity，再用「启动Antigravity(带Token监控).bat」启动。'
}

# 5. DevToolsActivePort 严格端口校验与无代理/禁重定向连通性
if (-not $inlineWanted) {
    Add-Check '5/6 本地调试端口' 'pass' '纯侧边栏模式跳过 CDP 端口检测'
} elseif (Test-Path -LiteralPath $ActivePortFile -PathType Leaf) {
    try {
        $lines = Get-Content -LiteralPath $ActivePortFile -ErrorAction Stop
        $portStr = if ($lines.Count -gt 0) { [string]$lines[0] } else { '' }
        $portStr = $portStr.Trim()
        if ($portStr -notmatch '^[1-9]\d{0,4}$' -or [int]$portStr -gt 65535) {
            throw '端口文件首行不是合法十进制端口'
        }
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$portStr/json/list")
        $req.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $req.AllowAutoRedirect = $false
        $req.Timeout = 2500
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        if ($code -eq 200) { Add-Check '5/6 本地调试端口' 'pass' 'DevToolsActivePort 存在且本地 CDP 列表可连通' }
        else { Add-Check '5/6 本地调试端口' 'fail' "CDP 返回异常状态码 HTTP $code" }
    } catch {
        Add-Check '5/6 本地调试端口' 'fail' 'DevToolsActivePort 端口无效或不可达（可能为过期文件）' '请彻底退出 Antigravity 后通过专用启动器重新打开。'
    }
} else {
    Add-Check '5/6 本地调试端口' 'fail' '未检测到 DevToolsActivePort 文件' '请确认彻底退出托盘残留后使用带 --remote-debugging-port=0 的启动器。'
}

# 6. 活实例 sidecar 与最新挂载状态核验（防旧文件假绿灯）
if (Test-Path -LiteralPath $StatusFile -PathType Leaf) {
    try {
        $st = ([System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
        $pidAlive = $false
        if ($st.pid) {
            $pidAlive = $null -ne (Get-Process -Id ([int]$st.pid) -ErrorAction SilentlyContinue)
        }
        $ageSec = 99999
        if ($st.checkedAt) {
            $ageSec = [Math]::Abs(([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($st.checkedAt)).TotalSeconds)
        }
        if (-not $pidAlive -or $ageSec -gt 30) {
            Add-Check '6/6 运行实例与挂载' 'fail' '状态文件已过期或对应 sidecar 进程未运行' '请确认客户端已完全重启并在 Customizations 中开启 TokenMeter。'
        } elseif ($st.state -eq 'mounted') {
            Add-Check '6/6 运行实例与挂载' 'pass' "sidecar 存活且底部状态条已挂载 (windows=$($st.windows))"
        } elseif ($st.state -eq 'waiting_composer') {
            Add-Check '6/6 运行实例与挂载' 'warn' 'sidecar 已连上主窗口，打开任意对话后将自动显示底部状态条'
        } elseif (-not $inlineWanted -and $st.state -eq 'disabled') {
            Add-Check '6/6 运行实例与挂载' 'pass' 'sidecar 存活（纯侧边栏模式运行中）'
        } else {
            Add-Check '6/6 运行实例与挂载' 'fail' "sidecar 存活但未挂载: state=$($st.state), code=$($st.code)"
        }
    } catch {
        Add-Check '6/6 运行实例与挂载' 'fail' 'integration-status.json 解析失败'
    }
} else {
    Add-Check '6/6 运行实例与挂载' 'fail' '尚未检测到 TokenMeter sidecar 运行状态文件' '请确认第 2、3 项已通过并已重启 Antigravity。'
}

if ($Json) {
    [PSCustomObject]@{ ok = ($failCount -eq 0); failures = $failCount; checks = $checks } | ConvertTo-Json -Depth 6
} else {
    Write-Host ''
    if ($failCount -eq 0) {
        Write-Host '全部关键诊断项通过！' -ForegroundColor Green
    } else {
        Write-Host "发现 $failCount 项异常，请按上方提示修复后重试。" -ForegroundColor Yellow
    }
    Write-Host ''
    if (-not $NonInteractive) { Read-Host '按回车键关闭窗口' }
}

if ($failCount -gt 0) { exit 1 } else { exit 0 }
