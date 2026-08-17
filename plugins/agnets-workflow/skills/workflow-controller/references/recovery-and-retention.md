# 恢复与保留

当前控制器仅支持 v3 SQLite 状态。所有工作区和任务共享固定用户级 `$CODEX_HOME/state/agnets-workflow/workflow.sqlite`；显式 `CODEX_HOME` 必须是绝对路径，未设置时使用平台用户目录下的 `.codex/state/agnets-workflow/workflow.sqlite`。`state_dir` 保持为逻辑 namespace 和审查制品根目录，绝不创建任务或工作区本地 SQLite。旧本地 SQLite 不会被迁移、read-through 或删除；全局行缺失但本地任务库存在时明确报告 `LEGACY_STATE_MIGRATION_REQUIRED`。

`workflow_stale` 区分未激活与心跳过期，并列出当前实际写锁；`workflow_status` 也提供相同的锁可见性。锁不会依时间自动释放。协调者必须先确认原执行者已经停止，才可调用 `workflow_requeue_stale`、`workflow_rescue` 或 `workflow_release_workspace`；已终止 claim 的指定锁可用 `workflow_release_write_lock` 重试释放。`workflow_rebind_pending` 只用于从未启动的 pending 节点。

控制器和 MCP 在命令分流前按现有物理祖先规范化 `state_dir`，并以 canonical namespace 加 task_id 形成 task key。全局 SQLite 的短写事务提供协调互斥；任务执行本身不持有该事务，也不再创建 `.lock`、`.writer`、`.release`、`.recover` 或 `.reclaim` 文件。任何替换、损坏或身份不匹配都会失败，不会重新基线或推测恢复。

`workflow_doctor` 是只读诊断：指定任务时检查 SQLite 状态、租约、控制数据库和运行节点；省略任务时检查隔离目录。它不删除、修复、释放租约或猜测旧代理状态。

`workflow_prune_expired` 仅在显式调用时运行。它逐任务先删除受控 `.workflow-review-results/<task_id>` 制品，再删除 task row；制品删除失败时保留该 row 并报告。只有 `closed_at` 已满 7 天、`closed_revision === workflow_revision`、所有节点为 `succeeded`/`skipped`、lease 已释放且工作区无 active task/lock 的任务才可删除。release-only、pending/running/failed/blocked/abandoned/unavailable 或损坏状态永不因时间删除，无法验证时一律保留并报告。
