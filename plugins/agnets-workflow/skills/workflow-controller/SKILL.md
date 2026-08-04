---
name: workflow-controller
description: "使用本地工作流控制器持久化 Codex 任务 DAG，并行派发所有就绪的原生子代理节点，并以绑定当前工作区指纹的独立 Sol 总审作为任务关闭关卡。"
---

# 工作流控制器

需要持久化 DAG 调度或可强制执行的总体验收记录的状态变更任务，使用此 skill。控制器是状态和关卡服务；它不替代 Codex 原生 `spawn_agent`、`send_message`、`wait_agent` 或 `interrupt_agent`。

## 必经流程

1. 创建 JSON 任务清单，包含 `task_id`、绝对路径 `workspace`、`goal`、唯一的 `requirements` 和 DAG `nodes`。新清单应设 `routing_schema_version=1`；每个节点必须包含 `id`、`kind`、可选 `agent_type`、`depends_on`、`execution_risk`、`routing_reason`、`execution_owner`、`integration_owner` 与 `quality_guard`。新任务必须在初始化时声明唯一的 `total_review` 节点，它直接依赖所有其他节点，且没有节点依赖它；初始化后 DAG 不可追加。旧清单没有版本标记时可读取，但会被明确标为 legacy/protected，不能授权 Luna executor。为任务固定一个绝对路径 `state_dir`，通常是 `<workspace>/.codex/workflow-controller`；同一任务的每一次 MCP/CLI 调用都必须携带完全相同的绝对路径。若初始化进程在返回前中断，先用 `workflow_reconcile_workspace` 检查该工作区：它只会激活可验证的已写状态，或清理确认不存在状态的初始化登记。每条需求包含唯一的 `id` 和非空 `text`。
2. 调用 `workflow_init`，再调用 `workflow_ready`。对每个返回节点，main/root 必须先用 `spawn_agent` 创建新的原生实例，核对返回的真实任务路径和 role，再以该路径调用 `workflow_claim` 并保存 `claim_id`；不得先 claim 再用 `followup_task` 唤醒历史实例，也不得把 followup 提交成功当成实例已启动。代理拿到 claim 后立即调用一次 `workflow_heartbeat`，再开始工作；不得因为等待一个相互独立的就绪节点而延迟派发其他节点。
3. 运行中的代理定期调用 `workflow_heartbeat`，并在开始、每个重要进展和阻塞前把不超过 32 KiB 的 JSON 进度写入临时文件后调用 `workflow_checkpoint`。checkpoint 应说明已完成步骤、下一步、改动/证据路径、验证和阻塞。心跳仅覆盖节点的最后活动时间和计数，不追加事件历史；每个原生子代理返回后，main/root 将结构化结果写入 JSON 文件，并携带匹配的 `claim_id` 调用 `workflow_complete`（仅可用 `succeeded`、`failed`、`blocked`、`skipped` 或 `unavailable`）。失败或阻塞节点必须保持可见；不得将其标为成功来解锁依赖节点。
4. 使用 `workflow_stale` 查看启动期限或节点 `lease_duration_sec` 已过期的运行节点。结果会区分 `reason=never_activated`（从未产生首个心跳）和 `reason=heartbeat_expired`（曾启动后失联）。协调者先用原生 `list_agents` 等实际状态确认旧执行者停止：若当前 Codex 运行时实际提供 `resume_agent`、节点保存了 `agent_thread_id` 且旧实例可恢复，优先恢复原代理，由它用原 `claim_id` 继续心跳；控制器不能调用该内部能力。否则，协调者以 `previous_agent_stopped=true` 调用 `workflow_requeue_stale`，它原子地保存旧 attempt/checkpoint 并返回恢复包，随后立即派发新实例并以新 claim 继续。没有实际停止证据时不得重排队。若整个任务已中断且没有运行节点，只有确认全部旧代理已停止后才可调用 `workflow_release_workspace`。
5. 锁阻塞时仅可用 `workflow_recover_lock` 恢复同一主机、超过阈值且写锁 PID 已不存在的锁；恢复操作以独占恢复保护串行化并归档旧锁，不会删除活动锁。写入、释放和恢复的崩溃遗留协调意图同样只会在元数据完整、同主机、超过阈值且 PID 不存在时归档恢复；未知、异机或仍活动的意图保持阻塞并报告。
6. 总体验收前，调用 `workflow_audit_context`。把紧凑证据包交给一个从未参与任何先前任务节点的新建 Sol 总审代理。
7. 审核 JSON 必须包含 `auditor_task`、`auditor_role`、总审节点的 `claim_id`、`verdict`、`requirement_coverage`、`workflow_snapshot`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps` 和 `residual_risk`。`workflow_snapshot` 必须原样回填 `workflow_audit_context` 的结果；控制器会核验它仍对应当前非总审节点的状态与结果，并核验该 claim 仍属于同一路径、同一角色的运行中 `total_review` 节点。默认使用 `avsp_sol_high`；仅在其升级条件满足时使用 `avsp_sol_xhigh`；仅在选定 Sol role 或模型确实不可用时使用 `avsp_terra_xhigh_readonly`。
8. 调用 `workflow_record_review`，再调用 `workflow_close_check`。只有 `close_allowed` 为 true 才能报告成功或触发发布；通过时控制器才释放该工作区租约。其后任何工作区变更都会使已记录的 `pass` 失效。

9. 所有携带 `state_dir` 的控制器操作会执行一次惰性清理；也可显式调用 `workflow_prune_expired`。它只删除连续 7 天未更新、租约已释放、没有运行节点且状态可解析的任务状态。控制器不是常驻服务，所以没有任何 MCP 调用时不会在第 7 天整点自行启动；活动、未知、legacy 或无法解析的任务一律保留并报告原因。

## 控制器边界

- 控制器记录由代理提供的任务路径和 claim；它不能验证真实 Codex 身份，也不能自行调用 Codex 协作 API。`claim_id` 防止误完成和误接管，不构成认证或权限边界。对 `total_review`，控制器还要求该 claim 至少有一次 `workflow_heartbeat` 才能记录审核；这只能证明工作流实例执行过启动握手，不能替代原生身份认证。
- `avsp_luna_high_executor` 与 `avsp_luna_xhigh_executor` 只能认领完整、`delegable` 且 `execution_owner` 等于其真实任务路径的节点；`protected` 节点或 legacy 路由必须交由 Terra 处理。控制器不证明写入目标是否真实互斥，协调者仍须在派发前核验。
- `workflow_ready` 只是调度建议。main/root 仍是唯一能创建原生代理树的主体，且必须保持现有 role 拓扑。
- `state_dir` 是必填的绝对路径。推荐使用 `<workspace>/.codex/workflow-controller`，不要把它纳入源代码控制差异，也不要删除活动任务的状态文件。
- 每个工作区在 `.codex/workflow-controller/workspace-lease.json` 中持有一个活动任务租约；即使两个会话使用不同 `state_dir`，也不能同时初始化同一个工作区的工作流。不同工作区可并行。租约释放后，旧任务只可读取，不能再认领、重试、追加节点、写心跳、完成或记录审核。控制器无法推断真实写入范围，因此这是保守的单工作区写任务边界。
- `agent_thread_id` 是可选的原生 Codex thread UUID；仅当宿主实际提供时随 `workflow_claim` 记录。控制器不读取 `~/.codex/sessions`、rollout 或 SQLite，也没有调用 `resume_agent` 的公开权限。缺少该能力时，`workflow_requeue_stale` 返回的 checkpoint、依赖结果摘要、任务契约和工作区检查要求是新代理的连续性来源，不得声称恢复了原会话。
- 控制器会从工作区指纹中排除 `.git`、`.codex`、`node_modules` 与 `.venv`；构建输出属于审核范围。清单最多 64 个节点与 64 条需求，每个节点最多 8 次尝试；节点结果最多 64 KiB、审核 JSON 最多 128 KiB。完整日志应作为外部制品保留，状态中只写摘要和可核对路径。
