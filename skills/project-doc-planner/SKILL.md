---
name: project-doc-planner
description: Use when Codex needs to design or update reusable project documentation, development standards, multi-environment resource boundaries, or an AI delivery workflow. Triggers include a docs architecture, root AGENTS.md, dev/test/prod context, private .local/project-resources, planning/bug/refactor records, deployment, rollback, and verification rules.
---

# Project Documentation Planner

Create only the documentation structure the project needs. This skill is the routing and quality contract; detailed trees and templates live in the referenced files and are loaded only when their topic is in scope.

## Establish Scope First

1. Read the repository `AGENTS.md`, `README*`, package manifest, top-level directories, and existing `docs/` before proposing a structure.
2. Identify the project type, source boundaries, users, environments, deployment needs, and existing documentation conventions. Mark unknown facts as `待确认`; do not invent product details, hosts, credentials, database names, or commands.
3. Separate stable public rules, temporary plans or review records, and private runtime facts. Do not create a full documentation skeleton for a small configuration package or another narrow repository.
4. Preserve current project obligations. Otherwise, default to the current schema, API contract, and UI flow; do not introduce long-lived runtime compatibility paths for old structures.

## Core Boundaries

- `docs/` holds committed, stable rules, templates, and acceptance criteria. Private environment facts, credentials, release artifacts, and operational records belong in a Git-ignored private directory such as `.local/project-resources/`.
- Every retained `docs/` directory has a `README.md` and one concrete example. Add templates or topic documents only when they will be reused.
- Use clear, task-specific terminology. A design must state its goal, non-goals, observable behavior, key tradeoffs, material risks, acceptance evidence, and open questions. Include implementation detail only when it affects a decision, risk, rollback, or explicit user request.
- Convert recurring user intents into an explicit flow with inputs, preflight, execution, success evidence, failure handling, and record location. Development and local validation proceed automatically within scope; production writes, rollback, credential changes, and other high-impact actions retain their documented authorization gates.
- Never copy a reference repository's product-specific modules, APIs, vendors, hosts, accounts, secrets, or historical records.

## Load References On Demand

| Need | Read this reference |
| --- | --- |
| Full public documentation tree, role definitions, or initial outline | [new-project-doc-architecture.md](references/new-project-doc-architecture.md) |
| Development standards, architecture, frontend/backend boundaries, security, or verification | [development-standards.md](references/development-standards.md) |
| Dev/test/prod context, private resources, deployment, release, rollback, or environment isolation | [local-project-resources.md](references/local-project-resources.md) |
| A reusable root project instruction file | [root-agents-template.md](references/root-agents-template.md) |

Load every reference selected by the task completely. Do not load a reference merely because it exists, and do not reproduce its long templates in this file or in an unrelated response.

## Plan And Produce

1. Propose the smallest useful structure and explain why each retained directory exists.
2. For projects with multiple environments or operational work, add or plan the ignored private resource layer and verify `.gitignore` protects it.
3. Link the root `AGENTS.md` to the project reading order, delivery flow, environment boundaries, and verification expectations. Keep durable policy in one authority rather than repeating it in every document.
4. Create or update files using relative Markdown links. Keep examples generic and placeholders explicit.
5. Verify directory entry points, example-document coverage, link targets, ignore rules, and consistency between delivery flow, scripts, environment rules, and verification guidance.

## Required Result

For a documentation-architecture request, provide or create:

- the proposed tree and concise responsibility of each retained directory;
- the public/private boundary and Git-ignore evidence when applicable;
- the delivery-flow mapping and authorization boundary for relevant operations;
- the first files to create or update, their acceptance evidence, and unresolved assumptions;
- a readable `AGENTS.md` outline when one is requested.

Report concrete files changed, verification performed, material limitations, and the next actionable decision. Do not claim a structure is complete solely because a directory tree was generated.
