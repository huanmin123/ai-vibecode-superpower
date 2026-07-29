# Root AGENTS.md Template

## Purpose

Use this template to create a reusable project-level `AGENTS.md`. It should define project-wide operating rules, document-reading order, and change habits without copying any reference project's business content.

## Recommended Sections

### Project Overview

- Project name
- One-sentence positioning
- Primary users
- First usable loop
- Current phase or maturity

### Work Principles

- Prefer a lightweight closed loop first.
- Update docs before changing architecture boundaries.
- Default to current-best implementation: current schema, current API contract, current UI flow, and current project conventions.
- Do not preserve backward compatibility unless the user explicitly requests it or an existing project instruction makes it mandatory.
- Keep terminology clear and consistent.
- Avoid introducing heavy abstractions too early.

### Compatibility Policy

- Runtime code should not keep old fields, old request shapes, old routes, old table structures, or old UI flows for compatibility by default.
- Do not add dual-read, dual-write, startup migration, temporary sync, compatibility fallback, migration markers, or one-off data repair to normal runtime paths.
- Existing data handling belongs in explicit offline SQL/script/rebuild instructions. Create those only when requested, and keep them out of long-lived runtime code.
- If compatibility is required, document the user request or project constraint, exact scope, retirement condition, and validation evidence.

### Reference Entry Points

- `docs/README.md`
- `docs/architecture/README.md`
- `docs/functions/README.md`
- `docs/plans/README.md`
- `docs/develop/README.md`
- `docs/deploy/README.md`
- `docs/bug/README.md`
- `docs/refactors/README.md`
- `.local/project-resources/README.md`（私有环境上下文；仅在当前任务需要时读取）

### Directory Conventions

- `frontend/`: UI pages, components, styles, and interactions.
- `backend/`: APIs, services, storage, middleware, and jobs.
- `docs/`: documentation, plans, references, and maintenance notes.
- `.local/project-resources/`: Git-ignored private resources for dev/test/prod env, accounts, databases, deploy facts, logs, runbooks, releases, and rollback material.

### Environment Context

- Agent defaults to the `dev` context.
- If `test` reuses `dev`, state that explicitly and list the actual env/database/cache/queue boundaries.
- Production operations require explicit user confirmation and a switch to `prod` resources.
- Real credentials, DSNs, tokens, cookies, private keys, database backups, and release private artifacts stay in `.local/project-resources/` or a secret manager, not in public docs or final responses.
- Env loading scripts should reject dev/test configs that point to production databases, production cache/queue DBs, production namespaces, or production root secrets.

### AI Delivery Pipeline

- "Develop/fix X": read docs, create or update a plan, implement, verify locally, update relevant docs.
- "Deploy to test": load test or dev-isolated env, run migration/deploy/smoke, record validation.
- "Release to production": run production preflight, prepare backup and rollback, show summary, wait for explicit confirmation, deploy, smoke, and archive release.
- "Rollback": read current release and rollback notes, assess data impact, wait for confirmation, execute, smoke, and record result.
- "Investigate production": use prod runbooks and logs in read-only mode by default; ask before writes, restarts, migrations, cache clearing, config changes, or rollback.
- If unattended production release is allowed, document the pre-authorization boundary, allowed branches, change types, time window, automatic rollback threshold, notification channel, and audit log.

### Module Boundaries

- List core modules using placeholders or actual project terms.
- Describe each module's responsibility and what it should not contain.
- Keep the boundary description generic enough to reuse across projects.

### Change Habits

- When adding fields, define defaults, current schema behavior, and offline handling for existing data if requested.
- When adding APIs, update contracts and validation docs.
- When changing storage, update storage docs and migration notes.
- When adding scripts or deploy steps, update develop/deploy docs.
- When changing real env, accounts, database, cache, queue, domain, reverse proxy, daemon, deployment path, release, or rollback material, update `.local/project-resources/<env>/...` first; update public docs only when reusable rules or templates changed.
- When fixing bugs, record reproduction, cause, fix, and verification.
- When refactoring large code, record split plan, risk, and validation.

### Verification Expectations

- List the usual typecheck, test, build, and manual verification commands.
- Describe the minimal evidence required before marking work complete.
- Note any project-specific constraints or environments.
- For deployment or env changes, include evidence that secrets were not committed, env loading used the intended environment, smoke output was redacted, and rollback material exists.
- For delivery pipeline changes, include evidence that intent mapping, scripts, gates, release logging, and rollback path were updated together.

## Writing Rules

- Keep sections short and reusable.
- Use placeholders instead of project-specific examples when possible.
- If a project has special constraints, add them below the generic template.
