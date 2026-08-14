---
name: workflow-controller
description: "使用本地工作流控制器持久化当前 v3 Codex 任务 DAG，并以独立末端质量门关闭任务。"
---

# 工作流控制器

需要持久化 DAG 调度、可恢复交接或可执行的任务级质量门时使用此 skill。简单问答、只读查询和边界清晰的单文件低风险任务不初始化控制器。控制器管理状态和关闭关卡，不替代 Codex 原生代理工具。

## 必经流程

1. 创建 `routing_schema_version=3` 的 JSON 清单。必须包含 `task_id`、绝对路径 `workspace`、`workspace_claims`、`goal`、唯一 `requirements`、DAG `nodes`、完整路由字段、结构化 `assurance_assessment`、`assurance_level`、`review_context` 和 `review_entry_stage`。`workspace_claims` 为非空 `{mode:"read"|"write",prefix:"..."}` 数组。`assurance_level` 只能是 `terra` 或 `sol`；起点只能是 `terra_single`、`terra_cohort`、`sol_high` 或 `sol_xhigh`，不得直接进入 `sol_max`。
2. 调用 `workflow_init`，再调用 `workflow_ready`。main/root 为每个就绪节点创建原生实例；实例开始首个回合后，以真实任务路径、role 和 `native_agent_started=true` 调用 `workflow_start`。未启动的预定实例在确认停止后使用 `workflow_rebind_pending` 更换 owner。运行节点使用 `workflow_heartbeat` 和 `workflow_checkpoint` 留下可恢复进度。
3. 所有工作节点完成后，main/root 完成验证、清理派生产物并调用 `workflow_audit_context` 冻结证据，再进入唯一末端审核门。`terra_single` 失败后记录精确 repair，进入 `terra_cohort`；cohort 不通过后 repair 并升级 `sol_high`。Sol 审核单调升级到 high、xhigh、max initial 和 max closure。closure 有效失败进入 `scope_decision_required`，必须交由用户决定。
4. 审核 JSON 必须含 `auditor_task`、`auditor_role`、`claim_id`、`verdict`、`requirement_coverage`、`workflow_snapshot`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps`、`residual_risk`、`independent_assessment`、`history_reconciliation` 和 `review_history_digest`。`fail` 必须含 blocking finding；`pass` 不得含 blocking finding。
5. 审核代理记录审核并完成原生回合后，main/root 以匹配 claim 的 `completion_attestation=native_agent_finished` 调用 `workflow_complete`，再调用 `workflow_close_check`。只有 `close_allowed=true` 才能交付或发布。

## 控制器边界

- 当前控制器只读取和写入 v3 SQLite 状态；其他清单或历史状态不会迁移、恢复或执行。
- `read_only` 节点使用只读 role；Luna executor 只能认领完整 `delegable` 契约且 `execution_owner` 与真实任务路径一致。非审核 `protected` 节点由 Terra 执行；`quality_review` 只允许 `avsp_terra_xhigh`，`total_review` 使用 Sol role。
- 控制器记录 agent 提供的任务路径和 claim，但不验证 Codex 身份。`workflow_start` 和 `workflow_complete` 的 lifecycle 字段是审计声明，不是宿主认证。
- `state_dir` 必须是绝对路径。工作区 lease 通过 authority、registry 与 task state 的固定锁序保护；声明范围不冲突的任务可以并行。扩大 claims 需使用新 `task_id`。
