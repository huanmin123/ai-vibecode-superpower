# 恢复与保留

仅在节点失联、任务中断、锁阻塞、状态迁移、诊断、隔离或清理时读取本文件。

## 节点与任务恢复

`workflow_stale` 区分 `never_activated`（没有首个心跳）和 `heartbeat_expired`（启动后失联）。协调者先用原生状态确认旧执行者已停止。若保存了 `agent_thread_id` 且 V2 metadata/rollout 可读，可用 `send_message`/`followup_task` 懒加载原子代理并继续原 claim；活动 turn、wait 或未确认 pending wakeup 不保证恢复，控制器也不能调用内部 `resume_agent`。

计划实例在认领节点前就未启动时，不需要伪造一次失败或等待 stale。确认该实例已停止后，先创建替代实例并核对真实任务路径，再以 `previous_agent_stopped=true` 调用 `workflow_rebind_pending`；它只处理未认领的现代 pending 节点，不消耗执行 attempt，并保持 reviewer 独立性与 owner 唯一性约束。

无法恢复原实例时，先创建替代实例并核对真实任务路径，再以该路径、原 `claim_id` 和 `previous_agent_stopped=true` 调用 `workflow_requeue_stale`。控制器保存旧 attempt/checkpoint、重绑现代节点的 `execution_owner` 并返回 `kind=new_agent_required` 恢复包。替代路径不得等于旧路径；总审替代者不得是此前参与者。这是新实例连续执行，不是恢复旧会话。

Luna executor 或显式匹配的 legacy writer 已停止而 Root 必须接管时，调用 `workflow_rescue` 记录原 claim、原因、替代路径和 `rescue_role=main/root`，再由 Root 以新 claim 和 `agent_role=main/root` 执行；不得归为 Luna 结果。任务中断且没有运行节点时，只有确认该任务全部旧代理停止后才能 `workflow_release_workspace`。释放、关闭和自愈只移除自身完整 lease identity，绝不清理 peer entry；没有实际停止证据时不得重排队、救援或释放。初始化恢复使用 `workflow_reconcile_workspace(workspace, task_id, state_dir)`，只处理目标 initializing entry；旧调用仅在唯一 initializing entry 时兼容。一个 `state_path` 同时只能由一个 registry entry 占用；同一 `task_id` 可在不同 `state_dir` 且 claims 不冲突时并行，恢复和释放始终按完整 identity 定位。

末端 `pass` 或验证记录完成后、工作区租约释放前，如果 `workflow_close_check` 报告任务状态或工作区在关卡后变化，调用 `workflow_invalidate_gate`。`verification` 会将完整旧记录、失效原因和时间追加到有界 `verification_history` 后清除当前记录并要求重新验证；Terra/Sol 会保留历史审核、重开同一个审核节点并绑定新的独立 reviewer。该入口只处理关闭关卡失效，不得用于普通 `fail`、`unavailable` 或人为增加审核轮次。

锁恢复只允许 `workflow_recover_lock` 处理同一主机、超过阈值且 PID 已不存在的锁；它在独占保护下归档旧锁，不删除活动锁。崩溃遗留协调意图也只在元数据完整、同主机、超过阈值且 PID 不存在时归档；未知、异机或仍活动时保持阻塞。

## 状态与诊断

任务主体位于 `state_dir/<task_id>.sqlite`，使用插件内置 SQLite/WASM；所有 controller/MCP/总审 CLI 入口在命令分流前按现有物理祖先 `realpath` 规范化 `state_dir`，缺失尾段从该祖先重建，因此 Windows 大小写、junction 和 symlink 别名共享同一个数据库、`<task_id>.json.lock`、MCP wait 和总审结果目录。相对路径被拒绝。总审 CLI 还会逐级创建并绑定 `.workflow-review-results/<task>/<claim>/` 的物理目录身份；任一级是 symlink/junction、越出 state 根目录或在写入前后被替换时拒绝写入。每个任务一个数据库。写入通过同步临时文件、原子替换和同步目标提交；POSIX 还同步父目录，Windows 刷新可写目标句柄。失败原样报错，不创建周期备份。

旧 `<task_id>.json` 在首次成功写入 SQLite 后改名为 `.json.legacy`，作为一次恢复副本；提交前不删除旧文件。任务初始化同时把 canonical `state_dir` 父目录的 `path`、`real_path` 与 BigInt identity 绑定到 task state 和对应 active registry entry；后续 mutation、关闭、协调恢复与清理只能复用该锚定，跨命令替换同一路径的状态目录会在读取、写入或删除 peer 前 fail closed。现代 task state 或 v2 `active_tasks` entry 缺少该锚定时一律要求受控恢复，禁止从当前 pathname 重新取样、补写或释放/删除；`workflow_doctor` 只报告 blocked。严格验证的 legacy v1 registry 只可临时映射为 v2 租约，其活动 task 仍必须已有可验证的 task-state 锚定，不能以 v1 路径字段重新基线。workspace 根目录的 `.codex-workflow-controller-authority.json` 独立绑定 workspace 根、`.codex/workflow-controller` 控制目录和当前 registry 文件对象，并提供 `authority -> registry -> task state` 的统一锁序；所有活动租约校验、状态 mutation、清理和 registry mutation 都在该根锁内执行，读写前后重新核对 authority 与 registry 身份。目录和文件对象 identity 一律以 `lstat/stat({ bigint: true })` 的十进制字符串保存和比较，不使用可能丢失 inode 精度的 Number。registry publication 会先写入同根 `.publication.json` journal；若 registry 原子替换后进程崩溃，下一次取得 authority lock 的变更操作只会把 journal 中精确 payload 的新 registry object 绑定回原 authority，随后删除 journal。`workflow_doctor`、`status` 等只读命令绝不触发此恢复或写入 journal。journal 尚未发布 registry 时仅在旧 authority object 仍匹配时丢弃；任一替换或不匹配均 fail closed。registry publication 和 v1 migration 只继承由调用方预先核验的 workspace/control 父目录身份，不递归重建父目录，也不会把过渡期间出现在同一路径的新目录重新选举为 authority；lock/intent 释放只删除仍与本实例打开句柄相同的文件对象。所有原子写入均要求调用方传入已验证父目录授权，并在创建临时文件、rename 前后复核该授权；父目录替换时停止且不清理 peer 文件。它及其临时/锁文件不进入工作区指纹，也不能被 claims 声明。`workspace-lease.json` 是 v2 `active_tasks` registry：v1 的单项租约迁移为根目录 `write` claim，旧 registry 可在显式恢复或首次受控 mutation 时建立 authority；authority 只在全新 control tree 无 registry 或严格识别的 legacy v1 registry 时允许第一次创建。缺失 authority 的 v2 registry、曾初始化后的 registry 缺失、文件对象替换、控制目录身份变化或内容损坏均 fail closed，不能合成为空 registry。`.workflow-prune-sweep.json` 是跨任务协调记录，继续独立保存。

`workflow_doctor` 是只读诊断：指定 `task_id` 时检查状态库、租约、协调文件和运行节点；省略时列出隔离项、孤立 legacy 副本和清理摘要。载荷不可读时返回 `health=blocked`、原始错误和不可关闭结论，不删除、修复、释放租约或猜测旧代理状态。

## 清理与隔离

非只读控制器操作通过 `.workflow-prune-sweep.json` 将惰性清理限制为同一目录最多每 6 小时一次；只读诊断不触发清理，`workflow_prune_expired` 可立即扫描。控制器不是常驻服务，没有调用时不会在保留期限到点时自行运行。

- 连续 7 天未更新：仅删除自身 lease entry 已释放、authority 与 registry 文件都存在且完整可验证、registry 中完全没有 active entry 的 state、SQLite/legacy 或 review 物理路径与候选删除集合相等或互为父子、无运行节点且版本与字段完整可验证的任务及对应 review 证据；缺失 registry 不能解释为空 registry。review 树含链接或身份无法验证时保留。同一工作区无关 peer 不阻塞，但大小写别名、不同 identity 占用同一物理 state path、peer state 嵌套在候选 review 树等情况均 fail closed。released 状态遗留的完整自身 entry 可在 registry 锁内受控自愈移除，绝不移除 peer。
- 连续 30 天未更新：仅当 canonical registry 存在、可完整验证并确认没有任何 active entry 占用候选 state 或 review 来源时，才把损坏、未知字段或 legacy 状态移到 `.workflow-errors/<task>-<64-hex-authority-anchor>-<uuid>/`。状态不可读、registry 缺失/损坏/非 canonical、节点状态未知或其他授权信息无法验证时一律保留并要求人工恢复，不得自动移动来源。新 `quarantine.json` 与 `.quarantine-expiry.json` 是与 workspace、registry、原始 state、已知文件、review 目录及隔离目录共同绑定的成对记录，必须逐项相符才可用于后续传输。review 树中任意 symlink、junction、reparse point 或越出物理根目录的路径都会阻止隔离。Windows 在创建错误目录前预检错误目录、sidecar/临时文件、全部 state 组件和 review 内容目标；任一路径超过系统保守限制时失败且不移动来源。旧目录或历史短锚目录没有完整 authority binding，只可管理已在错误目录中的内容或到期删除，不能再从来源目录补搬。
- 隔离完成 365 天后：后续清理仍须在 workspace authority -> registry 锁内重读成对 sidecar，确认整个隔离目录与任何 active entry 的 state、SQLite/legacy 或 review 路径都不重叠；随后把同一目录对象原子改名为唯一 tombstone，复核身份后才递归删除。主元数据损坏时，也必须有带完整 workspace/registry authority 的可验证到期凭证和安全目录内容；缺少该绑定的旧记录保留给人工恢复。

隔离传输中断时，`workflow_reconcile_quarantine` 只会在 registry -> state 锁序下重核绑定，并确认候选 state、SQLite/legacy 文件和 review 目录均不属于任何 active entry 后，才幂等补齐已知内容；不删除未知文件。旧 sidecar 缺少这种可信绑定时不从 `state_dir` 或 review 根目录补搬，保留给人工恢复。仍有运行节点、锁不可取得、绑定不符或传输未完成的状态始终保留。
