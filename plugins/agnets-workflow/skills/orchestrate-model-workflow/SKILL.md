---
name: orchestrate-model-workflow
description: "在复杂开发、实现、修复、架构设计、Bug 或漏洞诊断、复审和验收中，使用 Codex 命名 agent role 按证据、决策风险和执行风险分工。"
---

# 多模型工作流编排

本文件是路由、所有权、交接和验收的唯一运行规则。role profile 定义本地提示和模型偏好；[execution-plan.md](references/execution-plan.md) 只提供复杂任务的消息模板。

## Codex 运行边界

Codex 原生提供命名 role、父子 agent、消息、等待/中断和实例状态。`execution_contract`、`execution_risk`、`execution_owner`、`integration_owner` 与 `quality_guard` 只是任务消息中的协调字段，不是原生对象、锁或 ACL；父 agent 必须核验实际 role、消息、状态、diff、产物和验证输出。

role 会先应用，但 child 随后继承父 turn 的 approval policy 和 permission profile。因此 profile 中的 `sandbox_mode = "read-only"` 是行为边界和配置意图，不是可由 profile 单独证明的硬隔离。父 agent 在委派前核验实际有效权限；model/effort 以成功加载的 role 为准，role 或模型不可用时保留原始错误。

当前运行时只在 session persistence/state DB 启用且写入成功时，才可能保留部分 thread metadata、父子边、已处理通信或 rollout。某些 Codex 运行时提供按原生 thread UUID 恢复已关闭代理的 `resume_agent`，但这不是插件或 MCP 可读取/调用的通用接口；重启后不得假定 mailbox、pending wakeup、running turn 或 wait 状态可恢复。没有实际暴露的 `resume_agent` 与可读 thread UUID 时，只能用控制器的 checkpoint、任务状态和工作区证据创建新代理，不得声称恢复了旧会话。

## Role 与拓扑

这是消息和提示策略，不是 Codex 运行时 ACL：main/root 可按独立目标并行创建 `1..N` 个 Luna、Terra 或 Sol 分支。只读分支必须有互补证据域或不同决策问题；状态变更仅可由 main/root 或 `avsp_terra_high` 直接委派新的 Luna executor，且每个写入目标必须互斥。共享文件、数据或外部状态必须串行。只有完整契约、`execution_risk=delegable`、唯一 `execution_owner` 且影响和恢复受控时，main/root 或 Terra 才可直派 `avsp_luna_high_executor` 或 `avsp_luna_xhigh_executor`；executor 是叶节点。其他状态变更由 Terra 保护执行和集成。这里没有角色数量的静态上限，实际并发量仍受当前 `agents.max_threads`、`agents.max_depth` 和资源约束。所有 Luna 只读 role、Luna executor、Sol、Terra readonly fallback 与 `avsp_terra_xhigh` 都不得派生子 agent；Sol 也不得派写入节点。任务级总验收由 main/root 新建、此前未参与该任务的 Sol 实例完成；仅所选 Sol role 或模型实际不可用时使用 `avsp_terra_xhigh_readonly` 兜底。缺少可核验的总审结果等同 `unavailable`，不得关闭；Codex 没有可由本工作流配置的原生关闭 hook，父 agent 仍须实际执行这一 guard。

| 用途 | `agent_type` | 选择条件 |
| --- | --- | --- |
| 常规取证、预审 | `avsp_luna_high` | 一般只读证据域 |
| 深入取证、复杂预审 | `avsp_luna_xhigh` | 需要更深局部证据理解 |
| 已定契约执行 | `avsp_luna_high_executor` / `avsp_luna_xhigh_executor` | main/root 或 `avsp_terra_high` 直接委派的 `delegable` 状态变更任务；executor 为叶节点 |
| Luna 只读替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 对应 Luna role 真正不可用时一对一替代 |
| 高难定案、复杂复审、任务级总验收 | `avsp_sol_high` | 证据充分，但多约束权衡、跨域影响或推理复杂度高；也是总验收默认 role |
| 升级调查、受约束重设计、升级总验收 | `avsp_sol_xhigh` | 证据冲突、根因未证实、无可靠 oracle，或需重新思考 |
| Sol 只读替代、总验收兜底 | `avsp_terra_xhigh_readonly` | 所选 Sol role 或模型真正不可用时替代同一只读阶段，必须披露独立性下降 |
| 契约、保护执行与集成 | `avsp_terra_high` | 处理 `protected` 状态变更、审核 executor 结果并负责集成；可直接委派 executor |
| 有界定案、常规复审 | `avsp_terra_xhigh` | 证据充分、范围有界且推理路径常规的新建独立只读实例 |

## 委派、路由与执行

命名 `agent_type` 的 `spawn_agent` 必须显式传 `fork_turns="none"`，并使用自包含消息。仅确需有限最近上下文时才传正整数；不得省略。`fork_turns="all"` 仅用于继承父 role 的 full-history fork，且不得同时传自定义 `agent_type`。

状态变更包括任何持久工作区文件、配置、依赖或锁文件、生成产物、版本控制状态、数据库或其他数据，以及外部服务、API、部署或消息状态的改变。只有能够证明未改变上述任一状态的任务才是只读；无法证明时必须按状态变更处理并进入任务级总验收。

对外部仓库的状态变更，在创建工作流节点、下载完整源码、安装依赖或委派执行者之前，main/root 必须做一次只读预检：固定目标分支的提交、读取根 `AGENTS.md` 以及仓库明确指向的贡献/维护限制，并核对目标需求是否被允许。若规则要求用户确认、仅接受特定类别修复，或禁止该类改动，保留原始约束并停止该仓库的执行；不得把它当作普通失败重试，也不得以本地实验为由绕过。预检未发现限制后，才可建立该仓库的执行合同；网络不可达时可改用可核验的固定提交源码归档，但仍必须完成同一预检。

1. **只需事实**：按独立且互补的证据域直接委派 `1..N` 个 Luna；不得为同一事实重复创建分支。证据不足但可补充时继续 Luna；无法补证、授权缺失或必要外部输入缺失时停止并报告。
2. **需要判断**：证据充分时，`avsp_terra_xhigh` 与 `avsp_sol_high` 同属定案层，按难度分流而非先后升级：范围有界且推理路径常规时选 Terra；存在多约束权衡、跨域影响或高复杂度推理时选 Sol。高影响或风险域名称本身不触发 Sol。仅在证据冲突、根因未证实、无可靠 oracle 或需受约束重设计时升级 `avsp_sol_xhigh`。
3. **需要状态变更**：先在消息的 `execution_contract` 中写明目标行为、已定步骤、允许目标与非目标、授权、关键不变量、适用领域边界/精度、失败语义、回滚或恢复、验证和停止条件；每个写入任务还必须明确 `execution_owner`、`integration_owner`、`quality_guard`、`execution_risk` 和 `routing_reason`。仍有会改变行为、风险或兼容性的选择时不得委派 executor。main/root 直派 executor 时，main/root 是 `integration_owner`；Terra 直派 executor 时，Terra 必须审核并集成结果。
4. **执行风险**：只有影响面受控、失败可回滚或恢复、外部副作用受限、共享状态与顺序风险已解决且有可靠验证时才是 `delegable`；否则为 `protected`，由 Terra 直接执行。main/root 或 Terra 可把 `1..N` 个互不冲突的 `delegable` 契约并行交给 Luna executor；默认 Luna/high，只有完整契约仍需更深局部理解时用 xhigh executor，并在 `routing_reason` 记录理由。缺少任一审计字段、字段冲突、旧清单或共享写入时一律按 `protected`，不得静默当作可委派。`execution_owner` 是每个状态变更的唯一执行者；并行任务的写入目标必须互斥。
5. **任务级总验收**：每个发生状态变更的任务，在 main/root 宣布完成前都必须新建独立 Sol 实例做总验收；任何此前参与该任务的 Luna、Terra、Sol、writer、预审或 fallback 实例均不得复用。默认使用 `avsp_sol_high`；证据冲突、根因未证实、无可靠 oracle 或需受约束重设计时使用 `avsp_sol_xhigh`。仅在所选 Sol role 或模型被实际证明不可用时，才使用此前未参与该任务的 `avsp_terra_xhigh_readonly` 兜底同一总验收，并披露独立性下降；超时、证据不足或普通失败不得降级。总验收核验原始目标、验收条件、范围与非目标、执行契约、实际 diff/产物、验证结果、需求覆盖、范围漂移、回归风险和未验证项；返回可核验的审核实例标识、`pass`、`fail` 或 `unavailable` 及证据。缺少任一项按 `unavailable` 处理。`fail` 或 `unavailable` 时不得关闭任务，main/root 必须补证或修复后新建另一独立 Sol 实例重新总验收。先写入同时匹配当前工作区指纹和 `workflow_snapshot` 的审查记录，才可将唯一 `total_review` 节点标为 `succeeded`；控制器拒绝反序，并在任一非总审节点结果、状态或重试改变后使旧审查失效。旧状态若已把未记录总审标为成功，确认旧实例已停止后才可显式重开该节点，不得伪造或补写旧审查。

## 消息、失败与恢复

父 agent 发送自包含任务包：role、目标、范围与非目标、授权、必要事实、验收、验证、返回格式和停止条件；状态变更再附契约、风险与 owner。子 agent 返回实际改动、证据、验证、未完成工作和原始错误，父 agent 只在实际核验后集成或关闭。

`send_message` 只投递；`followup_task` 的成功只表示已提交触发请求，不证明 turn 已启动或完成；`wait_agent` 只等待 mailbox activity、steering 或 timeout，不代表目标终态；`interrupt_agent` 的成功、no-op 或 previous status 都不证明已终止，`Interrupted` 不是 final。恢复或替换前必须检查 `list_agents`、实际状态/历史/输出及旧实例是否已停止写入。

Luna readonly 真正不可用时才一对一改用对应 Terra low/medium readonly 并保留原错。所选 Sol role 或模型真正不可用时才改用 Terra xhigh readonly 并披露独立性下降；timeout、证据不足或普通失败不属于不可用。executor 失败时，`integration_owner` 核验状态、diff、产物和输出，确认旧 executor 已停止或不再写入后，才可用新完整契约替换一次或交由 Terra 接管。Terra high 不可用时，main/root 可在契约仍完整、`delegable` 且自身承担 `integration_owner` 时直派 executor；其他情况停止报告。所有 fallback 都是父 agent 的显式动作，不是 Codex 自动行为。

若 session persistence/state DB 未启用、写入失败或重启后没有可读的必要状态，只做一次当前状态、diff 和输出盘点，保留原始错误与缺失条件，停止当前恢复或替换并交回父级或用户。对于持久化控制器节点，main/root 可在原生状态已确认旧执行者停止后自动调用 `workflow_requeue_stale` 并派发替代实例；这不是 Codex 内部会话恢复，也不适用于未受控制器管理的任务。不得声称自动恢复、已排队或自动重试，也不得重复只读验证。

总审开始前，main/root 先完成所有会写入被审工作区的验证、清理已知测试产物，并调用 `audit-context` 冻结工作区指纹和 `workflow_snapshot`。总审实例不得在该被指纹绑定的工作区执行可能写入文件的命令（包括可能生成 WAL、锁、工作区校验和或快照的测试）；需要独立复跑时，在临时副本执行，复跑输出作为证据而不改变被审工作区。大型外部归档的 Sol 审查使用受控证据包：目标、需求、允许范围、当前指纹、当前工作流快照、实际测试输出、改动文件和与非目标对应的少量哨兵路径；Sol 必须亲查改动与必要相邻调用链，但不得为发现范围漂移无边界枚举整棵归档。

本地 `codex exec` 的外层命令超时仅说明调用者超时，不证明审查实例已停止。超时后，先用操作系统进程列表与命令行精确定位该任务/claim 的 CLI 子进程；只终止该明确匹配的进程并复核它已经退出，才可 `abandon` 和 `retry`。无法归属或无法确认终止时保留节点运行或阻塞，不得并行重试。

记录 guards 为 `pass`、`fail` 或 `unavailable`；后者不等于通过。只有验收满足且没有必需工作剩余时关闭，并交付实际改动、验证证据、未覆盖行为、残余风险和未解决问题。
