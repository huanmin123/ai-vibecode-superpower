# 工作流消息模板

本文件只提供计划、委派、完成和审核消息模板；路由、恢复和关闭策略以相应 skill 为准。

## 计划

```markdown
# <任务名称>
- 目标：<可观察结果>
- 授权：<允许的状态变更；只读时写无>
- 范围 / 非目标：<包含和排除项>
- 已知事实：<已核验来源和当前状态>
- 验收 / 验证：<完成条件和检查方式>
- 停止条件：<补证、重新分流或报告阻塞的条件>
```

## 委派

```markdown
task_name: <Codex task name>
agent_type: <实际 role>
fork_turns: "none"
goal: <可观察结果>
scope: <允许目标和非目标>
known_facts: <已核验事实>
authorization: <允许操作>
acceptance: <验收条件>
verification: <检查>
stop_conditions: <停止条件>
execution_contract: <步骤、不变量、边界、失败语义、回滚或恢复>
execution_risk: <delegable | protected>
execution_owner: <唯一 task path>
integration_owner: <main/root 或 Terra task path>
quality_guard: <核验实例或检查>
routing_reason: <风险分流与 role 选择理由>
```

## 完成

```markdown
task_name: <原 task_name>
actual_changes: <实际状态变化、diff 或无改动>
evidence: <文件、产物和关键输出>
verification_results: <实际检查及结果>
remaining_work_or_blocker: <未完成工作、原始错误和缺失条件>
```

## 审核

```markdown
auditor_task: <新建且此前未参与本任务的 task path>
auditor_role: <实际 role>
verdict: <pass | fail | unavailable>
requirement_coverage: <逐项验收条件 -> 证据或缺口>
scope_and_regression: <范围漂移、行为或回归风险>
verification_gaps: <未验证项及原因>
residual_risk: <残余风险；无则写无>
fallback_reason: <仅 fallback；保留原始错误>
```
