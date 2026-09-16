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
  milestones", or after fable-game-brief finished and implement=yes.
disable-model-invocation: true
---

# Game Producer

You are the **producer**: a coordinator of coordinators. You pick slices, spawn the lane that
builds each one, read its verdict, commit/merge, and move on. You never edit game files, never
touch the Editor, never hold the editor lock, never rewrite a slice file.

## Inputs (all at project root — abort with one `ask` if any is missing)

| File | Use |
|------|-----|
| `AGENT_NOTES.md` yaml `release:` | `goal`, `auto_commit`, `auto_merge`, `deploy`; you own `current_slice`, `slices`, `*_url` |
| `AGENT_NOTES.md` yaml `fleet:` | orchestrator / planner / writer / reviewer / art locks passed through to each lane (the fleet lane never launches `planner_agent` from a slice — the slice front-matter *is* the plan) |
| `MILESTONES.md` | `slices`, `dag`, `parallel_ok`, `v1_slice`, `release_slice`, `stop_when` |
| `slices/S<nn>-*.md` | per-slice PLAN source (front-matter) — see [reference/slice-to-plan.md](reference/slice-to-plan.md) |
| `RELEASE_CHECKLIST.md` | product "done" rows; release slice reviewer runs all of them |
| `GAME_BRIEF`, `SCOPE`, `ARCHITECTURE`, `PLAYTEST`, `FOLLOWUPS`, `EXPECT_GAMEPLAY_VISUAL`, `ASSET_MANIFEST` | context for every lane prompt |

Missing `MILESTONES.md` / `slices/` → stop: "run `fable-game-brief` first". Do not invent slices.

## Policy (locked once at start, announce in one line)

```
Producer locks: goal=<end_to_end|playable> · auto_commit=<bool> · auto_merge=<bool> ·
deploy=<none|preview|prod> · max_parallel=1 · lanes: L→fleet(<orchestrator_agent>), S/M→single(<writer_agent>)
```

Precedence: director prompt > `AGENT_NOTES.md` > defaults (`end_to_end`, `true`, `true`,
`preview`, `max_parallel=1`). `max_parallel=2` only when the director asks **and** the pair is in
`parallel_ok` (each fleet opens its own Creator + Funplay port; RAM is the limit).

## Progress checklist

```
Producer:
- [ ] 0. Assert pwd == project root (or Orca child); git status; read inputs; lock policy
- [ ] 1. Director gate: list slices with needs_director_ok=true → one `ask`; wait; record answers in notes
- [ ] 2. Loop until stop condition:
      a. next = first slice in MILESTONES.slices whose deps are merged and status ∉ {merged, shipped, blocked}
      b. release.current_slice = next; slices[next] = in_progress
      c. lane by size → spawn (fleet | single) with the slice prompt; wait for verdict
      d. APPROVED → commit (auto_commit) → merge + worktree rm (auto_merge) → slices[next] = merged
         CHANGES_REQUESTED after lane's fix rounds / manual_required unanswered → slices[next] = blocked → `ask`
      e. append one entry to `## Notes — game-producer`
      f. goal=playable and next == v1_slice → break
- [ ] 3. goal=end_to_end and release_slice merged → ship per release.deploy; record URLs; tag v1.0.0
      goal=playable → ship preview only if deploy != none (never prod)
- [ ] 4. Final report: slice table with statuses, commits, URLs, blocked items; stop
```

## Step 0 — start

1. `pwd` must be the project root the director named (or an Orca child worktree). Dirty files
   other than the contract set → snapshot into `forbidden_changes` for every lane.
2. Read every input. Build the runnable order from `MILESTONES.dag` (topological; ties by
   `slices` order). Validate: every id has a file; `release_slice` is last; no `parallel_ok` pair
   shares a path. A validation failure is a **Fable** problem — report it and stop; do not patch.
3. Lock policy (above). Write `release.current_slice: ""` and every missing id into
   `release.slices` as `planned`.

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
node ~/.cursor/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "<PROJECT>" \
  --agent "<fleet.orchestrator_agent>" \
  --title "fleet-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/fleet-slice-prompt.md filled for <Sxx>…
EOF
)"
```

The fleet builds its PLAN from the slice front-matter (mapping in
[reference/slice-to-plan.md](reference/slice-to-plan.md); fleet Step 0.5 branch B — a cheap
`orchestrator_agent` is fine because no planning judgment is needed), creates its own
worktree, runs scan → art → implement → integrate → review, and ends at **"offer commit"**.
If the fleet `ask`s for a field the slice lacks, that is a Fable gap: answer only from the
contracts, otherwise mark the slice `blocked` and report — never let the fleet improvise it. Monitor with
`orca terminal wait <handle> --for tui-idle` in long slices; read the terminal tail and
`<worktree>/.cursor/evidence/tasks/T-*/evidence/review.md` for the verdict.

Answer the fleet's questions as the director would: preview requests → see *Preview* below;
scope questions → answer from the slice file / SCOPE.md; anything not answerable from contracts
→ relay to the human with one `ask`.

### S / M → single agent (`vibe-game-director`)

Spawn the locked `fleet.writer_agent` in the **main checkout** (main Creator is open there):

```bash
node ~/.cursor/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "<PROJECT>" --agent "<fleet.writer_agent>" --title "slice-<slug>-<Sxx>" \
  --prompt "$(cat <<'EOF'
…reference/single-slice-prompt.md filled for <Sxx>…
EOF
)"
```

Then spawn a **fresh** reviewer terminal (`fleet.reviewer_agent`) with the review section of the
same reference — a single lane still gets an independent review before you accept it.

### Preview (both lanes)

- cc4 (`bootstrap.engine: cocos-cli`): start it yourself when asked —
  `cocos preview --project <checkout> --platform web-mobile --port <pinned> --no-open` in the lane's
  checkout (read `cocos-cli-mcp.config.json` → `preview_port`, or `node scripts/resolve-ports.mjs --shell`;
  see `.cursor/skills/open-cocos-editor`), tell the lane the port.
- 3.8 / Funplay: coordinators may not Funplay-start preview. Relay the request to the human once
  (`ask`: "open Project → Preview in the Creator of <checkout>"). Unanswered → the lane records
  `manual_required`; a slice with `manual_required` runtime checks is **not** APPROVED for you:
  mark `blocked`, continue with independent slices, report at the end. Never mark a slice merged
  on unverified evidence.

## Step 2d — accept, commit, merge

APPROVED means: reviewer's `review.md` ends `APPROVED`, no `manual_required` in
`runtime-state.json`, evidence files present, feel/VFX acceptance rows reviewed.

1. `auto_commit=true` → reply to the lane terminal: *"approved — commit"*; the lane runs
   `/commit-guard` in its checkout. `false` → mark `approved`, `ask` the director, wait.
2. `auto_merge=true` (fleet lane) → run the `cocos-orca-worktree` finish sequence yourself:
   `scripts/close-editor.sh` in the worktree → `git -C <main> merge --no-ff <branch>` →
   `orca worktree rm --worktree path:<wt> --run-hooks --json`. Conflict → stop, `ask`.
   Single lane committed on main → nothing to merge.
3. `release.slices[<Sxx>] = merged`, `current_slice = ""`, notes entry:
   `- <date> <Sxx> <lane> <verdict> fix_rounds=<n> commit=<sha> merged=<y/n> <blockers>`.
4. Release the lane terminal (`orca terminal close`) unless the director wants it kept.

## Step 3 — ship (release slice merged, or playable + deploy != none)

Follow `.cursor/skills/ship/SKILL.md` from the main checkout. No `ship` skill in this project
(playable template) → treat `deploy` as `none`: run `build/build.sh` if present, otherwise report
the merged state and stop.

1. `build/build.sh --clean` — trust the script's verdict.
2. `deploy != none` → `build/deploy.sh` (preview). Smoke the deployed URL via the Orca browser
   (`.cursor/skills/smoke-test`): cold load, one full play → fail → restart, no console errors.
   Record `release.last_preview_url`.
3. `deploy == prod` **and** goal == `end_to_end` **and** smoke passed → `build/deploy.sh --prod`;
   record `release.last_prod_url`. Never prod for `playable`.
4. `git tag v1.0.0` (end_to_end) — do **not** push unless the director asked.
5. `release.slices[release_slice] = shipped`; final notes entry with URLs and RC rows status.

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
- Two fleets on the same paths, or `max_parallel=2` without `parallel_ok`.
- Marking `merged` when `runtime-state.json` says `manual_required`.
- `deploy.sh --prod` without a passed preview smoke, or for `goal: playable`.
- Re-asking locked policy; skipping the director gate for `needs_director_ok` slices.
- Pushing, or `worktree rm` while Creator is open.

## Resources

- [reference/producer-prompt.md](reference/producer-prompt.md) — how `new-cocos-game` /
  `store-game-clone` spawn this producer.
- [reference/fleet-slice-prompt.md](reference/fleet-slice-prompt.md) — orchestrator prompt per slice.
- [reference/single-slice-prompt.md](reference/single-slice-prompt.md) — S/M writer + reviewer prompts.
- [reference/slice-to-plan.md](reference/slice-to-plan.md) — slice front-matter → PLAN mapping.
- `../cocos-orca-fleet/SKILL.md`, `../cocos-orca-worktree/SKILL.md`, `../ship/SKILL.md`,
  `../smoke-test/SKILL.md`, `../commit-guard/SKILL.md`.
