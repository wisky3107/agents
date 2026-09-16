# Fable brief-author prompt (sent via `bootstrap.mjs agent-session --agent "claude --model fable"`)

Replace `<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`, `<ENGINE_LINE>`,
`<RELEASE_GOAL>` (`end_to_end` | `playable`, from `AGENT_NOTES.md` `release.goal`).
Pick exactly one `<SOURCE_BLOCK>` variant below and paste it in place.
`docs/slice-schema.md` must already be copied into the project (skill Step 3).

```text
Task: author the project contracts for the game in <PROJECT>.
You are Claude Fable in <PROJECT>.

## Sources (read thoroughly before writing)
<SOURCE_BLOCK>
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
E. SCOPE.md, ARCHITECTURE.md, FOLLOWUPS.md, PLAYTEST.md from the templates (TS strict, event bus, web-mobile, core/systems/entities/ui). Tight change budget.
F. CONTEXT.md — game-specific domain terms only (Coin, Level, Core loop, system names), 1–2 sentence definitions, an `_Avoid_` list naming out-of-v1 modes.
G. docs/adr/0001-tech-stack.md — <ENGINE_LINE>, TS strict, web-mobile, <DESIGN_RES>, physics only if the core loop needs it, localStorage behind SaveSystem.
H. MILESTONES.md — every slice of the release, cut per docs/slice-schema.md: yaml block (slices, dag, parallel_ok, v1_slice, release_slice, stop_when) + table. 6–9 vertical slices; S01 == the v1 slice of GAME_BRIEF.md; last slice == release-polish.
I. slices/S<nn>-<name>.md — one file per slice with the full yaml front-matter (id, size, depends_on, needs_director_ok, scope in/out, paths code/art/scene_objects, assets 2d/3d/vfx/audio, acceptance with evidence labels, feel_rows, runtime_checks, playtest, change_budget, risks). Fields map 1:1 onto plan-schema.md; paths of parallel_ok pairs must be disjoint.
J. RELEASE_CHECKLIST.md — product-level "done" rows RC-nn per docs/slice-schema.md (lifecycle, layout, input, ux, feel, audio, perf, quality, branding, assets, ship), each with closed_by = a slice id. Union of all slices' release_items must cover every row.

## Labels (mandatory on every HOW_TO / EXPECT row)
- OBSERVED (<file>) — seen in a reference file; cite the exact path (reference/<SLUG>/iphone/03.jpg, reference/<SLUG>/video/frames/t12.jpg, …)
- GIVEN (IDEA §n) — stated by the director in the idea text
- ASSUMPTION — your fill; keep these few and call them out in the summary

## Rules
- Do not invent mechanics. Observe media when you have it; otherwise stay inside GIVEN + minimal ASSUMPTION.
- Do not implement gameplay, do not open Creator, do not commit, do not push.
- Slice files are contracts: no status fields, no TODOs; anything undecided goes to `risks` and flips `needs_director_ok: true`.
- When done: file list + 5-bullet v1 slice summary + the slice table (id · size · one-liner · needs_director_ok) + count of ASSUMPTION rows, then stop.
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
