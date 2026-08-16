---
name: orca-agent-fleet
description: Coordinate Codex agents through Orca Runs, Task DAGs, managed terminals, worktree isolation, structured lifecycle messages, independent reviews, and transparent recovery. Use when the user asks for an Orca-managed agent fleet, supervised multi-agent execution, parallel implementation, task dependencies, one-time plan approval, reviewer/fix/re-review loops, or model selection for Orca-launched Codex workers. Never use Hermes workers or Hermes profiles.
---

# Orca Agent Fleet

Use Orca as the coordination control plane and Codex as the only worker agent. Refine the brief, select a model for every role, obtain any required plan approval, and then supervise the complete Orca lifecycle.

## Mandatory Discovery

Before mutating Orca state:

1. Resolve the Orca executable according to the installed `orchestration` skill.
2. Load the version-matched guide with `orca skills get orchestration --full`.
3. Confirm runtime health with `orca status --json`.
4. Inspect applicable `AGENTS.md`, Git status, repository manifests, active worktrees, terminals, Runs, Tasks, and Dispatches.
5. Read `references/model-selection.md` before assigning models.

Never guess Orca commands. The installed guide is authoritative. Never launch or dispatch Hermes, use Hermes profiles, or introduce another scheduler.

## Normalize the Brief

Separate the request into:

- **Outcome:** observable user value.
- **Deliverables:** concrete artifacts.
- **Acceptance:** verifiable success conditions.
- **Scope:** repositories, paths, platforms, and exclusions.
- **Constraints:** compatibility, security, models, tools, timing, and approvals.
- **Topology:** task slices, dependencies, parallelism, ownership, and reviewers.
- **Human gates:** merge, push, deploy, credentials, destructive actions, production changes, and billing.

Discover facts locally before asking. Ask only when an unresolved answer changes product behavior, the target checkout, material risk, compatibility, isolation, or authorization. Make and record safe assumptions for low-risk preferences.

## Decide Whether to Orchestrate

Use a fleet when the work benefits from independent slices, parallelism, isolation, specialist roles, or independent review. Stay in the current agent for a small sequential task whose coordination overhead exceeds its value.

If orchestration is justified, create a bounded Task for every independently verifiable outcome. Define exact dependencies, ownership, verification, reviewer relationships, and non-goals. If the user requests one-time approval, present the full executable plan once and do not ask again unless new material risk appears.

## Select Models First

Choose the model and reasoning effort before launching each worker. State the choices in the plan with a short rationale.

- Default routine implementation and repository work to `gpt-5.6-terra` with `medium` effort.
- Use `gpt-5.6-sol` with `high` effort for architecture, difficult debugging, security-sensitive work, migrations, ambiguous cross-cutting changes, and final review.
- Use `gpt-5.6-luna` with `low` or `medium` effort for bounded read-only searches, classification, extraction, and mechanical checks.
- Prefer `gpt-5.6-sol` with `medium` effort when quality matters but the task is already sharply specified.
- Improve the Task specification before increasing reasoning effort. Do not assign the strongest model to every worker by default.

Read `references/model-selection.md` for the full decision table and escalation rules. Honor an explicit user model choice unless unavailable or unsafe; report any substitution before launch.

## Choose the Topology

Apply these defaults:

```text
parallel + writer + overlapping code surface = separate worktrees
parallel + writer + disjoint ownership = separate worktrees preferred
parallel + read-only = separate terminals; worktree optional
sequential writer = current worktree usually acceptable
assets/migrations/generated files = isolate by default
independent reviewer = never the author session
```

Only create a new worktree when the user requested one or a concrete checkout/filesystem conflict makes it necessary. State that conflict first. Use child lineage for work stacked on the current foundation and `--no-parent` for unrelated work. Decide the Git base independently from Orca lineage. Allow one writer per worktree.

## Launch Codex Workers

Create or bind the Run, create the Task, and attach a Codex worker using the preferred composition from the installed orchestration guide.

For an existing worktree, launch Codex in an Orca terminal with explicit model settings when needed:

```text
orca terminal create --worktree <selector> --title <task-name> --command 'codex --model <model> -c model_reasoning_effort="<effort>"' --json
```

For an allowed new worktree, prefer agent-first worktree creation when its agent configuration expresses the chosen model. Otherwise use the guide's custom-command path. Require every worker prompt to include:

- Task objective, deliverables, acceptance, boundaries, and non-goals.
- Owned files/modules and dependency context.
- Required verification and completion evidence.
- Instruction to assert `pwd` and `git status` before edits.
- Instruction to use Orca structured ask, escalation, heartbeat, and `worker_done` messages.

Do not use generic background shells as untracked workers. Preserve exact Run, Task, Dispatch, terminal, model, and worktree identity.

## Supervise the Lifecycle

Use the explicit Orca loop: create Task, start worker, and wait through the installed guide's check command. Process questions, escalations, failures, and `worker_done` through structured Orca messages.

After an accepted `worker_done`:

1. Inspect the changed files, report, test output, and acceptance evidence.
2. Transfer the exact terminal only when the same agent has an immediate follow-up Task.
3. Otherwise release it with the guide's worker-release procedure.
4. Never manually mark success after a valid `worker_done`.

Manual Task updates are recovery-only administrative overrides. Record the reason and never present them as worker success.

## Enforce Independent Review

Review Tasks depend on exact implementation artifacts. A reviewer must:

- Run in a different Codex session from the author.
- Be read-only by default.
- Inspect the original requirements, full diff, tests, security, compatibility, and operational risk.
- Return severity-ranked findings and exactly `APPROVED` or `CHANGES_REQUESTED`.

Use a quality-first model for consequential review according to `references/model-selection.md`. A successful reviewer process means the review ran; it does not mean the change passed. `CHANGES_REQUESTED` creates a bounded fix Task followed by re-review.

## Recover Transparently

On wrong cwd, truncated prompt, provider error, stale Dispatch, ownership conflict, or terminal failure:

1. Preserve evidence and inspect current Orca state.
2. Follow the exact version-matched recovery receipt.
3. Prefer a fresh bounded context over repeated long follow-ups.
4. Never release or close a worker merely because it is idle or timed out.
5. Never silently replace specialist or reviewer work with coordinator work.
6. Report partial orchestration honestly.

## Completion Audit

Before handoff, verify:

- Every required Task has a valid completion or a clearly labeled administrative override.
- Dependencies and acceptance criteria are satisfied.
- Required tests and checks actually ran.
- Reviewers were independent and their verdicts are recorded.
- Failed and retried attempts remain visible.
- All workers were transferred or released correctly.
- Unreviewed, blocked, or partial output is labeled accurately.

Do not call the Run end-to-end successful when required implementation, verification, or independent review was skipped or replaced.

## Resources

- `references/model-selection.md`: Codex model and reasoning-effort selection rules for Orca roles.
