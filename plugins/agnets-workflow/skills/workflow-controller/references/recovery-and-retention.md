# 恢复与保留

当前控制器仅支持当前 SQLite 状态。所有工作区和任务共享固定用户级 `$CODEX_HOME/state/agnets-workflow/workflow.sqlite`；显式 `CODEX_HOME` 必须是绝对路径，未设置时使用平台用户目录下的 `.codex/state/agnets-workflow/workflow.sqlite`。`state_dir` 只作为逻辑 namespace；审查制品统一位于 `$CODEX_HOME/state/agnets-workflow/artifacts/<namespace-hash>/<task>/<claim>/`，不属于项目目录。其他 schema 或本地文件不属于当前工作流状态，初始化不会读取它们。

`workflow_stale` 区分未激活与心跳过期，并列出当前实际写锁；`workflow_status` 也提供相同的锁可见性。锁不会依时间自动释放。协调者必须先确认原执行者已经停止，才可调用 `workflow_requeue_stale`、`workflow_rescue` 或 `workflow_release_workspace`；已终止 claim 的指定锁可用 `workflow_release_write_lock` 重试释放。`workflow_rebind_pending` 只用于从未启动的 pending 节点。

控制器和 MCP 在命令分流前按现有物理祖先规范化 `state_dir`，并以 canonical namespace 加 task_id 形成 task key。全局 SQLite 的短写事务提供协调互斥；任务执行本身不持有该事务，也不再创建 `.lock`、`.writer`、`.release`、`.recover` 或 `.reclaim` 文件。任何替换、损坏或身份不匹配都会失败，不会重新基线或推测恢复。

`workflow_doctor` 是只读诊断：必须指定任务，检查 SQLite 状态、租约、控制数据库和运行节点。它不删除、修复、释放租约或猜测代理状态。

MCP 每次启动后都会静默启动一个独立保留 worker，不向用户暴露单独的清理工具，也不阻塞 MCP 接收请求。全局库把完整关闭且已释放任务的到期点写入 `task_state.prune_after`，并使用仅包含非空值的复合索引 `(prune_after, namespace_key, task_id)` 定位到期 task key；它不会为启动维护反序列化或扫描全部任务行。worker 先在短事务内用持久 prune claim 冻结 task instance，再在事务外验证 namespace 身份并删除用户级 artifact store 中的 `<namespace-hash>/<task_id>` 制品，最后以第二个短事务复核 instance、租约与关闭不变量后删除 task row。制品删除失败时保留 row 和可重试 claim；同 task key 在 claim 存续时不能重建或写入，因此旧清理不会误删新任务。只有 `closed_at` 已满 7 天、`closed_revision === workflow_revision`、所有节点为 `succeeded`/`skipped`、lease 已释放且工作区无 active task/lock 的任务才可删除。release-only、pending/running/failed/blocked/abandoned/unavailable、身份不匹配或损坏状态永不因时间删除。

全局库使用 WAL、FULL synchronous、30 秒 busy timeout、任务级 change counter 和到期候选索引。新建库启用 incremental auto-vacuum；worker 每次运行会执行被动 WAL checkpoint、`PRAGMA optimize` 和有界 incremental vacuum。单任务 payload、全库页数、全库 task 数与单 namespace task 数均有限额，达到限额会明确拒绝新任务而不是继续吃满磁盘。已删除页可复用；MCP 前台不会执行全量 `VACUUM`。
