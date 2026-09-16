# Fable brief-author prompt (sent via `bootstrap.mjs agent-session --agent "claude --model fable"`)

Replace `<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<RIP_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`,
`<ENGINE_LINE>`, `<RELEASE_GOAL>` (`end_to_end` | `playable`, from `AGENT_NOTES.md` `release.goal`).
Pick exactly one `<SOURCE_BLOCK>` variant below and paste it in place. Paste the `<RIP_BLOCK>`
variant only when `reference/<SLUG>/rip/RIP_PACK.json` exists; otherwise delete that line.
`docs/slice-schema.md` must already be copied into the project (skill Step 3).

```text
Task: author the project contracts for the game in <PROJECT>.
You are Claude Fable in <PROJECT>.

## Sources (read thoroughly before writing)
<SOURCE_BLOCK>
<RIP_BLOCK>
- Contract templates: .cursor/skills/vibe-game-director/templates/{GAME_BRIEF,SCOPE,ARCHITECTURE,FOLLOWUPS,PLAYTEST}.md
- Slice / milestone / release-checklist format: docs/slice-schema.md (follow it exactly — the producer parses the yaml front-matter)
- PLAN format the slices must map onto: .cursor/skills/vibe-game-director/reference/plan-schema.md
- Quality bar for depth: sibling briefs under /Users/wikz/orca-global/*-brief/ (structure only — never copy another game's mechanics)
- Engine: <ENGINE_LINE>; TypeScript strict; web-mobile target
- Release goal: <RELEASE_GOAL> (end_to_end = every slice then ship; playable = producer stops after v1_slice — make S01 self-sufficient: own fail/restart + minimal HUD)

## Deliverables (repo root unless noted)
A. GAME_BRIEF.md — first playable slice only. Orient <ORIENTATION>, design res <DESIGN_RES>. Explicit NOT-in-v1 list (modes / meta / IAP / anything outside the slice).
B. HOW_TO.md — evidence→decision table. File layout, units, HUD numbers for <DESIGN_RES>. Every row carries an evidence label (see Labels).
C. EXPECT_GAMEPLAY_VISUAL.md — reviewer tick-list of what must be SEEN/FELT, each item citing its evidence. Accepted-deviation table.
   MUST include a **Game feel / VFX table** — one row per interaction (tap, move, merge/match,
   score gain, combo, fail/death, level transition, idle): VFX (particles, flash, trail, glow),
   tween easing + duration, screen shake / hit-stop yes-no, evidence label. These rows are v1
   acceptance criteria, not polish-later notes.
D. ASSET_MANIFEST.md — P0 raw art for the art worker (antigravity by default). Prefer importing existing reference/<SLUG>/models/*.glb when present; list regen script path if present.
   MUST list the **VFX assets** the feel table needs (particle textures, effect sprite sheets,
   glow/flare sprites) as P0 alongside gameplay sprites — an effect absent here is never produced.
   When a rip pack exists (see Rip pack block): every row carries a **Source** column = `import` (exact
   path under reference/<SLUG>/rip/images_ingame/, reference/<SLUG>/models/ or reference/<SLUG>/rip/meshes/,
   plus the atlas region to slice for `sactx-*` pages) or `generate` (prompt for the art worker). Default
   to `import` whenever the catalog has a P0/P1 file for the need; never import a P3 / meta / uGUI entry.
E. SCOPE.md, ARCHITECTURE.md, FOLLOWUPS.md, PLAYTEST.md from the templates (TS strict, event bus, web-mobile, core/systems/entities/ui). Tight change budget.
F. CONTEXT.md — game-specific domain terms only (Coin, Level, Core loop, system names), 1–2 sentence definitions, an `_Avoid_` list naming out-of-v1 modes.
G. docs/adr/0001-tech-stack.md — <ENGINE_LINE>, TS strict, web-mobile, <DESIGN_RES>, physics only if the core loop needs it, localStorage behind SaveSystem.
H. MILESTONES.md — every slice of the release, cut per docs/slice-schema.md: yaml block (slices, dag, parallel_ok, v1_slice, release_slice, stop_when) + table. 6–9 vertical slices; S01 == the v1 slice of GAME_BRIEF.md; last slice == release-polish.
I. slices/S<nn>-<name>.md — one file per slice with the full yaml front-matter (id, size, depends_on, needs_director_ok, scope in/out, paths code/art/scene_objects, assets 2d/3d/vfx/audio, acceptance with evidence labels, feel_rows, runtime_checks, playtest, change_budget, risks). Fields map 1:1 onto plan-schema.md; paths of parallel_ok pairs must be disjoint.
J. RELEASE_CHECKLIST.md — product-level "done" rows RC-nn per docs/slice-schema.md (lifecycle, layout, input, ux, feel, audio, perf, quality, branding, assets, ship), each with closed_by = a slice id. Union of all slices' release_items must cover every row.

## Labels (mandatory on every HOW_TO / EXPECT row)
- OBSERVED (<file>) — seen in a reference file; cite the exact path (reference/<SLUG>/iphone/03.jpg, reference/<SLUG>/video/frames/t12.jpg, reference/<SLUG>/rip/levels/t160-level-1.json, reference/<SLUG>/rip/images_ingame/<file>.png, …)
- GIVEN (IDEA §n) — stated by the director in the idea text
- SEED (reference/<SLUG>/rip/briefs/<file>.md §n) — only when a rip pack exists: a claim taken from the rip briefs / guides; never the sole evidence for a v1 mechanic — pair it with OBSERVED or downgrade to ASSUMPTION
- ASSUMPTION — your fill; keep these few and call them out in the summary

## Rules
- Do not invent mechanics. Observe media when you have it; otherwise stay inside GIVEN + minimal ASSUMPTION.
- Do not implement gameplay, do not open Creator, do not commit, do not push.
- Slice files are contracts: no status fields, no TODOs; anything undecided goes to `risks` and flips `needs_director_ok: true`.
- When done: file list + 5-bullet v1 slice summary + the slice table (id · size · one-liner · needs_director_ok) + count of ASSUMPTION rows (+ import/generate row counts when a rip pack exists), then stop.
```

## `<RIP_BLOCK>` (paste only when `reference/<SLUG>/rip/RIP_PACK.json` exists; else delete the line)

```text
- Rip pack (unity-apk-rip output of the shipped game, merged by store-game-clone): reference/<SLUG>/rip/
  - Start with rip/RIP_PACK.json (what was merged; `images/` full dump is usually excluded) and rip/README.md (folder guide).
  - Exact in-game art: rip/images_ingame/ + rip/IMAGES_INGAME_GUIDE.md + rip/images_ingame_catalog.json (`priority`, `category`, `maps_to`, `how_to_use` per file). `sactx-*` files are packed SpriteAtlas pages — cite the page and describe the region to slice; never treat a page as one sprite. Prefer `*_New` over `*_Old`.
  - Mesh topology: reference/<SLUG>/models/*.glb (catalog P0 already copied there) + rip/MESHES_GUIDE.md + rip/meshes_catalog.json. Most GLBs are uGUI prefab dumps (P3) — never list *PopUp*/Toolbar*/*Leaderboard* as art. If the guide says the game is 2.5D/sprite-based, plan sprites and use meshes only for shape data.
  - Level data: rip/levels/*.json (+ schema keys in rip/README.md and rip/briefs/GAMEPLAY_BRIEF.md). If v1 loads levels, HOW_TO.md gets a level-schema section that cites the exact keys v1 reads (OBSERVED) and names the sample level file(s) v1 ships; do not ship all levels in S01.
  - Rip briefs: rip/briefs/{GAME,GAMEPLAY,2D_ART,3D_ART}_BRIEF.md — research seeds about the shipped Unity game (label SEED). Re-derive v1 yourself; meta systems they describe (arena, store, live-ops, collections, leaderboards, IAP) go to NOT-in-v1 / _Avoid_, never into the v1 slice.
  - Store pack stays the source for feel / HUD layout / marketing look; the rip is the source for exact sprites, colors (color enum × neutral art — never per-color assets), shapes, and level schema. When they disagree, EXPECT follows the store screenshots/trailer and notes the rip variant in the accepted-deviation table.
  - ASSET_MANIFEST.md rows: Source column `import` (exact rip/models path + slice region) or `generate`; default import when a P0/P1 catalog file covers the need.
```

## `<SOURCE_BLOCK>` variants

### store (reference pack from store-game-clone)

```text
- Store page: <STORE_URL>
- Reference pack: reference/<SLUG>/ (iphone/, ipad/, video/preview.mp4, video/frames/, icon-1024.png, manifest.json; models/ if present) — READ the screenshots and frames, not just the manifest
- Research seed if present: reference/<SLUG>-brief/ (rewrite — do not rubber-stamp)
- Allowed labels: OBSERVED, ASSUMPTION
```

### media (user-supplied folder, not a store crawl)

```text
- Reference media: reference/<SLUG>/ (screenshots, video + video/frames/, GDD / notes, models/*.glb if present) — READ every image and frame; treat any .md inside as director statements
- Director notes (if any): reference/<SLUG>-brief/IDEA.md
- Allowed labels: OBSERVED, GIVEN, ASSUMPTION
```

### idea (text only)

```text
- Director idea: reference/<SLUG>-brief/IDEA.md — this is the whole source; quote it by section (§n)
- No media exists. NEVER write OBSERVED. Every row is GIVEN (IDEA §n) or ASSUMPTION.
- For the feel table, propose concrete values (easing, ms, shake yes/no) and label them ASSUMPTION; the director will tune them in review.
```
