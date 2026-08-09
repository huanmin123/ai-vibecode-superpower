# 恢复与保留

仅在节点失联、任务中断、锁阻塞、状态迁移、诊断、隔离或清理时读取本文件。

## 节点与任务恢复

`workflow_stale` 区分 `never_activated`（没有首个心跳）和 `heartbeat_expired`（启动后失联）。协调者先用原生状态确认旧执行者已停止。若保存了 `agent_thread_id` 且 V2 metadata/rollout 可读，可用 `send_message`/`followup_task` 懒加载原子代理并继续原 claim；活动 turn、wait 或未确认 pending wakeup 不保证恢复，控制器也不能调用内部 `resume_agent`。

无法恢复原实例时，先创建替代实例并核对真实任务路径，再以该路径、原 `claim_id` 和 `previous_agent_stopped=true` 调用 `workflow_requeue_stale`。控制器保存旧 attempt/checkpoint、重绑现代节点的 `execution_owner` 并返回 `kind=new_agent_required` 恢复包。替代路径不得等于旧路径；总审替代者不得是此前参与者。这是新实例连续执行，不是恢复旧会话。

Luna executor 或显式匹配的 legacy writer 已停止而 Root 必须接管时，调用 `workflow_rescue` 记录原 claim、原因、替代路径和 `rescue_role=main/root`，再由 Root 以新 claim 和 `agent_role=main/root` 执行；不得归为 Luna 结果。任务中断且没有运行节点时，只有确认全部旧代理停止后才能 `workflow_release_workspace`。没有实际停止证据时不得重排队、救援或释放。

锁恢复只允许 `workflow_recover_lock` 处理同一主机、超过阈值且 PID 已不存在的锁；它在独占保护下归档旧锁，不删除活动锁。崩溃遗留协调意图也只在元数据完整、同主机、超过阈值且 PID 不存在时归档；未知、异机或仍活动时保持阻塞。

## 状态与诊断

任务主体位于 `state_dir/<task_id>.sqlite`，使用插件内置 SQLite/WASM；每个任务一个数据库，`<task_id>.json.lock` 负责跨进程序列化。写入通过同步临时文件、原子替换和同步目标提交；POSIX 还同步父目录，Windows 刷新可写目标句柄。失败原样报错，不创建周期备份。

旧 `<task_id>.json` 在首次成功写入 SQLite 后改名为 `.json.legacy`，作为一次恢复副本；提交前不删除旧文件。`workspace-lease.json` 和 `.workflow-prune-sweep.json` 是跨任务协调记录，继续独立保存。

`workflow_doctor` 是只读诊断：指定 `task_id` 时检查状态库、租约、协调文件和运行节点；省略时列出隔离项、孤立 legacy 副本和清理摘要。载荷不可读时返回 `health=blocked`、原始错误和不可关闭结论，不删除、修复、释放租约或猜测旧代理状态。

## 清理与隔离

非只读控制器操作通过 `.workflow-prune-sweep.json` 将惰性清理限制为同一目录最多每 6 小时一次；只读诊断不触发清理，`workflow_prune_expired` 可立即扫描。控制器不是常驻服务，没有调用时不会在保留期限到点时自行运行。

- 连续 7 天未更新：仅删除租约已释放、无运行节点且版本与字段完整可验证的任务及对应 review 证据。
- 连续 30 天未更新：把未知、legacy 或租约不可验证状态移到 `.workflow-errors/<id>/`；`quarantine.json` 与 `.quarantine-expiry.json` 记录传输和不可变到期信息。
- 隔离完成 365 天后：后续清理才可删除；主元数据损坏时，也必须有可验证的到期凭证和目录内容。

隔离传输中断时用 `workflow_reconcile_quarantine` 幂等补齐已知文件和 review 证据，不删除未知文件。仍有运行节点、锁不可取得或传输未完成的状态始终保留。
