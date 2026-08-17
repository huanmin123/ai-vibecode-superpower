# Agnets 工作流

`agnets-workflow` 为 Codex 提供统一的多代理工作流、项目工具链的受控接入与维护，以及持久化任务状态。它适合需要并行执行、可恢复交接和按证据升级的质量门的复杂开发任务。简单问答、只读查询或边界清晰的单文件低风险修改不进入持久化 DAG，由 main/root 直接完成并做与风险相称的最终验证。

## 能力

- 用任务 DAG 管理取证、设计、实现、集成、验证与任务末端质量门。
- 持久化任务状态、节点产物、参与者、审核记录和按声明范围协调的工作区租约。
- 在控制器被再次调用时惰性清理过期状态；完整已关闭任务按 7 天处理，可证明已失活的损坏状态在 30 天后隔离，无法验证控制数据库或运行状态的任务保留给人工恢复，隔离完成后再保留 365 天。
- 通过 MCP 或本地 CLI 提供初始化、派发、心跳、checkpoint、恢复、总审和关闭检查。
- 用 `$agent-toolchain` 为目标项目接入或维护 CodeGraph/RTK；接入时在项目 `AGENTS.md` 中写入一个统一的 `## CodeGraph 与 RTK` 受管标题，日常开发直接遵守其中的规则。

工作流路由、角色边界、交接、恢复和总审升级规则以 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md) 为准；控制器命令和持久化约束以 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。

## 完整流程

先做工作流准入判断。只有需要持久化、多节点协作、恢复交接或独立末端质量门的完整任务才建立 DAG。进入后，一次用户输入对应一份完整任务清单；取证、设计、实现、集成和验证都在任务内部完成，各节点保留必要证据，但不单独启动审核。全部工作完成并冻结工作区后，才运行唯一的任务级末端质量门。v3 可以按难度直接从单 Terra、并行交叉 Terra、Sol/high 或 Sol/xhigh 起步；所有升级审核会重新审视原始目标、环境、场景、边界以及全部历史审核和修复，而不是只复述前一轮。`sol_max` 先做一次全局审核，失败后只允许一次受保护修复与新的 closure；closure 再有有效问题即进入用户范围决策阻塞，自动链终止，不会无限重审或静默关闭。只有质量门通过且证据仍与当前任务和工作区匹配时才能关闭。门级选择、审核升级和失败恢复规则见 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。

## 快速开始

先按 [`workflow-controller`](skills/workflow-controller/SKILL.md) 准备完整任务 manifest，并为任务固定一个 `state_dir`。新任务的清单结构、质量门评估和节点字段以该文档为准。

在插件目录运行：

```powershell
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" init --manifest .\task.json
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" ready --task-id payments-refactor
```

需要独立复核时可使用插件入口：

```powershell
node .\scripts\sol_review_cli.mjs -- <prompt>
```

CLI 会保存审查结果和受控日志；绑定工作流时使用控制器要求的同一结果制品完成收口。完整参数、总审绑定和验证流程见 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。

## 状态目录

每次新的 `workflow_init` 都要求 `state_dir` 位于目标工作区内，建议固定为 `<workspace>/.codex/workflow-controller/`；除该标准控制目录外，不得放在 `.git`、`node_modules`、`.venv` 等指纹排除目录中。工作区协调库为该目录下的 `workflow.sqlite`，每个 v3 任务状态为 `state_dir/<task_id>.sqlite`。`workflow_init` 是唯一允许创建工作区协调库的入口；创建前会扫描工作区中的现有 v3 任务状态及 SQLite/bootstrap 残留。已有任务后续遇到库缺失、损坏、路径替换或工作区不匹配会明确失败，不会通过更换 `state_dir` 静默重建并丢失互斥关系。新的 `workflow_init` 会删除已识别的旧 JSON 协调文件；它们不会被加载、迁移或执行。manifest、审核输入、checkpoint 与审查制品仍是外部 JSON/日志接口；它们不是控制器的协调状态。

控制器不是常驻服务，也不会在 heartbeat、claim 或 complete 等高频命令前隐式执行全局清理。需要维护保留周期时显式调用 `workflow_prune_expired`；该命令及隔离恢复会移动或删除跨任务制品，因此是少数会串行校验工作区 lease 的维护操作，普通任务状态更新只使用本任务 SQLite 事务。`workflow_doctor` 只检查状态和恢复前提，不替用户接管运行中的代理。未知或损坏状态不会静默删除，隔离和到期删除都必须经过控制器的保留周期。恢复、换绑和关卡失效处理见 [`workflow-controller`](skills/workflow-controller/SKILL.md)。

同一工作区可运行声明范围重叠的任务。清单必须提供非空 `workspace_claims`：`{mode:"read"|"write",prefix:"..."}` 数组；它是可申请写锁的不可变审计上界，而不是 `workflow_init` 时预占的锁，也不是文件系统 ACL。AI 仅在真正要改动文件前调用 `workflow_acquire_write_lock`，对最小实际相对路径申请短锁，并在该组写入完成后调用 `workflow_release_write_lock`；路径相同，或一方是另一方的祖先时才互斥。节点完成、放弃、救援或重排队会自动清理遗留锁。`workflow_status` 与 `workflow_stale` 会列出当前工作区的实际写锁；它们不会自动过期释放，协调者确认原执行者已停止后再使用相应的恢复或释放命令。末端审核仍须确认实际 diff 和产物仅落在 `write` claims。根目录 `write` 与根目录锁仅用于确实覆盖整个工作区的副作用，前者需 `global_write_justification`，后者需具体 `purpose`。扩大声明上界时，先确认旧执行者停止并释放其 entry，再用 claims 超集和新的 `task_id` 初始化替代任务。

## MCP

插件同时提供 `workflow-controller` MCP 服务。需要接入时使用插件自带的 `.mcp.json`；`workflow_init.manifest` 可直接传 v3 清单对象、内联 JSON 对象字符串或普通 JSON 文件路径，`state_dir` 必须为绝对路径。高频调度调用默认返回紧凑摘要，持续观察先从 `workflow_status` 取得 `cursor`，再用 `workflow_wait` 被动等待变化。排障或审计需要完整任务状态时使用 `workflow_status detail=full`。具体工具名称和输入字段以 MCP schema 与 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。
