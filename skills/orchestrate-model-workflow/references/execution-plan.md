# 执行计划模板

这是单次复杂任务的记录模板。路由与角色规则以 [SKILL.md](../SKILL.md) 为准；本模板不重复定义它们。

## 计划头

```markdown
# <任务名称> 计划

- 目标：<可观察结果>
- 授权：仅诊断 | 范围内实施
- 范围 / 非目标：<包含与明确排除项>
- 已知事实与产物：<证据、路径、当前状态>
- 约束与风险：<兼容、性能、外部影响与任务特有约束>
- 验收与验证：<完成条件、命令、人工路径>
- 停止条件：<何时升级、阻塞或要求补充信息>
```

## 阶段记录

```markdown
| work_id | 阶段 | agent_type | 依赖 | 输入/产物 | 所有权 | 验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <id> | 取证 / 定案 / 实施 / 预审 / 复审 / 验收 | <按 SKILL 路由> | <id 或无> | <引用> | <只读或目标> | <可判定条件> | not_started |
```

对每个并行 `WorkUnit` 记录其互补证据域、固定输入和新增价值。验收覆盖目标完成即停止；重复、矛盾或不可解释结果必须升级。并发 writer 必须有互斥目标；共享文件或状态由一个 owner 串行完成。

## HandoffPacket

```markdown
work_id: <稳定标识>
scope: <目标、范围与非目标>
execution_state: <规范化生命周期语义；原始 provider 状态可另附>
result_state: <规范化结果语义；原始 provider 状态可另附>
evidence: <相关文件、diff、验证输出>
next_action_or_blocker: <下游具体动作；无法继续时保留原始错误、已尝试操作和缺失条件>

# 仅恢复时添加；整个 WorkUnit 生命周期只能创建一次替代
parent_work_id: <直接父 WorkUnit；根任务为空>
depth: <由 parent_work_id 与 role hierarchy 推导>
agent_type: <实际 role>
instance_id: <运行实例；未知时明确未知>
failure_class: <规范化失败类别；原始 provider 错误可另附>
attempt: <本 WorkUnit 执行次数>
replacement_count: <0 或 1>
replacement_of: <无，或被替代实例的标识>
packet_revision: <单调版本>
last_observed_at: <最近核验时间>
checkpoint_ref: <恢复清单或状态提供者引用>
artifact_refs: <产物引用>
contract_ref: <ImplementationContract 引用；只读 WorkUnit 可为空>
settlement_state: <规范化收敛语义；原始 provider 状态可另附>

# 仅写入时添加
implementation_contract: <行为、允许目标与唯一所有权、不变量、验证和停止条件>
```

恢复时先检查实例和已有产物；失联或终止且工作未完成时，父任务至多创建一个替代实例。替代包包含原契约、当前 diff、验证输出、未完成项和 `replacement_of`。

## RecoveryManifest

仅当任务需要跨顶层重启恢复时创建。它是持久化状态索引，不是运行时队列；必须记录实际状态提供者，并用 `manifest_revision` 或等价原子 claim 防止重复替代。

```yaml
schema_version: <由状态提供者声明；不要在工作流中假设具体数字>
goal_id: <稳定目标标识>
run_id: <本次运行标识>
root_work_id: <根 WorkUnit>
manifest_revision: <单调版本>
persisted_at: <时间>
state_provider: <实际可读取的任务计划、工作区状态或其他已授权提供者>
goal_state: <规范化目标语义；由状态提供者映射>
recovery_state: <规范化恢复语义；由状态提供者映射>
children:
  - work_id: <子 WorkUnit>
    parent_work_id: <直接父 WorkUnit>
    depth: <由 parent_work_id 与 role hierarchy 推导>
    agent_type: <实际 role>
    instance_id: <实例>
    execution_state: <规范化生命周期语义>
    result_state: <规范化结果语义>
    failure_class: <规范化失败类别>
    replacement_count: <0 / 1>
    replacement_of: <实例或 null>
    packet_revision: <单调版本>
    last_observed_at: <时间>
    checkpoint_ref: <引用>
    settlement_state: <规范化收敛语义>
```

主控恢复时只处理直接一级子任务；一级 owner 负责自己的直接二级子树。没有 `state_provider`、无法校验版本或 claim 失败时，记录 `PERSISTENCE_UNAVAILABLE`/原始错误，将 `recovery_state` 设为 `recovery_required` 或 `runtime_wait`，结束当前轮次并保持 goal active；不得继续重复测试或审计。若 host 提供顶层任务创建或 fork controller，则由它带清单创建替代主任务。

## 关闭检查

- [ ] 实际路由只使用已安装 profile 的 `agent_type`；没有覆盖模型或 reasoning effort。
- [ ] 下游收到最小充分任务包与必要产物；没有默认传递完整历史。
- [ ] 子任务终态已被消费；未完成工作已继续路由、替代一次或报告实际阻塞。
- [ ] 运行时投递或唤醒失败保持 goal active；没有因旧 writer 无法响应而过早 `blocked`，也没有重复创建替代实例。
- [ ] 重启恢复使用可读取的 `RecoveryManifest`；根主控不越级替代 Luna，Terra 只替代直接 Luna，且每个 WorkUnit 最多替代一次。
- [ ] `PERSISTENCE_UNAVAILABLE` 或 writer 委派通道缺失时只盘点一次并结束当前轮次；`recovery_required/runtime_wait` 不触发重复只读循环。
- [ ] 影响判断、行动或关闭的上游主张已独立核验；不成立或证据不足时已明确回到补证，而非形成契约或关闭任务。
- [ ] 每个一级 workspace 写入、修复和集成由 `avsp_terra_high` 负责；它优先把已完成设计、所有权明确且可验证的 `ImplementationContract` 直接委派给二级 Luna writer，代码类型不是限制，父 Terra 已审核实际 diff 与验证结果。
- [ ] 独立复审与最终验收按风险完成；仅当纯机械、低风险且所有 guards 通过时，使用新的 Luna 加机器证据闭环，其他语义或中高影响路径使用新的 `avsp_terra_xhigh` work unit。
- [ ] 记录实际验证、guards 结果、未覆盖行为、待决事项、升级原因与残余风险。
