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

function Get-NormalizedLfSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $sourceBytes = [System.IO.File]::ReadAllBytes($Path)
    $normalizedBytes = [System.Collections.Generic.List[byte]]::new()
    for ($index = 0; $index -lt $sourceBytes.Length; $index++) {
        if ($sourceBytes[$index] -eq 0x0D -and ($index + 1 -eq $sourceBytes.Length -or $sourceBytes[$index + 1] -eq 0x0A)) {
            if ($index + 1 -lt $sourceBytes.Length) {
                $normalizedBytes.Add(0x0A)
                $index++
            }
            continue
        }
        $normalizedBytes.Add($sourceBytes[$index])
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha256.ComputeHash($normalizedBytes.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha256.Dispose()
    }
}

function Assert-ManagedAgentRoleProfiles {
    param(
        [Parameter(Mandatory)][string]$RoleDirectory,
        [Parameter(Mandatory)][System.Collections.IEnumerable]$Contracts,
        [Parameter(Mandatory)][string]$ManifestPath
    )

    Assert-NoReparsePointsInTree -Path $RoleDirectory
    $contractList = @($Contracts)
    $expectedHashes = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in [System.IO.File]::ReadLines($ManifestPath)) {
        if ($line -notmatch '^([0-9a-f]{64}) {2}([^\s]+)$') {
            throw "Invalid managed agent role manifest: $ManifestPath"
        }
        if ($expectedHashes.ContainsKey($Matches[2])) {
            throw "Repeated managed agent role hash: $($Matches[2])"
        }
        $expectedHashes[$Matches[2]] = $Matches[1]
    }
    $expectedFileNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($contract in $contractList) {
        [void]$expectedFileNames.Add($contract.FileName)
        if (-not $expectedHashes.ContainsKey($contract.FileName)) {
            throw "Missing managed agent role hash: $($contract.FileName)"
        }
    }
    if ($expectedHashes.Count -ne $contractList.Count) { throw "Unexpected managed agent role manifest entry count: $ManifestPath" }

    $entries = @(Get-ChildItem -LiteralPath $RoleDirectory -Force)
    if ($entries.Count -ne $contractList.Count) {
        throw "Expected exactly $($contractList.Count) managed agent role files in: $RoleDirectory"
    }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or -not $expectedFileNames.Contains($entry.Name)) {
            throw "Unexpected managed agent role file: $($entry.FullName)"
        }
    }

    foreach ($contract in $contractList) {
        $rolePath = Join-Path $RoleDirectory $contract.FileName
        if (-not (Test-Path -LiteralPath $rolePath -PathType Leaf)) {
            throw "Missing managed agent role: $rolePath"
        }
        $actualHash = Get-NormalizedLfSha256 -Path $rolePath
        if ($actualHash -ne $expectedHashes[$contract.FileName]) {
            throw "Managed agent role content does not match its contract: $rolePath"
        }

        $expectedValues = @{
            'name' = $contract.RoleName
            'model' = $contract.Model
            'model_reasoning_effort' = $contract.ReasoningEffort
            'sandbox_mode' = $contract.SandboxMode
        }
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $descriptionCount = 0
        $developerInstructionsCount = 0
        $inDeveloperInstructions = $false

        foreach ($line in [System.IO.File]::ReadLines($rolePath)) {
            $trimmed = $line.Trim()
            if ($inDeveloperInstructions) {
                if ($trimmed -match '"""') {
                    if ($trimmed -ne '"""') {
                        throw "Invalid managed agent role contract: $rolePath"
                    }
                    $inDeveloperInstructions = $false
                }
                continue
            }
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
                continue
            }
            if ($trimmed -match '^developer_instructions\s*=\s*"""\s*$') {
                $developerInstructionsCount++
                if ($developerInstructionsCount -ne 1) {
                    throw "Invalid managed agent role contract: $rolePath"
                }
                $inDeveloperInstructions = $true
                continue
            }
            if ($trimmed -match '^description\s*=') {
                $descriptionCount++
                if ($descriptionCount -ne 1 -or $trimmed -notmatch '^description\s*=\s*"[^"]*"\s*$') {
                    throw "Invalid managed agent role contract: $rolePath"
                }
                continue
            }
            if ($trimmed -match '^(name|model|model_reasoning_effort|sandbox_mode)\s*=') {
                $key = $Matches[1]
                if (-not $seen.Add($key) -or $trimmed -ne ('{0} = "{1}"' -f $key, $expectedValues[$key])) {
                    throw "Invalid managed agent role contract: $rolePath"
                }
                continue
            }
            throw "Invalid managed agent role contract: $rolePath"
        }

        if ($inDeveloperInstructions -or $descriptionCount -ne 1 -or $developerInstructionsCount -ne 1) {
            throw "Invalid managed agent role contract: $rolePath"
        }
        foreach ($key in $expectedValues.Keys) {
            if (-not $seen.Contains($key)) {
                throw "Invalid managed agent role contract: $rolePath"
            }
        }
    }
}

function Assert-NoReservedAgentRoleNameConflict {
    param(
        [Parameter(Mandatory)][string]$AgentsDirectory,
        [Parameter(Mandatory)][string]$ManagedRoleDirectory
    )

    if (-not (Test-Path -LiteralPath $AgentsDirectory -PathType Container)) { return }
    Assert-NoReparsePointsInTree -Path $AgentsDirectory
    $managedPrefix = (Get-AbsolutePath -Path $ManagedRoleDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($role in Get-ChildItem -LiteralPath $AgentsDirectory -Recurse -File -Filter '*.toml' -Force) {
        if ($role.FullName.StartsWith($managedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        foreach ($line in [System.IO.File]::ReadLines($role.FullName)) {
            if ($line -match '^\s*(?:name|["'']name["''])\s*=\s*(?:["'']{1,3})(?:avsp_|\\u0061vsp_|\\U00000061vsp_)') {
                throw "User agent role uses the reserved avsp_ namespace: $($role.FullName)"
            }
        }
    }
}

function Get-InstallMutex {
    param([Parameter(Mandatory)][string]$CodexHome)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($CodexHome.ToUpperInvariant())
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    $name = 'Local\CodexInstaller-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
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

function Expand-CodexHomePlaceholders {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$CodexHome
    )

    $textExtensions = @('.md', '.toml', '.txt')
    foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
        if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
        $content = [System.IO.File]::ReadAllText($file.FullName)
        $expanded = $content.Replace('<CODEX_HOME>', $CodexHome).Replace('$CODEX_HOME', $CodexHome)
        if ($expanded -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $expanded, [System.Text.UTF8Encoding]::new($false))
        }
    }
}

function Remove-OldInstallBackups {
    param(
        [Parameter(Mandatory)][string]$BackupRoot,
        [ValidateRange(1, 100)][int]$Keep = 5
    )

    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) { return }
    Assert-InstallContainer -Path $BackupRoot
    $managedBackups = @(
        Get-ChildItem -LiteralPath $BackupRoot -Force -Directory |
            Where-Object {
                $_.Name -cmatch '^backup-[0-9]{8}-[0-9]{6}-[0-9a-f]{32}$' -and
                ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
            } |
            Sort-Object -Property Name -Descending
    )
    foreach ($backup in $managedBackups | Select-Object -Skip $Keep) {
        Assert-NoReparsePointsInTree -Path $backup.FullName
        Remove-Item -LiteralPath $backup.FullName -Recurse -Force
    }
}

function Get-ManagedTomlSettings {
    param([Parameter(Mandatory)][string]$Path)

    $settings = [ordered]@{
        '' = [ordered]@{
            'model' = $null
            'model_reasoning_effort' = $null
            'sandbox_mode' = $null
            'approval_policy' = $null
            'approvals_reviewer' = $null
        }
        'agents' = [ordered]@{
            'max_threads' = $null
            'max_depth' = $null
        }
        'features' = [ordered]@{
            'goals' = $null
        }
    }
    $section = ''
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -cmatch '^\s*\[\[[^\]]+\]\]\s*(?:#.*)?$') {
            $section = '__other__'
            continue
        }
        if ($line -cmatch '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $section = $Matches[1].Trim()
            continue
        }
        if (($settings.Keys -ccontains $section) -and $line -cmatch '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$') {
            $key = $Matches[1]
            if ($settings[$section].Keys -ccontains $key) {
                $settings[$section][$key] = $Matches[2].Trim()
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

        if (-not ($Settings.Keys -ccontains $Section)) { return }
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
            if ($line -cmatch '^\s*\[\[[^\]]+\]\]\s*(?:#.*)?$') {
                Add-MissingSettings -Section $section
                $section = '__other__'
                $output.Add($line)
                continue
            }
            if ($line -cmatch '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
                Add-MissingSettings -Section $section
                $section = $Matches[1].Trim()
                if ($Settings.Keys -ccontains $section) { [void]$seenSections.Add($section) }
                $output.Add($line)
                continue
            }
            if (($Settings.Keys -ccontains $section) -and $line -cmatch '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=') {
                $key = $Matches[1]
                if (($Settings[$section].Keys -ccontains $key) -and -not $seenKeys[$section].Contains($key)) {
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

function Assert-SafeTomlMergeInput {
    param([Parameter(Mandatory)][string]$Path)

    $section = ''
    $tableSeen = @{}
    $managedSeen = @{}
    $lineNumber = 0
    foreach ($line in [System.IO.File]::ReadLines($Path)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if ($trimmed.Contains('"""') -or $trimmed.Contains("'''")) {
            throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (multiline strings)"
        }
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed.StartsWith('[', [System.StringComparison]::Ordinal)) {
            $arrayTable = $trimmed.StartsWith('[[', [System.StringComparison]::Ordinal)
            $headerPattern = if ($arrayTable) { '^\[\[([^\]]+)\]\]\s*(?:#.*)?$' } else { '^\[([^\]]+)\]\s*(?:#.*)?$' }
            if ($trimmed -notmatch $headerPattern) {
                throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (ambiguous table header)"
            }
            $section = $Matches[1].Trim()
            if ($section.Contains('\') -and $section -cnotmatch '^[A-Za-z0-9_-]+\.') {
                throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (escaped table key)"
            }
            if ($arrayTable -and $section -cin @('agents', 'features')) {
                throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (managed table cannot be an array table)"
            }
            if ($section -cmatch '^["'']?(agents|features|model|model_reasoning_effort|sandbox_mode|approval_policy|approvals_reviewer)["'']?\s*(?:[.]|$)' -and $section -cnotin @('agents', 'features')) {
                throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (managed namespace table)"
            }
            if (-not $arrayTable -and $section -cin @('agents', 'features')) {
                $tableSeen[$section] = 1 + ($tableSeen[$section] ?? 0)
                if ($tableSeen[$section] -ne 1) { throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (repeated managed table)" }
            }
            continue
        }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (unrecognized line)" }
        $key = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1)
        $inBasicString = $false
        $inLiteralString = $false
        $arrayDepth = 0
        $tableDepth = 0
        for ($index = 0; $index -lt $value.Length; $index++) {
            $character = $value[$index]
            if ($inBasicString) {
                if ($character -eq '\') { $index++; continue }
                if ($character -eq '"') { $inBasicString = $false }
                continue
            }
            if ($inLiteralString) {
                if ($character -eq "'") { $inLiteralString = $false }
                continue
            }
            if ($character -eq '#') { break }
            if ($character -eq '"') { $inBasicString = $true; continue }
            if ($character -eq "'") { $inLiteralString = $true; continue }
            if ($character -eq '[') { $arrayDepth++; continue }
            if ($character -eq ']') { $arrayDepth--; continue }
            if ($character -eq '{') { $tableDepth++; continue }
            if ($character -eq '}') { $tableDepth--; continue }
        }
        if ($inBasicString -or $inLiteralString -or $arrayDepth -ne 0 -or $tableDepth -ne 0) {
            throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (cross-line or unclosed value)"
        }
        if ($key -cnotmatch '^[A-Za-z][A-Za-z0-9_-]*$') {
            if (($section -ceq '' -and ($key.Contains('\') -or $key -cmatch '^["'']?(model|model_reasoning_effort|sandbox_mode|approval_policy|approvals_reviewer|agents|features)["'']?\s*(?:$|[.])')) -or
                ($section -cin @('agents', 'features') -and $key -cmatch '^["'']?(max_threads|max_depth|goals)["'']?\s*(?:$|[.])')) {
                throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (quoted or dotted managed key)"
            }
            continue
        }
        if ($section -ceq '' -and $key -cin @('agents', 'features')) {
            throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (managed table cannot be a root key)"
        }
        $managed = ($section -ceq '' -and $key -cin @('model', 'model_reasoning_effort', 'sandbox_mode', 'approval_policy', 'approvals_reviewer')) -or
                   ($section -ceq 'agents' -and $key -cin @('max_threads', 'max_depth')) -or
                   ($section -ceq 'features' -and $key -ceq 'goals')
        if ($managed) {
            $managedKey = "$section/$key"
            $managedSeen[$managedKey] = 1 + ($managedSeen[$managedKey] ?? 0)
            if ($managedSeen[$managedKey] -ne 1) { throw "Unsupported TOML syntax for safe merge at $Path`:$lineNumber (repeated managed key)" }
        }
    }
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
        [Parameter(Mandatory)][string]$AgentsTarget,
        [Parameter(Mandatory)][bool]$AgentsParentCreated,
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
    if (-not [string]::IsNullOrWhiteSpace($BackupDirectory)) {
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
    if ($AgentsParentCreated -and (Test-Path -LiteralPath $AgentsTarget -PathType Container)) {
        try {
            if (@(Get-ChildItem -LiteralPath $AgentsTarget -Force).Count -eq 0) {
                Remove-Item -LiteralPath $AgentsTarget -Force
            }
        } catch {
            $errors.Add("Could not remove newly created agents directory ${AgentsTarget}: $($_.Exception.Message)")
        }
    }
    if ($SkillsParentCreated -and (Test-Path -LiteralPath $SkillsTarget -PathType Container)) {
        try {
            if (@(Get-ChildItem -LiteralPath $SkillsTarget -Force).Count -eq 0) {
                Remove-Item -LiteralPath $SkillsTarget -Force
            }
        } catch {
            $errors.Add("Could not remove newly created skills directory ${SkillsTarget}: $($_.Exception.Message)")
        }
    }
    return $errors
}

function Get-CodexCliPath {
    foreach ($commandName in @('codex.cmd', 'codex.exe')) {
        $command = Get-Command $commandName -All -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
            return $command.Source
        }
    }
    throw 'Codex CLI is required to install the managed plugin, but codex.cmd/codex.exe was not found.'
}

function Assert-WorkflowControllerNode {
    $nodeCommand = Get-Command node -All -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace($nodeCommand.Source)) {
        throw 'Node.js is required for the agnets-workflow workflow-controller MCP server, but the node command was not found.'
    }
    $nodePath = $nodeCommand.Source
    $nodeVersionText = (& $nodePath -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0) { throw "Cannot determine Node.js version from: $nodePath" }
    try { $nodeVersion = [System.Version]::Parse($nodeVersionText) }
    catch { throw "Cannot parse Node.js version '$nodeVersionText' from: $nodePath" }
    if ($nodeVersion -lt [System.Version]'22.5.0') {
        throw "Node.js 22.5.0 or newer is required for the native SQLite workflow controller; found $nodeVersionText at $nodePath"
    }
}

function Install-ManagedPlugin {
    param(
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$MarketplaceRoot,
        [Parameter(Mandatory)][string]$PluginName,
        [Parameter(Mandatory)][string]$MarketplaceName
    )

    $codexCli = Get-CodexCliPath
    Assert-WorkflowControllerNode
    $hadCodexHome = Test-Path Env:CODEX_HOME
    $previousCodexHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $CodexHome
        & $codexCli plugin marketplace add $MarketplaceRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not register plugin marketplace: $MarketplaceRoot" }
        $marketplaceOutput = (& $codexCli plugin marketplace list 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $marketplaceOutput -notmatch ('(?m)^\s*' + [System.Text.RegularExpressions.Regex]::Escape($MarketplaceName) + '\s+')) {
            throw "Codex did not retain marketplace registration after add: $MarketplaceName. Output: $marketplaceOutput"
        }
        & $codexCli plugin add "$PluginName@$MarketplaceName"
        if ($LASTEXITCODE -ne 0) { throw "Could not install managed plugin: $PluginName@$MarketplaceName" }
        $pluginIdentity = "$PluginName@$MarketplaceName"
        $pluginOutput = (& $codexCli plugin list 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $pluginOutput -notmatch [System.Text.RegularExpressions.Regex]::Escape($pluginIdentity)) {
            throw "Codex did not retain managed plugin installation after add: $pluginIdentity. Output: $pluginOutput"
        }
    } finally {
        if ($hadCodexHome) {
            $env:CODEX_HOME = $previousCodexHome
        } else {
            Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
        }
    }
}

function Remove-RetiredWorkflowPlugin {
    param([Parameter(Mandatory)][string]$CodexHome)

    $pluginId = 'workflow-controller@ai-vibecode-superpower-local'
    $configPath = Join-Path $CodexHome 'config.toml'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return }
    $escapedPluginId = [System.Text.RegularExpressions.Regex]::Escape($pluginId)
    $pattern = '^\s*\[plugins\.(?:"' + $escapedPluginId + '"|''' + $escapedPluginId + ''')\]\s*(?:#.*)?$'
    if (-not ([System.IO.File]::ReadAllLines($configPath) | Where-Object { $_ -match $pattern })) { return }

    $codexCli = Get-CodexCliPath
    $hadCodexHome = Test-Path Env:CODEX_HOME
    $previousCodexHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $CodexHome
        for ($attempt = 1; $attempt -le 8; $attempt++) {
            & $codexCli plugin remove $pluginId
            if ($LASTEXITCODE -eq 0) { return }
            $exitCode = $LASTEXITCODE
            if ($attempt -lt 8) { Start-Sleep -Seconds 1 }
        }
        throw "Could not remove retired workflow plugin after 8 attempts: $pluginId (exit code $exitCode)"
    } finally {
        if ($hadCodexHome) { $env:CODEX_HOME = $previousCodexHome }
        else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
    }
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$sourceAgents = Join-Path $scriptRoot 'codex-global-config\AGENTS.md'
$sourceConfig = Join-Path $scriptRoot 'codex-global-config\config.toml'
$sourceDocs = Join-Path $scriptRoot 'codex-global-config\docs'
$managedAgentRoleDirectoryName = 'ai-vibecode-superpower'
$sourceAgentRoles = Join-Path $scriptRoot "codex-global-config\agents\$managedAgentRoleDirectoryName"
$sourceAgentRoleManifest = Join-Path $scriptRoot 'codex-global-config\agents\ai-vibecode-superpower.sha256'
$managedAgentRoleContracts = @(
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_luna_high.toml'; RoleName = 'avsp_luna_high'; Model = 'gpt-5.6-luna'; ReasoningEffort = 'high'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_luna_xhigh.toml'; RoleName = 'avsp_luna_xhigh'; Model = 'gpt-5.6-luna'; ReasoningEffort = 'xhigh'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_luna_high_executor.toml'; RoleName = 'avsp_luna_high_executor'; Model = 'gpt-5.6-luna'; ReasoningEffort = 'high'; SandboxMode = 'danger-full-access' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_luna_xhigh_executor.toml'; RoleName = 'avsp_luna_xhigh_executor'; Model = 'gpt-5.6-luna'; ReasoningEffort = 'xhigh'; SandboxMode = 'danger-full-access' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_sol_high.toml'; RoleName = 'avsp_sol_high'; Model = 'gpt-5.6-sol'; ReasoningEffort = 'high'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_sol_max.toml'; RoleName = 'avsp_sol_max'; Model = 'gpt-5.6-sol'; ReasoningEffort = 'max'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_sol_xhigh.toml'; RoleName = 'avsp_sol_xhigh'; Model = 'gpt-5.6-sol'; ReasoningEffort = 'xhigh'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_terra_high.toml'; RoleName = 'avsp_terra_high'; Model = 'gpt-5.6-terra'; ReasoningEffort = 'high'; SandboxMode = 'danger-full-access' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_terra_xhigh.toml'; RoleName = 'avsp_terra_xhigh'; Model = 'gpt-5.6-terra'; ReasoningEffort = 'xhigh'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml'; RoleName = 'avsp_terra_xhigh_readonly'; Model = 'gpt-5.6-terra'; ReasoningEffort = 'xhigh'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_terra_low_readonly.toml'; RoleName = 'avsp_terra_low_readonly'; Model = 'gpt-5.6-terra'; ReasoningEffort = 'low'; SandboxMode = 'read-only' }
    [pscustomobject]@{ FileName = 'ai-vibecode-superpower-avsp_terra_medium_readonly.toml'; RoleName = 'avsp_terra_medium_readonly'; Model = 'gpt-5.6-terra'; ReasoningEffort = 'medium'; SandboxMode = 'read-only' }
)
$managedPluginName = 'agnets-workflow'
$managedMarketplaceName = 'ai-vibecode-superpower-local'
$sourcePlugin = Join-Path $scriptRoot "plugins\$managedPluginName"
$sourceMarketplace = Join-Path $scriptRoot '.agents\plugins\marketplace.json'
$sourcePluginSkills = Join-Path $sourcePlugin 'skills'
$sourceStandaloneSkills = Join-Path $scriptRoot 'skills'
$managedPluginSkillNames = @(
    'agent-toolchain'
    'orchestrate-model-workflow'
    'workflow-controller'
)
$legacyPluginSkillNamesToRemove = @('adaptive-efficiency')
$managedStandaloneSkillNames = @(
    'gpt-image-2-cli'
    'project-doc-planner'
)

if (-not (Test-Path -LiteralPath $sourceAgents -PathType Leaf)) { throw "Missing source file: $sourceAgents" }
if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) { throw "Missing source file: $sourceConfig" }
if (-not (Test-Path -LiteralPath $sourceDocs -PathType Container)) { throw "Missing source directory: $sourceDocs" }
if (-not (Test-Path -LiteralPath $sourceAgentRoles -PathType Container)) { throw "Missing source directory: $sourceAgentRoles" }
if (-not (Test-Path -LiteralPath $sourceAgentRoleManifest -PathType Leaf)) { throw "Missing source file: $sourceAgentRoleManifest" }
if (-not (Test-Path -LiteralPath $sourceMarketplace -PathType Leaf)) { throw "Missing source file: $sourceMarketplace" }
if (-not (Test-Path -LiteralPath $sourcePlugin -PathType Container)) { throw "Missing source directory: $sourcePlugin" }
Assert-ManagedAgentRoleProfiles -RoleDirectory $sourceAgentRoles -Contracts $managedAgentRoleContracts -ManifestPath $sourceAgentRoleManifest
if (-not (Test-Path -LiteralPath $sourcePluginSkills -PathType Container)) { throw "Missing source directory: $sourcePluginSkills" }
if (-not (Test-Path -LiteralPath $sourceStandaloneSkills -PathType Container)) { throw "Missing source directory: $sourceStandaloneSkills" }
foreach ($skillName in $managedPluginSkillNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePluginSkills $skillName) -PathType Container)) {
        throw "Missing managed plugin skill: $skillName"
    }
}
foreach ($skillName in $managedStandaloneSkillNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceStandaloneSkills $skillName) -PathType Container)) {
        throw "Missing managed standalone skill: $skillName"
    }
}

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

$agentsTarget = Join-Path $codexHome 'agents'
$targetAgentRoles = Join-Path $agentsTarget $managedAgentRoleDirectoryName

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
if (Test-SamePath -Left $targetAgentRoles -Right $sourceAgentRoles) {
    throw "Destination target overlaps its source: $targetAgentRoles"
}

$installMutex = $null
$stageRoot = $null
$backupDirectory = $null
$skillsTarget = Join-Path $codexHome 'skills'
$agentsParentCreated = $false
$skillsParentCreated = $false
$transactionTargets = [System.Collections.Generic.List[object]]::new()

try {
    New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
    $installMutex = Get-InstallMutex -CodexHome $codexHome
    $stageRoot = New-UniqueDirectory -Parent $codexHome -Prefix '.install-stage-'
    Copy-Item -LiteralPath $sourceAgents -Destination (Join-Path $stageRoot 'AGENTS.md') -Force
    Copy-Item -LiteralPath $sourceConfig -Destination (Join-Path $stageRoot 'template-config.toml') -Force
    Copy-Item -LiteralPath $sourceDocs -Destination (Join-Path $stageRoot 'docs') -Recurse -Force
    $stagedAgents = Join-Path $stageRoot 'agents'
    New-Item -ItemType Directory -Path $stagedAgents | Out-Null
    $stagedAgentRoles = Join-Path $stagedAgents $managedAgentRoleDirectoryName
    Copy-Item -LiteralPath $sourceAgentRoles -Destination $stagedAgentRoles -Recurse -Force
    $stagedStandaloneSkills = Join-Path $stageRoot 'skills'
    New-Item -ItemType Directory -Path $stagedStandaloneSkills | Out-Null
    foreach ($skillName in $managedStandaloneSkillNames) {
        Copy-Item -LiteralPath (Join-Path $sourceStandaloneSkills $skillName) -Destination (Join-Path $stagedStandaloneSkills $skillName) -Recurse -Force
    }
    Expand-CodexHomePlaceholders -Root $stageRoot -CodexHome $codexHome
    foreach ($name in @('AGENTS.md', 'template-config.toml', 'docs', (Join-Path 'agents' $managedAgentRoleDirectoryName))) {
        if (-not (Test-ExistingPath -Path (Join-Path $stageRoot $name))) { throw "Staging failed for: $name" }
    }
    Assert-ManagedAgentRoleProfiles -RoleDirectory $stagedAgentRoles -Contracts $managedAgentRoleContracts -ManifestPath $sourceAgentRoleManifest
    foreach ($skillName in $managedStandaloneSkillNames) {
        if (-not (Test-ExistingPath -Path (Join-Path $stagedStandaloneSkills $skillName))) { throw "Staging failed for standalone skill: $skillName" }
    }

    $configTarget = Join-Path $codexHome 'config.toml'
    $mergedConfig = Join-Path $stageRoot 'merged-config.toml'
    Assert-InstallTarget -Path $configTarget -Kind File
    Assert-SafeTomlMergeInput -Path (Join-Path $stageRoot 'template-config.toml')
    if (Test-Path -LiteralPath $configTarget -PathType Leaf) { Assert-SafeTomlMergeInput -Path $configTarget }
    $managedSettings = Get-ManagedTomlSettings -Path (Join-Path $stageRoot 'template-config.toml')
    Merge-ManagedTomlSettings -Settings $managedSettings -ExistingPath $configTarget -OutputPath $mergedConfig
    Assert-SafeTomlMergeInput -Path $mergedConfig

    $transactionTargets.Add([pscustomobject]@{ Name = 'AGENTS.md'; Target = (Join-Path $codexHome 'AGENTS.md'); Candidate = (Join-Path $stageRoot 'AGENTS.md'); Kind = 'File'; Operation = 'Replace'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    $transactionTargets.Add([pscustomobject]@{ Name = 'config.toml'; Target = $configTarget; Candidate = $mergedConfig; Kind = 'File'; Operation = 'Replace'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    $transactionTargets.Add([pscustomobject]@{ Name = 'docs'; Target = (Join-Path $codexHome 'docs'); Candidate = (Join-Path $stageRoot 'docs'); Kind = 'Directory'; Operation = 'Replace'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    $transactionTargets.Add([pscustomobject]@{ Name = (Join-Path 'agents' $managedAgentRoleDirectoryName); Target = $targetAgentRoles; Candidate = $stagedAgentRoles; Kind = 'Directory'; Operation = 'Replace'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    foreach ($skillName in $managedStandaloneSkillNames) {
        $sourceSkill = Join-Path $sourceStandaloneSkills $skillName
        $targetSkill = Join-Path $skillsTarget $skillName
        if (Test-SamePath -Left $targetSkill -Right $sourceSkill) { throw "Destination target overlaps its source: $targetSkill" }
        $transactionTargets.Add([pscustomobject]@{ Name = (Join-Path 'skills' $skillName); Target = $targetSkill; Candidate = (Join-Path $stagedStandaloneSkills $skillName); Kind = 'Directory'; Operation = 'Replace'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    }
    foreach ($skillName in $managedPluginSkillNames) {
        $transactionTargets.Add([pscustomobject]@{ Name = (Join-Path 'skills' $skillName); Target = (Join-Path $skillsTarget $skillName); Candidate = $null; Kind = 'Directory'; Operation = 'Remove'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    }
    foreach ($legacySkillName in $legacyPluginSkillNamesToRemove) {
        $transactionTargets.Add([pscustomobject]@{ Name = (Join-Path 'skills' $legacySkillName); Target = (Join-Path $skillsTarget $legacySkillName); Candidate = $null; Kind = 'Directory'; Operation = 'Remove'; WasPresent = $false; BackedUp = $false; InstallStarted = $false })
    }

    # Validate every destination and the backup root before any managed target is replaced or removed.
    Assert-InstallContainer -Path $agentsTarget
    Assert-NoReservedAgentRoleNameConflict -AgentsDirectory $agentsTarget -ManagedRoleDirectory $targetAgentRoles
    Assert-InstallContainer -Path $skillsTarget
    $backupRoot = Join-Path $codexHome 'backups'
    Assert-InstallContainer -Path $backupRoot
    foreach ($target in $transactionTargets) {
        Assert-InstallTarget -Path $target.Target -Kind $target.Kind
        $target.WasPresent = Test-ExistingPath -Path $target.Target
    }

    if (-not (Test-Path -LiteralPath $agentsTarget -PathType Container)) {
        New-Item -ItemType Directory -Path $agentsTarget | Out-Null
        $agentsParentCreated = $true
    }
    if (-not (Test-Path -LiteralPath $skillsTarget -PathType Container)) {
        New-Item -ItemType Directory -Path $skillsTarget | Out-Null
        $skillsParentCreated = $true
    }
    if ($transactionTargets.Where({ $_.WasPresent }).Count -gt 0) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $backupDirectory = New-UniqueDirectory -Parent $backupRoot -Prefix 'backup-'
    }
    foreach ($target in $transactionTargets.Where({ $_.Operation -eq 'Replace' })) {
        if ($target.WasPresent) {
            $backupTarget = Join-Path $backupDirectory $target.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
            Move-Item -LiteralPath $target.Target -Destination $backupTarget
            $target.BackedUp = $true
        }
        $target.InstallStarted = $true
        if ($target.Operation -eq 'Replace') {
            Move-Item -LiteralPath $target.Candidate -Destination $target.Target
        }
    }

    # Plugin commands update config.toml. Run them only after its staged version
    # is installed, while the transaction can still restore the previous config.
    Install-ManagedPlugin -CodexHome $codexHome -MarketplaceRoot $scriptRoot -PluginName $managedPluginName -MarketplaceName $managedMarketplaceName

    # Do not leave the retired controller installed beside the v3-only plugin.
    Remove-RetiredWorkflowPlugin -CodexHome $codexHome

    foreach ($target in $transactionTargets.Where({ $_.Operation -eq 'Remove' })) {
        if ($target.WasPresent) {
            $backupTarget = Join-Path $backupDirectory $target.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
            Move-Item -LiteralPath $target.Target -Destination $backupTarget
            $target.BackedUp = $true
        }
        $target.InstallStarted = $true
    }

    # Re-validate the installed role directory, not only the staging copy.
    # Codex Desktop/CLI loads role profiles at process start and does not hot-reload them.
    Assert-ManagedAgentRoleProfiles -RoleDirectory $targetAgentRoles -Contracts $managedAgentRoleContracts -ManifestPath $sourceAgentRoleManifest

    Write-Host "Codex configuration installed in: $codexHome"
    Write-Host "Managed plugin installed: $managedPluginName@$managedMarketplaceName"
    Write-Host 'Managed standalone skills installed; obsolete global copies of plugin skills removed.'
    if ($null -ne $backupDirectory) {
        Write-Host "Backup directory: $backupDirectory"
    } else {
        Write-Host 'Backup directory: none (no managed targets existed)'
    }
    try {
        Remove-OldInstallBackups -BackupRoot $backupRoot -Keep 5
    } catch {
        Write-Warning "Installed successfully, but old backup retention could not complete: $($_.Exception.Message)"
    }
    Write-Warning 'Restart Codex Desktop/CLI before starting a new workflow so newly installed agent roles are loaded.'
}
catch {
    $rollbackErrors = Invoke-InstallRollback -Targets $transactionTargets -BackupDirectory $backupDirectory -AgentsTarget $agentsTarget -AgentsParentCreated $agentsParentCreated -SkillsTarget $skillsTarget -SkillsParentCreated $skillsParentCreated
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
