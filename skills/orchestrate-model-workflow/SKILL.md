---
name: orchestrate-model-workflow
description: "以命名 agent role 路由软件任务：只读 Luna 负责先锋探索和预审，Sol 负责汇总、独立复审与验证，Terra/high 负责常规写入，Terra/xhigh 只修复已确认问题。"
---

# 多模型工作流编排

通过已安装的 `avsp_*` agent role 分离只读分析、实现与独立复审。协调者负责用户意图、阶段依赖、任务产物和完成判断；worker 只拥有其受限阶段的输出。协调者以自身实际的 `spawn_agent(agent_type=...)` 调用确认所创建的 role，不要求 worker 自报不可见的运行时模型、推理强度或 sandbox。

开始路由前完整阅读 [references/workflow-design.md](references/workflow-design.md)。复杂任务还要阅读 [references/execution-plan.md](references/execution-plan.md)，并使用其中的产物与阶段清单。

## 固定角色路由

每个阶段只能使用下表的 `agent_type`。模型与推理强度是 profile 的固定属性，不在委派调用中覆盖。

| 阶段                           | `agent_type`                 | 固定模型 / 推理强度                | 职责                                             |
| ---------------------------- | ---------------------------- | -------------------------- | ---------------------------------------------- |
| 先锋探索、初版分析、快速并行探路             | `avsp_luna_high`             | `gpt-5.6-luna` / `high`    | 只读事实、证据、风险与待核实问题                               |
| 复杂先锋探索或复杂预审                  | `avsp_luna_xhigh`            | `gpt-5.6-luna` / `xhigh`   | 只读复杂证据域分析                                      |
| Luna/high 不可用时的唯一只读兜底        | `avsp_terra_low_readonly`    | `gpt-5.6-terra` / `low`    | 仅替代 `avsp_luna_high` 的只读先锋探索或复审预审；不得写入或替代 Sol  |
| Luna/xhigh 不可用时的唯一只读兜底       | `avsp_terra_medium_readonly` | `gpt-5.6-terra` / `medium` | 仅替代 `avsp_luna_xhigh` 的只读先锋探索或复审预审；不得写入或替代 Sol |
| 汇总、设计、调查、正式复审、最终验证           | `avsp_sol_high`              | `gpt-5.6-sol` / `high`     | 只读独立判断与完整复审                                    |
| 未解决诊断或重新设计升级                 | `avsp_sol_xhigh`             | `gpt-5.6-sol` / `xhigh`    | 只读根因重查与有范围的补救设计                                |
| Sol 上游明确不支持模型时的唯一只读 fallback | `avsp_terra_xhigh_readonly`  | `gpt-5.6-terra` / `xhigh`  | 仅替代同一 Sol 只读阶段；不得写入，必须披露独立性降级                  |
| 实施已验收计划和必要的常规写入              | `avsp_terra_high`            | `gpt-5.6-terra` / `high`   | 在授权范围内写入                                       |
| 修复独立复审已确认的问题                 | `avsp_terra_xhigh`           | `gpt-5.6-terra` / `xhigh`  | 只修复确认问题，不重做设计                                  |

Luna 以及所有只读 Terra fallback 都不得修改工作区。Luna 及其 fallback 只能报告事实、证据和待核实问题，不得把线索定性为缺陷或漏洞。Sol 独立核验所有线索，不能因 Luna 或 fallback 报告无发现而缩小复审范围。`avsp_terra_xhigh_readonly` 在 Sol fallback 时应完成同等范围的独立只读判断，但必须记录模型独立性降低。Terra/high 负责常规写入；可写 `avsp_terra_xhigh` 仅修复已确认的问题。

## 委派能力与不可用规则

首次委派前检查实际 `spawn_agent` schema 是否支持 `agent_type`，并验证目标 role 可启动。协调者以成功创建的 `agent_type` 和对应已安装 profile 记录声明的模型、推理强度与读写边界；这些是配置事实，不是 worker 对运行时状态的自证。worker 无须也不应被要求返回模型、推理强度或 sandbox。运行时若提供 effective sandbox 等元数据，协调者记录它；未提供时明确标为不可观察，profile 中的 `sandbox_mode` 仍只是期望权限。调用 `spawn_agent` 时只传 `agent_type`，不得再传 `model` 或 `reasoning_effort`。必须显式传 `fork_turns="none"`，或传有限正数轮次；禁止继承完整历史。向 worker 提供自包含任务契约、任务状态和必要产物路径。高风险、不可逆、生产、权限或外部写入任务在执行前必须确认本任务后续必需的 role 可启动；本地可回滚的实现不因缺少 worker 自报元数据而停止。

仅当能力检查确认 `avsp_luna_high` profile 不可用时，才可使用 `avsp_terra_low_readonly`；仅当确认 `avsp_luna_xhigh` profile 不可用时，才可使用 `avsp_terra_medium_readonly`。只有原 Sol profile 已通过本地 schema/profile 检查、委派后上游返回对应 `gpt-5.6-sol` 的结构化 `unsupported_model` 或 `model_not_found` 时，才可使用 `avsp_terra_xhigh_readonly` 替代同一 `avsp_sol_high` 或 `avsp_sol_xhigh` 只读阶段一次。不得从错误文本猜测模型不支持；认证/权限、限流/配额、网络/DNS/TLS/超时、参数或 schema、本地 profile 缺失、取消和未知/内部错误都不得 fallback。所有 fallback 必须通过能力检查，且绝不可写入；fallback 失败立即返回 `MODEL_UNAVAILABLE`。其他任何 profile 不可用时立即返回 `MODEL_UNAVAILABLE` 并停止当前阶段和其依赖阶段。错误必须包含：阶段、原定及实际 `agent_type`、profile 声明的模型/推理强度、结构化错误与能力检查证据、是否已经写入，以及恢复所需的外部条件。worker 启动失败或未完成该阶段任务契约时，只能以同一 `agent_type` 重试一次；缺少运行时模型、推理强度或 sandbox 自报不构成失败。再次失败后停止并报告原始错误。

## 分类与执行

任务短不等于简单。安全敏感、破坏性、改 schema、并发或影响生产的工作永远不是简单任务。

| 类型       | 条件                        | 路由                                                                                                |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| 先锋探索     | 需求、架构、根因、漏洞或方案尚不确定        | Luna role 探路；仅 Luna 不可用时使用对应只读 Terra fallback；Sol/high 汇总定案，且仅结构化模型不支持时可用只读 Terra/xhigh 替代        |
| 简单执行     | 步骤与预期完整、低风险且无实质设计选择       | Terra/high 实施，Luna 预审；仅 Luna 不可用时使用对应只读 Terra fallback；Sol/high 复审，且仅结构化模型不支持时可用只读 Terra/xhigh 替代 |
| 按计划实施    | 有协调者验收的设计与可衡量验收           | Terra/high                                                                                        |
| 首次代码复审预审 | 实施完成后按证据域并行报告线索           | Luna role；仅不可用时使用对应只读 Terra fallback                                                              |
| 正式复审     | 检查完成代码的正确性、回归、证据与遗漏       | Sol/high；仅结构化模型不支持时 `avsp_terra_xhigh_readonly`                                                   |
| 修复       | 修复已确认问题，不重新设计无关代码         | Terra/xhigh                                                                                       |
| 最终验证     | 修复后重新评估最终 diff 和证据        | Sol/high；仅结构化模型不支持时 `avsp_terra_xhigh_readonly`                                                   |
| 升级调查     | 两轮修复-复审失败、根因未证明，或出现具体验收缺口 | Sol/xhigh；仅结构化模型不支持时 `avsp_terra_xhigh_readonly`，然后 Terra/xhigh                                   |

### 1. 建立状态

复杂任务应建立可追踪状态，并在实施前记录范围、非目标、证据、风险、回滚、验收标准和必要验证。只有仓库已有允许提交的位置时，才创建持久设计、计划或复审文档；否则使用任务清单和目标状态。

### 2. Luna 探路，Sol/high 汇总设计

将互不重叠的证据域交给多个 Luna role（无上限但需要合理）。每个 worker 返回事实、证据位置、推断、风险和未解决问题，且不修改文件或外部状态。复杂探路才使用 `avsp_luna_xhigh`。仅在对应 Luna profile 的能力检查确认不可用时，才分别用 `avsp_terra_low_readonly` 或 `avsp_terra_medium_readonly` 承担同一只读任务。等待所有依赖结果后，交给 `avsp_sol_high` 汇总、核对矛盾、反驳不可靠假设，并形成协调者可验收的实现契约；仅在该 Sol 调用收到规定的结构化模型不支持错误时，才能用 `avsp_terra_xhigh_readonly` 完成同一汇总并记录独立性降级。仅诊断任务在此交付结论并停止，除非用户要求修复。

### 3. Terra/high 实施

仅在设计契约完整后委派 `avsp_terra_high`。提示词必须包含：准确范围和非目标、任务状态或产物路径、验收标准与验证命令、允许修改的文件、相关仓库指令，以及已改文件、测试、假设和残余风险的返回要求。只有所有权区域独立且不重叠时才能并行实施 worker。

### 4. Luna 预审，Sol/high 正式复审

Terra 完成写入后，使用多个 Luna role（无上限但需要合理） 按互不重叠的证据域预审：代码规范、基础类型或运行时错误、实际 diff 范围与死代码、常见安全模式，以及测试遗漏与回归风险。仅在对应 Luna profile 的能力检查确认不可用时，才使用其一对一只读 Terra fallback。每个线索必须有证据位置、触发条件、潜在影响和需要 Sol 核对的原因。只有改动面大、涉及认证/权限、外部输入或依赖关系明显复杂时，才使用 `avsp_luna_xhigh`。

所有预审完成后，由 `avsp_sol_high` 复审实际 diff、当前文件、测试和需求，而非实现者摘要。只有规定的结构化模型不支持错误才能改由新的 `avsp_terra_xhigh_readonly` worker 完成同一只读范围，并明确记录原 Sol role、错误和独立性降级。复审者必须逐项独立核验 Luna 线索，并完整检查需求、调用链、行为回归、边界、并发、权限、架构、性能、文档和测试。问题按严重度排序，给出精确文件/行证据；没有问题时明确说明并列出残余测试缺口。

### 5. 修复、验证与升级

Sol 确认可操作问题时，只向 `avsp_terra_xhigh` 提供已确认问题、当前 diff、约束和所需验证。它必须修复根因，禁止无关清理。修复后重跑受影响测试，再由新的 `avsp_sol_high` 对最终 diff 和测试证据进行独立复审。最多进行两轮修复-复审。

仅在两轮仍未解决重要问题、根因未知或证据矛盾、或用户指出具体验收缺口时，使用 `avsp_sol_xhigh` 重新调查根因并形成有范围的补救方案。协调者验收修订计划后，交给 `avsp_terra_xhigh` 实现，再执行常规独立最终验证。默认每个任务只允许一次升级；升级验证仍失败时，停止并报告未解决证据。

## 委派契约与关闭

每个委派提示词必须包含角色、目标和授权操作、范围与非目标、所有权、任务状态或产物路径、相关证据、验收标准、验证命令、返回格式和停止条件。所有 Sol worker 和 `avsp_terra_xhigh_readonly` 都必须明确“仅做只读分析，不得编辑文件或改变外部状态”。实现与其独立复审绝不并行；依赖阶段必须等待上游完成。

关闭前执行范围内最强的安全验证，更新任务状态和存在的持久产物，并报告实际 `agent_type` 路由、能力检查、改动、验证和残余风险。只有验收标准已满足且没有必需工作剩余时，才标记完成。
