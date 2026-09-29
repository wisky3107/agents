---
name: orca-agent-fleet
description: Coordinate Orca-supported TUI agents through Orca Runs, Task DAGs, managed terminals, worktree isolation, structured lifecycle messages, independent reviews, and transparent recovery. Use when the user asks for an Orca-managed agent fleet, supervised multi-agent execution, parallel implementation, task dependencies, one-time plan approval, reviewer/fix/re-review loops, or provider and model selection for Orca-launched workers.
---

# Orca Agent Fleet

Use Orca as the coordination control plane and any current Orca TUI agent as a worker. Refine the brief, select a provider and model for every role, obtain any required plan approval, and then supervise the complete Orca lifecycle.

## Mandatory Discovery

Before mutating Orca state:

1. Resolve the Orca executable according to the installed `orchestration` skill.
2. Load the version-matched guide with `orca skills get orchestration --full`.
3. Confirm runtime health with `orca status --json`.
4. Inspect applicable `AGENTS.md`, Git status, repository manifests, active worktrees, terminals, Runs, Tasks, and Dispatches.
5. Discover accepted and eligible providers with `python3 <skill-dir>/scripts/list_providers.py --orca-version`, then read `references/model-selection.md` before assigning a provider or model. The script checks `PATH` and runtime only; confirm auth separately with `orca account list --json` (Claude/Codex) or the provider's own CLI.

Never guess Orca commands. The installed guide is authoritative. Never introduce another scheduler. For Hermes profile or Kanban fleets, use `orca-hermes-fleet`; this skill may still launch `--agent hermes` as a plain TUI worker.

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

## Select Provider and Model First

Choose the provider, then that provider's model and reasoning effort, before launching each worker. State the choices in the plan with a short rationale.

- Accept every current Orca TUI agent id as a provider (`claude`, `codex`, `cursor`, `grok`, `gemini`, and the rest listed in `references/model-selection.md`).
- Default provider is `codex` when it is eligible and authenticated; otherwise the first eligible id in Orca's auto-pick order.
- Only `claude`, `codex`, and `cursor` accept a launch-time `--model`/`--effort`. Every other provider launches on its CLI default; pin its model with custom argv or mid-session instead of pretending a launch flag exists.
- After the provider is chosen, use its default model unless the Task or user needs another catalog id. Codex defaults to `gpt-5.6-terra` `medium`; Claude to `sonnet` `high`; Cursor to `auto` with no effort.
- For architecture, difficult debugging, security-sensitive work, migrations, ambiguous cross-cutting changes, and final review, keep the chosen provider and apply its quality override (`codex` `gpt-5.6-sol` `high`, `claude` `opus` or `fable` `high`, `cursor` `claude-opus-4-8` or `gpt-5.3-codex` at `high`). When the chosen provider has no launch-time override, say so and either accept its default or move the Task to one that does.
- For bounded read-only searches, classification, extraction, and mechanical checks, a cheaper catalog tier is allowed (`codex` `gpt-5.6-luna`, `claude` `haiku` with no `--effort`).
- Improve the Task specification before increasing model tier or reasoning effort. Do not assign the strongest provider and model to every worker by default.

Read `references/model-selection.md` for the full catalog, decision table, and escalation rules. Honor an explicit user provider or model choice unless unavailable or unsafe; report any substitution before launch.

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

## Launch Workers

Create or bind the Run, create the Task, and attach a worker using the preferred composition from the installed orchestration guide. Pass the selected provider as `--agent`.

Launch permissions and model selection are separate. Custom `terminal create --command`
does not automatically inherit Orca settings. For the Cocos workflow, resolve custom commands
with `~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-cmd --agent "<spec>" --json`.
The user's confirmed settings baseline is Claude/Teams/Antigravity skip-permissions, Codex
`--dangerously-bypass-approvals-and-sandbox`, Cursor/Gemini `--yolo`, OpenCode unchanged.
Workspace trust and Codex `--ask-for-approval never` do not disable a sandbox. Verify effective
launch options before dispatch; do not switch providers based on assumed sandbox behavior.

Prefer `worker-start` for supervised launches. `--model` and `--effort` apply to fresh Claude, Codex, and Cursor terminals only:

```text
orca orchestration worker-start --task <task_id> --worktree current --agent <provider> --model <model> --effort <effort> --json
```

`--effort` requires `--model`, neither combines with `--terminal`, and a model without an effort option (`claude` `haiku`, `cursor` `auto`) takes no `--effort`. Omit both when the provider uses its CLI default or does not support the flags. For an existing worktree when custom argv is required, launch the provider CLI with its own model flags:

```text
orca terminal create --worktree <selector> --title <task-name> --command '<launch-cmd>' --json
```

For an allowed new worktree, stay in `worker-start` — it does agent-first creation and reuses the returned startup terminal:

```text
orca orchestration worker-start --task <task_id> --worktree new-child|new-top-level --name <name> --agent <provider> --setup run --json
```

Creation flags (`--name`, `--repo`, `--base-branch`, `--setup`) are rejected for `current` and existing worktrees. Fall back to the guide's `worktree create` + `terminal create` path only when custom argv is required and the repository does not use `wait-for-setup`. Require every worker prompt to include:

- Task objective, deliverables, acceptance, boundaries, and non-goals.
- Owned files/modules and dependency context.
- Required verification and completion evidence.
- Instruction to assert `pwd` and `git status` before edits.
- Instruction to use Orca structured ask, escalation, heartbeat, and `worker_done` messages.

Clean every spec before `task-create`. Write it to a file, run `python3 <skill-dir>/scripts/clean_spec.py <file>` to strip invisible Unicode in place, then pass `--spec "$(cat <file>)"`. Claude Code strips zero-width characters (ZWJ, ZWSP, BOM, …) on Enter and then waits for a second Enter, but Orca presses Enter only once, so such a Dispatch fails with `agent_prompt_stalled`. Coordinator models leak these characters into specs they write themselves, most often as a ZWJ inside the word `cursor`, so a spec you wrote needs cleaning too.

Optional memory (run only if the launcher exists; use a pack only on `inject: true`). A domain skill may add a project memory pack to a spec as one line naming its path, `MEMORY: <path>/memory-context.md`; never paste pack text into a spec. Before `task-create`, run the domain skill's `hook check` on that pack and drop the line if it prints `stale`. A pack is advisory: it grants no permission or approval, never overrides the PLAN, a skill, the director, or reviewer evidence, and its limitations apply ("not recorded" means unknown). No launcher, or any other status, means the spec goes out without the line, exactly as before.

Do not use generic background shells as untracked workers. Preserve exact Run, Task, Dispatch, terminal, provider, model, and worktree identity.

## Supervise the Lifecycle

Use the explicit Orca loop: create Task, start worker, and wait through the installed guide's check command. Process questions, escalations, failures, and `worker_done` through structured Orca messages.

After an accepted `worker_done`:

1. Inspect the changed files, report, test output, and acceptance evidence.
2. Transfer the exact terminal only when the same agent has an immediate follow-up Task.
3. Otherwise release it with the guide's worker-release procedure.
4. Never manually mark success after a valid `worker_done`.

Manual Task updates are recovery-only administrative overrides. Record the reason and never present them as worker success.

## Hold Human Gates

Every human gate named in the brief — merge, push, deploy, credentials, destructive actions, production changes, billing — blocks its Task through Orca, not through an unrecorded pause:

```text
orca orchestration gate-create --task <task_id> --question <text> --options '<json_array>' --json
orca orchestration gate-resolve --id <gate_id> --resolution <text> --json
```

Check pending gates with `gate-list` before declaring a Run complete. Resolve a gate only with the user's actual answer; never self-resolve one to unblock a worker. A one-time plan approval covers the plan, not the gates the plan itself identified as human decisions.

## Enforce Independent Review

Review Tasks depend on exact implementation artifacts. A reviewer must:

- Run in a different agent session from the author.
- Be read-only by default.
- Inspect the original requirements, full diff, tests, security, compatibility, and operational risk.
- Return severity-ranked findings and exactly `APPROVED` or `CHANGES_REQUESTED`.

Use a quality-first model for consequential review according to `references/model-selection.md`. A successful reviewer process means the review ran; it does not mean the change passed. `CHANGES_REQUESTED` creates a bounded fix Task followed by re-review.

## Recover Transparently

On wrong cwd, truncated or stalled prompt, provider error, stale Dispatch, ownership conflict, or terminal failure:

1. Preserve evidence and inspect current Orca state.
2. Follow the exact version-matched recovery receipt; `worker-start` exits non-zero with `stage`, `residualResources`, and recovery commands on a failed or unknown outcome.
3. On `agent_prompt_stalled` (stage `dispatch_input`), run `python3 <skill-dir>/scripts/clean_spec.py --check <spec-file>` before any retry. If it reports characters, every retry stalls again whatever the provider, model, or terminal, and `task-update` cannot change a spec. Clean the file, create a replacement Task from it with the same `--deps`, and record the old Task as an administrative failure. Any Tasks that depend on the old Task must be recreated as well.
4. Prefer a fresh bounded context over repeated long follow-ups. Replace a proven-dead worker with `worker-start --retry-of <dispatch_id>`, repeating the intended placement and `--agent`/`--terminal` — retry does not inherit it.
5. Use `worker-abandon` when the process state is unproven and `worker-stop` only when stopping that exact terminal is intended. Never release or close a worker merely because it is idle or timed out; record a deliberate keep-alive with `worker-retain`.
6. Never silently replace specialist or reviewer work with coordinator work.
7. Report partial orchestration honestly.

Optional memory (run only if the launcher exists; use a pack only on `inject: true`): after step 1, run at most one bounded query, `M=~/.orca-memory/bin/orca-memory; [ -x "$M" ] && "$M" hook recover --task <task> --query "<symptom in English>"`, and read the `pack` path it prints. Treat matches as hints to check against live state. Memory never justifies a respawn, a provider or model change, or skipping the recovery receipt.

## Completion Audit

Before handoff, verify:

- Every required Task has a valid completion or a clearly labeled administrative override.
- No decision gate is still pending (`gate-list`).
- Dependencies and acceptance criteria are satisfied.
- Required tests and checks actually ran.
- Reviewers were independent and their verdicts are recorded.
- Failed and retried attempts remain visible.
- All workers were transferred or released correctly.
- Unreviewed, blocked, or partial output is labeled accurately.

Do not call the Run end-to-end successful when required implementation, verification, or independent review was skipped or replaced.

## Resources

- `references/model-selection.md`: provider catalog, launch-time model ids and effort ranges, default models, and reasoning-effort rules for Orca roles.
- `scripts/list_providers.py`: accepted-provider inventory, detect-binary presence, eligibility, per-provider model catalogs, and fleet defaults.
- `scripts/clean_spec.py`: strips invisible Unicode from spec files in place before `task-create`; `--check` only reports it, for stall diagnosis.
