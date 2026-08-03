---
name: workflow-controller
description: "使用本地工作流控制器持久化 Codex 任务 DAG，并行派发所有就绪的原生子代理节点，并以绑定当前工作区指纹的独立 Sol 总审作为任务关闭关卡。"
---

# 工作流控制器

需要持久化 DAG 调度或可强制执行的总体验收记录的状态变更任务，使用此 skill。控制器是状态和关卡服务；它不替代 Codex 原生 `spawn_agent`、`send_message`、`wait_agent` 或 `interrupt_agent`。

## 必经流程

1. 创建 JSON 任务清单，包含 `task_id`、绝对路径 `workspace`、`goal`、唯一的 `requirements` 和 DAG `nodes`。每条需求包含唯一的 `id` 和非空 `text`；每个节点包含 `id`、`kind`、可选 `agent_type` 和 `depends_on`。
2. 调用 `workflow_init`，再调用 `workflow_ready`。对每个返回节点，main/root 以真实 Codex 任务路径认领它，并保存返回的 `claim_id`；不得因为等待一个相互独立的就绪节点而延迟派发其他节点。
3. 运行中的代理定期调用 `workflow_heartbeat`。每个原生子代理返回后，main/root 将结构化结果写入 JSON 文件，并携带匹配的 `claim_id` 调用 `workflow_complete`（仅可用 `succeeded`、`failed`、`blocked`、`skipped` 或 `unavailable`）。失败或阻塞节点必须保持可见；不得将其标为成功来解锁依赖节点。
4. 中断时先检查原生代理状态、实际 diff、产物和输出。确认旧执行者停止后，持有其 `claim_id` 调用 `workflow_abandon`，再以 `previous_agent_stopped=true` 调用 `workflow_retry`。控制器不会自动杀死、放弃或重派代理；无法证明停止时保持 `running` 并报告阻塞。
5. 锁阻塞时仅可用 `workflow_recover_lock` 恢复同一主机、超过阈值且写锁 PID 已不存在的锁；恢复操作以独占恢复保护串行化并归档旧锁，不会删除活动锁。普通状态写入会在该保护存在时显式拒绝获取主锁，且已持有主锁的正常路径会等待保护结束后再释放；不得绕过保护并重试删除。
6. 总体验收前，调用 `workflow_audit_context`。把紧凑证据包交给一个从未参与任何先前任务节点的新建 Sol 总审代理。
7. 审核 JSON 必须包含 `auditor_task`、`auditor_role`、总审节点的 `claim_id`、`verdict`、`requirement_coverage`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps` 和 `residual_risk`。控制器会核验该 claim 仍属于同一路径、同一角色的运行中 `total_review` 节点。默认使用 `avsp_sol_high`；仅在其升级条件满足时使用 `avsp_sol_xhigh`；仅在选定 Sol role 或模型确实不可用时使用 `avsp_terra_xhigh_readonly`。
8. 调用 `workflow_record_review`，再调用 `workflow_close_check`。只有 `close_allowed` 为 true 才能报告成功或触发发布；其后任何工作区变更都会使已记录的 `pass` 失效。

## 控制器边界

- 控制器记录由代理提供的任务路径和 claim；它不能验证真实 Codex 身份，也不能自行调用 Codex 协作 API。`claim_id` 防止误完成和误接管，不构成认证或权限边界。
- `workflow_ready` 只是调度建议。main/root 仍是唯一能创建原生代理树的主体，且必须保持现有 role 拓扑。
- 状态默认存储在 `.codex/workflow-controller/`。不要把它纳入源代码控制差异，也不要删除活动任务的状态文件。
- 控制器会从工作区指纹中排除 `.git`、`.codex`、依赖缓存和构建输出。请在工作区中显式跟踪源码、配置、锁文件、生成源码和部署清单。
