# 存储与维护

这是 SQLite、原子写入、文件锁、清理、隔离和文件系统限制的唯一规则来源。

- 任务主体位于 `state_dir/<task_id>.sqlite`，使用内置 SQLite/WASM；每任务独占数据库，`<task_id>.json.lock` 串行同一任务。同步临时文件、原子替换与同步目标的写入失败原样报错；首次成功写入后旧 `.json` 改名 `.json.legacy`，SQLite 提交前不删除旧文件。
- 同一任务状态文件由 `<task_id>.json.lock` 的短时原子写锁串行；锁仅覆盖实际读改写和协调文件操作，超时仍报告 `Task state is busy`。不同 `task_id` 或不同 `state_dir` 即使绑定同一工作区也可并行，不存在工作区级活动租约。不要删除活动任务状态，也不要将控制目录纳入业务指纹。
- 旧版含 `workspace_lease` 的任务状态不能证明与文件级协议兼容，控制器会显式拒绝其生命周期操作；doctor 保留原始状态用于只读诊断，30 天后清理会按不可验证状态隔离。遗留的 `workspace-lease.json` 不参与新任务，也不会阻塞其他 `task_id` 的初始化。
- 外部证据根必须有 `evidence-manifest.json`，只含清单列出的普通文件；拒绝符号链接、junction、嵌套清单和目录外引用。流式校验最多 512 个普通文件（含清单）、512 个目录（不含根）、单文件 64 MiB、总计 128 MiB、32 层路径；复制前后核对真实路径、身份和摘要。
- `sol_review_cli` 的软 `--timeout-sec` 不终止进程；只有 `--hard-timeout-sec` 才请求终止。外层超时后先按任务与 claim 精确确认子进程已退出，才可 abandon 或 retry；无法确认时保留运行或阻塞。
- 普通非只读操作至多每 6 小时惰性清理一次，`workflow_prune_expired` 可立即扫描。7 天未更新且完整可验证、无运行节点的任务可删；30 天未知、legacy 或不可验证状态移入 `.workflow-errors`，隔离后保留 365 天才删。活动、锁不可得或隔离未完成时保留；`workflow_reconcile_quarantine` 只补齐可验证传输，不删除未知文件。
