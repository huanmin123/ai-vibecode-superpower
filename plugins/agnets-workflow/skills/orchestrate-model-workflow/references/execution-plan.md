# 复杂任务消息模板

路由、角色与恢复规则以 [SKILL.md](../SKILL.md) 为准。本文件只约定父子 agent 如何传递任务，不创建运行时对象或状态文件。

本模板只用于已准入的复杂任务。任务表使用 `Explore / Plan / Work / Critique` 标记工作阶段；这些名称是对外进度语言，不替代控制器节点或审核协议。`Plan` 的最终目标、范围、授权和执行契约由 main/root 定案；`Critique` 仅对应该任务唯一的末端质量门，必须直接依赖全部非审核节点，不得拆成多个审核门。`Promote` 不填入任务表，只由 main/root 在质量门通过且关闭检查允许后表达可信交付。简单问答、只读查询或单文件且边界清晰低风险的直接任务不创建本模板、控制器或独立审核。

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
| <Codex task name> | Explore / Plan / Work / Critique | <role> | <必要输入> | <条件> | pending |
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
execution_owner: <当前唯一执行 agent task path>
integration_owner: <负责审核并集成的 main/root 或 Terra task path>
quality_guard: <负责核验契约、diff、产物和验证的实例或检查>
routing_reason: <为何该风险分流和 role 选择成立；xhigh executor 说明具体局部理解理由>
```

新建 `delegable` 节点的 `agent_type` 必须是 Luna executor；Terra 只执行初始即为 `protected` 的节点。Luna 已停止后若发现新选择、共享冲突、不可控副作用、不可恢复性或验证缺口，先停止并返回证据；协调者只有在形成新的完整契约、质量检查和更新后的 `assurance_assessment` 后，才能通过 `workflow_escalate_execution` 将该节点改为 `protected` 并转交 Terra；若评估出现 `unknown`，先升级至 Sol。

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

总审路由、升级链和关闭条件以 [SKILL.md](../SKILL.md) 为准。总审结果必须能回填下列字段；`fail`/`unavailable` 不得关闭任务。

```markdown
auditor_task: <新建且此前未参与本任务的 task path>
auditor_role: <avsp_sol_high | avsp_sol_xhigh | avsp_sol_max | avsp_terra_xhigh_readonly>
verdict: <pass | fail | unavailable>
requirement_coverage: <逐项验收条件 -> 证据或缺口>
scope_and_regression: <范围漂移、行为或回归风险>
verification_gaps: <未验证项及原因>
residual_risk: <残余风险；无则写无>
fallback_reason: <仅 Terra fallback；保留 Sol 不可用原始错误>
```

## 协调检查

交接、并发、恢复和关闭检查以 [SKILL.md](../SKILL.md) 为准；本模板只提醒父 agent 填完整任务包，并核对实际状态、diff、产物和验证结果。
