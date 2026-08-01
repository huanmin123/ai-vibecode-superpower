param(
    [Parameter(Mandatory)][string]$SkillRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Resolve-ResultClosureContract {
    param(
        [Parameter(Mandatory)][bool]$HasVerifiedActiveChild,
        [Parameter(Mandatory)][ValidateSet('evidence_needed', 'decision_needed', 'executable', 'verified_complete', 'blocked')][string]$ResultState
    )

    if ($HasVerifiedActiveChild) { return 'wait' }

    switch ($ResultState) {
        'evidence_needed' { return 'route_evidence' }
        'decision_needed' { return 'route_decision' }
        'executable' { return 'route_execution' }
        'verified_complete' { return 'close' }
        'blocked' { return 'report_blocked' }
    }
}

function Resolve-DecisionInputContract {
    param(
        [Parameter(Mandatory)][ValidateSet('confirmed', 'contradicted', 'insufficient')][string]$ClaimStatus,
        [Parameter(Mandatory)][bool]$CanFormContract
    )

    if ($ClaimStatus -ne 'confirmed') { return 'evidence_needed' }
    if (-not $CanFormContract) { return 'decision_needed' }
    return 'executable'
}

if (-not (Test-Path -LiteralPath $SkillRoot -PathType Container)) {
    throw "Skill root does not exist: $SkillRoot"
}

$skillPath = Join-Path $SkillRoot 'SKILL.md'
if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf)) {
    throw "SKILL.md does not exist: $skillPath"
}

$policy = Get-Content -LiteralPath $skillPath -Raw
foreach ($rule in @(
    '`execution_state` 只描述 WorkUnit 是否仍在运行',
    '`result_state` 使用 `evidence_needed`、`decision_needed`、`executable`、`verified_complete` 或 `blocked`',
    '交接中的主张都是待核验输入，不是结论',
    '不得因上游已交接而生成契约或关闭任务',
    '所有子任务终态后立即离开等待，先按 `result_state` 继续路由',
    '只有 `verified_complete` 且证据满足当前任务验收时才能完成',
    '`blocked` 必须传递结构化失败、已尝试操作与缺失条件'
)) {
    Assert-True -Condition $policy.Contains($rule) -Message "workflow contract is missing: $rule"
}

# This suite fixes the protocol contract; it cannot exercise the Codex desktop scheduler itself.
$closureScenarios = @(
    [pscustomobject]@{ Name = '仍有已核验活动子任务'; Active = $true; State = 'decision_needed'; Next = 'wait' },
    [pscustomobject]@{ Name = '已结束的取证结果需要补充材料'; Active = $false; State = 'evidence_needed'; Next = 'route_evidence' },
    [pscustomobject]@{ Name = '所有子任务已结束但仍需判断'; Active = $false; State = 'decision_needed'; Next = 'route_decision' },
    [pscustomobject]@{ Name = '已定结论等待执行'; Active = $false; State = 'executable'; Next = 'route_execution' },
    [pscustomobject]@{ Name = '验收证据完整'; Active = $false; State = 'verified_complete'; Next = 'close' },
    [pscustomobject]@{ Name = '无法继续时暴露阻塞'; Active = $false; State = 'blocked'; Next = 'report_blocked' }
)

foreach ($scenario in $closureScenarios) {
    $actual = Resolve-ResultClosureContract -HasVerifiedActiveChild $scenario.Active -ResultState $scenario.State
    Assert-True -Condition ($actual -eq $scenario.Next) -Message "$($scenario.Name) next=$actual, expected=$($scenario.Next)"
    Write-Host "PASS $($scenario.Name)"
}

$decisionScenarios = @(
    [pscustomobject]@{ Name = '已确认且可形成契约'; Claim = 'confirmed'; Contract = $true; State = 'executable' },
    [pscustomobject]@{ Name = '上游主张被反证'; Claim = 'contradicted'; Contract = $true; State = 'evidence_needed' },
    [pscustomobject]@{ Name = '上游主张证据不足'; Claim = 'insufficient'; Contract = $true; State = 'evidence_needed' },
    [pscustomobject]@{ Name = '已确认但尚不能形成契约'; Claim = 'confirmed'; Contract = $false; State = 'decision_needed' }
)

foreach ($scenario in $decisionScenarios) {
    $actual = Resolve-DecisionInputContract -ClaimStatus $scenario.Claim -CanFormContract $scenario.Contract
    Assert-True -Condition ($actual -eq $scenario.State) -Message "$($scenario.Name) result_state=$actual, expected=$($scenario.State)"
    Write-Host "PASS $($scenario.Name)"
}

Write-Host 'workflow-result-closure.ps1 contract tests passed'
