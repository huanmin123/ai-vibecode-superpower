# 新项目文档架构参考

## 原则

参考仓库只用于借鉴文档组织和项目规则模式。可以复用结构、索引习惯、维护规则、环境资源分离和验证预期；不得复制业务内容。

每个目录必须包含：

- `README.md`：主入口文档。
- 一个“示例”或 `demo` 文档：该类型文档的具体示例。
- 该目录需要可重复记录时，可选的模板或专题文档。

默认开发规则应说明：实现面向当前最佳模型、当前 schema 和当前 API/UI 契约。除非用户明确要求，不要求向后兼容、运行时旧字段回退或迁移分支。

对于涉及开发、测试、生产、部署、发布、回滚、账号、密钥、数据库或第三方资源的项目，除 `docs` 外还要规划一个被 Git 忽略的私有资源层。公开文档说明规则和模板；私有资源保存当前环境事实。同时规划 AI 交付流水线，使自然语言请求映射到可重复的计划、验证、发布、部署、回滚和日志流程。

## 完整模板树

```text
docs/
├── README.md
├── 文档架构示例.md
├── architecture/
│   ├── README.md
│   ├── 架构总览.md
│   ├── 架构示例.md
│   ├── 功能开发指导.md
│   ├── 问题修复指导.md
│   ├── 大文件重构指南.md
│   ├── frontend/
│   │   ├── README.md
│   │   ├── 前端架构示例.md
│   │   ├── 样式规范.md
│   │   ├── 响应式列表规范.md
│   │   ├── 通用组件规范.md
│   │   └── 产品与品牌边界.md
│   └── backend/
│       ├── README.md
│       ├── 后端架构示例.md
│       └── 后台任务使用说明.md
├── functions/
│   ├── README.md
│   ├── 功能设计示例.md
│   ├── 核心功能设计.md
│   ├── 接口契约与权限矩阵.md
│   ├── 数据存储说明.md
│   └── 安全与日志策略.md
├── plans/
│   ├── README.md
│   ├── 计划模板.md
│   └── 计划-0001-示例.md
├── develop/
│   ├── README.md
│   ├── 开发流程示例.md
│   ├── 安装指南.md
│   ├── 运行说明.md
│   └── 测试与验证说明.md
├── deploy/
│   ├── README.md
│   ├── 部署流程示例.md
│   ├── 构建指南.md
│   └── 部署指南.md
├── bug/
│   ├── README.md
│   ├── 问题模板.md
│   └── 问题-0001-示例.md
└── refactors/
    ├── README.md
    ├── 重构模板.md
    └── 重构-0001-示例.md
```

## 私有项目资源树

环境事实需要供 AI 和维护者复用时，将下列目录与 `docs/` 配套使用：

```text
.local/project-resources/
├── README.md
├── dev/
│   ├── README.md
│   ├── env/README.md
│   ├── accounts/README.md
│   ├── database/README.md
│   ├── logs/README.md
│   ├── issues/README.md
│   └── runbooks/README.md
├── test/
│   ├── README.md
│   ├── env/README.md
│   ├── accounts/README.md
│   ├── database/README.md
│   ├── logs/README.md
│   ├── issues/README.md
│   └── runbooks/README.md
└── prod/
    ├── README.md
    ├── env/README.md
    ├── accounts/README.md
    ├── database/README.md
    ├── deploy/README.md
    ├── logs/README.md
    ├── issues/README.md
    ├── runbooks/README.md
    └── releases/
        ├── README.md
        ├── current-release.txt
        └── YYYY-MM-DD_NNN/
            ├── artifacts/
            ├── release.md
            ├── checksums.txt
            └── rollback.md
```

该目录必须被 Git 忽略。仅生成占位符和 README 指引；不得编造或复制真实凭据、IP、域名、数据库名或 token。

## 主文档大纲

每个目录的 `README.md` 使用以下结构：

- 目录定位：本目录解决什么问题。
- 适用范围：哪些改动应先读这里。
- 文件索引：每个文件的职责。
- 新增规则：新增文档的命名、编号和放置位置。
- 维护规则：哪些变更发生时必须更新本目录。
- AI/维护者入口：推荐阅读顺序。

`.local/project-resources` 的 README 文件使用以下结构：

- 当前用途：dev/test/prod 的角色，以及 test 是否复用 dev。
- 当前有效文件：env、账号索引、数据库、部署、runbook、发布指针。
- 隔离边界：数据库、缓存、队列、命名空间、端口、域名或云资源边界。
- 使用方式：加载 env、启动服务、运行 smoke、部署、验证或回滚。
- 禁止事项：dev 不连生产数据库，公开文档不放生产密钥，不输出密钥。
- 维护规则：环境、部署、发布、回滚或事故变化后需要更新什么。

## 示例文档大纲

每个示例文档使用以下结构：

- 示例背景：使用泛化场景，不写参考项目业务。
- 目标与非目标：明确边界。
- 涉及文件：列出可能影响的代码和文档区域。
- 设计或处理过程：展示该类型文档应有的核心内容。
- 验证方式：命令、手动路径和检查清单。
- 风险与后续：待确认项、限制和下一步。

## 各目录的示例重点

- `docs/文档架构示例.md`：展示完整文档树和更新矩阵。
- `architecture/架构示例.md`：展示模块边界、流程、非目标和扩展点。
- `architecture/frontend/前端架构示例.md`：展示页面结构、组件、交互、文案和验证。
- `architecture/backend/后端架构示例.md`：展示路由、服务、存储、错误、任务和中间件。
- `functions/功能设计示例.md`：展示一个功能的背景、流程、字段、状态、API/UI/存储影响。
- `plans/计划-0001-示例.md`：展示可执行的编号计划，不强制固定阶段名称。
- `develop/开发流程示例.md`：展示安装、运行、类型检查/测试/构建和手动验证。
- `deploy/部署流程示例.md`：展示构建包、环境变量、启动、健康检查和回滚。
- `bug/问题-0001-示例.md`：展示复现、根因、修复、验证和预防。
- `refactors/重构-0001-示例.md`：展示动机、拆分计划、已改文件、验证和复审。

## 维护矩阵

| 变更类型 | 必需文档 |
| --- | --- |
| 文档结构变化 | `docs/README.md`、受影响目录的 `README.md`、对应示例 |
| 架构边界变化 | `architecture/README.md`、`architecture/架构总览.md`；模式变化时更新 `architecture/架构示例.md` |
| 前端信息架构 | `architecture/frontend/README.md`、前端指导/示例文档 |
| 前端列表、表格、响应式或可复用组件变化 | 按相关性更新 `architecture/frontend/样式规范.md`、`architecture/frontend/响应式列表规范.md`、`architecture/frontend/通用组件规范.md` |
| 后端分层或 API 边界 | `architecture/backend/README.md`、后端示例、功能/API 文档 |
| 后端 worker、队列、定时任务或批处理副作用 | `architecture/backend/后台任务使用说明.md`、后端示例；运行时变化时更新 develop/deploy 文档 |
| 新功能或流程 | `functions/README.md`、`functions/功能设计示例.md` 模式；有追踪记录时更新 `plans/*` |
| API、权限或存储变化 | `functions/接口契约与权限矩阵.md`、`functions/数据存储说明.md`、验证文档 |
| 当前 schema/API/UI 模型变化 | 存储/API/UI 文档，并明确运行时代码默认遵循当前模型，除非用户要求兼容 |
| 开发命令变化 | `develop/README.md`、运行/测试文档、开发示例 |
| 构建或部署变化 | `deploy/README.md`、构建/部署指南、部署示例 |
| 私有环境、账号、数据库、部署拓扑或发布事实变化 | 仅在规则/模板变化时更新公开文档；当前事实更新 `.local/project-resources/<env>/...` |
| 测试环境复用 dev 或与 dev 分离 | `develop/测试与验证说明.md`；更新 `.local/project-resources/test/` 和环境加载脚本 |
| 生产发布或回滚 | 流程变化时更新 `deploy/` 模板；更新 `.local/project-resources/prod/logs/`、`prod/releases/`、`current-release.txt` 和回滚记录 |
| AI 交付流水线或命令映射变化 | `AGENTS.md`、`docs/develop/`、`docs/deploy/`；更新 `.local/project-resources/README.md` 和相关脚本 |
| 重复或重要 Bug | `bug/README.md`、问题模板、问题示例模式 |
| 大型重构 | `refactors/README.md`、重构模板、重构示例模式 |

## 编号记录模式

- `plans/`：使用稳定的 `PLAN-0001` ID、状态字段、任务清单、测试项、验证记录、完成摘要和 README 索引。
- `bug/`：使用稳定的 `BUG-0001` ID、同根因复发记录、关联 Bug 链接、原因/修复/验证/预防和 README 索引。
- `refactors/`：使用稳定的 `REFACTOR-0001` ID、改造前后职责边界、行为基线、验证证据和 README 索引。
- 不得重复使用或循环使用 ID。标题可以改名，但文件正文和链接中的 ID 必须稳定。

## 开发策略基线

在 `AGENTS.md`、功能开发指南、后端/schema 指南和重构指南中加入以下规则：

- 面向当前最佳实现，而不是旧数据形状或旧行为开发。
- 除非用户明确要求，不在运行时代码中保留旧 schema/API/UI 兼容性。
- 正常运行路径不增加双读/双写、启动迁移、临时同步、兼容回退或一次性修复代码。
- 现有数据处理属于明确的离线 SQL、脚本或重建说明。仅在被要求时创建这些一次性路径，且不能作为长期项目代码保留。
- 用户指令或公开契约要求兼容时，记录精确边界、退出条件和验证证据。

## 环境资源基线

- `docs/` 说明公开规则、示例和部署/开发模板；`.local/project-resources/` 或等价私有路径保存真实环境事实。
- Agent 默认使用 dev 上下文。生产操作需要明确 prod 上下文和明确确认。
- 环境加载脚本应在可行时强制隔离：dev/test 不得指向生产数据库、生产 Redis/缓存库、生产命名空间或生产根密钥。
- 只有 `test/README.md` 和环境加载脚本都记录时，test 才可以复用 dev。
- 生产发布备份应按 `YYYY-MM-DD_NNN` 版本化，包含产物、发布说明、校验和、回滚步骤和当前发布指针。
- 真实密钥、DSN、Authorization header、cookie、API key 和密码不得出现在公开文档、包文档、截图、聊天输出或日志中。

## AI 交付流水线基线

目标为“人提供需求，AI 负责执行”的项目应记录：

- 意图映射：开发/修复、部署到测试、发布到生产、回滚和生产诊断。
- 脚本入口：加载环境、预检、测试、构建、打包、部署、smoke、回滚和发布日志。
- 证据要求：命令输出、健康检查、smoke 结果、校验和、当前发布指针、必要时的截图和日志摘要。
- 停止条件：测试失败、密钥污染、缺少回滚、缺少备份、目标环境异常，或未确认的生产写入。
- 默认策略：通过门禁后可自动化测试部署；生产变更需要明确确认，除非存在独立的无人值守发布策略。

## 质量标准

- 不要留下只有 `README.md` 的目录。
- 不要创建提到复制来的产品专有模块的示例。
- 不得把设想中的功能写成既有事实。
- 架构文档要稳定耐用，计划文档保持临时性。
- 链接保持相对路径，以便仓库移动后仍可用。
- 不要留下模糊的“兼容性策略”表述；明确项目是只遵循当前模型，还是有具体兼容例外。
