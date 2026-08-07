# 恢复与诊断

这是 `ensure-context`、过期、重派、救援、锁和 doctor 的唯一规则来源。

- 创建或恢复边界仅调用一次 `workflow_ensure_context`：同时指定 `state_dir` 与 `task_id` 时，`new` 才初始化，`active` 继续，`blocked` 保留原始错误并停止；它不创建任务、代理或工作区级协调状态。
- `workflow_stale` 区分 `never_activated` 与 `heartbeat_expired`。协调者先用原生状态确认旧实例已停止且不再写入；没有该证据不得重排队、救援或并行替换。
- 有实际 `resume_agent`、可读 `agent_thread_id` 且旧实例可恢复时，由宿主恢复旧实例；控制器不能调用它。否则先创建并核验新实例，再以不同的 `replacement_agent_task_path` 调用 `workflow_requeue_stale`，按新 claim 继续，不得宣称恢复旧会话。总审替代者不得是此前参与者。
- session persistence、状态库或必要状态不可读时，只盘点当前实例状态、diff、产物和输出，保留原始错误与缺失条件并停止恢复或替换；不得声称已恢复、已排队或会自动重试。
- 旧 executor 已停止而 main/root 必须接管时，使用 `workflow_rescue` 记录原 claim、原因和替代路径；Root 以 `agent_role=main/root` 重新 `workflow_start`，不得把其结果归为 Luna。
- `workflow_retry` 只在旧实例停止后重开 failed、blocked、unavailable 或 abandoned 节点；现代路由必须重绑预定替代路径。任务中断且无运行节点时，不需要释放任何工作区级资源。
- `workflow_recover_lock` 只可归档同主机、超过阈值且 PID 不存在的该任务写锁；未知、异机或活动锁保持阻塞。`workflow_doctor` 只读返回状态、任务协调文件、过期节点和重派前提，不修复、释放、删除或猜测旧代理状态。
