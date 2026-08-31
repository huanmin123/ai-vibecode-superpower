[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedHash([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $out = [Collections.Generic.List[byte]]::new()
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 13 -and $i + 1 -lt $bytes.Length -and $bytes[$i + 1] -eq 10) { $out.Add(10); $i++ } else { $out.Add($bytes[$i]) }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($out.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

function Assert-NoReparse([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $Path" }
    if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $Path -Force | ForEach-Object { Assert-NoReparse $_.FullName } }
}

function Assert-NoReparseChain([string]$Path) {
    $currentPath = [IO.Path]::GetFullPath($Path)
    while ($currentPath -and -not (Test-Path -LiteralPath $currentPath)) {
        $parentPath = Split-Path -Parent $currentPath
        if ([string]::IsNullOrEmpty($parentPath) -or $parentPath -eq $currentPath) { break }
        $currentPath = $parentPath
    }
    while ($currentPath -and (Test-Path -LiteralPath $currentPath)) {
        $current = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $($current.FullName)" }
        $parentPath = Split-Path -Parent $currentPath
        if ([string]::IsNullOrEmpty($parentPath) -or $parentPath -eq $currentPath) { break }
        $currentPath = $parentPath
    }
}

function Assert-InstallContainer([string]$Path) {
    Assert-NoReparseChain $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { throw "Expected a non-reparse directory: $Path" }
}

function Assert-InstallTarget([string]$Path, [ValidateSet('File', 'Directory')][string]$Kind) {
    Assert-NoReparseChain $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing to replace reparse point: $Path" }
    if ($Kind -eq 'File' -and $item.PSIsContainer) { throw "Expected a regular file target: $Path" }
    if ($Kind -eq 'Directory' -and -not $item.PSIsContainer) { throw "Expected a directory target: $Path" }
    if ($Kind -eq 'Directory') { Assert-NoReparse $Path }
}

function Assert-RoleProfiles([string]$Directory, [string]$Manifest) {
    $hashes = @{}
    foreach ($line in Get-Content -LiteralPath $Manifest) {
        if ($line -notmatch '^([0-9a-f]{64}) {2}([^\s]+)$') { throw "Invalid role manifest: $Manifest" }
        $hashes[$Matches[2]] = $Matches[1]
    }
    if ($hashes.Count -ne 12) { throw 'Expected 12 managed role hashes' }
    $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.toml' -File)
    if ($files.Count -ne 12) { throw 'Expected 12 managed role files' }
    foreach ($file in $files) {
        if (-not $hashes.ContainsKey($file.Name) -or (Get-NormalizedHash $file.FullName) -ne $hashes[$file.Name]) { throw "Role hash mismatch: $($file.Name)" }
        $text = Get-Content -LiteralPath $file.FullName -Raw
        foreach ($key in 'name', 'model', 'model_reasoning_effort', 'sandbox_mode', 'description', 'developer_instructions') {
            if ($text -notmatch "(?m)^$key\s*=") { throw "Role field missing: $($file.Name)/$key" }
        }
    }
}

function Assert-SafeTomlMergeInput([string]$Path) {
    function ConvertFrom-SafeQuotedTomlKey([string]$Key) {
        if ($Key.Length -lt 2) { return $null }
        $quote = $Key[0]
        if ($quote -ne '"' -and $quote -ne "'") { return $null }
        if ($Key[$Key.Length - 1] -ne $quote) { return $null }
        $decoded = [Text.StringBuilder]::new()
        for ($i = 1; $i -lt $Key.Length - 1; $i++) {
            $character = $Key[$i]
            if ([int][char]$character -lt 32 -or [int][char]$character -eq 127) { return $null }
            if ($quote -eq "'") {
                if ($character -eq "'") { return $null }
                [void]$decoded.Append($character)
                continue
            }
            if ($character -eq '"') { return $null }
            if ($character -ne '\') { [void]$decoded.Append($character); continue }
            $i++
            if ($i -ge $Key.Length - 1) { return $null }
            $character = $Key[$i]
            if ($character -eq 'u' -or $character -eq 'U') {
                $count = if ($character -eq 'u') { 4 } else { 8 }
                if ($i + $count -ge $Key.Length - 1) { return $null }
                $hex = $Key.Substring($i + 1, $count)
                for ($digit = 1; $digit -le $count; $digit++) {
                    if ($Key[$i + $digit] -notmatch '^[0-9A-Fa-f]$') { return $null }
                }
                $codePoint = [Convert]::ToUInt32($hex, 16)
                if ($codePoint -gt 0x10FFFF -or ($codePoint -ge 0xD800 -and $codePoint -le 0xDFFF)) { return $null }
                [void]$decoded.Append([char]::ConvertFromUtf32($codePoint))
                $i += $count
            } elseif ($character -eq '"' -or $character -eq '\') {
                [void]$decoded.Append($character)
            } elseif ($character -in @('b','t','n','f','r')) {
                $escaped = switch ($character) { 'b' { [char]8 } 't' { "`t" } 'n' { "`n" } 'f' { [char]12 } 'r' { "`r" } }
                [void]$decoded.Append($escaped)
            } else {
                return $null
            }
        }
        return [pscustomobject]@{ Value = $decoded.ToString() }
    }
    function Find-TomlAssignmentSeparator([string]$Line) {
        $basic = $false; $literal = $false
        for ($i = 0; $i -lt $Line.Length; $i++) {
            $character = $Line[$i]
            if ($basic) {
                if ($character -eq '\') { $i++ } elseif ($character -eq '"') { $basic = $false }
                continue
            }
            if ($literal) {
                if ($character -eq "'") { $literal = $false }
                continue
            }
            if ($character -eq '"') { $basic = $true }
            elseif ($character -eq "'") { $literal = $true }
            elseif ($character -eq '=') { return $i }
        }
        return -1
    }
    function Test-ClosedTomlValue([string]$Value) {
        $basic = $false; $literal = $false; $arrayDepth = 0; $inlineDepth = 0
        for ($i = 0; $i -lt $Value.Length; $i++) {
            $character = $Value[$i]
            if ($basic) {
                if ($character -eq '\') { $i++ } elseif ($character -eq '"') { $basic = $false }
                continue
            }
            if ($literal) {
                if ($character -eq "'") { $literal = $false }
                continue
            }
            if ($character -eq '"') { $basic = $true }
            elseif ($character -eq "'") { $literal = $true }
            elseif ($character -eq '[') { $arrayDepth++ }
            elseif ($character -eq ']') { $arrayDepth-- }
            elseif ($character -eq '{') { $inlineDepth++ }
            elseif ($character -eq '}') { $inlineDepth-- }
            if ($arrayDepth -lt 0 -or $inlineDepth -lt 0) { return $false }
        }
        return -not $basic -and -not $literal -and $arrayDepth -eq 0 -and $inlineDepth -eq 0
    }
    $section = 'root'; $seen = @{}
    foreach ($line in [IO.File]::ReadLines($Path)) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed.Contains('"""') -or $trimmed.Contains("'''")) { throw "Unsupported multiline TOML in $Path" }
        if ($trimmed.StartsWith('[[')) {
            if ($trimmed -notmatch '^\[\[[^\]]+\]\]\s*(#.*)?$') { throw ('Unsupported TOML array table header in ' + $Path + ': ' + $trimmed) }
            $section = '__array__'; continue
        }
        if ($trimmed.StartsWith('[')) {
            if ($trimmed -notmatch '^\[[^\]]+\]\s*(#.*)?$') { throw ('Unsupported TOML table header in ' + $Path + ': ' + $trimmed) }
            $header = $trimmed.Substring(1, $trimmed.IndexOf(']') - 1)
            $section = $header.Trim(); continue
        }
        $separator = Find-TomlAssignmentSeparator $trimmed
        if ($separator -lt 0) { throw "Unsupported TOML line in ${Path}: $line" }
        $key = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1)
        if (-not (Test-ClosedTomlValue $value)) { throw ('Unsupported TOML value syntax in ' + $Path + ': ' + $value) }
        $keyIdentity = $key
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9_-]*$') {
            $quotedKey = ConvertFrom-SafeQuotedTomlKey $key
            if ($null -eq $quotedKey) { throw ('Unsupported TOML key syntax in ' + $Path + ': ' + $key) }
            $keyIdentity = $quotedKey.Value
        }
        $managed = ($section -eq 'root' -and $keyIdentity -in @('model','model_reasoning_effort','sandbox_mode','approval_policy','approvals_reviewer')) -or
            ($section -eq 'agents' -and $keyIdentity -in @('max_threads','max_depth')) -or
            ($section -eq 'features' -and $keyIdentity -eq 'goals')
        if ($managed) {
            if ($key -ne $keyIdentity) { throw "Quoted TOML key aliases a managed key in ${Path}: $section/$key" }
            $identity = "$section/$keyIdentity"
            if ($seen.ContainsKey($identity)) { throw "Repeated managed TOML key in ${Path}: $identity" }
            $seen[$identity] = $true
        }
    }
}

function Get-ManagedConfigValues([string]$Path) {
    $values = [ordered]@{
        root = [ordered]@{ model = $null; model_reasoning_effort = $null; sandbox_mode = $null; approval_policy = $null; approvals_reviewer = $null }
        agents = [ordered]@{ max_threads = $null; max_depth = $null }
        features = [ordered]@{ goals = $null }
    }
    $section = 'root'
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*\[\[([^\]]+)\]\]') { $section = '__array__'; continue }
        if ($line -match '^\s*\[([^\]]+)\]') { $section = $Matches[1].Trim(); continue }
        if ($values.Contains($section) -and $line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$') {
            $key = $Matches[1]
            if ($values[$section].Contains($key)) { $values[$section][$key] = $Matches[2].Trim() }
        }
    }
    foreach ($sectionName in $values.Keys) { foreach ($key in $values[$sectionName].Keys) { if ([string]::IsNullOrWhiteSpace($values[$sectionName][$key])) { throw "Missing managed config setting: $sectionName/$key" } } }
    return $values
}

function Get-ProviderSettings([string]$Path) {
    $values = [ordered]@{ request_max_retries = $null; stream_max_retries = $null; stream_idle_timeout_ms = $null; websocket_connect_timeout_ms = $null }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$' -and $values.Contains($Matches[1])) { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    foreach ($key in $values.Keys) { if ([string]::IsNullOrWhiteSpace($values[$key])) { throw "Missing provider setting: $key" } }
    return $values
}

function Merge-Config([string]$Template, [string]$Existing, [string]$Provider, [string]$Output) {
    Assert-SafeTomlMergeInput $Template
    Assert-SafeTomlMergeInput $Provider
    if (Test-Path -LiteralPath $Existing -PathType Leaf) { Assert-SafeTomlMergeInput $Existing }
    $managed = Get-ManagedConfigValues $Template
    $providerValues = Get-ProviderSettings $Provider
    $lines = [Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $Existing -PathType Leaf) { Get-Content -LiteralPath $Existing | ForEach-Object { $lines.Add($_) } } else { Get-Content -LiteralPath $Template | ForEach-Object { $lines.Add($_) } }
    $outputLines = [Collections.Generic.List[string]]::new()
    $seen = @{ root = @{}; agents = @{}; features = @{} }
    $seenSections = @{}
    $section = 'root'; $providerSection = $false; $providerSeen = @{}; $providerFound = $false
    $flush = {
        param([string]$name)
        if ($name -eq 'root' -or $name -eq 'agents' -or $name -eq 'features') {
            foreach ($key in $managed[$name].Keys) { if (-not $seen[$name].ContainsKey($key)) { $outputLines.Add("$key = $($managed[$name][$key])"); $seen[$name][$key] = $true } }
        }
        if ($providerSection) {
            foreach ($key in $providerValues.Keys) { if (-not $providerSeen.ContainsKey($key)) { $outputLines.Add("$key = $($providerValues[$key])"); $providerSeen[$key] = $true } }
        }
    }
    foreach ($line in $lines) {
        if ($line -match '^\s*\[\[([^\]]+)\]\]') { & $flush $section; $section = '__array__'; $providerSection = $false; $providerSeen = @{}; $outputLines.Add($line); continue }
        if ($line -match '^\s*\[([^\]]+)\]') {
            & $flush $section
            $header = $Matches[1].Trim()
            $section = if ($header -in @('agents','features')) { $header } else { '__other__' }
            if ($section -in @('agents','features')) { $seenSections[$section] = $true }
            $providerSection = $header -match '^model_providers\.(?:[A-Za-z0-9_-]+|"[^"]+"|''[^'']+'')$'
            if ($providerSection) { $providerFound = $true }
            $providerSeen = @{}
            $outputLines.Add($line); continue
        }
        if ($providerSection -and $line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=') {
            $key = $Matches[1]
            if ($providerValues.Contains($key)) { $outputLines.Add("$key = $($providerValues[$key])"); $providerSeen[$key] = $true; continue }
        }
        if (($section -eq 'root' -or $section -eq 'agents' -or $section -eq 'features') -and $line -match '^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=') {
            $key = $Matches[1]
            if ($managed[$section].Contains($key)) { $outputLines.Add("$key = $($managed[$section][$key])"); $seen[$section][$key] = $true; continue }
        }
        $outputLines.Add($line)
    }
    & $flush $section
    foreach ($table in 'agents','features') {
        if (-not $seenSections.ContainsKey($table)) { if ($outputLines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($outputLines[$outputLines.Count - 1])) { $outputLines.Add('') }; $outputLines.Add("[$table]"); foreach ($key in $managed[$table].Keys) { $outputLines.Add("$key = $($managed[$table][$key])") } }
    }
    if (-not $providerFound) { Write-Warning "No [model_providers.<provider-id>] table found in $Existing; skipped provider settings." }
    Set-Content -LiteralPath $Output -Value $outputLines -Encoding utf8
}

function Expand-Placeholders([string]$Directory, [string]$CodexRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File) {
        if ($file.Extension.ToLowerInvariant() -notin @('.md','.toml','.txt')) { continue }
        $text = [IO.File]::ReadAllText($file.FullName)
        $expanded = $text.Replace('<CODEX_HOME>', $CodexRoot).Replace('$CODEX_HOME', $CodexRoot)
        if ($expanded -ne $text) { [IO.File]::WriteAllText($file.FullName, $expanded, [Text.UTF8Encoding]::new($false)) }
    }
}

$root = Split-Path -Parent $PSCommandPath
$profilePath = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$homePath = if ($env:CODEX_HOME) { [IO.Path]::GetFullPath($env:CODEX_HOME) } else { [IO.Path]::GetFullPath((Join-Path $profilePath '.codex')) }
if ([string]::IsNullOrWhiteSpace($homePath) -or [IO.Path]::GetPathRoot($homePath).TrimEnd('\') -eq $homePath.TrimEnd('\')) { throw "Refusing unsafe Codex home: $homePath" }
$sourceRoles = Join-Path $root 'codex-global-config\agents\ai-vibecode-superpower'
$sourceManifest = Join-Path $root 'codex-global-config\agents\ai-vibecode-superpower.sha256'
$sourceDocs = Join-Path $root 'codex-global-config\docs'
$sourceAgents = Join-Path $root 'codex-global-config\AGENTS.md'
$sourceConfig = Join-Path $root 'codex-global-config\config.toml'
$sourceProvider = Join-Path $root 'codex-global-config\model-provider-settings.toml'
$sourceSkills = Join-Path $root 'skills'
$skillNames = @('agent-toolchain','gpt-image-2-cli','project-doc-planner','orchestrate-model-workflow')
foreach ($path in @($sourceRoles,$sourceManifest,$sourceDocs,$sourceAgents,$sourceConfig,$sourceProvider,$sourceSkills)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing source: $path" } }
foreach ($name in $skillNames) { if (-not (Test-Path -LiteralPath (Join-Path $sourceSkills $name) -PathType Container)) { throw "Missing skill: $name" } }
Assert-RoleProfiles $sourceRoles $sourceManifest
Assert-NoReparseChain $root
Assert-NoReparse $root
Assert-NoReparseChain $homePath

$existingConfig = Join-Path $homePath 'config.toml'

$stage = Join-Path $homePath ('.install-stage-' + [Guid]::NewGuid().ToString('N'))
$backup = $null
$targets = @(
    @{ Name='AGENTS.md'; Target=(Join-Path $homePath 'AGENTS.md'); Candidate=(Join-Path $stage 'AGENTS.md'); Kind='File'; BackedUp=$false; InstallStarted=$false },
    @{ Name='config.toml'; Target=$existingConfig; Candidate=(Join-Path $stage 'config.toml'); Kind='File'; BackedUp=$false; InstallStarted=$false },
    @{ Name='docs'; Target=(Join-Path $homePath 'docs'); Candidate=(Join-Path $stage 'docs'); Kind='Directory'; BackedUp=$false; InstallStarted=$false },
    @{ Name='agents/ai-vibecode-superpower'; Target=(Join-Path $homePath 'agents\ai-vibecode-superpower'); Candidate=(Join-Path $stage 'agents\ai-vibecode-superpower'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
)
foreach ($name in $skillNames) { $targets += @{ Name="skills/$name"; Target=(Join-Path $homePath "skills\$name"); Candidate=(Join-Path $stage "skills\$name"); Kind='Directory'; BackedUp=$false; InstallStarted=$false } }
foreach ($target in $targets) { Assert-InstallTarget $target.Target $target.Kind }
foreach ($container in @((Join-Path $homePath 'agents'),(Join-Path $homePath 'skills'),(Join-Path $homePath 'backups'))) { Assert-InstallContainer $container }

try {
    New-Item -ItemType Directory -Path $homePath -Force | Out-Null
    Assert-NoReparseChain $homePath
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'agents') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'skills') -Force | Out-Null
    Copy-Item $sourceAgents (Join-Path $stage 'AGENTS.md')
    Copy-Item $sourceDocs (Join-Path $stage 'docs') -Recurse
    Copy-Item $sourceRoles (Join-Path $stage 'agents') -Recurse
    foreach ($name in $skillNames) { Copy-Item (Join-Path $sourceSkills $name) (Join-Path $stage 'skills') -Recurse }
    Merge-Config $sourceConfig $existingConfig $sourceProvider (Join-Path $stage 'config.toml')
    Expand-Placeholders $stage $homePath
    Assert-RoleProfiles (Join-Path $stage 'agents\ai-vibecode-superpower') $sourceManifest

    $backupRoot = Join-Path $homePath 'backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Assert-InstallContainer $backupRoot
    $backup = Join-Path $backupRoot ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target.Target) {
            $backupTarget = Join-Path $backup $target.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
            Move-Item -LiteralPath $target.Target -Destination $backupTarget
            $target.BackedUp = $true
        }
        if ($null -ne $target.Candidate) {
            $target.InstallStarted = $true
            New-Item -ItemType Directory -Path (Split-Path -Parent $target.Target) -Force | Out-Null
            Move-Item -LiteralPath $target.Candidate -Destination $target.Target
        }
    }
    Assert-RoleProfiles (Join-Path $homePath 'agents\ai-vibecode-superpower') $sourceManifest
    Write-Host "Codex configuration installed in: $homePath"
    Write-Host 'Standalone skills and managed agent roles installed.'
    Write-Host "Backup directory: $backup"
}
catch {
    $original = $_.Exception.Message
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    foreach ($target in $targets) {
        if (-not $target.InstallStarted) { continue }
        try {
            if (Test-Path -LiteralPath $target.Target) {
                $item = Get-Item -LiteralPath $target.Target -Force
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing to remove reparse point during rollback: $($target.Target)" }
                Remove-Item -LiteralPath $target.Target -Recurse -Force
            }
        } catch { $rollbackErrors.Add("Could not remove installed target $($target.Target): $($_.Exception.Message)") }
    }
    foreach ($target in $targets) {
        if (-not $target.BackedUp -or $null -eq $backup) { continue }
        $backupTarget = Join-Path $backup $target.Name
        if (-not (Test-Path -LiteralPath $backupTarget)) { continue }
        try {
            if (-not (Test-Path -LiteralPath $target.Target)) { New-Item -ItemType Directory -Path (Split-Path -Parent $target.Target) -Force | Out-Null; Move-Item -LiteralPath $backupTarget -Destination $target.Target }
        } catch { $rollbackErrors.Add("Could not restore target $($target.Target): $($_.Exception.Message)") }
    }
    if ($rollbackErrors.Count -gt 0) { throw "$original; rollback incomplete: $($rollbackErrors -join '; ') Backup retained at $backup" }
    throw
}
finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
