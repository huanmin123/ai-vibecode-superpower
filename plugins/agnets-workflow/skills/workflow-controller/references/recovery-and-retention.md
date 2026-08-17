# 恢复与保留

当前控制器仅支持 v3 SQLite 状态。工作区协调保存在 `<workspace>/.codex/workflow-controller/workflow.sqlite`，任务状态保存在 `state_dir/<task_id>.sqlite`。旧 JSON、旧租约和其他历史状态不会被迁移、恢复或执行。只有新的 `workflow_init` 会删除已识别的旧 JSON 协调文件并创建新的工作区控制库；它不会读取旧任务、恢复旧 claim 或保留旧任务所有权。已存在任务的命令遇到控制库缺失、损坏或路径不匹配会失败，不会重建。

`workflow_stale` 区分未激活与心跳过期，并列出当前实际写锁；`workflow_status` 也提供相同的锁可见性。锁不会依时间自动释放。协调者必须先确认原执行者已经停止，才可调用 `workflow_requeue_stale`、`workflow_rescue` 或 `workflow_release_workspace`；已终止 claim 的指定锁可用 `workflow_release_write_lock` 重试释放。`workflow_rebind_pending` 只用于从未启动的 pending 节点。

控制器和 MCP 在命令分流前按现有物理祖先规范化 `state_dir`，并绑定状态目录与 `workflow.sqlite` 的物理身份。SQLite 的短写事务提供工作区协调互斥；任务执行本身不持有该事务，也不再创建 `.lock`、`.writer`、`.release`、`.recover` 或 `.reclaim` 文件。任何替换、损坏或身份不匹配都会失败，不会重新基线或推测恢复。

`workflow_doctor` 是只读诊断：指定任务时检查 SQLite 状态、租约、控制数据库和运行节点；省略任务时检查隔离目录。它不删除、修复、释放租约或猜测旧代理状态。

连续 7 天未更新的已释放任务，只有在任务状态、工作区控制库和 review 目录均可验证且不存在 active owner 时才会清理。连续 30 天的未知或损坏状态只会在同样的可验证前提下隔离。隔离满 365 天后，仍须重新验证没有 active owner，才可删除。无法验证时一律保留并报告。
