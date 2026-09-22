# Game brief author prompt

Send via `bootstrap.mjs agent-session --agent "$BRIEF_AGENT"` using the resolved agent/model.
This prompt applies equally to all supported providers; default is Fable 5.1.

Replace `<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<RIP_BLOCK>`, `<GAMEPLAY_NOTES_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`,
`<ENGINE_LINE>`, `<RELEASE_GOAL>` (`end_to_end` | `playable`, from `AGENT_NOTES.md` `release.goal`),
`<BRIEF_TOOLS>` (absolute skill scripts directory), `<BRIEF_RUN_ID>` and `<CONTRACT_DEPTH>`.
Pick exactly one `<SOURCE_BLOCK>` variant below and paste it in place. Paste the `<RIP_BLOCK>`
variant only when `reference/<SLUG>/rip/RIP_PACK.json` exists; otherwise delete that line.
Insert `<GAMEPLAY_NOTES_BLOCK>` only when notes exist, replacing `<GAMEPLAY_NOTES_PATH>`
with the saved project-relative path; otherwise delete the placeholder line.
`docs/slice-schema.md` must already be copied into the project (skill Step 3).

```text
Task: author the project contracts for the game in <PROJECT>.
You are the brief author in <PROJECT>.

## Sources (shortlist first; full director source)
<SOURCE_BLOCK>
<RIP_BLOCK>
<GAMEPLAY_NOTES_BLOCK>
- Read `docs/brief-input-index.json` first. Inspect its shortlist and full director source; query `docs/brief-asset-candidates.json` only for a specific needed asset. Record extra research with `node <BRIEF_TOOLS>/brief-progress.mjs --project <PROJECT> --run-id <BRIEF_RUN_ID> --read <path> --reason <decision>`. Use bounded targeted lookups; no default full-pack contact sheet. Counts/metadata are not proof of visual inspection.
- Contract templates: .cursor/skills/vibe-game-director/templates/{GAME_BRIEF,SCOPE,ARCHITECTURE,FOLLOWUPS,PLAYTEST}.md
- Slice / milestone / release-checklist format: docs/slice-schema.md (follow it exactly — the producer parses the yaml front-matter)
- PLAN format the slices must map onto: .cursor/skills/vibe-game-director/reference/plan-schema.md
- Optional recipes: read ~/.agents/skills/cocos-playbook/SKILL.md when available (fallback
  /Users/wikz/Works/games/cocos-playbook/SKILL.md), its INDEX, then only matching recipes.
  Resolve engine/render mode/platform from this project. Pin id/revision/sha256/path into
  recipe_refs in relevant slices; add in-scope checks and ADR rationale. Missing/no match = [].
  A candidate is guidance to validate, not observed product behavior; preserve GIVEN/ASSUMPTION.
- Quality bar for depth: consult at most one sibling brief under /Users/wikz/orca-global/*-brief/ only if templates leave a structural question; never copy mechanics.
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
   MUST include a **Game feel / VFX table** — one row per interaction (tap, move, merge/match,
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
E. SCOPE.md, ARCHITECTURE.md, FOLLOWUPS.md, PLAYTEST.md from the templates (TS strict, event bus, web-mobile, core/systems/entities/ui). Tight change budget.
F. CONTEXT.md — game-specific domain terms only (Coin, Level, Core loop, system names), 1–2 sentence definitions, an `_Avoid_` list naming out-of-v1 modes.
G. docs/adr/0001-tech-stack.md — <ENGINE_LINE>, TS strict, web-mobile, <DESIGN_RES>, physics only if the core loop needs it, localStorage behind SaveSystem.
H. MILESTONES.md — every slice of the release, cut per docs/slice-schema.md: yaml block (slices, dag, parallel_ok, v1_slice, release_slice, stop_when) + table. 6–9 vertical slices; S01 == the v1 slice of GAME_BRIEF.md; last slice == release-polish.
I. slices/S<nn>-<name>.md — one file per slice with the full yaml front-matter (id, size, depends_on, needs_director_ok, scope in/out, paths code/art/scene_objects, assets 2d/3d/vfx/audio, acceptance with evidence labels, feel_rows, runtime_checks, playtest, change_budget, risks). Fields map 1:1 onto plan-schema.md; paths of parallel_ok pairs must be disjoint.
   S01 must own the complete in-game UX/UI visible during the playable loop and every P0 art/font
   dependency needed to match the expected mock screen. Its acceptance and playtest must include
   visual comparison at <DESIGN_RES> plus at least two materially different viewport shapes,
   safe-area/notch checks, legibility, touch-target sizing, and absence of placeholder/debug UI.
   Specify capture paths and PASS/FAIL criteria per viewport using the visual review contract.
   Runtime captures are produced later by the implementation reviewer; do not claim them as done.
   Later HUD/juice slices may extend or refine S01, but must not be required to make S01 presentable.
J. RELEASE_CHECKLIST.md — product-level "done" rows RC-nn per docs/slice-schema.md (lifecycle, layout, input, ux, feel, audio, perf, quality, branding, assets, ship), each with closed_by = a slice id. Union of all slices' release_items must cover every row.
   Assign initial in-game layout, input, fail/restart, feel, asset completeness, and visual fidelity
   checks to S01; later slices add coverage for new screens, and release-polish reruns all checks.

## Labels (mandatory on every HOW_TO / EXPECT row)
- OBSERVED (<file>) — seen in a reference file; cite the exact path (reference/<SLUG>/iphone/03.jpg, reference/<SLUG>/video/frames/t12.jpg, reference/<SLUG>/rip/levels/t160-level-1.json, reference/<SLUG>/rip/images_ingame/<file>.png, …)
- GIVEN (IDEA §n) or GIVEN (GAMEPLAY_NOTES GP-nn) — stated by the director; reported play is testimony, not agent-observed evidence. Preserve uncertainty in tentative statements.
- SEED (reference/<SLUG>/rip/briefs/<file>.md §n) — only when a rip pack exists: a claim taken from the rip briefs / guides; never the sole evidence for a v1 mechanic — corroborate with OBSERVED or a definite GIVEN statement, otherwise downgrade to ASSUMPTION
- ASSUMPTION — your fill; keep these few and call them out in the summary

## Rules
- Do not invent mechanics. Observe media when you have it; otherwise stay inside GIVEN + minimal ASSUMPTION.
- Do not implement gameplay, do not open Creator, do not commit, do not push.
- Slice files are contracts: no status fields, no TODOs; anything undecided goes to `risks` and flips `needs_director_ok: true`.
- When done: file list + 5-bullet v1 slice summary + the slice table (id · size · one-liner · needs_director_ok) + count of ASSUMPTION rows (+ import/generate row counts when a rip pack exists; GP coverage counts and unresolved conflicts when gameplay notes exist), then stop.
- Write GAME_BRIEF.md once core evidence and source requirements are understood, then HOW_TO/EXPECT/ASSET_MANIFEST, supporting contracts and slices. Save completed sections incrementally. Use `node <BRIEF_TOOLS>/brief-progress.mjs --project <PROJECT> --run-id <BRIEF_RUN_ID> --phase <phase> --file <file>` after each group. Record opened images with `--evidence <path>`. Author stops at contracts_written; coordinator owns semantic review and done. Repeated heartbeat writes do not count as progress.
```

## `<GAMEPLAY_NOTES_BLOCK>` (optional, every source mode)

```text
- Director gameplay notes: <GAMEPLAY_NOTES_PATH> — read Source text and Requirement index in full; this is director input, not a research seed to rewrite.
- Notes contract: docs/gameplay-notes-contract.md — follow Evidence and decisions + Coverage; validate stable GP IDs against the source. Cite GIVEN (GAMEPLAY_NOTES GP-nn).
- Add Gameplay notes coverage to HOW_TO.md and carry included rules/scenarios into the owning slices so writer and reviewer use the same requirements. Explicit requested changes override inferred store/rip behavior; record intended deviations. Report unresolved material conflicts without silently selecting a rule.
- For amendments to existing contracts, also follow Notes arriving after contracts exist in the notes contract and the caller's affected-path/release-state handoff. Revise the affected set, preserving existing slice IDs and completed contracts; the initial full-release authoring/count rules do not require regenerating the release.
```

## `<RIP_BLOCK>` (paste only when `reference/<SLUG>/rip/RIP_PACK.json` exists; else delete the line)

```text
- Rip pack (unity-apk-rip output of the shipped game, merged by store-game-clone): reference/<SLUG>/rip/
  - Start with rip/RIP_PACK.json (what was merged; `images/` full dump is usually excluded) and rip/README.md (folder guide).
  - Exact in-game art: rip/images_ingame/ + rip/IMAGES_INGAME_GUIDE.md + rip/images_ingame_catalog.json (`priority`, `category`, `maps_to`, `how_to_use` per file). Sprites are de-atlased (one PNG per Unity Sprite); `maps_to` is the SpriteAtlas family. Prefer `*_New` over `*_Old`. Fonts: rip/fonts/ (.ttf/.otf) when present — SDF atlas PNGs are not in images/.
  - Mesh topology: reference/<SLUG>/models/*.glb (catalog P0 already copied there) + rip/MESHES_GUIDE.md + rip/meshes_catalog.json. Most GLBs are uGUI prefab dumps (P3) — never list *PopUp*/Toolbar*/*Leaderboard* as art. If the guide says the game is 2.5D/sprite-based, plan sprites and use meshes only for shape data.
  - Level data: rip/levels/*.json (+ schema keys in rip/README.md and rip/briefs/GAMEPLAY_BRIEF.md). If v1 loads levels, HOW_TO.md gets a level-schema section that cites the exact keys v1 reads (OBSERVED) and names the sample level file(s) v1 ships; do not ship all levels in S01.
  - Rip briefs: rip/briefs/{GAME,GAMEPLAY,2D_ART,3D_ART}_BRIEF.md — research seeds about the shipped Unity game (label SEED). Re-derive v1 yourself; meta systems they describe go to NOT-in-v1 / _Avoid_ unless explicitly requested and scoped by the director. Rip prose alone never expands v1.
  - Store pack stays the source for feel / HUD layout / marketing look; the rip is the source for exact sprites, colors (color enum × neutral art — never per-color assets), shapes, and level schema. Unless an explicit director requirement determines the design, EXPECT follows store screenshots/trailer when store and rip disagree, noting the rip variant in the accepted-deviation table. Conflicts with reported play follow the gameplay-notes contract.
  - ASSET_MANIFEST.md rows: Source column `import` (exact rip/models path + slice region) or `generate`; default import when a P0/P1 catalog file covers the need.
```

## `<SOURCE_BLOCK>` variants

### store (reference pack from store-game-clone)

```text
- Store page: <STORE_URL>
- Reference pack: reference/<SLUG>/ (iphone/, ipad/, video/preview.mp4, video/frames/, icon-1024.png, manifest.json; models/ if present) — READ the screenshots and frames, not just the manifest
- Research seed if present: reference/<SLUG>-brief/ (rewrite research briefs — do not rubber-stamp; preserve director source text in GAMEPLAY_NOTES.md / IDEA.md)
- Allowed labels: OBSERVED, GIVEN (only supplied director statements), ASSUMPTION; SEED when the rip block is present
```

### media (user-supplied folder, not a store crawl)

```text
- Reference media: reference/<SLUG>/ (screenshots, video + video/frames/, GDD / notes, models/*.glb if present) — inspect the index shortlist, then extra media only for an identified evidence gap; user-authored GDD/notes are director statements and must be read fully; rip research prose follows SEED rules
- Director notes (if any): reference/<SLUG>-brief/IDEA.md
- Allowed labels: OBSERVED, GIVEN, ASSUMPTION; SEED when the rip block is present
```

### idea (text only)

```text
- Director idea: reference/<SLUG>-brief/IDEA.md — base source; quote it by section (§n); supplied gameplay notes supplement it when present
- No media exists. NEVER write OBSERVED. Every row is GIVEN (IDEA §n / GAMEPLAY_NOTES GP-nn) or ASSUMPTION.
- For the feel table, propose concrete values (easing, ms, shake yes/no) and label them ASSUMPTION; the director will tune them in review.
```
