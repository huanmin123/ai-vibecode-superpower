# Agnets 工作流

`agnets-workflow` 为 Codex 提供统一的多代理工作流、项目工具链的受控接入与维护，以及持久化任务状态。它适合需要并行执行、可恢复交接和按证据升级的质量门的复杂开发任务。简单问答、只读查询或边界清晰的单文件低风险修改不进入持久化 DAG，由 main/root 直接完成并做与风险相称的最终验证。

## 能力

- 用任务 DAG 管理取证、设计、实现、集成、验证与任务末端质量门。
- 持久化任务状态、节点产物、参与者、审核记录和按声明范围协调的工作区租约。
- MCP 每次启动时会在后台清理满足完整关闭不变量且已满 7 天的任务；释放但未完整关闭、活动、失败、阻塞、放弃、unavailable 或损坏状态永不按时间删除。
- 通过 MCP 或本地 CLI 提供初始化、派发、心跳、checkpoint、恢复、总审和关闭检查。
- 用 `$agent-toolchain` 为目标项目接入或维护 CodeGraph/RTK；接入时在项目 `AGENTS.md` 中写入一个统一的 `## CodeGraph 与 RTK` 受管标题，日常开发直接遵守其中的规则。

工作流路由、角色边界、交接、恢复和总审升级规则以 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md) 为准；控制器命令和持久化约束以 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。

## 完整流程

先做工作流准入判断。复杂任务对外使用 `Explore → Plan → Work → Critique → Promote`：取证、定案、受控执行与集成验证属于前 3 个阶段；`Critique` 是冻结证据后的唯一任务级末端质量门；只有质量门和关闭检查通过且证据仍与当前任务和工作区匹配，才可 `Promote` 为可信交付。`Promote` 不授权发布、部署或其他外部状态变更。单文件、边界清晰且低风险的任务不进入该闭环，由 main/root 直接完成并运行贴近改动、再按影响扩大的验证。

进入持久化工作流后，一次用户输入对应一份完整任务清单；v3 可以按难度直接从单 Terra、并行交叉 Terra、Sol/high 或 Sol/xhigh 起步。所有升级审核会重新审视原始目标、环境、场景、边界以及全部历史审核和修复，而不是只复述前一轮。`sol_max` 先做一次全局审核，失败后只允许一次受保护修复与新的 closure；closure 再有有效问题即进入用户范围决策阻塞，自动链终止，不会无限重审或静默关闭。门级选择、审核升级和失败恢复规则见 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。

## 快速开始

先按 [`workflow-controller`](skills/workflow-controller/SKILL.md) 准备完整任务 manifest。`workflow_init` 会从 `manifest.workspace` 自动派生并返回全局 `state_dir`；后续命令必须原样复用该返回值。新任务的清单结构、质量门评估和节点字段以该文档为准。

在插件目录运行：

```powershell
node .\scripts\workflow_controller.mjs init --manifest .\task.json
# 从 init 输出复制 state_dir 后：
node .\scripts\workflow_controller.mjs --state-dir "<workflow_init 返回的全局 state_dir>" ready --task-id payments-refactor
```

需要独立复核时可使用插件入口：

```powershell
node .\scripts\sol_review_cli.mjs -- <prompt>
```

绑定工作流时，CLI 会把审查结果和受控日志保存到用户级 Codex home 的 `state/agnets-workflow/current/artifacts/<namespace-hash>/<task>/<claim>/`；子进程 stdout/stderr 只进入审查制品，不会转发到调用方终端。CLI 终端输出只给自然语言摘要，不输出 outcome 或审核 JSON；独立 CLI 不接受 `--result` 写入调用者指定路径，绑定工作流时使用全局结果制品完成收口，目标项目不会生成工作流审查 JSON。完整参数、总审绑定和验证流程见 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。

## 状态目录

`workflow_init` 从 canonical `manifest.workspace` 派生唯一的全局 namespace：`<用户级 Codex home>/state/agnets-workflow/current/namespaces/<workspace-sha256>`，并在响应中返回 `state_dir`。调用方不能选择或手工拼接它；项目内不会出现 `.codex/workflow-controller`、`workflow.sqlite`、任务 SQLite、WAL/SHM/journal、租约或审核 JSON。控制器不会扫描、读取、迁移或兼容任何旧本地 JSON/SQLite/租约，也不会打开旧的全局库；当前物理状态固定为用户级 Codex home 的 `state/agnets-workflow/current/workflow.sqlite`。初始化和质量门只读取声明 workspace claim 的根元数据，不递归枚举或哈希整个项目；实际变更验证以节点测试与审核证据为准。namespace 以 workspace 的 canonical 路径和物理身份锚定；审查制品固定写入全局 `state/agnets-workflow/current/artifacts/<namespace-hash>/<task>/<claim>/`。相同 task_id 可位于不同 workspace namespace；同 namespace 不可复用。`workflow_complete`、`workflow_checkpoint`、`workflow_record_review`、`workflow_record_repair` 和 `workflow_raise_assurance` 的 JSON 载荷应以内联对象传入；工作区内 JSON 文件路径会被拒绝，外部文件路径只保留给 workspace 外的明确输入。它们不是控制器的协调状态。

控制器不会在 heartbeat、claim 或 complete 等高频命令前隐式清理。每次 MCP 进程启动后会静默启动独立维护 worker，服务本身立即接收请求；worker 按到期索引用短事务认领 task instance，在事务外校验 namespace 物理身份并清理 artifact，再用短事务复核后删除 row。它只删除 closed_at 满 7 天、closed revision 与当前 revision 一致、全部节点 succeeded/skipped、lease 已释放且无活跃任务或锁的任务，并在 artifact 清理失败时保留 row。worker 还会执行被动 WAL checkpoint、查询规划优化和有界增量空间回收；全库和 namespace 任务数、payload 与数据库页数均有明确上限。该维护不作为 MCP 工具向用户暴露；release-only、pending/running/failed/blocked/abandoned/unavailable、身份不匹配和损坏状态永不按时间删除。`workflow_doctor` 只检查状态和恢复前提，不替用户接管运行中的代理。恢复、换绑和关卡失效处理见 [`workflow-controller`](skills/workflow-controller/SKILL.md)。

同一工作区可运行声明范围重叠的任务。清单必须提供非空 `workspace_claims`：`{mode:"read"|"write",prefix:"..."}` 数组；它是可申请写锁的不可变审计上界，而不是 `workflow_init` 时预占的锁，也不是文件系统 ACL。AI 仅在真正要改动文件前调用 `workflow_acquire_write_lock`，对最小实际相对路径申请短锁，并在该组写入完成后调用 `workflow_release_write_lock`；路径相同，或一方是另一方的祖先时才互斥。节点完成、放弃、救援或重排队会自动清理遗留锁。`workflow_status` 与 `workflow_stale` 会列出当前工作区的实际写锁；它们不会自动过期释放，协调者确认原执行者已停止后再使用相应的恢复或释放命令。末端审核仍须确认实际 diff 和产物仅落在 `write` claims。根目录 `write` 与根目录锁仅用于确实覆盖整个工作区的副作用，前者需 `global_write_justification`，后者需具体 `purpose`。扩大声明上界时，先确认旧执行者停止并释放其 entry，再用 claims 超集和新的 `task_id` 初始化替代任务。

## MCP

插件同时提供 `workflow-controller` MCP 服务。需要接入时使用插件自带的 `.mcp.json`；`workflow_init.manifest` 可直接传 v3 清单对象、内联 JSON 对象字符串或 workspace 外的普通 JSON 文件路径。`workflow_init` 返回的 `state_dir` 是后续操作唯一可接受的绝对全局 namespace。节点结果、checkpoint、审核和修复记录优先直接传 JSON 对象；控制器拒绝把目标 workspace 内的 JSON 文件当作工作流载荷，从调用契约上切断“先落地 JSON 再交给主控”的路径。高频调度调用默认返回紧凑摘要，持续观察先从 `workflow_status` 取得 `cursor`，再用 `workflow_wait` 被动等待变化。排障或审计需要完整任务状态时使用 `workflow_status detail=full`。具体工具名称和输入字段以 MCP schema 与 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。
