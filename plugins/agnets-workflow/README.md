# Agnets 工作流

`agnets-workflow` 是给 Codex 使用的统一工作流插件。它包含多代理编排、CodeGraph/RTK 工具链，以及将任务 DAG、子任务产物、参与者和总审记录保存到工作区的本地状态控制器。

## 解决的问题

- `workflow_ready` 返回所有依赖已满足的节点，main/root 可以一次并行派发它们，而不是顺序等待。
- 每个节点完成后都记录结构化产物；`workflow_audit_context` 汇集目标、需求、范围、节点结果、当前工作区指纹和 `workflow_snapshot`，作为独立 Sol 总审的输入。
- `workflow_close_check` 只在全部工作节点完成、唯一独立 Sol 总审为 `pass`、总审快照和工作区均未变化时允许关闭，并在通过时释放该工作区的活动任务租约。

控制器不创建、停止或直接通信 Codex 子代理。main/root 仍须使用原生 `spawn_agent`、`send_message`、`wait_agent` 和 `interrupt_agent`，并遵守 `orchestrate-model-workflow` 的 role 拓扑。

## 状态与清理

每次控制器调用都必须传入同一个绝对 `state_dir`，推荐目标工作区的 `.codex/workflow-controller/`。任务主体保存在 `<task_id>.sqlite`；旧版 `<task_id>.json` 会在首次成功写入 SQLite 后保留为 `<task_id>.json.legacy` 恢复副本。该目录属于控制数据，不应纳入业务改动或总审的工作区指纹。`workflow_doctor` 可只读检查状态库、工作区租约、协调文件、过期节点和受控重派前提；省略 `task_id` 时会列出错误隔离项和孤立 legacy 副本。它不会删除、修复或接管状态。

连续 7 天没有状态更新、租约已释放且不存在运行节点的完整任务状态，会在下一次该 `state_dir` 的非只读控制器操作时删除，关联的 `.workflow-review-results/<task_id>/` 也会一起删除。未知、legacy 或无法验证租约的状态连续 30 天后，会先移入 `state_dir/.workflow-errors/<id>/`；其中的 `quarantine.json` 与独立的 `.quarantine-expiry.json` 记录原因、原路径、review 证据和删除时间，隔离内容保留 365 天后才会在后续清理中删除。主隔离元数据损坏但到期凭证和内容仍完整时，仍可安全到期删除。`workflow_reconcile_quarantine` 会幂等补齐中断的隔离传输，不删除未知文件。`workflow_doctor` 指定 `task_id` 时返回单项隔离位置，省略 `task_id` 时列出全部隔离项、孤立 legacy 副本与最近一次惰性清理摘要。控制器不是常驻服务，因此没有任何调用时不会在第 7、30 或 365 天整点自行运行。

控制器会在目标工作区的 `.codex/workflow-controller/workspace-lease.json` 保留活动任务租约。因此多个不同工作区可并行，而同一工作区即使使用不同状态目录也只能有一个活动工作流。运行中的代理应定期写入 `workflow_checkpoint`，保存完成步骤、下一步、证据和阻塞。会话或进程中断后，协调者先检查实际代理、diff 和产物；只有确认旧代理已停止，才能调用 `workflow_requeue_stale` 原子保存旧 attempt/checkpoint、取得恢复包并派发新代理。若当前 Codex 运行时实际暴露 `resume_agent` 且 claim 保存了原生 `agent_thread_id`，协调者可优先恢复原代理会话；控制器本身不能读取或调用 Codex 的内部 session/rollout。确认没有旧代理仍在写入后，才能用 `workflow_release_workspace` 释放中断任务的租约。

初始化在状态文件和租约之间使用持久阶段标记。若进程在 `workflow_init` 返回前中断，先调用 `workflow_reconcile_workspace`：它只会激活与租约一致的已有状态，或清理确认不存在状态的初始化登记，不会猜测或接管未知任务。租约释放后，旧任务不能再写入任何 DAG 状态。

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
  "routing_schema_version": 1,
  "nodes": [
    {
      "id": "implementation",
      "kind": "implementation",
      "agent_type": "avsp_luna_high_executor",
      "execution_risk": "delegable",
      "routing_reason": "影响局限于支付路由；可回滚且已有定向测试",
      "execution_owner": "/root/payments-executor",
      "integration_owner": "/root",
      "quality_guard": "支付路由测试与独立 Sol 总审"
    },
    {
      "id": "verification",
      "kind": "verification",
      "depends_on": ["implementation"],
      "execution_risk": "protected",
      "routing_reason": "只读验证由 root 协调",
      "execution_owner": "/root/verification",
      "integration_owner": "/root",
      "quality_guard": "独立 Sol 总审"
    },
    {
      "id": "total-review",
      "kind": "total_review",
      "agent_type": "avsp_sol_high",
      "depends_on": ["implementation", "verification"],
      "execution_risk": "protected",
      "routing_reason": "独立只读总审必须等待全部工作节点完成",
      "execution_owner": "/root/payments-total-review",
      "integration_owner": "/root",
      "quality_guard": "任务关闭关卡"
    }
  ]
}
```

`routing_schema_version=1` 要求每个节点记录 `execution_risk`、`routing_reason`、`execution_owner`、`integration_owner` 与 `quality_guard`。没有该版本标记的旧清单仍可读取，但控制器会写入明确的 legacy/protected 路由，且禁止 Luna executor 认领，不能把缺失字段默认为可委派。

Windows 上也可以直接使用 CLI：

```powershell
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" init --manifest .\task.json
node .\scripts\workflow_controller.mjs --state-dir "$pwd\.codex\workflow-controller" ready --task-id payments-refactor
```

Windows 的独立 Sol CLI 总审通过包装器运行：`node .\scripts\sol_review_cli.mjs -- <prompt>`。它显式继承或解析当前账户的 `CODEX_HOME` 并传给子 `codex exec --model gpt-5.6-sol --sandbox read-only`。`--timeout-sec <1..7200>` 默认是软截止：到点只记录 `deadline_reached` 并提示，Sol 继续运行直到自己退出，不会因为到达该时间被限制；因此默认不会自动终止长复审。只有显式传入 `--hard-timeout-sec <1..7200>` 才启用强制终止，终止后最多再等待 15 秒确认进程退出。工作流总审应额外传入 `--workflow-state-dir`、`--workflow-task-id`、`--workflow-node-id` 和 `--workflow-claim-id`：包装器会把有界 stdout/stderr 与 PID、退出码、软截止、硬截止和终止确认写入固定的 `state_dir/.workflow-review-results/<task_id>/<claim_id>/outcome.json`，并拒绝覆盖其他 task/claim 的结果。Windows `.cmd/.bat` 通过固定 PowerShell 参数数组调用，提示词不会拼进 shell 源码；提示词作为 `--` 后的单一位置参数传入。子进程非零退出，或显式硬截止后已确认退出时，包装器只会将该 claim 收为 `unavailable`；仅到达软截止不会改变运行中的 claim 状态，也不会自动重试。随后仍必须确认旧代理停止、创建新的独立总审实例并调用 `workflow_retry`。成功的总审仍须由审核代理调用 `workflow_record_review` 和 `workflow_complete`。仅当 `.sandbox/deny_read_acl_state.json` 不能解析为 JSON 时，才并发安全地备份为 `.corrupt-*` 并重建 `{ "principals": {} }`；其他 Codex CLI 失败不会被清空或降级。

新任务的 DAG 在 `workflow_init` 后不可追加，并且必须包含唯一的 `total_review` 汇点；该节点直接依赖所有其他节点，其他节点不得依赖它。总审 JSON 除已有字段外必须回填 `workflow_audit_context` 返回的 `workflow_snapshot`。任何非总审节点的结果、状态或重试发生变化都会使旧总审失效，必须新建独立总审。

插件的 MCP 工具提供相同的 `workflow_init`、`workflow_reconcile_workspace`、`workflow_ready`、`workflow_claim`、`workflow_start`、`workflow_heartbeat`、`workflow_checkpoint`、`workflow_complete`、`workflow_abandon`、`workflow_retry`、`workflow_requeue_stale`、`workflow_rescue`、`workflow_recover_lock`、`workflow_audit_context`、`workflow_record_review`、`workflow_close_check`、`workflow_release_workspace`、`workflow_stale`、`workflow_status`、`workflow_doctor`、`workflow_reconcile_quarantine` 和 `workflow_prune_expired` 操作。新派发优先使用 `workflow_start`，它在一次状态提交中完成认领和首个激活心跳，避免启动竞态；`workflow_claim` 返回 `claim_id`，完成、心跳、checkpoint、放弃与总审记录必须携带该值。`workflow_checkpoint` 同时刷新节点租约心跳。`agent_thread_id` 只在宿主确实提供时保存，不能由 `agent_task_path` 推导。总审记录还会校验它属于同路径、同角色的运行中 `total_review` 节点。`workflow_requeue_stale` 还要求当前 claim 确已过期和 `previous_agent_stopped=true`，它保存旧 attempt/checkpoint 并返回给替代代理的恢复包，但不伪装为原会话恢复。Luna 停止后若 Root 必须接管，必须调用 `workflow_rescue` 并以 `main/root` 重新启动，状态会保留原 Luna attempt 和救援原因。陈旧锁、写入意图和恢复保护只会在同主机、创建时间可解析且与文件时间一致、超过阈值、原 PID 不存在且文件身份在归档前未变化时归档；其他情况明确报错，不会冒险移除。

为防止长任务无限膨胀，清单最多 64 个节点和 64 条需求，每个节点最多 8 次尝试；结构化节点结果上限 64 KiB、审核上限 128 KiB。大日志或完整测试输出应放在外部制品中，结果 JSON 只保留路径、摘要和关键结论。指纹以流式方式覆盖源码、配置、锁文件和构建输出，排除 `.git`、`.codex`、`node_modules`、`.venv`、`.yarn` 与 `.yarn-cache*`；后两类为派生下载缓存。遇到符号链接、持续变化的工作区或超过容量上限时明确失败，不能把失败当作通过。

## MCP 启动时限

`workflow-controller` 的 `.mcp.json` 将 `startup_timeout_sec` 设为 120 秒。此时限同时覆盖 MCP `initialize` 和连接后的首次 `tools/list`，不适用于后续 `tools/call` 工具调用。

节点默认激活窗口为 600 秒（10 分钟），租约默认 1,800 秒；新派发应使用 `workflow_start` 原子完成激活，长任务通过 `workflow_heartbeat` 或 `workflow_checkpoint` 续租。两者都不是任务总运行时限。

## 安全边界

`agent_task_path` 由调用方提供，控制器只能用它检查同一任务内的参与者是否被复用，不能把它当作身份认证。`claim_id` 仅保护节点生命周期操作不被误用，也不能替代身份认证。真正的发布、部署、数据库或外部 API 权限，应继续由 Git/CI 或受控 MCP 工具持有；不要把高权限凭据直接交给普通 agent shell。
