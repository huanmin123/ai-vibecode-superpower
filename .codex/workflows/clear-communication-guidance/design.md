# Clear Communication Guidance Design

- Goal: Ensure users can understand, verify, and challenge Codex outputs without requiring unnecessary implementation detail.
- Authorization: Update the global AGENTS.md source and workflow records.
- Scope: `codex-global-config/AGENTS.md` and this workflow directory.
- Non-goals: Require long answers, expose private chain-of-thought, prescribe one response format for every task, or change model-routing rules.
- Risk: Medium. This global instruction affects every installed Codex task.
- Rollback: Remove the new AGENTS.md section and workflow records.

## Evidence

- The current source AGENTS.md has development and execution rules but no explicit contract for user-comprehensible answers or design communication.
- The user reports that abstract or ambiguous output prevents effective correction and can cause work to drift.
- OpenAI's GPT-5.6 model guidance recommends lean prompts, stating each instruction once, while preserving required facts, decisions, caveats, and next actions in shorter outputs. It also recommends stating goals, constraints, approval boundaries, success criteria, and the required output format when relevant.

## Decision

Add one compact AGENTS.md section that requires concrete, decision-useful communication:

1. Lead with the conclusion or current status.
2. Name the specific object, scope, effect, evidence, and next action needed for a user to validate or challenge the result.
3. Separate facts, inferences, decisions, and unresolved questions.
4. Define designs using goals, non-goals, observable behavior, key decisions and tradeoffs, scope, material risks, and acceptance evidence.
5. Omit internal reasoning, generic filler, and detail that does not affect a user decision, verification, risk, or agreed direction.

## Alternatives

- Require exhaustive implementation detail in every answer: rejected because it obscures the direction and conflicts with the need for lean, decision-relevant context.
- Leave response quality to tone guidance only: rejected because it does not make ambiguity or verifiability testable.

## Acceptance Criteria

- The new AGENTS.md rules tell an agent how to make an output concrete and verifiable.
- They explicitly prevent both ambiguous abstraction and unnecessary detail.
- They give designs a readable, user-facing structure without requiring premature low-level design.
- The rules do not conflict with the existing system-command or orchestration instructions.
