---
name: workflow-controller
description: "使用本地工作流控制器持久化当前 v3 Codex 任务 DAG，并以独立末端质量门关闭任务。"
---

# 工作流控制器

需要持久化 DAG 调度、可恢复交接或可执行的任务级质量门时使用此 skill。简单问答、只读查询和边界清晰的单文件低风险任务不初始化控制器。控制器管理状态和关闭关卡，不替代 Codex 原生代理工具。

## 必经流程

1. 创建 `routing_schema_version=3` 的 JSON 清单。必须包含 `task_id`、绝对路径 `workspace`、顶层 `coordinator_task_path`、`coordinator_thread_id`（UUID 字符串）、`workspace_claims`、`goal`、唯一 `requirements`、DAG `nodes`、完整路由字段、结构化 `assurance_assessment`、`assurance_level`、`review_context` 和 `review_entry_stage`。`workspace_claims` 为非空 `{mode:"read"|"write",prefix:"..."}` 数组，优先最小可行范围；`write "."` 仅用于真正全工作区副作用，并且必须提供非空、不超过 2048 字符的 `global_write_justification`。`assurance_level` 只能是 `terra` 或 `sol`；起点只能是 `terra_single`、`terra_cohort`、`sol_high` 或 `sol_xhigh`，不得直接进入 `sol_max`。
2. 调用 `workflow_init`，再调用 `workflow_ready`。新建 `delegable` 节点必须以 Luna executor 启动；`avsp_terra_high` 只启动 `protected` 节点。main/root 为每个就绪节点创建原生实例；实例开始首个回合后，以真实任务路径、role 和 `native_agent_started=true` 调用 `workflow_start`。未启动的预定实例在确认停止后使用 `workflow_rebind_pending` 更换 owner。运行节点使用 `workflow_heartbeat` 和 `workflow_checkpoint` 留下可恢复进度。**即将修改工作区文件时**，该 running claim 先用 `workflow_acquire_write_lock` 对最小实际相对路径申请锁，完成这一原子写入组后立即用 `workflow_release_write_lock` 释放；不得因未来可能修改而预先锁定声明范围。节点完成、放弃、救援或重排队会自动清理该 claim 尚未释放的路径锁。
3. 所有工作节点完成后，main/root 完成验证、清理派生产物并调用 `workflow_audit_context` 冻结证据，再进入唯一末端审核门。`terra_single` 失败后记录精确 repair，进入 `terra_cohort`；cohort 不通过后 repair 并升级 `sol_high`。Sol 审核单调升级到 high、xhigh、max initial 和 max closure。closure 有效失败进入 `scope_decision_required`，必须交由用户决定。
4. 审核 JSON 必须含 `auditor_task`、`auditor_role`、`claim_id`、`coordinator_task_path`、`coordinator_thread_id`、`verdict`、`findings`、`requirement_coverage`、`workflow_snapshot`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps`、`residual_risk`、`independent_assessment`、`history_reconciliation` 和 `review_history_digest`。其中两个 coordinator 字段必须回显当前审核包绑定；缺失或错绑必须拒绝记录。`requirement_coverage` 必须是每个 requirement ID 到非空证据的对象；每条 finding 必须且只能是 `{id,severity,requirement_id,summary,evidence}`，`severity` 只能为 `blocking` 或 `advisory`。`fail` 必须含 blocking finding；`pass` 不得含 blocking finding。
5. **审核代理绝不调用 `workflow_record_review`、`workflow_complete` 或关闭任务。**main/root 创建审核实例时，任务包必须给出自己的 `coordinator_task_path`；审核代理将完整审核 JSON 仅用 `send_message` 发给该路径，最终可见答复只给自然语言结论、blocker 数量、关键证据和“审核载荷已发送”，不得输出裸 JSON、JSON 代码块或逐字段载荷。main/root 等待审核代理原生回合实际完成后，使用私信中的 JSON、`workflow_start` 返回的同一 `task_id`、`state_dir` 和 `claim_id` 调用 `workflow_record_review`；该调用成功后，main/root 才能以 `completion_attestation=native_agent_finished` 调用 `workflow_complete`，再调用 `workflow_close_check`。main/root 也不得把该 JSON 转发到用户可见回复。任何字段缺失时先调用 `workflow_status` 取回实际值，禁止猜测或自行编造。只有 `close_allowed=true` 才能交付或发布。

审核或修复记录失败时，main/root 必须读取 MCP 返回的 `error_code`、`field_errors` 与 `recovery`。`INVALID_ARGUMENT` 只修正所列字段；`FAILED_PRECONDITION` 必须按 `recovery.action` 操作：`refresh_audit_context` 重新读取上下文，`workflow_status` 取回当前 claim，`workflow_record_review` 先记录审核，`wait_for_work_nodes` 等待状态变化。不得更换字段名、猜测 claim、快照、指纹或 digest 后循环重试。`workflow_audit_context` 的 `review_input_contract` 与 `repair_input_contract` 是当前动态值的唯一来源；只有 `repair_input_contract.action="record_repair"` 时才可提交修复，`null` 表示当前阶段不允许修复记录。

Luna executor 已停止后，如果新证据使原 `delegable` 契约不再受控，main/root 先完成新的执行契约及更新后的 `assurance_assessment`，再调用 `workflow_escalate_execution`，提供原 `claim_id`、`previous_agent_stopped=true`、新的 Terra task path、`routing_reason` 与 `quality_guard`。评估仍为 Terra 时可在该调用中更新；若产生 `unknown`，先调用 `workflow_raise_assurance` 升级到 Sol。控制器会把节点改为 `protected`、保留旧 attempt、释放旧写锁，并返回恢复包；不得用它绕过初始 Luna 委派、接管审核节点或扩大 `workspace_claims`。

缺少当前 `execution_routing_policy_version` 或使用其他策略版本的历史持久化任务一律拒绝；控制器不读取、不迁移、不接管旧状态。创建新工作流后，仅当前策略下的 `delegable` 节点可由 Luna executor 认领；Terra 只能执行 `protected` 节点，或由 `workflow_escalate_execution` 在受控条件下接管。

### 清单字段的精确形状

`workflow_init` 会 fail-closed；不要把 requirements 写成字符串、不要使用 `node_id`，也不要把 `evidence` 写成单个字符串。最小形状如下（其余 manifest 字段照上节提供）：

```json
{
  "requirements": [{ "id": "R1", "text": "可核验的要求" }],
  "assurance_assessment": {
    "impact": { "status": "controlled", "evidence": ["证据"], "rationale": "理由" },
    "recoverability": { "status": "controlled", "evidence": ["证据"], "rationale": "理由" },
    "uncertainty": { "status": "partial", "evidence": ["证据"], "rationale": "理由" },
    "verifiability": { "status": "partial", "evidence": ["证据"], "rationale": "理由" },
    "coupling": { "status": "controlled", "evidence": ["证据"], "rationale": "理由" },
    "selection_reason": "各维度决定的门级理由"
  },
  "nodes": [{
    "id": "implement",
    "kind": "implementation",
    "depends_on": [],
    "execution_risk": "delegable",
    "routing_reason": "范围、恢复和验证均已明确",
    "execution_owner": "/root/implement",
    "integration_owner": "/root",
    "quality_guard": "明确的验证命令"
  }]
}
```

每个风险维度的 `status` 只能是 `controlled`、`partial` 或 `unknown`；任一 `unknown` 要求 `assurance_level="sol"`，至少一个 `partial` 且无 `unknown` 要求 `assurance_level="terra"`。审核节点仍须遵守上节的唯一末端门和 role 约束。

## 控制器边界

- 当前控制器只读取和写入当前 SQLite 状态。物理库固定为当前用户级 Codex home 的 `state/agnets-workflow/current/workflow.sqlite`；MCP 自己解析该 home，调用方不得传入或手工展开 home 路径。`workflow_init` 从 canonical workspace 自动派生绝对全局 namespace `state/agnets-workflow/current/namespaces/<workspace-sha256>` 并返回 `state_dir`；调用方不得选择目录。初始化不会创建、递归扫描、读取、迁移或兼容项目内旧状态，也不会打开旧全局库。它只验证 workspace 和声明 claims 的根元数据，实际变更证据由节点验证和独立审核提供。审查制品固定写入全局 `state/agnets-workflow/current/artifacts/<namespace-hash>/<task>/<claim>/`，不会在项目内创建 `.codex`、`workflow.sqlite`、`<task_id>.sqlite` 或审查结果 JSON。任务键为 canonical `state_dir + task_id`，工作区 lease 以该 task key 归属。`workflow_init`、`workflow_status` 和关闭/释放结果中的 `database_path` 与 `state_path` 都指向这一唯一物理库；`task_key={namespace,task_id}` 用于区分任务。全局库只接受当前 schema；未知、损坏或其他 schema 一律 fail-closed。
- `read_only` 节点使用只读 role；新建 `delegable` 节点只能由 Luna executor 认领，且 `execution_owner` 与真实任务路径一致。非审核 `protected` 节点由 Terra 执行；只有已停止的 Luna executor 因新证据被 `workflow_escalate_execution` 显式升级后，Terra 才可接管其原节点。`quality_review` 只允许 `avsp_terra_xhigh`，`total_review` 使用 Sol role。
- 控制器记录 agent 提供的任务路径和 claim，但不验证 Codex 身份。`workflow_start` 和 `workflow_complete` 的 lifecycle 字段是审计声明，不是宿主认证。
- `state_dir` 必须是 `workflow_init` 返回的绝对全局 namespace；project-local 路径、任意其他全局目录和 `<workspace>/.codex/...` 都会被拒绝。全局库使用 WAL、FULL、foreign_keys、30 秒 busy timeout、进程内 FIFO writer、任务级 change counter、总页数与任务数限额；只读查询不占 writer。`task_state.prune_after` 由完整关闭且已释放的状态同步维护，并有仅包含非空值的复合索引 `(prune_after, namespace_key, task_id)`。每次 MCP 启动后独立 worker 用短事务认领到期 task instance，在事务外校验 namespace 身份和清理 artifact，再以短事务复核并删除 row；MCP 先接收请求，文件系统扫描、删除和工作区指纹都不在全局写事务内。worker 同时执行被动 WAL checkpoint、`PRAGMA optimize` 和有界 incremental vacuum。该维护没有用户可调用的 MCP 工具。`workspace_claims` 是可申请路径锁的不可变审计上界，不是初始化时的互斥锁：声明重叠的任务可以并行，实际路径相同或一方是另一方的祖先时才互斥。只读节点不得申请写锁；`workflow_status` 和 `workflow_stale` 可见当前工作区的实际锁，锁不会因时间自动释放。根目录写锁仅限真正全工作区副作用，并要提供具体 `purpose`；扩大 claims 仍需使用新 `task_id`。`workflow_complete`、`workflow_checkpoint`、`workflow_record_review`、`workflow_record_repair` 和 `workflow_raise_assurance` 的 JSON 载荷必须优先以内联对象提交；控制器会拒绝目标 workspace 内的 JSON 文件路径，避免代理先把结果写进项目再让主控读取。
- MCP 启动维护只删除 closed_at 已满 7 天、`closed_revision===workflow_revision`、所有节点为 succeeded/skipped、lease 已释放且没有活跃任务或锁的任务；release-only、pending/running/failed/blocked/abandoned/unavailable 与损坏状态永不按时间删除。普通 `claim`、`heartbeat`、`checkpoint`、`complete` 和审核记录只锁定对应 task key。
