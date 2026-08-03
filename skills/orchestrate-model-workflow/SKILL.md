---
name: orchestrate-model-workflow
description: "在复杂开发、实现、修复、架构设计、Bug 或漏洞诊断、复审和验收中，使用 Codex 命名 agent role 按证据、决策风险和执行风险分工。"
---

# 多模型工作流编排

本文件是路由、所有权、交接和验收的唯一运行规则。role profile 定义本地提示和模型偏好；[execution-plan.md](references/execution-plan.md) 只提供复杂任务的消息模板。

## Codex 运行边界

Codex 原生提供命名 role、父子 agent、消息、等待/中断和实例状态。`execution_contract`、`execution_risk` 与 `operation_owner` 只是任务消息中的协调字段，不是原生对象、锁或 ACL；父 agent 必须核验实际 role、消息、状态、diff、产物和验证输出。

role 会先应用，但 child 随后继承父 turn 的 approval policy 和 permission profile。因此 profile 中的 `sandbox_mode = "read-only"` 是行为边界和配置意图，不是可由 profile 单独证明的硬隔离。父 agent 在委派前核验实际有效权限；model/effort 以成功加载的 role 为准，role 或模型不可用时保留原始错误。

当前运行时只在 session persistence/state DB 启用且写入成功时，才可能保留部分 thread metadata、父子边、已处理通信或 rollout。重启后只能使用实际可读状态并重新核验工作区；不得假定 mailbox、pending wakeup、running turn 或 wait 状态可恢复，也不得发明队列、自动重试、exactly-once 或自定义持久状态。

## Role 与拓扑

这是消息和提示策略，不是 Codex 运行时 ACL：main/root 可按独立目标并行创建 `1..N` 个 Luna、Terra 或 Sol 分支。只读分支必须有互补证据域或不同决策问题；状态变更分支只能由 main/root 直接委派 `1..N` 个 `avsp_terra_high`，且写入目标必须互斥。每个 Terra 可直接管理 `1..N` 个 Luna writer，但每个 writer 只执行一个完整且互不冲突的契约。共享文件、数据或外部状态必须串行。这里没有角色数量的静态上限，实际并发量仍受当前 `agents.max_threads`、`agents.max_depth` 和资源约束。只有 `avsp_terra_high` 可以继续委派状态变更执行者，且只能直接委派 `avsp_luna_high_writer` 或 `avsp_luna_xhigh_writer`；writer 是叶节点。所有 Luna 只读 role、Sol、Terra readonly fallback 与 `avsp_terra_xhigh` 都不得派生子 agent。最终独立 `avsp_terra_xhigh` 验收由 main/root 新建，不能由实施 Terra 自审或复用之前的定案/预审实例。

| 用途 | `agent_type` | 选择条件 |
| --- | --- | --- |
| 常规取证、预审 | `avsp_luna_high` | 一般只读证据域 |
| 深入取证、复杂预审 | `avsp_luna_xhigh` | 需要更深局部证据理解 |
| 已定契约执行 | `avsp_luna_high_writer` / `avsp_luna_xhigh_writer` | 仅直接父 `avsp_terra_high` 的 `delegable` 状态变更任务 |
| Luna 只读替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 对应 Luna role 真正不可用时一对一替代 |
| 高风险未决定案、正式复审 | `avsp_sol_high` | 证据基本一致，但高风险决策仍未决 |
| 升级调查、受约束重设计 | `avsp_sol_xhigh` | 证据冲突、根因未证实、无可靠 oracle，或需重新思考 |
| Sol 只读替代 | `avsp_terra_xhigh_readonly` | 所选 Sol role 或模型真正不可用，必须披露独立性下降 |
| 契约、保护执行与集成 | `avsp_terra_high` | 唯一可委派 writer 的命名 role |
| 有界定案、复审、最终验收 | `avsp_terra_xhigh` | 新建的独立只读实例 |

## 委派、路由与执行

命名 `agent_type` 的 `spawn_agent` 必须显式传 `fork_turns="none"`，并使用自包含消息。仅确需有限最近上下文时才传正整数；不得省略。`fork_turns="all"` 仅用于继承父 role 的 full-history fork，且不得同时传自定义 `agent_type`。

1. **只需事实**：按独立且互补的证据域直接委派 `1..N` 个 Luna；不得为同一事实重复创建分支。证据不足但可补充时继续 Luna；无法补证、授权缺失或必要外部输入缺失时停止并报告。
2. **需要判断**：证据充分且边界受控时委派 `avsp_terra_xhigh`。只有高风险未知仍会改变结果时选择 `avsp_sol_high`；满足表中的升级条件时选择 `avsp_sol_xhigh`。风险域名称或影响大本身不触发 Sol。
3. **需要状态变更**：main/root 可直接委派 `1..N` 个 `avsp_terra_high`，但每个分支必须有独立且互斥的写入目标。先在消息的 `execution_contract` 中写明目标行为、已定步骤、允许目标与非目标、授权、唯一 owner、关键不变量、适用领域边界/精度、失败语义、回滚或恢复、验证和停止条件。仍有会改变行为、风险或兼容性的选择时不得委派 executor。
4. **执行风险**：只有影响面受控、失败可回滚或恢复、外部副作用受限、共享状态与顺序风险已解决且有可靠验证时才是 `delegable`；否则为 `protected`，由 Terra 直接执行。Terra 可把 `1..N` 个互不冲突的 `delegable` 契约并行交给 Luna writer；默认 Luna/high，只有完整契约仍需更深局部理解时用 xhigh writer，并说明理由。`operation_owner` 只用于状态变更任务；并行任务的写入目标必须互斥。
5. **验收**：实施 Terra 审核 writer 的实际结果。纯机械低风险改动在机器 guards 全通过后可由新的 Luna 预审闭环；语义、中高影响或 `protected` 改动由 main/root 新建独立 `avsp_terra_xhigh` 最终验收。证据冲突、根因未证实或无可靠 oracle 时再升级 Sol。

## 消息、失败与恢复

父 agent 发送自包含任务包：role、目标、范围与非目标、授权、必要事实、验收、验证、返回格式和停止条件；状态变更再附契约、风险与 owner。子 agent 返回实际改动、证据、验证、未完成工作和原始错误，父 agent 只在实际核验后集成或关闭。

`send_message` 只投递；`followup_task` 的成功只表示已提交触发请求，不证明 turn 已启动或完成；`wait_agent` 只等待 mailbox activity、steering 或 timeout，不代表目标终态；`interrupt_agent` 的成功、no-op 或 previous status 都不证明已终止，`Interrupted` 不是 final。恢复或替换前必须检查 `list_agents`、实际状态/历史/输出及旧实例是否已停止写入。

Luna readonly 真正不可用时才一对一改用对应 Terra low/medium readonly 并保留原错。所选 Sol role 或模型真正不可用时才改用 Terra xhigh readonly 并披露独立性下降；timeout、证据不足或普通失败不属于不可用。writer 失败时，Terra 核验状态、diff、产物和输出，确认旧 writer 已停止或不再写入后，才可同 role 替换一次或自行接管。Terra high 不可用时，main/root 不得绕过层级直派 writer；只有授权和有效权限允许时接管同一合同，否则停止报告。所有 fallback 都是父 agent 的显式动作，不是 Codex 自动行为。

若 session persistence/state DB 未启用、写入失败或重启后没有可读的必要状态，只做一次当前状态、diff 和输出盘点，保留原始错误与缺失条件，停止当前恢复或替换并交回父级或用户。不得声称自动恢复、已排队或自动重试，也不得重复只读验证。

记录 guards 为 `pass`、`fail` 或 `unavailable`；后者不等于通过。只有验收满足且没有必需工作剩余时关闭，并交付实际改动、验证证据、未覆盖行为、残余风险和未解决问题。
