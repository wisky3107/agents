---
name: workflow-pilot
description: >-
  Pilot a Cocos game project through its producer workflow to find workflow bugs: run one or
  more slices under the game-producer runner with a watch loop, catch and fix runner / fleet /
  memory failures as they happen, and record a pilot entry (tokens, questions, incidents,
  memory-trial findings). Use when the user says "pilot", "chạy pilot", "pilot dự án / slice",
  "test workflow", or "test orca memory" for a project.
---

# Workflow pilot

A **pilot** runs real slices through the real workflow to find where the workflow breaks.
The slice is the vehicle; the findings are the product. Every stop, wrong answer, silent
stall or false alarm is a **finding**: diagnose it, fix the workflow (not just the slice),
and record it.

Tools this skill drives: `game-producer` (runner mode), `cocos-orca-fleet`, `game-brief`
(slice authoring), `orca-memory` (`~/.orca-memory/bin/orca-memory`), `cocos-playbook`
(recipes, kits). Results go to
`~/.agents/docs/plans/2026-10-01-coordinator-token-optimization/results.md` as
`### Pilot N — …`.

## 0. Intake

Settle these before touching anything. Ask only what the request leaves open.

| Item | Values | Default |
|---|---|---|
| Project | path under `~/Works/games/CocosCreator/` | the one named |
| Slices | existing planned slice(s), or author a new one (step 2) | next planned |
| Authority | `ask` (director answers every question) · `auto-answer` (I answer runner questions inside the slice's decisions) · `delegated` (I also decide contract gates and slice decisions) | `auto-answer` |
| Purpose | general workflow · token cost · memory trial · a named fix | general |
| Push / deploy / tag | never without a separate explicit request | never |

Done when: the authority level and purpose are known. Record the authority in the user's
memory note for the project (quote the director's words) and on the AGENT_NOTES policy line
as `(director gate: Sxx GIVEN — …)` when the slice is run.

## 1. Preflight

Run every check; each one has caught a real stall.

1. `git status` in the project and in `~/.agents`: note dirty files that belong to other
   sessions — they are never staged, stashed or reverted (see
   [fix-loop.md](reference/fix-loop.md) for merging into dirty checkouts).
2. Runner: `producer-runner.mjs status --project <p>` (lock, control, step, open questions)
   and `start --dry-run`. A `director_gate` blocker means the policy line lacks
   `Sxx GIVEN`.
3. Template sync: the project's `.cursor/rules` and `cocos-editor` skill match the template
   (`update-skills`, or copy the reviewed files when the project files equal the template
   base). A slice that relies on a rule the project lacks will fail review.
4. Contracts: `node ~/.agents/skills/game-brief/scripts/validate-contracts.mjs --project <p>`
   and `validate-gameplay-coverage.mjs` print `"ok": true`.
5. Smoke baseline: the project's smoke suite is green on main (a pre-existing red check
   becomes a question in every later slice — fix it first, as its own small task).
6. Memory and playbook: answer the **moments** questions for "preflight" (below).
7. The project's main is pushed when the next slice depends on merges made since the last
   push: slice worktrees can be seeded from the remote (pilot 7 started S14 without S13).
   Pushing needs the user's go-ahead; otherwise tell the coordinator to fast-forward the
   worktree to local main.

Done when: dry-run says `would: …spawn…` with no blockers, validators are ok, and every
known red check is either fixed or written into the slice as a pre-existing failure.

## 2. Slice (author only when asked or when the next slice does not serve the purpose)

Author with the project's `docs/slice-schema.md` and a recent slice as the shape. For a
memory trial pick content that touches topics with many archived lessons
(`orca-memory records --project <id>` grouped by topic).

**Pre-check before fixing any decision** — every gate in pilot 6 came from skipping this:
- geometry: read the real layout code (`ResponsiveLayout`, rect tables) at V1 and compact;
  a position decision must leave ≥ 44 CSS px targets and text that renders ≥ its floor;
- existing checks: grep `scripts/smoke/checks` for hard-coded lists, samples and EXPECT
  tokens the slice will change (node order, schema samples, layout numbers); name each
  check the slice must edit, with the reason, and each one it must pass unmodified;
- data: save schema, readable versions, test samples; prefer optional fields over a bump.
- names: every node name the slice prescribes follows the project's scene-structure rule
  (`{Kind} - {label}`, rule 35) and matches sibling prefabs; mock coordinates equal the
  numbers in the slice and EXPECT (pilot 13: `Mascot`/`Block` drifted, review F1);
- template sync is not optional: diff the project's `run-smoke.mjs` against the template
  before launch (pilot 13 ran without `--channel auto`, FOLLOWUPS #39).
- visual fit: a slice that layers a sprite onto base art (wheels in arches, eyes in windows) or
  shows data-dependent looks (flat tyre per ticket) names a 2x crop of the part and a
  data-says-"no" case in its playtest (inspected, not extra screenshots), and measures the geometry from the art, never
  "tune on the preview" (pilot 12: wheels 8-26 px off the arches through 10 review rounds);
- fixtures: every `?mock_scenario=` / fixture id in the playtest exists in the mock's
  scenario list (pilots 13–14 wrote `new_account`; the fixture is `new_user_free`); keep
  text assets (Spine JSON/atlas) out of `change_budget.lines`.

Then: mock SVG in `docs/mockups/Sxx-*.svg` for a new screen, contract deltas (HOW_TO row,
EXPECT row naming the mock, MILESTONES slices + dag + table row, RELEASE_CHECKLIST rows,
FOLLOWUPS status), a `## Director decisions` table (`GIVEN` with date and the director's
words, or `open`), validators ok, one commit for the contract set.

Done when: validators are ok, every decision is `GIVEN` or explicitly open, and every
smoke-check edit the slice needs is pre-declared.

## 3. Launch

1. Policy line `(director gate: Sxx GIVEN — …)`; dry-run clean.
2. `producer-runner.mjs launch --project <p>`; wait for `spawned coordinator` in
   `T-Sxx/producer-log.md`.
3. Read the coordinator terminal once: a prompt is in it, no update menu or trust dialog
   (signature table).
4. Memory: the plan pack exists under `T-Sxx/evidence/memory/plan/` when the mode is
   shadow/assist; note item count and tokens.
5. Register the pilot on the runner: `producer-runner.mjs pilot --set --n <N> --project <p>`,
   plus `--auto` at `delegated` authority. From then on every way the director answers (runner
   terminal, macOS dialog, `answer` menu, director console) offers **resolve by pilot agent**;
   with `--auto` the runner itself hands every question the judge and autopilot leave to the
   pilot, and the director is not called (no bell, notification or dialog). See "Handed
   questions" below. A runner started before the registration picks up `--auto` only after a
   restart.
6. Append `### Pilot N — <slice> (lane), từ <UTC>` to results.md (purpose, config: runner
   pid + terminal, coordinator, agents, judge/autopilot, memory mode and pack); commit
   only that file.

Done when: the coordinator is working on the slice, the pilot is registered and the pilot
entry is committed.

## 4. Watch

At every authority level, arm the handoff watch with the Monitor tool (`timeout_ms` 1800000,
description `pilot <N> handed questions`):
`node ~/.agents/skills/game-producer/scripts/producer-runner.mjs pilot-wait --project <p>`.
It prints one JSON line per question the director handed to the pilot and exits after 29 min
with a `{"pilot_wait":"timeout"}` line: re-arm it at once on that line or the Monitor's expiry
notice; the cron tick re-arms it when that was missed (at `ask` authority, schedule the cron for
that alone). `pilot --clear` hands any still-handed question back to the director.

Below `ask` authority, schedule the watch with CronCreate (off-minute, about every 30 min)
from [watch-cron-prompt.md](reference/watch-cron-prompt.md), filled in for the slice and
authority. Between ticks, react to the user's messages. On every tick and on every question:
check facts first (HANDOFF in the worktree, the newest review file, git, the coordinator
screen), then answer. Match each symptom against
[failure-signatures.md](reference/failure-signatures.md) before treating it as new.

Answer rules that hold at every authority level: never choose stop / mark blocked / skip;
never accept or "treat as approved/offer_commit" a review whose newest file does not end
APPROVED; merge-step options only after their precondition holds; "check again" only when
evidence files changed; never update an agent CLI mid-run; nothing outward (push, deploy,
tag) without the user's request.

**Handed questions.** A question the director handed ("resolve by pilot agent") is theirs
delegated to you for that one question, whatever the authority level; with `--auto` every
question arrives this way (`"auto": true` in the pilot-wait line). Check the facts as for any
question, read the director's note (`pilot_handoff.text`), then answer with
`producer-runner.mjs answer --project <p> --id qN --choice "<exact option>" [--text "…"] --by pilot`.
The answer rules above still hold; when no option is safe, or the choice is the director's
alone (money, push/deploy, stop), give it back:
`producer-runner.mjs pilot --project <p> --return qN --note "<why + your recommendation>"` —
the runner then calls the director with your note. The director can still answer first; then
do nothing.

Done when: the slice is merged (`release.slices.Sxx: merged`) or the user stops the pilot.

## 5. Finding → workflow fix

When a symptom is a workflow bug (not a slice defect), fix it while the pilot runs, through
[fix-loop.md](reference/fix-loop.md): root cause from logs and a reproduction, a worktree,
a regression test that fails on the old code, both suites green, an independent review
(read-only, no stash), merge into the dirty checkout safely, then restart the runner only
if the fix lives in code it has already loaded (orca-wait is spawned per call; lanes.mjs is
not). Unblock the live slice with the smallest safe action and say what you did.

Done when: the fix is merged with a test, the live slice is moving again, and the finding
is written down for the results entry and the memory note.

## 6. Close

1. `python3 ~/.agents/tools/token-report/token_report.py --since <launch UTC> --project <slug>`
   (and `--json --sessions` for per-session rows).
2. `T-Sxx/evidence/stats.json`, `producer-log.md`, all runner questions for the slice.
3. Memory trial (assist/shadow): specs carry an absolute MEMORY path; grep
   `memory used` and record ids in `integration-notes.md`, `review*.md`, `final-report.md`;
   which pack items were cited; did a lesson visibly prevent a known failure.
4. Append `### Pilot N — kết quả` using [results-template.md](reference/results-template.md);
   commit only results.md; delete the cron and stop the `pilot-wait` monitor;
   `producer-runner.mjs pilot --clear --project <p>` (when no other slice of this pilot follows);
   update the memory notes; tell the user in a few
   lines what merged, the numbers, the findings and what is still open.

Done when: results are committed, the cron and monitor are gone, the pilot is cleared, and the
user has the summary.

Shipping what the pilot merged (build, deploy, prod smoke, tag) happens only on the user's
explicit request: [release.md](reference/release.md).

## Memory and playbook moments

Ask yourself these at each phase; act only when the answer is yes.

| Phase | Question | Action |
|---|---|---|
| Preflight | Is the project registered and which mode? | `orca-memory doctor`; `orca-memory mode` (switch only on request: `mode --project <id> <mode> --note`) |
| Preflight | Did slices merge since the last refresh (daily 09:03 local)? | For a memory trial or when fresh lessons matter: `orca-memory refresh`, then list the new records |
| Slice authoring | Has another game solved this feature? | `node ~/.agents/skills/cocos-playbook/kits/kit.mjs find <words>`; recipes via the playbook INDEX → `recipe_refs` with pinned sha256 |
| Slice authoring | Do archived lessons warn about this area? | `orca-memory records --project <id>` / `retrieve --query`; turn a relevant lesson into a risk line or an acceptance detail |
| Launch | Did the plan pack reach the specs? | pack files exist; specs use an absolute path; nothing in main gets overwritten by the worktree copy |
| Watch | Is a finding a reusable lesson? | it goes to the slice's `learning-candidates.json` via the writer, or to the memory note when it is about the workflow |
| Close | Did roles cite memory, and did it help? | record cited ids and verdicts in results; `orca-memory pilot deviation` for a hook that did not run |
| Close | Is a lesson now encoded in a rule, check or template? | `orca-memory promote <id> --to <where> --note` so packs stop serving it |
| Close | Did the slice produce a reusable technique or kit? | the runner's kit slice-check output; playbook curation is a separate task — note it, do not do it inline |
