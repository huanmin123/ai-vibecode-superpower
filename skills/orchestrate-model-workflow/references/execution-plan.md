# 执行计划模板

这是单次复杂任务的记录模板。路由与角色规则以 [SKILL.md](../SKILL.md) 为准；本模板不重复定义它们。

## 计划头

```markdown
# <任务名称> 计划

- 目标：<可观察结果>
- 授权：仅诊断 | 实施 | 已取得破坏性操作授权
- 范围 / 非目标：<包含与明确排除项>
- 已知事实与产物：<证据、路径、当前状态>
- 约束与风险：<安全、兼容、权限、性能、外部影响、回滚>
- 验收与验证：<完成条件、命令、人工路径>
- 停止条件：<何时升级、阻塞或要求补充信息>
```

## 阶段记录

```markdown
| work_id | 阶段 | agent_type | 依赖 | 输入/产物 | 所有权 | 验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <id> | 取证 / 定案 / 实施 / 预审 / 复审 / 验收 | <按 SKILL 路由> | <id 或无> | <引用> | <只读或目标> | <可判定条件> | pending |
```

对每个并行 `WorkUnit` 记录其互补证据域、固定输入和新增价值。验收覆盖目标完成即停止；重复、矛盾或不可解释结果必须升级。并发 writer 必须有互斥目标；共享文件或状态由一个 owner 串行完成。

## HandoffPacket

```markdown
work_id: <稳定标识>
objective_and_scope: <目标、范围与非目标>
status: <完成 / 阻塞 / 需要升级>
inputs_and_artifacts: <输入状态、文件或产物引用>
results_and_evidence: <可验证结果、命令与证据位置>
guard_results: <ImplementationContract 与实际 diff/输入状态哈希、唯一所有权、不变量、确定性检查、可重建生成物与 Luna 一致性>
uncovered_behaviors: <尚未被测试或 guard 覆盖的行为；无则明确写无>
escalation_reason: <升级、未升级或不适用的原因>
risks_and_unknowns: <剩余风险、假设与未知项>
next_request: <下游应执行的具体动作>

# 仅写入或并发时添加
input_state_hash: <固定输入与基线状态哈希>
implementation_contract: <已定行为、允许目标与唯一所有权、不变量/顺序约束、适用的领域边界/精度/失败语义、示例、验证与停止条件>
dependencies: <依赖 work_id>
ownership: <允许目标或写入所有权>
acceptance_and_stop: <验收与停止条件>
integration_owner: <负责汇总实际结果的 Terra>
```

## 关闭检查

- [ ] 实际路由只使用已安装 profile 的 `agent_type`；没有覆盖模型或 reasoning effort。
- [ ] 下游收到最小充分任务包与必要产物；没有默认传递完整历史。
- [ ] 每个一级 workspace 写入、修复和集成由 `avsp_terra_high` 负责；它优先把已完成设计、所有权明确且可验证的 `ImplementationContract` 直接委派给二级 Luna writer，代码类型不是限制，父 Terra 已审核实际 diff 与验证结果。
- [ ] 独立复审与最终验收按风险完成；仅当纯机械、低风险且所有 guards 通过时，使用新的 Luna 加机器证据闭环，其他语义或中高影响路径使用新的 `avsp_terra_xhigh` work unit。
- [ ] 记录实际验证、guards 结果、未覆盖行为、确认问题、升级原因、修复轮次、fallback（如有）与残余风险。
