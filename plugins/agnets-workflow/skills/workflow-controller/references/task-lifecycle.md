# 任务生命周期

这是 manifest、`init`、`ready`、`start`、`heartbeat`、`checkpoint`、`complete` 与 attestation 的唯一规则来源。

- 新 manifest 必含 `task_id`、绝对 `workspace`、`goal`、唯一 `requirements` 和 DAG `nodes`；使用 `routing_schema_version=1` 时，每节点含 `id`、`kind`、`depends_on`、`execution_risk`、`routing_reason`、`execution_owner`、`integration_owner`、`quality_guard` 及可选 `agent_type`。
- 初始化时必须有唯一 `total_review`，它直接依赖所有其他节点，且没有节点依赖它；初始化后 DAG 不可追加。无版本旧清单是 legacy/protected，不能授权 executor。
- 对同一任务始终传完全相同的绝对 `state_dir`。初始化、认领、完成和关闭仅短时锁定该任务状态文件；同一工作区的不同任务可使用不同 `state_dir` 并行运行。初始化中断后用 `workflow_ensure_context` 指定同一 `state_dir` 与 `task_id` 读取实际状态，不存在时才重新初始化。
- `workflow_init` 后以 `workflow_ready` 获取依赖均成功的节点。main/root 创建新实例并核验真实任务路径和 role；已开始首回合的实例用真实路径和 `native_agent_started=true` 调用 `workflow_start` 原子认领。`workflow_claim` 仅用于兼容的先登记后握手场景。
- 运行实例定期 `workflow_heartbeat`；在开始、重要进展与阻塞前，将不超过 32 KiB 的 JSON 进度文件交给 `workflow_checkpoint`。checkpoint 说明完成步骤、下一步、改动或证据、验证与阻塞。
- 仅确认实例进入 `FINAL_ANSWER` 后，main/root 才用匹配 `claim_id` 的结果调用 `workflow_complete`，状态只能为 `succeeded`、`failed`、`blocked`、`skipped` 或 `unavailable`。失败或阻塞必须保持可见。
- 常规完成 attestation 是 `native_agent_finished`。显式 `workflow_rescue` 的 main/root 节点可用 `root_rescue_self_completion`；`total_review` 的 unavailable 仅在已确认退出或未启动时使用 `native_agent_exit_confirmed` 或 `native_agent_start_failed`，两者都不是 `FINAL_ANSWER`。
