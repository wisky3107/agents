# game-ui-kit integration — plan (2026-10-11)

Goal: one way to make 2D UI art across the game workflows. `game-ui-kit` becomes the generator
behind `figma-game-clone` (new art), the fleet's `art-2d` Task (manifest rows), and a new
`figma-flow-design` skill (design approval in Figma before code). No fourth manifest schema.

Source session: Melody Tiles Figma flow (2026-10-10/11). Scenarios 1–5 agreed with the director.

## Phase 1 — figma-game-clone uses the kit (scenarios 2, 3)

| # | Change | Where |
|---|---|---|
| 1.1 | `kit.mjs post --to <assets dir> [--notes <ASSET_MANIFEST.md>]`: copy kit files to figma-game-clone folders (`ui/common/`, `icons/`, `backgrounds/`, `vfx/`, row `out` wins) and write a `<!-- ui-kit:<name> -->` usage-notes block (file, size, 9-slice borders, backend) **above** the generated `figma-assets` table, which `figma.mjs manifest` keeps | game-ui-kit/scripts/kit.mjs |
| 1.2 | `figma.mjs draft-jobs` skips image hashes owned by any `Image library*` frame and prints them as "take from the kit" | figma-game-clone/scripts/figma.mjs |
| 1.3 | Step 5 rule (kit images are never re-exported) + Step 7 / constants: new art → `game-ui-kit` with `ref` = exported Figma art | figma-game-clone/SKILL.md |
| 1.4 | `figma-kit.mjs` reuses figma.mjs's connect logic (exported `connectFigma`) | both scripts |

Done when: smoke kit `post --to` lands files + notes block; `figma.mjs manifest` keeps the block;
`draft-jobs` on the Melody file reports the kit hashes as skipped.

## Phase 2 — fleet `art-2d` runs the kit (scenarios 1, 5)

| # | Change | Where |
|---|---|---|
| 2.1 | `kit.mjs from-manifest --art-manifest <art_paths/manifest.json> --art-backend <locked> [--override cat=backend,…]` → `kit.json` (rows from 2D `image-gen`/`procedural` rows; `tier:hero` → gpt-image-gen; cat + slice from name/notes; `style` left `TODO` so `jobs` refuses until the art bible is written); working dir `evidence/art/2d/ui-kit/` | kit.mjs |
| 2.2 | `kit.mjs post --to-project <art_paths>`: exact row `size` (chrome stretched, icons contained + padded, art cover-cropped), `borderPx` rescaled | kit.mjs |
| 2.3 | `kit.mjs gate --art-manifest … --look PASS|FAIL:<why>`: fleet-format `evidence/art/2d/2d-check.md` round (measured lines by script, look lines from the worker's attestation after reading `sheet.png`), `ART2D:` line, row `verify` with `tool` | kit.mjs |
| 2.4 | `kit.mjs meta --project <dir>`: after import, write `borderPx` into the sprite-frame `.meta` (`borderTop/Bottom/Left/Right`), warn when caps exceed half the image | kit.mjs |
| 2.5 | `kit.mjs agy --skip-permissions` → `agy --dangerously-skip-permissions` (fleet art workers' convention) | kit.mjs |
| 2.6 | art-2d prompt: "UI kit route" for any non-cursor backend when the slice has ≥ 5 UI chrome/icon rows; integrate prompt: run `kit meta` after import | cocos-asset-gen/reference/worker-prompts-art.md, cocos-asset-gen/SKILL.md, cocos-orca-fleet/reference/worker-prompts.md |

Done when: a synthetic art manifest → from-manifest → post --to-project → gate (ART2D: PASS,
verify set) → meta patches a real Cocos sprite `.meta`.

## Phase 3 — figma-flow-design skill (scenarios 3, 4)

Package the Melody Tiles renderer: `flow.json` config (file key, page, frame size, gaps, title),
spec modules (`spec/NN-*.mjs` + `_kit.mjs` helpers), `render.mjs` (screens, links, board, shot,
upload, `--variant <name>` mappers for v2-style re-skins), `page.js` (Plugin API side, nine-slice,
image fills from any `Image library*` frame), Melody spec as the worked example. Output feeds
`figma-game-clone` (kebab layer names → rename step skipped; kit images not re-exported).

Done when: the example renders on a scratch page of the Melody file (then the page is removed)
with screens, reactions and arrows, and a variant renders beside it.

## Not in scope

Committing (director asks separately), pilot on a live slice (next step: cat-dash or a new UI-heavy
slice), Cocos prefab generation from layout JSON.

## Status (2026-10-11, end of session) — implemented, not committed

| Phase | Result |
|---|---|
| 1 | `post --to/--notes` lands files + notes block, `figma.mjs manifest` keeps it; `draft-jobs` on the Melody file skipped 31 kit images (0 re-export jobs); `figma-kit` reuses `connectFigma` |
| 2 | synthetic fleet manifest (dict `{2d,3d}`, hero, procedural, sprite sheet, acquire): from-manifest mapped all correctly → post --to-project exact sizes → gate wrote fleet-format round `ART2D: PASS` + `verify` on 3 rows only → meta patched a real sprite-frame `.meta` (L106 R106) |
| 3 | `figma-flow-design` rendered the Melody example (v1 + v2, 28 hotspots / 14 arrows each) on a scratch page, page removed afterwards |

Tests: `game-ui-kit/tests/kit.test.mjs` 5/5, `figma-game-clone/tests/figma.test.mjs` 8/8.
Not yet exercised: the ui-kit route inside a live fleet slice (worker following the prompt), the
gpt-image-gen branch, codex `ref` edits through the kit. Next: pilot on a UI-heavy slice.
