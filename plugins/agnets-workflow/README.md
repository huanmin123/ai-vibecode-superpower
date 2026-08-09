# Agnets 工作流

`agnets-workflow` 为 Codex 提供统一的多代理工作流、项目工具链和持久化任务状态。它适合需要并行执行、可恢复交接和独立总审的复杂开发任务。

## 能力

- 用任务 DAG 管理实现、验证和总审节点。
- 持久化任务状态、节点产物、参与者、审核记录和工作区租约。
- 在控制器被再次调用时惰性清理过期状态；完整已关闭任务按 7 天处理，未知或无法验证的状态先隔离 30 天，隔离后再保留 365 天。
- 通过 MCP 或本地 CLI 提供初始化、派发、心跳、checkpoint、恢复、总审和关闭检查。

工作流路由、角色边界、交接、恢复和总审升级规则以 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md) 为准；控制器命令和持久化约束以 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。

## 快速开始

在目标工作区准备一个 manifest：

```json
{
  "task_id": "payments-refactor",
  "workspace": "F:\\work\\payments",
  "goal": "完成支付重构并保持现有行为",
  "routing_schema_version": 1,
  "requirements": [
    { "id": "R1", "text": "迁移支付路由" },
    { "id": "R2", "text": "现有测试通过" }
  ],
  "nodes": [
    {
      "id": "evidence",
      "kind": "verification",
      "execution_risk": "read_only",
      "routing_reason": "独立只读取证",
      "execution_owner": "/root/payments_evidence",
      "integration_owner": "/root",
      "quality_guard": "核对证据"
    },
    {
      "id": "implementation",
      "kind": "implementation",
      "depends_on": ["evidence"],
      "execution_risk": "delegable",
      "routing_reason": "范围互斥且可回滚",
      "execution_owner": "/root/payments_implementation",
      "integration_owner": "/root",
      "quality_guard": "核对 diff 和测试"
    },
    {
      "id": "total-review",
      "kind": "total_review",
      "depends_on": ["evidence", "implementation"],
      "execution_risk": "protected",
      "routing_reason": "任务级独立总验收",
      "execution_owner": "/root/payments_review",
      "integration_owner": "/root",
      "quality_guard": "核对需求和回归"
    }
  ]
}
```

`routing_schema_version=1` 清单可省略 `agent_type`，由控制器按节点风险应用默认路由。`execution_owner` 必须对应实际原生任务路径；例如 `task_name=payments_evidence` 对应 `/root/payments_evidence`。

在插件目录运行：

```powershell
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" init --manifest .\task.json
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" ready --task-id payments-refactor
```

独立 Sol 复核可用以下入口启动：

```powershell
node .\scripts\sol_review_cli.mjs --review-role avsp_sol_high -- <prompt>
```

CLI 会保存审查结果和受控日志；绑定工作流时使用控制器要求的同一结果制品完成收口。完整参数、总审绑定和验证流程见 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。

## 状态目录

建议将 `state_dir` 设为目标工作区的 `.codex/workflow-controller/`。状态库、租约、checkpoint 和审查制品属于控制数据，不应纳入业务改动或工作区指纹。

控制器不是常驻服务，清理只会在后续控制器调用时触发。`workflow_doctor` 可检查状态和恢复前提；它不会替用户接管运行中的代理。未知或损坏状态不会静默删除，隔离和到期删除都必须经过控制器的保留周期。

## MCP

插件同时提供 `workflow-controller` MCP 服务。需要接入时使用插件自带的 `.mcp.json`；高频调度调用默认返回紧凑摘要，持续观察先从 `workflow_status` 取得 `cursor`，再用 `workflow_wait` 被动等待变化。排障或审计需要完整任务状态时使用 `workflow_status detail=full`。具体工具名称和输入字段以 MCP schema 与 [`workflow-controller`](skills/workflow-controller/SKILL.md) 为准。
