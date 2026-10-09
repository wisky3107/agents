# Slice schema — MILESTONES.md, slices/S<nn>-<name>.md, RELEASE_CHECKLIST.md

Written once by the brief author (`game-brief`), read by `game-producer` and `cocos-orca-fleet`.
Every field of a slice maps 1:1 onto the fleet PLAN (`vibe-game-director/reference/plan-schema.md`)
so the producer never has to infer scope. Slice files are **contracts**: the producer never edits
them; progress lives in `AGENT_NOTES.md` `release:`.

## Cutting rules

`brief.contract_depth` defaults to `full`. Opt-in `playable` follows the bounded-authoring
reference (project copy: `docs/brief-workflow.md`): full S01, all later slice files/fields present as
non-dispatchable outlines until expanded. Keep concrete outcomes, scope, dependency, paths,
budgets, evidence-labeled acceptance, RC ownership and GP scenarios in both depths. This changes
authoring depth only; the S01 visual contract below is unchanged.

- **Vertical slices only** — each slice is playable, previewable, and reviewable on its own.
  No "engine-only" or "refactor" slice.
- `S01` = the v1 playable slice `GAME_BRIEF.md` describes. It is presentation-ready, not a
  mechanics prototype: complete core loop, fail/restart, polished in-game UX/UI, all required P0
  UI art/fonts, responsive safe-area behavior, and close correspondence to the expected mock screen
  in `EXPECT_GAMEPLAY_VISUAL.md`. It must contain no placeholder/debug UI. Last slice =
  `release-polish` (see below) and closes every remaining `RELEASE_CHECKLIST.md` row.
- 6–9 slices for a casual game. Typical order: polished playable core loop (including in-game HUD,
  responsive layout, and fail/restart) → progression / levels → shell/menu → extra juice + audio →
  persistence + settings → onboarding → release-polish. A later HUD slice may add meta/shell UI,
  but cannot defer the in-game presentation required for S01.
- `paths` of two slices listed in `parallel_ok` must be disjoint (code, art, scene objects).
- Every acceptance row carries an evidence label: `OBSERVED (<file>)`, `GIVEN (IDEA §n)`,
  `ASSUMPTION`. A slice with ≥ 3 `ASSUMPTION` rows is flagged `needs_director_ok: true`.
- `player_outcome` is required (→ PLAN `user_visible_behavior`). `unlocks` lists only slices whose
  `dag` entry contains this id (it may omit release-polish).
- `feel_rows` values must be row IDs in the first column of the EXPECT Game feel / VFX table
  (`tap`, `move`, `score_gain`, …); name that column `ID / interaction` and start each cell with the ID.
- A later slice that adds a screen (`scene_objects` *Panel/Screen/Menu/Popup/Dialog/Overlay/Modal*
  not owned by an earlier slice) needs its own visual target: an existing reference image, or
  `docs/mockups/S<nn>-<screen>.svg`, linked in the slice or in an EXPECT line naming the slice id,
  plus layout metrics and PASS/FAIL checks in its acceptance/playtest. Its writer must not guess layout.
- Popups (anything that opens over the screen and closes: result, pause, settings, shop, reward,
  toast) are prefabs, not Canvas nodes, when `docs/flows/00-project-overview.md` offers the
  `ui-popup` kit: `scene_objects` lists `assets/resources/prefab/ui/Popup<Name>.prefab`, `code`
  lists `assets/scripts/modules/popup/<name>/Popup<Name>.ts` + `assets/scripts/constant/PopupDefine.ts`.
  The first slice with a popup installs the kit (`scope.in` "install ui-popup kit", `code` lists
  `assets/scripts/common/uiManager.ts`) unless the project already has that file. HUD stays on Canvas.
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

The example below illustrates the fail/restart portion of S01. A generated S01 must also
include its core gameplay, HUD, responsive layout, visual target, and all their dependencies;
derive the full paths and change budget from that scope.

### Calibrating `change_budget` (measured, not guessed)

Budgets are **planning estimates** under `budget_mode: advisory` (SCOPE.md default): an overrun is
recorded as `budget_bump` and in `lessons.jsonl`, never gated, never trimmed to fit. Only
`tripo_credits` is a hard cap. `budget_mode: gate` (+ `budget_auto_bump_pct`) restores the old
tripwire for projects that want it.

Field data (11 projects, 2026-09): slices landed 1.05–2.05× over the authored `lines` (median
≈1.4×; e.g. 600→820, 650→1100, 300→445, 200→410) and every overrun was approved by the director,
while budget-only findings cost a fix round or a director gate each. Aim the estimate at the
*expected* diff so the number stays useful for sizing and splitting:

- Estimate the hand-authored lines per file you list in `paths.code` (new file ≈ 80–160, edit ≈
  20–60, unit test ≈ 40–80, a per-slice scenario/regression spec ≈ 200–300, smoke check ≈ 25 each,
  `docs/flows` ≈ 30), sum, **multiply by 1.5, round up to the next 50**. (cc-block-out S13–S18: the
  scenario spec alone was 250–330 lines a slice.)
- `lines` counts hand-authored code/config/tests/`docs/flows` only — never `.scene`/`.prefab`/
  `.index.json`/`.meta`/`docs/plans`/`docs/evidence`/`.cursor`, binary files, or generated output.
  State this in SCOPE.md as `budget_count: code_only` (template default). When a slice adds or runs
  a generator (a level importer, a fixture writer), list its output paths in SCOPE.md as
  `budget_exclude: <glob>, <glob>` (or mark them `linguist-generated` in `.gitattributes`): the
  counter reports them separately and never budgets them.
- `files` = every path you list + 2; `nodes` = authored nodes at max population + 20 %.
- If previous projects have `budget_bump` events in `.cursor/evidence/lessons.jsonl` (or
  `.cursor/evidence/tasks/*/stats.json`), use their median `to / from` (`diff_lines / max_lines`)
  ratio instead of 1.5. Bumps recorded before 2026-10-03 came from a counter that also counted
  `docs/evidence`, binary files and generated output; recount such a slice with
  `check-change-budget.sh --range <base>..<merge>` before trusting its ratio.
- Add `budget_mode: advisory` to SCOPE.md. A slice whose estimate is far beyond its siblings is a
  signal to split it — decide that here, not in review.

```markdown
---
id: S01
name: polished-playable
one_liner: Player can play the core loop with polished responsive UI and restart within one tap
size: L                            # L → fleet · S|M → single agent
depends_on: []
unlocks: [S02, S04]
needs_director_ok: false           # true when ≥ 3 ASSUMPTION rows or a SCOPE-level choice is open
recipe_refs: []                    # optional: pinned {id, revision, sha256, path}; absent = []
player_outcome: "After this slice the player can: die → see result → play again"
release_items: [RC-03, RC-05, RC-06, RC-07, RC-10, RC-17, RC-22]

scope:
  in:  [death detection, install ui-popup kit, PopupFail, restart flow, best-score persist]
  out: [revive by ad, leaderboard, share]

paths:                             # → PLAN.allowed_paths / allowed_scene_objects
  code: [assets/scripts/systems/GameStateSystem.ts, assets/scripts/modules/popup/fail/PopupFail.ts,
         assets/scripts/constant/PopupDefine.ts, assets/scripts/common/uiManager.ts]   # last = kit install
  art:  [assets/art/ui/fail/**]
  scene_objects: [assets/resources/prefab/ui/PopupFail.prefab, Canvas/HUD/ScoreLabel]

assets:                            # → art-manifest rows (stem, P0|P1); refs ASSET_MANIFEST.md
  2d:    [{stem: fail_panel_bg, p: P0}, {stem: btn_restart, p: P0}]
  3d:    []
  vfx:   [{stem: death_burst_particle, p: P0}]
  audio: [{stem: sfx_fail, p: P1}]

acceptance:                        # → PLAN.acceptance_criteria — observations, never logic
  - text: "Collision → ship breaks with particle burst, hit-stop ≈80 ms, light shake"
    evidence: OBSERVED (reference/<slug>/video/frames/t18.jpg)
  - text: "PopupFail slides in from bottom ≤250 ms ease-out, shows score + best"
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

**Port slices only — `rip_study`** (optional; omit outside rip-backed ports). Questions about
how the shipped game builds what this slice builds, answered from the rip before dispatch by a
per-slice study (`~/.agents/skills/rip-port-analysis/SKILL.md` § Slice study). Add a topic for
each presentation the slice mirrors: environment/lighting, models and their placement, UI
layout, VFX, camera, animation timing, audio wiring. `rip_study: []` means nothing to study; a
missing key lets the producer derive topics from scope and assets.

```yaml
rip_study:                         # kinds: environment|model|layout|vfx|animation|camera|audio|other
  - id: lockbox-open-vfx           # kebab-case, unique in the slice
    kind: vfx
    questions: ["How is the lockbox open glow built (emission, lifetime, size, blend) and when does it fire?"]
    source_dirs: [Assets/assetstobundle/features/bankheist]   # ExportedProject-relative; [] when unknown
```

Take `source_dirs` from `RIP_ASSET_MAP.md` rows or the inventory's `presentationIndex`; do not
open prefabs to author the contract. Acceptance still states observable targets; the study
supplies the parameters the writer copies or adapts.

For S01 specifically, acceptance and playtest must compare the running game against the S01
expected mock screen using the visual contract below. Include the mock screen's required UI
art/fonts in S01 `assets`; later slices cannot be prerequisites for a visually presentable S01.

Every slice that layers a sprite onto base art (wheels in arches, eyes in windows, items in slots)
or makes a look depend on data (ticket, level, fault, unlock) adds a `playtest` step that crops
the part at 2x and one case where the data says "no", and says what each must show (inspected
in the page, not extra screenshots).

### Worked example — a later slice (not S01)

A later slice builds on a presentable S01. It names only the files it adds or edits, owns its own
new screen, reuses S01 viewports as regression checks, and cites existing feel-table IDs. Copy the
shape, not the game. A real passing set: `/Users/wikz/Works/games/CocosCreator/cc-monopoly-go/slices/S03-chance-chain.md`.

```markdown
---
id: S05
name: settings-save
one_liner: Player can mute sound and resume the last level after a reload
size: M                            # new screen + 2 systems, no new 3D → single agent
depends_on: [S04]                  # must equal MILESTONES dag.S05
unlocks: [S06]                     # only ids whose dag entry contains S05 (release-polish may be omitted)
needs_director_ok: true            # 3 ASSUMPTION rows below
recipe_refs: []
player_outcome: "After this slice the player can: open Settings, mute, reload the page and continue the same level muted"
release_items: [RC-04, RC-09]      # RC rows this slice closes; release-polish takes the rest

scope:
  in:  [PopupSettings open/close, sound toggle, SaveSystem schema v1, resume last level, corrupt-save fallback]
  out: [cloud save, account, music volume slider, language picker]

paths:                             # only what S05 touches; S01/S03 files it edits are listed too
  code:
    - assets/scripts/systems/SaveSystem.ts        # new  ~120
    - assets/scripts/modules/popup/settings/PopupSettings.ts   # new  ~140 (extends PopupBase)
    - assets/scripts/constant/PopupDefine.ts      # edit ~1  (POPUP.SETTINGS)
    - assets/scripts/systems/AudioSystem.ts       # edit ~30
    - assets/scripts/ui/HudView.ts                # edit ~25 (gear button)
    - assets/scripts/GameController.ts            # edit ~40 (resume on boot)
    - tests/save-system.spec.ts                   # new  ~70
  art: [assets/art/ui/settings/**]
  scene_objects: [assets/resources/prefab/ui/PopupSettings.prefab, Canvas/HUD/GearButton]   # new popup → needs a visual target; kit installed in S01

assets:
  2d:    [{stem: settings_panel_bg, p: P0}, {stem: toggle_on, p: P0}, {stem: toggle_off, p: P0}, {stem: icon_gear, p: P0}]
  3d:    []
  vfx:   []
  audio: [{stem: sfx_toggle, p: P1}]

acceptance:
  - text: "Visual target docs/mockups/S05-settings.svg (EXPECT § S05 Settings): panel 560×640 centred at 720×1280, 48 px side margins, toggle rows 96 px tall, title 36 px, labels ≥ 24 px"
    evidence: ASSUMPTION
  - text: "Gear (HUD top-right, inside safe area) → panel scales 0.9→1 in 180 ms ease-out; tap outside or ✕ closes; gameplay paused while open"
    evidence: OBSERVED (reference/<slug>/iphone/05.jpg)
  - text: "Sound off → no SFX or music until turned on; setting survives reload"
    evidence: GIVEN (IDEA §6)
  - text: "Reload mid-level → same level index and score as the last completed move; no replayed rewards"
    evidence: ASSUMPTION
  - text: "Empty, junk-JSON or older-schema localStorage → fresh save, no console error, S01 flow unchanged"
    evidence: ASSUMPTION

feel_rows: [tap, panel_open]       # IDs from the EXPECT feel table; add panel_open there if missing

runtime_checks:
  - Same S01 viewport matrix: V1 720×1280 insets 0; V2 320×568 insets 0; V3 390×844 insets 47,0,34,0
  - FAIL panel clipped at any viewport, toggle target < 44×44 CSS px, text < 14 CSS px, gear under the notch
  - localStorage key `<slug>.save.v1` only; no other keys written
  - zero console errors across open/close ×10 and reload ×3

playtest:
  - Open Settings at V1/V2/V3; capture docs/evidence/S05/V1-settings.png, V2-settings.png, V3-settings.png; compare V1 with docs/mockups/S05-settings.svg
  - Mute → play 3 moves → reload → confirm muted and same level/score
  - Inject `{"broken":` into localStorage → reload → fresh game, no error
  - Regression: rerun the S01 core loop playtest at V1

change_budget: {files: 9, lines: 650, nodes: 12, assets: 5, tripo_credits: 0}
# lines: 120+140+30+25+40+70 = 425 × 1.5 = 637.5 → 650 · files: 6 code + art dir + 2 = 9
# nodes: panel, title, close, 2 rows × (label, toggle, bg) = 9 + gear = 10 × 1.2 → 12 · assets: 4 × 2d + 1 audio = 5
risks:
  - "Resume granularity (last move vs level start) is ASSUMPTION — director to confirm"
---

## Why here
S03 adds levels, so there is now progress worth saving (HOW_TO H-12); S04 adds the audio this slice mutes.

## Accepted deviations
| Reference | Allowed deviation | Reason |
|-----------|-------------------|--------|
| iphone/05.jpg shows a language row | omitted | out of v1 scope (SCOPE.md) |
```

Self-check for any later slice before you save it:

1. `depends_on` equals its `dag` entry; every `unlocks` id lists this slice in its own `dag` entry.
2. Every `paths.code` file has a line estimate; `lines` = sum × 1.5 rounded up to 50.
3. A new `Panel/Screen/Menu/Popup/Dialog/Overlay/Modal` or `prefab/ui/Popup*` in `scene_objects` → a
   visual target file exists, is cited in acceptance, and playtest names its capture paths. With the
   `ui-popup` kit offered, popups are `prefab/ui/Popup*` (never `Canvas/.../*Popup|Dialog|Modal`) and
   the kit is installed by this or an earlier slice (`validate-contracts`: `popup_kit_missing`,
   `popup_outside_kit`).
4. Every `feel_rows` ID appears in the first column of the EXPECT feel table.
5. Count ASSUMPTION rows: ≥ 3 → `needs_director_ok: true` and each open choice is in `risks`.
6. `release_items` are real `RC-nn` rows whose `closed_by` is this slice.
7. Every coordinate, rect or node path (mocks included) was checked against the real scene/prefabs/layout config: sibling order, existing rects, hitbox floors, row pitch.
8. A slice adding a core-loop phase lists the existing smoke checks / unit tests it changes or must keep passing in `paths.code`, with the reason.
9. No deploy, tag or push step anywhere in the slice (`slice_performs_ship`).

## S01 visual target and review contract

When selecting reusable recipes, read only matching files from cocos-playbook and put the
resolved id/revision/SHA-256/path in `recipe_refs`. The slice's existing acceptance/playtest
fields carry only relevant checks. Recipes never add mechanics, widen paths, or count as
runtime evidence. For older projects this field remains optional.

Put this contract in `EXPECT_GAMEPLAY_VISUAL.md`; carry its concrete checks into S01's existing
`acceptance`, `runtime_checks`, and `playtest` fields (no new producer schema fields required).

- **Visual target:** link an exact existing gameplay screenshot/frame and identify its crop and
  reference dimensions. Annotate it with a region/key table in the document. If no suitable image
  exists, author `docs/mockups/S01-ingame.svg` as a static documentation mock with the intended
  palette, typography, gameplay composition, HUD, and controls. Open/render it for visual inspection.
  A text description alone does not satisfy this requirement. The SVG is a design artifact, not
  gameplay code or a production art asset; label proposed choices GIVEN/ASSUMPTION, never OBSERVED.
- **Layout specification:** record major regions' bounds/anchors, spacing, font sizes, colors, and
  the representative gameplay state. Define scaling/reflow/letterboxing and minimum legibility;
  distinguish fixed HUD/control regions from the scalable playfield. Record permitted differences
  from the target in the accepted-deviation table before implementation review.
- **Viewport matrix:** name exact width × height in CSS pixels and safe-area insets for the design
  viewport plus at least two different aspect ratios relevant to the supported orientation. Include
  a short/wide case and a tall/narrow case, with a notched safe-area case. State how unsupported
  orientation is handled; do not implicitly add support for another orientation.
- **Evidence:** prescribe captures of representative gameplay and fail/result UI at every matrix
  entry, plus comparison with the visual target at the design viewport. Name an evidence directory
  and capture filenames in `playtest` (use the project's evidence convention; otherwise
  `docs/evidence/S01/`). These are required outputs of implementation review, not of brief authoring.
- **Pass/fail:** fail S01 for clipping, overlapping UI, cropped essential gameplay, unreadable text,
  controls outside the safe area, touch targets below 44 × 44 CSS pixels, placeholder/debug UI, or
  unexplained differences in composition, typography, palette, or controls. Specify project-specific
  measurable layout tolerances and minimum text sizes; avoid a generic "looks close" criterion.
  The reviewer records PASS/FAIL per viewport with capture paths and any accepted deviations.

The brief author authors and inspects the visual target and writes the review contract. The implementation
reviewer executes the runtime matrix; the brief author must not claim runtime checks have already passed.

## RELEASE_CHECKLIST.md

Rows are product-level "done" criteria. Each row names the slice expected to close it; the
release-polish slice sweeps whatever is left. Reviewer of the release slice runs **all** rows.
Rows assigned to S01 below cover all screens and interactions in the S01 playable. Later slices
must add checklist coverage for their new screens and interactions; the final review also reruns
the S01 rows as regression checks. Do not defer initial S01 compliance to release-polish.

```markdown
# RELEASE CHECKLIST — <game>

| id | area | check (observation) | closed_by | how to verify |
|----|------|---------------------|-----------|---------------|
| RC-01 | lifecycle | Cold load shows loading/splash with progress; no white flash; no error if an asset is slow | S08 | throttle network in preview, reload |
| RC-02 | lifecycle | Tab hidden → game + audio pause; return → no time/frame jump | S06 | switch tab 10 s |
| RC-03 | lifecycle | Fail → result → restart in 1 tap; no dead-end screen | S01 | die ×3 |
| RC-04 | lifecycle | Reload mid-run keeps a valid save; corrupted/empty localStorage does not crash | S06 | clear storage, inject junk JSON |
| RC-05 | layout | S01 screens pass the viewport matrix; safe areas respected; unsupported orientation handled as specified | S01 | capture each viewport and safe-area case |
| RC-06 | input | S01 touch targets ≥ 44 × 44 CSS px; no double-fire; browser scroll/zoom/long-press blocked during play | S01 | rapid taps, pinch, measure rendered targets |
| RC-07 | input | Mouse + touch both work in S01 | S01 | desktop + device |
| RC-08 | ux | First-run hint shown once, persisted | S07 | fresh storage, reload |
| RC-09 | ux | Sound on/off setting, remembered | S06 | toggle, reload |
| RC-10 | feel | Every S01 interaction's EXPECT feel/VFX row implemented and reviewed | S01 | reviewer tick-list |
| RC-11 | audio | SFX on every interaction + 1 music loop; unlock after first gesture (iOS) | S05 | play on iOS Safari |
| RC-12 | perf | fps ≥ 55 on a mid device across 3 min; no per-frame GC spikes (pools for spawned objects) | S08 | profiler / smoke fps probe |
| RC-13 | perf | Final release build size measured and optimized once (textures atlased/compressed; no fixed size cap); no leak after restart ×20 (node count stable) | S08 | build size before/after, node count probe |
| RC-14 | quality | Zero console.error/warn during the full playtest script; tsc strict + lint clean | S08 | smoke-test |
| RC-15 | quality | No debug code, cheats, logs, test scenes | S08 | grep |
| RC-16 | branding | Icon 1024 + favicon + apple-touch-icon; title / meta / OG image; PWA manifest (optional) | S08 | view source |
| RC-17 | assets | S01 has no placeholder/debug UI or placeholder art/text; fonts with fallback; strings not hardcoded in scene | S01 | walkthrough and asset check |
| RC-18 | assets | Every asset has its .meta pair; no orphan assets | S08 | integrator check |
| RC-19 | ship | `build/build.sh --clean` release build serves without 404s | S08 | `--serve` |
| RC-20 | ship | Preview deploy passes smoke test on the deployed URL; then prod if `release.deploy: prod` | S08 | ship skill |
| RC-21 | ship | git tag `v1.0.0`; FOLLOWUPS.md trimmed to a v1.1 backlog | S08 | git tag |
| RC-22 | visual | S01 matches its visual target and layout tolerances, with only documented accepted deviations | S01 | saved target comparison and PASS/FAIL per viewport |
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
`RELEASE_CHECKLIST.md all rows PASS`, fps floor, one measure-and-optimize pass on the final release
build (no numeric size cap), localStorage schema check.

**Build size is never a cap.** No contract (HOW_TO, RELEASE_CHECKLIST, slice) sets a MiB/MB
threshold, and no slice other than release-polish carries a size invariant, acceptance row,
runtime check or `build_checks` entry. Mid-release slices never trim art or levels to save bytes;
the final build is optimized once, here.
The slice never deploys, tags or pushes: write "ship handed to producer Step 3". After APPROVED the producer runs the `ship` skill per `release.deploy`.
