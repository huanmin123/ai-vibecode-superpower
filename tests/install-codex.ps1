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

function New-InstallerFixture {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    $fixtureInstaller = Join-Path $Path 'install-codex.ps1'
    Copy-Item -LiteralPath $installer -Destination $fixtureInstaller -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'codex-global-config') -Destination (Join-Path $Path 'codex-global-config') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'skills') -Destination (Join-Path $Path 'skills') -Recurse -Force

    $fixtureRole = Join-Path $Path 'codex-global-config\agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high.toml'
    $roleText = [System.IO.File]::ReadAllText($fixtureRole)
    $lfRoleText = $roleText -replace "`r`n?", "`n"
    [System.IO.File]::WriteAllText($fixtureRole, $lfRoleText.Replace("`n", "`r`n"), [System.Text.UTF8Encoding]::new($false))

    $cacheDirectory = Join-Path $Path 'skills\gpt-image-2-cli\scripts\__pycache__'
    [System.IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $cacheDirectory 'fixture.pyc'), [byte[]](0x00, 0x01, 0x02))
    [System.IO.File]::WriteAllBytes((Join-Path $Path 'skills\gpt-image-2-cli\scripts\fixture.pyc'), [byte[]](0x03, 0x04, 0x05))

    return $fixtureInstaller
}

function Invoke-InstallerExpectFailure {
    param(
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$InstallerPath
    )

    $env:CODEX_HOME = $CodexHome
    $failed = $false
    try { & $InstallerPath } catch { $failed = $true }
    Assert-True -Condition $failed -Message "installer unexpectedly succeeded for $CodexHome"
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null

    $successHome = Join-Path $testRoot 'success-home'
    New-TestHome -Path $successHome
    $successFixtureRoot = Join-Path $testRoot 'success-fixture'
    $successInstaller = New-InstallerFixture -Path $successFixtureRoot
    $sourceRole = Join-Path $successFixtureRoot 'codex-global-config\agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high.toml'
    Assert-True -Condition ([System.IO.File]::ReadAllText($sourceRole).Contains("`r`n")) -Message 'fixture did not create a CRLF role profile'
    $sourceImageSkill = Join-Path $successFixtureRoot 'skills\gpt-image-2-cli'
    $sourcePycFilesBefore = @(Get-ChildItem -LiteralPath $sourceImageSkill -Recurse -File -Filter '*.pyc' -Force |
        ForEach-Object { [pscustomobject]@{ Path = $_.FullName; Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
    Assert-True -Condition ($sourcePycFilesBefore.Count -ge 2) -Message 'fixture did not create Python cache files'
    $env:CODEX_HOME = $successHome
    & $successInstaller
    $roles = @(Get-ChildItem -LiteralPath (Join-Path $successHome 'agents\ai-vibecode-superpower') -File -Filter '*.toml')
    Assert-True -Condition ($roles.Count -eq 9) -Message 'expected nine managed role profiles'
    $fallback = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml'
    Assert-True -Condition (Test-Path -LiteralPath $fallback -PathType Leaf) -Message 'missing readonly Terra/xhigh Sol fallback'
    Assert-True -Condition ((Get-Content -LiteralPath $fallback -Raw) -match 'sandbox_mode = "read-only"') -Message 'Sol fallback is not read-only'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $successHome 'agents\user-role.toml') -PathType Leaf) -Message 'unmanaged user role was not preserved'
    $installedWorkflow = Join-Path $successHome 'skills\orchestrate-model-workflow\SKILL.md'
    Assert-True -Condition (Test-Path -LiteralPath $installedWorkflow -PathType Leaf) -Message 'installed orchestration workflow is missing'
    Assert-True -Condition ((Get-Content -LiteralPath $installedWorkflow -Raw).Contains('不要求 worker 自报不可见的运行时模型、推理强度或 sandbox')) -Message 'installed workflow still requires worker runtime metadata self-reporting'
    $installedWorkflowRoot = Join-Path $successHome 'skills\orchestrate-model-workflow'
    $legacyRuntimeGate = @(Get-ChildItem -LiteralPath $installedWorkflowRoot -Recurse -File |
        Select-String -SimpleMatch -Pattern '返回其固定 role、模型/推理强度和“未写入”确认')
    Assert-True -Condition ($legacyRuntimeGate.Count -eq 0) -Message 'installed workflow restored the worker runtime metadata self-reporting gate'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_list = \["one", "two"\]') -Message 'unmanaged array was not preserved'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_inline = \{ enabled = true \}') -Message 'unmanaged inline table was not preserved'
    $installedImageSkill = Join-Path $successHome 'skills\gpt-image-2-cli'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $installedImageSkill 'scripts\__pycache__'))) -Message 'managed skill copied __pycache__ into the destination'
    Assert-True -Condition (@(Get-ChildItem -LiteralPath $installedImageSkill -Recurse -File -Filter '*.pyc' -Force).Count -eq 0) -Message 'managed skill copied a .pyc file into the destination'
    foreach ($sourcePycFile in $sourcePycFilesBefore) {
        Assert-True -Condition (Test-Path -LiteralPath $sourcePycFile.Path -PathType Leaf) -Message "installer removed source cache file: $($sourcePycFile.Path)"
        Assert-True -Condition ((Get-FileHash -LiteralPath $sourcePycFile.Path -Algorithm SHA256).Hash -eq $sourcePycFile.Hash) -Message "installer changed source cache file: $($sourcePycFile.Path)"
    }

    $bomFixtureRoot = Join-Path $testRoot 'bom-fixture'
    $bomInstaller = New-InstallerFixture -Path $bomFixtureRoot
    $bomRole = Join-Path $bomFixtureRoot 'codex-global-config\agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high.toml'
    $bomRoleBytes = [System.IO.File]::ReadAllBytes($bomRole)
    $bomRoleBytesWithBom = [byte[]]::new($bomRoleBytes.Length + 3)
    $bomRoleBytesWithBom[0] = 0xEF
    $bomRoleBytesWithBom[1] = 0xBB
    $bomRoleBytesWithBom[2] = 0xBF
    [System.Array]::Copy($bomRoleBytes, 0, $bomRoleBytesWithBom, 3, $bomRoleBytes.Length)
    [System.IO.File]::WriteAllBytes($bomRole, $bomRoleBytesWithBom)
    $bomHome = Join-Path $testRoot 'bom-home'
    Invoke-InstallerExpectFailure -CodexHome $bomHome -InstallerPath $bomInstaller
    Assert-True -Condition (-not (Test-Path -LiteralPath $bomHome)) -Message 'BOM-mismatched role created an installation target'

    $changedFixtureRoot = Join-Path $testRoot 'changed-fixture'
    $changedInstaller = New-InstallerFixture -Path $changedFixtureRoot
    $changedRole = Join-Path $changedFixtureRoot 'codex-global-config\agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high.toml'
    Add-Content -LiteralPath $changedRole -Value '# changed role content'
    $changedHome = Join-Path $testRoot 'changed-home'
    Invoke-InstallerExpectFailure -CodexHome $changedHome -InstallerPath $changedInstaller
    Assert-True -Condition (-not (Test-Path -LiteralPath $changedHome)) -Message 'content-mismatched role created an installation target'

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
    Invoke-InstallerExpectFailure -CodexHome $unsafeHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($unsafeBefore, [System.IO.File]::ReadAllBytes($unsafeConfig))) -Message 'unsafe TOML changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $unsafeHome 'backups'))) -Message 'unsafe TOML created backups before rejection'

    $quotedManagedKeyHome = Join-Path $testRoot 'quoted-managed-key-home'
    New-TestHome -Path $quotedManagedKeyHome
    $quotedManagedConfig = Join-Path $quotedManagedKeyHome 'config.toml'
    [System.IO.File]::WriteAllText($quotedManagedConfig, '"model" = "old-model"' + "`n", [System.Text.UTF8Encoding]::new($false))
    $quotedManagedBefore = [System.IO.File]::ReadAllBytes($quotedManagedConfig)
    Invoke-InstallerExpectFailure -CodexHome $quotedManagedKeyHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($quotedManagedBefore, [System.IO.File]::ReadAllBytes($quotedManagedConfig))) -Message 'quoted managed key changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $quotedManagedKeyHome 'backups'))) -Message 'quoted managed key created backups before rejection'

    $crossLineValueHome = Join-Path $testRoot 'cross-line-value-home'
    New-TestHome -Path $crossLineValueHome
    $crossLineConfig = Join-Path $crossLineValueHome 'config.toml'
    [System.IO.File]::WriteAllText($crossLineConfig, "plugins = [`n  `"plugin-a`",`n]`n", [System.Text.UTF8Encoding]::new($false))
    $crossLineBefore = [System.IO.File]::ReadAllBytes($crossLineConfig)
    Invoke-InstallerExpectFailure -CodexHome $crossLineValueHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($crossLineBefore, [System.IO.File]::ReadAllBytes($crossLineConfig))) -Message 'cross-line value changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $crossLineValueHome 'backups'))) -Message 'cross-line value created backups before rejection'

    $embeddedCrossLineValueHome = Join-Path $testRoot 'embedded-cross-line-value-home'
    New-TestHome -Path $embeddedCrossLineValueHome
    $embeddedCrossLineConfig = Join-Path $embeddedCrossLineValueHome 'config.toml'
    [System.IO.File]::WriteAllText($embeddedCrossLineConfig, "plugins = [`"plugin-a`",`nmodel = `"inside`"]`n", [System.Text.UTF8Encoding]::new($false))
    $embeddedCrossLineBefore = [System.IO.File]::ReadAllBytes($embeddedCrossLineConfig)
    Invoke-InstallerExpectFailure -CodexHome $embeddedCrossLineValueHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($embeddedCrossLineBefore, [System.IO.File]::ReadAllBytes($embeddedCrossLineConfig))) -Message 'embedded cross-line value changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $embeddedCrossLineValueHome 'backups'))) -Message 'embedded cross-line value created backups before rejection'

    $reservedNameHome = Join-Path $testRoot 'reserved-name-home'
    New-TestHome -Path $reservedNameHome
    Write-TestFile -Path (Join-Path $reservedNameHome 'agents\user-role.toml') -Content "name = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -CodexHome $reservedNameHome -InstallerPath $installer
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $reservedNameHome 'backups'))) -Message 'reserved role conflict created backups before rejection'

    $literalReservedNameHome = Join-Path $testRoot 'literal-reserved-name-home'
    New-TestHome -Path $literalReservedNameHome
    Write-TestFile -Path (Join-Path $literalReservedNameHome 'agents\user-role.toml') -Content "name = 'avsp_custom'`n"
    Invoke-InstallerExpectFailure -CodexHome $literalReservedNameHome -InstallerPath $installer
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $literalReservedNameHome 'backups'))) -Message 'literal-string reserved role conflict created backups before rejection'

    $hiddenReservedNameHome = Join-Path $testRoot 'hidden-reserved-name-home'
    New-TestHome -Path $hiddenReservedNameHome
    Write-TestFile -Path (Join-Path $hiddenReservedNameHome 'agents\.user-role.toml') -Content "name = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -CodexHome $hiddenReservedNameHome -InstallerPath $installer
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $hiddenReservedNameHome 'backups'))) -Message 'hidden reserved role conflict created backups before rejection'

    $quotedKeyReservedNameHome = Join-Path $testRoot 'quoted-key-reserved-name-home'
    New-TestHome -Path $quotedKeyReservedNameHome
    Write-TestFile -Path (Join-Path $quotedKeyReservedNameHome 'agents\user-role.toml') -Content "`"name`" = `"avsp_custom`"`n"
    Invoke-InstallerExpectFailure -CodexHome $quotedKeyReservedNameHome -InstallerPath $installer
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $quotedKeyReservedNameHome 'backups'))) -Message 'quoted-key reserved role conflict created backups before rejection'

    $escapedReservedNameHome = Join-Path $testRoot 'escaped-reserved-name-home'
    New-TestHome -Path $escapedReservedNameHome
    Write-TestFile -Path (Join-Path $escapedReservedNameHome 'agents\user-role.toml') -Content ('name = "\u0061vsp_custom"' + "`n")
    Invoke-InstallerExpectFailure -CodexHome $escapedReservedNameHome -InstallerPath $installer
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $escapedReservedNameHome 'backups'))) -Message 'escaped reserved role conflict created backups before rejection'

    $rootTableKeyHome = Join-Path $testRoot 'root-table-key-home'
    New-TestHome -Path $rootTableKeyHome
    $rootTableKeyConfig = Join-Path $rootTableKeyHome 'config.toml'
    [System.IO.File]::WriteAllText($rootTableKeyConfig, "agents = { custom = true }`n", [System.Text.UTF8Encoding]::new($false))
    $rootTableKeyBefore = [System.IO.File]::ReadAllBytes($rootTableKeyConfig)
    Invoke-InstallerExpectFailure -CodexHome $rootTableKeyHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($rootTableKeyBefore, [System.IO.File]::ReadAllBytes($rootTableKeyConfig))) -Message 'managed table root key changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $rootTableKeyHome 'backups'))) -Message 'managed table root key created backups before rejection'

    $managedScalarTableHome = Join-Path $testRoot 'managed-scalar-table-home'
    New-TestHome -Path $managedScalarTableHome
    $managedScalarTableConfig = Join-Path $managedScalarTableHome 'config.toml'
    [System.IO.File]::WriteAllText($managedScalarTableConfig, "[model_reasoning_effort]`nvalue = `"xhigh`"`n", [System.Text.UTF8Encoding]::new($false))
    $managedScalarTableBefore = [System.IO.File]::ReadAllBytes($managedScalarTableConfig)
    Invoke-InstallerExpectFailure -CodexHome $managedScalarTableHome -InstallerPath $installer
    Assert-True -Condition ([System.Linq.Enumerable]::SequenceEqual($managedScalarTableBefore, [System.IO.File]::ReadAllBytes($managedScalarTableConfig))) -Message 'managed scalar table changed config before rejection'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $managedScalarTableHome 'backups'))) -Message 'managed scalar table created backups before rejection'

    Write-Host 'install-codex.ps1 regression tests passed'
}
finally {
    if ($null -eq $originalCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $originalCodexHome }
    if (Test-Path -LiteralPath $testRoot) {
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            try {
                Remove-Item -LiteralPath $testRoot -Recurse -Force
                break
            } catch {
                if ($attempt -eq 4) { throw }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
