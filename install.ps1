[CmdletBinding()]
param([string]$Client, [string]$Preset, [switch]$External, [switch]$UpdateRoleManifest)

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
                if ($table.Value -notin @('zcode', 'codex', 'antigravity')) { throw "Unsupported preset table: $trimmed" }
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

function Assert-ModelBindingValue([string]$HostSection, [string]$Value, [string]$Context) {
    if ($Value.StartsWith('local:')) { throw "Invalid model binding in ${Context}: value must not start with local:" }
    if ($Value.Length -eq 0) { throw "Invalid model binding in ${Context}: value must not be empty" }
    if ($Value -match '[\x00-\x1F\x7F-\x9F]') { throw "Invalid model binding in ${Context}: value must not contain control characters" }
    if ($HostSection -ceq 'zcode') {
        if ($Value -match '\s') { throw "Invalid model binding in ${Context}: value must not contain whitespace" }
        $slash = $Value.IndexOf('/')
        if ($slash -lt 0) { throw "Invalid model binding in ${Context}: value must be providerId/modelId" }
        if ($slash -eq 0 -or $slash -eq ($Value.Length - 1)) { throw "Invalid model binding in ${Context}: providerId and modelId must be non-empty" }
    }
}

function Read-ModelBindings([string]$Path, [string]$HostSection) {
    # 顶层 key -> 绑定值记录；Value 为解析后的字符串，Line 供 resolve 报错定位。
    $bindings = [hashtable]::new([StringComparer]::Ordinal)
    $seen = @{ zcode = [hashtable]::new([StringComparer]::Ordinal); codex = [hashtable]::new([StringComparer]::Ordinal); antigravity = [hashtable]::new([StringComparer]::Ordinal) }
    $seenTables = [hashtable]::new([StringComparer]::Ordinal)
    $section = $null
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $lineNumber += 1
        if ($lineNumber -eq 1) { $line = $line.TrimStart([char[]]@([char]0xFEFF)) }
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed.StartsWith('[')) {
            if ($trimmed -cne '[zcode]' -and $trimmed -cne '[codex]' -and $trimmed -cne '[antigravity]') { throw "Unsupported model binding table in ${Path}:${lineNumber}: $trimmed" }
            if ($seenTables.ContainsKey($trimmed)) { throw "Repeated model binding table in ${Path}:${lineNumber}: $trimmed" }
            $seenTables[$trimmed] = $true
            $section = $trimmed.Substring(1, $trimmed.Length - 2)
            continue
        }
        if ($null -eq $section) { throw "Unsupported model binding line in ${Path}:${lineNumber}: $trimmed (expected [zcode], [codex], or [antigravity] section first)" }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { throw "Unsupported model binding line in ${Path}:${lineNumber}: $trimmed" }
        $key = $trimmed.Substring(0, $separator).Trim()
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9_-]*$') { throw "Unsupported model binding key in ${Path}:${lineNumber}: $key" }
        if ($seen[$section].ContainsKey($key)) { throw "Repeated model binding key in ${Path}:${lineNumber}: $($section)/$key" }
        $seen[$section][$key] = $true
        $rawValue = $trimmed.Substring($separator + 1).Trim()
        if ($rawValue.Length -lt 2 -or -not $rawValue.StartsWith('"') -or -not $rawValue.EndsWith('"')) {
            throw "Model binding value must be a double-quoted string in ${Path}:${lineNumber}: $($section)/$key"
        }
        $value = [string](ConvertFrom-PresetScalar $rawValue "${Path}:${lineNumber} ($($section)/$key)")
        if ($section -ceq $HostSection) { $bindings[$key] = @{ Value = $value; Line = $lineNumber } }
    }
    return $bindings
}

function Resolve-ModelBindings([hashtable]$Preset, [string]$HostSection, [string]$BindingsFile) {
    $hostTable = $Preset.sections[$HostSection]
    $required = [Collections.Generic.List[string]]::new()
    foreach ($role in $hostTable.roles) {
        $effective = $null
        if ($role.Contains('model')) { $effective = [string]$role.model }
        elseif ($hostTable.Contains('model')) { $effective = [string]$hostTable.model }
        if ($null -ne $effective -and $effective.StartsWith('local:')) {
            $key = $effective.Substring(6)
            if ($key -cnotmatch '\A[A-Za-z][A-Za-z0-9_-]*\z') { throw "Invalid local model reference in [$HostSection]: $effective (expected local:<key>)" }
            $role['localKey'] = $key
            if (-not $required.Contains($key)) { $required.Add($key) }
        } else {
            $role.Remove('localKey')
        }
    }
    $labels = [Collections.Generic.List[string]]::new()
    $variantModels = [hashtable]::new([StringComparer]::Ordinal)
    $resolution = @{ Labels = $labels; Models = $variantModels; File = $BindingsFile }
    if ($required.Count -eq 0) { return $resolution }
    $requiredDisplay = $required -join ', '
    if ([string]::IsNullOrWhiteSpace($BindingsFile)) {
        throw "Cannot resolve model bindings file: USERPROFILE is not set (required keys in [$HostSection]: $requiredDisplay)"
    }
    if (-not (Test-Path -LiteralPath $BindingsFile -PathType Leaf)) {
        throw "Model bindings file not found: $BindingsFile (required keys in [$HostSection]: $requiredDisplay)"
    }
    $bindings = Read-ModelBindings $BindingsFile $HostSection
    $missing = @($required | Where-Object { -not $bindings.ContainsKey($_) })
    if ($missing.Count -gt 0) { throw "Missing model binding keys in ${BindingsFile} [$HostSection]: $($missing -join ', ')" }

    if ($HostSection -ceq 'zcode') {
        # 精确键是默认组；<key>_<label> 是额外 provider 组。显式引用的 key 优先，不当作更短 key 的变体。
        $labelSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $orderedKeys = @($bindings.Keys | Sort-Object { $bindings[$_].Line })
        foreach ($bindingKey in $orderedKeys) {
            $isRequired = $required.Contains($bindingKey)
            foreach ($key in $required) {
                if (-not $bindingKey.StartsWith($key + '_', [StringComparison]::Ordinal)) { continue }
                $label = $bindingKey.Substring($key.Length + 1)
                if ($label -cnotmatch '^[a-z0-9][a-z0-9_-]*$') {
                    if (-not $isRequired) { throw "Invalid model variant label in ${BindingsFile}: $bindingKey (expected <key>_<lowercase-label>)" }
                    continue
                }
                if (-not $isRequired) { [void]$labelSet.Add($label) }
            }
        }
        if ($labelSet.Count -gt 0) {
            $labelArray = [string[]]@($labelSet)
            [Array]::Sort($labelArray, [StringComparer]::Ordinal)
            $missingVariants = [Collections.Generic.List[string]]::new()
            foreach ($label in $labelArray) {
                foreach ($key in $required) {
                    $variantKey = "${key}_${label}"
                    if (-not $bindings.ContainsKey($variantKey)) { $missingVariants.Add($variantKey) }
                }
            }
            if ($missingVariants.Count -gt 0) {
                throw "Variant labels must cover every referenced key in ${BindingsFile} [$HostSection]; missing: $($missingVariants -join ', ')"
            }
            $seenValues = [hashtable]::new([StringComparer]::Ordinal)
            foreach ($key in $required) {
                $binding = $bindings[$key]
                Assert-ModelBindingValue $HostSection ([string]$binding.Value) "${BindingsFile}:$($binding.Line) ($HostSection/$key)"
                $seen = $key + "`t" + [string]$binding.Value
                if ($seenValues.ContainsKey($seen)) { throw "Duplicate model binding value in ${BindingsFile} [$HostSection]" }
                $seenValues[$seen] = $true
            }
            foreach ($label in $labelArray) {
                foreach ($key in $required) {
                    $variantKey = "${key}_${label}"
                    $binding = $bindings[$variantKey]
                    Assert-ModelBindingValue $HostSection ([string]$binding.Value) "${BindingsFile}:$($binding.Line) ($HostSection/$variantKey)"
                    $seen = $key + "`t" + [string]$binding.Value
                    if ($seenValues.ContainsKey($seen)) { throw "Duplicate model binding value in ${BindingsFile} [$HostSection]" }
                    $seenValues[$seen] = $true
                    $variantModels[$key + "`t" + $label] = [string]$binding.Value
                }
                $labels.Add($label)
            }
        }
    }

    foreach ($role in $hostTable.roles) {
        if ($role.Contains('localKey')) {
            $key = [string]$role.localKey
            $binding = $bindings[$key]
            Assert-ModelBindingValue $HostSection ([string]$binding.Value) "${BindingsFile}:$($binding.Line) ($HostSection/$key)"
            $role['model'] = [string]$binding.Value
        }
    }
    return $resolution
}

function Expand-ModelVariants([hashtable]$Preset, [string]$HostSection, [hashtable]$Resolution) {
    if ($Resolution.Labels.Count -eq 0) { return }
    $hostTable = $Preset.sections[$HostSection]
    $roles = $hostTable.roles
    foreach ($role in $roles) {
        if (-not $role.Contains('localKey')) { continue }
        $model = if ($role.Contains('model')) { [string]$role.model } else { '' }
        $origDescription = if ($role.Contains('description')) { [string]$role.description } else { '' }
        $origSkillDesc = if ($role.Contains('skill_desc')) { [string]$role.skill_desc } else { $origDescription }
        $role['__origDescription'] = $origDescription
        $role['__origSkillDesc'] = $origSkillDesc
        if ($role.Contains('description')) { $role['description'] = $origDescription + "（model: $model）" }
        $role['skill_desc'] = $origSkillDesc + "（model: $model）"
    }
    $baseRoles = @($roles)
    $variantIds = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($role in $baseRoles) {
        if ($role.Contains('localKey')) {
            $id = if ($role.Contains('id')) { [string]$role.id } else { '' }
            if ($id.Length -gt 0) { $variantIds[$id] = $true }
        }
    }
    foreach ($label in $Resolution.Labels) {
        foreach ($role in $baseRoles) {
            if (-not $role.Contains('localKey')) { continue }
            $key = [string]$role.localKey
            $lookup = $key + "`t" + $label
            if (-not $Resolution.Models.ContainsKey($lookup)) {
                throw "Missing model variant in $($Resolution.File) [$HostSection]: ${key}_${label}"
            }
            $model = [string]$Resolution.Models[$lookup]
            $baseId = if ($role.Contains('id')) { [string]$role.id } else { '' }
            $baseName = if ($role.Contains('name')) { [string]$role.name } else { '' }
            if ($baseId.Length -eq 0 -or $baseName.Length -eq 0) { continue }
            $clone = $role.Clone()
            $clone['id'] = $baseId + '_' + $label
            $clone['name'] = $baseName + '_' + $label
            $clone['model'] = $model
            $clone['body'] = if ($role.Contains('body')) { [string]$role.body } else { $baseId + '.md' }
            $clone['refSuffix'] = '_' + $label
            $clone['refVariantIds'] = $variantIds
            if ($role.Contains('description')) { $clone['description'] = [string]$role.__origDescription + "（model: $model）" }
            $clone['skill_desc'] = [string]$role.__origSkillDesc + "（model: $model）"
            $roles.Add($clone)
        }
    }
}

function ConvertTo-SafeQuoted([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function ConvertTo-TomlMultiline([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"""', '\"\"\"')
    return '"""' + "`n" + $escaped + "`n" + '"""'
}

function Convert-PresetToSkillRoute([hashtable]$Preset, [string]$Section, [string]$Kind = '') {
    $hostTable = $Preset.sections[$Section]
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($role in $hostTable.roles) {
        $desc = if ($role.Contains('skill_desc')) { [string]$role.skill_desc } else { [string]$role.description }
        if ($Kind -eq 'agy-md') {
            $effectiveModel = if ($role.Contains('model')) { [string]$role.model } elseif ($hostTable.Contains('model')) { [string]$hostTable.model } else { '' }
            $desc = $desc + "（invoke_subagent Model: $effectiveModel）"
        }
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
    $defaultAgyReadonlyTools = @('read_file', 'run_command', 'manage_task', 'search_web')
    $defaultAgyWritableTools = @('read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web')
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
        $effort = $null
        if ($Kind -eq 'agy-md') {
            if ($role.Contains('effort')) {
                $effortValue = [string]$role.effort
                if (-not $effortMap.ContainsKey($effortValue)) { throw "Role [$Section]/${id}: unsupported effort $effortValue" }
                $effort = $effortMap[$effortValue]
            } else { throw "Role [$Section]/$id requires effort (basic, deep, or max)" }
            if ($role.Contains('thoughtLevel')) { $ignored.Add("[$Section]/${id}: thoughtLevel is not consumed by Antigravity") }
            if ($role.Contains('model_reasoning_effort')) { $ignored.Add("[$Section]/${id}: model_reasoning_effort is not consumed by Antigravity") }
        } else {
            $effortKey = if ($Kind -eq 'md') { 'thoughtLevel' } else { 'model_reasoning_effort' }
            $foreignEffortKey = if ($Kind -eq 'md') { 'model_reasoning_effort' } else { 'thoughtLevel' }
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
        }
        $bodyFile = if ($role.Contains('body')) { Join-Path $PresetDir ('roles\' + [string]$role.body) } else { Join-Path $PresetDir "roles\$id.md" }
        if (-not (Test-Path -LiteralPath $bodyFile -PathType Leaf)) { throw "Role body file missing: $bodyFile" }
        $body = [IO.File]::ReadAllText($bodyFile)
        $body = $body -replace "`r`n", "`n"
        $refSuffix = if ($role.Contains('refSuffix')) { [string]$role.refSuffix } else { '' }
        $refVariantIds = if ($role.Contains('refVariantIds')) { $role.refVariantIds } else { $null }
        $body = [regex]::Replace($body, '\{\{role:([A-Za-z0-9_-]+)\}\}', { param($match)
            $ref = $match.Groups[1].Value
            if ($refSuffix.Length -gt 0 -and $null -ne $refVariantIds -and $refVariantIds.ContainsKey($ref)) { $ref = $ref + $refSuffix }
            if (-not $nameById.ContainsKey($ref)) { throw "Role [$Section]/$id references unknown role id: $ref" }
            $nameById[$ref]
        })
        if ($Kind -eq 'agy-md') {
            if ($model -cnotin @('flash_lite', 'flash', 'inherit', 'pro')) { throw "Role [$Section]/${id}: unsupported Antigravity model tier $model (expected flash_lite, flash, inherit, or pro)" }
            if ($role.Contains('sandbox_mode')) { $ignored.Add("[$Section]/${id}: sandbox_mode is not consumed by Antigravity") }
            if ($role.Contains('color')) { $ignored.Add("[$Section]/${id}: color is not consumed by Antigravity") }
            if ($role.Contains('tools') -and $role.tools -isnot [array]) { throw "Role [$Section]/${id}: tools must be an array" }
            if ($readonly) {
                $tools = if ($role.Contains('tools')) { @($role.tools | ForEach-Object { [string]$_ }) } else { $defaultAgyReadonlyTools }
            } elseif ($role.Contains('tools')) {
                throw "Role [$Section]/${id}: must not set tools for a writable role"
            } else {
                $tools = $defaultAgyWritableTools
            }
            $agyDesc = $description + "（invoke_subagent Model: $model）"
            $lines = [Collections.Generic.List[string]]::new()
            $lines.Add('---')
            $lines.Add("name: $name")
            $lines.Add('description: "' + (ConvertTo-SafeQuoted $agyDesc) + '"')
            $lines.Add('subagent: true')
            $lines.Add('mainAgent: false')
            $lines.Add('tools: [' + ($tools -join ', ') + ']')
            $lines.Add('---')
            $lines.Add('')
            $lines.Add($body.TrimEnd())
            $files[$name + '.md'] = ($lines -join "`n") + "`n"
        } elseif ($Kind -eq 'md') {
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

function Assert-AgyAgentFile([string]$Path) {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $lines = $text -split "`r?`n"
    $fileName = [IO.Path]::GetFileName($Path)
    if ($lines.Count -lt 2 -or $lines[0] -ne '---') { throw "Agent frontmatter missing: $fileName" }
    $end = -1
    for ($i = 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq '---') { $end = $i; break } }
    if ($end -lt 1) { throw "Agent frontmatter unterminated: $fileName" }
    $frontmatter = $lines[1..($end - 1)] -join "`n"
    $name = $null
    foreach ($key in 'name', 'description', 'subagent', 'mainAgent', 'tools') {
        if ($frontmatter -notmatch "(?m)^$key\s*:") { throw "Agent field missing: $fileName/$key" }
        if ($key -eq 'name' -and $frontmatter -match '(?m)^name\s*:\s*"?([^\r\n"]+?)"?\s*$') { $name = $Matches[1].Trim() }
    }
    if ($frontmatter -notmatch '(?m)^subagent\s*:\s*true\s*$') { throw "Agent subagent must be true: $fileName" }
    if ($frontmatter -notmatch '(?m)^mainAgent\s*:\s*false\s*$') { throw "Agent mainAgent must be false: $fileName" }
    if ($name -ne [IO.Path]::GetFileNameWithoutExtension($Path)) { throw "Agent name mismatch: $fileName/$name" }
}

function Assert-AgyAgentStructure([string]$Directory, [int]$ExpectedCount) {
    $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.md' -File)
    if ($files.Count -ne $ExpectedCount) { throw "Expected $ExpectedCount managed agent files, found $($files.Count): $Directory" }
    foreach ($file in $files) { Assert-AgyAgentFile $file.FullName }
}

function Assert-AgyAgentFiles([string]$Directory, [System.Collections.ICollection]$FileNames) {
    foreach ($fileName in $FileNames) {
        $path = Join-Path $Directory $fileName
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Managed agent file missing: $path" }
        Assert-AgyAgentFile $path
    }
}

function Assert-RoleOutput([string]$Kind, [string]$Directory, [int]$ExpectedCount) {
    if ($Kind -eq 'toml') { Assert-TomlRoleStructure $Directory $ExpectedCount }
    elseif ($Kind -eq 'agy-md') { Assert-AgyAgentStructure $Directory $ExpectedCount }
    else { Assert-AgentStructure $Directory $ExpectedCount }
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

function Sync-RoleBodies([string]$PresetsRoot, [string]$BodiesRoot) {
    $targetsFile = Join-Path $BodiesRoot 'targets.txt'
    Assert-NoReparseChain $targetsFile
    if (-not (Test-Path -LiteralPath $targetsFile -PathType Leaf)) { throw "Missing role body targets: $targetsFile" }

    $copies = [Collections.Generic.List[object]]::new()
    foreach ($target in (Get-Content -LiteralPath $targetsFile -Encoding UTF8)) {
        if ($target -cnotmatch '^([A-Za-z0-9][A-Za-z0-9_-]*)/roles/([A-Za-z0-9][A-Za-z0-9_-]*\.md)$') {
            throw "Invalid role body target: $target"
        }
        $presetDir = Join-Path $PresetsRoot $Matches[1]
        $rolesDir = Join-Path $presetDir 'roles'
        $source = Join-Path $BodiesRoot $Matches[2]
        $destination = Join-Path $rolesDir $Matches[2]
        Assert-NoReparseChain $source
        Assert-InstallContainer $rolesDir
        Assert-InstallTarget $destination 'File'
        if (-not (Test-Path -LiteralPath (Join-Path $presetDir 'preset.toml') -PathType Leaf) -or
            -not (Test-Path -LiteralPath $rolesDir -PathType Container)) {
            throw "Role body target is not an existing preset roles directory: $rolesDir"
        }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Role body source missing: $source" }
        $copies.Add([pscustomobject]@{ Destination = $destination; Bytes = [IO.File]::ReadAllBytes($source) })
    }
    if ($copies.Count -eq 0) { throw "No role body targets: $targetsFile" }

    foreach ($copy in $copies) {
        if ((Test-Path -LiteralPath $copy.Destination -PathType Leaf) -and
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($copy.Destination)) -ceq [Convert]::ToBase64String($copy.Bytes)) {
            continue
        }
        [IO.File]::WriteAllBytes($copy.Destination, $copy.Bytes)
    }
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
        $expanded = $text.Replace(('<' + $Token + '>'), $Root).Replace(('$' + $Token), $Root).Replace('<GLOBAL_HOME>', $Root)
        if ($expanded -ne $text) { [IO.File]::WriteAllText($file.FullName, $expanded, [Text.UTF8Encoding]::new($false)) }
    }
}

$root = Split-Path -Parent $PSCommandPath
$presetsRoot = Join-Path $root 'shared\roles\presets'
$externalHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$externalPresetsPrepared = $false
$presetManifest = Join-Path $root 'shared\roles\presets.sha256'
if ($UpdateRoleManifest) {
    if (-not (Test-Path -LiteralPath $presetsRoot -PathType Container)) { throw "Missing presets root: $presetsRoot" }
    Sync-RoleBodies $presetsRoot (Join-Path $root 'shared\roles\bodies')
    Update-RoleManifest $presetsRoot $presetManifest
    Write-Host "Preset manifest updated: $presetManifest"
    return
}
if ([string]::IsNullOrWhiteSpace($externalHome)) { throw 'USERPROFILE is not set' }
$externalPresetsRoot = Join-Path $externalHome '.ai-vibecode-superpower\presets'
$modelBindingsFile = Join-Path $externalHome '.ai-vibecode-superpower\model-bindings.toml'

$sourceSystemDocs = Join-Path $root 'shared\docs\system'
$clientProfiles = [ordered]@{
    codex = @{
        Label = 'Codex'; HomeEnv = 'CODEX_HOME'; DefaultHome = '.codex'; RoleKind = 'toml'; HostSection = 'codex'; DefaultPreset = 'gpt'; Placeholder = 'CODEX_HOME'
        Instructions = Join-Path $root 'shared\global-instructions.md'
        Docs = Join-Path $root 'codex-global-config\docs'
        ConfigTemplate = Join-Path $root 'codex-global-config\config.toml'
        ProviderSettings = Join-Path $root 'codex-global-config\model-provider-settings.toml'
        Skills = @(
            @{ Name = 'agent-toolchain'; Source = (Join-Path $root 'shared\skills\agent-toolchain') },
            @{ Name = 'project-doc-planner'; Source = (Join-Path $root 'shared\skills\project-doc-planner') },
            @{ Name = 'visual-aesthetics'; Source = (Join-Path $root 'shared\skills\visual-aesthetics') },
            @{ Name = 'deep-dive-review'; Source = (Join-Path $root 'shared\skills\deep-dive-review') },
            @{ Name = 'orchestrate-model-workflow'; Source = (Join-Path $root 'shared\skills\orchestrate-model-workflow') },
            @{ Name = 'test-strategy'; Source = (Join-Path $root 'shared\skills\test-strategy') },
            @{ Name = 'security-audit'; Source = (Join-Path $root 'shared\skills\security-audit') }
        )
        SkillAssets = Join-Path $root 'codex-global-config\skill-assets'
    }
    zcode = @{
        Label = 'ZCode'; HomeEnv = 'ZCODE_HOME'; DefaultHome = '.zcode'; RoleKind = 'md'; HostSection = 'zcode'; DefaultPreset = 'glm'; Placeholder = 'ZCODE_HOME'
        Instructions = Join-Path $root 'shared\global-instructions.md'
        Docs = Join-Path $root 'zcode-global-config\docs'
        Skills = @(
            @{ Name = 'agent-toolchain'; Source = (Join-Path $root 'shared\skills\agent-toolchain') },
            @{ Name = 'project-doc-planner'; Source = (Join-Path $root 'shared\skills\project-doc-planner') },
            @{ Name = 'visual-aesthetics'; Source = (Join-Path $root 'shared\skills\visual-aesthetics') },
            @{ Name = 'deep-dive-review'; Source = (Join-Path $root 'shared\skills\deep-dive-review') },
            @{ Name = 'orchestrate-model-workflow'; Source = (Join-Path $root 'shared\skills\orchestrate-model-workflow') },
            @{ Name = 'test-strategy'; Source = (Join-Path $root 'shared\skills\test-strategy') },
            @{ Name = 'security-audit'; Source = (Join-Path $root 'shared\skills\security-audit') }
        )
    }
    antigravity = @{
        Label = 'Antigravity'; HomeEnv = 'ANTIGRAVITY_HOME'; DefaultHome = '.gemini\config\plugins\ai-vibecode-superpower'; RoleKind = 'agy-md'; HostSection = 'antigravity'; DefaultPreset = 'antigravity'; Placeholder = 'ANTIGRAVITY_HOME'
        Instructions = Join-Path $root 'shared\global-instructions.md'
        InstructionsTarget = 'rules\AGENTS.md'
        Docs = Join-Path $root 'antigravity-global-config\docs'
        PluginManifest = Join-Path $root 'antigravity-global-config\plugin.json'
        PluginAssets = Join-Path $root 'antigravity-global-config\assets'
        Skills = @(
            @{ Name = 'agent-toolchain'; Source = (Join-Path $root 'shared\skills\agent-toolchain') },
            @{ Name = 'project-doc-planner'; Source = (Join-Path $root 'shared\skills\project-doc-planner') },
            @{ Name = 'visual-aesthetics'; Source = (Join-Path $root 'shared\skills\visual-aesthetics') },
            @{ Name = 'deep-dive-review'; Source = (Join-Path $root 'shared\skills\deep-dive-review') },
            @{ Name = 'orchestrate-model-workflow'; Source = (Join-Path $root 'shared\skills\orchestrate-model-workflow') },
            @{ Name = 'test-strategy'; Source = (Join-Path $root 'shared\skills\test-strategy') },
            @{ Name = 'security-audit'; Source = (Join-Path $root 'shared\skills\security-audit') }
        )
    }
}

if ([string]::IsNullOrWhiteSpace($Preset) -and -not $External -and -not [Console]::IsInputRedirected) {
    Write-Host 'Select the preset source:'
    Write-Host "  1) Built-in ($presetsRoot) [default]"
    Write-Host "  2) External ($externalPresetsRoot)"
    $sourceChoice = Read-Host 'Enter number or name (b/e, q to quit)'
    if ($sourceChoice -match '^[qQ]$') { return }
    if ($sourceChoice -match '^(2|e|external)$') {
        $External = $true
        if (-not (Test-Path -LiteralPath $externalPresetsRoot -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $externalPresetsRoot | Out-Null
        }
        Write-Host "External preset directory: $externalPresetsRoot"
        $externalPresetsPrepared = $true
    } elseif ($sourceChoice -match '^(1|b|builtin|)$') {
        $External = $false
    } else {
        throw "Invalid selection: $sourceChoice"
    }
}

if ([string]::IsNullOrWhiteSpace($Client)) {
    if ([Console]::IsInputRedirected) { throw "No client specified. Usage: .\install.ps1 -Client <$($clientProfiles.Keys -join '|')> [-Preset <name|path>] [-External]" }
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
$presetSelectedDir = $null
$presetSearchRoot = $presetsRoot
if ($External) {
    $presetSearchRoot = $externalPresetsRoot
    if (-not $externalPresetsPrepared) {
        if (-not (Test-Path -LiteralPath $presetSearchRoot -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $presetSearchRoot | Out-Null
        }
        Write-Host "External preset directory: $presetSearchRoot"
    }
}
if ([string]::IsNullOrWhiteSpace($presetName)) {
    if ([Console]::IsInputRedirected) {
        if ($External) { throw "No preset specified. Usage: .\install.ps1 -Client $Client -Preset <name> -External" }
        throw "No preset specified. Usage: .\install.ps1 -Client $Client -Preset <$($profile.DefaultPreset)|name|path> [-External]"
    }
    $available = @(Get-ChildItem -LiteralPath $presetSearchRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'preset.toml') -PathType Leaf } | Where-Object {
        try { (Read-Preset (Join-Path $_.FullName 'preset.toml')).sections.Contains($profile.HostSection) } catch { $false }
    } | Sort-Object Name)
    if ($available.Count -eq 0) {
        if ($External) {
            Write-Host "No external presets support $Client in: $presetSearchRoot"
            Write-Host 'Copy a built-in preset as a template, for example:'
            Write-Host "  Copy-Item -Recurse '$presetsRoot\$($profile.DefaultPreset)' '$presetSearchRoot\$($profile.DefaultPreset)-local'"
            Write-Host "Then edit '$presetSearchRoot\$($profile.DefaultPreset)-local\preset.toml' and rerun with: .\install.ps1 -Client $Client -Preset $($profile.DefaultPreset)-local -External"
            Write-Host "Use [$($profile.HostSection)] in the preset host section for $label."
            throw "No external presets support $Client in: $presetSearchRoot"
        }
        throw "No presets support $Client under: $presetsRoot"
    }
    Write-Host "Select the $label role preset to install:"
    for ($i = 0; $i -lt $available.Count; $i++) {
        $mark = if (-not $External -and $available[$i].Name -eq $profile.DefaultPreset) { ' [default]' } else { '' }
        $desc = try { [string](Read-Preset (Join-Path $available[$i].FullName 'preset.toml')).description } catch { '<unreadable preset>' }
        Write-Host ('  {0}) {1}{2} - {3}' -f ($i + 1), $available[$i].Name, $mark, $desc)
    }
    $choice = Read-Host 'Enter number or name (q to quit)'
    if ($choice -match '^[qQ]$') { return }
    $choiceNumber = 0
    if ($choice -match '^\d+$' -and [int]::TryParse($choice, [ref]$choiceNumber) -and $choiceNumber -ge 1 -and $choiceNumber -le $available.Count) {
        $selected = $available[$choiceNumber - 1]
        $presetName = $selected.Name
        $presetSelectedDir = $selected.FullName
    } else {
        $presetName = $choice
        $selected = $available | Where-Object { $_.Name -ceq $choice } | Select-Object -First 1
        if ($null -ne $selected) { $presetSelectedDir = $selected.FullName }
    }
}
$presetDir = if ($null -ne $presetSelectedDir) {
    $presetSelectedDir
} elseif (Test-Path -LiteralPath $presetName -PathType Container) {
    [IO.Path]::GetFullPath($presetName)
} elseif ($External) {
    Join-Path $externalPresetsRoot $presetName
} else {
    Join-Path $presetsRoot $presetName
}
$presetFile = Join-Path $presetDir 'preset.toml'
if (-not (Test-Path -LiteralPath $presetFile -PathType Leaf)) { throw "Preset not found: $presetName (expected $presetFile)" }
$isManagedPreset = $presetDir.TrimEnd('\').StartsWith($presetsRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $presetDir.TrimEnd('\').Equals($presetsRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
if ($isManagedPreset) { Assert-PresetSources $presetsRoot ([IO.Path]::GetFileName($presetDir.TrimEnd('\'))) $presetManifest }
$presetData = Read-Preset $presetFile
if (-not $presetData.sections.Contains($profile.HostSection)) { throw "Preset '$presetName' has no [$($profile.HostSection)] section and cannot be installed for $label" }
$modelResolution = Resolve-ModelBindings $presetData $profile.HostSection $modelBindingsFile
Expand-ModelVariants $presetData $profile.HostSection $modelResolution
$rendered = Convert-PresetToHostFiles $presetData $profile.HostSection $profile.RoleKind $presetDir
$expectedRoleCount = $rendered.Count
$variantLabelsNote = if ($modelResolution.Labels.Count -gt 0) { ' (provider variants: ' + ($modelResolution.Labels -join ', ') + ')' } else { '' }

$profilePath = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$homeEnvValue = [Environment]::GetEnvironmentVariable($profile.HomeEnv)
$homePath = if ($homeEnvValue) { [IO.Path]::GetFullPath($homeEnvValue) } else { [IO.Path]::GetFullPath((Join-Path $profilePath $profile.DefaultHome)) }
if ([string]::IsNullOrWhiteSpace($homePath) -or [IO.Path]::GetPathRoot($homePath).TrimEnd('\') -eq $homePath.TrimEnd('\')) { throw "Refusing unsafe $label home: $homePath" }

foreach ($path in @($presetsRoot, $profile.Docs, $sourceSystemDocs, $profile.Instructions)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing source: $path" } }
if ($profile.Contains('SkillAssets') -and -not (Test-Path -LiteralPath $profile.SkillAssets)) { throw "Missing source: $($profile.SkillAssets)" }
if ($profile.Contains('SkillAssets') -and (Test-Path -LiteralPath $profile.SkillAssets -PathType Container)) {
    foreach ($asset in Get-ChildItem -LiteralPath $profile.SkillAssets -Directory) {
        $agentDir = Join-Path $asset.FullName 'agents'
        if (-not (Test-Path -LiteralPath $agentDir -PathType Container)) { throw "Skill asset must contain agents/: $($asset.FullName)" }
        if (@(Get-ChildItem -LiteralPath $agentDir -Recurse -File).Count -eq 0) { throw "Empty skill asset: $($asset.FullName)" }
    }
}
if ($profile.Contains('ConfigTemplate')) { foreach ($path in @($profile.ConfigTemplate, $profile.ProviderSettings)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing source: $path" } } }
if ($profile.Contains('PluginManifest') -and -not (Test-Path -LiteralPath $profile.PluginManifest -PathType Leaf)) { throw "Missing source: $($profile.PluginManifest)" }
if ($profile.Contains('PluginAssets') -and -not (Test-Path -LiteralPath $profile.PluginAssets -PathType Container)) { throw "Missing source: $($profile.PluginAssets)" }
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
$instructionsRel = if ($profile.Contains('InstructionsTarget')) { [string]$profile.InstructionsTarget } else { 'AGENTS.md' }
$instructionsName = $instructionsRel.Replace('\', '/')
$isFlatMdRoles = $profile.RoleKind -in @('md', 'agy-md')

$stage = Join-Path $homePath ('.install-stage-' + [Guid]::NewGuid().ToString('N'))
$backup = $null
$targets = @(
    @{ Name=$instructionsName; Target=(Join-Path $homePath $instructionsRel); Candidate=(Join-Path $stage $instructionsRel); Kind='File'; BackedUp=$false; InstallStarted=$false },
    @{ Name='docs'; Target=(Join-Path $homePath 'docs'); Candidate=(Join-Path $stage 'docs'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
)
if ($profile.Contains('PluginManifest')) {
    $targets += @{ Name='plugin.json'; Target=(Join-Path $homePath 'plugin.json'); Candidate=(Join-Path $stage 'plugin.json'); Kind='File'; BackedUp=$false; InstallStarted=$false }
}
if ($profile.Contains('PluginAssets')) {
    $targets += @{ Name='assets'; Target=(Join-Path $homePath 'assets'); Candidate=(Join-Path $stage 'assets'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
}
# md / agy-md agents are installed flat under <home>/agents/.
if ($isFlatMdRoles) {
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
    if ($profile.RoleKind -eq 'md') {
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
    }
} else {
    $targets += @{ Name='agents/ai-vibecode-superpower'; Target=(Join-Path $homePath 'agents\ai-vibecode-superpower'); Candidate=(Join-Path $stage 'agents\ai-vibecode-superpower'); Kind='Directory'; BackedUp=$false; InstallStarted=$false }
}
if ($null -ne $existingConfig) {
    $targets = @(@{ Name='config.toml'; Target=$existingConfig; Candidate=(Join-Path $stage 'config.toml'); Kind='File'; BackedUp=$false; InstallStarted=$false }) + $targets
}
foreach ($skill in $profile.Skills) { $targets += @{ Name="skills/$($skill.Name)"; Target=(Join-Path $homePath "skills\$($skill.Name)"); Candidate=(Join-Path $stage "skills\$($skill.Name)"); Kind='Directory'; BackedUp=$false; InstallStarted=$false } }
foreach ($target in $targets) { Assert-InstallTarget $target.Target $target.Kind }
$containers = @((Join-Path $homePath 'agents'),(Join-Path $homePath 'skills'),(Join-Path $homePath 'backups'))
if ($profile.Contains('InstructionsTarget')) { $containers += (Split-Path -Parent (Join-Path $homePath $instructionsRel)) }
foreach ($container in $containers) { Assert-InstallContainer $container }

try {
    New-Item -ItemType Directory -Path $homePath -Force | Out-Null
    Assert-NoReparseChain $homePath
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'agents') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'skills') -Force | Out-Null
    $stageInstructions = Join-Path $stage $instructionsRel
    New-Item -ItemType Directory -Path (Split-Path -Parent $stageInstructions) -Force | Out-Null
    Copy-Item $profile.Instructions $stageInstructions
    Copy-Item $profile.Docs (Join-Path $stage 'docs') -Recurse
    Copy-Item $sourceSystemDocs (Join-Path $stage 'docs\system') -Recurse
    if ($profile.Contains('PluginManifest')) {
        $null = Get-Content -LiteralPath $profile.PluginManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        Copy-Item $profile.PluginManifest (Join-Path $stage 'plugin.json')
    }
    if ($profile.Contains('PluginAssets')) {
        Copy-Item $profile.PluginAssets (Join-Path $stage 'assets') -Recurse
    }
    $stageAgents = Join-Path $stage 'agents'
    if ($profile.RoleKind -eq 'toml') { $stageAgents = Join-Path $stageAgents 'ai-vibecode-superpower'; New-Item -ItemType Directory -Path $stageAgents -Force | Out-Null }
    foreach ($fileName in $rendered.Files.Keys) { [IO.File]::WriteAllText((Join-Path $stageAgents $fileName), $rendered.Files[$fileName], [Text.UTF8Encoding]::new($false)) }
    if ($isFlatMdRoles) { [IO.File]::WriteAllText((Join-Path $stageAgents '.ai-vibecode-superpower.managed'), ((@($rendered.Files.Keys) | Sort-Object) -join "`n") + "`n", [Text.UTF8Encoding]::new($false)) }
    foreach ($skill in $profile.Skills) { Copy-Item $skill.Source (Join-Path $stage 'skills') -Recurse }
    if ($profile.Contains('SkillAssets') -and (Test-Path -LiteralPath $profile.SkillAssets -PathType Container)) {
        foreach ($asset in Get-ChildItem -LiteralPath $profile.SkillAssets -Directory) {
            $assetTarget = Join-Path $stage "skills\$($asset.Name)"
            New-Item -ItemType Directory -Path $assetTarget -Force | Out-Null
            Copy-Item (Join-Path $asset.FullName 'agents') $assetTarget -Recurse -Force
        }
    }
    $skillDoc = Join-Path (Join-Path $stage 'skills\orchestrate-model-workflow') 'SKILL.md'
    if (Test-Path -LiteralPath $skillDoc -PathType Leaf) {
        $skillText = [IO.File]::ReadAllText($skillDoc)
        if ($skillText.Contains('<!-- preset-roles -->')) {
            $skillText = $skillText.Replace('<!-- preset-roles -->', (Convert-PresetToSkillRoute $presetData $profile.HostSection $profile.RoleKind))
            $skillText = $skillText -replace "`r`n", "`n"
            [IO.File]::WriteAllText($skillDoc, $skillText, [Text.UTF8Encoding]::new($false))
        }
    }
    if ($null -ne $existingConfig) { Merge-Config $profile.ConfigTemplate $existingConfig $profile.ProviderSettings (Join-Path $stage 'config.toml') }
    Expand-Placeholders $stage $profile.Placeholder $homePath
    # 展开后不得残留任一宿主的 home 占位符或未解析 token，否则宿主会读到错误的文档路径。
    $guardFiles = @($stageInstructions, (Join-Path $stage 'docs\README.md')) + @(Get-ChildItem -LiteralPath (Join-Path $stage 'skills') -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'SKILL.md' })
    foreach ($guardFile in $guardFiles) {
        if (-not (Test-Path -LiteralPath $guardFile -PathType Leaf)) { continue }
        if ([IO.File]::ReadAllText($guardFile) -match '<(CODEX_HOME|ZCODE_HOME|ANTIGRAVITY_HOME|GLOBAL_HOME)>|\$(CODEX_HOME|ZCODE_HOME|ANTIGRAVITY_HOME)|\{\{') { throw "Unresolved home placeholder in: $guardFile" }
    }
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
    elseif ($profile.RoleKind -eq 'agy-md') { Assert-AgyAgentFiles (Join-Path $homePath 'agents') @($rendered.Files.Keys) }
    else { Assert-TomlRoleStructure (Join-Path $homePath 'agents\ai-vibecode-superpower') $expectedRoleCount }
    foreach ($note in $rendered.Ignored) { Write-Warning "Preset field not consumed: $note" }
    Write-Host "$label configuration installed in: $homePath"
    Write-Host "Preset '$presetName' rendered $expectedRoleCount roles.$variantLabelsNote"
    Write-Host 'Standalone skills and managed agent roles installed.'
    if ($Client -eq 'antigravity') {
        Write-Host 'Antigravity discovers the plugin automatically from the next turn; manage it from Customizations.'
        Write-Host 'Other Antigravity plugins and global config.json were not modified.'
    } else {
        Write-Host "Restart $label to load the new configuration and skills."
    }
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
