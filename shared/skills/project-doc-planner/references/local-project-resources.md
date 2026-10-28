# 私有层与项目资源参考

当项目需要规划 `.local/` 私有层、私有环境事实或交付流程时，使用本参考。只抽象目录结构、同步规则、安全边界和模板，不复制参考项目的真实域名、IP、账号、数据库名、密钥、连接串、业务命令或上线记录。

## 核心分层

- `docs/`：可提交的公开规则、通用模板、构建/部署边界、门禁、验收口径。
- `.local/`：整体被 `.gitignore` 忽略的私有层。AI 与维护者把不能入库的事实和材料都放这里，避免反复向用户索取；AI 在任务中收到的私密交付物也当场落盘到对应位置。固定成员是 `tmp/` 与 `project-resources/`，其余子目录按项目使用场景裁剪，布局见下节。
- `AGENTS.md`：只写路径、读取顺序和操作规则，不写明文密码、token、连接串或完整生产配置。
- 自动化脚本：把开发、测试发布、生产预检、上线、smoke、回滚和记录归档做成可重复命令，减少人工补充上下文。

如果项目不使用 `.local/` 这个名字，也要保留同等角色的私有层，并在 `AGENTS.md` 写清位置。

## `.local/` 私有层布局

`.local/` 整体从 Git 排除（推荐忽略规则 `/.local/`，新增子目录自动覆盖），内部全部是私有内容。`tmp/` 与 `project-resources/` 是固定成员；其余目录是按场景裁剪的候选，不为凑齐结构创建。

```text
.local/
├── tmp/                     # 固定：任务暂存与中间产物，随时可清空
├── project-resources/       # 固定：dev/test/prod 环境运行事实（结构见下节）
├── test-reports/            # 候选：与 docs/reports/ 报告互证的原始机器产物（JSON、log、profile）
├── document-archive/        # 候选：文档清理、重构、覆盖前的原文快照（可恢复材料）
├── recovery/                # 候选：高危变更前的回退与恢复材料
└── log/                     # 候选：本地运行与任务日志
```

固定成员规则：

- `tmp/` 在建立私有层时创建，不需要 README 和生命周期管理；只放可再生成或丢弃后不影响交付的产物（约定无唯一副本），可随时清空，怀疑含唯一副本时先移出再清空。
- 唯一副本、凭据、环境事实和需要与报告互证的材料不放 `tmp/`，按归属放入 `project-resources/` 或对应场景目录。
- 场景目录按项目实际使用场景取舍；保留时配一页 README 说明用途、保留期限和清空条件，格式遵循 [dir-readme-template.md](templates/dir-readme-template.md)。
- 场景目录与 `project-resources/` 子目录职责重叠时按归属裁决：运行与事故记录归环境分区的 `<env>/logs/`，`.local/log/` 只放不归属任何环境的本机与任务日志；发布备份与回滚材料随当次 `prod/releases/<版本>/` 归档，`.local/recovery/` 只放不属于任何 release 或环境目录的恢复材料。

## 推荐目录

以下是资源候选集合，只保留实际存在的环境与资源类别，不为凑齐目录创建账号、数据库或发布资料。仅需本地开发事实的项目可直接写一个 `dev/README.md`。环境入口使用 [env-readme-template.md](templates/env-readme-template.md)，资源子目录按下表职责与 [dir-readme-template.md](templates/dir-readme-template.md) 编写，具体操作使用 [operation-guide-template.md](templates/operation-guide-template.md)。

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

部署记录、发布材料与环境 README 的可复制模板见 [deploy-record-template.md](templates/deploy-record-template.md)、[release-materials-template.md](templates/release-materials-template.md)、[env-readme-template.md](templates/env-readme-template.md)。

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

- 生产高影响操作须有覆盖环境、目标、范围和副作用的明确授权；本次指令已覆盖时不重复询问。
- 发布前备份范围：env、数据库、缓存/队列、当前 release、反代配置。
- 每次发布创建 `releases/YYYY-MM-DD_NNN/`，保留 `release.md`、`checksums.txt`、`rollback.md`。
- 涉及旧数据保留时只做离线导出、清洗、导入、校验和归档，不把旧结构兼容写进运行时代码。

## 环境加载与隔离脚本

按实际交付需求复用已有脚本；以下名称是能力建议，不代表脚本已经存在，也不授权本次文档任务直接创建部署工具：

- `scripts/load-local-env.*`：按 `dev/test/prod` 读取私有 env；默认读取 dev。
- `scripts/preflight.*`：检查依赖、环境、Git 状态、构建前提、目标环境和 secrets 泄露风险。
- `scripts/package-release.*`：生成发布包、校验包内容、输出 checksums，不打包 `.local/`、真实 `.env`、数据库和日志。
- `scripts/deploy.*`：按环境部署或切换 release；生产路径默认只在明确确认后执行。
- `scripts/smoke.*`：按环境执行 health、migration status、数据库、缓存、队列、关键 API 和页面检查。
- `scripts/rollback.*`：读取当前 release 和目标 release，执行回滚步骤并验证。
- `scripts/write-release-log.*`：把命令结果、版本、校验和、验证和后续事项写入固定记录。
- test 复用 dev 时在脚本和 README 中显式映射，而不是隐式猜测。
- 生产 env 加载不作为默认开发命令的一部分；生产变更命令需要显式参数、确认和日志记录。
- 加载前隔离检查与输出脱敏的门禁规则见 [development-standards.md](development-standards.md) 的"环境资源与上下文规范"。

## 一条龙交付控制面

为了让人只提需求，项目应把自然语言意图映射到固定执行流。建议写在 `AGENTS.md` 和 `.local/project-resources/README.md`：

| 人工指令 | AI 执行流 | 默认确认 |
| --- | --- | --- |
| 开发、实现、修复 | 读文档 -> 写/更新计划 -> 改代码 -> 本地验证 -> 更新功能/问题/重构文档 | 不需要，除非需求不清 |
| 发测试 | 加载 test 或 dev 隔离 env -> 按实际契约迁移/部署 -> smoke -> 记录测试发布结果 | 用户指令明确覆盖目标与副作用时执行；共享环境、数据破坏等未覆盖动作先确认 |
| 上线 | 生产预检 -> 备份 -> 打包 -> 部署 -> smoke -> 记录 release -> 观察窗口 | 核对明确授权；未覆盖时完成准备后确认 |
| 回滚 | 读取 `current-release.txt` 和目标 `rollback.md` -> 评估数据影响 -> 执行 -> smoke -> 记录 | 核对明确授权；未覆盖时完成评估后确认 |
| 排查线上问题 | 只读读取 prod runbook/logs -> 执行只读诊断 -> 给出修复计划 | 写操作须有明确授权 |

每条执行流必须具备的要素（入口、环境、脚本、门禁、证据、停止条件、记录位置）统一见 [development-standards.md](development-standards.md) 的"AI 交付流水线规范"。

如果项目想要"无人值守上线"，其预授权边界与默认禁止规则见 [development-standards.md](development-standards.md) 的"AI 交付流水线规范"。

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

- `.local/` 整目录被 `.gitignore` 忽略（推荐规则 `/.local/`，新增子目录自动覆盖）；所有真实 env、账号、数据库备份、release 私有包必须位于其中或同等私有位置。
- 同时核对私有路径被忽略且未被 Git 跟踪；忽略规则不改变已跟踪文件。发现已提交秘密时报告位置和影响而不回显值，停止扩散；取消跟踪、历史处理与凭据轮换按各自授权执行。
- AI 在任务中收到的密码、token、密钥等私密交付物，当场按归属写入 `.local/` 对应位置并同步相应 README 索引；无对应环境分区时写入 `project-resources/` 下按用途命名的文件并在其 `README.md` 登记。后续任务直接复用，不要求用户重复提供，也不写入公开文档或回复正文。
- 公开 `docs/`、`AGENTS.md`、提交信息、PR 描述、聊天记录和发布包说明不写明文密钥或连接串。
- README 可以写文件路径、用途、生成时间、交付对象和脱敏示例；真实值放在私有 env、`.txt`、密钥管理系统或服务器本机文件。
- 生产发布包不应包含 `.local/`、`.env`、数据库文件、日志、账号文件或真实备份。
- 如果 AI 需要读取私有资源，只在当前任务需要的环境范围内读取；输出时只总结结构和状态，不回显秘密值。

## AGENTS.md 应包含

根目录 `AGENTS.md` 的章节结构与应包含内容统一见 [root-agents-template.md](root-agents-template.md)，不在此重复维护。
