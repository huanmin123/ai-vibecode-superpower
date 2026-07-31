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

function Assert-NoReparsePointsInTree {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Any)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to copy through a symbolic link or junction: $Path"
    }
    if (-not $item.PSIsContainer) { return }

    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
        Assert-NoReparsePointsInTree -Path $child.FullName
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

function Get-ManagedTomlSettings {
    param([Parameter(Mandatory)][string]$Path)

    $settings = [ordered]@{
        '' = [ordered]@{
            'model' = $null
            'model_reasoning_effort' = $null
        }
        'agents' = [ordered]@{
            'max_threads' = $null
            'max_depth' = $null
        }
        'features' = [ordered]@{
            'js_repl' = $null
            'goals' = $null
        }
    }
    $section = ''
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $section = $Matches[1]
            continue
        }
        if ($settings.Contains($section) -and $line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*(?:#.*)?$') {
            $key = $Matches[1]
            if ($settings[$section].Contains($key)) {
                $settings[$section][$key] = $Matches[2]
            }
        }
    }

    foreach ($settingSection in $settings.Keys) {
        foreach ($key in $settings[$settingSection].Keys) {
            if ([string]::IsNullOrWhiteSpace($settings[$settingSection][$key])) {
                throw "Missing managed config setting: $settingSection/$key"
            }
        }
    }
    return $settings
}

function Merge-ManagedTomlSettings {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory)][string]$ExistingPath,
        [Parameter(Mandatory)][string]$OutputPath
    )

    $output = [System.Collections.Generic.List[string]]::new()
    $seenSections = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $seenKeys = @{}
    foreach ($settingSection in $Settings.Keys) {
        $seenKeys[$settingSection] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    }

    function Add-MissingSettings {
        param([Parameter(Mandatory)][AllowEmptyString()][string]$Section)

        if (-not $Settings.Contains($Section)) { return }
        foreach ($key in $Settings[$Section].Keys) {
            if (-not $seenKeys[$Section].Contains($key)) {
                $output.Add("$key = $($Settings[$Section][$key])")
                [void]$seenKeys[$Section].Add($key)
            }
        }
    }

    $section = ''
    if (Test-Path -LiteralPath $ExistingPath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $ExistingPath) {
            if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
                Add-MissingSettings -Section $section
                $section = $Matches[1]
                if ($Settings.Contains($section)) { [void]$seenSections.Add($section) }
                $output.Add($line)
                continue
            }
            if ($Settings.Contains($section) -and $line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=') {
                $key = $Matches[1]
                if ($Settings[$section].Contains($key) -and -not $seenKeys[$section].Contains($key)) {
                    $output.Add("$key = $($Settings[$section][$key])")
                    [void]$seenKeys[$section].Add($key)
                    continue
                }
            }
            $output.Add($line)
        }
    }
    Add-MissingSettings -Section $section

    foreach ($settingSection in @('agents', 'features')) {
        if (-not $seenSections.Contains($settingSection)) {
            if ($output.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($output[$output.Count - 1])) { $output.Add('') }
            $output.Add("[$settingSection]")
            Add-MissingSettings -Section $settingSection
        }
    }
    Set-Content -LiteralPath $OutputPath -Value $output
}

function Assert-InstallTarget {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('File', 'Directory')][string]$Kind
    )

    Assert-NoReparsePoints -Path $Path
    if (-not (Test-ExistingPath -Path $Path)) { return }

    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to replace a symbolic link or junction: $Path"
    }
    if ($Kind -eq 'File' -and $item.PSIsContainer) {
        throw "Expected a regular file target: $Path"
    }
    if ($Kind -eq 'Directory') {
        if (-not $item.PSIsContainer) { throw "Expected a directory target: $Path" }
        Assert-NoReparsePointsInTree -Path $Path
    }
}

function Assert-InstallContainer {
    param([Parameter(Mandatory)][string]$Path)

    Assert-NoReparsePoints -Path $Path
    if (-not (Test-ExistingPath -Path $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) {
        throw "Expected a non-symbolic-link directory: $Path"
    }
}

function Invoke-InstallRollback {
    param(
        [Parameter(Mandatory)][System.Collections.IEnumerable]$Targets,
        [AllowNull()][string]$BackupDirectory,
        [Parameter(Mandatory)][string]$SkillsTarget,
        [Parameter(Mandatory)][bool]$SkillsParentCreated
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($target in $Targets) {
        if ($target.InstallStarted -and (Test-ExistingPath -Path $target.Target)) {
            try {
                Remove-Item -LiteralPath $target.Target -Recurse -Force
            } catch {
                $errors.Add("Could not remove installed target $($target.Target): $($_.Exception.Message)")
            }
        }
    }
    if ($null -ne $BackupDirectory) {
        foreach ($target in $Targets) {
            $backupTarget = Join-Path $BackupDirectory $target.Name
            if ($target.BackedUp -and (Test-ExistingPath -Path $backupTarget)) {
                try {
                    if (-not (Test-ExistingPath -Path $target.Target)) {
                        New-Item -ItemType Directory -Path (Split-Path -Parent $target.Target) -Force | Out-Null
                        Move-Item -LiteralPath $backupTarget -Destination $target.Target
                    }
                } catch {
                    $errors.Add("Could not restore target $($target.Target): $($_.Exception.Message)")
                }
            }
        }
    }
    if ($SkillsParentCreated -and (Test-Path -LiteralPath $SkillsTarget -PathType Container)) {
        try {
            Remove-Item -LiteralPath $SkillsTarget -Force
        } catch {
            $errors.Add("Could not remove newly created skills directory $SkillsTarget: $($_.Exception.Message)")
        }
    }
    return $errors
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$sourceAgents = Join-Path $scriptRoot 'codex-global-config\AGENTS.md'
$sourceConfig = Join-Path $scriptRoot 'codex-global-config\config.toml'
$sourceDocs = Join-Path $scriptRoot 'codex-global-config\docs'
$sourceSkills = Join-Path $scriptRoot 'skills'

if (-not (Test-Path -LiteralPath $sourceAgents -PathType Leaf)) { throw "Missing source file: $sourceAgents" }
if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) { throw "Missing source file: $sourceConfig" }
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
    'config.toml' = $sourceConfig
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

$installMutex = $null
$stageRoot = $null
$backupDirectory = $null
$skillsTarget = Join-Path $codexHome 'skills'
$skillsParentCreated = $false
$transactionTargets = [System.Collections.Generic.List[object]]::new()

try {
    New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
    $installMutex = Get-InstallMutex -CodexHome $codexHome
    $stageRoot = New-UniqueDirectory -Parent $codexHome -Prefix '.install-stage-'
    Copy-Item -LiteralPath $sourceAgents -Destination (Join-Path $stageRoot 'AGENTS.md') -Force
    Copy-Item -LiteralPath $sourceConfig -Destination (Join-Path $stageRoot 'template-config.toml') -Force
    Copy-Item -LiteralPath $sourceDocs -Destination (Join-Path $stageRoot 'docs') -Recurse -Force
    $stagedSkills = Join-Path $stageRoot 'skills'
    New-Item -ItemType Directory -Path $stagedSkills | Out-Null
    foreach ($skillName in $managedSkillNames) {
        Copy-Item -LiteralPath (Join-Path $sourceSkills $skillName) -Destination (Join-Path $stagedSkills $skillName) -Recurse -Force
    }

    foreach ($name in @('AGENTS.md', 'template-config.toml', 'docs')) {
        if (-not (Test-ExistingPath -Path (Join-Path $stageRoot $name))) { throw "Staging failed for: $name" }
    }
    foreach ($skillName in $managedSkillNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagedSkills $skillName) -PathType Container)) {
            throw "Staging failed for skill: $skillName"
        }
    }

    $configTarget = Join-Path $codexHome 'config.toml'
    $mergedConfig = Join-Path $stageRoot 'merged-config.toml'
    Assert-InstallTarget -Path $configTarget -Kind File
    $managedSettings = Get-ManagedTomlSettings -Path (Join-Path $stageRoot 'template-config.toml')
    Merge-ManagedTomlSettings -Settings $managedSettings -ExistingPath $configTarget -OutputPath $mergedConfig

    $transactionTargets.Add([pscustomobject]@{ Name = 'AGENTS.md'; Target = (Join-Path $codexHome 'AGENTS.md'); Candidate = (Join-Path $stageRoot 'AGENTS.md'); Kind = 'File'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    $transactionTargets.Add([pscustomobject]@{ Name = 'config.toml'; Target = $configTarget; Candidate = $mergedConfig; Kind = 'File'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    $transactionTargets.Add([pscustomobject]@{ Name = 'docs'; Target = (Join-Path $codexHome 'docs'); Candidate = (Join-Path $stageRoot 'docs'); Kind = 'Directory'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    foreach ($skillName in $managedSkillNames) {
        $transactionTargets.Add([pscustomobject]@{ Name = (Join-Path 'skills' $skillName); Target = (Join-Path $skillsTarget $skillName); Candidate = (Join-Path $stagedSkills $skillName); Kind = 'Directory'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    }

    # Validate every destination and the backup root before any managed target is replaced.
    Assert-InstallContainer -Path $skillsTarget
    $backupRoot = Join-Path $codexHome 'backups'
    Assert-InstallContainer -Path $backupRoot
    foreach ($target in $transactionTargets) {
        Assert-InstallTarget -Path $target.Target -Kind $target.Kind
        $target.WasPresent = Test-ExistingPath -Path $target.Target
    }

    if (-not (Test-Path -LiteralPath $skillsTarget -PathType Container)) {
        New-Item -ItemType Directory -Path $skillsTarget | Out-Null
        $skillsParentCreated = $true
    }
    if ($transactionTargets.Where({ $_.WasPresent }).Count -gt 0) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $backupDirectory = New-UniqueDirectory -Parent $backupRoot -Prefix 'backup-'
    }
    foreach ($target in $transactionTargets) {
        if ($target.WasPresent) {
            $backupTarget = Join-Path $backupDirectory $target.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
            Move-Item -LiteralPath $target.Target -Destination $backupTarget
            $target.BackedUp = $true
        }
        $target.InstallStarted = $true
        Move-Item -LiteralPath $target.Candidate -Destination $target.Target
    }

    Write-Host "Codex configuration installed in: $codexHome"
    if ($null -ne $backupDirectory) {
        Write-Host "Backup directory: $backupDirectory"
    } else {
        Write-Host 'Backup directory: none (no managed targets existed)'
    }
}
catch {
    $rollbackErrors = Invoke-InstallRollback -Targets $transactionTargets -BackupDirectory $backupDirectory -SkillsTarget $skillsTarget -SkillsParentCreated $skillsParentCreated
    foreach ($rollbackError in $rollbackErrors) {
        Write-Warning "$rollbackError Backup directory retained: $backupDirectory"
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
