# Workflow Design Contract

## Objective

Minimize expensive-model implementation tokens without weakening design quality or independent verification. Assign each phase to the cheapest model that satisfies its reasoning and reliability requirements.

## Architecture

Use a coordinator with phase-specific workers. The coordinator owns user intent, artifacts, dependencies, integration, and completion. Workers own bounded phase outputs.

```text
Sol/high design
      |
      v
Terra/high implementation
      |
      v
Sol/high independent review
      |
      +-- findings --> Terra/xhigh repair --+
      |                                      |
      +--------------------------------------+
      |
      v
Sol/high final verification
```

Sol is read-only in every path. It returns conclusions, designs, findings, and verification verdicts; it does not modify the workspace or external systems. The coordinator records the conclusion, and a non-Sol execution worker performs every resulting write: Terra for normal and escalated work, or Luna only for approved low-risk deterministic work.

Fully specified low-risk work may use Luna/high with mandatory Terra/high review.

```text
Luna/high execution
      |
      v
Terra/high mandatory review
      |
      +-- bounded findings --> Terra/xhigh repair --> fresh Terra/high review
      |
      +-- ambiguity or material risk --> normal Sol/Terra workflow
```

When Sol/high is unavailable, the normal route degrades as follows:

```text
Terra/xhigh design or review fallback
      |
      +-- must be a fresh worker, separate from Terra implementation or repair
      |
      +-- record "Sol unavailable -> Terra/xhigh" and residual risk
```

After normal repair-review work fails, use one evidence-gated escalation:

```text
Two failed repair-review cycles, unknown root cause,
or concrete user acceptance gap
      |
      v
Sol/xhigh re-investigation and revised design conclusion
      |
      v
Terra/xhigh scoped implementation
      |
      v
Independent final verification
      |
      +-- unresolved --> stop and report evidence
```

## Design Decisions

### Keep model switching at task boundaries

Do not rely on a running agent changing its own model. Reuse a matching current agent or create a worker with an explicit model and effort override. This keeps runtime identity observable.

### Hand off through artifacts

Cross-model workers may not receive complete conversation history. Treat `design.md`, `plan.md`, and `review.md` as the source of truth. Prompts point to these artifacts and restate the worker's bounded contract. Sol returns structured content for the coordinator to persist; Sol does not write the artifacts itself.

### Separate implementation from review

The implementation worker must not be the only reviewer of its own changes. Sol/high reads the actual diff and evidence. Repair is followed by a fresh Sol/high review.

Every Luna result receives the same separation: a distinct Terra/high worker reviews the actual output before completion. Luna is an executor, never the final verifier.

When Terra substitutes for Sol, use Terra/xhigh and preserve the same separation. A Terra implementer or repair worker may not review its own diff; if a fresh Terra/xhigh worker is unavailable, stop the high-risk phase and report the capability gap.

### Separate reasoning from execution

Sol never edits code, configuration, documentation, test fixtures, or task artifacts, and never performs external state changes. Its output is a structured conclusion. Terra applies conclusions, including the mechanical work of persisting planning artifacts when the coordinator is Sol.

### Verify capability at runtime

Model catalogs, App task creation, and subagent delegation can expose different model sets. Inspect the active tool schema before routing. Never infer that Luna can be spawned merely because it can start a top-level task.

### Avoid recursive Codex launches

Do not use nested `codex exec` as an automatic Luna workaround. Nested sessions complicate authority, instruction inheritance, output tracking, and concurrent workspace writes.

### Escalate effort only on evidence

Sol/xhigh is a recovery route, not a default. Enter it only after two failed repair-review cycles, an unproven or conflicting root-cause investigation, or user feedback tied to an observable acceptance gap. Create a new Sol/xhigh worker instead of assuming a Sol/high worker changed effort in place. Limit the task to one escalation by default.

## State Machine

| State | Required input | Exit condition | Next state |
| --- | --- | --- | --- |
| Classify | User request and repo instructions | Route and authorization established | Design or Simple Execute |
| Design | Evidence and requirements | Approved implementation contract | Implement or Complete |
| Implement | Design and acceptance criteria | Scoped diff plus test evidence | Review |
| Review | Actual diff and requirements | Findings or clean review | Repair or Verify |
| Repair | Confirmed findings | Corrected diff plus tests | Verify |
| Verify | Final diff and all evidence | Acceptance criteria met | Complete or Repair |
| Escalate | Evidence-gated unresolved result | Revised design and plan | Implement |
| Simple Execute | Fully specified low-risk steps | Luna output plus deterministic checks | Luna Review |
| Luna Review | Luna output and original acceptance criteria | Terra/high verdict | Complete, Repair, or Design |
| Complete | Verified result | Goal and artifacts closed | Stop |

Diagnosis-only requests transition from Design directly to Complete. High-risk unresolved findings transition to Stop rather than forced implementation.

## Artifact Contract

For complex tasks, prefer existing repository conventions. Otherwise use:

```text
.codex/workflows/<task-slug>/
├── design.md
├── plan.md
└── review.md
```

`design.md` contains requirements, evidence, proposed behavior, alternatives, risks, rollback, and acceptance criteria.

`plan.md` contains ordered phases, owners, model routes, dependencies, status, verification commands, and recorded fallbacks.

`review.md` contains review passes, findings, repairs, evidence, and the final verdict.

## Risk Controls

- Dry-run or simulate destructive, production, migration, permission, and external-system changes.
- Resolve exact targets before destructive actions.
- Keep implementation workers within declared file ownership.
- Serialize workers that can modify the same files or shared state.
- Require concrete evidence before adopting assumptions.
- Stop after two failed repair-review cycles unless the user explicitly extends the effort.
- Permit one Sol/xhigh escalation after those cycles; stop after its verification fails unless the user explicitly extends the effort.

## Cost Controls

- Keep broad code generation and mechanical changes on Terra.
- Keep Sol focused on evidence gathering, decisions, and review.
- Use Sol/xhigh only for the evidence-gated recovery route.
- Use Luna only for deterministic low-risk work and always budget a Terra/high review.
- Prefer deterministic tools and tests over additional reasoning tokens.
- Do not increase reasoning effort to compensate for an incomplete prompt or missing acceptance criteria.

## Known Capability Boundary

At the time this workflow was created, the local App supported Luna as a top-level model while the active subagent override exposed Sol and Terra only. The workflow therefore checks capabilities dynamically and uses an explicit fallback rather than hard-coding that temporary limitation.
