# Sol 总审运行细则

仅在使用 Sol CLI、受控外部证据包或硬超时时读取本文件。普通原生总审遵循 skill 入口即可。

## 受控外部证据

总审前，main/root 完成所有会写入被审工作区的验证，清理已知测试产物，并调用 `audit-context` 冻结工作区指纹和 `workflow_snapshot`。总审实例不得在该工作区执行可能写文件的命令，包括可能生成 WAL、锁、校验和或快照的测试；独立复跑必须在临时副本中执行，输出只作为证据。

大型外部归档只提供目标、需求、允许范围、当前指纹、工作流快照、实际测试输出、改动文件、必要相邻调用链和少量非目标哨兵路径。需要复跑时还必须包含传递本地导入闭包、对应配置和命令入口；否则标为仅静态证据，禁止尝试运行。

证据根目录必须包含 `evidence-manifest.json`：`{ "version": 1, "allowed_files": ["相对文件路径"] }`。目录内只允许清单列出的普通文件，不得包含符号链接、junction、嵌套同名清单、未列文件或目录外引用；上限为 512 个普通文件（含 manifest）、单文件 64 MiB、总计 128 MiB、路径深度 32 层。CLI 验证真实路径、文件身份和内容摘要后复制到私有临时快照；源目录变化、替换或快照失败均记为 `unavailable`。

使用 `sol_review_cli --review-profile bounded-external --evidence-dir <绝对目录>` 启动。该 profile 把 Codex 工作根切到证据目录并跳过 Git 仓库检查，不能只在 prompt 中声称隔离。目录缺失、清单无效、包含无关归档，或审查没有输出完整最终 JSON，均记为 `unavailable`。

CLI 的子进程 stdout/stderr 是机器审核证据：只允许写入受控 stdout/stderr 制品并由解析器消费，不得 tee 到调用方终端或聊天文本。CLI 外层 stdout 只保留一份最终 outcome JSON；MCP 调用应优先消费 `structuredContent`，`content.text` 只放人类摘要。

## 超时与结果

外层命令超时不证明审查进程已停止。`--timeout-sec` 是软截止，只记录 `deadline_reached` 并继续等待；只有 `--hard-timeout-sec` 才请求终止。硬截止或外层超时后，必须从操作系统进程列表和命令行精确定位该 task/claim 的 CLI 子进程，只终止明确匹配的进程并复核其已退出，之后才可 `abandon` 和 `retry`。无法归属或确认退出时保留节点运行或阻塞，不得并行重试。

软截止不是失败，部分日志不是 verdict，退出码 0 也不等于通过。有效 stdout 必须完整并以最终 JSON 结束；工作流绑定时还须匹配审查者、claim、需求覆盖、`workflow_snapshot` 和工作区指纹，否则记为 `unavailable`。`fail` 必须返回非空 `findings`，每项精确包含唯一、以字母开头、仅含字母数字、点、下划线或连字符且最长 80 字符的 `id`、`severity`、可空 `requirement_id`、`summary` 和 `evidence`，且至少一项为 `blocking`；`pass` 不得带 blocking finding，`unavailable` 不得带 findings。该结构直接用于后续修复的逐项绑定，不能只在自由文本里描述问题。

有效结果保留 `workflow_completion.state=pending`，并持久化 `workflow_artifact_authority`。工作流绑定的 CLI 只向用户级 Codex home 的 `state/agnets-workflow/artifacts/<namespace-hash>/<task>/<claim>/` 写入，并在启动前及每次日志、outcome、completion 写入前后逐级核对目录物理身份；任何 symlink/junction、越界或目录替换都会拒绝写入。main/root 把同一全局 `outcome.json` 作为受控内部制品交给 `workflow_complete`；普通节点结果和审核/修复/checkpoint 载荷直接以内联 JSON 传给控制器，目标 workspace 内的 JSON 路径会被拒绝。控制器用拒绝 link 的稳定文件句柄读取 outcome，把读取对象的文件身份传入 authority 校验，并在持久 intent、原子回写和回写后复核之间保持内容摘要与物理身份一致。它拒绝复制到其他路径、读取窗口内替换或目录替换后的 outcome，持久化节点完成后才原子回写最终 completion。恢复时同时检查该字段和控制器中的 claim 终态。子进程异常退出只可记录 `native_agent_exit_confirmed` 或 `native_agent_start_failed`：只有未收到 `spawn` 事件即报错属于后者，启动后的 error 必须等到实际 exit 才属于前者，均不得伪称 `native_agent_finished`。

## Max Closure

当 `audit-context.max_review_charter` 存在时，CLI 审查是 closure，不再开放式重新发现。只核验 charter 的固定 blockers、受保护 repair 的差异与回归，以及原始 requirements。`pass` 仅在这些项目全部通过时可用。v3 closure 发现任何 blocking finding 都必须输出 `fail` 和完整证据；控制器会进入 `scope_decision_required`，自动修复/重试链立即终止，等待用户选择替代任务或显式扩大范围。
