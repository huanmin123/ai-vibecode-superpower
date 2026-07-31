# 工作流设计契约

## 目标

以命名 agent role 固定每个阶段的模型、推理强度与读写边界，在不削弱设计质量和独立验证的前提下控制成本。协调者负责用户意图、产物、依赖、集成和完成判断；执行者只拥有受限阶段输出。

## 角色职责

| 阶段 | `agent_type` | 固定模型 / 推理强度 | 读写边界 |
| --- | --- | --- | --- |
| 先锋探索与预审 | `avsp_luna_high` | `gpt-5.6-luna` / `high` | 只读，只报告事实、证据与待核实问题 |
| 复杂探索与预审 | `avsp_luna_xhigh` | `gpt-5.6-luna` / `xhigh` | 只读，只报告事实、证据与待核实问题 |
| Luna/high 不可用时的唯一 fallback | `avsp_terra_low_readonly` | `gpt-5.6-terra` / `low` | 仅替代 `avsp_luna_high` 的只读探索与预审；不可写入，不可替代 Sol |
| Luna/xhigh 不可用时的唯一 fallback | `avsp_terra_medium_readonly` | `gpt-5.6-terra` / `medium` | 仅替代 `avsp_luna_xhigh` 的只读探索与预审；不可写入，不可替代 Sol |
| 汇总、设计、正式复审与验证 | `avsp_sol_high` | `gpt-5.6-sol` / `high` | 只读，独立判断与完整复审 |
| 升级调查与重新设计 | `avsp_sol_xhigh` | `gpt-5.6-sol` / `xhigh` | 只读，重新调查根因 |
| Sol 模型不受上游支持时的唯一 fallback | `avsp_terra_xhigh_readonly` | `gpt-5.6-terra` / `xhigh` | 仅替代同一 Sol 只读阶段；不可写入，必须披露独立性降级 |
| 常规实施 | `avsp_terra_high` | `gpt-5.6-terra` / `high` | 在授权范围内写入 |
| 已确认问题修复 | `avsp_terra_xhigh` | `gpt-5.6-terra` / `xhigh` | 只修复已确认问题 |

```text
Luna 并行探路（`avsp_luna_high` 不可用仅映射至 `avsp_terra_low_readonly`；`avsp_luna_xhigh` 不可用仅映射至 `avsp_terra_medium_readonly`）
  -> Sol 汇总与定案
  -> 仅 Sol 收到结构化模型不支持错误：只读 Terra/xhigh 汇总并披露独立性降级
  -> Terra/high 写入实施
  -> Luna 多路预审（同样只读替代规则）
  -> Sol/high 独立正式复审
  -> 有确认问题：Terra/xhigh 修复 -> Sol/high 再复审
  -> 必要升级：Sol/xhigh 重新设计 -> Terra/xhigh 实现 -> Sol/high 验证
```

## 设计决定

### 通过 role 切换模型

不要假设运行中的 agent 能改变模型或推理强度。委派前验证目标 `agent_type` 可用；任何 Terra 写入前，对本任务后续必需的 Luna、Sol 和 Terra role 逐个执行无写入 runtime preflight，要求返回固定 role、模型/推理强度和未写入确认。任一必需 role 未成功启动或未返回完整确认，就在写入前停止。若运行时提供 effective sandbox 信息则记录它；profile 的 `sandbox_mode` 只是期望权限，宿主覆盖时不得把提示词约束称为技术强制隔离。调用 `spawn_agent` 只传该 `agent_type`，不传 `model` 或 `reasoning_effort`。使用 `fork_turns="none"`，或有限正数轮次，将任务状态、持久产物路径和自包含契约传给 worker；禁止传递完整历史。只有能力检查确认目标是 `avsp_luna_high` 或 `avsp_luna_xhigh` 且其不可用时，才可分别调用对应的只读 fallback。只有原 Sol role 已通过本地 schema/profile 检查、上游为该 `gpt-5.6-sol` 请求返回结构化 `unsupported_model` 或 `model_not_found` 时，才可调用 `avsp_terra_xhigh_readonly` 处理同一只读 Sol 阶段。认证、限流、网络、超时、参数/schema、本地 profile 缺失和未知错误均停止，绝不从错误文本猜测或改用可写 Terra role。

### 通过产物交接

跨 role worker 可能没有完整对话历史。任务状态是事实来源；仓库提供允许的持久位置时，`design.md`、`plan.md` 和 `review.md` 是其可审计副本。提示词指向可用记录并重申受限契约。Sol 只返回结构化结论，由协调者或 Terra worker 记录。

### 分离实现与复审

Luna 在写入前负责互不重叠证据域的先锋探索，在 Terra 实施后负责首次代码复审预审。仅在对应 Luna profile 已确认不可用时，其对应的只读 Terra fallback 才能承担同一任务。Luna 和 fallback 只能报告待核实线索，不能把它们定性为缺陷或漏洞，也不能修改格式或代码。Sol 必须独立核验每条线索，并重新检查需求、实际 diff、关键调用链、行为回归、边界、并发、权限、架构、测试和文档；无发现不能缩小 Sol 的范围。仅在规定的结构化模型不支持错误下，`avsp_terra_xhigh_readonly` 才能替代同一 Sol 只读阶段，且结果必须记录原 Sol role、错误证据和模型独立性降低。修复后必须重新独立复审。

### 运行时不可用

目标 `agent_type` 必须由实际委派工具支持并可用。只有 `avsp_luna_high` 不可用时可使用 `avsp_terra_low_readonly`，只有 `avsp_luna_xhigh` 不可用时可使用 `avsp_terra_medium_readonly`。`avsp_terra_xhigh_readonly` 仅在 `avsp_sol_high` 或 `avsp_sol_xhigh` 上游返回结构化 `unsupported_model` 或 `model_not_found` 时替代对应只读阶段。所有 fallback 都必须保持只读；其他任何 profile 不可用时都返回 `MODEL_UNAVAILABLE` 并停止，不创建替代 worker，也不用嵌套命令绕过能力检查。

### 仅凭证据升级

升级是恢复路径，不是默认路径。只有两轮修复-复审仍未解决重要问题、根因未知或证据矛盾、或用户指出具体验收缺口时，才使用 `avsp_sol_xhigh`。每个任务默认最多一次升级；升级后的实现由 `avsp_terra_xhigh` 完成，再由 `avsp_sol_high` 独立验证。

## 状态机

| 状态 | 必要输入 | 退出条件 | 下一状态 |
| --- | --- | --- | --- |
| 分类 | 用户请求与仓库规则 | 已确定 role 路由与授权 | 设计或简单执行 |
| 设计 | Luna 证据与需求 | Sol 验收的实现契约 | 实现或完成 |
| 实现 | 设计与验收标准 | 受限 diff 与测试证据 | 预审 |
| 预审 | 实际 diff 与测试证据 | Luna 的待核实线索或无发现报告 | 复审 |
| 复审 1 | 实际 diff 与需求 | 复审者的问题或干净结论 | 修复 1 或完成 |
| 修复 1 | 已确认问题 | 修正 diff 与测试 | 复审 2 |
| 复审 2 | 修复 1 的 diff 与证据 | 复审者的问题或干净结论 | 修复 2 或完成 |
| 修复 2 | 已确认问题 | 修正 diff 与测试 | 复审 3 |
| 复审 3 | 修复 2 的 diff 与证据 | 最终结论 | 完成或升级 |
| 升级 | 证据门槛失败 | 修订设计与计划 | 实现 |
| 简单执行 | 完整低风险步骤 | 执行输出与确定性检查 | 预审 |

仅诊断请求从设计直接完成；高风险未解决问题停止，不强行实施。

## 产物、风险与成本

复杂任务优先采用仓库既有且允许提交的记录惯例；没有时使用任务清单和目标工具持续跟踪。用户或仓库明确提供持久位置时，`design.md`、`plan.md`、`review.md` 分别记录需求与风险、阶段与路由，以及复审与修复证据；不得为此重新创建被忽略的临时目录。

- 破坏性、生产、迁移、权限和外部操作先模拟、确认精确目标并准备恢复。
- 修改同一文件或共享状态的 worker 串行执行；假设必须有具体证据。
- Luna 只用于只读先锋探索和首次复审预审；Sol 只做独立结论、设计和复审；所有写入由 Terra 完成。
- `avsp_luna_high` 不可用时只能以只读 `avsp_terra_low_readonly` 兜底，`avsp_luna_xhigh` 不可用时只能以只读 `avsp_terra_medium_readonly` 兜底。Sol 上游明确不支持模型时只能以只读 `avsp_terra_xhigh_readonly` 处理同一阶段；不得复用可写 `avsp_terra_xhigh`。其他任何 role 不可用时报告 `MODEL_UNAVAILABLE`。
- 优先确定性工具与测试，不要用更高推理强度弥补缺失的需求或验收标准。
