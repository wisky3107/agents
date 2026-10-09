# Game brief author prompt

Rendered by `scripts/prepare.mjs` into `<project>/docs/brief-author-prompt.md`; do not fill by hand.
The placeholder rules below document what that script does.
Send via `bootstrap.mjs agent-session --agent "$BRIEF_AGENT"` using the resolved agent/model.
This prompt applies equally to all supported providers; default is Fable 5.1.

Replace `<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<RIP_BLOCK>`, `<RIP_PORT_BLOCK>`, `<GAMEPLAY_NOTES_BLOCK>`, `<VIDEO_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`,
`<ENGINE_LINE>`, `<RELEASE_GOAL>` (`end_to_end` | `playable`, from `AGENT_NOTES.md` `release.goal`),
`<BRIEF_TOOLS>` (absolute skill scripts directory), `<BRIEF_RUN_ID>`, `<CONTRACT_DEPTH>` and `<PROGRESS>`
(the full `node <BRIEF_TOOLS>/brief-progress.mjs --project <PROJECT> --run-id <BRIEF_RUN_ID>` command).
Pick exactly one `<SOURCE_BLOCK>` variant below and paste it in place. Paste the `<RIP_BLOCK>`
variant only when `reference/<SLUG>/rip/RIP_PACK.json` exists; otherwise delete that line.
Include RIP_PORT_BLOCK whenever rip input exists, with actual RIP_PORT_PATH and validated
RIP_PORT_HASH; its presence does not require RIP_PACK.json. Remove it for non-port tasks.
Insert `<GAMEPLAY_NOTES_BLOCK>` only when notes exist, replacing `<GAMEPLAY_NOTES_PATH>`
with the saved project-relative path; otherwise delete the placeholder line.
Insert `<VIDEO_BLOCK>` only when the index lists videos (`<VIDEO_LIST>` one line per video, `<VIDEO_PROBE>` the
video-probe command); otherwise delete the placeholder line.
`docs/slice-schema.md` must already be copied into the project (skill Step 3).

```text
Task: author the project contracts for the game in <PROJECT>.
You are the brief author in <PROJECT>.

## Sources (shortlist first; full director source)
<SOURCE_BLOCK>
<RIP_BLOCK>
<RIP_PORT_BLOCK>
<GAMEPLAY_NOTES_BLOCK>
<VIDEO_BLOCK>
- Read `docs/brief-input-index.json` first. Open every file in its shortlist and read the director source (IDEA / GDD / GAMEPLAY_NOTES) in full. Look up `docs/brief-asset-candidates.json` only when a specific ASSET_MANIFEST row needs a file. Open anything beyond the shortlist only to answer a named question (e.g. "what does the fail screen look like?") and log it: `<PROGRESS> --read <path> --reason "<question>"`. Do not open every file in a folder or build a contact sheet. A filename, count or catalog entry is not OBSERVED — only a file you opened is.
- Contract templates: .cursor/skills/vibe-game-director/templates/{GAME_BRIEF,SCOPE,ARCHITECTURE,FOLLOWUPS,PLAYTEST}.md
- Slice / milestone / release-checklist format: docs/slice-schema.md (follow it exactly — the producer parses the yaml front-matter)
- PLAN format the slices must map onto: .cursor/skills/vibe-game-director/reference/plan-schema.md
- Optional recipes: read ~/.agents/skills/cocos-playbook/SKILL.md when available (fallback
  /Users/wikz/Works/games/cocos-playbook/SKILL.md), its INDEX, then only matching recipes.
  Resolve engine/render mode/platform from this project. Pin id/revision/sha256/path into
  recipe_refs in relevant slices; add in-scope checks and ADR rationale. Missing/no match = [].
  A candidate is guidance to validate, not observed product behavior; preserve GIVEN/ASSUMPTION.
- Worked example of a passing contract set (store + rip + port + gameplay notes): /Users/wikz/Works/games/CocosCreator/cc-monopoly-go/ — MILESTONES.md, slices/S01-polished-playable.md (v1), slices/S03-chance-chain.md (later M slice), slices/S07-release-polish.md, EXPECT_GAMEPLAY_VISUAL.md (visual target + feel table). Read these for format and level of detail when unsure; never copy its mechanics, numbers or assets. Skip if the path is missing.
- Contract depth: <CONTRACT_DEPTH>. Follow docs/brief-workflow.md. With playable depth, S01 remains complete; later slices are outlines that cannot dispatch until expanded. Preserve full GP coverage and release ownership in either mode.
- Engine: <ENGINE_LINE>; TypeScript strict; web-mobile target
- Release goal: <RELEASE_GOAL> (end_to_end = every slice then ship; playable = producer stops after v1_slice). In both modes S01 must be a polished, presentation-ready playable: complete core loop, own fail/restart, production-quality in-game UX/UI, responsive layout, and close correspondence to the expected mock screen. Never define S01 as gray boxes, debug UI, placeholder layout, or a minimal HUD.

## Deliverables (repo root unless noted)
A. GAME_BRIEF.md — first playable slice only. Orient <ORIENTATION>, design res <DESIGN_RES>. Explicit NOT-in-v1 list (modes / meta / IAP / anything outside the slice).
B. HOW_TO.md — evidence→decision table. File layout, units, HUD numbers for <DESIGN_RES>. Every row carries an evidence label (see Labels).
C. EXPECT_GAMEPLAY_VISUAL.md — reviewer tick-list of what must be SEEN/FELT, each item citing its evidence. Accepted-deviation table.
   MUST include an **S01 expected mock screen** following `docs/slice-schema.md` §S01 visual target
   and review contract. Link an exact existing screenshot/frame with crop, dimensions, and region
   annotations, or author and visually inspect `docs/mockups/S01-ingame.svg` when no suitable image
   exists. This static documentation mock is within the docs-only scope. Brief-derived choices are
   GIVEN/ASSUMPTION. Include layout metrics, responsive rules, exact CSS viewport sizes and safe-area
   insets, measurable tolerances, and accepted deviations. Text alone is insufficient.
   MUST include a **Game feel / VFX table** whose first column is `ID / interaction` and whose cells start with the ID slices cite in `feel_rows` — one row per interaction (tap, move, merge/match,
   score gain, combo, fail/death, level transition, idle): VFX (particles, flash, trail, glow),
   tween easing + duration, screen shake / hit-stop yes-no, evidence label. These rows are v1
   acceptance criteria, not polish-later notes.
D. ASSET_MANIFEST.md — P0 raw art for the art worker (antigravity by default). Prefer importing existing reference/<SLUG>/models/*.glb when present; list regen script path if present.
   MUST list the **VFX assets** the feel table needs (particle textures, effect sprite sheets,
   glow/flare sprites) as P0 alongside gameplay sprites — an effect absent here is never produced.
   When a rip pack exists (see Rip pack block): every row carries a **Source** column = `import` (exact
   path under reference/<SLUG>/rip/images_ingame/, reference/<SLUG>/models/ or reference/<SLUG>/rip/meshes/
   — sprites are already de-atlased; cite the PNG name, never a packed `sactx-*` page) or `generate`
   (prompt for the art worker). Fonts: reference/<SLUG>/rip/fonts/ when present. Default
   to `import` whenever the catalog has a P0/P1 file for the need; never import a P3 / meta / uGUI entry.
E. SCOPE.md, ARCHITECTURE.md, FOLLOWUPS.md, PLAYTEST.md from the templates (TS strict, event bus, web-mobile, core/systems/entities/ui). SCOPE.md carries `budget_count: code_only` and `budget_mode: advisory` (budgets are estimates recorded as `budget_bump`, never a review gate; only `tripo_credits` is a hard cap); size every slice `change_budget` with docs/slice-schema.md § Calibrating `change_budget` (sum per-file estimates, ×1.5, round up to 50, or the measured ratio).
F. CONTEXT.md — game-specific domain terms only (Coin, Level, Core loop, system names), 1–2 sentence definitions, an `_Avoid_` list naming out-of-v1 modes.
G. docs/adr/0001-tech-stack.md — <ENGINE_LINE>, TS strict, web-mobile, <DESIGN_RES>, physics only if the core loop needs it, localStorage behind SaveSystem.
H. MILESTONES.md — every slice of the release, cut per docs/slice-schema.md: yaml block (slices, dag, parallel_ok, v1_slice, release_slice, stop_when) + table. 6–9 vertical slices; S01 == the v1 slice of GAME_BRIEF.md; last slice == release-polish.
I. slices/S<nn>-<name>.md — one file per slice with the full yaml front-matter (id, name, one_liner, size, depends_on, unlocks, needs_director_ok, player_outcome, release_items, scope in/out, paths code/art/scene_objects, assets 2d/3d/vfx/audio, acceptance with evidence labels, feel_rows, runtime_checks, playtest, change_budget, risks). Fields map 1:1 onto plan-schema.md; paths of parallel_ok pairs must be disjoint.
   S01 must own the complete in-game UX/UI visible during the playable loop and every P0 art/font
   dependency needed to match the expected mock screen. Its acceptance and playtest must include
   visual comparison at <DESIGN_RES> plus at least two materially different viewport shapes,
   safe-area/notch checks, legibility, touch-target sizing, and absence of placeholder/debug UI.
   Specify capture paths and PASS/FAIL criteria per viewport using the visual review contract.
   Runtime captures are produced later by the implementation reviewer; do not claim them as done.
   Later HUD/juice slices may extend or refine S01, but must not be required to make S01 presentable.
   Every slice has a non-empty `player_outcome`; `unlocks` names only slices that depend on it in the dag.
   Every later slice that adds a screen (menu, settings, result, shop, onboarding overlay) gets its own
   visual target — an existing reference image or `docs/mockups/S<nn>-<screen>.svg` you open and inspect —
   linked in the slice or an EXPECT line naming its id, with layout metrics and PASS/FAIL checks.
   Popups (result, pause, settings, shop, reward, toast — opens and closes over the screen): when
   docs/flows/00-project-overview.md offers the `ui-popup` kit, follow docs/slice-schema.md § Cutting rules (popups) —
   prefab/ui/Popup<Name> + modules/popup/**, the first popup slice installs the kit, ARCHITECTURE.md
   fills its "Overlay UI (popups)" table. HUD stays on the Canvas.
J. RELEASE_CHECKLIST.md — product-level "done" rows RC-nn per docs/slice-schema.md (lifecycle, layout, input, ux, feel, audio, perf, quality, branding, assets, ship), each with closed_by = a slice id. Union of all slices' release_items must cover every row. Build size has no numeric cap: never write a MiB/MB threshold in any contract, and never put a size invariant/acceptance/build check in a slice other than release-polish, which measures and optimizes the final build once.
   Assign initial in-game layout, input, fail/restart, feel, asset completeness, and visual fidelity
   checks to S01; later slices add coverage for new screens, and release-polish reruns all checks.

## Labels (mandatory on every HOW_TO / EXPECT row)
- OBSERVED (<file>) — seen in a reference file; cite the exact path (reference/<SLUG>/iphone/03.jpg, reference/<SLUG>/video/frames/t12.jpg, reference/<SLUG>/video/probe/<name>/track-<feel-id>/track.md, reference/<SLUG>/rip/levels/t160-level-1.json, reference/<SLUG>/rip/images_ingame/<file>.png, …)
- GIVEN (IDEA §n) or GIVEN (GAMEPLAY_NOTES GP-nn) — stated by the director; reported play is testimony, not agent-observed evidence. Preserve uncertainty in tentative statements.
- SEED (reference/<SLUG>/rip/briefs/<file>.md §n) — only when a rip pack exists: a claim taken from the rip briefs / guides; never the sole evidence for a v1 mechanic — corroborate with OBSERVED or a definite GIVEN statement, otherwise downgrade to ASSUMPTION
- ASSUMPTION — your fill; keep these few and call them out in the summary

## Rules
- Do not invent mechanics. Every rule row in HOW_TO needs a label. If no opened file and no director sentence supports it, label it ASSUMPTION and add a matching `risks` entry to the owning slice.
- Do not implement gameplay, do not open Creator, do not commit, do not push.
- Slice files are contracts: no status fields, no TODOs; anything undecided goes to `risks` and flips `needs_director_ok: true`.
- Progress commands only record work; running one without writing a file is not progress.
- Geometry pass: every coordinate, rect or node path a slice (or mock) prescribes is checked against the real scene, prefabs and layout config: sibling order (what draws over what), existing rects and hitbox floors, row pitch, clamps vs aim tolerance. No node path from memory; no mock overlay on a cell it hides.
- Old checks: a slice that changes the core loop (new phase, new step before win) lists in `paths.code` every existing smoke check, solver and unit test it breaks or that must still pass, with the reason, even outside its own area.
- No deploy, `vercel`, `deploy.sh`, git tag or push in any slice (scope, acceptance, runtime_checks, playtest). Release slices write "ship handed to producer Step 3"; `validate-contracts` rejects `slice_performs_ship`.
- Context budget: read code with line ranges, write one file per tool call; a huge context times the author out.

## Work order (do the steps in order; each command must print "ok": true)
1. Evidence: open the shortlist and director source. After opening each image/frame/level file run `<PROGRESS> --evidence <path>`. Then `<PROGRESS> --phase evidence_ready`.
2. Write GAME_BRIEF.md, then `<PROGRESS> --phase game_brief_written --file GAME_BRIEF.md`.
3. Write HOW_TO.md, EXPECT_GAMEPLAY_VISUAL.md (+ any docs/mockups/*.svg, opened after writing), ASSET_MANIFEST.md. Run `<PROGRESS> --file <path>` once per file.
4. Write SCOPE.md, ARCHITECTURE.md, FOLLOWUPS.md, PLAYTEST.md, CONTEXT.md, docs/adr/0001-tech-stack.md. `<PROGRESS> --file <path>` per file.
5. Write RELEASE_CHECKLIST.md, MILESTONES.md, then every slices/S<nn>-<name>.md. `<PROGRESS> --file <path>` per file.
6. Self-check: run `node <BRIEF_TOOLS>/validate-contracts.mjs --project <PROJECT>` and `node <BRIEF_TOOLS>/validate-gameplay-coverage.mjs --project <PROJECT>`. Exit 1 → fix each listed `code`/`file` and rerun until both print "ok": true. Exit 2 → a tool/input error; report it and stop, do not work around it.
7. `<PROGRESS> --phase contracts_written` (it reruns both validators and refuses while errors remain). Then print: file list, 5-bullet v1 slice summary, slice table (id · size · one-liner · needs_director_ok), ASSUMPTION row count (+ import/generate row counts when a rip pack exists; GP coverage counts and unresolved conflicts when gameplay notes exist). Stop. The coordinator owns semantic review and `done`.
```

## `<GAMEPLAY_NOTES_BLOCK>` (optional, every source mode)

```text
- Director gameplay notes: <GAMEPLAY_NOTES_PATH> — read Source text and Requirement index in full; this is director input, not a research seed to rewrite.
- Notes contract: docs/gameplay-notes-contract.md — follow Evidence and decisions + Coverage; validate stable GP IDs against the source. Cite GIVEN (GAMEPLAY_NOTES GP-nn).
- Add Gameplay notes coverage to HOW_TO.md and carry included rules/scenarios into the owning slices so writer and reviewer use the same requirements. Explicit requested changes override inferred store/rip behavior; record intended deviations. Report unresolved material conflicts without silently selecting a rule.
- For amendments to existing contracts, also follow Notes arriving after contracts exist in the notes contract and the caller's affected-path/release-state handoff. Revise the affected set, preserving existing slice IDs and completed contracts; the initial full-release authoring/count rules do not require regenerating the release.
```

## `<VIDEO_BLOCK>` (only when the index lists videos; every source mode)

```text
- Gameplay video, probed by the coordinator with video-probe from the gameplay-video skill (timing measured from decoded frames and audio, not guessed); method and limits in docs/video-evidence.md:
<VIDEO_LIST>
  - Start with <probe>/overview/overview.md and open one overview sheet to learn what happens when. candidates.md is an event log (cuts, flashes, motion bursts, audio onsets), not a list of feel moments; strips/cNNN.jpg replays one candidate in slow motion. Run `<PROGRESS> --evidence <path>` for each sheet, strip, track.md, track.jpg, shape.md and shape.jpg you open.
  - Measure S01 feel rows for moving objects (hop, slide, drop, exit, knock-back) instead of guessing: `<VIDEO_PROBE> track <video> --at <sec> --box x0,y0,x1,y1 --crop auto --out <probe>/track-<feel-id>` (box = screen fractions of the cropped frame at --at; add `--mode move` for slides and exits, `--cell <px>` for cells/s, `--react x0,y0,x1,y1` for what gets hit). At most 4 runs. Read track.md, open track.jpg once to confirm the right object was followed; on a WARNING rerun with a later --at or a tighter box, once.
  - Squash and stretch, an object's full size or its exact exit timing: `<VIDEO_PROBE> shape <probe>/track-<feel-id>` segments that track's object with SAM 2 and writes shape.md and shape.jpg (2–3 min per run, at most 2 runs; `--pos x,y --neg x,y` for an object drawn in layers). Open shape.jpg once: the magenta mask must cover the whole object; on a WARNING in shape.md, reprompt once with points. If shape says the SAM env is missing, do not run sam-setup (an 800 MB download the user approves); keep those numbers ASSUMPTION.
  - Labels: a duration, distance, speed or easing from track.md is OBSERVED (<probe>/track-<feel-id>/track.md); a candidate time is OBSERVED only after you opened its strip or frame. Squash and stretch are OBSERVED only from a shape.md, above the floor it states; without one they are ASSUMPTION (track cannot see them under ~8 %), and so is tilt. On an object that stretches, track.md's arc is an upper bound: use shape.md's arc of the feet when it ran. The Cocos sketches in track.md and shape.md are hints, not contracts.
```

## `<RIP_BLOCK>` (paste only when `reference/<SLUG>/rip/RIP_PACK.json` exists; else delete the line)

```text
- Rip pack (unity-apk-rip output of the shipped game, merged by store-game-clone): reference/<SLUG>/rip/
  - Start with rip/RIP_PACK.json (what was merged; `images/` full dump is usually excluded) and rip/README.md (folder guide).
  - Exact in-game art: rip/images_ingame/ + rip/IMAGES_INGAME_GUIDE.md + rip/images_ingame_catalog.json (`priority`, `category`, `maps_to`, `how_to_use` per file). Sprites are de-atlased (one PNG per Unity Sprite); `maps_to` is the SpriteAtlas family. Prefer `*_New` over `*_Old`. Fonts: rip/fonts/ (.ttf/.otf) when present — SDF atlas PNGs are not in images/.
  - Mesh topology: reference/<SLUG>/models/*.glb (catalog P0 already copied there) + rip/MESHES_GUIDE.md + rip/meshes_catalog.json. Most GLBs are uGUI prefab dumps (P3) — never list *PopUp*/Toolbar*/*Leaderboard* as art. If the guide says the game is 2.5D/sprite-based, plan sprites and use meshes only for shape data.
  - Level data: rip/levels/*.json (+ schema keys in rip/README.md and rip/briefs/GAMEPLAY_BRIEF.md). If v1 loads levels, HOW_TO.md gets a level-schema section that cites the exact keys v1 reads (OBSERVED) and names the sample level file(s) v1 ships; do not ship all levels in S01.
  - Rip briefs: rip/briefs/{GAME,GAMEPLAY,2D_ART,3D_ART}_BRIEF.md — research seeds about the shipped Unity game (label SEED). Re-derive v1 yourself; meta systems they describe go to NOT-in-v1 / _Avoid_ unless explicitly requested and scoped by the director. Rip prose alone never expands v1.
  - Store pack validates visible HUD/layout/look. Port behavior comes from reviewed code/data evidence in RIP_PORT_BLOCK; source-version conflicts and deliberate deviations are recorded, not silently resolved in favor of marketing screenshots. Use color enum × neutral art when observed, not invented per-color assets. Conflicts with director-reported play follow the gameplay-notes contract.
  - ASSET_MANIFEST.md rows: Source column `import` (exact rip/models path + slice region) or `generate`; default import when a P0/P1 catalog file covers the need.
```

## `<RIP_PORT_BLOCK>` (every rip-backed port, independent of store/media source mode)

```text
- Port analysis: <RIP_PORT_PATH>/RIP_PORT_MANIFEST.json; validated SHA-256: <RIP_PORT_HASH>.
- Read its five reports and docs/rip-port-contract.md before deciding core rules. Follow the
  contract's Contracts and implementation handoff section. Use source IDs and RP claim IDs;
  open critical cited input/resolution/win/lose/reset and level-reader evidence as needed.
  The mid-tier analyst already did broad source investigation; use targeted follow-ups.
- HOW_TO needs port coverage; ARCHITECTURE needs behavior-to-Cocos mappings. Slices include
  Port evidence with this analysis path and pinned manifest hash, RP-linked acceptance and
  initial state → input → expected result scenarios. Preserve deferred/unknown dispositions.
- Forensic INFERRED/PORT_DECISION becomes ASSUMPTION in contract evidence fields. UNKNOWN
  remains a risk; source stubs/names do not prove behavior. Explicit director changes are GIVEN.
- Existing suitable assets default to import. List staged source, runtime destination and
  required conversion. Generate only uncovered needs with a reason. Raw Unity-only inputs
  require staging selected assets before exact import paths can pass the contract gate.
- Each slice that mirrors shipped presentation (environment, models, UI layout, VFX, camera,
  animation, audio wiring) gets `rip_study` topics per docs/slice-schema.md: specific questions
  plus source_dirs from RIP_ASSET_MAP.md or the inventory's presentationIndex. Use
  `rip_study: []` for slices with nothing to mirror. The producer answers these from the rip
  before dispatch; do not open prefabs or scenes to author parameters yourself.
- The analyst's source coverage is not proof of runtime parity or permission to expand v1.
```

## `<SOURCE_BLOCK>` variants

### store (reference pack from store-game-clone)

```text
- Store page: <STORE_URL>
- Reference pack: reference/<SLUG>/ (iphone/, ipad/, video/preview.mp4, video/frames/, video/probe/, icon-1024.png, manifest.json; models/ if present) — READ the screenshots and frames, not just the manifest
- Research seed if present: reference/<SLUG>-brief/ (rewrite research briefs — do not rubber-stamp; preserve director source text in GAMEPLAY_NOTES.md / IDEA.md)
- Allowed labels: OBSERVED, GIVEN (only supplied director statements), ASSUMPTION; SEED when the rip block is present
```

### media (user-supplied folder, not a store crawl)

```text
- Reference media: reference/<SLUG>/ (screenshots, video + video/frames/ + video/probe/, GDD / notes, models/*.glb if present) — inspect the index shortlist, then extra media only for an identified evidence gap; user-authored GDD/notes are director statements and must be read fully; rip research prose follows SEED rules
- Director notes (if any): reference/<SLUG>-brief/IDEA.md
- Allowed labels: OBSERVED, GIVEN, ASSUMPTION; SEED when the rip block is present
```

### idea (text only)

```text
- Director idea: reference/<SLUG>-brief/IDEA.md — base source; quote it by section (§n); supplied gameplay notes supplement it when present
- No media exists. NEVER write OBSERVED. Every row is GIVEN (IDEA §n / GAMEPLAY_NOTES GP-nn) or ASSUMPTION.
- For the feel table, propose concrete values (easing, ms, shake yes/no) and label them ASSUMPTION; the director will tune them in review.
```
