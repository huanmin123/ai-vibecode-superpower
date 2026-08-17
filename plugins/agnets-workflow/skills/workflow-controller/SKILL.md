---
name: workflow-controller
description: "使用本地工作流控制器持久化当前 v3 Codex 任务 DAG，并以独立末端质量门关闭任务。"
---

# 工作流控制器

需要持久化 DAG 调度、可恢复交接或可执行的任务级质量门时使用此 skill。简单问答、只读查询和边界清晰的单文件低风险任务不初始化控制器。控制器管理状态和关闭关卡，不替代 Codex 原生代理工具。

## 必经流程

1. 创建 `routing_schema_version=3` 的 JSON 清单。必须包含 `task_id`、绝对路径 `workspace`、`workspace_claims`、`goal`、唯一 `requirements`、DAG `nodes`、完整路由字段、结构化 `assurance_assessment`、`assurance_level`、`review_context` 和 `review_entry_stage`。`workspace_claims` 为非空 `{mode:"read"|"write",prefix:"..."}` 数组，优先最小可行范围；`write "."` 仅用于真正全工作区副作用，并且必须提供非空、不超过 2048 字符的 `global_write_justification`。`assurance_level` 只能是 `terra` 或 `sol`；起点只能是 `terra_single`、`terra_cohort`、`sol_high` 或 `sol_xhigh`，不得直接进入 `sol_max`。
2. 调用 `workflow_init`，再调用 `workflow_ready`。main/root 为每个就绪节点创建原生实例；实例开始首个回合后，以真实任务路径、role 和 `native_agent_started=true` 调用 `workflow_start`。未启动的预定实例在确认停止后使用 `workflow_rebind_pending` 更换 owner。运行节点使用 `workflow_heartbeat` 和 `workflow_checkpoint` 留下可恢复进度。**即将修改工作区文件时**，该 running claim 先用 `workflow_acquire_write_lock` 对最小实际相对路径申请锁，完成这一原子写入组后立即用 `workflow_release_write_lock` 释放；不得因未来可能修改而预先锁定声明范围。节点完成、放弃、救援或重排队会自动清理该 claim 尚未释放的路径锁。
3. 所有工作节点完成后，main/root 完成验证、清理派生产物并调用 `workflow_audit_context` 冻结证据，再进入唯一末端审核门。`terra_single` 失败后记录精确 repair，进入 `terra_cohort`；cohort 不通过后 repair 并升级 `sol_high`。Sol 审核单调升级到 high、xhigh、max initial 和 max closure。closure 有效失败进入 `scope_decision_required`，必须交由用户决定。
4. 审核 JSON 必须含 `auditor_task`、`auditor_role`、`claim_id`、`verdict`、`requirement_coverage`、`workflow_snapshot`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps`、`residual_risk`、`independent_assessment`、`history_reconciliation` 和 `review_history_digest`。`fail` 必须含 blocking finding；`pass` 不得含 blocking finding。
5. 审核代理记录审核并完成原生回合后，main/root 以匹配 claim 的 `completion_attestation=native_agent_finished` 调用 `workflow_complete`，再调用 `workflow_close_check`。只有 `close_allowed=true` 才能交付或发布。

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

- 当前控制器只读取和写入 v3 SQLite 状态。物理库固定为 `$CODEX_HOME/state/agnets-workflow/workflow.sqlite`；显式 `CODEX_HOME` 必须是绝对路径，未设置时 Windows 使用 `%USERPROFILE%/.codex`，POSIX 使用 `$HOME/.codex`。`state_dir` 是绝对逻辑 namespace 与审查制品根目录，不会创建 `workflow.sqlite` 或 `<task_id>.sqlite`。任务键为 canonical `state_dir + task_id`，工作区 lease 以该 task key 归属。`workflow_init`、`workflow_status` 和关闭/释放结果中的 `database_path`（兼容字段 `state_path`）都指向这一唯一物理库；`task_key={namespace,task_id}` 用于区分任务，绝不把项目内逻辑键当作 SQLite 文件。旧本地 SQLite 不迁移、不 read-through；发现时返回 `LEGACY_STATE_MIGRATION_REQUIRED`。
- `read_only` 节点使用只读 role；Luna executor 只能认领完整 `delegable` 契约且 `execution_owner` 与真实任务路径一致。非审核 `protected` 节点由 Terra 执行；`quality_review` 只允许 `avsp_terra_xhigh`，`total_review` 使用 Sol role。
- 控制器记录 agent 提供的任务路径和 claim，但不验证 Codex 身份。`workflow_start` 和 `workflow_complete` 的 lifecycle 字段是审计声明，不是宿主认证。
- `state_dir` 必须是绝对路径；每次新的 `workflow_init` 都要求它位于目标工作区内，并且除标准 `<workspace>/.codex/workflow-controller/` 外不得使用 `.git`、`node_modules`、`.venv` 等指纹排除目录。全局库使用 WAL、FULL、foreign_keys、30 秒 busy timeout 和进程内 FIFO writer；只读查询不占 writer。显式 `workflow_prune_expired` 还会在同一全局 `BEGIN IMMEDIATE` maintenance transaction 中排队，逐任务完成候选校验、artifact 清理和 row 删除，artifact 失败时保留 row。`workspace_claims` 是可申请路径锁的不可变审计上界，不是初始化时的互斥锁：声明重叠的任务可以并行，实际路径相同或一方是另一方的祖先时才互斥。只读节点不得申请写锁；`workflow_status` 和 `workflow_stale` 可见当前工作区的实际锁，锁不会因时间自动释放。根目录写锁仅限真正全工作区副作用，并要提供具体 `purpose`；扩大 claims 仍需使用新 `task_id`。
- `workflow_prune_expired` 仅在显式调用时运行。它只删除 closed_at 已满 7 天、`closed_revision===workflow_revision`、所有节点为 succeeded/skipped、lease 已释放且没有活跃任务或锁的任务；release-only、pending/running/failed/blocked/abandoned/unavailable 与损坏状态永不按时间删除。普通 `claim`、`heartbeat`、`checkpoint`、`complete` 和审核记录只锁定对应 task key。
