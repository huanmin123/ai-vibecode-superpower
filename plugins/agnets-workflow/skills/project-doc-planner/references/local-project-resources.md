# 私有项目资源目录参考

当项目需要 AI 在开发、测试、上线或运维时直接读取环境事实，使用本参考。只抽象目录结构、同步规则、安全边界和模板，不复制参考项目的真实域名、IP、账号、数据库名、密钥、连接串、业务命令或上线记录。

## 核心分层

- `docs/`：可提交的公开规则、通用模板、构建/部署边界、门禁、验收口径。
- `.local/project-resources/`：Git 忽略的私有运行事实，包括真实 env、账号索引、数据库连接、部署拓扑、上线流水、运维手册、发版备份和回滚材料。
- `AGENTS.md`：只写路径、读取顺序和操作规则，不写明文密码、token、连接串或完整生产配置。
- 自动化脚本：把开发、测试发布、生产预检、上线、smoke、回滚和记录归档做成可重复命令，减少人工补充上下文。

如果项目不使用 `.local/project-resources/` 这个名字，也要保留同等角色的私有目录，并在 `AGENTS.md` 写清位置。

## 推荐目录

```text
.local/project-resources/
├── README.md
├── dev/
│   ├── README.md
│   ├── env/
│   │   ├── README.md
│   │   └── shared.env
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
    ├── env/
    │   ├── README.md
    │   └── shared.env
    ├── accounts/README.md
    ├── database/README.md
    ├── deploy/
    │   ├── README.md
    │   ├── 部署拓扑.md
    │   ├── 上线检查清单.md
    │   └── 部署记录模板.md
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

## 文件职责

| 位置 | 职责 |
| --- | --- |
| `README.md` | 私有资源总入口、环境分区、安全规则、AGENTS 读取约定 |
| `dev/README.md` | 开发环境当前事实、默认 Agent 上下文、隔离边界 |
| `test/README.md` | 测试环境事实；无独立测试环境时声明复用 dev 和未来拆分条件 |
| `prod/README.md` | 生产事实入口、操作门禁、部署/运维/发版/回滚入口 |
| `env/README.md` | 当前有效 env 文件、加载方式、变量来源、禁止复制规则 |
| `accounts/README.md` | 账号文件索引、用途、交付记录；避免在 README 中堆叠明文密钥 |
| `database/README.md` | 数据库、缓存、队列、备份、恢复、离线迁移和禁止误连边界 |
| `deploy/README.md` | 真实服务器、域名、路径、反代、守护进程、上线步骤和检查清单 |
| `logs/README.md` | 上线记录、事故日志和索引 |
| `issues/README.md` | 当前环境已知问题、影响、状态和关联文档 |
| `runbooks/README.md` | 常用运维命令、回滚、恢复、证书、排障 SOP |
| `releases/README.md` | 版本目录命名、当前版本指针、产物、校验和、回滚材料 |

## README 最小大纲

每个环境入口至少写：

- 当前用途：开发、测试或生产。
- 当前有效文件：例如 `env/shared.env`、账号索引、部署方案、runbook。
- 环境隔离：数据库、缓存、队列、namespace、端口、域名或账号边界。
- 使用方式：加载 env、启动服务、运行 smoke、查看日志的入口。
- 禁止事项：不得连接生产库、不得复用生产密钥、不得复制连接串到公开文档等。
- 维护要求：修改真实环境后同步哪些 README、脚本、上线记录或 release。

`prod/README.md` 还要写：

- 生产操作必须先获得明确确认。
- 发布前备份范围：env、数据库、缓存/队列、当前 release、反代配置。
- 每次发布创建 `releases/YYYY-MM-DD_NNN/`，保留 `release.md`、`checksums.txt`、`rollback.md`。
- 涉及旧数据保留时只做离线导出、清洗、导入、校验和归档，不把旧结构兼容写进运行时代码。

## 环境加载与隔离脚本

建议配套脚本把文档规则变成硬门禁：

- `scripts/load-local-env.*`：按 `dev/test/prod` 读取私有 env；默认读取 dev。
- `scripts/preflight.*`：检查依赖、环境、Git 状态、构建前提、目标环境和 secrets 泄露风险。
- `scripts/package-release.*`：生成发布包、校验包内容、输出 checksums，不打包 `.local/`、真实 `.env`、数据库和日志。
- `scripts/deploy.*`：按环境部署或切换 release；生产路径默认只在明确确认后执行。
- `scripts/smoke.*`：按环境执行 health、migration status、数据库、缓存、队列、关键 API 和页面检查。
- `scripts/rollback.*`：读取当前 release 和目标 release，执行回滚步骤并验证。
- `scripts/write-release-log.*`：把命令结果、版本、校验和、验证和后续事项写入固定记录。
- test 复用 dev 时在脚本和 README 中显式映射，而不是隐式猜测。
- dev/test 加载前检查数据库名、Redis DB、namespace、端口、服务名或云资源标签，发现生产目标时拒绝加载。
- 生产 env 加载不作为默认开发命令的一部分；生产变更命令需要显式参数、确认和日志记录。
- smoke、migration、package、deploy 脚本不得把 DSN、token、Authorization、API Key、Cookie 或密码打印到普通输出。

## 一条龙交付控制面

为了让人只提需求，项目应把自然语言意图映射到固定执行流。建议写在 `AGENTS.md` 和 `.local/project-resources/README.md`：

| 人工指令 | AI 执行流 | 默认确认 |
| --- | --- | --- |
| 开发、实现、修复 | 读文档 -> 按任务记录判定决定是否写/更新记录 -> 改代码 -> 本地验证 -> 按需更新相关文档 | 不需要，除非需求不清 |
| 发测试 | 加载 test 或 dev 隔离 env -> 迁移/部署 -> smoke -> 记录测试发布结果 | 通常不需要 |
| 上线 | 生产预检 -> 备份 -> 打包 -> 部署 -> smoke -> 记录 release -> 观察窗口 | 需要明确确认 |
| 回滚 | 读取 `current-release.txt` 和目标 `rollback.md` -> 评估数据影响 -> 执行 -> smoke -> 记录 | 需要明确确认 |
| 排查线上问题 | 只读读取 prod runbook/logs -> 执行只读诊断 -> 给出修复计划 | 写操作需要确认 |

每条执行流都应具备：

- 输入：需求描述、计划编号、目标环境、目标 release 或问题编号。
- 上下文：公开文档入口、私有资源入口、env 文件、账号索引、数据库/缓存边界。
- 命令：固定脚本或明确命令，不依赖人工现场拼接。
- 门禁：Git 状态、构建、测试、smoke、备份、回滚材料、敏感信息扫描。
- 输出：验证摘要、日志路径、release 目录、回滚步骤、后续观察项。
- 失败策略：失败即停止、自动回滚、要求人工确认或转入问题记录。

如果项目想要“无人值守上线”，必须额外写清预授权边界：允许的分支、时间窗口、变更类型、最大数据影响、自动回滚阈值、通知渠道和审计记录。默认不要让 AI 无确认修改生产。

## 公开文档同步规则

| 变化 | 更新公开文档 | 更新私有资源 |
| --- | --- | --- |
| 开发启动命令或 env 加载方式变化 | `docs/develop/运行说明.md`、`docs/develop/测试与验证说明.md` | `dev/env/README.md`、加载脚本 |
| 新增测试环境或 test 不再复用 dev | `docs/develop/测试与验证说明.md` | `test/README.md`、`test/env/README.md`、隔离脚本 |
| 生产部署拓扑变化 | `docs/deploy/README.md`、`docs/deploy/部署指南.md` | `prod/deploy/README.md`、拓扑、runbook |
| 环境变量新增、重命名或删除 | `.env.example`、develop/deploy 文档 | 对应环境 `env/README.md` 和 `shared.env` |
| 数据库、缓存、队列或 namespace 变化 | 存储说明、部署指南、验证说明 | `database/README.md`、env、smoke/runbook |
| 上线发布 | 部署模板或上线计划需要时更新 | `prod/logs/`、`prod/releases/<版本>/`、`current-release.txt` |
| 回滚或事故 | `docs/bug/` 或部署检查清单需要时更新 | `prod/logs/`、`prod/issues/`、`prod/runbooks/` |
| 旧数据保留 | 存储说明、部署指南、计划 | `prod/database/`、当次 release 的导出/清洗/校验/回滚材料 |
| 交付流水线或用户指令映射变化 | `AGENTS.md`、`docs/develop/`、`docs/deploy/` | `.local/project-resources/README.md`、相关脚本、runbook |

## 安全规则

- `.local/` 和所有真实 env、账号、数据库备份、release 私有包必须被 `.gitignore` 忽略。
- 公开 `docs/`、`AGENTS.md`、提交信息、PR 描述、截图、聊天记录和发布包说明不写明文密钥或连接串。
- README 可以写文件路径、用途、生成时间、交付对象和脱敏示例；真实值放在私有 env、`.txt`、密钥管理系统或服务器本机文件。
- 生产发布包不应包含 `.local/`、`.env`、数据库文件、日志、账号文件或真实备份。
- 如果 AI 需要读取私有资源，只在当前任务需要的环境范围内读取；输出时只总结结构和状态，不回显秘密值。

## AGENTS.md 应包含

- 私有资源目录路径和 Git 忽略要求。
- Agent 默认读取 dev；test 复用 dev 时的规则；生产操作前必须切换 prod 并获得明确确认。
- 本地启动命令和是否加载私有 env。
- dev/test/prod 的隔离红线，例如生产库、生产缓存 DB、生产 namespace 和生产密钥不得用于开发。
- 用户指令映射：开发、发测试、上线、回滚、线上排查分别走哪些脚本、环境和记录位置。
- 发布备份和 release 命名规则。
- 真实凭据只保存在私有目录或密钥系统，禁止写入公开文档和最终回复。
