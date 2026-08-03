# Agnets 工作流

`agnets-workflow` 是给 Codex 使用的统一工作流插件。它包含多代理编排、项目文档规划、GPT Image 2 CLI、CodeGraph/RTK 工具链，以及将任务 DAG、子任务产物、参与者和总审记录保存到工作区的本地状态控制器。

## 解决的问题

- `workflow_ready` 返回所有依赖已满足的节点，main/root 可以一次并行派发它们，而不是顺序等待。
- 每个节点完成后都记录结构化产物；`workflow_audit_context` 汇集目标、需求、范围、节点结果和当前工作区指纹，作为独立 Sol 总审的输入。
- `workflow_close_check` 只在全部节点完成、独立总审为 `pass` 且工作区未在总审后改变时允许关闭。

控制器不创建、停止或直接通信 Codex 子代理。main/root 仍须使用原生 `spawn_agent`、`send_message`、`wait_agent` 和 `interrupt_agent`，并遵守 `orchestrate-model-workflow` 的 role 拓扑。

## 状态与清理

默认状态目录是目标工作区的 `.codex/workflow-controller/`。该目录属于控制数据，不应纳入业务改动或总审的工作区指纹；任务关闭后可按项目保留策略归档或删除。

每个任务先创建 manifest：

```json
{
  "task_id": "payments-refactor",
  "workspace": "F:\\work\\payments",
  "goal": "完成支付重构并保持现有行为",
  "requirements": [
    { "id": "R1", "text": "迁移支付路由" },
    { "id": "R2", "text": "现有测试通过" }
  ],
  "scope": ["src/payments"],
  "non_goals": ["修改结算协议"],
  "nodes": [
    { "id": "implementation", "kind": "implementation", "agent_type": "avsp_terra_high" },
    { "id": "verification", "kind": "verification", "depends_on": ["implementation"] }
  ]
}
```

Windows 上也可以直接使用 CLI：

```powershell
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" init --manifest .\task.json
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" ready --task-id payments-refactor
```

插件的 MCP 工具提供相同的 `workflow_init`、`workflow_ready`、`workflow_claim`、`workflow_heartbeat`、`workflow_complete`、`workflow_abandon`、`workflow_retry`、`workflow_recover_lock`、`workflow_audit_context`、`workflow_record_review`、`workflow_close_check` 和 `workflow_status` 操作。`workflow_claim` 返回 `claim_id`；完成、心跳、放弃与总审记录必须携带该值。总审记录还会校验它属于同路径、同角色的运行中 `total_review` 节点。`abandoned` 只能通过 `workflow_abandon` 写入，以保留停止确认和审计原因；重试前调用方必须先实际确认旧执行者已停止。陈旧锁恢复会串行化；已有恢复操作时会明确报错而不冒险移动锁文件。

## MCP 启动时限

`workflow-controller` 的 `.mcp.json` 将 `startup_timeout_sec` 设为 120 秒。此时限同时覆盖 MCP `initialize` 和连接后的首次 `tools/list`，不适用于后续 `tools/call` 工具调用。

## 安全边界

`agent_task_path` 由调用方提供，控制器只能用它检查同一任务内的参与者是否被复用，不能把它当作身份认证。`claim_id` 仅保护节点生命周期操作不被误用，也不能替代身份认证。真正的发布、部署、数据库或外部 API 权限，应继续由 Git/CI 或受控 MCP 工具持有；不要把高权限凭据直接交给普通 agent shell。
