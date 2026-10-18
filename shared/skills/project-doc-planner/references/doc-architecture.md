# 项目文档架构参考

## 原则

参考仓库只用于借鉴文档组织和项目规则模式。可以复用结构、索引习惯、维护规则、环境资源分离和验证预期；不得复制业务内容。

以下目录树是候选集合，按项目规模、现有布局与实际职责裁剪，不是必须生成的骨架。每个保留的公开文档目录包含：

- `README.md`：主入口文档。
- 按需的模板或专题文档；格式以本 skill `templates/` 目录的模板为准，目标项目内不单独维护示例文档。

默认开发规则应说明：实现面向当前 schema 和当前 API/UI 契约；兼容义务以项目既有契约和用户要求为准，不能因套用模板而取消。完整策略见 [development-standards.md](development-standards.md)。

`functions/` 保存长期有效的功能契约，`plans/` 保存阶段性的执行记录。涉及接口、数据或权限契约的功能先写或更新功能设计，计划引用设计并记录需求基线；小改动可直接使用简短计划，已有问题/重构记录能完整覆盖范围与验证时无需再建平行计划。稳定验收口径属于契约，本次任务、验证矩阵与实际结果属于执行记录，并通过需求的 `AC-*` 键追踪。

跨会话共享且尚未关闭的阻塞、待确认、待办和观察项集中在 `docs/待办与阻塞事项.md` 单一清单；条目关闭即删除，需要长期保留的过程与证据仍归入 `plans/`、`bug/`、`refactors/` 档案，清单通过编号锚点和指针区链接这些档案。格式见 [todo-blockers-template.md](templates/todo-blockers-template.md)。

压测、验收、审计和专项分析沉淀的人工报告保存在 `docs/reports/`，只记录测试范围、环境、数据、已证实结论和边界；原始机器产物（JSON、log、profile）放在 Git 忽略目录（例如 `.local/project-resources/`），报告以仓库相对路径引用，不混入 `docs/`。计划仍承载推进过程与本次验证矩阵；报告结论升级为长期规则时同步回对应设计文档。格式见 [report-template.md](templates/report-template.md)。

需要复用私有环境事实或发布材料时，再规划 Git 忽略的私有资源层；仅有本地开发或公开配置的项目不因此自动增加 dev/test/prod 分区。交付流程只覆盖项目实际支持的开发、验证和运维能力，不能把建议脚本描述为已有工具。

文档按“草稿 -> 生效 -> 已废弃/已归档 -> 删除”管理生命周期；状态变化必须保留原因、责任人、受影响链接和基线影响。`functions/` 的稳定契约、已产生证据的 `plans/`、`bug/`、`refactors/` 和 `reports/` 默认保留或归档，不因当前任务结束直接删除；`待办与阻塞事项.md` 的已关闭条目仍按清单规则移除，但需要长期保留的过程证据必须先转入对应档案。清理、合并、废弃和删除前的证据、恢复性、链接和索引检查按 [document-cleanup-guide.md](document-cleanup-guide.md) 执行。

## 候选文档树

```text
docs/
├── README.md
├── 待办与阻塞事项.md
├── architecture/
│   ├── README.md
│   ├── 架构总览.md
│   ├── 功能开发指导.md
│   ├── 问题修复指导.md
│   ├── 大文件重构指南.md
│   ├── frontend/
│   │   ├── README.md
│   │   ├── 样式规范.md
│   │   ├── 响应式列表规范.md
│   │   ├── 通用组件规范.md
│   │   └── 产品与品牌边界.md
│   └── backend/
│       ├── README.md
│       └── 后台任务使用说明.md
├── functions/
│   ├── README.md
│   ├── 核心功能设计.md
│   ├── 接口契约与权限矩阵.md
│   ├── 数据存储说明.md
│   └── 安全与日志策略.md
├── plans/
│   ├── README.md
│   └── 计划模板.md
├── reports/
│   ├── README.md
│   └── 报告模板.md
├── develop/
│   ├── README.md
│   ├── 安装指南.md
│   ├── 运行说明.md
│   └── 测试与验证说明.md
├── deploy/
│   ├── README.md
│   ├── 构建指南.md
│   └── 部署指南.md
├── bug/
│   ├── README.md
│   └── 问题模板.md
└── refactors/
    ├── README.md
    └── 重构模板.md
```

## 私有项目资源树

环境事实需要供 AI 和维护者复用时，在 `docs/` 之外配套规划被 Git 忽略的私有资源层。目录结构、文件职责、脚本门禁与安全边界统一见 [local-project-resources.md](local-project-resources.md)，环境 README 模板见 [env-readme-template.md](templates/env-readme-template.md)。

仅生成占位符和 README 指引；不得编造或复制真实凭据、IP、域名、数据库名或 token。

## 稳定文档与模板映射

| 产物 | 模板或内容依据 |
| --- | --- |
| 项目根 `README.md` | 保留项目使用手册惯例：用途、使用者、安装/使用入口与文档导航，不套用内部目录索引模板 |
| `docs/` 及子目录 `README.md` | [dir-readme-template.md](templates/dir-readme-template.md) |
| `architecture/架构总览.md` | [architecture-overview-template.md](templates/architecture-overview-template.md) |
| `functions/` 中长期需求与行为契约 | [feature-design-template.md](templates/feature-design-template.md) |
| `develop/测试与验证说明.md` | [verification-guide-template.md](templates/verification-guide-template.md) |
| 安装、运行、构建、部署指南和私有 runbook | [operation-guide-template.md](templates/operation-guide-template.md) |
| 文档生命周期、清理、归档、合并与删除 | [document-cleanup-guide.md](document-cleanup-guide.md) |
| 功能开发、问题修复、重构和前后端专题规范 | [development-standards.md](development-standards.md) 中对应章节；写适用范围、项目实际规则、例外依据与维护触发，不再复制无关规范 |
| 接口/权限、存储、安全/日志专题契约 | 功能设计模板的对应章节和开发规范；内容较大时拆为专题文档并相互链接，保持单一权威来源 |

没有直接匹配的模板时，依据相关大纲编写；不为每个候选文件制造同构模板。复制到目标项目后，链接指向项目文档，不能依赖本 skill 的安装路径。

## 维护矩阵

| 变更类型 | 必需文档 |
| --- | --- |
| 文档结构变化 | `docs/README.md`、受影响目录的 `README.md` |
| 架构边界变化 | `architecture/README.md`、`architecture/架构总览.md` |
| 前端信息架构 | `architecture/frontend/README.md`、前端指导与规范文档 |
| 前端列表、表格、响应式或可复用组件变化 | 按相关性更新 `architecture/frontend/样式规范.md`、`architecture/frontend/响应式列表规范.md`、`architecture/frontend/通用组件规范.md` |
| 后端分层或 API 边界 | `architecture/backend/README.md`、后端规范、功能/API 文档 |
| 后端 worker、队列、定时任务或批处理副作用 | `architecture/backend/后台任务使用说明.md`、后端规范；运行时变化时更新 develop/deploy 文档 |
| 新功能或流程 | `functions/README.md` 与功能设计文档；有追踪记录时更新 `plans/*` |
| API、权限或存储变化 | `functions/接口契约与权限矩阵.md`、`functions/数据存储说明.md`、验证文档 |
| 当前 schema/API/UI 模型变化 | 存储/API/UI 文档，以及明确的既有兼容义务或用户指定例外 |
| 开发命令变化 | `develop/README.md`、运行/测试文档 |
| 构建或部署变化 | `deploy/README.md`、构建/部署指南 |
| 私有环境、账号、数据库、部署拓扑或发布事实变化 | 仅在规则/模板变化时更新公开文档；当前事实更新 `.local/project-resources/<env>/...` |
| 测试环境复用 dev 或与 dev 分离 | `develop/测试与验证说明.md`；更新 `.local/project-resources/test/` 和环境加载脚本 |
| 生产发布或回滚 | 流程变化时更新 `deploy/` 模板；更新 `.local/project-resources/prod/logs/`、`prod/releases/`、`current-release.txt` 和回滚记录 |
| AI 交付流水线或命令映射变化 | `AGENTS.md`、`docs/develop/`、`docs/deploy/`；更新 `.local/project-resources/README.md` 和相关脚本 |
| 重复或重要 Bug | `bug/README.md`、当次问题记录；仅格式变化时更新问题模板 |
| 大型重构 | `refactors/README.md`、当次重构记录；仅格式变化时更新重构模板 |
| 阻塞出现或解除、裁决完成、观察项升级 | `待办与阻塞事项.md` 对应分区（保留编号移动）；需长期保留证据时建立 plans/bug/refactors 档案并删除清单条目 |
| 压测、验收、审计或专项分析产出独立报告 | `reports/README.md` 文件索引、当次报告；计划/问题的验证矩阵链接报告而不复制数据；结论成为长期规则时同步回设计文档 |
| 文档新增、合并、归档、废弃或删除 | 先读 [document-cleanup-guide.md](document-cleanup-guide.md)；更新受影响目录 `README.md`、入链、替代文档、关联计划/基线和清理记录；有长期证据的记录只归档不删除 |
| 清理规则、保留期限或归档位置变化 | [document-cleanup-guide.md](document-cleanup-guide.md)、本矩阵及受影响目录 `README.md`；说明生效日期、迁移范围和恢复路径 |

矩阵按实际影响和已保留目录应用，不因命中变更类型创建整套不存在的文件；既有权威文件已覆盖时直接更新并链接。

## 编号记录模式

- 新建记录类文档（plans/bug/refactors）默认使用 UTC 时间戳 ID，精确到秒，不用毫秒和顺序编号。ID 形如 `PLAN-YYYYMMDDTHHmmss`、`BUG-YYYYMMDDTHHmmss`、`REFACTOR-YYYYMMDDTHHmmss`，文件名对应为 `计划/问题/重构-YYYYMMDDTHHmmss-短标题.md`。秒级时间戳仍可能碰撞；创建时以排他方式保留目标文件名，冲突则在下一秒重新生成，不覆盖已有记录。已有项目编号惯例可保留。
- ID 创建后不再修改。标题可以改名，但文件正文和链接中的 ID 必须稳定。
- `docs/待办与阻塞事项.md` 是在用清单而非档案，条目使用文件内稳定短编号（`B`/`C`/`T`/`W`/`P` + 递增序号），状态变化跨分区移动并保留编号，关闭即删除且编号不复用；需要长期保留的过程记录仍按时间戳 ID 建档。
- `docs/reports/` 报告不使用编号 ID，文件名用 `<主题>报告-YYYY-MM-DD.md`，同一主题多轮以日期区分；新报告在目录 README 的文件索引登记后才算交付。

记录与私有资源模板：[plan-template.md](templates/plan-template.md)、[todo-blockers-template.md](templates/todo-blockers-template.md)、[bug-template.md](templates/bug-template.md)、[refactor-template.md](templates/refactor-template.md)、[report-template.md](templates/report-template.md)、[deploy-record-template.md](templates/deploy-record-template.md)、[release-materials-template.md](templates/release-materials-template.md)、[env-readme-template.md](templates/env-readme-template.md)。稳定文档模板见上方映射表。目标项目仅在需要项目专有格式时维护模板副本；副本成为项目格式的权威来源，不要求与 skill 长期机械同步。

## 开发策略基线

兼容性策略和离线数据处理等开发规则见 [development-standards.md](development-standards.md) 的"基线原则"；目标项目选定一个权威规范承载适用规则，`AGENTS.md`、功能开发指导和其他指南只链接对应规范，不重复维护。

## 环境资源基线

dev 默认上下文、生产确认门禁、环境隔离与敏感信息脱敏等规则，权威出处是 [development-standards.md](development-standards.md) 的"环境资源与上下文规范"；私有资源的目录结构、脚本门禁与安全规则见 [local-project-resources.md](local-project-resources.md)。

## AI 交付流水线基线

意图映射、脚本入口、证据要求与停止条件等规则，权威出处是 [development-standards.md](development-standards.md) 的"AI 交付流水线规范"；人工指令到执行流的映射表与脚本清单见 [local-project-resources.md](local-project-resources.md)。

## 质量标准

- 不为凑齐目录树创建空目录；仅含 `README.md` 的目录可以保留，但入口本身须承担实际索引或规则职责。
- 不得把设想中的功能写成既有事实。
- 架构文档要稳定耐用，计划文档保持临时性。
- 链接保持相对路径，以便仓库移动后仍可用。
- 不要留下模糊的“兼容性策略”表述；明确项目是只遵循当前模型，还是有具体兼容例外。
- 任何清理都必须先证明目标的生命周期状态、入链、索引、需求基线和恢复路径；不能以“内容看起来过时”作为删除依据。
