---
name: orchestrate-model-workflow
description: "在复杂开发、实现、修复、架构设计、Bug 或漏洞诊断、复审和验收中，使用 Codex 命名 agent role 按证据、决策风险和执行风险分工。"
---

# 多模型工作流编排

控制器会为没有 `workflow` 字段的直接总审制品写入与当前 task/node/claim/state_dir 匹配的 pending envelope；已有绑定缺失、`null`、假值或其他不匹配 completion 均不得完成或关闭。控制器只可回写自身生成的最终 completion；制品写入失败时节点保持运行中，原 claim 可重试。受控外部证据目录以流式遍历校验，普通文件最多 512（含 manifest），目录最多 512（不含根目录）。

本文件是路由、所有权、交接和验收的唯一运行规则。role profile 定义本地提示和模型偏好；[execution-plan.md](references/execution-plan.md) 只提供复杂任务的消息模板。

## Codex 运行边界

Codex 原生提供命名 role、父子 agent、消息、等待/中断和实例状态。`execution_contract`、`execution_risk`、`execution_owner`、`integration_owner` 与 `quality_guard` 只是任务消息中的协调字段，不是原生对象、锁或 ACL；父 agent 必须核验实际 role、消息、状态、diff、产物和验证输出。

role 会先应用，但 child 随后继承父 turn 的 approval policy 和 permission profile。因此 profile 中的 `sandbox_mode = "read-only"` 是行为边界和配置意图，不是可由 profile 单独证明的硬隔离。父 agent 在委派前核验实际有效权限；model/effort 以成功加载的 role 为准，role 或模型不可用时保留原始错误。

当前 Codex V2 运行时在 session persistence/state DB 启用且写入成功时，会保留可用于恢复的 thread metadata、父子边和 rollout；重启后可由原生 `send_message`/`followup_task` 按已知 thread UUID 懒加载已关闭的 V2 子代理。控制器不能直接调用内部 `resume_agent`；正在运行的 turn、活动 wait 和未确认的 pending wakeup 不保证恢复。元数据或 rollout 不可读时，才使用控制器 checkpoint、任务状态和工作区证据创建新代理，不得声称恢复了旧会话。

## Role 与拓扑

这是消息和提示策略，不是 Codex 运行时 ACL：main/root 可按独立目标并行创建 `1..N` 个 Luna、Terra 或 Sol 分支。只读分支必须有互补证据域或不同决策问题，并标为 `execution_risk=read_only`；状态变更仅可由 main/root 或 `avsp_terra_high` 直接委派新的 Luna executor，且每个写入目标必须互斥。共享文件、数据或外部状态必须串行。只有完整契约、`execution_risk=delegable`、唯一 `execution_owner` 且影响和恢复受控时，main/root 或 Terra 才可直派 `avsp_luna_high_executor` 或 `avsp_luna_xhigh_executor`；executor 是叶节点。其他状态变更由 Terra 保护执行和集成。这里没有角色数量的静态上限；V2 并发主要受 `agents.max_threads` 映射的会话线程上限和资源约束，`agents.max_depth` 只约束 V1，V2 不读取它。所有 Luna 只读 role、Luna executor、Sol、Terra readonly fallback 与 `avsp_terra_xhigh` 都不得派生子 agent；Sol 也不得派写入节点。任务级总验收由 main/root 新建、此前未参与该任务的 Sol 实例完成；仅所选 Sol role 或模型实际不可用时使用 `avsp_terra_xhigh_readonly` 兜底。缺少可核验的总审结果等同 `unavailable`，不得关闭；Codex 没有可由本工作流配置的原生关闭 hook，父 agent 仍须实际执行这一 guard。

| 用途 | `agent_type` | 选择条件 |
| --- | --- | --- |
| 常规取证、预审 | `avsp_luna_high` | 默认首选；跨文件、未知根因或需要扫描的有界只读证据域 |
| 深入取证、复杂预审 | `avsp_luna_xhigh` | 需要更深局部证据理解 |
| 已定契约执行 | `avsp_luna_high_executor` / `avsp_luna_xhigh_executor` | main/root 或 `avsp_terra_high` 直接委派的 `delegable` 状态变更任务；executor 为叶节点 |
| Luna 只读替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 对应 Luna role 真正不可用时一对一替代 |
| 高难定案、复杂复审、任务级总验收 | `avsp_sol_high` | 证据充分，但多约束权衡、跨域影响或推理复杂度高；也是总验收默认 role |
| 升级调查、受约束重设计、升级总验收 | `avsp_sol_xhigh` | 证据冲突、根因未证实、无可靠 oracle，或需重新思考 |
| 最高强度复审与最终升级验收 | `avsp_sol_max` | `avsp_sol_xhigh` 修复后仍 `fail` 时使用；进入后保持 max，直到 `pass` 或显式阻塞 |
| Sol 只读替代、总验收兜底 | `avsp_terra_xhigh_readonly` | 所选 Sol role 或模型真正不可用时替代同一只读阶段，必须披露独立性下降 |
| 契约、保护执行与集成 | `avsp_terra_high` | 处理 `protected` 状态变更、审核 executor 结果并负责集成；可直接委派 executor |
| 有界定案、常规复审 | `avsp_terra_xhigh` | 证据充分、范围有界且推理路径常规的新建独立只读实例 |

## 委派、路由与执行

### 默认分流

跨文件、未知根因或需扫描的任务，若能拆出独立只读证据域，默认先派 `avsp_luna_high`；单文件且改法明确时可跳过并记录理由。主控保留设计、授权、集成和最终判断。

现代 `routing_schema_version=1` 清单省略 `agent_type` 时，非总审 `read_only`/`delegable` 分别默认到 `avsp_luna_high`/`avsp_luna_high_executor`，`total_review` 默认到 `avsp_sol_high`。显式 `agent_type` 必须与 `execution_risk` 兼容；控制器在初始化时拒绝会导致节点无法认领的组合。非总审节点需要 Terra 或其他 role 时显式指定；总审仅在所选 Sol 实际不可用时使用 Terra fallback。共享写入、外部副作用或不可恢复变更仍为 `protected`，由 Terra 处理。

### 通用委派约束

命名 `agent_type` 的 `spawn_agent` 必须显式传 `fork_turns="none"`，并使用自包含消息。仅确需有限最近上下文时才传正整数；不得省略。`fork_turns="all"` 仅用于继承父 role 的 full-history fork，且不得同时传自定义 `agent_type`。

状态变更包括任何持久工作区文件、配置、依赖或锁文件、生成产物、版本控制状态、数据库或其他数据，以及外部服务、API、部署或消息状态的改变。只有能够证明未改变上述任一状态的任务才是只读；无法证明时必须按状态变更处理并进入任务级总验收。

对外部仓库的状态变更，在创建工作流节点、下载完整源码、安装依赖或委派执行者之前，main/root 必须做一次只读预检：固定目标分支的提交、读取根 `AGENTS.md` 以及仓库明确指向的贡献/维护限制，并核对目标需求是否被允许。若规则要求用户确认、仅接受特定类别修复，或禁止该类改动，保留原始约束并停止该仓库的执行；不得把它当作普通失败重试，也不得以本地实验为由绕过。预检未发现限制后，才可建立该仓库的执行合同；网络不可达时可改用可核验的固定提交源码归档，但仍必须完成同一预检。

### 路由规则

1. **只需事实**：按独立且互补的证据域委派 Luna，并在清单中设 `execution_risk=read_only`；不得重复取同一事实或为使用 Luna 改写风险。证据不足但可补充时继续取证，否则停止并报告。
2. **需要判断**：证据充分时，`avsp_terra_xhigh` 与 `avsp_sol_high` 同属定案层，按难度分流而非先后升级：范围有界且推理路径常规时选 Terra；存在多约束权衡、跨域影响或高复杂度推理时选 Sol。高影响或风险域名称本身不触发 Sol。总审修复循环使用单调升级链：第一次 `avsp_sol_high` `fail` 后仍由 high 复审一次；第二次连续 high `fail` 后下一轮自动切换 `avsp_sol_xhigh`；xhigh 在修复后再次 `fail` 时下一轮切换 `avsp_sol_max`；进入更高等级后不得降级。`unavailable`、超时、证据不足或无效输出不代表 high 能力不足，不触发升级，只在确认旧实例停止后按当前等级重试或补证。max 阶段持续到 `pass`，达到控制器显式状态上限时必须报告阻塞，不得静默开启无界审核风暴。
3. **需要状态变更**：先写完整 `execution_contract` 和五项路由字段；仍有行为、风险或兼容性选择时不得委派 executor。main/root 直派时负责集成，Terra 直派时负责审核和集成。
4. **执行风险**：可证明没有任何工作区、数据或外部状态变更的取证为 `read_only`，交给只读 role；只有影响面受控、失败可回滚或恢复、外部副作用受限、共享状态与顺序风险已解决且有可靠验证的写入才是 `delegable`；其余写入为 `protected`，由 Terra 直接执行。main/root 或 Terra 可把 `1..N` 个互不冲突的 `delegable` 契约并行交给 Luna executor；默认 Luna/high，只有完整契约仍需更深局部理解时用 xhigh executor，并在 `routing_reason` 记录理由。缺少任一审计字段、字段冲突、旧清单或共享写入时一律按 `protected`，不得静默当作可委派。`execution_owner` 是每个状态变更的唯一执行者；并行任务的写入目标必须互斥。
5. **任务级总验收**：每个发生状态变更的任务，在 main/root 宣布完成前都必须新建独立 Sol 实例做总验收；任何此前参与该任务的 Luna、Terra、Sol、writer、预审或 fallback 实例均不得复用。默认使用 `avsp_sol_high`，失败修复后的下一轮由控制器依据连续 `fail` 历史选择 high、xhigh 或 max；`workflow_retry` 会持久化升级事件和当前 `agent_type`，新实例必须按该角色认领。仅在所选 Sol role 或模型被实际证明不可用时，才使用此前未参与该任务的 `avsp_terra_xhigh_readonly` 兜底同一总验收，并披露独立性下降；超时、证据不足或普通失败不得降级。总验收核验原始目标、验收条件、范围与非目标、执行契约、实际 diff/产物、验证结果、需求覆盖、范围漂移、回归风险和未验证项；返回可核验的审核实例标识、`pass`、`fail` 或 `unavailable` 及证据。缺少任一项按 `unavailable` 处理。`fail` 或 `unavailable` 时不得关闭任务，main/root 必须确认旧实例停止、派遣修复或补证，并新建另一独立 Sol 实例重新总验收。先写入同时匹配当前工作区指纹和 `workflow_snapshot` 的审查记录，才可将唯一 `total_review` 节点标为 `succeeded`；控制器拒绝反序，并在任一非总审节点结果、状态或重试改变后使旧审查失效。旧状态若已把未记录总审标为成功，确认旧实例已停止后才可显式重开该节点，不得伪造或补写旧审查。

## 消息、失败与恢复

父 agent 发送自包含任务包：role、目标、范围与非目标、授权、必要事实、验收、验证、返回格式和停止条件；状态变更再附契约、风险与 owner。子 agent 返回实际改动、证据、验证、未完成工作和原始错误，父 agent 只在实际核验后集成或关闭。

`send_message` 只投递；`followup_task` 的成功只表示已提交触发请求，不证明 turn 已启动或完成；`wait_agent` 只等待 mailbox activity、steering 或 timeout，不代表目标终态；`interrupt_agent` 的成功、no-op 或 previous status 都不证明已终止，`Interrupted` 不是 final。控制器节点启动时，由已经开始回合的子实例调用 `workflow_start(..., native_agent_started=true)`；正常完成路径中，只有在 Root 实际确认该实例进入原生 `AgentStatus::Completed`（宿主可能将最终答复显示为 `FINAL_ANSWER`）后，才可以 `workflow_complete(..., completion_attestation=native_agent_finished)`。总审因实例未启动或已确认退出而以 `unavailable` 结束时，使用 `native_agent_start_failed` 或 `native_agent_exit_confirmed`；已由 `workflow_rescue` 显式转交的 `main/root` 节点则在自身验证后使用 `root_rescue_self_completion`。这些字段形成可审计的声明，但当前宿主未公开调用者身份验证，不能把它们说成强认证。恢复或替换前必须检查 `list_agents`、实际状态/历史/输出及旧实例是否已停止写入。

等待原生代理时优先一次调用带充分 timeout 的 `wait_agent`，收到 mailbox activity 后再核验对应实例；持久化工作流先从 `workflow_status` 取得 `cursor`，随后使用 `workflow-controller` MCP 的 `workflow_wait` 被动等待可操作变化。普通 heartbeat 不应唤醒协调者；不得用固定短间隔循环调用 `list_agents`、`workflow_status` 或其他状态工具。能力没有事件或 wait 接口时，才按预计完成时间和最近进展逐步退避，并在明确的 timeout、租约、stale 或恢复边界前主动核验。

Luna readonly 真正不可用时才一对一改用对应 Terra low/medium readonly 并保留原错；控制器认领该 fallback 时必须提供 `fallback_reason`，并将原因写入认领事件。所选 Sol role 或模型真正不可用时才改用 Terra xhigh readonly 并披露独立性下降；总审 fallback 的认领和审查记录都必须提供 `fallback_reason`。timeout、证据不足或普通失败不属于不可用。executor 失败时，`integration_owner` 核验状态、diff、产物和输出，确认旧 executor 已停止或不再写入后，优先用新完整契约替换一次或交由 Terra 接管；如果 Root 必须直接救援写入，必须通过控制器的 `workflow_rescue` 记录原 claim、原因、替代路径和 `main/root` 角色，再以新 claim 完成，不能把救援结果归为 Luna 结果。Terra high 不可用时，main/root 可在契约仍完整、`delegable` 且自身承担 `integration_owner` 时直派 executor；其他情况停止报告。所有 fallback 都是父 agent 的显式动作，不是 Codex 自动行为。

若 session persistence/state DB 未启用、写入失败或重启后没有可读的必要状态，只做一次当前状态、diff 和输出盘点，保留原始错误与缺失条件，停止当前恢复或替换并交回父级或用户。对于持久化控制器节点，先确认原生状态中的旧执行者已停止；若 V2 thread metadata/rollout 仍可读，可用原生 `send_message`/`followup_task` 懒加载原子代理并继续原 claim，否则再创建并核对新的原生实例，以其真实路径作为 `replacement_agent_task_path` 调用 `workflow_requeue_stale`。控制器会记录旧 attempt 并将现代节点的 `execution_owner` 显式重绑定给替代实例。该路径必须不同于旧执行者，总审替代者还必须从未参与该任务。活动 turn、wait 或未确认 pending wakeup 不保证恢复；不得声称自动恢复、已排队或自动重试，也不得重复只读验证。

总审前，main/root 完成所有会写入被审工作区的验证，清理已知测试产物并调用 `audit-context` 冻结证据；总审不得修改该工作区。使用 Sol CLI、受控外部证据或硬超时时，必须读取 [Sol 总审运行细则](references/sol-review.md)；普通原生总审不加载该参考。

记录 guards 为 `pass`、`fail` 或 `unavailable`；后者不等于通过。只有验收满足且没有必需工作剩余时关闭，并交付实际改动、验证证据、未覆盖行为、残余风险和未解决问题。
