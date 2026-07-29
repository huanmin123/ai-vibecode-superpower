---
name: orchestrate-model-workflow
description: "Route software work through a cost-aware multi-model workflow: GPT-5.6 Sol/high for exploration, architecture, bug or vulnerability analysis, and independent review; GPT-5.6 Terra/high for implementation; Terra/xhigh for review-driven repairs; Sol/high for final verification; and GPT-5.6 Luna/high for deterministic, low-risk, fully specified repetitive tasks followed by Terra/high review. Use for complex coding, feature development, refactoring, debugging, security investigation, implementation from an approved plan, code review, or requests to reduce cost by assigning different development phases to different Codex models."
---

# Orchestrate Model Workflow

Use a coordinator-and-workers workflow. Keep phase ownership explicit and never claim that a model switch occurred unless the runtime or tool call confirms it.

## Keep Sol Analysis-Only

Treat Sol as the core reasoning brain, not an executor. Sol workers may inspect evidence and return structured diagnoses, designs, findings, and verification verdicts, but must not edit workspace files, apply patches, change configuration, invoke destructive commands, or make external state changes.

The coordinator records Sol's conclusions in the task artifacts. When the coordinator is itself Sol, delegate that mechanical write to Terra without changing the conclusion. Non-Sol execution workers own every workspace and external-state modification: Terra for normal and escalated implementation, and Luna only for approved low-risk deterministic work.

## Load The Contract

Read [references/workflow-design.md](references/workflow-design.md) completely before routing work. For complex tasks, also read [references/execution-plan.md](references/execution-plan.md) and use its artifact and phase checklist.

## Request Exact Routes

When the active tool accepts literal model IDs, request these routes:

| Phase | Model ID | Reasoning effort |
| --- | --- | --- |
| Explore, design, investigate, review, verify | `gpt-5.6-sol` | `high` |
| Implement an approved plan | `gpt-5.6-terra` | `high` |
| Repair confirmed review findings | `gpt-5.6-terra` | `xhigh` |
| Fully specified, low-risk repetitive execution | `gpt-5.6-luna` | `high` |
| Mandatory review of every Luna result | `gpt-5.6-terra` | `high` |
| Sol unavailable for high-risk design, review, or verification | `gpt-5.6-terra` | `xhigh` |
| Escalated unresolved diagnosis or redesign | `gpt-5.6-sol` | `xhigh` |

Use the parameter names required by the actual tool schema, such as `model` with `reasoning_effort` or `thinking`.

## Preserve User Intent

- Treat answer, explanation, review, status, and diagnosis requests as read-only unless the user also asks for implementation.
- Continue through implementation only for build, change, fix, or equivalent requests.
- Keep destructive operations, external writes, production changes, commits, and new App tasks within the authority granted by the user and the host product.
- Apply more specific repository instructions in addition to this workflow.

## Classify The Work

Choose the narrowest applicable route:

| Class | Criteria | Preferred route |
| --- | --- | --- |
| Simple execution | Steps and expected result are complete, risk is low, and no material design choice remains | Luna/high, then mandatory Terra/high review |
| Exploration | Requirements, architecture, root cause, vulnerability, or solution is uncertain | Sol/high |
| Planned implementation | An approved design and measurable acceptance criteria exist | Terra/high |
| Review | Inspect completed code for correctness, regressions, evidence, and omissions | Sol/high |
| Repair | Fix confirmed review findings without redesigning unrelated code | Terra/xhigh |
| Final verification | Re-evaluate the resulting diff and evidence after repair | Sol/high |
| Escalated investigation | Two repair-review cycles failed, the root cause remains unproven, or user feedback identifies a concrete acceptance gap | Sol/xhigh, then Terra/xhigh |

Do not classify a task as simple merely because it is short. Security-sensitive, destructive, schema-changing, concurrent, or production-impacting work is never simple.

## Verify Routing Capability

Before the first delegation:

1. Inspect the actual callable delegation tool schema for supported model and reasoning overrides.
2. Treat that schema as authoritative for subagents. A model appearing in a CLI catalog does not prove that the subagent tool can use it.
3. Reuse the current agent for a phase only when its model and reasoning effort are confirmed to match the preferred route. Otherwise delegate the phase.
4. When a model override cannot use full-history inheritance, pass a bounded turn fork or no fork and provide artifact paths plus a self-contained task contract.
5. If a required Sol/high route is unavailable, confirm that a distinct Terra/xhigh worker can be created before using the documented degraded route.
6. Use Sol/xhigh only through the escalation criteria in this skill. Do not increase effort merely because a task looks difficult.
7. Record every fallback in the task plan and final result.

## Run The Workflow

### 1. Establish State

For a complex task:

- Create a tracked goal when a goal tool is available.
- Use the repository's existing planning convention. If none exists, create `.codex/workflows/<task-slug>/design.md`, `plan.md`, and `review.md`.
- Define scope, non-goals, evidence, risks, rollback, acceptance criteria, and required tests before implementation.
- Simulate or dry-run high-risk operations and document the recovery path before acting.

Skip persistent artifacts for genuinely simple execution unless the repository requires them.

### 2. Explore And Design With Sol/High

Use the confirmed Sol/high agent to inspect source evidence and return a structured design conclusion. Require it to separate facts, inferences, and unresolved questions. Do not accept unsupported assumptions as design inputs. The coordinator records that conclusion in the design and plan; Sol does not write the artifacts itself.

If Sol/high is unavailable, use a distinct Terra/xhigh worker and mark the design route as `Sol unavailable -> Terra/xhigh`. Do not present this as an equivalent Sol result.

For diagnosis-only work, deliver the conclusion and stop here unless the user requested a fix.

### 3. Implement With Terra/High

Delegate only after the design contract is complete. Give the Terra/high worker:

- exact scope and non-goals;
- design and plan artifact paths;
- acceptance criteria and verification commands;
- ownership boundaries and files it may touch;
- relevant repository instructions;
- a requirement to report changed files, tests, assumptions, and remaining risks.

Allow parallel Terra workers only for independent, non-overlapping ownership areas. The coordinator remains responsible for integration.

### 4. Review With Sol/High

Review the actual diff, current files, tests, and requirements rather than the implementer's summary. Return actionable findings ordered by severity and include file/line evidence; do not modify the reviewed workspace. Check at least:

- requirement completeness and behavioral regressions;
- correctness, boundary behavior, concurrency, and security;
- performance and resource use;
- code organization, abstraction fit, over-design, and over-defence;
- architecture robustness and reasonable extensibility;
- documentation and test alignment;
- unsupported assumptions and missing empirical evidence.

If no issues are found, state that explicitly and identify residual test gaps.

If Sol/high is unavailable, use a fresh Terra/xhigh reviewer. It must be a different agent from the Terra worker that implemented or repaired the reviewed diff. Record the degraded review route and its residual risk.

### 5. Repair With Terra/XHigh

When review finds actionable issues, give Terra/xhigh only the confirmed findings, current diff, constraints, and required verification. Require root-cause fixes and prohibit unrelated cleanup. Re-run affected tests after repair.

### 6. Verify Again With Sol/High

Perform a fresh read-only review of the final diff and test evidence. Do not merely check whether the repair worker says each finding is resolved. Re-open affected code and look for regressions introduced by the repair.

Use at most two repair-review cycles before considering the single escalation path below. Do not continue the same repair loop indefinitely.

If Sol/high is unavailable, use a fresh Terra/xhigh verifier under the same independence and disclosure requirements as the first review.

### 7. Escalate With Sol/XHigh

Use this phase only when one of these evidence gates is met:

- two repair-review cycles did not resolve material findings;
- the root cause remains unknown or available evidence conflicts;
- the user identifies a concrete mismatch between the delivered result and the documented requirement, acceptance criterion, example, or intended behavior.

Do not escalate on an unexplained statement that the result is unsatisfactory. First translate feedback into observable acceptance criteria or ask for the missing expectation.

Create a new Sol/xhigh worker with the current artifacts, failed findings, test evidence, and user feedback. It must re-investigate the root cause, challenge the current design, and return a scoped remediation. The coordinator records the revised design and plan; Sol/xhigh does not edit them or any other workspace file. Do not ask the currently running Sol/high agent to claim it changed its own reasoning effort.

After approval, send the revised plan to Terra/xhigh for implementation, then run the normal independent final verification. If Sol/xhigh is unavailable, use the documented independent Terra/xhigh fallback and record `Sol/xhigh unavailable -> Terra/xhigh`. Allow only one escalation per task by default; if its verification still fails, stop and report the unresolved evidence.

### 8. Close The Work

- Run the strongest safe verification available within scope.
- Update the plan, design decisions, and review record.
- Mark the goal complete only when acceptance criteria are met and no required work remains.
- Report the models actually used, any routing fallbacks, changes, verification, and residual risk.

## Route Simple Repetitive Work

Use Luna/high only when the request supplies deterministic steps and the work is low risk. Every Luna result requires a fresh Terra/high review before it can be reported as complete. Luna must not self-review or declare final completion.

Give the Terra/high reviewer the original request, Luna's result, changed files or command output, acceptance criteria, and available deterministic checks. Require it to inspect actual output for missed steps, scope drift, incorrect assumptions, and regressions.

- If the Terra/high review is clean, report its verification evidence and complete the task.
- If it finds bounded issues, use Terra/xhigh to repair them and require a fresh Terra/high re-review.
- If it finds ambiguity, non-trivial risk, or design work, stop the Luna path and escalate to the normal Sol/Terra workflow.
- Apply the normal two repair-review cycle limit to this path as well.

If the active subagent tool does not support Luna:

1. Do not start a nested `codex exec` process or create a separate App task unless the user explicitly authorized that action.
2. Use Terra/low as the continuity fallback only for low-risk deterministic work, and disclose the fallback.
3. For work that fails the low-risk gate, use the normal Sol/Terra workflow.

## Dispatch Contract

Every delegated prompt must contain:

```text
Role and requested model/effort
Objective and authorized action
Scope, non-goals, and ownership
Artifact paths and relevant evidence
Acceptance criteria and verification commands
Expected return format
Stop conditions and escalation rules
```

For every Sol worker, also include: `Read-only analysis only. Do not edit files or change external state; return the structured conclusion to the coordinator.`

Wait for dependency-producing workers before starting dependent phases. Never let an implementation and its independent review run concurrently.

## Fallback Rules

- Never silently substitute a model or reasoning effort.
- Prefer the closest lower-cost capable route for low-risk work; prefer stopping over weakening review for high-risk work.
- If Sol/high is unavailable for high-risk design, review, or verification, use a distinct Terra/xhigh worker and record `Sol unavailable -> Terra/xhigh` in the plan and final result.
- Do not let the Terra implementation or repair worker review its own diff under the Sol fallback. If a distinct Terra/xhigh worker cannot be created, report the capability gap and stop the high-risk phase.
- Use Sol/xhigh only for the evidence-gated escalation path. If it is unavailable, use the independent Terra/xhigh fallback, record `Sol/xhigh unavailable -> Terra/xhigh`, and preserve the one-escalation limit.
- If Terra is unavailable, the current capable agent may implement only after recording that the cost-routing objective could not be met.
- If a worker fails or returns incomplete evidence, retry once with a tighter contract, then continue locally only when safe and disclose the change.
