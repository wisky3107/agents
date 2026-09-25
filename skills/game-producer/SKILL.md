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
      c. lane by size → spawn (fleet | fleet lite | single) with the slice prompt; wait on
         <evidence>/HANDOFF.json (see Waiting), never on terminal text
      d. APPROVED (incl. any budget_bump in advisory mode) → commit (auto_commit) → harvest evidence → merge +
         worktree rm (auto_merge) → slices[next] = merged
         INFRA_BLOCKED → not a fix round: swap reviewer to cursor auto / integrator recovery, re-review
         CHANGES_REQUESTED after lane's fix rounds → slices[next] = blocked → one `ask`
         manual_required → slices[next] = blocked; reuse existing preview escalation (see Preview)
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
{"slice":"S04","event":"infra_blocked","count":4,"cost":"4 review rounds, ~2.5h","cause":"codex sandbox cannot reach 127.0.0.1","fix_target":"template:AGENT_NOTES.md reviewer_agent","evidence":".cursor/evidence/tasks/T-S04/evidence/review.md","at":"2026-09-18T11:50:00Z"}
```

`event` ∈ `fix_round | infra_blocked | respawn | director_gate | budget_bump | script_fixed_by_hand |
merge_conflict | evidence_lost | other`; `fix_target` ∈ `skill:<name> | template:<path> |
contract:<Fable field> | none`. Facts only (what failed, what it cost, the file that proves it);
no proposals here — those are the retro's job.

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

### L → `cocos-orca-fleet` (default for anything with art + scene + code)

Spawn the fleet orchestrator in a **new terminal in this project** with the locked
`fleet.orchestrator_agent`:

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --json \
  --path "<PROJECT>" \
  --agent "<fleet.orchestrator_agent>" \
  --title "fleet-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/fleet-slice-prompt.md filled for <Sxx>…
EOF
)"
```

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
# block on the terminal going idle, then read the file; repeat. No `terminal read` polling,
# no grepping for "READY FOR REVIEW" (it matches the prompt you sent — false READY on S07).
# tui-idle returns at once on an already-idle terminal; a timeout is a checkpoint. Keep
# --timeout-ms under your shell tool's cap (Claude Code Bash max 600000).
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 540000 --json >/dev/null
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["status"],d.get("detail",""),d.get("sha"))' <HANDOFF.json>
```

**Single-agent lane:** `working` after idle for two consecutive waits → one nudge naming the
missing evidence files, then `terminal wait` again. Three idle waits with no file change →
treat as hung: `terminal close`, spawn a resume lane (same evidence dir, "finish verify +
evidence only"), note it.

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
  --path "<PROJECT>" --agent "<fleet.writer_agent>" --title "slice-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/single-slice-prompt.md filled for <Sxx>…
EOF
)"
```

With `--json`, stdout is exactly one JSON object (`.session.handle`) and progress lines go to
stderr — redirect stdout to a file and parse that; spawn exactly once (a failed parse on S07
led to a second writer on the same evidence dir).

Then spawn a **fresh** reviewer terminal (`fleet.reviewer_agent`) with the review section of the
same reference — a single lane still gets an independent review before you accept it.

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
`runtime-state.json`, evidence files present, feel/VFX acceptance rows reviewed. A
`budget_bump: <from>→<to>` line above the verdict is still APPROVED — in `advisory` mode for any
size of overrun; record it in the notes entry and `lessons.jsonl`, no gate, no ask. A review that
lists a budget overrun as a finding in advisory mode is a misread: drop that finding (not a fix round);
when it was the only blocker/major, the verdict counts as APPROVED. `gate:<pct>` mode only: above
`<from> × (1 + pct/100)` → `blocked`, one `ask` (`bump_lines_<n>` | `cut_to_<budget>`).
`tripo_credits` over its cap → `blocked`, one `ask`, in every mode.

`INFRA_BLOCKED` (review.md last line): not a fix round, no notes entry beyond one line. Your own
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` → 200 ⇒ the reviewer agent
cannot reach localhost: spawn the same review on `cursor --model auto` and lock that for the
rest of the run. Non-200 ⇒ integrator recovery, then a fresh review.

1. `auto_commit=true` → reply to the lane terminal: *"approved — commit"*; the lane runs
   `/commit-guard` in its checkout and sets HANDOFF `committed` + sha. `false` → mark
   `approved`, `ask` the director, wait.
2. **Harvest evidence before anything is removed** (fleet lane): if the slice commit did not
   include `.cursor/evidence/tasks/T-<Sxx>/` (check `git show --stat <sha>`), copy it now:
   `rsync -a --exclude '*.png' <wt>/.cursor/evidence/tasks/T-<Sxx>/ <main>/.cursor/evidence/tasks/T-<Sxx>/`.
   cc-meowdoku lost T-S06 and T-S08 (`stats.json` included) to `worktree rm`.
3. `auto_merge=true` (fleet lane) → run the `cocos-orca-worktree` finish sequence yourself.
   Close **both** Creators before merge: first `<wt>/scripts/close-editor.sh <wt>`, then
   `<main>/scripts/close-editor.sh <main>`. Confirm each checkout's
   `probe.mjs --only funplay` reports nothing listening; if primary shutdown cannot be confirmed,
   do not merge. With both Editors closed, run `git -C <main> merge --no-ff <branch>`, then
   `orca worktree rm --worktree path:<wt> --run-hooks --json`. Reopen the primary Editor with
   `<main>/scripts/open-editor.sh <main>`, wait for primary Funplay parity, and perform the
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

- [reference/producer-prompt.md](reference/producer-prompt.md) — how `new-cocos-game` /
  `store-game-clone` spawn this producer.
- [reference/fleet-slice-prompt.md](reference/fleet-slice-prompt.md) — orchestrator prompt per slice.
- [reference/single-slice-prompt.md](reference/single-slice-prompt.md) — S/M writer + reviewer prompts.
- [reference/slice-to-plan.md](reference/slice-to-plan.md) — slice front-matter → PLAN mapping.
- [reference/retro.md](reference/retro.md) — ship-time `docs/retro.md` from `lessons.jsonl`.
- `../cocos-orca-fleet/SKILL.md`, `../cocos-orca-worktree/SKILL.md`, `../ship/SKILL.md`,
  `../smoke-test/SKILL.md`, `../commit-guard/SKILL.md`.
