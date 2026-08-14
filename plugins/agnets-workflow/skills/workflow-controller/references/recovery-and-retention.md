# 恢复与保留

当前控制器仅支持 v3 SQLite task state。旧 JSON、旧租约和其他历史状态不会被迁移、恢复或执行；它们由维护者在控制器外部决定归档或删除。

`workflow_stale` 区分未激活与心跳过期。协调者必须先确认原执行者已经停止，才可调用 `workflow_requeue_stale`、`workflow_rescue` 或 `workflow_release_workspace`。`workflow_rebind_pending` 只用于从未启动的 pending 节点。

每个任务的状态位于 `state_dir/<task_id>.sqlite`。控制器和 MCP 在命令分流前按现有物理祖先规范化 `state_dir`，并绑定状态目录、workspace authority 与 registry 的物理身份。任何替换、损坏或身份不匹配都会失败，不会重新基线或推测恢复。

`workflow_doctor` 是只读诊断：指定任务时检查 SQLite 状态、租约、协调文件和运行节点；省略任务时检查隔离目录与清理摘要。它不删除、修复、释放租约或猜测旧代理状态。

连续 7 天未更新的已释放任务，只有在状态、租约、authority、registry 和 review 目录均可验证且不存在 active owner 时才会清理。连续 30 天的未知或损坏状态只会在同样的可验证前提下隔离。隔离满 365 天后，仍须重新验证没有 active owner，才可删除。无法验证时一律保留并报告。
