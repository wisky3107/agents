# Executable Brief Template

## Outcome

What observable user or system outcome must exist?

## Target

- Repository/path:
- Base branch or commit:
- Platforms/environments:

## Deliverables

1. Artifact and owner.
2. Artifact and owner.

## Acceptance Criteria

- Behavior that can be verified.
- Tests/build/checks that must pass.
- Accessibility/security/compatibility expectations.

## Scope

### Must

- Required work.

### Should

- Valuable but negotiable work.

### Optional

- Only if low-cost and non-disruptive.

### Excluded

- Explicit non-goals.

## Constraints

- Compatibility:
- Data/security:
- Model/reasoning/tool limits:

## Model-selection gate (must be completed before official plan approval)

Inventory source/time:

| Task / worker | Hermes profile | Rất phù hợp | Tiết kiệm / ước tính | Availability + evidence time | Recommended default | User selection | Reasoning | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | exact provider/model | exact provider/model | confirmed-live / cached-candidate | | pending | | |

Decision record: `pending` / `user accepted defaults` / `user selected tiers` / `user override`.

Do not show the official executable plan or request its approval while any row remains `pending`.
- Time/cost:

## Task DAG

| Task | Depends on | Profile | Worktree | Verification | Reviewer |
|---|---|---|---|---|---|
| Foundation | — | web-dev | current | build/test | reviewer-A |

## Parallelism and Ownership

- Parallel-ready Tasks:
- Files/modules owned by each writer:
- Isolation conflicts:

## Human Gates

- Plan approval:
- Merge/push/PR:
- Deploy/production/destructive actions:

## Assumptions

- Safe defaults chosen without asking.

## Open Decisions

- Only decisions that cannot be discovered or defaulted safely.

## Approval Contract

After this plan is approved once, the coordinator may execute all reversible local work in scope. It must ask again only for a new material-risk decision or an action behind a listed human gate.
