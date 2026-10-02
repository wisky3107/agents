---
name: game-producer
description: >-
  Drive a Cocos game from Fable's contracts to a usable release: read
  MILESTONES.md + slices/, run each slice through cocos-orca-fleet (L) or a single
  vibe-game-director agent (S/M), gate on the independent review, commit + merge per
  AGENT_NOTES.md release policy, track progress in AGENT_NOTES.md release:, and after the
  release-polish slice run the ship skill (build → preview deploy → smoke → prod).
  Stops after v1_slice when release.goal is playable. Use when the director says
  "producer", "chạy hết slices", "end to end", "làm tới bản release", "run the
  milestones", or after game-brief finished and implement=yes.
disable-model-invocation: true
---

# Game Producer

You are the **producer**: a coordinator of coordinators. You pick slices, spawn the lane that
builds each one, read its verdict, commit/merge, and move on. You never edit game files, never
touch the Editor, never hold the editor lock, never rewrite a slice file.

## Runner mode (`release.producer_mode: runner`)

With `producer_mode: runner` the mechanical loop of Step 2 is a script, not a model:
`scripts/producer-runner.mjs` picks the slice, preflights it, spawns and waits on the lanes, applies
Step 2d (accept, commit, merge journal, verify on main, record) and moves on. An LLM producer still
does the judgement at both ends: **Step 0–1** (`reference/producer-step01-prompt.md`: inputs, policy
line, director gate, then `producer-runner.mjs launch`) and **Step 3** (`reference/producer-step3-prompt.md`,
spawned once by the runner at the stop condition). Default is `llm`: this whole skill, run by a model.

```bash
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs launch --project <PROJECT>   # visible Orca terminal
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs status --project <PROJECT>
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs answer --project <PROJECT> --id q3 --choice "<option>" [--text "…"]
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs answer --project <PROJECT>   # in a terminal: numbered menu
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs pause|stop|stop-after S05|clear --project <PROJECT>
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs handoff-reset --project <PROJECT>   # forget a Step 0–1 / Step 3 handoff
node ~/.agents/skills/game-producer/scripts/producer-runner.mjs start --dry-run --project <PROJECT>   # what it would do; writes nothing
```

- **It never guesses.** Anything a rule here leaves to judgement becomes one question with fixed
  options in `.cursor/producer-runner.json` (shown by `status`; the runner waits, using no model).
  Contract drift — a slice in progress that MILESTONES lacks, two slices in progress, a policy line
  that locks a different agent than `fleet:`, a director decision not written as `<Sxx> GIVEN|approved`
  — stops it with a question, never with an interpretation.
- **Answering** — a new question rings, sends a desktop notification and (macOS) opens a dialog
  listing the options (`scripts/answer-dialog.mjs`; "Later" closes it). Three ways in, one record
  (the first answer wins, the runner applies it once):
  - the runner's own terminal shows the question with numbered options: type the number + Enter
    (`2 only the test file` adds a note; a choice that needs one asks for it);
  - the dialog (a gate's choice asks for an optional note: it goes to the coordinator);
  - `answer` — with `--id/--choice/--text`, or with no `--choice` in a terminal for the same menu.
  `PRODUCER_RUNNER_DIALOG=0` / `PRODUCER_RUNNER_TTY=0` turn the dialog / terminal prompt off — set
  `PRODUCER_RUNNER_TTY=0` when starting the runner in the background of a shell (`&`); an agent
  answering for the director always passes `--id/--choice` (the menu waits for a keyboard). A
  restarted runner reopens the dialog unless it is still open or was closed with "Later". Every
  question comes with where the run stands: project · slice title (lane and phase, or its status),
  release progress, the runner's last event.
- **`release.autopilot: retry_once`** (default off; a policy token wins): the routine "try again"
  answers come from the runner itself, once per slice and kind — commit_stalled → resend commit,
  reviewer_hung → a fresh reviewer, lane_hung → another resume lane, changes_after_rounds → one more
  fix round, orca_error → retry. The same stop again, or any other
  question, waits for the director (or the judge). Logged as `autopilot on qN`.
- **Single-lane commit (pilot 2):** the commit request says what to do — `/commit-guard` on the
  checkout, then HANDOFF `committed` + the full sha. A writer that commits and says nothing: the only
  new commit on main since the request — not a merge, naming the slice in its subject or a path it
  touches — is taken as the slice commit (logged); anything else →
  `commit_stalled` lists them with "the newest commit is the slice, continue". Idles are counted from
  the last commit request, so a stall after "resend commit" is asked again (it used to wait in silence).
- **director_gate** (a `needs_director_ok` slice with no decision on the policy line): the first
  choice `<Sxx> GIVEN — record it on the policy line` makes the runner append
  `(director gate: <Sxx> GIVEN — <note>; recorded by producer-runner <date>)` to the policy line and
  start the slice; "decided, retry" is for a decision the director wrote there themselves.
- **`release.manual_required: defer`** (default `ask`; a `manual_required=` policy token wins): when
  the only Step 2d problem is `manual_required` — the newest review ends APPROVED, `runtime-state.json`
  and the evidence files are there — the runner commits and merges anyway, writes the items to
  `T-<Sxx>/evidence/manual-deferred.json`, puts `manual_deferred=<n>` in the slice's Notes line and
  lists them under `status` → `manual_deferred`; Step 3 shows them to the director before build or
  deploy and writes `signed_off` into each file once they are done or waived (`status` then drops
  them). Missing evidence or a review that is not APPROVED still asks — first, before any manual check.
- **Bookkeeping commit:** after `record` (merge journal step `notes_commit`) the runner commits what it
  changed on main — `AGENT_NOTES.md` (release cache, Notes line), the slice's *tracked* evidence files
  the evidence step refreshed, a tracked `lessons.jsonl` — as `chore(producer): record <Sxx> merge —
  notes, evidence`, by path: those files go in whole (a director's unstaged edit inside
  `AGENT_NOTES.md`, e.g. the policy line, goes with them); every other file, untracked files (an
  Editor's new `.meta`) and runner state files stay out. Skipped (noted in the journal) under
  `auto_commit=false` or `auto_merge=false`, off the slice's base branch, or when a listed file has
  staged changes. A failing commit (a hook, a 120 s timeout — SIGTERM, so git drops its index.lock) is
  logged and left for the director — the
  next slice's step retries it; the slice still finishes.
- **Judge** (`judge_agent: claude --model <m>` in AGENT_NOTES): one `claude -p` read-only call
  (`reference/judge-prompt.md`) answers fleet gates and lane questions the contracts already settle,
  unknown HANDOFF statuses and verdict-line mismatches; it can only pick an offered option or defer,
  never stop / block. Other providers are not verified yet: their questions go to the director.
- **Cursor that cannot log in** (`cursor-agent status` can say "Logged in" while every run waits at
  the login screen): the runner probes once per run (`cocos-orca-fleet/scripts/agent-ready.mjs`).
  Cursor off and a lane, coordinator, verifier or LLM producer on a Cursor spec → before that spawn,
  one `cursor_off` question for the whole run: move every Cursor role to
  `claude --model sonnet --effort high` (kept as `cursor_substitute`) or log Cursor in and retry.
  Policy `no_cursor=true` moves them without asking. `art_backend: cursor` → `cursor_art` (pick
  another backend). Fleet locks end in `cursor=on|off`, plus a note when roles were moved.
- **HANDOFF statuses:** one that only names a step (`implementing`, `reviewing`, …) counts as
  `working`; any other unknown status is a question (with "treat as working, keep waiting").
- **Fleet specifics (pilot 1):** the verdict is `review.md` or the highest `review-r<N>.md`,
  whichever was written later; a final `review.md` that turns the last round's CHANGES_REQUESTED into
  APPROVED must name a gate whose decision the runner sent (else `verdict_override` — a speed bump
  against the coordinator's say-so, not proof: a new highest round file is read as a review round); a
  "terminal missing" from orca-wait is checked with `orca terminal show` before `coordinator_missing`
  (5 in a row while Orca still shows it → asked anyway); one gate question lists every pending gate,
  the relay names the others (not for a judge answer), and after a relay another gate waits 3 idle
  pauses for the coordinator; the commit line is `approved — commit (producer: Step 2d passed)`; a
  merged worktree whose only changes are evidence files the copy carries (no PNG, no runner file) is
  copied to main once more and removed with `--force`, any other change keeps it.
- **One producer per project:** the runner holds `.cursor/producer.lock` (a second `start` or a
  `launch` is refused). An LLM producer does not take that lock: never run an LLM slice loop while
  `producer-runner.mjs status` shows a live runner; the Step 0–1 / Step 3 producers never dispatch
  slices. `handoff-reset` forgets a Step 0–1 / Step 3 handoff so the runner may spawn a new one.
- **Phase 1 limits:** `max_parallel=1`; a port slice without a reviewed slice study stops
  (`needs_slice_study`: run the study with an LLM producer); verifying main after a fleet merge needs
  3.8 + Funplay — cc4 or no Funplay → the director verifies; a single lane gets the preview port from
  the newest `preview-startup.json` or records it itself.
- State: `.cursor/producer-runner.json` (questions, run-wide reviewer switch, LLM handoffs) and
  `T-<Sxx>/producer-state.json`, `producer-log.md`, `merge-journal.json` (all resumable after a kill).

## Inputs (all at project root — abort with one `ask` if any is missing)

| File | Use |
|------|-----|
| `AGENT_NOTES.md` leading yaml + `policy` line | `release:` / `fleet:` locks; you own `current_slice`, `slices`, `*_url`. Do not load Notes history. Pass resolved locks into lane prompts — lanes never open this file |
| `MILESTONES.md` | `slices`, `dag`, `parallel_ok`, `v1_slice`, `release_slice`, `stop_when` |
| `slices/S<nn>-*.md` | per-slice PLAN source (front-matter) — see [reference/slice-to-plan.md](reference/slice-to-plan.md) |
| `RELEASE_CHECKLIST.md` | product "done" rows; release slice reviewer runs all of them |
| `GAME_BRIEF`, `SCOPE`, `ARCHITECTURE`, `PLAYTEST`, `FOLLOWUPS`, `EXPECT_GAMEPLAY_VISUAL`, `ASSET_MANIFEST` | context for every lane prompt |

Missing `MILESTONES.md` / `slices/` → stop: "run `game-brief` first". Do not invent slices.
For any rip input (rip_port, brief/store_clone rip paths, or a merged RIP_PACK.json), resolve
the analysis path from `rip_port.analysis_path` → `brief.rip_port_path` → reference/<slug>/rip-port, and run
`node ~/.agents/skills/rip-port-analysis/scripts/validate-rip-port.mjs <project> --analysis-path <resolved path>`
before initial dispatch; run game-brief's contract validator to verify slice analysis pins.
Carry the resolved analysis path/hash into lane handoffs. Workers may read the slice's
`Port evidence` reports and the exact source files cited there; source trees remain read-only.
Missing/stale analysis returns to rip-port-analysis then targeted game-brief amendment, not
screenshot-led replanning. Keep unaffected completed slices intact; material parity gaps use
the existing director decision gate. Review requires RP-linked scenarios, not only visual match.
**Slice study (port).** Before dispatching an unmerged port slice, unless it declares
`rip_study: []`, run `~/.agents/skills/rip-port-analysis/SKILL.md` § Slice study: launch the
locked `rip_port.analyst_agent` with the filled `references/slice-study-prompt.md`, gate with
`validate-rip-port.mjs <project> --analysis-path <path> --slice <Sxx> --allow-analyzed`,
spot-check two or three `adopt` claims against their extracts, set the study reviewed, rerun
without the flag and record `rip_port.slice_studies.<Sxx>` (the one `rip_port` key you write).
Pass `<RIP_STUDY>` (study directory + manifest SHA-256) into the lane prompt. A stale study is
refreshed, never bypassed; one that cannot be produced leaves the slice `planned` with the
error reported. You may run the next slice's study while a lane works (it writes only its
study directory).
`brief.contract_depth` absent means `full`. If it is `playable`, only `v1_slice` may dispatch,
and only for `release.goal=playable`. Before a later slice or end_to_end run, route a targeted
game-brief expansion, preserving merged slices; require depth=full and fresh contract gates.
For projects using `docs/brief-progress.json`, require phase=done and a current contract hash
(`node ~/.agents/skills/game-brief/scripts/brief-progress.mjs --project <project> --watch` → done)
before initial dispatch or accepting a brief amendment. Implementation-owned updates to PLAYTEST
or FOLLOWUPS after a slice starts are reviewed by the normal lane gate; do not misclassify those
as a new brief amendment or restart authoring solely because that content changed.
Do not use an outline or a stale marker as a runnable PLAN. Legacy projects without this marker
continue through the existing Step 0 checks.
You create `.cursor/evidence/lessons.jsonl` (Step 2d) and `docs/retro.md` (Step 3.6); they are
not start-gate files.

## Policy (locked once at start, announce in one line)

```
Producer locks: goal=<end_to_end|playable> · auto_commit=<bool> · auto_merge=<bool> ·
deploy=<none|preview|prod> · budget=<advisory|gate:<pct>> · lite_when_no_assets=<bool> · max_parallel=1 ·
lanes: L→fleet(<orchestrator_agent>, scanner=<scanner_agent>), L-no-assets→fleet lite, S/M→single(<writer_agent>) · reviewer=<reviewer_agent>
```

Precedence: director prompt > `AGENT_NOTES.md` > defaults (`end_to_end`, `true`, `true`,
`preview`, `budget_mode=advisory` (SCOPE.md `budget_mode` wins over this default; `gate` uses
`budget_auto_bump_pct`, default 15), `fleet_lite_when_no_assets=true`, `max_parallel=1`).
Pass the result to lanes as `<BUDGET_MODE>` (`advisory` or `gate:<pct>`).
A legacy policy line with only `budget_auto_bump=<pct>%` (no `budget=`) resolves to `advisory` unless
SCOPE.md says `budget_mode: gate`; rewrite the token as `budget=advisory` when you next touch it.
`max_parallel=2` only when the director asks **and** the pair is in `parallel_ok` (each fleet
opens its own Creator + Funplay port; RAM is the limit).
`reviewer_agent` must reach `127.0.0.1`. Keep the locked provider, including Codex:
its corrected launcher bypasses approvals and sandbox as configured in Orca. Check actual
preview connectivity; do not infer failure from provider identity. Before a provider fallback,
inspect the actual launch command and correct a stale restricted launch once, after confirming
the old reviewer has stopped. Only use the existing infrastructure fallback for an observed
failure that remains after launch settings are corrected.

## Progress checklist

```
Producer:
- [ ] 0. Assert pwd == project root (or Orca child); git status; read inputs; lock policy
- [ ] 1. Director gate: list slices with needs_director_ok=true → one `ask`; wait; record answers in notes
- [ ] 2. Loop until stop condition:
      a. next = first slice in MILESTONES.slices whose deps are merged and status ∉ {merged, shipped, blocked}
      b. release.current_slice = next; slices[next] = in_progress
         port slice (rip_study ≠ []) → reviewed slice study pinned first (see Inputs)
      c. lane by size → spawn (fleet | fleet lite | single) with the slice prompt; wait on
         <evidence>/HANDOFF.json (see Waiting), never on terminal text
      d. APPROVED (incl. any budget_bump in advisory mode) → commit (auto_commit) → harvest evidence → merge +
         worktree rm (auto_merge) → slices[next] = merged
         INFRA_BLOCKED → not a fix round: swap reviewer to cursor auto / integrator recovery, re-review
         CHANGES_REQUESTED after lane's fix rounds → slices[next] = blocked → one `ask`
         manual_required → slices[next] = blocked (release.manual_required: defer → merge, record
         the checks; Step 2d); reuse existing preview escalation (see Preview)
      e. rewrite the slice's ONE line in `## Notes — game-producer`; collect cost events,
         learning candidates and reviewed recipe reuse once (see Notes discipline)
      f. goal=playable and next == v1_slice → break
- [ ] 3. goal=end_to_end and release_slice merged → ship per release.deploy; record URLs; tag v1.0.0
      goal=playable → ship preview only if deploy != none (never prod)
      then RETRO: lessons + candidates + stats → docs/retro.md, including deploy=none/playable
- [ ] 4. Final report: slice table with statuses, commits, URLs, blocked items, retro path; stop
```

## Step 0 — start

1. `pwd` must be the project root the director named (or an Orca child worktree). Dirty files
   other than the contract set → snapshot into `forbidden_changes` for every lane.
2. Read the leading yaml fence of `AGENT_NOTES.md` plus the `policy` line (python/sed — not the
   rest of the file), then `MILESTONES.md`, `slices/`, `RELEASE_CHECKLIST.md`, and the root
   contracts. Build the runnable order from `MILESTONES.dag` (topological; ties by `slices`
   order). Validate: every id has a file; `release_slice` is last; no `parallel_ok` pair shares
   a path. A validation failure is a **Fable** problem — report it and stop; do not patch.
3. Lock policy (above). Write the one `policy` line. Write `release.current_slice: ""` and every
   missing id into `release.slices` as `planned`.
4. **Resuming** (a previous producer hung, or the director says "resume from Sxx"): git is the
   truth, the yaml is a cache. Before touching anything run
   `git log --format='%h %s' -20` and `git worktree list`; a slice whose `feat(Sxx)` commit is an
   ancestor of HEAD is `merged` regardless of the yaml; a live worktree `<slug>/Sxx-*` means that
   slice is `in_progress` — reattach (read its `HANDOFF.json`, `orca terminal list` for its
   handles), never re-dispatch. Correct the yaml to match, append one line to
   `.cursor/evidence/tasks/T-<Sxx>/producer-log.md` with the evidence you used, then continue the
   loop. Never re-run the director gate for decisions already in the `policy` line.
   Optional memory (run only if the launcher exists; use a pack only on `inject: true`): after the git
   check, at most one bounded `M=~/.orca-memory/bin/orca-memory; [ -x "$M" ] && "$M" hook
   recover --task T-<Sxx> --query "<symptom in English>"`; read the `pack` path it prints.
   Git and live Orca state stay the truth; memory never justifies a re-dispatch or a lock change.

## Notes discipline — AGENT_NOTES.md is state, not a log

Keep shared startup state compact; cc-meowdoku's old producer history grew to 14 KB.
Workers receive resolved locks and selected recipe references instead of loading Notes. Rules:

| Where | What | Size |
|---|---|---|
| yaml `release:` | `current_slice`, `slices`, `*_url` — the resume state | fixed |
| `## Notes — game-producer` | ONE `policy` line (locks + director-gate answers), ONE line per slice **rewritten in place** on each state change, ONE `ship` line | ≤ slices + 2 lines |
| `.cursor/evidence/tasks/T-<Sxx>/producer-log.md` | spawned / handle / nudge / resume / review round timestamps — append freely | unbounded, read only when debugging |
| `HANDOFF.json` | live status + terminal handle of the current lane | per slice |
| `.cursor/evidence/lessons.jsonl` | cost events + deduplicated recipe candidates/reuse at Step 2d | producer/retro only |

Slice line format (rewrite, do not append):
`- S06 fleet merged fix_rounds=1 bump=650→680 commit=714d5b6 merged=y -`

Cost events → `lessons.jsonl` (append one line when the slice ends, only if something cost time;
always append a `budget_bump` event with `"from"`, `"to"`, `"ratio"` when the diff exceeded the
slice budget — game-brief calibrates future budgets from these):

```json
{"slice":"S04","event":"infra_blocked","count":4,"cost":"4 review rounds, ~2.5h","minutes":150,"cause":"codex sandbox cannot reach 127.0.0.1","system":"agent:review","fix_target":"template:AGENT_NOTES.md reviewer_agent","evidence":".cursor/evidence/tasks/T-S04/evidence/review.md","at":"2026-09-18T11:50:00Z"}
```

`event` ∈ `fix_round | infra_blocked | respawn | director_gate | budget_bump | script_fixed_by_hand |
merge_conflict | evidence_lost | other`; `fix_target` ∈ `skill:<name> | template:<path> |
contract:<Fable field> | none`; `system` ∈ `agent[:<role>] | orca | gateway | engine | brief |
art[:<backend>] | ship | memory | other` — the part of the workflow that cost the time, not where
to fix it (the runner sets it from the event; an LLM producer sets it from the cause). Optional:
`origin_slice` when an earlier slice introduced the cause, `minutes` when the cost is known.
`tools/workflow-scorecard` reads these as written. Facts only (what failed, what it cost, the file
that proves it); no proposals here — those are the retro's job.

### Recipe learning

Optional library: `~/.agents/skills/cocos-playbook/SKILL.md` (fallback
`/Users/wikz/Works/games/cocos-playbook/SKILL.md`). Read its `references/workflow.md` for
candidate/reuse records. If unavailable, keep task-local findings and continue normally.
Forward the slice's optional `recipe_refs` unchanged to both lanes (missing field = `[]`);
the planning owner selects recipes, not the producer. Role cards explicitly permit reading
these selected files. Workers never scan the library or producer lessons.

Before accepting/removing a checkout, collect its `learning-candidates.json` and reviewed
recipe outcomes into lessons, including successful patterns with no cost. Dedupe by
`candidate_id`; retain archived project-relative evidence paths. Collect known cost events
and incomplete learning evidence before returning a blocked/failed slice too. After a
reviewed technical milestone, an interim retro may curate candidates within existing library
authorization; otherwise propose them in the project. No new default or silent promotion.

## Step 1 — director gate

Collect slices with `needs_director_ok: true` (plus every `risks` line that asks a question).
Send **one** `orca orchestration ask` (or a plain question when no Run exists yet) listing them;
wait for the reply; write the decisions into `## Notes — game-producer` (they are now GIVEN for
the lanes). No answer within the wait budget → proceed with slices that are not flagged, keep
the flagged ones `planned`, and say so.

## Step 2c — lanes

Optional memory (run only if the launcher exists; use a pack only on `inject: true`). Before spawning
either lane, from the main checkout run
`M=~/.orca-memory/bin/orca-memory; [ -x "$M" ] && "$M" hook plan --task T-<Sxx> --query-file <SLICE_FILE> --out <main task evidence dir>/memory/plan`
(the absolute task evidence dir for T-<Sxx> in the main checkout). On `inject: true`, fill
`<CONTEXT_PACK>` with the absolute path of `memory-context.md` in that dir; otherwise
`<CONTEXT_PACK>` is `none`. Forward it next to the `recipe_refs`; never paste pack text into a
prompt. For the single lane's reviewer, run `hook review --task T-<Sxx> --acceptance <file of
the slice acceptance rows> --base HEAD --out <EVIDENCE_DIR>/memory/review` after the writer is
`ready_for_review`, and fill its `<CONTEXT_PACK>` from that result, never from the plan pack. A
pack is advisory: no permission or approval, never above the slice, contracts or reviewer
evidence, and its limitations apply. The mode lives in the operator config only.

### L → `cocos-orca-fleet` (default for anything with art + scene + code)

Spawn the fleet orchestrator in a **new terminal in this project** with the locked
`fleet.orchestrator_agent`:

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --json \
  --path "<PROJECT>" \
  --agent "<fleet.orchestrator_agent>" \
  --role coordinator --slice <Sxx> \
  --title "fleet-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/fleet-slice-prompt.md filled for <Sxx>…
EOF
)"
```

`--role coordinator` launches the orchestrator without the editor's MCP tools (it never edits
through Funplay; it uses `probe.mjs` and `preview-startup.json`) and tags the launch for the token
report. Every lane you spawn for a slice (fleet, single writer, reviewer, resume lane) carries
`--role` and `--slice`.

The fleet writes a pointer PLAN to the slice file (mapping in
[reference/slice-to-plan.md](reference/slice-to-plan.md); fleet Step 0.5 branch B — a cheap
`orchestrator_agent` is fine because no planning judgment is needed), creates its own
worktree, runs scan → art → implement → integrate → review, and ends at **"offer commit"**.
**Fleet lite:** when the slice's `assets` block is empty (no 2d/3d/vfx/audio) and
`fleet_lite_when_no_assets` is true, put `LITE: true` in the prompt — the fleet skips scan and
every art Task (implement → integrate → review only). cc-meowdoku S06/S08 paid the full fleet
boot for zero art.
If the fleet `ask`s for a field the slice lacks, that is a Fable gap: answer only from the
contracts, otherwise mark the slice `blocked` and report — never let the fleet improvise it.

### Waiting (both lanes) — the status file, not the terminal

Every lane writes `<checkout>/.cursor/evidence/tasks/T-<Sxx>/evidence/HANDOFF.json`
(`status: working | blocked | ready_for_review | infra_blocked | approved | changes_requested |
offer_commit | committed`). `<handle>` is the lane's own terminal: `.session.handle` from
`agent-session --json`, logged in `producer-log.md` at spawn. Fleet lane: once its Run exists,
log the run id (`orca orchestration run-list --json` → the Run whose `coordinator_handle` is that
handle) and re-resolve from `run-show --id <run> --json` after any resume. Never pick a handle
by worktree path or title — agent CLIs rewrite titles, and the feature worktree's terminals are
workers (S08: four nudges over 2 h went to the implement worker while the coordinator, retitled
"Workspace startup procedures", sat stalled). Wait like this and nothing else:

```bash
# fleet lane: --run (the coordinator handle is re-read from run-show every minute: takeovers replace it)
node ~/.agents/skills/cocos-orca-fleet/scripts/orca-wait.mjs lane --run <run_id> \
  --handoff <wt>/.cursor/evidence/tasks/T-<Sxx>/evidence/HANDOFF.json \
  --state <PROJECT>/.cursor/evidence/tasks/T-<Sxx>/producer-state.json
# single lane: --handle <writer or reviewer handle> instead of --run
```

One JSON line: `event` (`idle` | `handoff` | `gate` | `terminal-missing` | `orca-error` | `timeout`),
`handle`, `handle_changed`, HANDOFF `status`/`detail`/`sha`, `handoff_changed`, `idle_streak`
(a new handle starts at 1), `pending_gates`, `unread_to_run`. `terminal-missing`: a single lane
gets a resume lane (rule below); a fleet coordinator is never respawned — report it. `orca-error`:
the runtime failed, not the lane — retry the wait once, then report. `unread_to_run` > 0 on an idle
coordinator is the stall evidence used below. It never runs past `--max-ms` (default 540000; give the Bash
tool `timeout: 600000`); a `timeout` is a checkpoint. No `terminal read` polling, no grepping for
"READY FOR REVIEW" (it matches the prompt you sent — false READY on S07). Keep `--state` in the
main checkout, never in the lane's evidence dir (the fleet commits that dir).

**Single-agent lane:** `working` with `idle_streak` 2 → one nudge naming the
missing evidence files, then `orca-wait lane` again. `idle_streak` 3 (idle, HANDOFF unchanged) →
treat as hung: `terminal close`, spawn a resume lane (same evidence dir, "finish verify +
evidence only", `--role worker --slice <Sxx>`), note it.

**Fleet lane:** a healthy coordinator is busy (its `check --wait` runs in the foreground), so
wait timeouts are normal for hours. Idle with `offer_commit` / `blocked` / `infra_blocked` →
your move. Idle with any other status → stalled (S08 lost ~3 h this way):
`orca orchestration inbox --json` shows its unread (`read: 0`) messages to `run:<run>`; send
**one** nudge to the coordinator: "resume the cocos-orca-fleet Coordinator loop: `check --ack`
the Delivery you last handled (bare `check` if none), handle the batch — including <unread
ids> — then keep a foreground `check --wait`". Still idle with no progress after that →
report to the human. Never close or respawn a fleet coordinator (a replacement needs a
`run-use` takeover — the human's call) and never do its job for it.

Read `review.md` only when the status says a verdict exists.

Answer the fleet's questions as the director would: preview requests → see *Preview* below;
scope questions → answer from the slice file / SCOPE.md; anything not answerable from contracts
→ relay to the human with one `ask`. A pending fleet gate (`orca orchestration gate-list --run
<run> --json`) is read-only for you: send the decision as plain text to the coordinator
(`orca terminal send`) and let it resolve its own gate. Against a lane's Run you never run
`run-use`, `gate-resolve`, `task-create` / `task-update`, `worker-*`, `dispatch`, `send` /
`reply`, or anything with `--from <coordinator>` — `run-use` fences the live coordinator
(S08: the producer bound itself to resolve a gate, then later dispatched a fix Task as the
coordinator).

### S / M → single agent (`vibe-game-director`)

Spawn the locked `fleet.writer_agent` in the **main checkout** (main Creator is open there):

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --json \
  --path "<PROJECT>" --agent "<fleet.writer_agent>" --role worker --slice <Sxx> \
  --title "slice-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/single-slice-prompt.md filled for <Sxx>…
EOF
)"
```

With `--json`, stdout is exactly one JSON object (`.session.handle`) and progress lines go to
stderr — redirect stdout to a file and parse that; spawn exactly once (a failed parse on S07
led to a second writer on the same evidence dir).

Then spawn a **fresh** reviewer terminal (`fleet.reviewer_agent`, `--role worker --slice <Sxx>`)
with the review section of the same reference — a single lane still gets an independent review
before you accept it.

### Preview (both lanes)

- cc4 (`bootstrap.engine: cocos-cli`): have the lane's integrator reuse/start preview —
  `cocos preview --project <checkout> --platform web-mobile --port <pinned> --no-open` in the lane's
  checkout (read `cocos-cli-mcp.config.json` → `preview_port`, or `node scripts/resolve-ports.mjs --shell`;
  see `.cursor/skills/open-cocos-editor`). Verify readiness and record the URL in the same
  preview-startup.json handoff used below.
- 3.8 / Funplay: route startup/recovery to the lane's integrator (S/M: the single agent in its
  integrator role). It verifies the pinned connection's projectPath, discovers the tools,
  reuses a healthy browser preview or calls `run_project_preview({mode: "browser"})`, and
  verifies the returned URL. It writes `evidence/preview-startup.json` and hands the URL to the
  reviewer. Follow the project's `preview-interact-playbook.md` §Automatic preview startup.
- Both lanes: automatic-start failure → read the recorded tool/error and `humanRequest` before
  escalating. Reuse the coordinator's request, or relay it to the human once if not yet delivered;
  store the human-facing request id/timestamp and blocker key in the shared startup record.
  Never repeat "still waiting", require a literal "preview started" reply, or reset the request
  for a new review number. Resume when readiness is observed after relevant new evidence/input.
  Unavailable runtime remains `manual_required`: mark the slice `blocked`, continue independent
  slices, and report the blocker. Do not launch repeated reviews for an unchanged startup failure,
  or approve/merge a slice on unverified evidence.

Launch recovery: before switching a reviewer provider for localhost failure, verify the actual command matches Orca settings. Correct an old restricted launch once using the same locked provider/model, after confirming its old process and jobs have stopped; retry the preflight. Provider identity alone does not prove a sandbox failure. The fallback below applies only to a remaining observed failure.

## Step 2d — accept, commit, merge

APPROVED means: reviewer's `review.md` ends `APPROVED`, no `manual_required` in
`runtime-state.json`, evidence files present, feel/VFX acceptance rows reviewed. Exception:
`release.manual_required: defer` (the director's standing call) — APPROVED with everything else
present and only `manual_required` checks left → commit and merge, record the checks in
`T-<Sxx>/evidence/manual-deferred.json` and `manual_deferred=<n>` in the notes line; Step 3 shows
them to the director before build or deploy. A
`budget_bump: <from>→<to>` line above the verdict is still APPROVED — in `advisory` mode for any
size of overrun; record it in the notes entry and `lessons.jsonl`, no gate, no ask. A review that
lists a budget overrun as a finding in advisory mode is a misread: drop that finding (not a fix round);
when it was the only blocker/major, the verdict counts as APPROVED. `gate:<pct>` mode only: above
`<from> × (1 + pct/100)` → `blocked`, one `ask` (`bump_lines_<n>` | `cut_to_<budget>`).
`tripo_credits` over its cap → `blocked`, one `ask`, in every mode.

`INFRA_BLOCKED` (review.md last line): not a fix round, no notes entry beyond one line. Your own
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` → 200 ⇒ the reviewer agent
cannot reach localhost: spawn the same review on `cursor --model auto` and lock that for the
rest of the run. Non-200 ⇒ integrator recovery, then a fresh review. `producer-runner.mjs`
launches every reviewer with bootstrap's current command, so there is no stale launch to correct
first: its first 200-with-INFRA_BLOCKED moves straight to `cursor --model auto` — unless Cursor is
off (policy `no_cursor=true` or the runner's probe), then it asks instead.

1. `auto_commit=true` → reply to the lane terminal: *"approved — commit"* (single lane), or for a
   fleet lane the exact line *"approved — commit (producer: Step 2d passed)"* — the fleet prompt
   commits on nothing else, so a director committing by hand types that line too; the lane runs
   `/commit-guard` in its checkout and sets HANDOFF `committed` + sha. `false` → mark
   `approved`, `ask` the director, wait.
2. **Harvest evidence before anything is removed** (fleet lane): if the slice commit did not
   include `.cursor/evidence/tasks/T-<Sxx>/` (check `git show --stat <sha>`), copy it now:
   `rsync -a --exclude '*.png' <wt>/.cursor/evidence/tasks/T-<Sxx>/ <main>/.cursor/evidence/tasks/T-<Sxx>/`.
   cc-meowdoku lost T-S06 and T-S08 (`stats.json` included) to `worktree rm`.
   Optional memory harvest, before that rsync (skip unless the launcher exists):
   `M=~/.orca-memory/bin/orca-memory; [ -x "$M" ] && "$M" hook harvest --wt <wt> --task T-<Sxx>`.
   It archives candidates, review.md, HANDOFF.json and the PNGs they reference outside the
   project (status `off` = nothing copied). A non-zero exit means the copy failed: keep the
   worktree, skip `worktree rm`, and report it. Single lane: run it with `--wt <PROJECT>`.
3. `auto_merge=true` (fleet lane) → run the `cocos-orca-worktree` finish sequence yourself.
   Close **both** Creators before merge: first `<wt>/scripts/close-editor.sh <wt>`, then
   `<main>/scripts/close-editor.sh <main>`. Confirm each checkout's
   `probe.mjs --only funplay` reports nothing listening; if primary shutdown cannot be confirmed,
   do not merge. With both Editors closed, run `git -C <main> merge --no-ff <branch>`, then
   `orca worktree rm --worktree path:<wt> --run-hooks --json`. Reopen the primary Editor with
   `<main>/scripts/open-editor.sh <main>`, wait for primary Funplay parity with one foreground
   `node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs wait-mcp --path <main> --timeout-ms 180000`
   (no retry loop), and perform the
   primary-checkout integration/runtime verification before marking the slice merged. When
   Feature Cropping changed, verify each active config's `includeModules` contains both the
   parent feature and selected backend (for example `physics` + `physics-ammo`). An untracked
   file in main that the merge would overwrite (usually a stray `docs/plans/<Sxx>.md`) → `mv`
   it to `/tmp/<Sxx>-stash/`, merge, diff, drop it if identical. Real conflict → stop, `ask`.
   Single lane committed on main → nothing to merge.
4. `release.slices[<Sxx>] = merged`, `current_slice = ""`; rewrite the slice's line in the notes:
   `- <Sxx> <lane> merged fix_rounds=<n> bump=<from→to|none> commit=<sha> merged=<y/n> <blocker|->`.
   Reconcile harvested cost events, `learning-candidates.json` and reviewed recipe outcomes
   into `lessons.jsonl` once — see Notes discipline. Successful patterns need no cost threshold.
5. Release the lane terminal (`orca terminal close`) unless the director wants it kept.

## Step 3 — release / playable completion and retro

Follow `.cursor/skills/ship/SKILL.md` from the main checkout. No `ship` skill in this project
(playable template) → treat `deploy` as `none`: run `build/build.sh` if present, otherwise report
the merged state; still run the retro before the final report. A playable stop with deploy=none
also runs retro without being marked shipped solely for completing the retro.
For playable + deploy=none, go directly to step 6. With no ship skill, perform only the optional
build just described and step 6; do not fall through into deployment, tagging or shipped-state
updates. These branches still include the retro path in the final report.

1. `build/build.sh --clean` — trust the script's verdict.
2. `deploy != none` → `build/deploy.sh` (preview). Vercel preview URLs are usually behind
   deployment protection (302 → login): check the served HTML with `npx vercel curl <url>` (or
   `--` `-I`) from `build/web-mobile`, not plain `curl`. Smoke the deployed URL via the Orca
   browser (`.cursor/skills/smoke-test`): cold load, one full play → fail → restart, no console
   errors. Record `release.last_preview_url`.
3. `deploy == prod` **and** goal == `end_to_end` **and** smoke passed → `build/deploy.sh --prod`;
   record `release.last_prod_url`. Never prod for `playable`.
4. `git tag v1.0.0` (end_to_end) — do **not** push unless the director asked.
5. `release.slices[release_slice] = shipped`; the ONE `ship` notes line with URLs and RC rows status.
6. **Retro**: reconcile lessons, surviving task candidates and stats per
   [reference/retro.md](reference/retro.md); write `docs/retro.md` at release/playable completion
   even without deployment. Preserve cost filtering for operational fixes; evaluate reusable
   successful techniques separately. Missing lessons is not an early exit. Shared-library
   curation requires existing authorization; recipe defaults and template/skill edits are
   separate decisions. Report proposed recipe ids, evidence gaps and retro path.
   Optional memory recurrence check (`hook retro`) is described in the retro reference;
   its matches feed proposals only.

## Stop conditions

| goal | stop when |
|------|-----------|
| `playable` | `v1_slice` merged (+ preview URL if `deploy != none`) |
| `end_to_end` | `release_slice` shipped (or `deploy: none` → merged + build served OK) |
| either | a slice is `blocked` and nothing else is runnable → report, stop |

## Anti-patterns

- Editing game files, slice files, or the PLAN "to unblock" — producer is read-only on contracts.
- Running the fleet DAG from this terminal (this is the fleet orchestrator's job; nested
  dispatch depth is 1 — you spawn orchestrators as terminals, never as orchestration Tasks).
- Binding to or mutating a lane's Run — `run-use`, `gate-resolve`, `task-*`, `worker-*`,
  `--from <coordinator>` — "to unblock" it: `run-use` fences the live coordinator. Decisions go
  to the coordinator as plain text.
- Nudging a terminal picked by worktree path or title instead of the logged coordinator handle;
  closing or respawning a stalled fleet coordinator instead of one "resume the loop" nudge.
- A `terminal wait` `--timeout-ms` above your shell tool's cap (the tool kills it mid-wait).
- Two fleets on the same paths, or `max_parallel=2` without `parallel_ok`.
- Marking `merged` when `runtime-state.json` says `manual_required`.
- `deploy.sh --prod` without a passed preview smoke, or for `goal: playable`.
- Re-asking locked policy; skipping the director gate for `needs_director_ok` slices.
- Pushing, merging while either the worktree or primary Creator is open, or `worktree rm` before
  the evidence dir is in main.
- Polling `orca terminal read` on a timer, or grepping the tail for "READY FOR REVIEW".
- Opening a director gate, fix round or trim request for a `files`/`lines`/`nodes`/`assets`
  overrun in advisory mode (or inside `budget_auto_bump_pct` in gate mode).
- Counting a preview-unreachable review as a fix round, or re-spawning the same sandboxed
  reviewer agent after an `INFRA_BLOCKED`.
- Parsing `bootstrap.mjs agent-session` output without `--json` (mixed logs broke the parse and
  spawned a duplicate writer on S07).
- Appending a progress paragraph to `## Notes — game-producer`, or telling a lane to "read
  AGENT_NOTES.md". Rewrite the one slice line; put handles and timestamps in `HANDOFF.json` /
  `producer-log.md`.
- Writing lessons into `AGENT_NOTES.md` or asking a writer/reviewer to read `lessons.jsonl`.

## Resources

- `~/.agents/skills/cocos-orca-fleet/reference/orca/cheatsheet-producer.md` — every `orca` flag you
  use (terminals, read-only Run state, worktrees); read it instead of running `--help`.
- [reference/producer-prompt.md](reference/producer-prompt.md) — how `new-cocos-game` /
  `store-game-clone` spawn this producer.
- [reference/fleet-slice-prompt.md](reference/fleet-slice-prompt.md) — orchestrator prompt per slice.
- [reference/single-slice-prompt.md](reference/single-slice-prompt.md) — S/M writer + reviewer prompts.
- [reference/slice-to-plan.md](reference/slice-to-plan.md) — slice front-matter → PLAN mapping.
- [reference/retro.md](reference/retro.md) — ship-time `docs/retro.md` from `lessons.jsonl`.
- `../cocos-orca-fleet/SKILL.md`, `../cocos-orca-worktree/SKILL.md`, `../ship/SKILL.md`,
  `../smoke-test/SKILL.md`, `../commit-guard/SKILL.md`.
