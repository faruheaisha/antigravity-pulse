param(
    [switch]$NonInteractive,
    [switch]$PurgeData
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter 卸载工具' } catch {}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   Antigravity TokenMeter 反向事务卸载程序' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

$HomeDir   = if ($env:AG_TEST_HOME) { $env:AG_TEST_HOME } else { $env:USERPROFILE }
if (-not $HomeDir) { $HomeDir = [Environment]::GetFolderPath('UserProfile') }
$LocalDir  = if ($env:AG_TEST_LOCAL) { $env:AG_TEST_LOCAL } else { $env:LOCALAPPDATA }
if (-not $LocalDir) { $LocalDir = Join-Path $HomeDir 'AppData\Local' }

$DstPlugin   = Join-Path $HomeDir '.gemini\config\plugins\antigravity-token-meter'
$ConfigFile  = Join-Path $HomeDir '.gemini\config\config.json'
$ConfigDir   = Join-Path $LocalDir 'AntigravityTokenMeter'
$SidecarData = Join-Path $HomeDir '.gemini\antigravity\sidecar_data\antigravity-token-meter'
$Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)

if (-not $NonInteractive) {
    $confirm = Read-Host '确认要卸载 Antigravity TokenMeter 吗？(输入 Y 确认，其他键取消)'
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host '已取消卸载。' -ForegroundColor Yellow
        exit 0
    }
}

# 1. 先检查主进程是否已退出（运行中拒绝改写配置以防被客户端退出时覆盖）
if (-not $env:AG_TEST_HOME) {
    $guiProcs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop | Where-Object {
        $_.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--type='
    })
    if ($guiProcs.Count -gt 0) {
        Write-Host '[错误] 检测到 Antigravity 主界面正在运行，请先彻底退出客户端后再执行卸载。' -ForegroundColor Red
        if (-not $NonInteractive) { Read-Host '按回车键退出' }
        exit 3
    }
}

# 2. 先备份再从 config.json 中原子移除本插件与 sidecar 注册项（失败即中止）
if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
    $raw = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $parsed = $raw | ConvertFrom-Json
    if (-not ($parsed -is [PSCustomObject])) {
        Write-Host '[错误] config.json 根节点格式异常，已中止卸载（未改动原文件）。' -ForegroundColor Red
        exit 4
    }
    $cfgBakDir = Join-Path $ConfigDir 'config-backups'
    New-Item -ItemType Directory -Path $cfgBakDir -Force | Out-Null
    $randTag = [guid]::NewGuid().ToString('N').Substring(0,8)
    Copy-Item -LiteralPath $ConfigFile -Destination (Join-Path $cfgBakDir ('config-uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randTag + '.json'))

    $cfg = [ordered]@{}
    foreach ($p in $parsed.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    if ($cfg.Contains('plugins') -and ($cfg['plugins'] -is [PSCustomObject])) {
        $pm = [ordered]@{}
        foreach ($p in $cfg['plugins'].PSObject.Properties) {
            if ($p.Name -ne 'antigravity-token-meter') { $pm[$p.Name] = $p.Value }
        }
        $cfg['plugins'] = $pm
    }
    if ($cfg.Contains('sidecars') -and ($cfg['sidecars'] -is [PSCustomObject])) {
        $sm = [ordered]@{}
        foreach ($p in $cfg['sidecars'].PSObject.Properties) {
            if ($p.Name -ne 'antigravity-token-meter/meter') { $sm[$p.Name] = $p.Value }
        }
        $cfg['sidecars'] = $sm
    }
    $tmp = Join-Path (Split-Path -Parent $ConfigFile) ('.tm-uninst-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    try {
        [System.IO.File]::WriteAllText($tmp, (($cfg | ConvertTo-Json -Depth 100) + "`n"), $Utf8NoBom)
        [System.IO.File]::Replace($tmp, $ConfigFile, [NullString]::Value, $true)
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
    Write-Host '[已清理] 已从 config.json 移除 TokenMeter 插件与 sidecar 注册项。' -ForegroundColor Green
}

# 3. 清理运行状态文件、临时租约与插件目录
foreach ($runtimeFile in @(
    (Join-Path $SidecarData 'meter\data\integration-status.json'),
    (Join-Path $SidecarData 'meter\data\owner-lease.json'),
    (Join-Path $SidecarData 'meter\data\pending-import.json')
)) {
    if (Test-Path -LiteralPath $runtimeFile) {
        Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
    }
}
$pluginsRoot = Split-Path -Parent $DstPlugin
if (Test-Path -LiteralPath $pluginsRoot -PathType Container) {
    Get-ChildItem -LiteralPath $pluginsRoot -Directory -Filter '.antigravity-token-meter-prev-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (Test-Path -LiteralPath $DstPlugin) {
    Remove-Item -LiteralPath $DstPlugin -Recurse -Force
    Write-Host ('[已移除] ' + $DstPlugin) -ForegroundColor Green
} else {
    Write-Host '[提示] 插件目录不存在，无需删除。' -ForegroundColor Gray
}

# 4. 可选清除偏好与历史账本（默认保留历史账本）
$shouldPurge = $PurgeData
if (-not $shouldPurge -and -not $NonInteractive -and ((Test-Path -LiteralPath $ConfigDir) -or (Test-Path -LiteralPath $SidecarData))) {
    $ans = Read-Host '是否同时清除本地偏好配置与历史 Token 账本？(Y/N，默认 N 保留历史记录)'
    if ($ans -match '^[Yy]$') { $shouldPurge = $true }
}
if ($shouldPurge) {
    if (Test-Path -LiteralPath $ConfigDir) { Remove-Item -LiteralPath $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $SidecarData) { Remove-Item -LiteralPath $SidecarData -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host '[已清理] 已移除本地偏好与历史账本数据。' -ForegroundColor Green
}

Write-Host ''
Write-Host '[完成] 卸载完毕！如 Antigravity 正在运行，完全重启一次即可生效。' -ForegroundColor Green
if (-not $NonInteractive) { Read-Host '按回车键关闭窗口' }
