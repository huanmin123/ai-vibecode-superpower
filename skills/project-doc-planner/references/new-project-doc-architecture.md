# New Project Docs Architecture Reference

## Principle

Use the reference repository only for documentation organization and project-rule patterns. Copy structure, index habits, maintenance rules, environment-resource separation, and validation expectations; do not copy business content.

Every directory must have:

- `README.md`: main entry document.
- One `示例` / `demo` document: a concrete example of the document type.
- Optional templates or topic documents if that directory needs repeatable records.

Default development rules should say that implementation targets the current best model, current schema, and current API/UI contract. Do not require backward compatibility, runtime old-field fallbacks, or migration branches unless the user explicitly requests them.

For projects with development, test, production, deployment, release, rollback, accounts, keys, databases, or third-party resources, plan a Git-ignored private resource layer in addition to `docs`. Public docs describe rules and templates; private resources hold current environment facts. Also plan an AI delivery pipeline so natural-language requests map to repeatable planning, validation, release, deploy, rollback, and logging flows.

## Complete Template Tree

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

## Private Project Resources Tree

Use this alongside `docs/` when environment facts should be reusable by AI and maintainers:

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

This directory must be ignored by Git. Generate placeholders and README guidance only; never invent or copy real credentials, IPs, domains, database names, or tokens.

## Main Document Outline

Use this for each directory `README.md`:

- 目录定位：本目录解决什么问题。
- 适用范围：哪些改动应先读这里。
- 文件索引：每个文件的职责。
- 新增规则：新增文档的命名、编号、放置位置。
- 维护规则：发生哪些变更时必须更新本目录。
- AI/维护者入口：推荐阅读顺序。

For `.local/project-resources` README files, use:

- 当前用途：dev/test/prod role and whether test reuses dev.
- 当前有效文件：env, account index, database, deploy, runbook, release pointers.
- 隔离边界：database, cache, queue, namespace, ports, domain, or cloud resource boundaries.
- 使用方式：load env, start services, run smoke, deploy, verify, or rollback.
- 禁止事项：no production DB in dev, no production secrets in public docs, no secret echoing.
- 维护规则：what to update after env, deploy, release, rollback, or incident changes.

## Demo Document Outline

Use this for each demo/example document:

- 示例背景：用泛化场景，不写参考项目业务。
- 目标与非目标：明确边界。
- 涉及文件：列出可能影响的代码和文档区域。
- 设计/处理过程：展示该类型文档应包含的核心内容。
- 验证方式：命令、手动路径、检查清单。
- 风险与后续：待确认、限制、下一步。

## Directory-Specific Demo Focus

- `docs/文档架构示例.md`: show a complete docs tree and update matrix.
- `architecture/架构示例.md`: show module boundaries, flows, non-goals, expansion points.
- `architecture/frontend/前端架构示例.md`: show page structure, components, interaction, copy, validation.
- `architecture/backend/后端架构示例.md`: show routes, services, storage, errors, jobs, middleware.
- `functions/功能设计示例.md`: show one feature's background, flow, fields, states, API/UI/storage impact.
- `plans/计划-0001-示例.md`: show an executable numbered plan without requiring a fixed phase name.
- `develop/开发流程示例.md`: show install, run, typecheck/test/build, manual verification.
- `deploy/部署流程示例.md`: show build package, env vars, startup, health check, rollback.
- `bug/问题-0001-示例.md`: show reproduce, root cause, fix, validation, prevention.
- `refactors/重构-0001-示例.md`: show motivation, split plan, changed files, validation, review.

## Maintenance Matrix

| Change type | Required docs |
| --- | --- |
| Docs structure change | `docs/README.md`, affected directory `README.md`, matching demo |
| Architecture boundary change | `architecture/README.md`, `architecture/架构总览.md`, `architecture/架构示例.md` if pattern changes |
| Frontend information architecture | `architecture/frontend/README.md`, frontend guidance/demo docs |
| Frontend list, table, responsive, or reusable component change | `architecture/frontend/样式规范.md`, `architecture/frontend/响应式列表规范.md`, `architecture/frontend/通用组件规范.md` as relevant |
| Backend layering or API boundary | `architecture/backend/README.md`, backend demo, function/API docs |
| Backend worker, queue, scheduled job, or batch side effect | `architecture/backend/后台任务使用说明.md`, backend demo, develop/deploy docs if runtime changes |
| New feature or workflow | `functions/README.md`, `functions/功能设计示例.md` pattern, `plans/*` when tracked |
| API, permission, or storage change | `functions/接口契约与权限矩阵.md`, `functions/数据存储说明.md`, validation docs |
| Current schema/API/UI model change | Storage/API/UI docs plus explicit note that runtime code follows the current model unless the user requested compatibility |
| Development command change | `develop/README.md`, run/test docs, development demo |
| Build or deployment change | `deploy/README.md`, build/deploy guides, deployment demo |
| Private env, account, database, deployment topology, or release fact change | Public docs only if rules/templates changed; update `.local/project-resources/<env>/...` for current facts |
| Test environment reuses dev or splits from dev | `develop/测试与验证说明.md`; update `.local/project-resources/test/` and env loading scripts |
| Production release or rollback | `deploy/` templates if process changed; update `.local/project-resources/prod/logs/`, `prod/releases/`, `current-release.txt`, and rollback notes |
| AI delivery pipeline or command mapping changes | `AGENTS.md`, `docs/develop/`, `docs/deploy/`; update `.local/project-resources/README.md` and related scripts |
| Recurring or important bug | `bug/README.md`, issue template, issue demo pattern |
| Large refactor | `refactors/README.md`, refactor template, refactor demo pattern |

## Numbered Record Patterns

- `plans/`: use stable `PLAN-0001` IDs, status fields, task checklist, test items, validation record, completion summary, and README index.
- `bug/`: use stable `BUG-0001` IDs, same-root recurrence records, related-bug links, cause/fix/verification/prevention, and README index.
- `refactors/`: use stable `REFACTOR-0001` IDs, before/after responsibility boundaries, behavior baseline, validation evidence, and README index.
- Never reuse or recycle IDs. Rename titles if needed, but keep IDs stable in file body and links.

## Development Policy Baseline

Include these rules in `AGENTS.md`, feature-development guidance, backend/schema guidance, and refactor guidance:

- Build toward the current best implementation, not old data shapes or old behavior.
- Do not keep old schema/API/UI compatibility in runtime code unless the user explicitly asks for it.
- Do not add dual-read/dual-write, startup migration, temporary sync, compatibility fallback, or one-time repair code to normal runtime paths.
- Existing data handling belongs in explicit offline SQL/script/rebuild instructions. Only create those one-time paths on request, and do not keep them as long-lived project code.
- If compatibility is required by user instruction or public contract, document the exact boundary, retirement condition, and validation evidence.

## Environment Resource Baseline

- `docs/` describes public rules, examples, and deploy/develop templates. `.local/project-resources/` or an equivalent private path stores real environment facts.
- Agent defaults to dev context. Production actions require explicit prod context and explicit confirmation.
- Env loading scripts should enforce isolation when practical: dev/test must not point to production database, production Redis/cache DB, production namespace, or production root secret.
- Test may reuse dev only when documented in both `test/README.md` and the env loading script.
- Production release backups should be versioned as `YYYY-MM-DD_NNN` and include artifacts, release notes, checksums, rollback steps, and a current-release pointer.
- Real secrets, DSNs, Authorization headers, cookies, API keys, and passwords must not appear in public docs, package docs, screenshots, chat output, or logs.

## AI Delivery Pipeline Baseline

Projects that aim for "human provides requirements, AI handles execution" should document:

- Intent mapping: develop/fix, deploy to test, release to production, rollback, and production diagnosis.
- Script entrypoints: load-env, preflight, test, build, package, deploy, smoke, rollback, and release-log.
- Evidence requirements: command output, health checks, smoke results, checksums, current release pointer, screenshots when useful, and log summaries.
- Stop conditions: failed tests, dirty secrets, missing rollback, missing backup, unexpected target environment, or production write without confirmation.
- Default policy: test deploy may be automated after passing gates; production changes require explicit confirmation unless a separate unattended-release policy exists.

## Quality Bar

- Do not leave directories with only `README.md`.
- Do not create demos that mention copied product-specific modules.
- Do not document aspirational features as existing facts.
- Keep architecture docs durable and plans temporary.
- Keep links relative so the docs work after moving repositories.
- Do not leave vague `compatibility strategy` wording; say whether the project follows the current model only or has an explicit compatibility exception.
