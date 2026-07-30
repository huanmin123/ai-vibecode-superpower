[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-ExistingPath {
    param([Parameter(Mandatory)][string]$Path)

    return (Test-Path -LiteralPath $Path -PathType Any)
}

function Get-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
}

function Test-SamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    return [string]::Equals(
        (Get-AbsolutePath -Path $Left).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        (Get-AbsolutePath -Path $Right).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-NoReparsePoints {
    param([Parameter(Mandatory)][string]$Path)

    $current = Get-AbsolutePath -Path $Path
    while (-not (Test-Path -LiteralPath $current -PathType Any)) {
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $current = $parent
    }

    while (Test-Path -LiteralPath $current -PathType Any) {
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to install through a symbolic link or junction: $current"
        }

        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Get-InstallMutex {
    param([Parameter(Mandatory)][string]$CodexHome)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($CodexHome)
    $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
    $name = 'Local\CodexInstaller-' + [Convert]::ToHexString($hash)
    $mutex = [System.Threading.Mutex]::new($false, $name)
    try {
        if (-not $mutex.WaitOne(0)) {
            $mutex.Dispose()
            throw "Another Codex installer is already running for: $CodexHome"
        }
    } catch [System.Threading.AbandonedMutexException] {
        # An interrupted installer left no active owner; this process now owns the mutex.
    }
    return $mutex
}

function New-UniqueDirectory {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Prefix
    )

    do {
        $candidate = Join-Path $Parent ('{0}{1}-{2}' -f $Prefix, (Get-Date -Format 'yyyyMMdd-HHmmss'), [System.Guid]::NewGuid().ToString('N'))
    } while (Test-Path -LiteralPath $candidate)

    New-Item -ItemType Directory -Path $candidate | Out-Null
    return $candidate
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$sourceAgents = Join-Path $scriptRoot 'codex-global-config\AGENTS.md'
$sourceDocs = Join-Path $scriptRoot 'codex-global-config\docs'
$sourceSkills = Join-Path $scriptRoot 'skills'

if (-not (Test-Path -LiteralPath $sourceAgents -PathType Leaf)) { throw "Missing source file: $sourceAgents" }
if (-not (Test-Path -LiteralPath $sourceDocs -PathType Container)) { throw "Missing source directory: $sourceDocs" }
if (-not (Test-Path -LiteralPath $sourceSkills -PathType Container)) { throw "Missing source directory: $sourceSkills" }
$managedSkillNames = @(Get-ChildItem -LiteralPath $sourceSkills -Directory -Force | Sort-Object -Property Name | Select-Object -ExpandProperty Name)
if ($managedSkillNames.Count -eq 0) { throw "No managed skill directories found in: $sourceSkills" }

if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    $codexHome = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.codex'
} else {
    $codexHome = $env:CODEX_HOME
}
$codexHome = Get-AbsolutePath -Path $codexHome

if ([System.IO.Path]::GetPathRoot($codexHome).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) -eq $codexHome.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) {
    throw "Refusing to install into a filesystem root: $codexHome"
}
Assert-NoReparsePoints -Path $codexHome

$targets = @{
    'AGENTS.md' = $sourceAgents
    'docs' = $sourceDocs
}
foreach ($name in $targets.Keys) {
    if (Test-SamePath -Left (Join-Path $codexHome $name) -Right $targets[$name]) {
        throw "Destination target overlaps its source: $(Join-Path $codexHome $name)"
    }
}
foreach ($skillName in $managedSkillNames) {
    $targetSkill = Join-Path (Join-Path $codexHome 'skills') $skillName
    $sourceSkill = Join-Path $sourceSkills $skillName
    if (Test-SamePath -Left $targetSkill -Right $sourceSkill) {
        throw "Destination target overlaps its source: $targetSkill"
    }
}

$installTargets = [System.Collections.Generic.List[string]]::new()
$installTargets.Add('AGENTS.md')
$installTargets.Add('docs')
foreach ($skillName in $managedSkillNames) {
    $installTargets.Add((Join-Path 'skills' $skillName))
}

New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
$installMutex = $null
$installMutex = Get-InstallMutex -CodexHome $codexHome
$stageRoot = $null
$backupRoot = Join-Path $codexHome 'backups'
$backupDirectory = $null
$movedOldTargets = [System.Collections.Generic.List[string]]::new()
$installedTargets = [System.Collections.Generic.List[string]]::new()

try {
    $stageRoot = New-UniqueDirectory -Parent $codexHome -Prefix '.install-stage-'
    Copy-Item -LiteralPath $sourceAgents -Destination (Join-Path $stageRoot 'AGENTS.md') -Force
    Copy-Item -LiteralPath $sourceDocs -Destination (Join-Path $stageRoot 'docs') -Recurse -Force
    $stagedSkills = Join-Path $stageRoot 'skills'
    New-Item -ItemType Directory -Path $stagedSkills | Out-Null
    foreach ($skillName in $managedSkillNames) {
        Copy-Item -LiteralPath (Join-Path $sourceSkills $skillName) -Destination (Join-Path $stagedSkills $skillName) -Recurse -Force
    }

    foreach ($name in $installTargets) {
        $stagedTarget = Join-Path $stageRoot $name
        if (-not (Test-ExistingPath -Path $stagedTarget)) { throw "Staging failed for: $name" }
    }

    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backupDirectory = New-UniqueDirectory -Parent $backupRoot -Prefix 'backup-'

    foreach ($name in $installTargets) {
        $targetPath = Join-Path $codexHome $name
        Assert-NoReparsePoints -Path $targetPath
        if (Test-ExistingPath -Path $targetPath) {
            $backupPath = Join-Path $backupDirectory $name
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
            Move-Item -LiteralPath $targetPath -Destination $backupPath
            $movedOldTargets.Add($name)
        }
    }

    foreach ($name in $installTargets) {
        $targetPath = Join-Path $codexHome $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Move-Item -LiteralPath (Join-Path $stageRoot $name) -Destination $targetPath
        $installedTargets.Add($name)
    }

    Write-Host "Codex configuration installed in: $codexHome"
    Write-Host "Backup directory: $backupDirectory"
}
catch {
    foreach ($name in $installedTargets) {
        $installedPath = Join-Path $codexHome $name
        if (Test-ExistingPath -Path $installedPath) {
            Remove-Item -LiteralPath $installedPath -Recurse -Force
        }
    }
    if ($null -ne $backupDirectory) {
        foreach ($name in $movedOldTargets) {
            $backupPath = Join-Path $backupDirectory $name
            $restorePath = Join-Path $codexHome $name
            if ((Test-ExistingPath -Path $backupPath) -and -not (Test-ExistingPath -Path $restorePath)) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $restorePath) -Force | Out-Null
                Move-Item -LiteralPath $backupPath -Destination $restorePath
            }
        }
    }
    throw
}
finally {
    if ($null -ne $stageRoot -and (Test-Path -LiteralPath $stageRoot -PathType Container)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    if ($null -ne $installMutex) {
        $installMutex.ReleaseMutex()
        $installMutex.Dispose()
    }
}
