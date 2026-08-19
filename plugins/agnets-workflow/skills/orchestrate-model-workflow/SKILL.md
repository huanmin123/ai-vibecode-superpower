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

本文出现的 Codex `V1`/`V2` 只指原生运行时和会话机制，绝不表示 workflow routing schema 的兼容范围；持久化 workflow 一律只接受 `routing_schema_version=3`。当前 Codex V2 运行时在 session persistence/state DB 启用且写入成功时，会保留可用于恢复的 thread metadata、父子边和 rollout；重启后可由原生 `send_message`/`followup_task` 按已知 thread UUID 懒加载已关闭的 V2 子代理。控制器不能直接调用内部 `resume_agent`；正在运行的 turn、活动 wait 和未确认的 pending wakeup 不保证恢复。元数据或 rollout 不可读时，才使用控制器 checkpoint、任务状态和工作区证据创建新代理，不得声称恢复了旧会话。

## Role 与拓扑

这是消息和提示策略，不是 Codex 运行时 ACL：main/root 可按独立目标并行创建 `1..N` 个 Luna、Terra 或 Sol 分支。只读分支必须有互补证据域或不同决策问题，并标为 `execution_risk=read_only`；状态变更仅可由 main/root 或 `avsp_terra_high` 直接委派新的 Luna executor。不要因为潜在写入范围相交而预先串行：真正修改共享文件、数据或外部状态前，执行者才申请最小实际路径锁；锁未覆盖的工作可以并行。只有完整契约、`execution_risk=delegable`、唯一 `execution_owner` 且影响和恢复受控时，main/root 或 Terra 才可直派 `avsp_luna_high_executor` 或 `avsp_luna_xhigh_executor`；executor 是叶节点。其他状态变更由 Terra 保护执行和集成。这里没有角色数量的静态上限；V2 并发主要受 `agents.max_threads` 映射的会话线程上限和资源约束，`agents.max_depth` 只约束 V1，V2 不读取它。所有 Luna 只读 role、Luna executor、Sol、Terra readonly fallback 与 `avsp_terra_xhigh` 都不得派生子 agent；Sol 也不得派写入节点。写入任务的关闭由声明的质量门决定；进入 Sol 的任务必须由 main/root 新建、此前未参与该任务的独立 Sol 实例审核。仅所选 Sol role 或模型实际不可用时使用 `avsp_terra_xhigh_readonly` 兜底。缺少当前质量门要求的可核验记录等同 `unavailable`，不得关闭；Codex 没有可由本工作流配置的原生关闭 hook，父 agent 仍须实际执行这一 guard。

| 用途 | `agent_type` | 选择条件 |
| --- | --- | --- |
| 常规取证、预审 | `avsp_luna_high` | 默认首选；跨文件、未知根因或需要扫描的有界只读证据域 |
| 深入取证、复杂预审 | `avsp_luna_xhigh` | 需要更深局部证据理解 |
| 已定契约执行 | `avsp_luna_high_executor` / `avsp_luna_xhigh_executor` | main/root 或 `avsp_terra_high` 直接委派的 `delegable` 状态变更任务；executor 为叶节点 |
| Luna 只读替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 对应 Luna role 真正不可用时一对一替代 |
| 高难定案、复杂复审、Sol 质量门 | `avsp_sol_high` | 证据充分，但多约束权衡、跨域影响或推理复杂度高；也是 Sol 质量门默认 role |
| 升级调查、受约束重设计、升级总验收 | `avsp_sol_xhigh` | 证据冲突、根因未证实、无可靠 oracle，或需重新思考 |
| 最高强度复审与最终升级验收 | `avsp_sol_max` | `avsp_sol_xhigh` 有效失败修复后使用；先作一次独立 max 全局审核，失败后冻结 charter、受保护修复一次，再由新 max 实例 closure；closure 有效失败必须停止并交由用户决策 |
| Sol 只读替代、总验收兜底 | `avsp_terra_xhigh_readonly` | 所选 Sol role 或模型真正不可用时替代同一只读阶段，必须披露独立性下降 |
| 契约、保护执行与集成 | `avsp_terra_high` | 处理 `protected` 状态变更、审核 executor 结果并负责集成；可直接委派 executor |
| 有界定案、常规复审 | `avsp_terra_xhigh` | 证据充分、范围有界且推理路径常规的新建独立只读实例 |

## 委派、路由与执行

### 工作流准入

先判断是否需要多代理持久化工作流。简单问答、只读查询、边界清晰且可由 main/root 独立完成的单文件低风险整理，不创建控制器 DAG，也不派独立审核代理；main/root 直接完成，并在结束前执行与风险相称的验证。只有任务需要跨文件或复杂取证、多节点协作、持久恢复、受保护写入、独立末端质量门或用户明确要求该工作流时，才进入下述完整生命周期。准入只决定是否启用持久化编排，不得用来跳过本来就需要的验证或高风险独立审核。

### 完整任务生命周期

一次用户输入建立一份完整任务清单。main/root 先明确目标、范围、非目标、验收和授权；随后完成必要的取证、设计与执行契约，派发全部就绪的取证、实现、集成和验证节点，并在每次状态变更后核验结果与工作区。节点的 `quality_guard` 只定义该节点必须留下的测试或证据，不创建审核代理，也不得把审核插入每个小步骤。

全部非审核节点完成后，main/root 汇总验证、清理已知派生产物并冻结当前快照与工作区指纹；这时才启动清单中唯一的末端质量门。门通过才可关闭、释放租约和交付；门失败后的修复回到任务内部，修复完成后重新进入同一个末端门。审核节点必须直接依赖全部非审核节点，任何节点不得依赖审核节点，禁止为单点、小任务或节点交接单独追加审核。执行期间若新证据证明原门级不足，只能在末端门被认领前调用 `workflow_raise_assurance` 将 v3 的 `terra` 单调提高为 `sol`，并把同一个未认领门重绑定为 `sol_high`。该入口不允许通用追加节点或降级。

### 默认分流

跨文件、未知根因或需扫描的任务，若能拆出独立只读证据域，默认先派 `avsp_luna_high`；单文件且改法明确时可跳过并记录理由。主控保留设计、授权、集成和最终判断。

持久化复杂任务使用 `routing_schema_version=3`，必须声明 `assurance_level`、结构化 `assurance_assessment`、`review_context`（精确含非空 `environment`、`scenarios`、`boundaries`）和 `review_entry_stage`。`review_entry_stage` 只能是 `terra_single`、`terra_cohort`、`sol_high` 或 `sol_xhigh`：常规任务从 `terra_single` 开始；已有中等复杂度、跨域或需挑战单审固化风险时从 `terra_cohort` 开始；高度复杂、证据冲突或低可信 oracle 时可直接从 `sol_high` 或 `sol_xhigh` 开始。不得直接进入 `sol_max`，它只能来自前级有效失败后的受控链。全部 assurance 维度为 `controlled` 时不应初始化持久化复杂任务；任一为 `partial` 且没有 `unknown` 时门级必须是 `terra`，任一为 `unknown` 时必须是 `sol`。一个任务仍只有一个末端审核节点，cohort 是该节点内部的并行 lane，不是第二个质量门。Sol 仅在所选 Sol 实际不可用时使用 Terra fallback。共享写入、外部副作用或不可恢复变更仍为 `protected`，由 Terra 处理。

### 通用委派约束

命名 `agent_type` 的 `spawn_agent` 必须显式传 `fork_turns="none"`，并使用自包含消息。仅确需有限最近上下文时才传正整数；不得省略。`fork_turns="all"` 仅用于继承父 role 的 full-history fork，且不得同时传自定义 `agent_type`。

状态变更包括任何持久工作区文件、配置、依赖或锁文件、生成产物、版本控制状态、数据库或其他数据，以及外部服务、API、部署或消息状态的改变。只有能够证明未改变上述任一状态的任务才是只读；无法证明时必须按状态变更处理。v3 写入任务按影响范围、可恢复性、不确定性、可验证性和耦合性选择一次任务末端质量门，并把状态、证据、理由和选择理由写入 `assurance_assessment`。执行中风险上升时更新同一结构并调用受控升级入口；证据不足只能保持或提升门级，不能降级。

对外部仓库的状态变更，在创建工作流节点、下载完整源码、安装依赖或委派执行者之前，main/root 必须做一次只读预检：固定目标分支的提交、读取根 `AGENTS.md` 以及仓库明确指向的贡献/维护限制，并核对目标需求是否被允许。若规则要求用户确认、仅接受特定类别修复，或禁止该类改动，保留原始约束并停止该仓库的执行；不得把它当作普通失败重试，也不得以本地实验为由绕过。预检未发现限制后，才可建立该仓库的执行合同；网络不可达时可改用可核验的固定提交源码归档，但仍必须完成同一预检。

### 路由规则

1. **只需事实**：按独立且互补的证据域委派 Luna，并在清单中设 `execution_risk=read_only`；不得重复取同一事实或为使用 Luna 改写风险。证据不足但可补充时继续取证，否则停止并报告。
2. **需要判断**：证据充分时，`avsp_terra_xhigh` 与 `avsp_sol_high` 同属定案层，按难度分流而非先后升级；高影响或风险域名称本身不触发 Sol。v3 审核者先针对原始目标、requirements、环境、场景、边界、当前产物和验证独立形成全局判断，再核对全部 review/repair 历史；历史是待复核证据，不能限制审核范围。审核 JSON 必须记录 `independent_assessment`、`history_reconciliation`，并原样回填 `workflow_audit_context.review_history_digest`。`fail` 必须包含至少一个结构化 blocking finding。`terra_single` 有效 `fail` 后必须先记录精确 repair，再进入 `terra_cohort`；cohort 使用两个新的 `avsp_terra_xhigh` 并行 blind lane，随后各以一轮 cross-questioning 精确挑战另一份报告。两份最终立场均 pass 才通过；任一 blocker 或不收敛即汇总 findings，repair 后升级 `sol_high`。Sol 使用单调链：`sol_high` 有效 fail -> repair -> 新 `sol_xhigh`；`sol_xhigh` 有效 fail -> repair -> 新 `sol_max_initial`；首次 max 仍 fail 时冻结该次 blockers，执行一次 protected repair，再由新 `sol_max_closure` 复核。closure 任一有效 fail（含新全局 blocker）立即 `scope_decision_required`/`blocked`，自动流程终止，必须由用户选择替代任务或明确扩大范围；不得自动重开、同级循环或伪装为 pass。`unavailable`、超时、证据不足或无效输出不计入有效失败，也不升级；只在确认旧实例停止后由新实例在当前阶段使用独立的有限不可用预算重试。
3. **需要状态变更**：先写完整 `execution_contract` 和五项路由字段；仍有行为、风险或兼容性选择时不得委派 executor。main/root 直派时负责集成，Terra 直派时负责审核和集成。
4. **执行风险**：可证明没有任何工作区、数据或外部状态变更的取证为 `read_only`，交给只读 role；只有影响面受控、失败可回滚或恢复、外部副作用受限、共享状态与顺序风险已解决且有可靠验证的写入才是 `delegable`；其余写入为 `protected`，由 Terra 直接执行。main/root 或 Terra 可把 `1..N` 个契约完整的 `delegable` 节点并行交给 Luna executor；默认 Luna/high，只有完整契约仍需更深局部理解时用 xhigh executor，并在 `routing_reason` 记录理由。使用控制器时，将写入/审阅范围写成不可变 `workspace_claims`；它是可申请锁的审计上界而非 ACL 或预占锁。执行者只在即将进行一组实际工作区写入时，对最小文件或目录前缀调用 `workflow_acquire_write_lock`，完成该组写入立即调用 `workflow_release_write_lock`；实际锁冲突才串行，禁止以“可能涉及”范围或根目录锁预先阻塞他人。根目录锁仅允许真实全工作区副作用并须记录具体 purpose。范围扩大仍必须确认旧执行者停止并释放 entry 后，以新 `task_id` 和 claims 超集创建替代任务。缺少任一审计字段、旧清单或实际共享写入风险未被路径锁覆盖时一律按 `protected`，不得静默当作可委派。`execution_owner` 是每个状态变更的唯一执行者。
5. **质量门与关闭**：每个任务只有一个末端质量门，不能按节点拆分；v3 `terra_cohort` 的两条并行 lane 与交叉质询属于同一个门。执行期间升级后的门仍是同一个任务级末端门。Sol 必须核验原始目标、验收条件、环境、场景、边界、范围与非目标、执行契约、实际 diff/产物、验证结果、需求覆盖、范围漂移、回归风险和未验证项，并确认实际 diff/产物均属于任务的 `write` claims；无法证明时不得 pass。所有门级都要求当前快照和 scoped 指纹匹配；范围外 peer 变化不使已有 `pass` 失效，但范围内与 read claim 变化会使其失效。max closure 还要求已冻结的 charter 为 `closure_passed`；`scope_decision_required`、缺 charter 或未完成受保护 repair 一律拒绝关闭。closure 有效 fail 后必须保留 blocked 状态并请求用户决策，不得调用自动 retry 或 record-repair。关闭检查发现普通 gate 已失效时，main/root 必须调用 `workflow_invalidate_gate` 或以新的独立 reviewer 路径重开同一个审核节点；不得复用旧 `pass`，也不得新建第二个审核节点。进入 Sol 后仅所选 Sol role 或模型被实际证明不可用时，才使用此前未参与该任务的 `avsp_terra_xhigh_readonly` 兜底并披露独立性下降；超时、证据不足或普通失败不得降级。

## 消息、失败与恢复

父 agent 发送自包含任务包：role、目标、范围与非目标、授权、必要事实、验收、验证、返回格式和停止条件；状态变更再附契约、风险与 owner。子 agent 返回实际改动、证据、验证、未完成工作和原始错误，父 agent 只在实际核验后集成或关闭。

`send_message` 只投递；`followup_task` 的成功只表示已提交触发请求，不证明 turn 已启动或完成；`wait_agent` 只等待 mailbox activity、steering 或 timeout，不代表目标终态；`interrupt_agent` 的成功、no-op 或 previous status 都不证明已终止，`Interrupted` 不是 final。控制器节点启动时，由已经开始回合的子实例调用 `workflow_start(..., native_agent_started=true)`；Root 必须保存该响应返回的 `task_id`、`state_dir`、`node_id` 和 `claim_id`，后续调用原样复用，缺失时先 `workflow_status`，禁止猜测。正常完成路径中，只有在 Root 实际确认该实例进入原生 `AgentStatus::Completed`（宿主可能将最终答复显示为 `FINAL_ANSWER`）后，才可以 `workflow_complete(..., completion_attestation=native_agent_finished)`。**审核节点还有强制顺序：审核代理只返回审核 JSON；Root 先成功 `workflow_record_review`（同一 active claim），再 `workflow_complete`。**仅限已持有 active claim 且已记录 `unavailable` 审核的工作流绑定总审，外部审核实例启动失败或确认退出时才可使用 `native_agent_start_failed` 或 `native_agent_exit_confirmed`；它们不是跳过审核、也不是普通审核节点的完成方式。已由 `workflow_rescue` 显式转交的 `main/root` 节点则在自身验证后使用 `root_rescue_self_completion`。这些字段形成可审计的声明，但当前宿主未公开调用者身份验证，不能把它们说成强认证。恢复或替换前必须检查 `list_agents`、实际状态/历史/输出及旧实例是否已停止写入。

等待原生代理时优先一次调用带充分 timeout 的 `wait_agent`，收到 mailbox activity 后再核验对应实例；持久化工作流先从 `workflow_status` 取得 `cursor`，随后使用 `workflow-controller` MCP 的 `workflow_wait` 被动等待可操作变化。普通 heartbeat 不应唤醒协调者；不得用固定短间隔循环调用 `list_agents`、`workflow_status` 或其他状态工具。能力没有事件或 wait 接口时，才按预计完成时间和最近进展逐步退避，并在明确的 timeout、租约、stale 或恢复边界前主动核验。

Luna readonly 真正不可用时才一对一改用对应 Terra low/medium readonly 并保留原错；控制器认领该 fallback 时必须提供 `fallback_reason`，并将原因写入认领事件。所选 Sol role 或模型真正不可用时才改用 Terra xhigh readonly 并披露独立性下降；总审 fallback 的认领和审查记录都必须提供 `fallback_reason`。timeout、证据不足或普通失败不属于不可用。executor 失败时，`integration_owner` 核验状态、diff、产物和输出，确认旧 executor 已停止或不再写入后，优先用新完整契约替换一次或交由 Terra 接管；如果 Root 必须直接救援写入，必须通过控制器的 `workflow_rescue` 记录原 claim、原因、替代路径和 `main/root` 角色，再以新 claim 完成，不能把救援结果归为 Luna 结果。Terra high 不可用时，main/root 可在契约仍完整、`delegable` 且自身承担 `integration_owner` 时直派 executor；其他情况停止报告。所有 fallback 都是父 agent 的显式动作，不是 Codex 自动行为。

若 session persistence/state DB 未启用、写入失败或重启后没有可读的必要状态，只做一次当前状态、diff 和输出盘点，保留原始错误与缺失条件，停止当前恢复或替换并交回父级或用户。对于持久化控制器节点，若计划实例在认领前就未启动，确认其已停止后，以替代实例的真实路径调用 `workflow_rebind_pending`，无需制造一次失败 attempt；若已有活动 claim，先确认原生状态中的旧执行者已停止，V2 thread metadata/rollout 可读时可用原生 `send_message`/`followup_task` 懒加载原子代理并继续原 claim，否则再创建并核对新的原生实例，以其真实路径作为 `replacement_agent_task_path` 调用 `workflow_requeue_stale`。控制器会记录旧 attempt 并将现代节点的 `execution_owner` 显式重绑定给替代实例。替代路径必须不同于旧执行者，审核替代者还必须从未参与该任务。活动 turn、wait 或未确认 pending wakeup 不保证恢复；不得声称自动恢复、已排队或自动重试，也不得重复只读验证。

审核前，main/root 完成所有会写入被审工作区的验证，清理已知测试产物并调用 `audit-context` 冻结证据；审核实例不得修改该工作区。使用 Sol CLI、受控外部证据或硬超时时，必须读取 [Sol 总审运行细则](references/sol-review.md)；普通原生 Sol 审核不加载该参考。

记录 guards 为 `pass`、`fail` 或 `unavailable`；后者不等于通过。只有验收满足且没有必需工作剩余时关闭，并交付实际改动、验证证据、未覆盖行为、残余风险和未解决问题。
