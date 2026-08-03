# 复杂任务消息模板

路由、角色与恢复规则以 [SKILL.md](../SKILL.md) 为准。本文件只约定父子 agent 如何传递任务，不创建运行时对象或状态文件。

## 计划

```markdown
# <任务名称>

- 目标：<可观察结果>
- 授权：<允许的状态变更；只读时写无>
- 范围 / 非目标：<包含和排除项>
- 已知事实：<已核验来源和当前状态>
- 验收 / 验证：<完成条件和检查方式>
- 停止条件：<何时补证、升级或报告阻塞>

| task_name | 阶段 | agent_type | 输入/依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- | --- |
| <Codex task name> | 取证 / 定案 / 实施 / 预审 / 总验收 | <role> | <必要输入> | <条件> | pending |
```

## 委派消息

```markdown
task_name: <传给 spawn_agent 的名称>
agent_type: <实际 role>
fork_turns: "none"
goal: <可观察结果>
scope: <允许目标和非目标>
known_facts: <已核验的必要事实>
authorization: <允许的操作>
acceptance: <验收条件>
verification: <要求执行的检查>
stop_conditions: <停止并交回父级的条件>

# 仅状态变更任务添加
execution_contract: <已定步骤、不变量、领域边界/精度、失败语义和回滚/恢复方式>
execution_risk: <delegable | protected>
operation_owner: <当前唯一 agent task path>
effort_reason: <仅 xhigh writer；填写具体局部理解理由>
```

默认使用自包含消息。只有确需有限最近上下文时，`fork_turns` 才能改为正整数；`all` 只能用于不传自定义 `agent_type` 的 full-history fork。

## 完成消息

```markdown
task_name: <原 task_name>
actual_changes: <实际状态变化、diff 或无改动>
evidence: <文件、产物和关键输出>
verification_results: <实际检查及结果>
remaining_work_or_blocker: <未完成工作；保留原始错误和缺失条件>
```

子 agent 未返回时，父 agent 先核验 `list_agents`、实例状态/历史、diff、产物和验证输出。投递、触发、等待或中断的工具返回都不等于子任务完成或已经停止写入。

## 任务级总验收

每个有状态变更的任务在关闭前，由 main/root 新建此前未参与该任务的 `avsp_sol_high` 做总验收；仅在证据冲突、根因未证实、无可靠 oracle 或需受约束重设计时使用 `avsp_sol_xhigh`。所选 Sol role 或模型被实际证明不可用时，使用此前未参与该任务的 `avsp_terra_xhigh_readonly` 兜底同一验收并披露独立性降级；超时、证据不足或普通失败不得降级。输入必须包含原始目标、逐项验收条件、范围/非目标、执行契约、实际 diff/产物、验证输出和已知风险。验收返回 `pass`、`fail` 或 `unavailable`，并逐项说明需求覆盖、范围漂移、行为或回归风险、验证缺口与残余风险。缺少审核实例标识、逐项需求覆盖或证据时视为 `unavailable`。`fail` 或 `unavailable` 不得关闭任务；修复或补证后必须新建另一独立 Sol 实例重新验收。

```markdown
auditor_task: <新建且此前未参与本任务的 task path>
auditor_role: <avsp_sol_high | avsp_sol_xhigh | avsp_terra_xhigh_readonly>
verdict: <pass | fail | unavailable>
requirement_coverage: <逐项验收条件 -> 证据或缺口>
scope_and_regression: <范围漂移、行为或回归风险>
verification_gaps: <未验证项及原因>
residual_risk: <残余风险；无则写无>
fallback_reason: <仅 Terra fallback；保留 Sol 不可用原始错误>
```

## 协调检查

- main/root 可为独立目标并行创建 `1..N` 个 Luna、Terra 或 Sol；状态变更只能直派 `1..N` 个 Terra，且写入目标必须互斥。只有该 Terra 可直接委派 Luna writer，且 writer 为叶节点。
- 同一 Terra 可并行管理 `1..N` 个 Luna；只读分支必须提供互补证据，writer 分支必须使用独立、完整且写入目标互斥的契约。
- 状态变更任务的契约完整后才选择 executor；`protected` 不交 Luna；xhigh writer 有具体理由。
- 并行写入目标互斥；接管或替代前确认旧 executor 已终止或不再写入。
- 只有证据满足验收时才关闭；保留实际验证、未覆盖行为和残余风险。
- 仅在实际可读的运行时持久状态存在时使用它；缺失时只盘点当前状态、diff 和输出，保留原始错误与缺失条件并交回父级或用户，不声称自动恢复、已排队或自动重试。
