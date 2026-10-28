---
name: project-doc-planner
description: 设计或更新项目文档架构、根目录 AGENTS.md、开发规范和可复用模板，以及 `.local` 私有层、私有环境资源与交付流程。用于文档规划或整理，不因普通开发、部署或修复任务自动重建文档体系。
---

# 项目文档规划器

只创建项目真正需要的文档结构。本 skill 只定义路由与质量约束；详细目录树和模板放在参考文件中，仅在任务命中时加载。

## 先确定范围

1. 提出结构前，阅读仓库的 `AGENTS.md`、`README*`、包清单、顶层目录和现有 `docs/`。
2. 识别项目类型、源码边界、用户、环境、部署需求和既有文档惯例。未知事实标记为 `待确认`，不得编造产品细节、主机、凭据、数据库名或命令。
3. 区分稳定公开规则、临时计划或复审记录，以及私有运行事实。小型配置包或范围狭窄的仓库不应生成完整文档骨架。
4. 保留已有项目义务；否则以当前 schema、API 契约和 UI 流程为准，不为旧结构引入长期运行时兼容路径。

## 核心边界

- `docs/` 保存可提交的稳定契约、规则、模板和脱敏的计划/问题/重构记录；`.local/` 是整体 Git 忽略的私有层，存放凭据、私有环境事实、发布产物、原始运行记录和任务暂存：`tmp/` 必备，dev/test/prod 环境事实在 `project-resources/`，其余子目录按使用场景裁剪。
- `external/`（与 `docs/`、`.local/` 平级的仓库根目录）保存面向外部使用者的交付资料（演示、外部对接文档、模板、工具等），由维护者手工维护：AI 日常开发中不读取、不检查、不主动更新，仅在用户明确要求维护对外资料时操作；目录以 `README.md` 作为唯一资源索引。
- 每个保留的 `docs/` 目录都有 `README.md`；按需增加模板或专题文档，不单独维护示例文档。
- 默认用简体中文编写项目文档。代码、命令、路径、配置键、协议字段和有契约意义的原文保持不变；项目明确采用其他语言时遵从项目约定。
- 设计必须写明目标、非目标、可观察行为、关键取舍、重要风险和待解决问题。稳定行为契约保留在设计中；本次测试项、验收清单和实际证据记在计划或对应问题/重构/部署记录中，关联记录用链接复用证据。只有影响决策、风险、回滚或用户明确要求时才展开实现细节。
- 遵循 SDD 分层：需求/设计（spec）定义长期稳定的语义和约束，计划（plan）定义本次如何实现、测量和收集证据，报告（report）沉淀已证实结果、边界和推断。定性与定量是内容属性，不是文档类型的绝对二分；稳定的性能、容量、错误率等阈值也属于 spec。
- 计划不得越权成为需求来源。只有不改变 API、schema、权限、UI、错误语义和稳定质量指标的文档整理、机械性整理或内部重构，才可使用 plan-only；任何稳定契约变化必须先创建或更新 `functions/` 设计。确需临时例外时，计划必须记录 waiver、批准人、理由、影响的契约和重新验证要求；waiver 只接受执行风险，不能授权计划定义长期契约，稳定变化在交付完成前仍须回写并冻结到 spec。
- 量化契约必须可判定：spec 至少记录指标、单位、目标/阈值、基线或对照、测量条件和测量方法；plan/report 记录本次环境、样本、实际值、状态和证据路径。定性契约也必须写成可观察断言，不使用“体验良好”“性能正常”等不可判定表述。
- 设计基线必须可冻结和复核：计划记录设计 revision/hash 及精确引用的 AC/NFR 集合；设计变化不得静默改变既有计划含义，必须追加变更记录并重新验证。
- 文档清理遵循生命周期和可恢复性规则：先判断文档职责、引用、基线和证据，再决定保留、合并、归档、废弃或删除；不得因“很久没更新”单独删除仍承担契约、审计或历史证据职责的文档。具体流程见 [document-cleanup-guide.md](references/document-cleanup-guide.md)。

### 定性与定量的职责分工

定性/定量是同一条 SDD 链路中的两种约束属性，不能按文档类型硬切分。需求设计定义长期口径，计划把口径转成这次可执行的任务和验证，报告记录实际观察；三者必须引用同一个稳定的 AC/NFR ID。

| 内容 | 需求/设计（spec） | 计划（plan） | 报告（report） |
| --- | --- | --- | --- |
| 定性约束 | 定义可观察语义、状态、错误、不变量和边界 | 指定场景、步骤、预期信号和证据收集方式 | 记录实际观察、适用范围和未验证项 |
| 定量约束 | 定义指标、单位、运算符与阈值/目标、基线/对照、条件和稳定测量方法 | 实例化环境、样本、负载、命令和本次测量，不能另造产品阈值 | 记录实测值、与原阈值的判定、证据和外推边界 |
| 禁止行为 | 不把一次测试结果冒充长期契约 | 不首次发明稳定语义或阈值；变化先回到 spec | 不改写契约或把推断写成已证实结论 |

设计快照 hash 必须对明确、可重现的 spec 内容计算；排除 hash 字段本身和会随执行过程变化的计划/报告链接，并在计划中记录算法、范围和快照时间。这样 hash 变化可以定位到设计基线变化，而不是记录文件自引用。
- 将高频用户意图映射为含输入、预检、执行、成功证据、失败处理和记录位置的流程。范围内的开发和本地验证自动执行；生产写入、回滚、凭据变更和其他高影响动作保留其授权门槛。
- 不得复制参考仓库的产品专属模块、API、供应商、主机、账号、密钥或历史记录。

## 按需加载参考

| 需要 | 读取参考 |
| --- | --- |
| 完整公开文档树、目录职责或文档大纲 | [doc-architecture.md](references/doc-architecture.md) |
| 文档生命周期、归档、合并、废弃和清理 | [document-cleanup-guide.md](references/document-cleanup-guide.md) |
| 开发规范、架构、前后端边界、安全或验证 | [development-standards.md](references/development-standards.md) |
| `.local` 私有层、dev/test/prod 上下文、tmp 暂存、部署、发布、回滚或环境隔离 | [local-project-resources.md](references/local-project-resources.md) |
| 可复用的项目根目录指令文件 | [root-agents-template.md](references/root-agents-template.md) |
| `docs/` 及子目录 `README.md` 格式 | [dir-readme-template.md](references/templates/dir-readme-template.md)；项目根 README 保留使用手册定位 |
| 架构总览格式 | [architecture-overview-template.md](references/templates/architecture-overview-template.md) |
| 长期测试与验证说明格式 | [verification-guide-template.md](references/templates/verification-guide-template.md) |
| 压测、验收、审计或专项分析报告格式 | [report-template.md](references/templates/report-template.md) |
| 安装、运行、构建、部署、回滚或 runbook 格式 | [operation-guide-template.md](references/templates/operation-guide-template.md) |
| 长期需求与行为契约格式 | [feature-design-template.md](references/templates/feature-design-template.md) |
| 单次交付计划与证据格式 | [plan-template.md](references/templates/plan-template.md) |
| 跨会话未完成事项清单（阻塞、待确认、待办、观察项）格式 | [todo-blockers-template.md](references/templates/todo-blockers-template.md) |
| 未来优化与条件触发事项（当前不做、储备登记）格式 | [reserve-items-template.md](references/templates/reserve-items-template.md) |
| 对外资料目录定位、资源索引与维护边界 | [external-docs-readme-template.md](references/templates/external-docs-readme-template.md) |
| 问题（bug）记录格式 | [bug-template.md](references/templates/bug-template.md) |
| 重构记录格式 | [refactor-template.md](references/templates/refactor-template.md) |
| 部署记录格式 | [deploy-record-template.md](references/templates/deploy-record-template.md) |
| 发布材料（release / rollback / checksums）格式 | [release-materials-template.md](references/templates/release-materials-template.md) |
| 私有环境 README 格式 | [env-readme-template.md](references/templates/env-readme-template.md) |

任务选择了哪个参考，就完整阅读哪个。填写模板时也读取对应架构、开发规范或私有资源参考中的相关约束，不能仅凭模板补全政策；不要因文件存在而加载全部参考。模板中的路径和章节是待裁剪的候选，成品只保留实际存在的相对链接和适用内容。

## 规划与产出

1. 提出最小可用结构，并说明每个保留目录的必要性。
2. 默认创建或规划被 `.gitignore` 保护的 `.local/` 私有层：`tmp/` 与 `project-resources/` 是固定成员；dev/test/prod 分区仅在确有对应环境时建立。
3. 用户要求对外资料时，在仓库根规划 `external/`（与 `docs/`、`.local/` 平级），只建立 `README.md` 索引骨架和必要的分组目录；内容由用户维护，AI 不填充演示、对接或工具细节，也不在后续任务中主动同步。
4. 让根 `AGENTS.md` 链接项目读取顺序、交付流程、环境边界和验证预期；持久政策只保留一个权威位置。
5. 使用相对 Markdown 链接创建或更新文件。模板保持通用、占位符清晰；复制后删去 skill 使用说明，改写指向 skill 的链接，只保留目标项目适用的内容。
6. 清理或重组文档前，先按清理指导手册完成引用、职责、基线、证据和恢复性预检；删除、覆盖或移动前必须保留可恢复副本或 Git 记录。
7. 验证目录入口、模板覆盖、链接目标、忽略规则，以及交付流程、脚本、环境规则和验证说明的一致性。Git 忽略须同时核对目标路径被忽略且未被跟踪；已跟踪的私有文件不能仅靠新增忽略规则宣称安全，不自动取消跟踪或改写历史。

## 必须交付

文档架构任务应返回或创建：

- 建议目录树及每个保留目录的简要职责；
- 公开/私有边界及适用时的 Git 忽略证据；
- 交付流程映射和相关操作的授权边界；
- 首批需创建或更新的文件、验收证据和未解决假设；
- 用户要求时提供清晰可读的 `AGENTS.md` 大纲。

报告具体改动文件、已执行验证、重要限制和下一项可执行决策。不得仅因生成了目录树就宣称文档结构完成。
