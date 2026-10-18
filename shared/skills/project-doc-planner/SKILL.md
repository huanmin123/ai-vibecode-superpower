---
name: project-doc-planner
description: 设计或更新项目文档架构、根目录 AGENTS.md、开发规范和可复用模板，以及适用时的私有环境资源与交付流程。用于文档规划或整理，不因普通开发、部署或修复任务自动重建文档体系。
---

# 项目文档规划器

只创建项目真正需要的文档结构。本 skill 只定义路由与质量约束；详细目录树和模板放在参考文件中，仅在任务命中时加载。

## 先确定范围

1. 提出结构前，阅读仓库的 `AGENTS.md`、`README*`、包清单、顶层目录和现有 `docs/`。
2. 识别项目类型、源码边界、用户、环境、部署需求和既有文档惯例。未知事实标记为 `待确认`，不得编造产品细节、主机、凭据、数据库名或命令。
3. 区分稳定公开规则、临时计划或复审记录，以及私有运行事实。小型配置包或范围狭窄的仓库不应生成完整文档骨架。
4. 保留已有项目义务；否则以当前 schema、API 契约和 UI 流程为准，不为旧结构引入长期运行时兼容路径。

## 核心边界

- `docs/` 保存可提交的稳定契约、规则、模板和脱敏的计划/问题/重构记录；私有环境事实、凭据、发布产物和原始运行记录放在 Git 忽略目录，例如 `.local/project-resources/`。
- 每个保留的 `docs/` 目录都有 `README.md`；按需增加模板或专题文档，不单独维护示例文档。
- 默认用简体中文编写项目文档。代码、命令、路径、配置键、协议字段和有契约意义的原文保持不变；项目明确采用其他语言时遵从项目约定。
- 设计必须写明目标、非目标、可观察行为、关键取舍、重要风险和待解决问题。稳定行为契约保留在设计中；本次测试项、验收清单和实际证据记在计划或对应问题/重构/部署记录中，关联记录用链接复用证据。只有影响决策、风险、回滚或用户明确要求时才展开实现细节。
- 将高频用户意图映射为含输入、预检、执行、成功证据、失败处理和记录位置的流程。范围内的开发和本地验证自动执行；生产写入、回滚、凭据变更和其他高影响动作保留其授权门槛。
- 不得复制参考仓库的产品专属模块、API、供应商、主机、账号、密钥或历史记录。

## 按需加载参考

| 需要 | 读取参考 |
| --- | --- |
| 完整公开文档树、目录职责或文档大纲 | [doc-architecture.md](references/doc-architecture.md) |
| 开发规范、架构、前后端边界、安全或验证 | [development-standards.md](references/development-standards.md) |
| dev/test/prod 上下文、私有资源、部署、发布、回滚或环境隔离 | [local-project-resources.md](references/local-project-resources.md) |
| 可复用的项目根目录指令文件 | [root-agents-template.md](references/root-agents-template.md) |
| `docs/` 及子目录 `README.md` 格式 | [dir-readme-template.md](references/templates/dir-readme-template.md)；项目根 README 保留使用手册定位 |
| 架构总览格式 | [architecture-overview-template.md](references/templates/architecture-overview-template.md) |
| 长期测试与验证说明格式 | [verification-guide-template.md](references/templates/verification-guide-template.md) |
| 压测、验收、审计或专项分析报告格式 | [report-template.md](references/templates/report-template.md) |
| 安装、运行、构建、部署、回滚或 runbook 格式 | [operation-guide-template.md](references/templates/operation-guide-template.md) |
| 长期需求与行为契约格式 | [feature-design-template.md](references/templates/feature-design-template.md) |
| 单次交付计划与证据格式 | [plan-template.md](references/templates/plan-template.md) |
| 跨会话未完成事项清单（阻塞、待确认、待办、观察项）格式 | [todo-blockers-template.md](references/templates/todo-blockers-template.md) |
| 问题（bug）记录格式 | [bug-template.md](references/templates/bug-template.md) |
| 重构记录格式 | [refactor-template.md](references/templates/refactor-template.md) |
| 部署记录格式 | [deploy-record-template.md](references/templates/deploy-record-template.md) |
| 发布材料（release / rollback / checksums）格式 | [release-materials-template.md](references/templates/release-materials-template.md) |
| 私有环境 README 格式 | [env-readme-template.md](references/templates/env-readme-template.md) |

任务选择了哪个参考，就完整阅读哪个。填写模板时也读取对应架构、开发规范或私有资源参考中的相关约束，不能仅凭模板补全政策；不要因文件存在而加载全部参考。模板中的路径和章节是待裁剪的候选，成品只保留实际存在的相对链接和适用内容。

## 规划与产出

1. 提出最小可用结构，并说明每个保留目录的必要性。
2. 有多环境或运维需求时，创建或规划被 `.gitignore` 保护的私有资源层。
3. 让根 `AGENTS.md` 链接项目读取顺序、交付流程、环境边界和验证预期；持久政策只保留一个权威位置。
4. 使用相对 Markdown 链接创建或更新文件。模板保持通用、占位符清晰；复制后删去 skill 使用说明，改写指向 skill 的链接，只保留目标项目适用的内容。
5. 验证目录入口、模板覆盖、链接目标、忽略规则，以及交付流程、脚本、环境规则和验证说明的一致性。Git 忽略须同时核对目标路径被忽略且未被跟踪；已跟踪的私有文件不能仅靠新增忽略规则宣称安全，不自动取消跟踪或改写历史。

## 必须交付

文档架构任务应返回或创建：

- 建议目录树及每个保留目录的简要职责；
- 公开/私有边界及适用时的 Git 忽略证据；
- 交付流程映射和相关操作的授权边界；
- 首批需创建或更新的文件、验收证据和未解决假设；
- 用户要求时提供清晰可读的 `AGENTS.md` 大纲。

报告具体改动文件、已执行验证、重要限制和下一项可执行决策。不得仅因生成了目录树就宣称文档结构完成。
