[CmdletBinding()]
param([string]$Client, [string]$Preset, [switch]$UpdateRoleManifest)

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

function ConvertFrom-PresetScalar([string]$Value, [string]$Context) {
    $v = $Value.Trim()
    if ($v -eq 'true') { return $true }
    if ($v -eq 'false') { return $false }
    if ($v -match '^[A-Za-z][A-Za-z0-9_-]*$') { return $v }
    if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) {
        $inner = $v.Substring(1, $v.Length - 2)
        $sb = [Text.StringBuilder]::new()
        for ($i = 0; $i -lt $inner.Length; $i++) {
            $c = $inner[$i]
            if ($c -eq '\') {
                $i++
                if ($i -ge $inner.Length) { throw "Unterminated escape in $Context" }
                $e = $inner[$i]
                switch ($e) {
                    '"' { [void]$sb.Append('"') }
                    '\' { [void]$sb.Append('\') }
                    'n' { [void]$sb.Append("`n") }
                    't' { [void]$sb.Append("`t") }
                    default { throw "Unsupported escape in ${Context}: '\$e'" }
                }
            } elseif ($c -eq '"') { throw "Unescaped double quote in $Context" }
            else { [void]$sb.Append($c) }
        }
        return $sb.ToString()
    }
    throw "Unsupported preset value in ${Context}: $Value"
}

function ConvertFrom-PresetValue([string]$Value, [string]$Context) {
    $v = $Value.Trim()
    if ($v.StartsWith('[') -and $v.EndsWith(']')) {
        $inner = $v.Substring(1, $v.Length - 2).Trim()
        if ($inner.Length -eq 0) { return @() }
        return @($inner -split ',' | ForEach-Object { ConvertFrom-PresetScalar $_ "$Context item" })
    }
    return ConvertFrom-PresetScalar $Value $Context
}

function Read-Preset([string]$PresetFile) {
    $preset = @{ description = $null; sections = [ordered]@{} }
    $section = $null
    $allowedRoleKeys = @('id', 'name', 'description', 'effort', 'readonly', 'model', 'body', 'color', 'tools', 'thoughtLevel', 'model_reasoning_effort', 'sandbox_mode', 'skill_desc')
    foreach ($line in Get-Content -LiteralPath $PresetFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed.StartsWith('[')) {
            $table = Get-TomlTableHeader $trimmed
            if ($table.IsArray) {
                if ($table.Value -notmatch '^([A-Za-z][A-Za-z0-9_-]*)\.role$') { throw "Unsupported preset table: $trimmed" }
                $hostName = $Matches[1]
                if (-not $preset.sections.Contains($hostName)) { $preset.sections[$hostName] = @{ roles = [Collections.Generic.List[hashtable]]::new() } }
                $preset.sections[$hostName].roles.Add(@{})
                $section = @{ Host = $hostName; RoleIndex = $preset.sections[$hostName].roles.Count - 1 }
            } else {
                if ($table.Value -notin @('zcode', 'codex')) { throw "Unsupported preset table: $trimmed" }
                if (-not $preset.sections.Contains($table.Value)) { $preset.sections[$table.Value] = @{ roles = [Collections.Generic.List[hashtable]]::new() } }
                $section = @{ Host = $table.Value; RoleIndex = $null }
            }
            continue
        }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { throw "Unsupported preset line in ${PresetFile}: $line" }
        $key = $trimmed.Substring(0, $separator).Trim()
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9_-]*$') { throw "Unsupported preset key in ${PresetFile}: $key" }
        if ($null -eq $section) {
            if ($key -ne 'description') { throw "Unsupported preset root key: $key" }
            if ($null -ne $preset.description) { throw 'Repeated preset key: description' }
            $preset.description = ConvertFrom-PresetScalar $trimmed.Substring($separator + 1) 'description'
        } else {
            if ($null -eq $section.RoleIndex -and $key -ne 'model') { throw "Unsupported preset key in [$($section.Host)]: $key" }
            if ($null -ne $section.RoleIndex -and $key -notin $allowedRoleKeys) { throw "Unsupported preset role key in [$($section.Host)]: $key" }
            $hostTable = $preset.sections[$section.Host]
            $target = if ($null -eq $section.RoleIndex) { $hostTable } else { $hostTable.roles[$section.RoleIndex] }
            if ($target.Contains($key)) { throw "Repeated preset key: $($section.Host)/$key" }
            $target[$key] = ConvertFrom-PresetValue $trimmed.Substring($separator + 1) "$($section.Host)/$key"
        }
    }
    if ($null -eq $preset.description) { throw "Preset description missing: $PresetFile" }
    if ($preset.sections.Count -eq 0) { throw "Preset has no host section: $PresetFile" }
    return $preset
}

function ConvertTo-SafeQuoted([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function ConvertTo-TomlMultiline([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"""', '\"\"\"')
    return '"""' + "`n" + $escaped + "`n" + '"""'
}

function Convert-PresetToSkillRoute([hashtable]$Preset, [string]$Section) {
    $hostTable = $Preset.sections[$Section]
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($role in $hostTable.roles) {
        $desc = if ($role.Contains('skill_desc')) { [string]$role.skill_desc } else { [string]$role.description }
        $lines.Add('- `' + [string]$role.name + '`：' + $desc)
    }
    return ($lines -join "`n")
}

function Convert-PresetToHostFiles([hashtable]$Preset, [string]$Section, [string]$Kind, [string]$PresetDir) {
    if (-not $Preset.sections.Contains($Section)) { throw "Preset has no [$Section] section" }
    $hostTable = $Preset.sections[$Section]
    $roles = $hostTable.roles
    if ($roles.Count -eq 0) { throw "Preset [$Section] section declares no roles" }
    $ids = @{}
    $names = @{}
    foreach ($role in $roles) {
        foreach ($required in 'id', 'name', 'description') {
            if (-not $role.Contains($required)) { throw "Preset role in [$Section] missing $required" }
        }
        $id = [string]$role.id
        $name = [string]$role.name
        if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') { throw "Invalid preset role id: $id" }
        if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid preset role name: $name" }
        if ($ids.ContainsKey($id)) { throw "Duplicate role id in [$Section]: $id" }
        if ($names.ContainsKey($name)) { throw "Duplicate role name in [$Section]: $name" }
        $ids[$id] = $true
        $names[$name] = $true
    }
    $nameById = @{}
    foreach ($role in $roles) { $nameById[[string]$role.id] = [string]$role.name }
    $effortMap = @{ basic = 'low'; deep = 'high'; max = 'max' }
    $defaultTools = @('Read', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite')
    $ignored = [Collections.Generic.List[string]]::new()
    $files = [ordered]@{}
    foreach ($role in $roles) {
        $id = [string]$role.id
        $name = [string]$role.name
        $description = [string]$role.description
        if ($role.Contains('readonly')) {
            if ($role.readonly -isnot [bool]) { throw "Role [$Section]/${id}: readonly must be true or false" }
            $readonly = $role.readonly
        } else { $readonly = $true }
        $model = $null
        if ($role.Contains('model')) { $model = [string]$role.model }
        elseif ($hostTable.Contains('model')) { $model = [string]$hostTable.model }
        if ([string]::IsNullOrWhiteSpace($model)) { throw "Role [$Section]/$id has no model (neither role model nor [$Section] model)" }
        $effortKey = if ($Kind -eq 'md') { 'thoughtLevel' } else { 'model_reasoning_effort' }
        $foreignEffortKey = if ($Kind -eq 'md') { 'model_reasoning_effort' } else { 'thoughtLevel' }
        $effort = $null
        if ($role.Contains($effortKey)) {
            if ($role.Contains('effort')) { throw "Role [$Section]/$id must not set both effort and $effortKey" }
            $effort = [string]$role[$effortKey]
        } elseif ($role.Contains('effort')) {
            $effortValue = [string]$role.effort
            if (-not $effortMap.ContainsKey($effortValue)) { throw "Role [$Section]/${id}: unsupported effort $effortValue" }
            $effort = $effortMap[$effortValue]
        } elseif ($role.Contains($foreignEffortKey)) {
            throw "Role [$Section]/$id sets only $foreignEffortKey which is not consumed by this host; set effort or $effortKey"
        } else { throw "Role [$Section]/$id has neither effort nor $effortKey" }
        if ($role.Contains($foreignEffortKey) -and $null -ne $effort) { $ignored.Add("[$Section]/${id}: $foreignEffortKey is not consumed by this host") }
        $bodyFile = if ($role.Contains('body')) { Join-Path $PresetDir ('roles\' + [string]$role.body) } else { Join-Path $PresetDir "roles\$id.md" }
        if (-not (Test-Path -LiteralPath $bodyFile -PathType Leaf)) { throw "Role body file missing: $bodyFile" }
        $body = [IO.File]::ReadAllText($bodyFile)
        $body = $body -replace "`r`n", "`n"
        $body = [regex]::Replace($body, '\{\{role:([A-Za-z0-9_-]+)\}\}', { param($match)
            $ref = $match.Groups[1].Value
            if (-not $nameById.ContainsKey($ref)) { throw "Role [$Section]/$id references unknown role id: $ref" }
            $nameById[$ref]
        })
        if ($Kind -eq 'md') {
            if ($role.Contains('sandbox_mode')) { $ignored.Add("[$Section]/${id}: sandbox_mode is not consumed by ZCode") }
            if ($role.Contains('model_reasoning_effort')) { $ignored.Add("[$Section]/${id}: model_reasoning_effort is not consumed by ZCode") }
            $color = if ($role.Contains('color')) { [string]$role.color } elseif (-not $readonly) { 'green' } elseif ($effort -eq 'max') { 'orange' } else { 'cyan' }
            $lines = [Collections.Generic.List[string]]::new()
            $lines.Add('---')
            $lines.Add("name: $name")
            $lines.Add('description: "' + (ConvertTo-SafeQuoted $description) + '"')
            $lines.Add('model: "' + (ConvertTo-SafeQuoted $model) + '"')
            $lines.Add("thoughtLevel: $effort")
            $lines.Add("color: $color")
            if ($role.Contains('tools') -and $role.tools -isnot [array]) { throw "Role [$Section]/${id}: tools must be an array" }
            if ($readonly) {
                $tools = if ($role.Contains('tools')) { @($role.tools | ForEach-Object { [string]$_ }) } else { $defaultTools }
                $lines.Add('tools: [' + ($tools -join ', ') + ']')
            } elseif ($role.Contains('tools')) { throw "Role [$Section]/${id}: must not set tools for a writable role" }
            $lines.Add('---')
            $lines.Add('')
            $lines.Add($body.TrimEnd())
            $files[$name + '.md'] = ($lines -join "`n") + "`n"
        } else {
            if ($role.Contains('tools')) { $ignored.Add("[$Section]/${id}: tools is not consumed by Codex") }
            if ($role.Contains('color')) { $ignored.Add("[$Section]/${id}: color is not consumed by Codex") }
            $sandbox = if ($role.Contains('sandbox_mode')) { [string]$role.sandbox_mode } elseif ($readonly) { 'read-only' } else { 'danger-full-access' }
            $lines = [Collections.Generic.List[string]]::new()
            $lines.Add('name = "' + (ConvertTo-SafeQuoted $name) + '"')
            $lines.Add('description = "' + (ConvertTo-SafeQuoted $description) + '"')
            $lines.Add('developer_instructions = ' + (ConvertTo-TomlMultiline $body.TrimEnd()))
            $lines.Add('model = "' + (ConvertTo-SafeQuoted $model) + '"')
            $lines.Add('model_reasoning_effort = "' + (ConvertTo-SafeQuoted $effort) + '"')
            $lines.Add('sandbox_mode = "' + (ConvertTo-SafeQuoted $sandbox) + '"')
            $files[$name + '.toml'] = ($lines -join "`n") + "`n"
        }
    }
    return @{ Files = $files; Ignored = $ignored; Count = $roles.Count }
}

function Assert-AgentFile([string]$Path) {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $lines = $text -split "`r?`n"
    $fileName = [IO.Path]::GetFileName($Path)
    if ($lines.Count -lt 2 -or $lines[0] -ne '---') { throw "Agent frontmatter missing: $fileName" }
    $end = -1
    for ($i = 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq '---') { $end = $i; break } }
    if ($end -lt 1) { throw "Agent frontmatter unterminated: $fileName" }
    $frontmatter = $lines[1..($end - 1)] -join "`n"
    $name = $null
    foreach ($key in 'name', 'description', 'model', 'thoughtLevel') {
        if ($frontmatter -notmatch "(?m)^$key\s*:") { throw "Agent field missing: $fileName/$key" }
        if ($key -eq 'name' -and $frontmatter -match '(?m)^name\s*:\s*"?([^\r\n"]+?)"?\s*$') { $name = $Matches[1].Trim() }
    }
    if ($name -ne [IO.Path]::GetFileNameWithoutExtension($Path)) { throw "Agent name mismatch: $fileName/$name" }
}

function Assert-AgentStructure([string]$Directory, [int]$ExpectedCount) {
    $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.md' -File)
    if ($files.Count -ne $ExpectedCount) { throw "Expected $ExpectedCount managed agent files, found $($files.Count): $Directory" }
    foreach ($file in $files) { Assert-AgentFile $file.FullName }
}

function Assert-AgentFiles([string]$Directory, [System.Collections.ICollection]$FileNames) {
    foreach ($fileName in $FileNames) {
        $path = Join-Path $Directory $fileName
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Managed agent file missing: $path" }
        Assert-AgentFile $path
    }
}

function Assert-TomlRoleStructure([string]$Directory, [int]$ExpectedCount) {
    $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.toml' -File)
    if ($files.Count -ne $ExpectedCount) { throw "Expected $ExpectedCount managed role files, found $($files.Count): $Directory" }
    foreach ($file in $files) {
        $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        foreach ($key in 'name', 'model', 'model_reasoning_effort', 'sandbox_mode', 'description', 'developer_instructions') {
            $count = [regex]::Matches($text, "(?m)^$key\s*=").Count
            if ($count -ne 1) { throw "Role field must appear exactly once (found $count): $($file.Name)/$key" }
        }
    }
}

function Assert-RoleOutput([string]$Kind, [string]$Directory, [int]$ExpectedCount) {
    if ($Kind -eq 'toml') { Assert-TomlRoleStructure $Directory $ExpectedCount } else { Assert-AgentStructure $Directory $ExpectedCount }
}

function Read-SourceManifest([string]$ManifestPath) {
    $hashes = @{}
    foreach ($line in Get-Content -LiteralPath $ManifestPath -Encoding UTF8) {
        if ($line -notmatch '^([0-9a-f]{64})  ([^\s]+)$') { throw "Invalid preset manifest: $ManifestPath" }
        $hashes[$Matches[2]] = $Matches[1]
    }
    if ($hashes.Count -eq 0) { throw "Empty preset manifest: $ManifestPath" }
    return $hashes
}

function Assert-PresetSources([string]$PresetsRoot, [string]$PresetName, [string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Missing preset manifest: $ManifestPath" }
    $hashes = Read-SourceManifest $ManifestPath
    $prefix = $PresetName + '/'
    $matched = @{}
    foreach ($rel in $hashes.Keys) {
        if (-not $rel.StartsWith($prefix)) { continue }
        $matched[$rel] = $true
        $path = Join-Path $PresetsRoot ($rel.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Managed preset source missing: $path" }
        if ((Get-NormalizedHash $path) -ne $hashes[$rel]) { throw "Preset source hash mismatch: $rel" }
    }
    if ($matched.Count -eq 0) { throw "Preset not covered by manifest: $PresetName" }
}

function Update-RoleManifest([string]$PresetsRoot, [string]$ManifestPath) {
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($preset in (Get-ChildItem -LiteralPath $PresetsRoot -Directory | Sort-Object Name)) {
        $presetFile = Join-Path $preset.FullName 'preset.toml'
        if (-not (Test-Path -LiteralPath $presetFile -PathType Leaf)) { throw "Preset missing preset.toml: $($preset.FullName)" }
        foreach ($file in (Get-ChildItem -LiteralPath $preset.FullName -Recurse -File | Sort-Object FullName)) {
            $rel = $preset.Name + '/' + $file.FullName.Substring($preset.FullName.Length + 1).Replace('\', '/')
            $lines.Add((Get-NormalizedHash $file.FullName) + '  ' + $rel)
        }
    }
    if ($lines.Count -eq 0) { throw "No preset sources found under $PresetsRoot" }
    [IO.File]::WriteAllText($ManifestPath, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-TomlTableHeader([string]$Line) {
    $trimmed = $Line.Trim()
    if (-not $trimmed.StartsWith('[')) { return $null }
    $array = $trimmed.StartsWith('[[')
    $opening = if ($array) { 2 } else { 1 }
    $basic = $false; $literal = $false
    for ($i = $opening; $i -lt $trimmed.Length; $i++) {
        $character = $trimmed[$i]
        if ($basic) {
            if ($character -eq '\') { $i++ } elseif ($character -eq '"') { $basic = $false }
            continue
        }
        if ($literal) {
            if ($character -eq "'") { $literal = $false }
            continue
        }
        if ($character -eq '"') { $basic = $true; continue }
        if ($character -eq "'") { $literal = $true; continue }
        if ($character -eq '[') { throw "Unsupported TOML table header: $Line" }
        if ($character -eq ']') {
            if ($array -and ($i + 1 -ge $trimmed.Length -or $trimmed[$i + 1] -ne ']')) { throw "Unsupported TOML array table header: $Line" }
            $closing = if ($array) { 2 } else { 1 }
            if ($trimmed.Substring($i + $closing) -notmatch '^\s*(#.*)?$') { throw "Unsupported TOML table header: $Line" }
            $header = $trimmed.Substring($opening, $i - $opening).Trim()
            if ($header.Length -eq 0) { throw "Unsupported TOML table header: $Line" }
            return [pscustomobject]@{ Value = $header; IsArray = $array }
        }
    }
    throw "Unsupported TOML table header: $Line"
}

function Assert-SafeTomlMergeInput([string]$Path) {
    function ConvertFrom-SafeQuotedTomlKey([string]$Key) {
        $KeyLength = $Key.Length
        if ($KeyLength -lt 2) { return $null }
        $quote = $Key[0]
        if ($quote -ne '"' -and $quote -ne "'") { return $null }
        if ($Key[$KeyLength - 1] -ne $quote) { return $null }
        $decoded = [Text.StringBuilder]::new()
        for ($i = 1; $i -lt $KeyLength - 1; $i++) {
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
            if ($i -ge $KeyLength - 1) { return $null }
            $character = $Key[$i]
            if ($character -eq 'u' -or $character -eq 'U') {
                $count = if ($character -eq 'u') { 4 } else { 8 }
                if ($i + $count -ge $KeyLength - 1) { return $null }
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
        if ($trimmed.StartsWith('[')) {
            $table = Get-TomlTableHeader $trimmed
            $section = if ($table.IsArray) { '__array__' } else { $table.Value }
            continue
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
        if ($line.TrimStart().StartsWith('[')) {
            $table = Get-TomlTableHeader $line
            $section = if ($table.IsArray) { '__array__' } else { $table.Value }
            continue
        }
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
        if ($line.TrimStart().StartsWith('[')) {
            & $flush $section
            $table = Get-TomlTableHeader $line
            if ($table.IsArray) { $section = '__array__'; $providerSection = $false; $providerSeen = @{}; $outputLines.Add($line); continue }
            $header = $table.Value
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

function Expand-Placeholders([string]$Directory, [string]$Token, [string]$Root) {
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File) {
        if ($file.Extension.ToLowerInvariant() -notin @('.md','.toml','.txt')) { continue }
        $text = [IO.File]::ReadAllText($file.FullName)
        $expanded = $text.Replace(('<' + $Token + '>'), $Root).Replace(('$' + $Token), $Root)
        if ($expanded -ne $text) { [IO.File]::WriteAllText($file.FullName, $expanded, [Text.UTF8Encoding]::new($false)) }
    }
}

$root = Split-Path -Parent $PSCommandPath
$presetsRoot = Join-Path $root 'shared\roles\presets'
$presetManifest = Join-Path $root 'shared\roles\presets.sha256'
if ($UpdateRoleManifest) {
    if (-not (Test-Path -LiteralPath $presetsRoot -PathType Container)) { throw "Missing presets root: $presetsRoot" }
    Update-RoleManifest $presetsRoot $presetManifest
    Write-Host "Preset manifest updated: $presetManifest"
    return
}

$sourceSystemDocs = Join-Path $root 'shared\docs\system'
$clientProfiles = [ordered]@{
    codex = @{
        Label = 'Codex'; HomeEnv = 'CODEX_HOME'; DefaultHome = '.codex'; RoleKind = 'toml'; HostSection = 'codex'; DefaultPreset = 'gpt'; Placeholder = 'CODEX_HOME'
        Instructions = Join-Path $root 'codex-global-config\AGENTS.md'
        Docs = Join-Path $root 'codex-global-config\docs'
        ConfigTemplate = Join-Path $root 'codex-global-config\config.toml'
        ProviderSettings = Join-Path $root 'codex-global-config\model-provider-settings.toml'
        Skills = @(
            @{ Name = 'agent-toolchain'; Source = (Join-Path $root 'shared\skills\agent-toolchain') },
            @{ Name = 'project-doc-planner'; Source = (Join-Path $root 'shared\skills\project-doc-planner') },
            @{ Name = 'visual-aesthetics'; Source = (Join-Path $root 'shared\skills\visual-aesthetics') },
            @{ Name = 'deep-dive-review'; Source = (Join-Path $root 'shared\skills\deep-dive-review') },
            @{ Name = 'orchestrate-model-workflow'; Source = (Join-Path $root 'codex-global-config\skills\orchestrate-model-workflow') }
        )
    }
    zcode = @{
        Label = 'ZCode'; HomeEnv = 'ZCODE_HOME'; DefaultHome = '.zcode'; RoleKind = 'md'; HostSection = 'zcode'; DefaultPreset = 'glm'; Placeholder = 'ZCODE_HOME'
        Instructions = Join-Path $root 'zcode-global-config\AGENTS.md'
        Docs = Join-Path $root 'zcode-global-config\docs'
        Skills = @(
            @{ Name = 'agent-toolchain'; Source = (Join-Path $root 'shared\skills\agent-toolchain') },
            @{ Name = 'project-doc-planner'; Source = (Join-Path $root 'shared\skills\project-doc-planner') },
            @{ Name = 'visual-aesthetics'; Source = (Join-Path $root 'shared\skills\visual-aesthetics') },
            @{ Name = 'deep-dive-review'; Source = (Join-Path $root 'shared\skills\deep-dive-review') },
            @{ Name = 'orchestrate-model-workflow'; Source = (Join-Path $root 'zcode-global-config\skills\orchestrate-model-workflow') }
        )
    }
}

if ([string]::IsNullOrWhiteSpace($Client)) {
    if ([Console]::IsInputRedirected) { throw "No client specified. Usage: .\install.ps1 -Client <$($clientProfiles.Keys -join '|')>" }
    Write-Host 'Select the client to install:'
    $index = 1
    foreach ($name in $clientProfiles.Keys) { Write-Host ("  {0}) {1}" -f $index, $clientProfiles[$name].Label); $index++ }
    $choice = Read-Host 'Enter number or name (q to quit)'
    if ($choice -match '^[qQ]$') { return }
    if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $clientProfiles.Count) {
        $Client = @($clientProfiles.Keys)[[int]$choice - 1]
    } else {
        $Client = $choice
    }
}
$Client = $Client.Trim().ToLowerInvariant()
if (-not $clientProfiles.Contains($Client)) { throw "Unknown client: $Client (supported: $($clientProfiles.Keys -join '|'))" }
$profile = $clientProfiles[$Client]
$label = $profile.Label

$presetName = $Preset
if ([string]::IsNullOrWhiteSpace($presetName)) {
    if ([Console]::IsInputRedirected) { throw "No preset specified. Usage: .\install.ps1 -Client $Client -Preset <$($profile.DefaultPreset)|name|path>" }
    $available = @(Get-ChildItem -LiteralPath $presetsRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'preset.toml') -PathType Leaf } | Sort-Object Name)
    if ($available.Count -eq 0) { throw "No presets found under: $presetsRoot" }
    Write-Host 'Select the role preset to install:'
    for ($i = 0; $i -lt $available.Count; $i++) {
        $mark = if ($available[$i].Name -eq $profile.DefaultPreset) { ' [default]' } else { '' }
        $desc = try { [string](Read-Preset (Join-Path $available[$i].FullName 'preset.toml')).description } catch { '<unreadable preset>' }
        Write-Host ('  {0}) {1}{2} - {3}' -f ($i + 1), $available[$i].Name, $mark, $desc)
    }
    $choice = Read-Host 'Enter number or name (q to quit)'
    if ($choice -match '^[qQ]$') { return }
    if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $available.Count) { $presetName = $available[[int]$choice - 1].Name }
    else { $presetName = $choice }
}
$presetDir = if (Test-Path -LiteralPath $presetName -PathType Container) { [IO.Path]::GetFullPath($presetName) } else { Join-Path $presetsRoot $presetName }
$presetFile = Join-Path $presetDir 'preset.toml'
if (-not (Test-Path -LiteralPath $presetFile -PathType Leaf)) { throw "Preset not found: $presetName (expected $presetFile)" }
$isManagedPreset = $presetDir.TrimEnd('\').StartsWith($presetsRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $presetDir.TrimEnd('\').Equals($presetsRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
if ($isManagedPreset) { Assert-PresetSources $presetsRoot ([IO.Path]::GetFileName($presetDir.TrimEnd('\'))) $presetManifest }
$presetData = Read-Preset $presetFile
if (-not $presetData.sections.Contains($profile.HostSection)) { throw "Preset '$presetName' has no [$($profile.HostSection)] section and cannot be installed for $label" }
$rendered = Convert-PresetToHostFiles $presetData $profile.HostSection $profile.RoleKind $presetDir
$expectedRoleCount = $rendered.Count

$profilePath = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$homeEnvValue = [Environment]::GetEnvironmentVariable($profile.HomeEnv)
$homePath = if ($homeEnvValue) { [IO.Path]::GetFullPath($homeEnvValue) } else { [IO.Path]::GetFullPath((Join-Path $profilePath $profile.DefaultHome)) }
if ([string]::IsNullOrWhiteSpace($homePath) -or [IO.Path]::GetPathRoot($homePath).TrimEnd('\') -eq $homePath.TrimEnd('\')) { throw "Refusing unsafe $label home: $homePath" }

foreach ($path in @($presetsRoot, $profile.Docs, $sourceSystemDocs, $profile.Instructions)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing source: $path" } }
if ($profile.Contains('ConfigTemplate')) { foreach ($path in @($profile.ConfigTemplate, $profile.ProviderSettings)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing source: $path" } } }
foreach ($skill in $profile.Skills) {
    if (-not (Test-Path -LiteralPath $skill.Source -PathType Container)) { throw "Missing skill: $($skill.Name)" }
    if (-not (Test-Path -LiteralPath (Join-Path $skill.Source 'SKILL.md') -PathType Leaf)) { throw "Missing SKILL.md for skill: $($skill.Name)" }
}
if (Test-Path -LiteralPath (Join-Path $profile.Docs 'system')) { throw "$($profile.Docs) must not contain a system/ directory; shared system docs are composed by the installer" }
Assert-NoReparseChain $root
Assert-NoReparse $root
Assert-NoReparseChain $homePath

$existingConfig = $null
if ($profile.Contains('ConfigTemplate')) { $existingConfig = Join-Path $homePath 'config.toml' }

$stage = Join-Path $homePath ('.install-stage-' + [Guid]::NewGuid().ToString('N'))
$backup = $null
$targets = @(
    @{ Name='AGENTS.md'; Target=(Join-Path $homePath 'AGENTS.md'); Candidate=(Join-Path $stage 'AGENTS.md'); Kind='File'; BackedUp=$false; InstallStarted=$false },
    @{ Name='docs'; Target=(Join-Path $homePath 'docs'); Candidate=(Join-Path $stage 'docs'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
)
# md agents are installed flat: the ZCode host only scans the top level of ~/.zcode/agents.
if ($profile.RoleKind -eq 'md') {
    foreach ($agentName in $rendered.Files.Keys) {
        $targets += @{ Name="agents/$agentName"; Target=(Join-Path $homePath "agents\$agentName"); Candidate=(Join-Path $stage "agents\$agentName"); Kind='File'; BackedUp=$false; InstallStarted=$false }
    }
    $managedList = Join-Path $homePath 'agents\.ai-vibecode-superpower.managed'
    $previousManaged = @()
    if (Test-Path -LiteralPath $managedList -PathType Leaf) {
        $previousManaged = @(Get-Content -LiteralPath $managedList -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9][A-Za-z0-9._-]*\.md$' -and (Test-Path -LiteralPath (Join-Path $homePath "agents\$_") -PathType Leaf) })
    }
    foreach ($staleName in ($previousManaged | Where-Object { @($rendered.Files.Keys) -notcontains $_ })) {
        $targets += @{ Name="agents/$staleName"; Target=(Join-Path $homePath "agents\$staleName"); Candidate=$null; Kind='File'; BackedUp=$false; InstallStarted=$false }
    }
    $targets += @{ Name='agents/.ai-vibecode-superpower.managed'; Target=$managedList; Candidate=(Join-Path $stage 'agents\.ai-vibecode-superpower.managed'); Kind='File'; BackedUp=$false; InstallStarted=$false }
    $legacyAgentsDir = Join-Path $homePath 'agents\ai-vibecode-superpower'
    if (Test-Path -LiteralPath $legacyAgentsDir -PathType Container) {
        try {
            Assert-AgentStructure $legacyAgentsDir $expectedRoleCount
            $legacyNames = @(Get-ChildItem -LiteralPath $legacyAgentsDir -Filter '*.md' -File | Sort-Object Name | ForEach-Object { $_.Name })
            $expectedNames = @($rendered.Files.Keys | Sort-Object)
            if (($legacyNames -join '|') -ne ($expectedNames -join '|')) { throw "Legacy agent set differs from preset output" }
            $targets += @{ Name='agents/ai-vibecode-superpower'; Target=$legacyAgentsDir; Candidate=$null; Kind='Directory'; BackedUp=$false; InstallStarted=$false }
        } catch {
            Write-Warning "Legacy managed agent directory does not match the preset; left untouched: $legacyAgentsDir"
        }
    }
} else {
    $targets += @{ Name='agents/ai-vibecode-superpower'; Target=(Join-Path $homePath 'agents\ai-vibecode-superpower'); Candidate=(Join-Path $stage 'agents\ai-vibecode-superpower'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
}
if ($null -ne $existingConfig) {
    $targets = @(@{ Name='config.toml'; Target=$existingConfig; Candidate=(Join-Path $stage 'config.toml'); Kind='File'; BackedUp=$false; InstallStarted=$false }) + $targets
}
foreach ($skill in $profile.Skills) { $targets += @{ Name="skills/$($skill.Name)"; Target=(Join-Path $homePath "skills\$($skill.Name)"); Candidate=(Join-Path $stage "skills\$($skill.Name)"); Kind='Directory'; BackedUp=$false; InstallStarted=$false } }
foreach ($target in $targets) { Assert-InstallTarget $target.Target $target.Kind }
foreach ($container in @((Join-Path $homePath 'agents'),(Join-Path $homePath 'skills'),(Join-Path $homePath 'backups'))) { Assert-InstallContainer $container }

try {
    New-Item -ItemType Directory -Path $homePath -Force | Out-Null
    Assert-NoReparseChain $homePath
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'agents') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'skills') -Force | Out-Null
    Copy-Item $profile.Instructions (Join-Path $stage 'AGENTS.md')
    Copy-Item $profile.Docs (Join-Path $stage 'docs') -Recurse
    Copy-Item $sourceSystemDocs (Join-Path $stage 'docs\system') -Recurse
    $stageAgents = Join-Path $stage 'agents'
    if ($profile.RoleKind -eq 'toml') { $stageAgents = Join-Path $stageAgents 'ai-vibecode-superpower'; New-Item -ItemType Directory -Path $stageAgents -Force | Out-Null }
    foreach ($fileName in $rendered.Files.Keys) { [IO.File]::WriteAllText((Join-Path $stageAgents $fileName), $rendered.Files[$fileName], [Text.UTF8Encoding]::new($false)) }
    if ($profile.RoleKind -eq 'md') { [IO.File]::WriteAllText((Join-Path $stageAgents '.ai-vibecode-superpower.managed'), ((@($rendered.Files.Keys) | Sort-Object) -join "`n") + "`n", [Text.UTF8Encoding]::new($false)) }
    foreach ($skill in $profile.Skills) { Copy-Item $skill.Source (Join-Path $stage 'skills') -Recurse }
    $skillDoc = Join-Path (Join-Path $stage 'skills\orchestrate-model-workflow') 'SKILL.md'
    if (Test-Path -LiteralPath $skillDoc -PathType Leaf) {
        $skillText = [IO.File]::ReadAllText($skillDoc)
        if ($skillText.Contains('<!-- preset-roles -->')) {
            $skillText = $skillText.Replace('<!-- preset-roles -->', (Convert-PresetToSkillRoute $presetData $profile.HostSection))
            $skillText = $skillText -replace "`r`n", "`n"
            [IO.File]::WriteAllText($skillDoc, $skillText, [Text.UTF8Encoding]::new($false))
        }
    }
    if ($null -ne $existingConfig) { Merge-Config $profile.ConfigTemplate $existingConfig $profile.ProviderSettings (Join-Path $stage 'config.toml') }
    Expand-Placeholders $stage $profile.Placeholder $homePath
    Assert-RoleOutput $profile.RoleKind $stageAgents $expectedRoleCount

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
    if ($profile.RoleKind -eq 'md') { Assert-AgentFiles (Join-Path $homePath 'agents') @($rendered.Files.Keys) }
    else { Assert-TomlRoleStructure (Join-Path $homePath 'agents\ai-vibecode-superpower') $expectedRoleCount }
    foreach ($note in $rendered.Ignored) { Write-Warning "Preset field not consumed: $note" }
    Write-Host "$label configuration installed in: $homePath"
    Write-Host "Preset '$presetName' rendered $expectedRoleCount roles."
    Write-Host 'Standalone skills and managed agent roles installed.'
    Write-Host "Restart $label to load the new configuration and skills."
    Write-Host "Backup directory: $backup"
    if ($Client -eq 'zcode') { Write-Host 'Unmanaged ZCode state (cli/, v2/, plugins, other skills and agents) was not modified.' }
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
