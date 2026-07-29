# Clear Communication Guidance Plan

- Goal: Add a durable global communication and design-expression contract.
- Authorization: Implement documentation-only changes.
- Scope: `codex-global-config/AGENTS.md` and this workflow directory.
- Non-goals: Change installed files directly, alter model routing, or rewrite unrelated instructions.
- Risk: Medium.
- Rollback: Revert the new AGENTS.md section and workflow records.
- Acceptance: The source AGENTS.md directs agents to provide concrete, understandable, proportionate outputs and designs.

| Phase | Owner | Model/effort | Dependencies | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Classify and design | Coordinator | current | user request and official guidance | completed | `design.md` |
| Record artifacts | Coordinator | current | design | completed | this directory |
| Implement AGENTS.md guidance | Implementer | current | coordinator-accepted design | completed | scoped diff |
| Review | Independent reviewer | Sol/high | implementation | completed | `review.md` |
| Final verification | Independent reviewer | Sol/high | review repairs | completed | final Sol/high review and static checks |

## Verification

1. Read the new AGENTS.md section against the acceptance criteria in `design.md`.
2. Check Markdown structure and targeted text with `rg`.
3. Review the actual diff for conflicts, ambiguity, excessive prescription, and unrelated changes.
