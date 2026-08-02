---
name: orchestrate-model-workflow
description: "以命名 agent role 路由软件任务：纯只读直达 Luna，Terra/high 负责集成与受控写入，Sol 仅处理真正高风险或高不确定判断。"
---

# 多模型工作流编排

本文件是模型路由、交接、并发和验收的唯一运行时规范。role profile 只定义角色本地权限和输出边界；`references/` 提供设计说明与模板，README 只面向使用者介绍。规则冲突时以本文件为准。

主控 `Terra/high` 指默认主控模型/推理强度，不是可写 role `avsp_terra_high`。前者只负责意图、上下文选择、阶段依赖、调度、显式交接和完成判断，不得写入工作区；后者是被明确委派的一级 writer。主控通过运行时提供的角色委派入口传递实际 role 标识，由 profile 解析模型、推理强度和权限；不要求 worker 自报不可见的运行时属性。

开始路由前阅读 [references/workflow-design.md](references/workflow-design.md)；复杂任务使用 [references/execution-plan.md](references/execution-plan.md) 的状态与交接模板。

## 委派提示

每个任务包只说明一次目标、范围与非目标、已授权操作、必要输入、成功标准和停止条件；不要在 role、模板和补充提示中重复同一条规则。纯答复、解释、复审、诊断和规划只检查材料并交付结果；用户同时要求实施时才写入。对开发、实现、修复或整理，已授权范围内的本地改动和非破坏性验证应直接完成，不因重复的“先问”“不要动”类措辞停下。只有外部写入、破坏性操作、购买或实质扩大范围缺少明确授权时，才返回具体待决事项。

## 角色

模型与推理强度由 profile 固定；委派时只传 role 标识和任务包，不在任务提示中覆盖 profile 的模型、推理强度或权限。
下表是当前安装包的 role 适配注册表，不是工作流语义本身；新增或替换 provider 时只需更新适配映射，不应改变 ownership、验收和恢复语义。

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

取证、预审和二级 writer 阶段均可使用 `0..N` 个 `WorkUnit`，没有静态数量上限；`WorkUnit` 是可独立验收的工作，不等于子代理。二级 writer WorkUnit 由其父 `avsp_terra_high` 创建并直接委派，writer 不得创建子代理或继续派生。每个 WorkUnit 必须覆盖互补证据域、使用固定输入并说明新增价值；验收覆盖目标完成即停止，重复、矛盾或不可解释的结果立即升级。并发 writer 不得共享文件、共享状态或其他写入目标，共享目标由单一 owner 串行处理。允许为独立反证或关键假设核验而有目的地重叠，但每个分支必须说明新增价值。

## 交接与上下文

每个阶段用最小 `HandoffPacket` 交代：目标和范围、`execution_state`、`result_state`、产物或证据，以及下一动作或阻塞；写入再附 `ImplementationContract`、目标所有权、验收和停止条件。交接是待核验输入，不传完整历史，也不要求固定 checkpoint 或表格字段。

需要跨顶层重启恢复的任务必须另外维护一个可读取的 `RecoveryManifest`。它不是新的运行时队列，而是任务状态的持久化索引；必须明确状态提供者、版本和最近写入时间。没有可核验的持久化提供者时，父任务只做一次最终状态盘点，报告 `PERSISTENCE_UNAVAILABLE`，将 `recovery_state` 设为 `recovery_required`/`runtime_wait`，结束当前执行轮次并保持 goal active；不得继续重复测试或审计。

子任务终态不表示父任务完成。`execution_state` 使用可映射到“活动、成功终态、失败终态、取消、失联”的生命周期语义；`result_state` 使用可映射到“需要证据、需要决策、可执行、已验证完成、真实领域受阻”的结果语义。状态提供者可以使用不同原始枚举，但 Handoff 必须记录规范化语义，父任务只能按语义消费：只有“已验证完成”才可集成或完成；“真实领域受阻”必须说明领域缺失，不能代表执行通道故障。

没有可消费 Handoff 时，先核验实例状态、diff、产物和验证输出。仍在运行则等待；实例失联、终止或无法恢复且工作未完成时，父任务在当前回合创建一次替代实例，并交付原契约和已知产物。替代 Handoff 记录被替代实例，整个 WorkUnit 生命周期不得再次替代。替代不能创建时保留原始错误、尝试和缺失条件，并保持 goal active。运行时未唤醒、投递失败或替代启动失败不得把 goal 标记为 blocked；只有真实领域或授权缺失反复出现且达到阻塞条件时才可调用状态更新接口。

### 顶层重启与分层恢复

主 agent 恢复或被新的顶层任务接管时，先读取并校验 `RecoveryManifest`，按 `manifest_revision` 只消费一次每个子任务的终态。根主控只恢复或替代自己的直接一级实施 owner；不得越级直接创建二级 writer。替代一级 owner 收到原契约、当前 diff、验证输出和子树状态后，只恢复或替代自己的直接二级子任务。

恢复顺序固定为：读取清单并取得本轮恢复 claim；核验直接子任务实例、心跳、diff 和产物；活动且可核验则继续，已验证完成则幂等消费，失联或未完成且 `replacement_count=0` 才创建一次替代；替代成功后递增清单版本并记录 `replacement_of`，随后由替代者继续其下级恢复。持久化或 claim 冲突、投递、唤醒和启动失败属于 `failure_class=runtime`。若当前主控没有可用的直接 writer 委派通道，顶层控制器（若 host 提供顶层任务创建或 fork 能力）必须创建带原清单的新顶层替代任务；没有控制器时只保留 `recovery_required`，不得转为 `domain_blocked`/`blocked`，也不得在原任务内继续空转。

`RecoveryManifest` 至少包含由状态提供者定义的 schema 标识、`goal_id`、`run_id`、`root_work_id`、revision、`persisted_at`、目标语义、恢复语义和直接子任务条目。恢复语义至少要能区分正常、核验、继续、消费、一次替代、需要恢复、运行时等待和已收敛；具体枚举由状态提供者映射。每个条目包含 `work_id`、`parent_work_id`、由角色层级推导的层级、`agent_type`、`instance_id`、规范化生命周期语义、规范化结果语义、规范化失败类别、尝试次数、替代次数、替代关系、packet revision、最近核验时间、checkpoint、产物、契约和收敛语义。提供者不支持原子版本检查或幂等 claim 时，恢复必须停止并报告原始错误，不能并发创建 writer。

提示词不能排队、唤醒或重试 agent。若运行时未提供子任务终态唤醒、`RecoveryManifest` 持久化、claim 或 backoff 能力，本规则只约束父任务已在运行时的处理。停止类 hook 也不能代替恢复控制器。需要跨进程、定时或多次重试时，必须使用已明确的外部状态提供者或 host 的顶层任务控制能力；缺失时进入 `runtime_wait` 并结束当前轮次，不伪造“已排队”，也不重复跑只读检查。

## 委派与关闭

每个委派至少说明角色、目标与授权操作、范围与非目标、必要 `HandoffPacket`、验收、验证、返回格式和停止条件；writer 额外说明允许文件或所有权。不要重复角色能力或通用限制；委派提示按前述“委派提示”执行。

使用角色委派入口时必须显式声明不继承完整父上下文，并通过自包含 `HandoffPacket` 传递必要事实、契约、diff 与验证证据；不得依赖隐式历史复制或让子代理自行改变 role。

只有已确认对应只读 profile 不可用时，才能使用配置中声明的一对一只读替代；只有高风险独立判断明确返回“模型或能力不支持”时，才能使用对应的只读技术替代。其他必需 role 不可用时保留 provider 原始错误和缺失条件，主控不得自行写入兜底。

关闭前执行范围内最强的验证，记录实际路由、验证证据、guards 结果、未覆盖行为、升级原因（如有）和残余风险。只有验收标准满足且没有必需工作剩余时，才能完成任务。
