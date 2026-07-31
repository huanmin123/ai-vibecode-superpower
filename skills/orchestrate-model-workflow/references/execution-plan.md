# 执行计划模板

复杂任务可使用此模板；仓库提供允许的持久计划位置时，将其存入该位置。否则把同样字段记录到任务清单和目标状态，不得为了套用模板创建被忽略的临时目录。

所有委派使用命名 `agent_type`。模型与推理强度由 role 固定，调用 `spawn_agent` 时只传 `agent_type`，且使用 `fork_turns="none"` 或有限正数轮次；不得传 `model` 或 `reasoning_effort`，也不得传递完整历史。任何 Terra 写入前，对本任务后续必需 role 执行无写入 runtime preflight，并记录固定 role、模型/推理强度、未写入确认和可用时的 effective sandbox；任何必需 role 不可用都在写入前停止。Luna role 只读探路与预审，Sol role 独立判断与完整复审，Terra/high 写入实施，可写 Terra/xhigh 仅修复已确认问题。仅当 `avsp_luna_high` 或 `avsp_luna_xhigh` 经能力检查确认不可用时，才分别使用只读的 `avsp_terra_low_readonly` 或 `avsp_terra_medium_readonly`。只有 Sol 调用返回对应 `gpt-5.6-sol` 的结构化 `unsupported_model` 或 `model_not_found` 时，才使用只读 `avsp_terra_xhigh_readonly` 替代同一 Sol 阶段；认证、限流、网络、超时、参数/schema 和未知错误均停止。所有 fallback 不得写入；其他任何 role 不可用都记录 `MODEL_UNAVAILABLE` 并停止。

## 计划头

```markdown
# <任务名称> 计划

- 目标：<可衡量结果>
- 授权：仅诊断 | 实施 | 已取得破坏性操作授权
- 范围：<包含的系统/文件>
- 非目标：<明确排除项>
- 背景与依据：<相关上下文、已确认事实和关键证据>
- 硬约束：<安全、兼容、性能、授权、时间或环境边界>
- 风险：低 | 中 | 高
- 回滚：<恢复方式或不适用>
- 验收：<可观察完成标准>
- 验证：<必需命令、检查或人工路径>
- 输出：<用户需要的交付物和应报告的证据>
- 停止条件：<何时停止、升级或要求补充信息>
```

## 阶段清单

```markdown
| 阶段 | 负责人 | agent_type（固定模型 / 推理强度） | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 分类 | 协调者 | 按主 skill 路由 | 无 | in_progress | |
| 探索 | 先锋 | `avsp_luna_high`（`gpt-5.6-luna` / `high`）；仅不可用时 `avsp_terra_low_readonly`（`gpt-5.6-terra` / `low`） | 分类 | pending | 事实/证据/风险 |
| 复杂探索 | 先锋 | `avsp_luna_xhigh`（`gpt-5.6-luna` / `xhigh`）；仅不可用时 `avsp_terra_medium_readonly`（`gpt-5.6-terra` / `medium`） | 分类 | conditional | 事实/证据/风险 |
| Luna/high fallback | 只读先锋 | `avsp_terra_low_readonly`（`gpt-5.6-terra` / `low`） | `avsp_luna_high` 已确认不可用 | conditional | 仅探索/预审；不写入，不替代 Sol |
| Luna/xhigh fallback | 只读先锋 | `avsp_terra_medium_readonly`（`gpt-5.6-terra` / `medium`） | `avsp_luna_xhigh` 已确认不可用 | conditional | 仅探索/预审；不写入，不替代 Sol |
| Sol fallback | 只读复审者 | `avsp_terra_xhigh_readonly`（`gpt-5.6-terra` / `xhigh`） | 原 Sol role 已通过本地检查，且上游对 `gpt-5.6-sol` 返回结构化 `unsupported_model` 或 `model_not_found` | conditional | 同一只读阶段；记录错误与独立性降级 |
| 汇总定案 | 架构者 | `avsp_sol_high`（`gpt-5.6-sol` / `high`） | 探索 | pending | 设计契约 |
| 实现 | 实施者 | `avsp_terra_high`（`gpt-5.6-terra` / `high`） | 已验收设计 | pending | diff/tests |
| 首次复审预审 | Luna 预审者 | `avsp_luna_high` 或复杂时 `avsp_luna_xhigh`；仅目标 Luna 不可用时使用对应 fallback | 实现 | pending | 待核实线索/无发现报告 |
| 复审 1 | Sol 正式复审者 | `avsp_sol_high`（`gpt-5.6-sol` / `high`） | 实现与预审输出 | pending | 独立复审结论 |
| 修复 1 | 修复者 | `avsp_terra_xhigh`（`gpt-5.6-terra` / `xhigh`） | 复审 1 的确认问题 | conditional | 问题 ID、diff/tests |
| 复审 2 | Sol 验证者 | `avsp_sol_high`，或规定条件下 `avsp_terra_xhigh_readonly` | 修复 1 | conditional | 独立结论 |
| 修复 2 | 修复者 | `avsp_terra_xhigh`（`gpt-5.6-terra` / `xhigh`） | 复审 2 的确认问题 | conditional | 问题 ID、diff/tests |
| 复审 3 | Sol 验证者 | `avsp_sol_high`，或规定条件下 `avsp_terra_xhigh_readonly` | 修复 2 | conditional | 最终结论 |
| 升级分析/设计 | 架构者 | `avsp_sol_xhigh`，或规定条件下 `avsp_terra_xhigh_readonly` | 复审 3 仍有重要问题 | conditional | 修订设计 |
| 升级实现 | 实施者 | `avsp_terra_xhigh`（`gpt-5.6-terra` / `xhigh`） | 已验收修订设计 | conditional | diff/tests |
| 升级验证 | 验证者 | `avsp_sol_high`（`gpt-5.6-sol` / `high`），或规定条件下 `avsp_terra_xhigh_readonly` | 升级实现 | conditional | 最终结论 |
```

首次复审干净后跳过两轮修复；复审 2 干净后跳过修复 2 和复审 3。每轮修复都记录确认问题 ID、当前 diff、受影响测试和新的独立 reviewer。实际路由不同于计划时，记录实际 `agent_type`、能力检查和 `MODEL_UNAVAILABLE` 证据。只有对应 Luna profile 已确认不可用时，实际路由才可切换到其一对一只读 fallback；Sol 仅可因规定的结构化模型不支持错误切换到只读 Terra/xhigh fallback。

## 检查清单

### 设计

- [ ] 用户意图和写入授权清楚。
- [ ] 已检查仓库规则与既有模式。
- [ ] 事实、推断和未知项分离。
- [ ] 范围与非目标阻止无关修改。
- [ ] 已记录替代方案、重要取舍、高风险模拟和回滚。
- [ ] 验收标准与验证命令可衡量。
- [ ] 所有权边界支持安全委派。

### 实现与复审

- [ ] 委派调用只传目标 `agent_type`，并传受限 `fork_turns`。
- [ ] Terra 写入前已完成本任务必需 role 的无写入 runtime preflight；失败 role 已在写入前停止，并记录固定模型、未写入确认和可用时的 effective sandbox。
- [ ] Luna 不可用时只使用一对一只读 fallback；Sol 仅在结构化模型不支持错误时使用只读 Terra/xhigh fallback；所有 fallback 不写入，其他 role 不可用则记录 `MODEL_UNAVAILABLE`。
- [ ] 执行者收到自包含契约、任务状态或持久产物引用，以及验证要求。
- [ ] 改动保持在范围和既有架构内，并按比例处理边界、错误、并发和安全。
- [ ] 测试覆盖改动及重要回归，必要文档已同步。
- [ ] Sol 复审者检查实际 diff 和当前文件；问题含严重度、证据和精确位置。
- [ ] 修复后进行了新的独立复审；每次低风险确定性执行都有主 skill 要求的独立复审。

## 完成记录

```markdown
## 完成

- 实际路由：<阶段 -> agent_type>
- 能力检查：<每个目标 role 的检查证据>
- 模型错误：<无，或 MODEL_UNAVAILABLE 的阶段、agent_type、固定模型/推理强度和证据>
- 验证：<命令和结果>
- 复审结论：干净 | 存在残余问题
- 残余风险：<具体缺口>
- 目标状态：complete | blocked
```
