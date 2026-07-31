$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = Join-Path $repoRoot 'install-codex.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-install-test-' + [System.Guid]::NewGuid().ToString('N'))
$originalCodexHome = $env:CODEX_HOME

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Write-TestFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-TestHome {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory((Join-Path $Path 'docs')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $Path 'agents\ai-vibecode-superpower')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $Path 'skills\unmanaged-skill')) | Out-Null
    Write-TestFile -Path (Join-Path $Path 'AGENTS.md') -Content "old agents`n"
    Write-TestFile -Path (Join-Path $Path 'config.toml') -Content "model_provider = `"custom`"`nmodel = `"old-model`"`nunmanaged_list = [`"one`", `"two`"]`nunmanaged_inline = { enabled = true }`n[agents]`nmax_threads = 1`n[features]`ngoals = false`n"
    Write-TestFile -Path (Join-Path $Path 'docs\legacy.txt') -Content "old docs`n"
    Write-TestFile -Path (Join-Path $Path 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high.toml') -Content "old managed role`n"
    Write-TestFile -Path (Join-Path $Path 'agents\user-role.toml') -Content "name = `"user_role`"`n"
    Write-TestFile -Path (Join-Path $Path 'skills\unmanaged-skill\keep.txt') -Content "keep`n"
}

function Invoke-InstallerExpectFailure {
    param([Parameter(Mandatory)][string]$Home)

    $env:CODEX_HOME = $Home
    $failed = $false
    try { & $installer } catch { $failed = $true }
    Assert-True -Condition $failed -Message "installer unexpectedly succeeded for $Home"
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null

    $successHome = Join-Path $testRoot 'success-home'
    New-TestHome -Path $successHome
    $env:CODEX_HOME = $successHome
    & $installer
    $roles = @(Get-ChildItem -LiteralPath (Join-Path $successHome 'agents\ai-vibecode-superpower') -File -Filter '*.toml')
    Assert-True -Condition ($roles.Count -eq 9) -Message 'expected nine managed role profiles'
    $fallback = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml'
    Assert-True -Condition (Test-Path -LiteralPath $fallback -PathType Leaf) -Message 'missing readonly Terra/xhigh Sol fallback'
    Assert-True -Condition ((Get-Content -LiteralPath $fallback -Raw) -match 'sandbox_mode = "read-only"') -Message 'Sol fallback is not read-only'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $successHome 'agents\user-role.toml') -PathType Leaf) -Message 'unmanaged user role was not preserved'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_list = \["one", "two"\]') -Message 'unmanaged array was not preserved'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_inline = \{ enabled = true \}') -Message 'unmanaged inline table was not preserved'

    $complexExistingHome = Join-Path $testRoot 'complex-existing-home'
    New-TestHome -Path $complexExistingHome
    Add-Content -LiteralPath (Join-Path $complexExistingHome 'config.toml') -Value '[projects."/tmp/example"]'
    Add-Content -LiteralPath (Join-Path $complexExistingHome 'config.toml') -Value 'name = "kept"'
    Add-Content -LiteralPath (Join-Path $complexExistingHome 'config.toml') -Value '[[skills.config]]'
    Add-Content -LiteralPath (Join-Path $complexExistingHome 'config.toml') -Value 'path = "kept"'
    $env:CODEX_HOME = $complexExistingHome
    & $installer
    $complexConfig = Get-Content -LiteralPath (Join-Path $complexExistingHome 'config.toml') -Raw
    Assert-True -Condition ($complexConfig -match '\[projects\."/tmp/example"\]') -Message 'quoted project table was not preserved'
    Assert-True -Condition ($complexConfig -match '\[\[skills\.config\]\]') -Message 'array table was not preserved'
    Assert-True -Condition ($complexConfig -match 'path = "kept"') -Message 'array table value was not preserved'

    $unsafeHome = Join-Path $testRoot 'unsafe-toml-home'
    New-TestHome -Path $unsafeHome
    $unsafeConfig = Join-Path $unsafeHome 'config.toml'
    [System.IO.File]::WriteAllText($unsafeConfig, "notes = `"`"`"`nmodel = `"inside-a-string`"`n`"`"`"`n", [System.Text.UTF8Encoding]::new($false))
    $unsafeBefore = [System.IO.File]::ReadAllBytes($unsafeConfig)
    Invoke-InstallerExpectFailure -Home $unsafeHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($unsafeBefore, [System.IO.File]::ReadAllBytes($unsafeConfig))) -Message 'unsafe TOML changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $unsafeHome 'backups'))) -Message 'unsafe TOML created backups before rejection'

    $quotedManagedKeyHome = Join-Path $testRoot 'quoted-managed-key-home'
    New-TestHome -Path $quotedManagedKeyHome
    $quotedManagedConfig = Join-Path $quotedManagedKeyHome 'config.toml'
    [System.IO.File]::WriteAllText($quotedManagedConfig, '"model" = "old-model"' + "`n", [System.Text.UTF8Encoding]::new($false))
    $quotedManagedBefore = [System.IO.File]::ReadAllBytes($quotedManagedConfig)
    Invoke-InstallerExpectFailure -Home $quotedManagedKeyHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($quotedManagedBefore, [System.IO.File]::ReadAllBytes($quotedManagedConfig))) -Message 'quoted managed key changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $quotedManagedKeyHome 'backups'))) -Message 'quoted managed key created backups before rejection'

    $crossLineValueHome = Join-Path $testRoot 'cross-line-value-home'
    New-TestHome -Path $crossLineValueHome
    $crossLineConfig = Join-Path $crossLineValueHome 'config.toml'
    [System.IO.File]::WriteAllText($crossLineConfig, "plugins = [`n  `"plugin-a`",`n]`n", [System.Text.UTF8Encoding]::new($false))
    $crossLineBefore = [System.IO.File]::ReadAllBytes($crossLineConfig)
    Invoke-InstallerExpectFailure -Home $crossLineValueHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($crossLineBefore, [System.IO.File]::ReadAllBytes($crossLineConfig))) -Message 'cross-line value changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $crossLineValueHome 'backups'))) -Message 'cross-line value created backups before rejection'

    $embeddedCrossLineValueHome = Join-Path $testRoot 'embedded-cross-line-value-home'
    New-TestHome -Path $embeddedCrossLineValueHome
    $embeddedCrossLineConfig = Join-Path $embeddedCrossLineValueHome 'config.toml'
    [System.IO.File]::WriteAllText($embeddedCrossLineConfig, "plugins = [`"plugin-a`",`nmodel = `"inside`"]`n", [System.Text.UTF8Encoding]::new($false))
    $embeddedCrossLineBefore = [System.IO.File]::ReadAllBytes($embeddedCrossLineConfig)
    Invoke-InstallerExpectFailure -Home $embeddedCrossLineValueHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($embeddedCrossLineBefore, [System.IO.File]::ReadAllBytes($embeddedCrossLineConfig))) -Message 'embedded cross-line value changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $embeddedCrossLineValueHome 'backups'))) -Message 'embedded cross-line value created backups before rejection'

    $reservedNameHome = Join-Path $testRoot 'reserved-name-home'
    New-TestHome -Path $reservedNameHome
    Write-TestFile -Path (Join-Path $reservedNameHome 'agents\user-role.toml') -Content "name = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -Home $reservedNameHome
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $reservedNameHome 'backups'))) -Message 'reserved role conflict created backups before rejection'

    $literalReservedNameHome = Join-Path $testRoot 'literal-reserved-name-home'
    New-TestHome -Path $literalReservedNameHome
    Write-TestFile -Path (Join-Path $literalReservedNameHome 'agents\user-role.toml') -Content "name = 'avsp_custom'`n"
    Invoke-InstallerExpectFailure -Home $literalReservedNameHome
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $literalReservedNameHome 'backups'))) -Message 'literal-string reserved role conflict created backups before rejection'

    $hiddenReservedNameHome = Join-Path $testRoot 'hidden-reserved-name-home'
    New-TestHome -Path $hiddenReservedNameHome
    Write-TestFile -Path (Join-Path $hiddenReservedNameHome 'agents\.user-role.toml') -Content "name = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -Home $hiddenReservedNameHome
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $hiddenReservedNameHome 'backups'))) -Message 'hidden reserved role conflict created backups before rejection'

    $quotedKeyReservedNameHome = Join-Path $testRoot 'quoted-key-reserved-name-home'
    New-TestHome -Path $quotedKeyReservedNameHome
    Write-TestFile -Path (Join-Path $quotedKeyReservedNameHome 'agents\user-role.toml') -Content "`"name`" = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -Home $quotedKeyReservedNameHome
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $quotedKeyReservedNameHome 'backups'))) -Message 'quoted-key reserved role conflict created backups before rejection'

    $escapedReservedNameHome = Join-Path $testRoot 'escaped-reserved-name-home'
    New-TestHome -Path $escapedReservedNameHome
    Write-TestFile -Path (Join-Path $escapedReservedNameHome 'agents\user-role.toml') -Content 'name = "\u0061vsp_custom"' + "`n"
    Invoke-InstallerExpectFailure -Home $escapedReservedNameHome
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $escapedReservedNameHome 'backups'))) -Message 'escaped reserved role conflict created backups before rejection'

    $rootTableKeyHome = Join-Path $testRoot 'root-table-key-home'
    New-TestHome -Path $rootTableKeyHome
    $rootTableKeyConfig = Join-Path $rootTableKeyHome 'config.toml'
    [System.IO.File]::WriteAllText($rootTableKeyConfig, "agents = { custom = true }`n", [System.Text.UTF8Encoding]::new($false))
    $rootTableKeyBefore = [System.IO.File]::ReadAllBytes($rootTableKeyConfig)
    Invoke-InstallerExpectFailure -Home $rootTableKeyHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($rootTableKeyBefore, [System.IO.File]::ReadAllBytes($rootTableKeyConfig))) -Message 'managed table root key changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $rootTableKeyHome 'backups'))) -Message 'managed table root key created backups before rejection'

    $managedScalarTableHome = Join-Path $testRoot 'managed-scalar-table-home'
    New-TestHome -Path $managedScalarTableHome
    $managedScalarTableConfig = Join-Path $managedScalarTableHome 'config.toml'
    [System.IO.File]::WriteAllText($managedScalarTableConfig, "[model_reasoning_effort]`nvalue = `"xhigh`"`n", [System.Text.UTF8Encoding]::new($false))
    $managedScalarTableBefore = [System.IO.File]::ReadAllBytes($managedScalarTableConfig)
    Invoke-InstallerExpectFailure -Home $managedScalarTableHome
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($managedScalarTableBefore, [System.IO.File]::ReadAllBytes($managedScalarTableConfig))) -Message 'managed scalar table changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $managedScalarTableHome 'backups'))) -Message 'managed scalar table created backups before rejection'

    Write-Host 'install-codex.ps1 regression tests passed'
}
finally {
    if ($null -eq $originalCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $originalCodexHome }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
