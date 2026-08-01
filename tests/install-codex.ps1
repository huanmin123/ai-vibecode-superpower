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
    Assert-True -Condition ($roles.Count -eq 11) -Message 'expected eleven managed role profiles'
    $readonlySubstitute = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml'
    Assert-True -Condition (Test-Path -LiteralPath $readonlySubstitute -PathType Leaf) -Message 'missing readonly Terra/xhigh Sol substitute'
    Assert-True -Condition ((Get-Content -LiteralPath $readonlySubstitute -Raw) -match 'sandbox_mode = "read-only"') -Message 'Sol substitute is not read-only'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $successHome 'agents\user-role.toml') -PathType Leaf) -Message 'unmanaged user role was not preserved'
    $installedWorkflow = Join-Path $successHome 'skills\orchestrate-model-workflow\SKILL.md'
    Assert-True -Condition (Test-Path -LiteralPath $installedWorkflow -PathType Leaf) -Message 'installed orchestration workflow is missing'
    $workflowContents = Get-Content -LiteralPath $installedWorkflow -Raw
    Assert-True -Condition ($workflowContents.Contains('唯一运行时规范')) -Message 'installed workflow does not declare a single runtime authority'
    Assert-True -Condition ($workflowContents.Contains('前者只负责意图')) -Message 'installed workflow does not keep the coordinator read-only by contract'
    Assert-True -Condition ($workflowContents.Contains('唯一一级 writer')) -Message 'installed workflow does not assign write ownership to Terra/high'
    Assert-True -Condition ($workflowContents.Contains('HandoffPacket')) -Message 'installed workflow does not require explicit handoffs'
    Assert-True -Condition ($workflowContents.Contains('0..N')) -Message 'installed workflow lost dynamic WorkUnit scaling'
    Assert-True -Condition ($workflowContents.Contains('语义改动或中高影响路径的最终验收必须使用新的')) -Message 'installed workflow lost independent final acceptance'
    foreach ($routingRule in @('纯只读任务', '不得无故插入 Terra 或 Sol', '默认每个任务最多调用一次 Sol', '高影响本身不是 Sol 触发条件', '不再追加“Terra/xhigh 复审 + 新 Terra/xhigh 验收”的重复调用', 'ImplementationContract', '不存在按文件类型或业务对象划定的写入禁止清单', '领域边界/精度/失败语义', 'WorkUnit 受阻时向直接父角色交付', '未覆盖行为', '升级原因')) {
        Assert-True -Condition ($workflowContents.Contains($routingRule)) -Message "installed workflow is missing routing guard: $routingRule"
    }
    foreach ($handoffField in @('work_id', '目标与范围/非目标', '状态', '输入或产物引用', '可验证结果与证据', '风险/未知项', '下一阶段请求', 'ImplementationContract', '所有权', '验收')) {
        Assert-True -Condition ($workflowContents.Contains($handoffField)) -Message "installed workflow handoff is missing: $handoffField"
    }
    $installedAgents = Join-Path $successHome 'AGENTS.md'
    Assert-True -Condition ((Get-Content -LiteralPath $installedAgents -Raw).Contains('## 开发规范')) -Message 'installed AGENTS.md is missing development standards'
    Assert-True -Condition ((Get-Content -LiteralPath $installedAgents -Raw).Contains('复杂开发使用 `$orchestrate-model-workflow`')) -Message 'installed AGENTS.md does not route development work through the skill'
    Assert-True -Condition (-not $workflowContents.Contains('返回其固定 role、模型/推理强度和“未写入”确认')) -Message 'installed workflow restored worker runtime metadata self-reporting'
    $installedWorkflowRoot = Join-Path $successHome 'skills\orchestrate-model-workflow'
    $installedWorkflowDesign = Join-Path $installedWorkflowRoot 'references\workflow-design.md'
    $workflowDesignContents = Get-Content -LiteralPath $installedWorkflowDesign -Raw
    Assert-True -Condition ($workflowDesignContents.Contains('不是运行时规范')) -Message 'installed workflow design does not defer runtime rules to the skill'
    Assert-True -Condition ($workflowDesignContents.Contains('HandoffPacket')) -Message 'installed workflow design lost the handoff schema'
    foreach ($designGuard in @('guard 或验证失败时交由父 `Terra/high` 按当前状态处理', '无法补证或缺少必要输入', '实施前未调用 Sol，或敏感域双阶段 / 根因仍未证实', 'work_id`、目标、范围与非目标', '受阻与继续', 'WorkUnit 受阻时向直接父角色交付')) {
        Assert-True -Condition ($workflowDesignContents.Contains($designGuard)) -Message "installed workflow design is missing: $designGuard"
    }
    $installedExecutionPlan = Join-Path $installedWorkflowRoot 'references\execution-plan.md'
    $executionPlanContents = Get-Content -LiteralPath $installedExecutionPlan -Raw
    foreach ($planField in @('work_id', 'dependencies', 'ownership', 'acceptance_and_stop', 'integration_owner', 'guard_results', 'uncovered_behaviors', 'escalation_reason', 'implementation_contract')) {
        Assert-True -Condition ($executionPlanContents.Contains($planField)) -Message "installed execution plan is missing: $planField"
    }
    Assert-True -Condition ($executionPlanContents.Contains('每个一级 workspace 写入、修复和集成')) -Message 'installed execution plan does not preserve Terra/high first-level ownership'
    Assert-True -Condition ($executionPlanContents.Contains('代码类型不是限制')) -Message 'installed execution plan still restricts Luna by code category'
    Assert-True -Condition ($executionPlanContents.Contains('领域边界/精度/失败语义')) -Message 'installed execution plan omits implementation-contract boundary semantics'
    Assert-True -Condition ($executionPlanContents.Contains('仅当纯机械、低风险且所有 guards 通过时')) -Message 'installed execution plan lost the mechanical acceptance exception'
    $installedSkillMetadata = Join-Path $installedWorkflowRoot 'agents\openai.yaml'
    Assert-True -Condition ((Get-Content -LiteralPath $installedSkillMetadata -Raw).Contains('不要假定设计、复审、修复或最终验收均必经')) -Message 'installed workflow metadata restores mandatory stages'
    $installedWriter = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_terra_high.toml'
    Assert-True -Condition ((Get-Content -LiteralPath $installedWriter -Raw).Contains('唯一一级 Terra/high')) -Message 'installed Terra/high role does not own implementation leadership'
    $installedLunaHighWriter = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_high_writer.toml'
    $installedLunaXhighWriter = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_luna_xhigh_writer.toml'
    foreach ($installedLunaWriter in @($installedLunaHighWriter, $installedLunaXhighWriter)) {
        $writerContents = Get-Content -LiteralPath $installedLunaWriter -Raw
        Assert-True -Condition ($writerContents.Contains('只接受 `avsp_terra_high` 的直接委派')) -Message "installed Luna writer is not limited to a Terra/high parent: $installedLunaWriter"
        Assert-True -Condition ($writerContents.Contains('不得继续派生')) -Message "installed Luna writer permits child delegation: $installedLunaWriter"
        Assert-True -Condition ($writerContents.Contains('可修改任何指定的代码或产物')) -Message "installed Luna writer cannot implement contract code: $installedLunaWriter"
        Assert-True -Condition ($writerContents.Contains('ImplementationContract')) -Message "installed Luna writer is missing an implementation contract: $installedLunaWriter"
        Assert-True -Condition ($writerContents.Contains('领域边界/精度/失败语义')) -Message "installed Luna writer contract omits boundary semantics: $installedLunaWriter"
        Assert-True -Condition ($writerContents.Contains('WorkUnit 受阻时向直接父角色交付')) -Message "installed Luna writer does not return blocked work to its parent: $installedLunaWriter"
        Assert-True -Condition (-not $writerContents.Contains('不得修改生产逻辑')) -Message "installed Luna writer still has a production-code ban: $installedLunaWriter"
        Assert-True -Condition (-not $writerContents.Contains('HandoffPacket')) -Message "installed Luna writer duplicated central handoff policy: $installedLunaWriter"
        Assert-True -Condition ($writerContents -match 'sandbox_mode = "danger-full-access"') -Message "installed Luna writer does not have the configured full-access sandbox: $installedLunaWriter"
    }
    $installedTerraXhigh = Join-Path $successHome 'agents\ai-vibecode-superpower\ai-vibecode-superpower-avsp_terra_xhigh.toml'
    $terraXhighContents = Get-Content -LiteralPath $installedTerraXhigh -Raw
    Assert-True -Condition ($terraXhighContents.Contains('始终只读')) -Message 'installed Terra/xhigh is not declared readonly'
    Assert-True -Condition ($terraXhighContents.Contains('最终验收')) -Message 'installed Terra/xhigh is missing its final acceptance responsibility'
    Assert-True -Condition ($terraXhighContents.Contains('先回到 Luna 取证')) -Message 'installed Terra/xhigh skips the required Luna re-evidence step'
    $terraHighContents = Get-Content -LiteralPath $installedWriter -Raw
    Assert-True -Condition ($terraHighContents.Contains('WorkUnit 受阻时向直接父角色交付')) -Message 'installed Terra/high does not return blocked work to its parent'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_list = \["one", "two"\]') -Message 'unmanaged array was not preserved'
    Assert-True -Condition ((Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw) -match 'unmanaged_inline = \{ enabled = true \}') -Message 'unmanaged inline table was not preserved'
    $successConfig = Get-Content -LiteralPath (Join-Path $successHome 'config.toml') -Raw
    Assert-True -Condition ($successConfig -match '(?m)^model_reasoning_effort = "high"\r?$') -Message 'managed controller reasoning effort was not installed'
    Assert-True -Condition ($successConfig -match '(?m)^sandbox_mode = "danger-full-access"\r?$') -Message 'managed sandbox mode was not installed'
    Assert-True -Condition ($successConfig -notmatch '(?m)^js_repl\s*=') -Message 'default js_repl was injected into a new target'
    $installedAgentsContents = Get-Content -LiteralPath $installedAgents -Raw
    Assert-True -Condition ($installedAgentsContents.Contains('## 开发规范')) -Message 'installed AGENTS.md is missing development standards'
    Assert-True -Condition ($installedAgentsContents.Contains('复杂开发使用 `$orchestrate-model-workflow`')) -Message 'installed AGENTS.md does not route development work through the skill'
    $sourceReadmeContents = Get-Content -LiteralPath (Join-Path $repoRoot 'README.md') -Raw
    foreach ($readmeGuard in @('guard 或验证失败由 `Terra/high` 按当前状态处理', '无法补证或缺少必要输入', '实施前未调用 Sol，或敏感域双阶段 / 根因仍未证实', '范围与非目标', '领域边界/精度/失败语义', 'WorkUnit 受阻时向直接父角色交付', 'Luna 是否可以写不是由“是不是生产代码”决定')) {
        Assert-True -Condition ($sourceReadmeContents.Contains($readmeGuard)) -Message "source README is missing workflow guard: $readmeGuard"
    }
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
    $complexConfigPath = Join-Path $complexExistingHome 'config.toml'
    $complexConfigBefore = Get-Content -LiteralPath $complexConfigPath -Raw
    [System.IO.File]::WriteAllText($complexConfigPath, "sandbox_mode = `"read-only`"`n$complexConfigBefore", [System.Text.UTF8Encoding]::new($false))
    Add-Content -LiteralPath $complexConfigPath -Value 'js_repl = false'
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
    Assert-True -Condition ($complexConfig -match '(?m)^sandbox_mode = "danger-full-access"\r?$') -Message 'managed sandbox mode was not updated'
    Assert-True -Condition ($complexConfig -match '(?m)^js_repl = false\r?$') -Message 'existing unmanaged js_repl was not preserved'

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
