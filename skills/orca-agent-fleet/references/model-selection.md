# Provider and Model Selection for Orca Workers

Choose a provider and a model independently for each Task. The provider is the Orca TUI agent id passed to `--agent`. Optimize for the minimum capable eligible provider and model, not one fleet-wide default.

## Discover Before Choosing

1. Treat every current Orca TUI agent id as an accepted provider. Do not invent ids.
2. Run `python3 <skill-dir>/scripts/list_providers.py --orca-version`. Use its JSON as the live inventory: accepted ids, detect/launch commands, launch-time model catalogs, and PATH presence. `<skill-dir>` is the folder holding this skill's `SKILL.md`.
3. Confirm auth for providers that need it (`orca account list --json` for Claude/Codex; provider CLI status for others). The script reports `authChecked: false` — installed but unauthenticated is not launchable.
4. If the script is unavailable, probe the detect commands in the catalog below with `command -v` and keep the same eligibility rules.

Use the script's `eligible` list, then subtract anything that fails the auth check. `eligible` means the detect binary (or alias) is on `PATH`, required companion binaries are present, and the runtime supports it. `installed` is PATH presence alone.

The seed table is stamped with the Orca version it was read from (`catalogSource`). If `orcaAppVersion` is newer and a known agent id is rejected, trust the CLI over this file: accept any id Orca takes as an `--agent` value.

## Selection Procedure

1. Classify the Task: read-only or writing, routine or consequential, sharply bounded or ambiguous.
2. Assess blast radius: files, services, data, security, compatibility, and reversibility.
3. Choose the provider first. Then apply that provider's default model unless the Task or user needs a different catalog id.
4. Choose reasoning effort only when the provider *and* the chosen model support it. Start from the model's default, then adjust one level only for a concrete reason.
5. Record provider, model, effort, rationale, expected evidence, and fallback in the plan.

Honor an explicit user provider or model choice unless unavailable or unsafe. If a requested provider is ineligible, explain the substitution before launch and choose the nearest eligible provider. Never invent model IDs.

## Fleet Defaults

- **Default provider:** `codex` when eligible. Otherwise the first eligible id in Orca's auto-pick order (see script `autoPickOrder`). Orca's own auto-pick head is `claude`; this skill prefers `codex` for fleet workers, so state the choice rather than assuming either.
- **Default model:** that provider's default. `defaultSource: orca-catalog` means Orca marks it default; `skill-convention` means this skill picked it; `null` means omit `--model` and take the provider CLI default.
- **Default effort:** the model's catalog effort default. Omit `--effort` when the model exposes no effort option.

Improve the Task specification before increasing model tier or effort. Do not assign the strongest provider and model to every worker.

## Launch-Time Model Selection

`worker-start --model` / `--effort` reach only **Claude, Codex, and Cursor**, and only for *fresh* agent terminals. Hard rules from the CLI:

- `--effort` requires `--model`.
- Neither option can combine with `--terminal` (reused terminals keep their session settings).
- A connected remote worker server must advertise launch-preference support before Orca forwards either option.
- Every other provider launches on its CLI default. To pin a model there, use custom argv via `orca terminal create --command '<cli> <its own model flag>'`, or change the model mid-session inside the TUI.

Valid launch-time ids and their effort ranges:

| Provider | Model id | Effort choices | Effort default |
| --- | --- | --- | --- |
| `claude` | `sonnet` (default), `opus`, `fable` | `low` `medium` `high` `xhigh` `max` | `high` |
| `claude` | `haiku` | none — do not pass `--effort` | — |
| `codex` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.2-codex` | `minimal` `low` `medium` `high` `xhigh` | `medium` |
| `codex` | `gpt-5.6-luna` | `minimal` `low` `medium` `high` (no `xhigh`) | `medium` |
| `cursor` | `auto` (default) | none — do not pass `--effort` | — |
| `cursor` | `gpt-5.3-codex`, `claude-opus-4-8` | `low` `medium` `high` | `high` |

Codex exposes no catalog default model, so omitting `--model` uses the Codex CLI's own default. This skill pins `gpt-5.6-terra` for routine fleet work so worker launches stay reproducible.

`gemini` (`gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`) and `grok` (`grok-4.5`) have model catalogs but **no launch-preference support**: pick their model with custom argv or mid-session, not `worker-start --model`.

## Provider Catalog

`WS` = `worker-start --model`/`--effort` is forwarded. `CLI default` means omit `--model`.

| Provider | Detect / launch | WS | Default model | Default effort | Typical use |
| --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | ✅ | `sonnet` | `high` | Everyday implementation and review |
| `claude-agent-teams` | `orca` / `orca-dev` / `orca-ide` → `orca claude-teams` (requires `claude`; not win32/wsl) | — | CLI default | — | Multi-pane Claude teammates |
| `openclaude` | `openclaude` | — | CLI default | — | Claude-compatible CLI |
| `codex` | `codex` | ✅ | `gpt-5.6-terra` | `medium` | Default fleet implementer |
| `grok` | `grok` | — | `grok-4.5` (not launch-settable) | `high` (mid-session) | xAI TUI |
| `copilot` | `copilot` | — | CLI default | — | GitHub Copilot TUI |
| `opencode` | `opencode` | — | CLI default | — | OpenCode TUI |
| `mimo-code` | `mimo` | — | CLI default | — | MiMo Code |
| `ante` | `ante` | — | CLI default | — | Ante TUI |
| `trae` | `traecli` | — | CLI default | — | TRAE CN |
| `pi` | `pi` | — | CLI default | — | Pi TUI |
| `omp` | `omp` | — | CLI default | — | OMP TUI |
| `gemini` | `gemini` | — | `gemini-3-flash-preview` (not launch-settable) | — | Routine Gemini work |
| `antigravity` | `agy` | — | CLI default | — | Antigravity / `agy` |
| `aider` | `aider` | — | CLI default | — | Aider |
| `goose` | `goose` | — | CLI default | — | Goose |
| `amp` | `amp` | — | CLI default | — | Amp |
| `kilo` | `kilo` | — | CLI default | — | Kilocode |
| `kiro` | `kiro-cli` → `kiro-cli chat --tui` | — | CLI default | — | Kiro |
| `crush` | `crush` | — | CLI default | — | Charm Crush |
| `aug` | `auggie` | — | CLI default | — | Auggie |
| `autohand` | `autohand` | — | CLI default | — | Autohand Code |
| `cline` | `cline` | — | CLI default | — | Cline |
| `codebuff` | `codebuff` | — | CLI default | — | Codebuff |
| `command-code` | `command-code` → `command-code --trust` | — | CLI default | — | Command Code |
| `continue` | `cn` | — | CLI default | — | Continue |
| `cursor` | `cursor-agent` | ✅ | `auto` | — (`auto` has none) | Cursor Agent CLI |
| `droid` | `droid` | — | CLI default | — | Droid |
| `kimi` | `kimi` | — | CLI default | — | Kimi Code |
| `mistral-vibe` | `vibe` / `mistral-vibe` → `vibe` | — | CLI default | — | Mistral Vibe |
| `qwen-code` | `qwen` | — | CLI default | — | Qwen Code |
| `rovo` | `rovo` | — | CLI default | — | Rovo Dev |
| `hermes` | `hermes` → `hermes --tui` | — | CLI/profile default | — | Plain Hermes TUI; use `orca-hermes-fleet` for Hermes profiles/Kanban |
| `devin` | `devin` | — | CLI default | — | Devin CLI |
| `openclaw` | `openclaw` | — | CLI default | — | OpenClaw |

Quality overrides when the Task is architectural, security-sensitive, a migration, or final independent review:

- `claude`: `opus` or `fable`, `high`
- `codex`: `gpt-5.6-sol`, `high`
- `cursor`: `claude-opus-4-8` or `gpt-5.3-codex` at `high` (not `auto`)
- `gemini`: `gemini-3-pro-preview`, selected via custom argv or mid-session
- `grok`, `openclaude`, `claude-agent-teams`, and every CLI-default provider: no launch-time override exists — either accept the CLI default, set the model inside the TUI, or move the Task to a provider that supports the override

Mechanical read-only work may drop a tier (`claude` `haiku` with no `--effort`, `codex` `gpt-5.6-luna`, `gemini` flash) once the provider is chosen.

## Codex Decision Table

Use this table only after the provider is `codex`.

| Task shape | Model | Effort | Typical roles |
| --- | --- | --- | --- |
| Mechanical, read-only, high-volume, tightly bounded | `gpt-5.6-luna` | `low` or `medium` | Search, inventory, classification, extraction, simple verification |
| Routine coding with clear acceptance criteria | `gpt-5.6-terra` | `medium` | Feature slice, tests, documentation, focused bug fix |
| Broad but well-specified implementation | `gpt-5.6-terra` | `high` | Multi-file refactor, integration work, difficult test repair |
| Architecture or ambiguous cross-cutting work | `gpt-5.6-sol` | `high` | Planner, architect, migration designer |
| Difficult debugging or security-sensitive code | `gpt-5.6-sol` | `high` or `xhigh` | Root-cause analysis, auth, concurrency, data integrity |
| Consequential independent review | `gpt-5.6-sol` | `high` | Final reviewer, security reviewer, migration reviewer |
| Quality-critical but sharply bounded work | `gpt-5.6-sol` | `medium` | Focused reviewer, delicate patch, compatibility check |

## Escalation Rules

Escalate provider or model only when the current eligible pair cannot meet acceptance.

Escalate Codex from Luna to Terra when the worker must modify code, reconcile multiple sources, or make non-mechanical judgments.

Escalate Codex from Terra to Sol, or Claude from `sonnet` to `opus`/`fable`, when any of these applies:

- Requirements remain materially ambiguous after discovery.
- The change crosses architectural boundaries.
- Failure could cause security, privacy, data-loss, production, or migration risk.
- Root cause is unclear after a bounded investigation.
- The task is the final independent gate for consequential work.

Increase reasoning effort only when the prompt already contains clear acceptance criteria, dependencies, ownership, and verification. A vague Task needs refinement, not `xhigh` effort.

Do not switch providers mid-Task unless the current provider is unavailable or the user asks. A reviewer may use a different provider from the author.

## Role Defaults

- **Coordinator/planner:** `codex` `gpt-5.6-sol high` or `claude` `opus high` for complex fleets; `codex` `gpt-5.6-terra medium` or `claude` `sonnet high` for straightforward DAGs.
- **Routine implementer:** default provider + that provider's default model.
- **Research/inventory worker:** cheaper catalog tier when one exists; otherwise the provider default.
- **Test or documentation worker:** provider default; cheaper tier only for mechanical edits or checks.
- **Independent reviewer:** match or exceed the implementation's judgment demands; default consequential review to a quality override.
- **Fix worker:** select from the finding's complexity, not automatically from the original author pair.

## User Overrides and Availability

Honor explicit user choices for provider, model, effort, budget, or latency. If a requested model is unavailable, explain the substitution before launch and choose the nearest role-equivalent tier on the same provider when possible. Re-check current provider CLI model guidance when availability or naming is uncertain.

## Plan Format

For every Task, include a compact record:

```text
Task: <bounded outcome>
Role: <planner|implementer|researcher|reviewer|fixer>
Provider: <orca tui agent id>
Model: <model or CLI default>
Effort: <effort or omitted>
Why: <task-specific rationale>
Owns: <worktree and files/modules>
Depends on: <task ids or none>
Verifies: <commands and evidence>
Fallback: <retry, refine, or escalate condition>
```
