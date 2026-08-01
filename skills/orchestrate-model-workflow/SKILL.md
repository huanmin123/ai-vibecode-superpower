---
name: orchestrate-model-workflow
description: "以命名 agent role 路由软件任务：纯只读直达 Luna，Terra/high 负责集成与受控写入，Sol 仅处理真正高风险或高不确定判断。"
---

# 多模型工作流编排

本文件是模型路由、交接、并发和验收的唯一运行时规范。role profile 只定义角色本地权限和输出边界；`references/` 提供设计说明与模板，README 只面向使用者介绍。规则冲突时以本文件为准。

主控 `Terra/high` 指默认主控模型/推理强度，不是可写 role `avsp_terra_high`。前者只负责意图、上下文选择、阶段依赖、调度、显式交接和完成判断，不得写入工作区；后者是被明确委派的一级 writer。主控以实际 `spawn_agent(agent_type=...)` 调用确认 role，不要求 worker 自报不可见的运行时模型、推理强度或 sandbox。

开始路由前阅读 [references/workflow-design.md](references/workflow-design.md)；复杂任务使用 [references/execution-plan.md](references/execution-plan.md) 的状态与交接模板。

## 委派提示

每个任务包只说明一次目标、范围与非目标、已授权操作、必要输入、成功标准和停止条件；不要在 role、模板和补充提示中重复同一条规则。纯答复、解释、复审、诊断和规划只检查材料并交付结果；用户同时要求实施时才写入。对开发、实现、修复或整理，已授权范围内的本地改动和非破坏性验证应直接完成，不因重复的“先问”“不要动”类措辞停下。只有外部写入、破坏性操作、购买或实质扩大范围缺少明确授权时，才返回具体待决事项。

## 角色

模型与推理强度由 profile 固定；`spawn_agent` 只传 `agent_type`，不得覆盖 `model` 或 `reasoning_effort`。

| 用途 | `agent_type` | 边界 |
| --- | --- | --- |
| 常规取证、实施后预审 | `avsp_luna_high` | 只读事实、证据与未知项 |
| 深入取证、复杂预审 | `avsp_luna_xhigh` | 只读复杂证据域 |
| 二级契约实施 | `avsp_luna_high_writer` / `avsp_luna_xhigh_writer` | 仅 `avsp_terra_high` 的直接子代理；在实施契约内写入代码与产物 |
| Luna 不可用的只读替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 仅一对一替代对应 Luna |
| 高不确定性定案、正式复审 | `avsp_sol_high` | 只读独立判断 |
| 未解根因或重新设计 | `avsp_sol_xhigh` | 只读升级调查 |
| Sol 不支持模型时的替代 | `avsp_terra_xhigh_readonly` | 仅同一 Sol 只读阶段，披露独立性降级 |
| 实施、修复、集成 | `avsp_terra_high` | 唯一一级 writer |
| 受控技术定案、复审、最终验收 | `avsp_terra_xhigh` | 始终只读 |

## 不变量

1. 所有实施、修复、测试或文档改动的一级所有权、集成和结果责任都属于 `avsp_terra_high`。主控、只读 Luna、Sol、`avsp_terra_xhigh` 与只读替代 role 均不得写入或充当 writer；Luna writer 只能在其父 Terra 的直接委派下写入。
2. 二级 Luna writer 仅能作为 `avsp_terra_high` 的直接子代理实施一个或多个互不冲突的 `ImplementationContract`，不得继续派生。不存在按文件类型或业务对象划定的写入禁止清单：只要契约明确，Luna 可以写生产逻辑、公共接口或 schema、迁移脚本、共享状态或并发相关代码。每份契约必须给出目标行为与已定设计、允许目标及唯一所有权、相关不变量或顺序约束、适用的领域边界/精度/失败语义、基线或示例、验证方式与停止条件。Luna 遇到契约缺口、所有权冲突、范围漂移、未预期验证失败或需要新的技术取舍时不得写入并交回父 Terra；父 Terra 负责审核实际 diff 与验证结果并完成集成。WorkUnit 受阻时向直接父角色交付已完成结果与具体阻塞；普通暂态问题不转成用户确认。写入代码或迁移脚本不等于执行生产、外部或不可逆操作，后者仍按风险和授权边界处理。
3. `avsp_terra_xhigh` 只能做有界技术定案、相应复审或最终验收；它发现关键未知、范围漂移或风险升级时，必须先交回 Luna 补充证据，只有满足 Sol 升级条件时才转入 Sol。
4. 实现与独立复审不并行。语义改动或中高影响路径的最终验收必须使用新的 `avsp_terra_xhigh` work unit，不能复用该任务的定案者或复审者实例；纯机械、低风险写入仅在全部机器 guards 通过时，才能适用第 5 条的 Luna 验收例外。

## 路由与阶段

先按证据是否充分、决策是否有界、影响与耦合、风险可逆性和验收可观察性判断。任务短不等于简单，高影响本身不是 Sol 触发条件。

1. **纯只读任务**：不需要写入、技术定案或实施计划时，主控直接委派匹配的 Luna WorkUnit，Luna 可直接交付事实、证据、推断、未知项与风险；不得无故插入 Terra 或 Sol。证据显示写入、关键未知或下列 Sol 条件时立即升级。
2. **已设计、可验证的实施路径**：既有规格或前序定案已足以形成 `ImplementationContract` 时，主控直接委派 `avsp_terra_high`。Terra 持有一级所有权，并默认将契约中互斥的代码、测试、文档或生成物 WorkUnit 批量下放给 Luna writer；`avsp_luna_high_writer` 是默认实施者，只有契约虽完整但单元需要更深局部理解时才使用 `avsp_luna_xhigh_writer`。Terra 优先负责拆解、所有权、集成、冲突、契约缺口、验证失败和不可下放部分，而不是重复编写已经被充分设计的实现。
3. **有界技术路径**：Luna 取证后，只有确实需要受控技术定案时才由 `avsp_terra_xhigh` 输出 `ImplementationContract`；随后 `avsp_terra_high` 负责把契约拆成 WorkUnit，并优先让 Luna writer 实施其中包括生产代码在内的已定部分。实施后执行 Luna 预审与机器 guards；通过后只使用一个新的 `avsp_terra_xhigh` 最终验收 WorkUnit，不再追加“Terra/xhigh 复审 + 新 Terra/xhigh 验收”的重复调用。
4. **真正高风险或高不确定路径**：仅当不确定性出现在权限、安全或隐私合规、数据迁移或完整性、并发竞态、生产或不可逆外部副作用、公共契约或跨模块重设计、无可靠 oracle 的非确定性风险，或证据矛盾/修复后仍未证实根因时，Luna 取证后才允许 Sol。默认每个任务最多调用一次 Sol 独立判断：不确定性在实施前出现则用 Sol 定案；在实施后才出现则用 Sol 正式复审。Sol 或 Terra 定案后仍应尽量形成 `ImplementationContract` 并下放已定实现；Terra 直接编码仅保留无法可靠拆解、需要持续设计判断或存在共享所有权冲突的残余部分。只有上述敏感域需要前后两阶段独立判断，或证据仍矛盾、修复后根因仍未证实时，才允许 Sol 双阶段或升级 `avsp_sol_xhigh`。
5. **验收与升级**：纯机械、低风险写入在所有 guards 通过时可由新的 Luna 加机器证据闭环验收；语义改动或中高影响路径必须由新的 `avsp_terra_xhigh` 最终验收。任一 guard、预审或验收失败，或出现范围漂移时，交 `avsp_terra_high` 在原契约内修复；若根因未证实或证据矛盾，再走 Sol 升级条件。

机器 guards 必须可观察并记录结果：`ImplementationContract`、实际 diff 与目标范围一致，目标所有权未冲突，已声明的不变量、确定性 test/type/lint/build/contract/golden 与可重建生成物均通过，且 Luna 预审与机器证据一致。没有可靠的相关 guard 时不得走低风险闭环。guard 或验证失败时交由父 Terra 按当前状态处理。

Luna 取证、预审和二级 writer 均可创建 `0..N` 个 `WorkUnit`，没有静态数量上限。每个 WorkUnit 必须覆盖互补证据域、使用固定输入并说明新增价值；验收覆盖目标完成即停止，重复、矛盾或不可解释的结果立即升级。并发 writer 不得共享文件、共享状态或其他写入目标，共享目标由单一 owner 串行处理。允许为独立反证或关键假设核验而有目的地重叠，但每个分支必须说明新增价值。

## 交接与上下文

每个阶段返回 `HandoffPacket`，由协调者显式交给下游；role 间不假设隐式对话连通。核心字段是：`work_id`、目标与范围/非目标、`execution_state`、`result_state`、输入或产物引用、可验证结果与证据、核验依据、`guard_results`、未覆盖行为、升级原因、风险/未知项和下一阶段请求。涉及写入或并发时额外提供 `ImplementationContract`、依赖、允许目标或所有权、验收、停止条件和集成负责人。默认使用自包含任务包与相关产物引用；只有会改变判断的近期历史才附加。下游缺少影响判断的输入时交回父角色，不猜测。

### 结果定案

`execution_state` 只描述 WorkUnit 是否仍在运行；`completed`、`failed` 等终态不表示父任务已完成。`result_state` 使用 `evidence_needed`、`decision_needed`、`executable`、`verified_complete` 或 `blocked`，分别表示需要补充材料、需要判断、已具备可执行契约、已满足当前任务验收或无法继续。

交接中的主张都是待核验输入，不是结论。任何负责判断、行动或关闭的接收节点，都必须依据原始材料、任务约束和可观察结果独立判断；关键主张不成立或证据不足时，转为 `evidence_needed`，不得因上游已交接而生成契约或关闭任务。只有已定结论才能形成 `ImplementationContract`。

收敛所有终态子任务后，协调者必须先按 `result_state` 继续路由，而不是继续等待或假定整体完成。相对于当前任务验收仍未满足的 `evidence_needed`、`decision_needed` 与 `executable` 都是中间结果；只有 `verified_complete` 且证据满足当前任务验收时才能完成。`blocked` 必须传递结构化失败、已尝试操作与缺失条件，不得报告成功。

### 恢复子任务

恢复任务时，父角色必须逐个核验未完成子任务是否仍有可读取的活动执行实例和可验证的新进展；历史 `pending` 或等待中状态不是存活证据。实例仍存活时保留它继续执行；实例不存在、已终止或无法核验时，先检查已有产物、实际 diff、验证输出和目标所有权，再将旧实例标为失联。工作仍需完成时，只创建一个替代执行实例，并交付自包含的 `HandoffPacket`：原 `ImplementationContract` 与验收、旧子任务已回传的内容、当前文件与实际 diff、验证输出、未完成项，以及进度为“已验证完成”“已验证部分完成”或“未知”的明确分类。进度未知时，替代实例必须先盘点当前状态；不得假定从零开始或已经完成。不得等待失联实例返回、反复创建替代实例或从空白状态重做已完成工作。替代实例无法启动、不能验证继续条件或仍未完成时，返回包含原始错误、已尝试操作、现有产物、受影响范围和缺失条件的结构化失败；不得自动降级、隐藏错误或报告成功。

### 收敛子任务结果

父角色在等待前、收到子任务状态变化后和恢复时收敛结果。只等待可读取且已核验活动的执行实例；终态实例有 `HandoffPacket` 时幂等消费并移出等待集合。终态但无结果时，依据可用最终输出、产物、实际 diff 和验证日志重建；证据不足则标记 `result_missing` 并返回结构化失败。所有子任务终态后立即离开等待，先按 `result_state` 继续路由，再进入集成、验证、补证、定案或显式失败；原工作仍未完成时才按恢复规则创建一次替代实例。不得对终态实例重复等待、无限轮询、静默降级、假定完成或追加无必要的用户确认。

## 委派与关闭

每个委派至少说明角色、目标与授权操作、范围与非目标、必要 `HandoffPacket`、验收、验证、返回格式和停止条件；writer 额外说明允许文件或所有权。不要重复角色能力或通用限制；委派提示按前述“委派提示”执行。

只有已确认对应 Luna profile 不可用时，才能分别使用 `avsp_terra_low_readonly` 或 `avsp_terra_medium_readonly`；只有 Sol 请求返回对应 `gpt-5.6-sol` 的结构化不支持结果时，才能以 `avsp_terra_xhigh_readonly` 替代同一 Sol 阶段。其他必需 role 不可用则报告 `MODEL_UNAVAILABLE`，主控不得自行写入兜底。

关闭前执行范围内最强的验证，记录实际路由、验证证据、guards 结果、未覆盖行为、升级原因（如有）和残余风险。只有验收标准满足且没有必需工作剩余时，才能完成任务。
