# AI Configuration Alignment Design

- Goal: Make the configuration package easier for AI agents to load, route, verify, and maintain, using concise task-specific instructions and references.
- Authorization: Reorganize configuration-package documentation, skills, and maintenance metadata. Preserve installer behavior unless an explicit defect is found.
- Scope: `codex-global-config/`, `skills/`, root documentation, installer documentation, and repository hygiene files.
- Non-goals: Create a generic application-documentation tree, change external provider credentials, alter destructive/production approval boundaries, or rewrite working helper implementations without evidence.
- Risk: Medium. The package is installed as global Codex guidance.
- Rollback: Revert scoped documentation, skill-routing, and hygiene changes.

## Evidence

- This repository is a small global-configuration installer, not an application repository. Its stable boundaries are global guidance, system documents, reusable skills, and installers.
- The official GPT-5.6 guide recommends lean prompts, each instruction stated once, specific autonomy boundaries, and output requirements that retain conclusion, evidence, caveats, and next action.
- `project-doc-planner` contains detailed reference files already, so repeating full documentation architectures in the skill entry increases prompt load without adding task-specific direction.
- The repository contains a tracked macOS `.DS_Store` artifact inside a skill and no root `.gitignore` to prevent it from recurring.

## Decisions

1. Add an explicit autonomy boundary: internal orchestration and safe local work are automatic; only material external or destructive actions require confirmation.
2. Keep skill entry files short and route detailed requirements to the existing reference files based on task shape.
3. Add package-level reading order and maintenance guidance at the README and global-doc entry points.
4. Preserve cross-platform installer logic and helper scripts; validate them instead of rewriting them without observed defects.
5. Remove machine metadata and prevent it from being recommitted.

## Acceptance

- An agent can determine where to start, what to load, and what it may do without asking for internal orchestration approval.
- Reusable skills declare concise scope, dispatch conditions, required evidence, and reference routing without duplicated long-form rules.
- README, AGENTS, docs, and skills agree on stable rules versus temporary workflow records.
- Installers still locate the same sources and install the same targets.
- Repository search and Git state show no obsolete source-directory references or machine metadata.
