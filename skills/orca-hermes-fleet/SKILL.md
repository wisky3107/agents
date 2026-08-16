---
name: orca-hermes-fleet
description: >-
  Refine briefs and coordinate Hermes Agent profiles through Orca Runs, Task DAGs,
  custom terminals, dispatch --inject, worktree isolation, lifecycle messages,
  independent review gates, and transparent recovery. Use when a request combines
  Orca with Hermes workers, asks for supervised multi-agent execution, parallel
  implementation slices, one-time plan approval, ask/reply or worker_done flows,
  reviewer/fix/re-review loops, or rules/skills for an Orca-managed Hermes fleet.
---

# Orca Hermes Fleet

Use Orca as the single coordination control plane and Hermes profiles as bounded execution roles. Refine the user's brief before creating state, then execute only after the required plan approval.

## Mandatory Discovery

Before any Orca mutation:

1. Resolve the Orca executable for the session according to the installed `orchestration` skill.
2. Load the version-matched guide:

```text
orca skills get orchestration --full
```

3. Confirm runtime health with `orca status --json`.
4. Inspect applicable `AGENTS.md`, repository status, manifests, existing Run/Tasks and relevant Hermes profiles.
5. Discover the currently selectable Hermes models using the version-matched procedure in `references/model-selection.md`. Prefer the authenticated picker inventory; if it is unavailable, use Hermes's current local model cache and label it `cached-candidate`, including its timestamp. Never recommend from a hard-coded model list or treat a catalog entry as confirmed availability.
5. Read `references/session-lessons.md` when designing topology, handling a failure, or auditing a prior run.

Never guess Orca subcommands from this skill. The installed guide is authoritative.

## Brief Intake

Run `scripts/brief_intake.py` against a Markdown/text brief when one is available. Use its output as a checklist, not as a substitute for repository discovery.

Separate input into:

- **Outcome:** observable user value.
- **Deliverables:** concrete artifacts.
- **Acceptance:** verifiable success conditions.
- **Scope:** repositories, paths, platforms and exclusions.
- **Constraints:** time, compatibility, security, models, tools and approvals.
- **Topology:** slices, dependencies, parallelism, worktree ownership and reviewers.
- **Human gates:** merge, push, deploy, production mutation, credentials, destructive operations and billing.

Discover facts locally before asking. Do not ask for information available from files, Git, Orca state or Hermes profile metadata.

### Decide Whether to Ask

Ask only when an unresolved answer changes one of:

- Product behavior or acceptance criteria.
- Repository/worktree target.
- Data loss, security, legal or production risk.
- Compatibility or migration strategy.
- Required isolation or ownership.
- Whether an irreversible/human-gated action is authorized.

Use a safe, explicit assumption for low-risk preferences and record it in the plan.

### Detect an Under-Specified Brief

The brief is insufficient when it lacks a discoverable/defaultable answer for outcome, target, acceptance, boundaries or a high-risk decision.

Ask the smallest number of decision questions, preferably one batch of at most three. Each question must explain why the answer changes execution. Do not request a second approval for information already covered by the approved plan.

### Detect an Over-Specified Brief

A brief is excessive when it contains:

- Repeated or conflicting requirements.
- Prescribed implementation details that fight repository conventions.
- Too many outputs without priority.
- Multiple control planes or overlapping ownership.
- Requirements unrelated to the stated outcome.

Do not blindly accept the excess. Normalize it into **must**, **should**, **optional** and **excluded**. Surface conflicts and ask the user to choose only when local evidence cannot resolve them safely.

### Grill Mode

Use a grill-style clarification pass when ambiguity is broad, risks compound, or the user explicitly asks to be challenged. No `grill-me` skill is installed in the current environment, so implement the behavior directly:

1. State the current interpretation in 2–4 bullets.
2. Identify contradictions, hidden assumptions and missing decisions.
3. Ask prioritized questions with consequences.
4. Propose a recommended default for every question.
5. Stop grilling as soon as the plan becomes executable.

Never grill for cosmetic preferences that can be iterated cheaply.

## Design the Plan and DAG

First decompose the work into bounded worker/profile assignments. This is a draft topology, not the official plan and must not be dispatched.

## Mandatory Model-Selection Gate

After the draft worker/profile assignments exist and before presenting the official plan or asking for plan approval, perform a separate model-selection gate. This gate is mandatory even when a profile has a configured default model.

For every worker Task:

1. Inspect the current Hermes-supported model inventory and the profile's configured defaults/limits. Confirm provider authentication/configuration separately from catalog presence.
2. Recommend exactly two choices whenever evidence supports them: **Rất phù hợp** (best fit for the task's risk, complexity, modality, tool use, and required reasoning) and **Tiết kiệm** (lowest-cost/fastest credible choice still expected to meet acceptance). When pricing or latency is unavailable, label the latter **Tiết kiệm ước tính** and state the proxy evidence. Use one choice only when no credible economical alternative exists, and say why.
3. Show the exact provider/model identifier and reasoning effort for each choice, along with a short rationale, availability state (`confirmed-live` or `cached-candidate`), evidence timestamp, and any known constraint. Do not use vague labels such as “model mạnh”.
4. Mark one option as the recommended default, but do not silently apply it. The user must explicitly either accept all recommended defaults, select a tier per worker, or provide an eligible model override per worker.

Ask only for this decision at the gate. It is valid for the user to reply “accept defaults”; record that explicit choice. If inventory retrieval fails and there is no trustworthy current cache, explain the failure and do not present an official plan, request plan approval, create a Run, terminal, Task, or Dispatch. Do not default a write/high-risk Task to an unconfirmed cached candidate.

Do not collapse model choice into the later plan approval. A plan approval is valid only after the model-selection decision has been recorded. Re-run the gate if the task scope, worker role, profile, model inventory, or material risk changes before dispatch.

Read `references/model-selection.md` when constructing the choices, evaluating availability, or resolving a profile/model mismatch.

After the model-selection decision, produce a plan before creating a Run when the task is multi-slice. Include:

- At least one bounded Task per independent outcome.
- Exact dependencies and which Tasks become ready in parallel.
- Profile, model/reasoning rationale and verification for every Task.
- Worktree placement and file/module ownership.
- Review grouping, fix/re-review path and final review.
- Human gates and explicit non-goals.

If the user requests one-time approval, show the complete executable plan once. After approval, do not ask again unless a new decision falls outside its scope or changes material risk.

## Choose Worktree Topology

Enforce:

```text
parallel + writer + shared code surface = separate worktrees
parallel + read-only = separate session; worktree optional
sequential writer = current worktree usually acceptable
assets/migrations/generated files = isolate by default
independent reviewer = never the author session
```

Use child lineage for work stacked on the current foundation and top-level lineage for unrelated work. Decide Git base independently from Orca lineage. Allow one writer per worktree.

## Dispatch Hermes Correctly

Hermes is a custom terminal worker unless the installed Orca guide explicitly says otherwise.

1. Create/bind the Run.
2. Create Task with complete but bounded spec.
3. Create Hermes TUI in the exact worktree with the user-selected exact model and reasoning effort.
4. Wait for TUI readiness if necessary.
5. Dispatch with `--inject`.
6. Require the worker to assert the absolute path with `pwd` and `git status` before edits.

Do not use Hermes Kanban as a second scheduler. The Hermes `orchestrator` profile is not the global planner when Orca owns the DAG.

## Supervise the Lifecycle

Process heartbeat, ask, escalation and `worker_done` through Orca structured messages. Preserve exact Task/Dispatch identity and capability. Process a Delivery fully before acknowledging it.

After accepted `worker_done`:

- Inspect files/report and verification evidence.
- Transfer the exact terminal only for an immediate follow-up Task, otherwise release it using the Orca recovery instructions.
- Never manually mark completed after valid `worker_done`.

Manual `task-update` is recovery only. Record the reason and report it as an administrative override, never as worker success.

## Review Policy

Review Tasks must depend on exact implementation artifacts. Reviewers:

- Run independently from authors.
- Are read-only by default.
- Inspect original requirements, full diff, tests, security and operational risk.
- Produce severity-ranked evidence and `APPROVED` or `CHANGES_REQUESTED`.

Reviewer `worker_done succeeded` means the review ran, not that the change passed. `CHANGES_REQUESTED` creates a fix Task followed by re-review. Never fabricate independent approval when a reviewer fails.

## Recovery

On wrong cwd, truncated prompt, provider 503, shell fallback, stale Dispatch or ownership conflict:

1. Preserve evidence and inspect the active Orca state.
2. Follow version-matched recovery receipts.
3. Prefer a fresh bounded session/context over repeated long follow-ups.
4. Do not close terminals or mutate Task status merely because a worker is idle or timed out.
5. Do not let the coordinator silently replace specialist work or reviewer verdicts.
6. Report partial orchestration honestly.

Read the failure catalogue in `references/session-lessons.md` before improvising recovery.

## Completion Audit

Run `scripts/completion_audit.py` with a JSON manifest when coordinating a substantial run. A final handoff must distinguish:

- Valid `worker_done` completions.
- Failed/retried attempts.
- Manual administrative overrides.
- Unreviewed output.
- Independent reviewer verdicts.
- Verification actually executed.

Do not call a run end-to-end successful if specialist implementation or independent review was replaced by coordinator work.

## Resources

- `references/session-lessons.md`: detailed architecture, commands, profile roster, worktree/reviewer policy, real incident timeline and candidate rules.
- `references/model-selection.md`: mandatory selection gate, current-inventory discovery, decision rubric and output format.
- `references/brief-template.md`: normalized brief and one-time approval template.
- `scripts/brief_intake.py`: deterministic brief quality scan.
- `scripts/completion_audit.py`: checks completion evidence and reviewer independence from a manifest.
