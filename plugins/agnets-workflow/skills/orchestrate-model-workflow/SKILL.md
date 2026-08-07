---
name: orchestrate-model-workflow
description: "为任何状态变更、无法证明纯只读，或需要持久控制、恢复与任务级总审的任务建立契约、执行分流和验收闭环。"
---

# 状态变更工作流

先阅读 [workflow-common.md](../workflow-common.md)。任何状态变更、无法证明纯只读、可能产生持久产物，或需要持久任务控制、恢复或任务级总审时使用本 skill。整个任务可证明纯只读时改用 `$orchestrate-read-workflow`；两条工作流互斥。

仅在创建或恢复边界调用一次幂等 `workflow_ensure_context`：`new` 才初始化，`active` 继续，`blocked` 保留原始错误并停止。前序任务上下文不足时先在本 skill 内只读盘点；恢复证据不能重建任务身份、目标和授权，就在写入前停止，而不是退回无工作流状态。session、mailbox、运行回合和 wait 状态不可假定能恢复；缺少实际可用的原生恢复接口时，以当前工作区、控制器状态和 checkpoint 创建新实例，不得声称恢复旧会话。只有需要持久 DAG、恢复或强制总审记录时，阅读并使用 [workflow-controller](../workflow-controller/SKILL.md)；控制器协议以该 skill 及其直接 reference 为唯一权威。

## 必经主线

1. 先取得足以定案的证据。为每个写入任务创建完整 `execution_contract`：目标行为、允许目标与非目标、授权、已定步骤、不变量、领域边界/精度、失败语义、回滚或恢复、验证和停止条件；同时唯一明确 `execution_owner`、`integration_owner`、`quality_guard`、`execution_risk` 与 `routing_reason`。模板见 [execution-plan.md](references/execution-plan.md)。
2. 只有影响、回滚、外部副作用、共享状态和验证均受控时才为 `delegable`；其他写入为 `protected`，由 `avsp_terra_high` 执行和集成。共享文件、数据或外部状态必须串行。`delegable` 的唯一执行者可由 main/root 或 Terra 直接委派 `avsp_luna_high_executor`；仅需显著更深局部理解时使用 `avsp_luna_xhigh_executor` 并在 `routing_reason` 记录理由。executor 为叶节点；缺失或冲突字段一律 `protected`。
3. 委派使用自包含消息和显式 `fork_turns="none"`；`fork_turns="all"` 仅限不传自定义 `agent_type` 的 full-history fork。工具投递、触发、等待或中断返回不代表实例已开始、停止或完成。执行后由 `integration_owner` 核验真实终态、diff、产物和验证输出；普通失败形成新完整契约后重新分流，接管前确认旧实例不再写入。
4. 所有状态变更完成验证后，main/root 新建此前未参与任务的独立 Sol 做总验收。总审核验目标、需求、范围、契约、实际改动、验证、回归风险和缺口；只有可核验 `pass` 才能关闭。`fail` 或 `unavailable` 不得关闭，修复或补证后用另一独立 Sol 重审。仅所选 Sol role 或 model 实际不可用时，才可由此前未参与的 `avsp_terra_xhigh_readonly` 兜底，并披露独立性下降。
