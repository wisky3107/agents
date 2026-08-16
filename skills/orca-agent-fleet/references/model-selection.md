# Model Selection for Orca Codex Agents

Choose a model independently for each Task. Optimize for the minimum capable tier, not one fleet-wide default.

## Decision Table

| Task shape | Model | Effort | Typical roles |
| --- | --- | --- | --- |
| Mechanical, read-only, high-volume, tightly bounded | `gpt-5.6-luna` | `low` or `medium` | Search, inventory, classification, extraction, simple verification |
| Routine coding with clear acceptance criteria | `gpt-5.6-terra` | `medium` | Feature slice, tests, documentation, focused bug fix |
| Broad but well-specified implementation | `gpt-5.6-terra` | `high` | Multi-file refactor, integration work, difficult test repair |
| Architecture or ambiguous cross-cutting work | `gpt-5.6-sol` | `high` | Planner, architect, migration designer |
| Difficult debugging or security-sensitive code | `gpt-5.6-sol` | `high` or `xhigh` | Root-cause analysis, auth, concurrency, data integrity |
| Consequential independent review | `gpt-5.6-sol` | `high` | Final reviewer, security reviewer, migration reviewer |
| Quality-critical but sharply bounded work | `gpt-5.6-sol` | `medium` | Focused reviewer, delicate patch, compatibility check |

## Selection Procedure

1. Classify the Task as read-only or writing, routine or consequential, sharply bounded or ambiguous.
2. Assess blast radius: files, services, data, security, compatibility, and reversibility.
3. Choose the lowest tier that reliably handles that combination.
4. Choose reasoning effort after the model. Start from the table, then adjust one level only for a concrete reason.
5. Record model, effort, rationale, expected evidence, and fallback in the plan.

## Escalation Rules

Escalate from Luna to Terra when the worker must modify code, reconcile multiple sources, or make non-mechanical judgments.

Escalate from Terra to Sol when any of these applies:

- Requirements remain materially ambiguous after discovery.
- The change crosses architectural boundaries.
- Failure could cause security, privacy, data-loss, production, or migration risk.
- Root cause is unclear after a bounded investigation.
- The task is the final independent gate for consequential work.

Increase reasoning effort only when the prompt already contains clear acceptance criteria, dependencies, ownership, and verification. A vague Task needs refinement, not `xhigh` effort.

## Role Defaults

- **Coordinator/planner:** `gpt-5.6-sol high` for complex fleets; `gpt-5.6-terra medium` for straightforward DAGs.
- **Routine implementer:** `gpt-5.6-terra medium`.
- **Research/inventory worker:** `gpt-5.6-luna medium` unless synthesis is complex.
- **Test or documentation worker:** `gpt-5.6-terra medium`; Luna only for mechanical edits or checks.
- **Independent reviewer:** match or exceed the implementation's judgment demands; default consequential review to `gpt-5.6-sol high`.
- **Fix worker:** select from the finding's complexity, not automatically from the original author model.

## User Overrides and Availability

Honor explicit user choices for model, effort, budget, or latency. If a requested model is unavailable, explain the substitution before launch and choose the nearest role-equivalent tier. Never invent model IDs. Re-check current Codex model guidance when availability or naming is uncertain.

## Plan Format

For every Task, include a compact record:

```text
Task: <bounded outcome>
Role: <planner|implementer|researcher|reviewer|fixer>
Model: <model>
Effort: <effort>
Why: <task-specific rationale>
Owns: <worktree and files/modules>
Depends on: <task ids or none>
Verifies: <commands and evidence>
Fallback: <retry, refine, or escalate condition>
```
