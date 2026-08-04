[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Action,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DriverArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { throw "agent-toolchain: $Message" }
function Note([string]$Message) { Write-Output "agent-toolchain: $Message" }

function Show-Usage {
  @'
Usage:
  agent-toolchain.ps1 configure --project PATH
  agent-toolchain.ps1 doctor --project PATH [--quick]
  agent-toolchain.ps1 bootstrap --project PATH --dry-run|--apply
  agent-toolchain.ps1 init-codegraph --project PATH
  agent-toolchain.ps1 maintain --project PATH [--sync]
  agent-toolchain.ps1 rollback rtk VERSION
'@ | Write-Output
}

if (-not $IsWindows) { Fail '此驱动仅适用于 Windows PowerShell 7；macOS/Linux 请使用 agent-toolchain.sh' }
if (-not [Environment]::Is64BitProcess) { Fail '需要 64 位 PowerShell 7' }

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) { Fail '无法确定 LocalApplicationData' }
$ToolchainHome = if ($env:AGENT_TOOLCHAIN_HOME) { $env:AGENT_TOOLCHAIN_HOME } else { Join-Path $localAppData 'agent-toolchain' }
$ToolchainBin = if ($env:AGENT_TOOLCHAIN_BIN) { $env:AGENT_TOOLCHAIN_BIN } else { Join-Path $ToolchainHome 'bin' }

$script:Project = $null
$script:Apply = $false
$script:DryRun = $false
$script:Quick = $false
$script:Sync = $false
$script:RollbackTool = $null
$script:RollbackVersion = $null
$script:PlatformName = $null
$script:Manifest = $null
$script:ConnectTimeout = $null
$script:RequestTimeout = $null
$script:DownloadProxy = $null
$script:DownloadProxySource = 'direct'

function Get-PlatformName {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($architecture) {
    'x64' { return 'win32-x64' }
    'arm64' { Fail 'Windows arm64 不受支持：RTK 0.44.1 没有官方 Windows arm64 发布资产，不能安装半套工具链' }
    default { Fail "不支持的 Windows 架构：$architecture" }
  }
}

function Parse-Arguments {
  $script:Action = if ($Action) { $Action } else { '' }
  $index = 0
  while ($index -lt $DriverArgs.Count) {
    $argument = $DriverArgs[$index]
    switch ($argument) {
      '--project' {
        if ($index + 1 -ge $DriverArgs.Count) { Fail '--project 缺少路径' }
        $script:Project = $DriverArgs[$index + 1]
        $index += 2
      }
      '--apply' { $script:Apply = $true; $index += 1 }
      '--dry-run' { $script:DryRun = $true; $index += 1 }
      '--quick' { $script:Quick = $true; $index += 1 }
      '--sync' { $script:Sync = $true; $index += 1 }
      'codegraph' { if ($script:Action -ne 'rollback') { Fail "未知参数：$argument" }; $script:RollbackTool = $argument; $index += 1 }
      'rtk' { if ($script:Action -ne 'rollback') { Fail "未知参数：$argument" }; $script:RollbackTool = $argument; $index += 1 }
      default {
        if ($script:Action -eq 'rollback' -and -not $script:RollbackVersion) {
          $script:RollbackVersion = $argument
          $index += 1
        } else {
          Fail "未知参数：$argument"
        }
      }
    }
  }
  if ($script:Quick -and $script:Action -ne 'doctor') { Fail '--quick 仅适用于 doctor' }
}

function Check-Project {
  if ([string]::IsNullOrWhiteSpace($script:Project)) { Fail '必须指定 --project' }
  if (-not (Test-Path -LiteralPath $script:Project -PathType Container)) { Fail "项目目录不存在：$script:Project" }
  $script:Project = (Resolve-Path -LiteralPath $script:Project).Path
}

function Assert-PlainFileOrAbsent([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer) { Fail "$Path 必须是普通文件" }
}

function Append-ProjectText([string]$Path, [string]$Text) {
  Assert-PlainFileOrAbsent $Path
  $prefix = if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path -Force).Length -gt 0) { "`r`n" } else { '' }
  [System.IO.File]::AppendAllText($Path, "$prefix$Text`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Get-TomlTableBody([string]$Path, [string]$Header) {
  $count = 0
  $active = $false
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -ceq $Header) {
      $count += 1
      if ($count -gt 1) { Fail "$Path 的 $Header 重复" }
      $active = $true
      continue
    }
    if ($active -and $line -match '^\[') { $active = $false }
    if ($active) { [void]$lines.Add($line) }
  }
  if ($count -ne 1) { Fail "$Path 缺少 $Header" }
  return ($lines -join "`n")
}

function Configure-Project {
  $codexDirectory = Join-Path $script:Project '.codex'
  $configPath = Join-Path $codexDirectory 'config.toml'
  $agentsPath = Join-Path $script:Project 'AGENTS.md'
  $ignorePath = Join-Path $script:Project '.gitignore'
  if (Test-Path -LiteralPath $codexDirectory) {
    $codexItem = Get-Item -LiteralPath $codexDirectory -Force
    if (($codexItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or -not $codexItem.PSIsContainer) { Fail '.codex 必须是非链接目录' }
  }
  Assert-PlainFileOrAbsent $configPath
  Assert-PlainFileOrAbsent $agentsPath
  Assert-PlainFileOrAbsent $ignorePath

  $needsConfig = $false; $needsAgents = $false; $needsToolErrorRule = $false; $needsIgnore = $false
  $toolErrorRule = '- 工具调用报错时，只有工具注册表或 `--help` 未列出目标命令，才可判定其不存在；否则不得归因于能力缺失。'
  $configText = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw } else { '' }
  if ($configText -match '(?m)^\[mcp_servers\.codegraph\]\s*$') {
    $mainBody = Get-TomlTableBody $configPath '[mcp_servers.codegraph]'
    $envBody = Get-TomlTableBody $configPath '[mcp_servers.codegraph.env]'
    if ($mainBody -notmatch '(?m)^command\s*=\s*"codegraph"\s*$' -or $mainBody -notmatch '(?m)^\s*"serve",\s*$' -or $mainBody -notmatch '(?m)^\s*"--mcp",\s*$' -or $envBody -notmatch '(?m)^CODEGRAPH_TELEMETRY\s*=\s*"0"\s*$' -or $envBody -notmatch '(?m)^CODEGRAPH_NO_UPDATE_CHECK\s*=\s*"1"\s*$' -or $envBody -notmatch '(?m)^DO_NOT_TRACK\s*=\s*"1"\s*$') { Fail '.codex/config.toml 的 CodeGraph 配置冲突' }
  } elseif ($configText -match '(?m)^\[mcp_servers\.codegraph\.') {
    Fail '.codex/config.toml 存在不完整的 CodeGraph 表'
  } else {
    $needsConfig = $true
  }

  $agentsText = if (Test-Path -LiteralPath $agentsPath) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
  if ($agentsText -match '(?m)^## AI 工具\s*$') {
    if (-not $agentsText.Contains('$agent-toolchain') -or -not $agentsText.Contains('rtk rewrite')) { Fail 'AGENTS.md 的 AI 工具路由冲突' }
    if (-not $agentsText.Contains($toolErrorRule)) { $needsToolErrorRule = $true }
  } else {
    $needsAgents = $true
  }

  $ignoreText = if (Test-Path -LiteralPath $ignorePath) { Get-Content -LiteralPath $ignorePath -Raw } else { '' }
  if ($ignoreText -notmatch '(?m)^/\.codegraph/\s*$') { $needsIgnore = $true }

  if (-not (Test-Path -LiteralPath $codexDirectory)) { New-Item -ItemType Directory -Path $codexDirectory | Out-Null }
  if ($needsConfig) {
    Append-ProjectText $configPath @'
[mcp_servers.codegraph]
command = "codegraph"
args = [
    "serve",
    "--mcp",
]

[mcp_servers.codegraph.env]
CODEGRAPH_TELEMETRY = "0"
CODEGRAPH_NO_UPDATE_CHECK = "1"
DO_NOT_TRACK = "1"
'@
  }
  if ($needsAgents) {
    Append-ProjectText $agentsPath @'
## AI 工具

- CodeGraph/RTK 的安装、初始化、维护和验证使用全局 `$agent-toolchain`。
- CodeGraph MCP 用于查询跨模块依赖、调用链和影响范围；处理跨模块任务时使用它。
- 对只读高输出命令，优先使用匹配的 `rtk` 子命令：`git`、`rg`、`log`、`diff`、`test`、`mvn`、`npm`、`pnpm`、`read`、`find`、`ls`、`tree`。未列出的只读命令先用 `rtk rewrite "<command>"` 或 `rtk --help` 判断；写操作和精确排障使用原生命令。
- 工具调用报错时，只有工具注册表或 `--help` 未列出目标命令，才可判定其不存在；否则不得归因于能力缺失。
'@
  }
  if ($needsToolErrorRule) { Append-ProjectText $agentsPath $toolErrorRule }
  if ($needsIgnore) { Append-ProjectText $ignorePath '/.codegraph/' }
  Note '项目 CodeGraph/RTK 路由已就绪'
}

function Load-TrustedManifest {
  $script:Manifest = [ordered]@{
    CODEGRAPH_VERSION = '1.5.0'; CODEGRAPH_NPM_PACKAGE = '@colbymchenry/codegraph'; RTK_VERSION = '0.44.1'
    RTK_WIN32_X64_ASSET = 'rtk-x86_64-pc-windows-msvc.zip'; RTK_WIN32_X64_SHA256 = 'e9f2e26c377279c34604d81021347f8a0f16eb539ab54dd17567ab5805b2957d'
  }
}

function Get-ToolValue([ValidateSet('codegraph', 'rtk')][string]$Tool, [ValidateSet('version', 'asset', 'sha', 'url')][string]$Field) {
  if ($Field -eq 'version') {
    if ($Tool -eq 'codegraph') { return $script:Manifest.CODEGRAPH_VERSION }
    return $script:Manifest.RTK_VERSION
  }
  if ($Tool -eq 'codegraph') { Fail "CodeGraph 只支持 version 字段；其余信息由 npm 管理" }
  $prefix = if ($script:PlatformName -eq 'win32-x64') { 'WIN32_X64' } else { Fail "未实现的平台：$script:PlatformName" }
  $keyPrefix = if ($Tool -eq 'codegraph') { "CODEGRAPH_$prefix" } else { "RTK_$prefix" }
  if ($Field -eq 'asset') { return $script:Manifest["${keyPrefix}_ASSET"] }
  if ($Field -eq 'sha') { return $script:Manifest["${keyPrefix}_SHA256"] }
  $version = Get-ToolValue $Tool 'version'
  $asset = Get-ToolValue $Tool 'asset'
  $repository = if ($Tool -eq 'codegraph') { 'colbymchenry/codegraph' } else { 'rtk-ai/rtk' }
  return "https://github.com/$repository/releases/download/v$version/$asset"
}

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Get-ToolDirectory([string]$Tool) { Join-Path $ToolchainHome $Tool }
function Get-VersionDirectory([string]$Tool, [string]$Version) { Join-Path (Get-ToolDirectory $Tool) $Version }
function Get-CurrentFile([string]$Tool) { Join-Path (Get-ToolDirectory $Tool) 'current.txt' }
function Get-NpmCommand {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $npm) { Fail '缺少 npm，无法全局安装 CodeGraph' }
  return $npm.Source
}
function Get-CodeGraphNpmPrefix {
  return (Join-Path $ToolchainHome 'npm')
}
function Get-CodeGraphNpmRoot {
  $output = @(& (Get-NpmCommand) --prefix (Get-CodeGraphNpmPrefix) root -g)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($output -join '').Trim())) { Fail '无法确定 npm 全局包目录' }
  return ($output -join "`n").Trim()
}
function Get-CodeGraphNpmBinary { Join-Path (Get-CodeGraphNpmPrefix) 'codegraph.cmd' }
function Get-CodeGraphPackageManifest { Join-Path (Join-Path (Join-Path (Get-CodeGraphNpmRoot) '@colbymchenry') 'codegraph') 'package.json' }
function Test-CodeGraphNpmReady {
  try {
    $manifestPath = Get-CodeGraphPackageManifest
    $binary = Get-CodeGraphNpmBinary
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) { return $false }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -ne $script:Manifest.CODEGRAPH_VERSION) { return $false }
    $platformManifest = Join-Path (Join-Path (Join-Path (Join-Path (Get-CodeGraphNpmRoot) '@colbymchenry') 'codegraph') 'node_modules/@colbymchenry') "codegraph-$script:PlatformName/package.json"
    if (-not (Test-Path -LiteralPath $platformManifest -PathType Leaf)) { return $false }
    if ((Get-Content -LiteralPath $platformManifest -Raw | ConvertFrom-Json).version -ne $script:Manifest.CODEGRAPH_VERSION) { return $false }
    $publicPath = Join-Path $ToolchainBin 'codegraph.cmd'
    if (-not (Test-Path -LiteralPath $publicPath -PathType Leaf)) { return $false }
    $publicItem = Get-Item -LiteralPath $publicPath -Force
    if ($publicItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    if ((Get-Content -LiteralPath $publicPath -Raw) -cne (Get-CodeGraphLauncher)) { return $false }
    return (Invoke-ToolVersion 'codegraph' $binary) -eq $script:Manifest.CODEGRAPH_VERSION -and (Invoke-ToolVersion 'codegraph' $publicPath) -eq $script:Manifest.CODEGRAPH_VERSION
  } catch { return $false }
}
function Get-Binary([string]$Tool, [string]$Directory) {
  if ($Tool -eq 'codegraph') { return Get-CodeGraphNpmBinary }
  return Join-Path $Directory 'rtk.exe'
}

function Assert-SafeVersion([string]$Version) {
  if ($Version -notmatch '^[0-9]+(?:\.[0-9]+)+$') { Fail "不安全的版本号：$Version" }
}

function Get-PeMachine([string]$Path) {
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { Fail "不是 PE 文件：$Path" }
    $stream.Position = 0x3C
    $headerOffset = $reader.ReadInt32()
    if ($headerOffset -lt 0 -or $headerOffset -gt ($stream.Length - 6)) { Fail "PE 头无效：$Path" }
    $stream.Position = $headerOffset + 4
    return $reader.ReadUInt16()
  } finally {
    $stream.Dispose()
  }
}

function Assert-PeX64([string]$Path, [string]$Description) {
  if ((Get-PeMachine $Path) -ne 0x8664) { Fail "$Description 不是 x64 PE 文件" }
}

function Assert-NoReparsePoints([string]$Directory) {
  if ((Get-Item -LiteralPath $Directory -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Fail "目录不能是重解析点：$Directory" }
  $reparse = Get-ChildItem -LiteralPath $Directory -Force -Recurse | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
  if ($reparse) { Fail "目录包含重解析点：$($reparse.FullName)" }
}

function Invoke-ToolVersion([string]$Tool, [string]$Binary) {
  $old = @{ RTK_TELEMETRY_DISABLED = $env:RTK_TELEMETRY_DISABLED; CODEGRAPH_TELEMETRY = $env:CODEGRAPH_TELEMETRY; CODEGRAPH_NO_UPDATE_CHECK = $env:CODEGRAPH_NO_UPDATE_CHECK; DO_NOT_TRACK = $env:DO_NOT_TRACK; CODEGRAPH_NO_DOWNLOAD = $env:CODEGRAPH_NO_DOWNLOAD }
  try {
    if ($Tool -eq 'rtk') { $env:RTK_TELEMETRY_DISABLED = '1' }
    if ($Tool -eq 'codegraph') { $env:CODEGRAPH_TELEMETRY = '0'; $env:CODEGRAPH_NO_UPDATE_CHECK = '1'; $env:DO_NOT_TRACK = '1'; $env:CODEGRAPH_NO_DOWNLOAD = '1' }
    $output = @(& $Binary --version)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { return $null }
    return ($output -join "`n").Trim()
  } finally {
    $env:RTK_TELEMETRY_DISABLED = $old.RTK_TELEMETRY_DISABLED; $env:CODEGRAPH_TELEMETRY = $old.CODEGRAPH_TELEMETRY; $env:CODEGRAPH_NO_UPDATE_CHECK = $old.CODEGRAPH_NO_UPDATE_CHECK; $env:DO_NOT_TRACK = $old.DO_NOT_TRACK; $env:CODEGRAPH_NO_DOWNLOAD = $old.CODEGRAPH_NO_DOWNLOAD
  }
}

function Verify-VersionDirectory([string]$Tool, [string]$Version, [string]$Directory = '') {
  if ($Tool -ne 'rtk') { Fail '只有 RTK 使用受管版本目录' }
  Assert-SafeVersion $Version
  if (-not $Directory) { $Directory = Get-VersionDirectory $Tool $Version }
  $toolDirectory = Get-ToolDirectory $Tool
  if (-not (Test-Path -LiteralPath $toolDirectory -PathType Container)) { Fail "安装验证失败：工具目录" }
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { Fail "安装验证失败：版本目录" }
  Assert-NoReparsePoints $Directory
  $binary = Get-Binary $Tool $Directory
  $receiptPath = Join-Path $Directory 'receipt'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { Fail '安装验证失败：二进制或 receipt' }
  $receipt = @{}
  foreach ($line in Get-Content -LiteralPath $receiptPath) {
    if ($line -notmatch '^([^=]+)=(.*)$' -or $receipt.ContainsKey($Matches[1])) { Fail '安装验证失败：receipt 格式' }
    $receipt[$Matches[1]] = $Matches[2]
  }
  if ($receipt.tool -ne $Tool -or $receipt.version -ne $Version -or $receipt.archive_sha256 -ne (Get-ToolValue $Tool 'sha') -or $receipt.binary_sha256 -ne (Get-Sha256 $binary)) { Fail '安装验证失败：receipt 摘要' }
  Assert-PeX64 $binary 'RTK'
  $expectedVersion = Get-ToolValue $Tool 'version'
  $expectedOutput = if ($Tool -eq 'codegraph') { $expectedVersion } else { "rtk $expectedVersion" }
  if ((Invoke-ToolVersion $Tool $binary) -ne $expectedOutput) { Fail '安装验证失败：版本输出' }
}

function Get-CodeGraphLauncher {
@"
@echo off
setlocal
set "CODEGRAPH_TELEMETRY=0"
set "CODEGRAPH_NO_UPDATE_CHECK=1"
set "DO_NOT_TRACK=1"
set "CODEGRAPH_NO_DOWNLOAD=1"
"$ToolchainHome\npm\codegraph.cmd" %*
exit /b %ERRORLEVEL%
"@
}

function Get-LegacyRtkLauncher {
  @"
@echo off
setlocal
set "TOOLCHAIN_HOME=$ToolchainHome"
set "RTK_TELEMETRY_DISABLED=1"
set /p VERSION=<"%TOOLCHAIN_HOME%\rtk\current.txt"
"%TOOLCHAIN_HOME%\rtk\%VERSION%\rtk.exe" %*
exit /b %ERRORLEVEL%
"@
}

function Get-PublicRtkBinary { return Join-Path $ToolchainBin 'rtk.exe' }

function Test-PublicRtkBinary([string]$Version) {
  try {
    $publicPath = Get-PublicRtkBinary
    $target = Get-Binary 'rtk' (Get-VersionDirectory 'rtk' $Version)
    if (-not (Test-Path -LiteralPath $publicPath -PathType Leaf) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { return $false }
    $publicItem = Get-Item -LiteralPath $publicPath -Force
    if ($publicItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    return (Get-Sha256 $publicPath) -eq (Get-Sha256 $target)
  } catch { return $false }
}

function Assert-LegacyRtkLauncherSafe {
  $legacyPath = Join-Path $ToolchainBin 'rtk.cmd'
  if (-not (Test-Path -LiteralPath $legacyPath)) { return }
  $legacyItem = Get-Item -LiteralPath $legacyPath -Force
  if (($legacyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $legacyItem.PSIsContainer) { Fail "$legacyPath 必须是普通文件" }
  if ((Get-Content -LiteralPath $legacyPath -Raw) -cne (Get-LegacyRtkLauncher)) { Fail "$legacyPath 已被非受管理目标占用" }
}

function Remove-LegacyRtkLauncher {
  $legacyPath = Join-Path $ToolchainBin 'rtk.cmd'
  Assert-LegacyRtkLauncherSafe
  if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) { return }
  Remove-Item -LiteralPath $legacyPath -Force
}

function Ensure-PublicRtkBinary([string]$Version) {
  Assert-SafeVersion $Version
  Verify-VersionDirectory 'rtk' $Version
  Assert-LegacyRtkLauncherSafe
  $publicPath = Get-PublicRtkBinary
  if (Test-Path -LiteralPath $publicPath) {
    $publicItem = Get-Item -LiteralPath $publicPath -Force
    if (($publicItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $publicItem.PSIsContainer) { Fail "$publicPath 必须是普通文件" }
    if (Test-PublicRtkBinary $Version) {
      Remove-LegacyRtkLauncher
      return
    }
    $currentVersion = Get-CurrentVersion 'rtk'
    if (-not $currentVersion -or -not (Test-PublicRtkBinary $currentVersion)) { Fail "$publicPath 已被非受管理目标占用" }
  }
  $target = Get-Binary 'rtk' (Get-VersionDirectory 'rtk' $Version)
  $temporary = Join-Path $ToolchainBin ".rtk-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    New-Item -ItemType HardLink -Path $temporary -Target $target | Out-Null
    if (Test-Path -LiteralPath $publicPath -PathType Leaf) {
      [System.IO.File]::Replace($temporary, $publicPath, $null)
    } else {
      [System.IO.File]::Move($temporary, $publicPath)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
  if (-not (Test-PublicRtkBinary $Version)) { Fail 'RTK 原生公共入口验证失败' }
  Remove-LegacyRtkLauncher
}

function Ensure-PublicLauncher([string]$Tool, [string]$Version = '') {
  New-Item -ItemType Directory -Path $ToolchainBin -Force | Out-Null
  if ($Tool -eq 'rtk') {
    if ([string]::IsNullOrWhiteSpace($Version)) { Fail 'RTK 公共入口缺少版本号' }
    Ensure-PublicRtkBinary $Version
    return
  }
  $path = Join-Path $ToolchainBin "$Tool.cmd"
  $expected = Get-CodeGraphLauncher
  if (Test-Path -LiteralPath $path) {
    $current = Get-Content -LiteralPath $path -Raw
    if ($current -cne $expected) {
      if ($Tool -ne 'codegraph' -or $current -notmatch [regex]::Escape("set `"TOOLCHAIN_HOME=$ToolchainHome`"")) { Fail "$path 已被非受管理目标占用" }
      [System.IO.File]::WriteAllText($path, $expected, [System.Text.UTF8Encoding]::new($false))
    }
    return
  }
  [System.IO.File]::WriteAllText($path, $expected, [System.Text.UTF8Encoding]::new($false))
}

function Ensure-UserPath([string[]]$Directories) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $additions = @()
  foreach ($candidate in $Directories) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    $alreadyPresent = $parts | Where-Object { $_.TrimEnd('\') -ieq $candidate.TrimEnd('\') } | Select-Object -First 1
    if (-not $alreadyPresent) { $additions += $candidate }
  }
  if ($additions.Count -gt 0) {
    $newUserPath = [string]::Join(';', $additions + $parts)
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    Note '已将受管理命令目录加入当前用户 Path；新开的终端或 Codex task 才会读取该变更。'
  }
  foreach ($directory in $Directories) {
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $directory.TrimEnd('\') })) { $env:Path = "$directory;$env:Path" }
  }
}

function Get-CurrentVersion([string]$Tool) {
  $currentFile = Get-CurrentFile $Tool
  if (-not (Test-Path -LiteralPath $currentFile -PathType Leaf)) { return $null }
  $version = (Get-Content -LiteralPath $currentFile -Raw).Trim()
  if ($version -notmatch '^[0-9]+(?:\.[0-9]+)+$') { return $null }
  return $version
}

function Set-CurrentVersion([string]$Tool, [string]$Version) {
  Assert-SafeVersion $Version
  $toolDirectory = Get-ToolDirectory $Tool
  New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
  Assert-NoReparsePoints $toolDirectory
  $currentFile = Get-CurrentFile $Tool
  if ((Test-Path -LiteralPath $currentFile) -and -not (Test-Path -LiteralPath $currentFile -PathType Leaf)) { Fail "current 不是普通文件：$currentFile" }
  Ensure-PublicLauncher $Tool $Version
  Ensure-UserPath @($ToolchainBin)
  $temporary = Join-Path $toolDirectory ".current-$([Guid]::NewGuid().ToString('N')).tmp"
  $backup = Join-Path $toolDirectory ".current-$([Guid]::NewGuid().ToString('N')).bak"
  try {
    [System.IO.File]::WriteAllText($temporary, "$Version`n", [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $currentFile -PathType Leaf) {
      [System.IO.File]::Replace($temporary, $currentFile, $backup)
    } else {
      [System.IO.File]::Move($temporary, $currentFile)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  }
}

function Test-Ready([string]$Tool) {
  try {
    if ($Tool -eq 'codegraph') { return Test-CodeGraphNpmReady }
    $version = Get-ToolValue $Tool 'version'
    if ((Get-CurrentVersion $Tool) -ne $version) { return $false }
    if (Test-Path -LiteralPath (Join-Path $ToolchainBin 'rtk.cmd')) { return $false }
    Verify-VersionDirectory $Tool $version
    return Test-PublicRtkBinary $version
  } catch { return $false }
}

function Test-QuickReady([string]$Tool) {
  try {
    if ($Tool -eq 'codegraph') { return Test-CodeGraphNpmReady }
    $version = Get-ToolValue $Tool 'version'
    if ((Get-CurrentVersion $Tool) -ne $version) { return $false }
    if (Test-Path -LiteralPath (Join-Path $ToolchainBin 'rtk.cmd')) { return $false }
    $directory = Get-VersionDirectory $Tool $version
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return $false }
    Assert-NoReparsePoints $directory
    $binary = Get-Binary $Tool $directory
    $receiptPath = Join-Path $directory 'receipt'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $false }
    $receipt = @{}
    foreach ($line in Get-Content -LiteralPath $receiptPath) {
      if ($line -notmatch '^([^=]+)=(.*)$' -or $receipt.ContainsKey($Matches[1])) { return $false }
      $receipt[$Matches[1]] = $Matches[2]
    }
    if ($receipt.tool -ne $Tool -or $receipt.version -ne $version) { return $false }
    if ($Tool -eq 'codegraph') {
      if (-not (Test-Path -LiteralPath (Join-Path $directory 'node.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $directory 'lib/dist/bin/codegraph.js') -PathType Leaf)) { return $false }
    }
    return Test-PublicRtkBinary $version
  } catch { return $false }
}

function Assert-Timeout([string]$Name, [string]$Value) {
  $number = 0
  if (-not [int]::TryParse($Value, [ref]$number) -or $number -lt 1 -or $number -gt 300) { Fail "$Name 必须是 1 到 300 的整数" }
  return $number
}

function Detect-Proxy {
  $script:DownloadProxy = $null; $script:DownloadProxySource = 'direct'
  foreach ($candidate in @(
    @{ Name = 'AGENT_TOOLCHAIN_PROXY'; Source = 'explicit' },
    @{ Name = 'HTTPS_PROXY'; Source = 'environment' },
    @{ Name = 'https_proxy'; Source = 'environment' },
    @{ Name = 'ALL_PROXY'; Source = 'environment' },
    @{ Name = 'all_proxy'; Source = 'environment' }
  )) {
    $value = [Environment]::GetEnvironmentVariable($candidate.Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value)) { $script:DownloadProxy = $value; $script:DownloadProxySource = $candidate.Source; return }
  }
  try {
    $target = [Uri]'https://github.com/'
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
    if ($proxy -and $proxy.Host -ne $target.Host) { $script:DownloadProxy = $proxy.AbsoluteUri; $script:DownloadProxySource = 'Windows-system' }
  } catch { }
}

function Network-Preflight {
  $connectValue = if ($env:AGENT_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS) { $env:AGENT_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS } else { '10' }
  $requestValue = if ($env:AGENT_TOOLCHAIN_REQUEST_TIMEOUT_SECONDS) { $env:AGENT_TOOLCHAIN_REQUEST_TIMEOUT_SECONDS } else { '90' }
  $script:ConnectTimeout = Assert-Timeout 'AGENT_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS' $connectValue
  $script:RequestTimeout = Assert-Timeout 'AGENT_TOOLCHAIN_REQUEST_TIMEOUT_SECONDS' $requestValue
  Detect-Proxy
  if ($script:DownloadProxySource -eq 'direct') {
    Note "网络预检：直连 GitHub；未检测到代理。连接超时 $($script:ConnectTimeout)s，请求超时 $($script:RequestTimeout)s。"
    Note '网络提示：若连接或下载缓慢，设置 AGENT_TOOLCHAIN_PROXY=<scheme://host:port> 后重试。'
  } else {
    Note "网络预检：使用 $script:DownloadProxySource 代理；连接超时 $($script:ConnectTimeout)s，请求超时 $($script:RequestTimeout)s。"
  }
}

function Invoke-Curl([string[]]$Arguments) {
  $curl = Get-Command curl.exe -ErrorAction Stop | Select-Object -First 1
  $curlArguments = @()
  if ($script:DownloadProxy) { $curlArguments += @('--proxy', $script:DownloadProxy) }
  $curlArguments += $Arguments
  & $curl.Source @curlArguments
  if ($LASTEXITCODE -ne 0) { Fail 'GitHub 下载失败或超时；请检查网络/代理后重试。可设置 AGENT_TOOLCHAIN_PROXY=<scheme://host:port>，不会写入项目配置。' }
}

function Download-Archive([string]$Url, [string]$Archive, [string]$WorkDirectory, [string]$Label) {
  $segmentsText = if ($env:AGENT_TOOLCHAIN_DOWNLOAD_WORKERS) { $env:AGENT_TOOLCHAIN_DOWNLOAD_WORKERS } else { '4' }
  $segments = 0
  if (-not [int]::TryParse($segmentsText, [ref]$segments) -or $segments -lt 1 -or $segments -gt 8) { Fail 'AGENT_TOOLCHAIN_DOWNLOAD_WORKERS 必须是 1 到 8 的整数' }
  $headers = Join-Path $WorkDirectory 'range-headers'
  Note "下载 $Label：获取受信任 release asset 信息"
  Invoke-Curl @('--fail', '--location', '--silent', '--show-error', '--http1.1', '--retry', '3', '--retry-delay', '2', '--connect-timeout', "$script:ConnectTimeout", '--max-time', "$script:RequestTimeout", '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--range', '0-0', '--dump-header', $headers, '--output', 'NUL', $Url)
  $headerText = Get-Content -LiteralPath $headers -Raw
  $rangeMatch = [regex]::Match($headerText, '(?im)^content-range:\s*bytes\s+\d+-\d+/(\d+)\s*$')
  $locationMatches = [regex]::Matches($headerText, '(?im)^location:\s*(https://\S+)\s*$')
  if (-not $rangeMatch.Success -or $locationMatches.Count -eq 0) { Fail '无法从 Range 响应确定下载大小或 release asset 地址' }
  $total = [int64]$rangeMatch.Groups[1].Value
  $assetUrl = $locationMatches[$locationMatches.Count - 1].Groups[1].Value
  if ($assetUrl -notlike 'https://release-assets.githubusercontent.com/*') { Fail '下载重定向不是受信任的 GitHub release asset' }
  $chunk = [int64][Math]::Ceiling($total / $segments)
  for ($index = 0; $index -lt $segments; $index += 1) {
    $start = [int64]$index * $chunk
    if ($start -ge $total) { break }
    $end = [Math]::Min($total - 1, $start + $chunk - 1)
    Note "下载 $Label：分段 $($index + 1)/$segments"
    Invoke-Curl @('--fail', '--location', '--silent', '--show-error', '--http1.1', '--retry', '3', '--retry-delay', '2', '--connect-timeout', "$script:ConnectTimeout", '--max-time', "$script:RequestTimeout", '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--range', "$start-$end", '--output', (Join-Path $WorkDirectory "part-$index"), $assetUrl)
  }
  $output = [System.IO.File]::Open($Archive, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    for ($index = 0; $index -lt $segments; $index += 1) {
      $part = Join-Path $WorkDirectory "part-$index"
      if (-not (Test-Path -LiteralPath $part -PathType Leaf)) { break }
      $input = [System.IO.File]::OpenRead($part)
      try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
  } finally { $output.Dispose() }
  if ((Get-Item -LiteralPath $Archive).Length -ne $total) { Fail '分段下载大小不匹配' }
}

function Assert-SafeZip([string]$Archive) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    if ($zip.Entries.Count -eq 0) { Fail '归档为空' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:/' -or $name -match '(^|/)\.\.(/|$)') { Fail '归档包含危险路径' }
      $type = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($type -eq 0xA000) { Fail '归档包含符号链接' }
    }
  } finally { $zip.Dispose() }
}

function Install-Tool([ValidateSet('codegraph', 'rtk')][string]$Tool) {
  if ($Tool -ne 'rtk') { Fail 'CodeGraph 必须通过官方 npm 包安装' }
  $version = Get-ToolValue $Tool 'version'
  if (Test-Ready $Tool) { Note "$Tool $version 已就绪"; return }
  $destination = Get-VersionDirectory $Tool $version
  if (Test-Path -LiteralPath $destination) {
    if ((Get-CurrentVersion $Tool) -eq $version) {
      Verify-VersionDirectory $Tool $version
      if ($script:DryRun) {
        Note "dry-run: 修复 $ToolchainBin\\rtk.exe 公共入口"
        return
      }
      Set-CurrentVersion $Tool $version
      if (Test-Ready $Tool) { Note "$Tool $version 已修复"; return }
    }
    Fail "$destination 已存在但不健康，拒绝覆盖"
  }
  if ($script:DryRun) {
    Note "dry-run: 下载 $(Get-ToolValue $Tool 'url')"
    Note "dry-run: 验证 SHA-256 $(Get-ToolValue $Tool 'sha')"
    Note "dry-run: 安装到 $destination 并创建 $ToolchainBin\\rtk.exe"
    return
  }
  $workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "agent-toolchain-$([Guid]::NewGuid().ToString('N'))"
  $stage = $null
  try {
    New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null
    $archive = Join-Path $workDirectory (Get-ToolValue $Tool 'asset')
    Download-Archive (Get-ToolValue $Tool 'url') $archive $workDirectory "$Tool $version"
    if ((Get-Sha256 $archive) -ne (Get-ToolValue $Tool 'sha')) { Fail "$Tool 下载摘要不匹配" }
    Assert-SafeZip $archive
    $extract = Join-Path $workDirectory 'extract'
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    Assert-NoReparsePoints $extract
    $candidates = @(Get-ChildItem -LiteralPath $extract -Filter 'rtk.exe' -File -Recurse)
    if ($candidates.Count -ne 1) { Fail '归档中 RTK binary 数量异常' }
    $bundleRoot = $candidates[0].Directory.FullName
    Assert-PeX64 $candidates[0].FullName 'RTK'
    $toolDirectory = Get-ToolDirectory $Tool
    New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
    Assert-NoReparsePoints $toolDirectory
    $stage = Join-Path $toolDirectory ".install-$version-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $bundleRoot -Force | Copy-Item -Destination $stage -Recurse -Force
    $binary = Get-Binary $Tool $stage
    $receipt = @("tool=$Tool", "version=$version", "archive_sha256=$(Get-Sha256 $archive)", "binary_sha256=$(Get-Sha256 $binary)", "url=$(Get-ToolValue $Tool 'url')")
    [System.IO.File]::WriteAllLines((Join-Path $stage 'receipt'), $receipt, [System.Text.UTF8Encoding]::new($false))
    Verify-VersionDirectory $Tool $version $stage
    Move-Item -LiteralPath $stage -Destination $destination
    $stage = $null
    Set-CurrentVersion $Tool $version
    if (-not (Test-Ready $Tool)) { Fail "$Tool 发布后验证失败" }
    Note "$Tool $version 已安装"
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath $workDirectory) { Remove-Item -LiteralPath $workDirectory -Recurse -Force }
  }
}

function Install-CodeGraphNpm {
  $npm = Get-NpmCommand
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $node) { Fail '缺少 Node.js，无法全局安装 CodeGraph' }
  if (Test-CodeGraphNpmReady) { Note "CodeGraph npm $($script:Manifest.CODEGRAPH_VERSION) 已就绪"; return }
  if ($script:DryRun) {
    Note "dry-run: npm install --global --prefix $(Get-CodeGraphNpmPrefix) --ignore-scripts $($script:Manifest.CODEGRAPH_NPM_PACKAGE)@$($script:Manifest.CODEGRAPH_VERSION)"
    Note 'dry-run: 使用当前 npm registry 和代理设置；RTK 仍使用下方已校验的 GitHub release'
    return
  }
  Note "通过 npm 全局安装 CodeGraph $($script:Manifest.CODEGRAPH_VERSION)"
  New-Item -ItemType Directory -Path (Get-CodeGraphNpmPrefix) -Force | Out-Null
  $npmEnvironmentNames = @('NPM_CONFIG_FETCH_TIMEOUT', 'NPM_CONFIG_FETCH_RETRIES', 'NPM_CONFIG_FETCH_RETRY_MINTIMEOUT', 'NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT')
  $previousNpmEnvironment = @{}
  foreach ($name in $npmEnvironmentNames) { $previousNpmEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    if (-not $env:NPM_CONFIG_FETCH_TIMEOUT) { $env:NPM_CONFIG_FETCH_TIMEOUT = "$($script:RequestTimeout * 1000)" }
    if (-not $env:NPM_CONFIG_FETCH_RETRIES) { $env:NPM_CONFIG_FETCH_RETRIES = '1' }
    if (-not $env:NPM_CONFIG_FETCH_RETRY_MINTIMEOUT) { $env:NPM_CONFIG_FETCH_RETRY_MINTIMEOUT = '1000' }
    if (-not $env:NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT) { $env:NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT = '10000' }
    & $npm install --global --prefix (Get-CodeGraphNpmPrefix) --ignore-scripts --no-audit --no-fund "$($script:Manifest.CODEGRAPH_NPM_PACKAGE)@$($script:Manifest.CODEGRAPH_VERSION)"
    if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph npm 安装失败或超时；请检查 npm registry、代理和 Node 环境' }
  } finally {
    foreach ($name in $npmEnvironmentNames) {
      if ($null -eq $previousNpmEnvironment[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:$name" -Value $previousNpmEnvironment[$name] }
    }
  }
  Ensure-PublicLauncher 'codegraph'
  Ensure-UserPath @($ToolchainBin)
  if (-not (Test-CodeGraphNpmReady)) { Fail 'CodeGraph npm 安装后验证失败' }
  Note "CodeGraph $($script:Manifest.CODEGRAPH_VERSION) 已通过 npm 全局安装"
}

function Invoke-WithCodeGraphEnvironment([scriptblock]$Block) {
  $old = @{ CODEGRAPH_TELEMETRY = $env:CODEGRAPH_TELEMETRY; CODEGRAPH_NO_UPDATE_CHECK = $env:CODEGRAPH_NO_UPDATE_CHECK; DO_NOT_TRACK = $env:DO_NOT_TRACK; CODEGRAPH_NO_DOWNLOAD = $env:CODEGRAPH_NO_DOWNLOAD }
  try {
    $env:CODEGRAPH_TELEMETRY = '0'; $env:CODEGRAPH_NO_UPDATE_CHECK = '1'; $env:DO_NOT_TRACK = '1'; $env:CODEGRAPH_NO_DOWNLOAD = '1'
    & $Block
  } finally {
    $env:CODEGRAPH_TELEMETRY = $old.CODEGRAPH_TELEMETRY; $env:CODEGRAPH_NO_UPDATE_CHECK = $old.CODEGRAPH_NO_UPDATE_CHECK; $env:DO_NOT_TRACK = $old.DO_NOT_TRACK; $env:CODEGRAPH_NO_DOWNLOAD = $old.CODEGRAPH_NO_DOWNLOAD
  }
}

function Assert-CodeGraphIndexSafe {
  $indexDirectory = Join-Path $script:Project '.codegraph'
  if (-not (Test-Path -LiteralPath $indexDirectory)) { return }
  $item = Get-Item -LiteralPath $indexDirectory -Force
  if (-not $item.PSIsContainer) { Fail '.codegraph 必须是目录' }
  Assert-NoReparsePoints $indexDirectory
}

function Invoke-Doctor {
  $failed = $false
  if ($script:Quick) {
    foreach ($tool in @('codegraph', 'rtk')) {
      if (Test-QuickReady $tool) { Note "$($tool): ready ($(Get-Binary $tool (Get-VersionDirectory $tool (Get-ToolValue $tool 'version'))))" } else { Note "$($tool): missing"; $failed = $true }
    }
    Note 'codegraph-index: skipped (--quick)'
    if ($failed) { Fail '健康检查未通过' }
    return
  }
  Assert-CodeGraphIndexSafe
  foreach ($tool in @('codegraph', 'rtk')) {
    if (Test-Ready $tool) { Note "$($tool): ready ($(Get-Binary $tool (Get-VersionDirectory $tool (Get-ToolValue $tool 'version'))))" } else { Note "$($tool): missing"; $failed = $true }
  }
  $indexDirectory = Join-Path $script:Project '.codegraph'
  if ((Test-Ready 'codegraph') -and (Test-Path -LiteralPath $indexDirectory -PathType Container) -and (Get-ChildItem -LiteralPath $indexDirectory -Force | Where-Object { $_.Name -ne '.gitignore' } | Select-Object -First 1)) {
    Invoke-WithCodeGraphEnvironment { Push-Location -LiteralPath $script:Project; try { & (Get-Binary 'codegraph' (Get-VersionDirectory 'codegraph' (Get-ToolValue 'codegraph' 'version'))) status; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph 索引状态异常' } } finally { Pop-Location } }
  } else { Note 'codegraph-index: needs_init'; $failed = $true }
  if ($failed) { Fail '健康检查未通过' }
}

function Invoke-Bootstrap {
  if ($script:Apply -eq $script:DryRun) { Fail 'bootstrap 必须且只能指定 --dry-run 或 --apply' }
  Network-Preflight
  try {
    Install-CodeGraphNpm
    Install-Tool 'rtk'
  } catch {
    throw
  }
  if ($script:Apply -and (Test-Ready 'codegraph')) { Invoke-WithCodeGraphEnvironment { & (Get-Binary 'codegraph' (Get-VersionDirectory 'codegraph' (Get-ToolValue 'codegraph' 'version'))) telemetry off | Out-Null } }
  if ($script:Apply -and (Test-Ready 'rtk')) {
    $env:RTK_TELEMETRY_DISABLED = '1'
    $telemetryOutput = @(& (Get-Binary 'rtk' (Get-VersionDirectory 'rtk' (Get-ToolValue 'rtk' 'version'))) telemetry disable)
    $telemetryExitCode = $LASTEXITCODE
    if ($telemetryExitCode -ne 0) { Fail "RTK telemetry disable 失败：$telemetryExitCode $($telemetryOutput -join ' ')" }
  }
}

function Invoke-InitCodeGraph {
  if (-not (Test-Ready 'codegraph')) { Fail 'CodeGraph 尚未安装' }
  $indexDirectory = Join-Path $script:Project '.codegraph'
  Assert-CodeGraphIndexSafe
  if (Test-Path -LiteralPath $indexDirectory -PathType Container) {
    if (Get-ChildItem -LiteralPath $indexDirectory -Force | Where-Object { $_.Name -ne '.gitignore' } | Select-Object -First 1) {
      Note '.codegraph 已有索引；执行增量同步'
      Invoke-WithCodeGraphEnvironment { Push-Location -LiteralPath $script:Project; try { $binary = Get-CodeGraphNpmBinary; & $binary sync; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph sync 失败' }; & $binary status; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph status 失败' } } finally { Pop-Location } }
      return
    }
  }
  Invoke-WithCodeGraphEnvironment { Push-Location -LiteralPath $script:Project; try { $binary = Get-Binary 'codegraph' (Get-VersionDirectory 'codegraph' (Get-ToolValue 'codegraph' 'version')); & $binary init; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph init 失败' }; & $binary status; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph status 失败' } } finally { Pop-Location } }
}

function Invoke-Maintain {
  if (-not (Test-Ready 'codegraph')) { Fail 'CodeGraph 尚未安装' }
  Assert-CodeGraphIndexSafe
  Invoke-WithCodeGraphEnvironment { Push-Location -LiteralPath $script:Project; try { $binary = Get-Binary 'codegraph' (Get-VersionDirectory 'codegraph' (Get-ToolValue 'codegraph' 'version')); & $binary status; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph status 失败' }; if ($script:Sync) { & $binary sync; if ($LASTEXITCODE -ne 0) { Fail 'CodeGraph sync 失败' } } } finally { Pop-Location } }
}

function Invoke-Rollback {
  if (-not $script:RollbackTool -or -not $script:RollbackVersion) { Fail 'rollback 需要工具和版本' }
  if ($script:RollbackTool -ne 'rtk') { Fail 'CodeGraph 使用 npm 固定版本安装，不支持此回滚命令' }
  Assert-SafeVersion $script:RollbackVersion
  Verify-VersionDirectory $script:RollbackTool $script:RollbackVersion
  Set-CurrentVersion $script:RollbackTool $script:RollbackVersion
  Note "$script:RollbackTool 已切换到 $script:RollbackVersion"
}

Parse-Arguments
switch ($script:Action) {
  'configure' { Check-Project; Configure-Project }
  'doctor' { $script:PlatformName = Get-PlatformName; Check-Project; Load-TrustedManifest; Invoke-Doctor }
  'bootstrap' { $script:PlatformName = Get-PlatformName; Check-Project; Load-TrustedManifest; Invoke-Bootstrap }
  'init-codegraph' { $script:PlatformName = Get-PlatformName; Check-Project; Load-TrustedManifest; Invoke-InitCodeGraph }
  'maintain' { $script:PlatformName = Get-PlatformName; Check-Project; Load-TrustedManifest; Invoke-Maintain }
  'rollback' { $script:PlatformName = Get-PlatformName; Load-TrustedManifest; Invoke-Rollback }
  'help' { Show-Usage }
  '-h' { Show-Usage }
  '--help' { Show-Usage }
  '' { Show-Usage }
  default { Show-Usage; Fail "未知操作：$script:Action" }
}
