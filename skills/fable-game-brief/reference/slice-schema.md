# Slice schema — MILESTONES.md, slices/S<nn>-<name>.md, RELEASE_CHECKLIST.md

Written once by Fable (`fable-game-brief`), read by `game-producer` and `cocos-orca-fleet`.
Every field of a slice maps 1:1 onto the fleet PLAN (`vibe-game-director/reference/plan-schema.md`)
so the producer never has to infer scope. Slice files are **contracts**: the producer never edits
them; progress lives in `AGENT_NOTES.md` `release:`.

## Cutting rules

- **Vertical slices only** — each slice is playable, previewable, and reviewable on its own.
  No "engine-only" or "refactor" slice.
- `S01` = the v1 playable slice `GAME_BRIEF.md` describes. Last slice = `release-polish`
  (see below) and closes every remaining `RELEASE_CHECKLIST.md` row.
- 6–9 slices for a casual game. Typical order: core loop → win/fail/restart → progression /
  levels → HUD + menu → juice + audio → persistence + settings → onboarding → release-polish.
- `paths` of two slices listed in `parallel_ok` must be disjoint (code, art, scene objects).
- Every acceptance row carries an evidence label: `OBSERVED (<file>)`, `GIVEN (IDEA §n)`,
  `ASSUMPTION`. A slice with ≥ 3 `ASSUMPTION` rows is flagged `needs_director_ok: true`.
- `size` decides the lane: `L` → `cocos-orca-fleet`; `S` / `M` → single agent
  (`vibe-game-director`). Prefer `L` for anything with new art + scene + code.

## MILESTONES.md

```markdown
# MILESTONES — <game>

One paragraph: how the slices add up to the release; what "done" means (link RELEASE_CHECKLIST.md).

```yaml
slices: [S01, S02, S03, S04, S05, S06, S07, S08]
dag:                      # slice → prerequisites
  S02: [S01]
  S03: [S01, S02]
  S04: [S01]
  S05: [S03]
  S06: [S03]
  S07: [S04, S06]
  S08: [S01, S02, S03, S04, S05, S06, S07]
parallel_ok: [[S04, S05]] # pairs with disjoint paths; anything else runs serially
v1_slice: S01             # `release.goal: playable` stops after this one
release_slice: S08        # always the release-polish slice; never runs in parallel
stop_when: RELEASE_CHECKLIST.md all rows PASS
```

| id | name | size | one-liner | unlocks |
|----|------|------|-----------|---------|
| S01 | core-loop | L | … | S02, S04 |
| … | | | | |
```

## slices/S<nn>-<name>.md

```markdown
---
id: S03
name: fail-restart-loop
one_liner: Player can die, see a fail screen, and restart within one tap
size: L                            # L → fleet · S|M → single agent
depends_on: [S01, S02]
unlocks: [S05, S06]
needs_director_ok: false           # true when ≥ 3 ASSUMPTION rows or a SCOPE-level choice is open
player_outcome: "After this slice the player can: die → see result → play again"
release_items: [RC-03, RC-07]      # RELEASE_CHECKLIST rows this slice closes

scope:
  in:  [death detection, FailPanel UI, restart flow, best-score persist]
  out: [revive by ad, leaderboard, share]

paths:                             # → PLAN.allowed_paths / allowed_scene_objects
  code: [assets/scripts/systems/GameStateSystem.ts, assets/scripts/ui/FailPanel.ts]
  art:  [assets/art/ui/fail/**]
  scene_objects: [Canvas/UI/FailPanel, Canvas/HUD/ScoreLabel]

assets:                            # → art-manifest rows (stem, P0|P1); refs ASSET_MANIFEST.md
  2d:    [{stem: fail_panel_bg, p: P0}, {stem: btn_restart, p: P0}]
  3d:    []
  vfx:   [{stem: death_burst_particle, p: P0}]
  audio: [{stem: sfx_fail, p: P1}]

acceptance:                        # → PLAN.acceptance_criteria — observations, never logic
  - text: "Collision → ship breaks with particle burst, hit-stop ≈80 ms, light shake"
    evidence: OBSERVED (reference/<slug>/video/frames/t18.jpg)
  - text: "FailPanel slides in from bottom ≤250 ms ease-out, shows score + best"
    evidence: ASSUMPTION
  - text: "Tap Restart → gameplay in <500 ms, score reset, best kept"
    evidence: GIVEN (IDEA §4)

feel_rows: [death, level_transition]   # rows of EXPECT_GAMEPLAY_VISUAL.md feel table that apply

runtime_checks:                    # → PLAN.runtime_checks
  - no console errors across 3 die→restart cycles
  - localStorage best_score survives a reload
  - fps ≥ 55 for 5 s after restart

playtest:                          # reviewer script in preview, in order
  - play until death
  - observe VFX + panel; capture preview.png
  - restart ×3; reload; check best

change_budget: {files: 6, lines: 350, nodes: 4, assets: 4, tripo_credits: 0}
risks:
  - "Countdown before restart? — ask director before dispatch"
---

## Why here
One paragraph tying the slice to GAME_BRIEF §n / HOW_TO rows.

## Accepted deviations
| Reference | Allowed deviation | Reason |
|-----------|-------------------|--------|
```

## RELEASE_CHECKLIST.md

Rows are product-level "done" criteria. Each row names the slice expected to close it; the
release-polish slice sweeps whatever is left. Reviewer of the release slice runs **all** rows.

```markdown
# RELEASE CHECKLIST — <game>

| id | area | check (observation) | closed_by | how to verify |
|----|------|---------------------|-----------|---------------|
| RC-01 | lifecycle | Cold load shows loading/splash with progress; no white flash; no error if an asset is slow | S08 | throttle network in preview, reload |
| RC-02 | lifecycle | Tab hidden → game + audio pause; return → no time/frame jump | S06 | switch tab 10 s |
| RC-03 | lifecycle | Fail → result → restart in 1 tap; no dead-end screen | S03 | die ×3 |
| RC-04 | lifecycle | Reload mid-run keeps a valid save; corrupted/empty localStorage does not crash | S06 | clear storage, inject junk JSON |
| RC-05 | layout | Rotate / resize / notch: every UI element inside safe area (`cc.Widget` on all) | S08 | rotate, resize window |
| RC-06 | input | Touch targets ≥ 44 px; no double-fire; browser scroll/zoom/long-press blocked | S08 | rapid taps, pinch |
| RC-07 | input | Mouse + touch both work | S03 | desktop + device |
| RC-08 | ux | First-run hint shown once, persisted | S07 | fresh storage, reload |
| RC-09 | ux | Sound on/off setting, remembered | S06 | toggle, reload |
| RC-10 | feel | Every row of the EXPECT feel/VFX table implemented and reviewed | S05, S08 | reviewer tick-list |
| RC-11 | audio | SFX on every interaction + 1 music loop; unlock after first gesture (iOS) | S05 | play on iOS Safari |
| RC-12 | perf | fps ≥ 55 on a mid device across 3 min; no per-frame GC spikes (pools for spawned objects) | S08 | profiler / smoke fps probe |
| RC-13 | perf | Bundle ≤ budget; textures atlased; no leak after restart ×20 (node count stable) | S08 | build size, node count probe |
| RC-14 | quality | Zero console.error/warn during the full playtest script; tsc strict + lint clean | S08 | smoke-test |
| RC-15 | quality | No debug code, cheats, logs, test scenes | S08 | grep |
| RC-16 | branding | Icon 1024 + favicon + apple-touch-icon; title / meta / OG image; PWA manifest (optional) | S08 | view source |
| RC-17 | assets | No placeholder art/text; fonts with fallback; strings not hardcoded in scene | S08 | walkthrough |
| RC-18 | assets | Every asset has its .meta pair; no orphan assets | S08 | integrator check |
| RC-19 | ship | `build/build.sh --clean` release build serves without 404s | S08 | `--serve` |
| RC-20 | ship | Preview deploy passes smoke test on the deployed URL; then prod if `release.deploy: prod` | S08 | ship skill |
| RC-21 | ship | git tag `v1.0.0`; FOLLOWUPS.md trimmed to a v1.1 backlog | S08 | git tag |
```

## release-polish slice (always last)

No new mechanics. `paths` is wide (touches many files) → never `parallel_ok`. `change_budget`
code small, `assets` / `audio` large. Acceptance is mostly **absence** (no error, no overflow,
no placeholder), so `playtest` must be an explicit script:

```
cold load → play → fail → restart ×3 → pause/resume (tab switch) → rotate → reload
→ mute → play again → capture preview.png at each step
```

Its `release_items` = every RC row not closed by an earlier slice; its `runtime_checks` include
`RELEASE_CHECKLIST.md all rows PASS`, fps floor, bundle-size budget, localStorage schema check.
After APPROVED the producer runs the `ship` skill per `release.deploy`.
