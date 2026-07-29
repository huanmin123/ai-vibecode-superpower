# Execution Plan Template

Use this template for complex tasks. Adapt it to repository conventions without dropping required fields.

Sol-owned rows are analysis-only: Sol returns the conclusion, while the coordinator records it and a non-Sol execution worker performs every workspace or external-state write: Terra for normal and escalated work, or Luna only for coordinator-accepted low-risk deterministic work.

## Plan Header

```markdown
# <Task> Plan

- Goal: <measurable outcome>
- Authorization: diagnose-only | implement | destructive action authorization granted
- Scope: <included systems/files>
- Non-goals: <explicit exclusions>
- Risk: low | medium | high
- Rollback: <recovery method or not applicable>
- Acceptance: <observable completion criteria>
```

## Phase Checklist

```markdown
| Phase | Owner | Model/effort | Dependencies | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Classify | Coordinator | current | none | in_progress | |
| Explore/design | Architect | Sol/high | classification | pending | design.md |
| Implement | Implementer | Terra/high | coordinator-accepted design | pending | diff/tests |
| Review 1 | Reviewer | Sol/high | implementation | pending | review.md |
| Repair | Fixer | Terra/xhigh | confirmed findings | pending | diff/tests |
| Review 2 | Verifier | Sol/high | repair | pending | final verdict |
| Escalated analysis/design | Architect | Sol/xhigh | evidence-gated failure | conditional | revised design.md |
| Escalated implementation | Implementer | Terra/xhigh | coordinator-accepted revised design | conditional | diff/tests |
| Escalated verification | Verifier | Sol/high | escalated implementation | conditional | final verdict |
```

Remove the repair row only after a clean first review. Record actual model routes rather than planned routes when they differ.

When Sol/high is unavailable, replace each affected Sol phase with a distinct Terra/xhigh worker and add `Sol unavailable -> Terra/xhigh` to the Fallbacks field. Do not assign the Terra implementer or repair worker to review its own diff.

Use the escalated rows only after two failed repair-review cycles, an unproven or conflicting root cause, or user feedback tied to a concrete acceptance gap. Create a new read-only Sol/xhigh worker for that phase; do not claim an existing Sol/high worker changed effort in place. The coordinator records its conclusion and Terra/xhigh implements it. Limit the plan to one escalation by default.

## Luna Path

Use this path only for fully specified low-risk work. Do not omit the Terra/high review.

```markdown
| Phase | Owner | Model/effort | Dependencies | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Execute | Executor | Luna/high | classification | pending | output/checks |
| Review Luna output | Reviewer | Terra/high | Luna execution | pending | review.md |
| Repair findings | Fixer | Terra/xhigh | confirmed findings | conditional | diff/checks |
| Re-review repair | Reviewer | Terra/high | repair | conditional | final verdict |
```

Escalate to the full Sol/Terra path if the reviewer discovers ambiguity, material risk, or required design work.

## Design Checklist

- [ ] User intent and write authorization are clear.
- [ ] Repository instructions and existing patterns were inspected.
- [ ] Facts, inferences, and unknowns are separated.
- [ ] Scope and non-goals prevent unrelated changes.
- [ ] Alternatives and material tradeoffs are recorded.
- [ ] High-risk operations have a simulation and rollback plan.
- [ ] Acceptance criteria and verification commands are measurable.
- [ ] Ownership boundaries allow safe worker delegation.

## Implementation Checklist

- [ ] The worker received artifact paths and a self-contained contract.
- [ ] Changes remain within scope and established architecture.
- [ ] Boundary, error, concurrency, and security behavior are handled proportionally.
- [ ] Tests cover changed behavior and important regressions.
- [ ] Documentation is updated when contracts or operation changed.
- [ ] The worker reported assumptions and remaining risks.
- [ ] Every Luna execution has a separate Terra/high review before completion.

## Review Checklist

- [ ] Reviewer inspected the actual diff and current files.
- [ ] Requirements and acceptance criteria were checked individually.
- [ ] Findings include severity, evidence, and precise location.
- [ ] User dissatisfaction, if any, was translated into a concrete acceptance gap before escalation.
- [ ] Performance, security, concurrency, and compatibility were considered.
- [ ] Abstraction fit, over-design, and over-defence were considered.
- [ ] Test quality and empirical evidence were assessed.
- [ ] Repair was followed by a fresh independent review.

## Completion Record

```markdown
## Completion

- Actual routes: <phase -> model/effort>
- Fallbacks: <none or reason and substitute>
- Verification: <commands and results>
- Review verdict: clean | residual findings
- Residual risk: <specific gaps>
- Goal status: complete | blocked
```
