---
name: game-brief
description: >-
  Author the full game-contract set (GAME_BRIEF, HOW_TO, EXPECT_GAMEPLAY_VISUAL,
  ASSET_MANIFEST, SCOPE, ARCHITECTURE, FOLLOWUPS, PLAYTEST, CONTEXT, ADR) plus the
  release plan (MILESTONES.md, numbered slice files, RELEASE_CHECKLIST.md) for an
  existing Cocos Creator project by spawning a configurable agent (default Fable 5.1) via
  Orca. Works from any source: an App Store reference pack (store-game-clone, optionally
  with a merged unity-apk-rip pack and mandatory rip-port-analysis forensic maps for rip-backed
  ports), a user-supplied media
  folder (screenshots / video / GDD / GLB), a gameplay video file or URL (measured with
  gameplay-video), or a text-only idea, with optional director
  gameplay notes and amendments to existing contracts.
  Sits between store-game-clone / new-cocos-game and game-producer. Use when the
  user says "game-brief", "game brief", "fable brief", "brief sâu", "contracts",
  "HOW_TO/EXPECT", or wants deep contracts for a game that was NOT cloned from a store.
---

# Game Brief

Turn a source (store pack, media folder, or plain idea) into the project contracts the
producer and fleet read — including **every slice up front**. Full depth prepares the whole
release; opt-in playable depth requires expansion before later slices can dispatch. S01 must
be a presentation-ready playable: complete core
loop plus polished in-game UX/UI, responsive layout, and close visual correspondence to the
expected mock screen derived from screenshots or the brief. The brief author **only writes docs**: no
gameplay code, no Creator, no commit, no push.

Prereq: the project already exists (bootstrapped by `new-cocos-game`) and its MCP gate
passed. This skill never creates or opens a project.

## Constants

| Key | Value |
|-----|-------|
| Brief agent | Fable 5.1: `claude --model claude-fable-5-1`; resolve overrides at intake |
| Launcher | `~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session` (handles trust, AGENTS.md boot, `tui-idle`) |
| Prompt | [reference/brief-prompt.md](reference/brief-prompt.md) |
| Slice schema | [reference/slice-schema.md](reference/slice-schema.md) — MILESTONES / slices / RELEASE_CHECKLIST format, cutting rules, release-polish content |
| Reference root in project | `<project>/reference/<slug>/` (`media` / `store`), absent for `idea` |
| Rip pack (optional add-on) | `<project>/reference/<slug>/rip/` — `unity-apk-rip` output merged by `store-game-clone` Step 1b (`RIP_PACK.json`, `README.md`, `images_ingame/` de-atlased sprites, `fonts/`, `meshes/`, `levels/`, `briefs/`, `*_GUIDE.md`, `*_catalog.json`); P0 GLBs already copied to `reference/<slug>/models/` |
| Port forensic maps | `<project>/reference/<slug>/rip-port/` — reviewed `RIP_PORT_MANIFEST.json` plus logic/state/level/asset/gap reports from `rip-port-analysis`; behavior source for a rip-backed port |
| Contract templates | `<project>/.cursor/skills/vibe-game-director/templates/*.md` |
| Depth exemplar | `/Users/wikz/Works/games/CocosCreator/cc-monopoly-go/` — passing store+rip+port+GP set: `MILESTONES.md`, `slices/S01-polished-playable.md`, `slices/S03-chance-chain.md` (later slice), `slices/S07-release-polish.md`, `EXPECT_GAMEPLAY_VISUAL.md`. Format only; never copy mechanics. (`/Users/wikz/orca-global/*-brief/` hold research seeds, not contracts.) |
| Handoff file | `<project>/AGENT_NOTES.md` — this skill owns yaml `brief:` + `## Notes — game-brief` |
| Launch prep | `scripts/prepare.mjs` — deps, docs copies, index, progress run, filled prompt (`docs/brief-author-prompt.md`), launch command |
| Optimization tools | `scripts/index-source.mjs`, `scripts/brief-progress.mjs`, `scripts/validate-contracts.mjs`, `scripts/validate-gameplay-coverage.mjs` |
| Video probe | `gameplay-video` skill — `~/.agents/skills/gameplay-video/scripts/video-probe.mjs` (fetch / signals / overview / strips / zoom / track) measures gameplay video timing; its `reference/probe-guide.md` is copied to `docs/video-evidence.md` for the brief author |

## Progress checklist

```
Game Brief:
- [ ] 0. Intake (project, slug, source mode, rip pack present?, gameplay notes?, video file/URL?, orientation/design res, agent override?)
- [ ] 1. Seed source (media → reference/<slug>/; idea → reference/<slug>-brief/IDEA.md; rip → already under reference/<slug>/rip/; video → fetch + probe into reference/<slug>/video/)
- [ ] 1b. Any rip pack/project → run or reuse reviewed rip-port-analysis before brief launch
- [ ] 2. Fill AGENT_NOTES.md brief: block (add block/section if skeleton is old)
- [ ] 2b. `node ~/.agents/skills/game-brief/scripts/prepare.mjs --project "$PROJECT"` → exit 0, keep `runId`, `promptPath`, `launch`
- [ ] 3. Validate the agent spec, run the `launch` command from 2b, record the terminal handle
- [ ] 4. Gate: run the deterministic contract and gameplay coverage validators, then inspect the remaining visual evidence (+ rip rows / GP coverage)
- [ ] 5. Update notes section; report file list + slice table; stop (no commit unless asked)
```

## Step 0 — Intake

Ask only what's missing:

1. **Project path** — `/Users/wikz/Works/games/CocosCreator/cc-<slug>` (or `cc4-<slug>`). Abort if missing or no `AGENT_NOTES.md` / `.cursor/skills/vibe-game-director/`.
2. **Source mode** (announce in one line, do not ask when obvious):
   - `store` — `reference/<slug>/manifest.json` exists (came from `store-game-clone`)
   - `media` — user points at a folder / files of screenshots, video, GDD, GLB that are not a store crawl
   - `idea` — text only (chat message, `GAME_BRIEF.md` seed, a `.md` the user wrote)
2b. **Rip pack** (add-on to `store` or `media`, announce, never ask) — present when
   `reference/<slug>/rip/RIP_PACK.json` exists **or** `AGENT_NOTES.md` `store_clone.rip_path` is
   non-empty. Read `RIP_PACK.json` for what was merged (dirs, excluded `images/`, P0 GLB count) and
   skim `rip/README.md`. If the user points at a raw `unity-apk-rip` `output/` folder that was
   never merged, run `node ~/.agents/skills/store-game-clone/scripts/merge-rip-pack.mjs --rip <dir>
   --slug <slug> --assets-root "$PROJECT/reference"` so it lands at `reference/<slug>/rip/` with the
   same layout (that script also fills `reference/<slug>/models/`). `idea` + rip is not a thing —
   a rip pack is media, so the mode becomes `media`.
   A raw recovered Unity/workdir input also selects port mode even without output/manifest.
   Resolve it with `~/.agents/skills/rip-port-analysis/SKILL.md`; skip the output merge when
   none exists. Use `source=media` when no store evidence exists.
2c. **Rip analysis gate** — any rip input requires `rip_port.enabled: true` and reviewed
   analysis at `rip_port.analysis_path` (default `reference/<slug>/rip-port/`). Read and run
   `~/.agents/skills/rip-port-analysis/SKILL.md` before source indexing/brief launch if missing
   or stale; this coordinator owns that nested phase, the brief author does not. Reuse only
   after its validator and source-list check pass. Output-only packs use the same phase with
   assets_only coverage. Direct game-brief invocation has the same gate as store-game-clone.
   Preserve source mode `store|media`; it is independent of port mode. The analysis skill owns
   `rip_port:` while this skill owns `brief:`. Read all reports and targeted critical evidence.
   When no Unity tree exists, analysis must use `logicCoverage: assets_only`; do not convert
   asset names, catalog priorities, or rip prose into recovered gameplay rules.
2d. **Gameplay notes** (optional, all source modes) — accept supplied chat text/files or
   detect `brief.gameplay_notes_path` / `reference/<slug>-brief/GAMEPLAY_NOTES.md`.
   Read [reference/gameplay-notes.md](reference/gameplay-notes.md) when present; it owns
   capture, evidence precedence, coverage, and late amendments. Absence requires no question.
   Existing contracts + new notes → use its late-notes flow before revising affected files.
2e. **Gameplay video** (optional, every mode; announce, never ask) — a video file in the media
   folder, the store trailer `reference/<slug>/video/preview.mp4`, or a video URL in the
   request (YouTube, TikTok, a direct .mp4). Any video gets probed in Step 1 with the
   `gameplay-video` skill; it is the only source of measured feel timing. A video is media: `idea` + video becomes `media`, with the idea text kept as
   IDEA.md (GIVEN). Record each URL for the Step 5 notes.
3. **Orientation / design res** — default from media aspect if any; else portrait `720×1280`. Landscape → `1280×720`.
4. **Engine line** — from `AGENT_NOTES.md` `bootstrap:`: `Creator <creator_version>` (3.8 templates) or `COCOS 4 CLI <engine_version>` (cc4).
5. **Brief agent** — resolve in this order: explicit user/caller launch spec → existing
   `AGENT_NOTES.md` `brief.brief_agent` → `claude --model claude-fable-5-1` (Fable 5.1).
   Accept any agent supported by `bootstrap.mjs agent-session`, for example
   `claude --model opus`, `codex --model <requested-model>`, or `cursor --model auto`.
   Model and effort options belong to the selected provider; do not carry Fable's model into
   another provider. For a provider-only request, use that provider's default model. Announce the
   resolved spec, validate it with `bootstrap.mjs agent-cmd --agent "$BRIEF_AGENT"` (no launch),
   and record the canonical spec actually honored by the launcher. Do not silently fall back to
   a different model if validation or launch fails; report the exact failure.
6. **Release goal** — read `AGENT_NOTES.md` `release.goal` (`end_to_end` default | `playable`).
   The brief author always writes **all** slice files. `brief.contract_depth` defaults to `full`;
   opt-in `playable` keeps S01 fully detailed and later slices as non-dispatchable outlines under
   [bounded-authoring.md](reference/bounded-authoring.md). It is valid only for goal=playable.
   In either depth, S01 is self-sufficient and visually presentable: its own fail/restart,
   production-quality in-game HUD and controls, responsive safe-area layout, and an explicit
   expected mock screen based on the strongest screenshot evidence or the director brief.
   `playable` must never mean gray boxes, debug UI, placeholder layout, or a minimal HUD.

Never invent mechanics. `store` / `media` → the brief author must OBSERVE files and label
director statements GIVEN. In every mode its own fills are ASSUMPTION. `idea` has no
inspected media, so nothing may be marked OBSERVED.

Rip pack evidence rules (when present): inspected files under `rip/images_ingame/`, `rip/meshes/`,
`rip/levels/`, readable source code and serialized data can support **OBSERVED** claims (cite
source ID, path, symbol/key). Catalog `how_to_use`, `rip/briefs/*.md` and `*_GUIDE.md` prose are
**research seeds** — the brief author may quote them
as `SEED (rip/briefs/GAMEPLAY_BRIEF.md §…)` but must re-derive v1 decisions itself; a rip brief
describing the shipped Unity meta (arena, store, live-ops) never widens v1 scope by itself;
explicit director requirements receive the scope decision defined in gameplay-notes.md.

## Bounded research and progress

Read [bounded-authoring.md](reference/bounded-authoring.md) before launch. It owns dependency
setup, source indexing, optional safe scaffolding, progress commands, recovery ownership and
the opt-in playable-depth contract. These tools live in this skill, not in the game project's
`scripts/` directory. Pass their absolute paths and the active run ID in the author prompt.
Use a shortlist first and targeted extra reads tied to unresolved decisions. Full director
source reading and S01 visual inspection remain required. An indexed asset is not visually
inspected evidence. Do not make a full-pack contact sheet by default.

## Step 1 — Seed the source into the project

```bash
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
```

- `store`: reuse `reference/<slug>/` seeded by `store-game-clone` Step 3.
- `media`:
  For rip input use the analysis skill's source/staging rules, not the generic rsync below;
  preserve the external Unity tree and stage only selected output packs/evidence.
  ```bash
  mkdir -p "$PROJECT/reference/<slug>"
  rsync -a --exclude '.DS_Store' <user media folder>/ "$PROJECT/reference/<slug>/"
  ```
- Video (every mode that has one, intake 2e): run steps 1–2 of the `gameplay-video` skill per
  video, with its `P`, `V=reference/<slug>/video` and `D=$V/probe/<name>` (a URL is fetched
  into `$V`), then `node $P strips $V/<name>.mp4 --out $D --top 20`. When `video/frames/` is empty, extract
  about 12 stills: `ffmpeg -i $V/<name>.mp4 -vf fps=12/<duration> -q:v 3 $V/frames/t%02d.jpg`.
  Read `overview.md`, one sheet and two or three strips so the intake notes say what the video
  shows (core loop, which moments carry the feel). Leave `track` to the brief author. Missing ffmpeg or yt-dlp: say so, keep the frames you
  have, and expect the `Video not probed` warning from prepare (feel timing becomes ASSUMPTION).
- `idea`: write the user's text **verbatim** to `$PROJECT/reference/<slug>-brief/IDEA.md`
  (heading `# IDEA — <slug>`, then the text). The brief author reads this file, not the chat.

When gameplay notes exist, capture/reuse them per [gameplay-notes.md](reference/gameplay-notes.md)
and copy that reference to `$PROJECT/docs/gameplay-notes-contract.md` for the brief author.
Verify the notes source and GP index are readable before launch. Keep IDEA.md as the base
idea; gameplay amendments belong in GAMEPLAY_NOTES.md without duplicating the whole idea.

Read at least the key images / frames yourself with the Read tool before Step 3 so you can
judge the brief author's OBSERVED claims at the gate; with a video also `overview.md` and one
overview sheet per video. With a rip pack also read `rip/README.md`,
`rip/briefs/GAME_BRIEF.md`, `rip/briefs/GAMEPLAY_BRIEF.md`, and the P0 tables of
`rip/IMAGES_INGAME_GUIDE.md` + `rip/MESHES_GUIDE.md`, and open 2–3 P0 PNGs (named de-atlased
sprites from Gameplay/HUD families — do not expect `sactx-*` pages under `rip/images_ingame/`;
also note `rip/fonts/` when text is in scope) so you know what "import" rows should look like.
Read the port reports and `~/.agents/skills/rip-port-analysis/references/port-contract.md`
when rip input exists; copy that contract to `docs/rip-port-contract.md` for the brief author.
Missing optional legacy rip briefs/guides are reported, not fabricated; analysis can use raw evidence.

## Step 2 — AGENT_NOTES.md

Edit only the `brief:` yaml block and `## Notes — game-brief`:

```yaml
brief:
  brief_agent: claude --model claude-fable-5-1      # launch spec actually used
  source: store | media | idea
  reference_path: reference/<slug>/      # "" for idea
  rip_path: reference/<slug>/rip/        # "" when no rip pack (intake 2b)
  rip_port_path: reference/<slug>/rip-port/ # from rip_port.analysis_path; "" when no rip input
  gameplay_notes_path: reference/<slug>-brief/GAMEPLAY_NOTES.md  # "" when none
  contract_depth: full                  # full (default) | playable (opt-in; later slices need expansion)
  orientation: landscape 1280x720        # or portrait 720x1280
  authored_at: ""                        # fill after Step 4 (ISO date)
```

Old skeleton without `brief:` → append the block at the end of the leading yaml and add an
empty `## Notes — game-brief` section after `## Notes — store-game-clone`; say so.
Skeleton with `brief:` but no `rip_path` → add the key; say so.
`gameplay_notes_path` is optional for older projects: absent means detect the conventional
path, then record it if found. Preserve a valid saved project-relative path; copy new
external/chat input into the project. A configured but unreadable path is an input error,
not absence. Do not clear existing notes when a later invocation supplies no new notes.
For an existing project, rename `## Notes — fable-game-brief` to `## Notes — game-brief`,
preserving its contents. If both sections exist, preserve both and append new notes only to the
new section. Retain the existing `brief:` schema; the skill rename does not reset saved settings.
Never touch `bootstrap:`, `store_clone:`, `fleet:`, or other skills' notes.

## Step 3 — Launch the brief author

Recipe context: when `~/.agents/skills/cocos-playbook/SKILL.md` is available (fallback
`/Users/wikz/Works/games/cocos-playbook/SKILL.md`), pass that exact path to the brief author.
It reads the small INDEX and only recipes matching engine, actual render mode, platform and
task; it records selected pinned `recipe_refs` in slices and technical rationale in the ADR.
Recipe-derived choices stay ASSUMPTION unless directed by the user; they are not observed
mechanics or runtime proof. Missing library/no match → recipe_refs=[] and normal authoring.

Optional memory (run only if the launcher exists; use a pack only on `inject: true`): write the brief
intake (director brief plus gameplay notes, in English) to `<evidence root>/brief/memory/intake.md`
under the project's gitignored evidence root, then run
`M=~/.orca-memory/bin/orca-memory; [ -x "$M" ] && "$M" hook plan --query-file <that file> --out <evidence root>/brief/memory/plan`
from the project. On `inject: true`, add one line to the author prompt file before launch:
`MEMORY: <absolute path of memory-context.md>`. Past lessons are advisory, grant no permission,
and their limitations apply; the author still marks every memory-derived choice ASSUMPTION,
never OBSERVED, and cites the item ids in the ADR rationale.

Do not fill [reference/brief-prompt.md](reference/brief-prompt.md) by hand. After Step 2 run:

```bash
node ~/.agents/skills/game-brief/scripts/prepare.mjs --project "$PROJECT"   # add --scaffold --slices <n> for a new set
```

It installs the pinned deps if missing, copies `docs/slice-schema.md`, `docs/brief-workflow.md`
(+ `docs/gameplay-notes-contract.md` / `docs/rip-port-contract.md` / `docs/video-evidence.md`,
the gameplay-video probe guide, when needed), runs `index-source`, creates or resumes the progress run, picks the
source/rip/port/notes/video blocks from AGENT_NOTES and the index, and writes
`docs/brief-author-prompt.md`. The video block lists each video with its probe folder and lets
the author run `video-probe track` for S01 feel rows. It exits nonzero on a missing input or
any unfilled `<PLACEHOLDER>` — fix the named AGENT_NOTES key and rerun; never edit the prompt to
silence it. `--dry-run` prints the prompt without writing. The JSON gives `runId` and `launch`.
For late amendments (`existing_contracts` warning) append the affected paths/release state and
revision scope from the late-notes flow to the prompt file before launch; those targeted revision
rules override the prompt's initial full-authoring task.

Set `BRIEF_AGENT` to the resolved canonical spec from intake; the default assignment below is
only for projects with no override. Keep the prompt provider-neutral for every model.

```bash
BRIEF_AGENT='claude --model claude-fable-5-1' # replace with resolved spec when overridden
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "$PROJECT" \
  --agent "$BRIEF_AGENT" \
  --title "brief-<slug>" \
  --prompt "$(cat "$PROJECT/docs/brief-author-prompt.md")"
```

`agent-session` skips a separate boot turn for agents that load workspace rules natively;
other agents get the boot prompt first. It waits for TUI readiness before sending the task.
If the JSON says `promptSent: false`, re-send with `orca terminal send --terminal <handle> --enter` (without
`--enter` the text stays in draft). Record the terminal handle.

## Step 4 — Gate

Monitor progress per bounded-authoring.md with short waits (≤60 seconds), not terminal-text
polling or a single 15-minute wait. The progress tool only accepts contracts_written after both
validators pass, but files can change afterward, so when contracts_written appears, rerun:

```bash
node ~/.agents/skills/game-brief/scripts/validate-contracts.mjs --project "$PROJECT"
node ~/.agents/skills/game-brief/scripts/validate-gameplay-coverage.mjs --project "$PROJECT"
```

Both return JSON and nonzero exit on errors. Give exact failures to the current author.
Mechanical PASS does not replace the semantic/visual checks below. The coordinator records
their result and uses the progress tool to mark done only against the reviewed contract hash.
For a quick missing-file diagnostic:

```bash
cd "$PROJECT" && for f in GAME_BRIEF.md HOW_TO.md EXPECT_GAMEPLAY_VISUAL.md ASSET_MANIFEST.md \
  SCOPE.md ARCHITECTURE.md FOLLOWUPS.md PLAYTEST.md CONTEXT.md docs/adr/0001-tech-stack.md \
  MILESTONES.md RELEASE_CHECKLIST.md; do
  [ -s "$f" ] && echo "ok   $f" || echo "MISS $f"; done
ls slices/                                                # ≥ 1 file per id in MILESTONES.md
grep -c 'OBSERVED' EXPECT_GAMEPLAY_VISUAL.md HOW_TO.md slices/*.md   # idea mode: must be 0
```

Also confirm:

- `EXPECT_GAMEPLAY_VISUAL.md` has the **Game feel / VFX table**; `ASSET_MANIFEST.md` lists VFX assets as P0.
- With a video: feel rows for moving objects cite a `video/probe/<name>/track-*/track.md` as
  OBSERVED, or say why not (ASSUMPTION). Open one cited `track.md` and its `track.jpg`: the
  numbers match the row and the followed object is the one the row names. Squash/scale/tilt
  under ~8 % is not OBSERVED.
- `EXPECT_GAMEPLAY_VISUAL.md` satisfies [S01 visual target and review contract](reference/slice-schema.md#s01-visual-target-and-review-contract):
  an exact screenshot/frame with crop/dimensions and region annotations, or a visually inspected
  `docs/mockups/S01-ingame.svg` when no suitable image exists. Open the target yourself; text alone
  is insufficient. A static documentation mock is permitted by the docs-only scope.
- S01 includes concrete layout metrics, exact viewport sizes and safe-area insets, capture paths,
  measurable tolerances, and PASS/FAIL rules in its acceptance/playtest. It owns all required P0 UI
  art/fonts and the initial in-game layout/input/feel/visual checklist rows. Later slices cover new
  screens and regression checks. This gate checks the authored contract, not runtime completion.
- `MILESTONES.md` yaml has `slices`, `dag`, `v1_slice`, `release_slice`; every id has a
  `slices/S<nn>-*.md` whose front-matter carries `size`, `paths`, `acceptance`, `runtime_checks`,
  `change_budget` (the producer copies these straight into the PLAN). Budgets follow
  [slice-schema.md § Calibrating `change_budget`](reference/slice-schema.md) (estimate ×1.5,
  code-only counting); `SCOPE.md` carries `budget_count: code_only` and `budget_mode: advisory`
  (budgets are planning estimates; only `tripo_credits` is a hard cap).
- Last slice is `release-polish`; the union of all `release_items` covers every `RC-nn` row.
- `parallel_ok` pairs have disjoint `paths`.
- Optional `recipe_refs` carry id/revision/SHA-256/path; selected checks are in-scope, engine
  compatibility is explicit, and candidate status has not been upgraded by contract authoring.
- When gameplay notes exist, run the coverage gate in
  [reference/gameplay-notes.md](reference/gameplay-notes.md): all source statements indexed,
  every GP ID accounted for, included behaviors mapped into actual rules and slice scenarios,
  and unresolved decisions represented by affected slice risks/gates. Report outstanding
  decisions before handoff; an authored coverage table is not proof of implemented behavior.

Extra rows when a rip pack is present (`brief.rip_path` non-empty):

For every port, the contract validator also requires fresh reviewed analysis. The semantic
gate applies `docs/rip-port-contract.md`: HOW_TO port coverage, ARCHITECTURE mappings,
slice RP scenarios and explicit Port evidence/hash pointers. Check that code/data-backed
rules survive the handoff; material unknowns are risks, never silently promoted to OBSERVED.
Slices that mirror shipped presentation carry `rip_study` topics with concrete questions
(the validator checks shape and that `source_dirs` exist); the studies themselves run later,
per slice, from the producer.

```bash
cd "$PROJECT" && grep -c 'reference/<slug>/rip/' ASSET_MANIFEST.md HOW_TO.md EXPECT_GAMEPLAY_VISUAL.md   # ASSET_MANIFEST must be > 0
grep -cE '\| *import *\|' ASSET_MANIFEST.md                                                        # ≥ 1 import row
grep -c 'SEED (' GAME_BRIEF.md HOW_TO.md                                                           # allowed, but no SEED row may be the only evidence for a v1 mechanic
```

- `ASSET_MANIFEST.md` has a **Source** column with `import` / `generate` per row; every `import`
  row names an existing file under `reference/<slug>/rip/images_ingame/`, `reference/<slug>/models/`
  or `reference/<slug>/rip/meshes/` (spot-check 3 paths with `ls`). Sprites are already de-atlased —
  cite the PNG filename, not a packed `sactx-*` page. Nothing from a P3 catalog entry appears as P0.
- When v1 loads levels: `HOW_TO.md` has a level-schema section citing `reference/<slug>/rip/levels/<file>.json`
  keys actually used (OBSERVED) and names the sample level(s) v1 ships.
- `SCOPE.md` / `CONTEXT.md` `_Avoid_` list rip-brief meta systems as out of v1 unless explicitly
  included by the director; verify any requested scope change is reflected across contracts.

| Result | Action |
|--------|--------|
| A contract missing | Nudge the brief author once with the missing file names |
| S01 target missing/unreadable, review criteria incomplete, or S01 UI checks deferred to later slices | Nudge the brief author with the exact gaps and the S01 visual contract; recheck before marking the brief complete |
| Rip present but `ASSET_MANIFEST.md` has no `import` rows / no `rip/` paths | Nudge the brief author with `reference/<slug>/rip/IMAGES_INGAME_GUIDE.md` + `MESHES_GUIDE.md` P0 tables; do not add rows yourself |
| An `import` path does not exist | Nudge with the exact row; the brief author must fix or flip it to `generate` |
| No evidence/contract change for 8 minutes after an acknowledged nudge | Check the tool/job or provider state; transfer recovery only after confirming the previous writer and background jobs stopped. Reuse its index and drafts; apply the same gates. A STOP message alone is not cessation proof. |
| `CONTEXT.md` / ADR missing | Nudge the current author; after verified ownership transfer, recovery may write minimal versions (domain terms + `_Avoid_`; engine, TS strict, web-mobile, design res, physics only if needed). |
| `OBSERVED` in idea mode | Tell the brief author to relabel to `GIVEN` / `ASSUMPTION` |
| Video present but S01 feel timing is guessed, or a cited `track.md` does not match its row | Nudge the brief author with the row ids, the prompt's video block and docs/video-evidence.md § Reading the outputs |
| Gameplay notes missing coverage, mislabelled as OBSERVED, or contradicted by slice acceptance | Nudge the brief author with the GP IDs and conflicting rows; recheck before handoff |
| Slice missing a PLAN field / RC rows uncovered / parallel pair overlaps | Nudge the brief author with the exact ids; do not patch slices yourself (they are the brief author's contract) |

## Step 5 — Notes + report

- `brief.authored_at` → today.
- `## Notes — game-brief` → 3–5 bullets: source mode, what was OBSERVED vs ASSUMED (or
  GIVEN vs ASSUMED), media that could not be read, files written here instead of by the brief author; with a
  rip pack: how many `import` vs `generate` rows, and which rip-brief systems were kept out of v1.
  With port analysis include actual analyst, coverage, manifest hash and unresolved core rules.
  With a video: the videos probed (with source URLs), the track runs and which feel rows they
  measured, and any video left unprobed.
- With gameplay notes, include their path and coverage counts by decision; for amendments,
  report changed GP IDs/files/slices and required fresh review scenarios for the current owner.
- Report the file list, the brief author's v1 summary, the slice table from `MILESTONES.md`
  (id · size · one-liner · `needs_director_ok`), and the terminal handle. Slices flagged
  `needs_director_ok: true` are the director's review list before `game-producer` starts.
  Do **not** commit unless asked; the caller (`store-game-clone` / `new-cocos-game`) decides
  what happens next (`/setup-project` Phase 1–3 skips Phase 0 because the root contracts now
  exist; then `game-producer` per `release.goal`).

## Out of scope

- Crawling stores (`store-game-clone`), bootstrapping projects (`new-cocos-game`)
- Implementing any slice, running `game-producer` or `cocos-orca-fleet`
- Editing slice files after the brief author wrote them (re-run the brief author with a nudge instead)
- Commit / push
