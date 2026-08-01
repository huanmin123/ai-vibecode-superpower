param(
    [Parameter(Mandatory)][string]$SkillRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Resolve-SettlementContract {
    param(
        [Parameter(Mandatory)][object[]]$Children,
        [Parameter(Mandatory)][bool]$OriginalWorkComplete,
        [Parameter(Mandatory)][bool]$ReplacementAlreadyCreated
    )

    $activeChildren = @($Children |
        Where-Object { $_.State -eq 'active' -and $_.Verified } |
        Group-Object Id |
        ForEach-Object { $_.Group | Select-Object -First 1 })
    $terminalChildren = @($Children |
        Where-Object { -not ($_.State -eq 'active' -and $_.Verified) } |
        Group-Object Id |
        ForEach-Object { $_.Group | Select-Object -First 1 })
    $consumed = @($terminalChildren | Where-Object HasHandoff | ForEach-Object Id)
    $reconstructed = @($terminalChildren | Where-Object { -not $_.HasHandoff -and $_.HasEvidence } | ForEach-Object Id)
    $missing = @($terminalChildren | Where-Object { -not $_.HasHandoff -and -not $_.HasEvidence } | ForEach-Object Id)

    if ($activeChildren.Count -gt 0) {
        $nextAction = if ($missing.Count -gt 0) { 'wait_with_result_missing' } else { 'wait' }
        return [pscustomobject]@{
            Waiting = @($activeChildren.Id)
            Consumed = $consumed
            Reconstructed = $reconstructed
            Missing = $missing
            NextAction = $nextAction
            ReplacementCount = 0
        }
    }

    if ($missing.Count -gt 0 -and $OriginalWorkComplete) {
        $nextAction = 'fail_result_missing'
    } elseif ($OriginalWorkComplete) {
        $nextAction = 'integrate'
    } elseif ($ReplacementAlreadyCreated) {
        $nextAction = 'fail_unfinished'
    } else {
        $nextAction = 'replace_once'
    }

    return [pscustomobject]@{
        Waiting = @()
        Consumed = $consumed
        Reconstructed = $reconstructed
        Missing = $missing
        NextAction = $nextAction
        ReplacementCount = if ($nextAction -eq 'replace_once') { 1 } else { 0 }
    }
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
    '只等待可读取且已核验活动的执行实例',
    '幂等消费并移出等待集合',
    '证据不足则标记 `result_missing`',
    '所有子任务终态后立即离开等待',
    '创建一次替代实例',
    '原工作仍未完成时才按恢复规则创建一次替代实例',
    '不得等待失联实例返回、反复创建替代实例',
    '不得自动降级、隐藏错误或报告成功',
    '不得对终态实例重复等待、无限轮询、静默降级、假定完成'
)) {
    Assert-True -Condition $policy.Contains($rule) -Message "workflow contract is missing: $rule"
}

# This suite fixes the protocol contract; it cannot exercise the Codex desktop scheduler itself.
$scenarios = @(
    [pscustomobject]@{ Name = '完成且有交接'; Children = @([pscustomobject]@{ Id = 'A'; State = 'completed'; Verified = $true; HasHandoff = $true; HasEvidence = $true }); Complete = $true; Replaced = $false; Waiting = ''; Consumed = 'A'; Reconstructed = ''; Missing = ''; Next = 'integrate'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '失败但有可重建证据'; Children = @([pscustomobject]@{ Id = 'B'; State = 'failed'; Verified = $true; HasHandoff = $false; HasEvidence = $true }); Complete = $true; Replaced = $false; Waiting = ''; Consumed = ''; Reconstructed = 'B'; Missing = ''; Next = 'integrate'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '取消但有交接且原工作未完成'; Children = @([pscustomobject]@{ Id = 'C'; State = 'cancelled'; Verified = $true; HasHandoff = $true; HasEvidence = $true }); Complete = $false; Replaced = $false; Waiting = ''; Consumed = 'C'; Reconstructed = ''; Missing = ''; Next = 'replace_once'; ReplacementCount = 1 },
    [pscustomobject]@{ Name = '终态缺结果且无证据'; Children = @([pscustomobject]@{ Id = 'D'; State = 'completed'; Verified = $true; HasHandoff = $false; HasEvidence = $false }); Complete = $true; Replaced = $false; Waiting = ''; Consumed = ''; Reconstructed = ''; Missing = 'D'; Next = 'fail_result_missing'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '失联且原工作未完成'; Children = @([pscustomobject]@{ Id = 'E'; State = 'lost'; Verified = $false; HasHandoff = $false; HasEvidence = $false }); Complete = $false; Replaced = $false; Waiting = ''; Consumed = ''; Reconstructed = ''; Missing = 'E'; Next = 'replace_once'; ReplacementCount = 1 },
    [pscustomobject]@{ Name = '混合活动与终态实例'; Children = @([pscustomobject]@{ Id = 'F'; State = 'active'; Verified = $true; HasHandoff = $false; HasEvidence = $false }, [pscustomobject]@{ Id = 'G'; State = 'completed'; Verified = $true; HasHandoff = $true; HasEvidence = $true }); Complete = $false; Replaced = $false; Waiting = 'F'; Consumed = 'G'; Reconstructed = ''; Missing = ''; Next = 'wait'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '活动期间记录缺失结果'; Children = @([pscustomobject]@{ Id = 'H'; State = 'active'; Verified = $true; HasHandoff = $false; HasEvidence = $false }, [pscustomobject]@{ Id = 'I'; State = 'failed'; Verified = $true; HasHandoff = $false; HasEvidence = $false }); Complete = $false; Replaced = $false; Waiting = 'H'; Consumed = ''; Reconstructed = ''; Missing = 'I'; Next = 'wait_with_result_missing'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '无法核验的历史活动实例'; Children = @([pscustomobject]@{ Id = 'J'; State = 'active'; Verified = $false; HasHandoff = $false; HasEvidence = $false }); Complete = $false; Replaced = $false; Waiting = ''; Consumed = ''; Reconstructed = ''; Missing = 'J'; Next = 'replace_once'; ReplacementCount = 1 },
    [pscustomobject]@{ Name = '多个终态结果分别消费和重建'; Children = @([pscustomobject]@{ Id = 'K'; State = 'completed'; Verified = $true; HasHandoff = $true; HasEvidence = $true }, [pscustomobject]@{ Id = 'L'; State = 'failed'; Verified = $true; HasHandoff = $false; HasEvidence = $true }); Complete = $true; Replaced = $false; Waiting = ''; Consumed = 'K'; Reconstructed = 'L'; Missing = ''; Next = 'integrate'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '重复终态通知幂等消费'; Children = @([pscustomobject]@{ Id = 'M'; State = 'completed'; Verified = $true; HasHandoff = $true; HasEvidence = $true }, [pscustomobject]@{ Id = 'M'; State = 'completed'; Verified = $true; HasHandoff = $true; HasEvidence = $true }); Complete = $true; Replaced = $false; Waiting = ''; Consumed = 'M'; Reconstructed = ''; Missing = ''; Next = 'integrate'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '重复活动通知只等待一次'; Children = @([pscustomobject]@{ Id = 'N'; State = 'active'; Verified = $true; HasHandoff = $false; HasEvidence = $false }, [pscustomobject]@{ Id = 'N'; State = 'active'; Verified = $true; HasHandoff = $false; HasEvidence = $false }); Complete = $false; Replaced = $false; Waiting = 'N'; Consumed = ''; Reconstructed = ''; Missing = ''; Next = 'wait'; ReplacementCount = 0 },
    [pscustomobject]@{ Name = '替代实例已创建后仍未完成'; Children = @([pscustomobject]@{ Id = 'O'; State = 'lost'; Verified = $false; HasHandoff = $false; HasEvidence = $true }); Complete = $false; Replaced = $true; Waiting = ''; Consumed = ''; Reconstructed = 'O'; Missing = ''; Next = 'fail_unfinished'; ReplacementCount = 0 }
)

foreach ($scenario in $scenarios) {
    $result = Resolve-SettlementContract -Children $scenario.Children -OriginalWorkComplete $scenario.Complete -ReplacementAlreadyCreated $scenario.Replaced
    foreach ($field in @('Waiting', 'Consumed', 'Reconstructed', 'Missing')) {
        $actual = @($result.$field) -join ','
        Assert-True -Condition ($actual -eq $scenario.$field) -Message "$($scenario.Name) $field=$actual, expected=$($scenario.$field)"
    }
    Assert-True -Condition ($result.NextAction -eq $scenario.Next) -Message "$($scenario.Name) next=$($result.NextAction), expected=$($scenario.Next)"
    Assert-True -Condition ($result.ReplacementCount -eq $scenario.ReplacementCount) -Message "$($scenario.Name) replacement_count=$($result.ReplacementCount), expected=$($scenario.ReplacementCount)"
    Write-Host "PASS $($scenario.Name)"
}

Write-Host 'workflow-result-settlement.ps1 contract tests passed'
