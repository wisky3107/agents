---
name: game-ui-kit
description: Generate a game UI kit (buttons, panels, cards, ribbons, tabs, bars, icons, game pieces, art) from a brief, routing each asset to the art backend that fits the input — Codex, Antigravity (agy), ChatGPT or procedural — with a per-prompt override, then keying, trimming, nine-slice borders and a manifest. Use when the user wants a UI kit, UI assets or a set of game buttons/icons from a brief, GAME_BRIEF / ASSET_MANIFEST, screenshots, a mood board or a Figma flow ("gen bộ UI", "tạo UI kit", "gen button/icon cho game"), optionally placed into Figma.
---

# Game UI Kit

One brief in, one **kit** out: `<dir>/kit/*.png` + `manifest.json` (sizes, alpha, nine-slice
borders, backend per row) + `sheet.png`. Every row of the kit names its **backend**; the kit is
the single source of truth the scripts read.

```bash
K=~/.agents/skills/game-ui-kit/scripts
node $K/kit.mjs check                 # backend availability
node $K/kit.mjs jobs  --kit kit.json  # style.txt, codex-jobs.json, agy/BRIEF.md, todo.json
node $K/kit.mjs agy   --kit kit.json  # agy rows in an Orca terminal worker
node $K/kit.mjs post  --kit kit.json  # kit/*.png + manifest.json
node $K/kit.mjs sheet --kit kit.json  # sheet.png
node $K/figma-kit.mjs --manifest <dir>/manifest.json   # optional: kit board in the open Figma file
```

Three ways in, same pipeline:

| Caller | Rows come from | Files land in | Extra |
|---|---|---|---|
| standalone (a brief) | you write `kit.json` (§1–3) | `<dir>/kit/` | — |
| `figma-game-clone` (new art, wireframe → hi-fi) | you write `kit.json`, `ref` = exported Figma art | `post --to <game>/assets --notes ASSET_MANIFEST.md` | usage-notes block with nine-slice borders above the generated table |
| fleet `art-2d` (ui-kit route) | `kit.mjs from-manifest` over the slice's art manifest | `post --to-project .` (exact row `size`) | `gate` → `2d-check.md` `ART2D` + row `verify`; integrator runs `meta` |

## 1. Read the brief

Sources, any mix: text in the prompt, `GAME_BRIEF.md` / `ASSET_MANIFEST.md` / `EXPECT_GAMEPLAY_VISUAL.md`
in a project, screenshots or a mood board, a Figma file or flow already built (read its screens
for what UI they use), a store pack from `store-game-clone`.

From it settle:
- **kit name** (kebab) and **dir** (absolute; default `<project>/assets/ui-kit/` inside a game
  project, else `~/Works/ui-kits/<name>/`).
- **art bible** → `kit.style`: genre, rendering style (glossy soft-3D, flat vector, painted,
  pixel…), palette as hex, light and rim, mood. One paragraph; every prompt carries it.
- **rows**: what the screens need, picked from [reference/catalog.md](reference/catalog.md)
  (names, aspects, alpha, slice insets, subject wording). Variant sets share one subject sentence.

Completion criterion: every UI element the brief's screens show maps to a row or to a row it
reuses (a label on `btn-primary` is not a new row), and `kit.style` has the palette in hex.

## 2. Pick the backend

**Override first.** Words in the user's prompt set the backend and beat every rule below:

| user says | backend |
|---|---|
| `art_backend=<x>`, `backend <x>`, `by <x>`, `dùng <x>`, `bằng <x>` | that backend for all rows |
| `<category> by <x>` / `<category> dùng <x>` ("icons by agy", "button dùng codex") | that backend for those rows only |
| `agy`, `antigravity`, `gemini` | `agy` |
| `codex`, `omniroute image` | `codex` |
| `chatgpt`, `gpt image`, `images 2.5` | `gpt-image-gen` |
| `procedural`, `vẽ bằng code`, `pillow`, `svg` | `procedural` |

**Otherwise auto, by input** (first match wins per row):

1. `hero` rows (logo, splash / key art, store image, a background the director calls final) →
   `gpt-image-gen`, the hero lane of `codex-image-gen`'s routing table.
2. The brief brings reference images (screenshots, mood board, an existing kit) → `codex` with
   `ref` set to the closest reference, so each asset is an edit that keeps that look.
3. The style is flat / minimal / vector / material, or the row is a geometric primitive whose
   pixels must be exact (track, plain panel, toggle, slider, progress bar) → `procedural`.
4. Everything else (glossy, 3D, painted, casual) → `codex`.

What each backend is good at (measured 2026-10-11 on the Melody Tiles kit):

| backend | strength | cost | alpha |
|---|---|---|---|
| `codex` | fast, 6 in parallel (12 images ≈ 1 min), ref edits hold a design across a set | OmniRoute codex accounts | native (`alpha: true`) |
| `agy` | strong glossy soft-3D game UI and icons, its own image tool | sequential, 20 images ≈ 25 min, per-account image quota | none: flat key backdrop, keyed in `post` |
| `gpt-image-gen` | sharpest detail, hero art | one browser chat per image | ask for the key backdrop, set `key` on the row |
| `procedural` | exact pixels, perfect nine-slice, zero cost | a script you write | native |

**Availability.** Run `kit.mjs check`. When a chosen backend is down, fall back once and say so
in the report: `agy` (quota / exit 4) → `codex` for the missing rows; `codex` (exit 2) → `agy`;
`gpt-image-gen` unavailable → `codex` with a note that hero rows are not final. An explicit
override that is down: tell the user and ask before falling back.

Completion criterion: every row in `kit.json` has a concrete `backend` (no `auto`), and each
override or fallback is written down for the report.

## 3. Write kit.json

```json
{
  "name": "melody-tiles-ui",
  "dir": "/abs/path/ui-kit",
  "style": "Casual mobile rhythm-game UI, glossy soft-3D … Palette: cyan #3FE0FF, pink #FF4FD8, …",
  "agyKey": "green",
  "rows": [
    { "name": "btn-primary", "cat": "button", "aspect": "wide 3:1", "backend": "codex",
      "subject": "empty pill button, cyan-to-blue gradient, glossy, thin light rim, no text", "slice": [0.22, 0, 0.22, 0] },
    { "name": "ic-gem", "cat": "icon", "aspect": "square 1:1", "backend": "agy", "subject": "cyan faceted diamond gem" },
    { "name": "bg-home", "cat": "background", "aspect": "portrait 9:16", "backend": "codex", "alpha": false,
      "subject": "abstract night concert hall, soft bokeh, low detail" }
  ]
}
```

**Hybrid rows** (image-gen base + a procedural step): when a row needs generated art plus exact
geometry the generator cannot hold (a badge composed onto a fixed plate, text-safe insets,
pixel-exact caps), generate the base, then run a recorded step in `gen_2d.py` that reads
`kit/<name>.png` and writes the raw again; set `"compose": "gen_2d.py:<function>"` on the row so
`gate` reports `image-gen base + procedural …` as a planned method, not a deviation the lane
invents (S18 did this for 4 route rows and 12 chrome rows without a rule).

Fields set by `from-manifest` (fleet): `out` (project-relative target), `size` (exact px),
`src` (row key for `verify`), `slicePx` (from "9-slice 24px" notes), `method`; `fit`
(`stretch` | `contain` | `cover`) overrides how `post --to-project` reaches `size`.

Fields: `alpha` defaults to true (set `false` for art / backgrounds); `slice` only on stretchable
chrome; `ref` (absolute path) for codex edits; `key` (`magenta` | `green` | `none`) forces the
keying of one row; `max` caps the long side. `agyKey` is optional: `jobs` picks the key colour
farthest from the palette (green when the palette has pink / magenta, else magenta).

Completion criterion: `kit.mjs jobs` exits 0 (it validates the kit; exit 64 lists every problem).

## 4. Generate

`kit.mjs jobs` writes the inputs for every backend. Then, for each backend in use:

- **codex** → `node ~/.agents/skills/codex-image-gen/scripts/codex-image.mjs gen --jobs <dir>/codex-jobs.json --prefix-file <dir>/style.txt --report <dir>/codex-report.json`
  (the `codex-image-gen` skill's rules apply: retries, `--overwrite` for re-runs).
- **agy** → `kit.mjs agy --kit kit.json`. It opens an Orca terminal running `agy` in `<dir>/agy`,
  accepts the folder trust prompt, sends the brief, approves agy's permission prompts with
  "always allow in this conversation", and exits when every file exists or `DONE.md` appears.
  Exit 4 = quota → fall back (§2). Exit 3 = stalled 12 min or timed out → read the terminal
  (`orca terminal read --terminal <handle>`), nudge with `orca terminal send`, or fall back.
- **gpt-image-gen** → for each `todo.json` row of that backend, run the `orca-gpt-image-gen`
  skill with `style.txt` + the row prompt and save to the row's `out`. Alpha rows: ask for a flat
  `#FF00FF` backdrop and set `"key": "magenta"` on the row. The ChatGPT lane drives Orca's
  embedded browser, which barely renders while Orca is not the visible window (S18: ~3 frames
  per 2 s, clicks ignored). Check first: if the page stalls, ask the director once to bring
  Orca to the front; if that is not possible, fall back to codex for those rows and mark them
  `hero not final` in the report.
- **procedural** → write `<dir>/gen_ui.py` (Pillow, RGBA, drawn at 2× then saved) that writes
  each `todo.json` procedural row to its `out`, and run it with `python3 -I`.

Run backends in parallel where they are independent (agy in its terminal while codex runs).

Completion criterion: every row has a raw file (`raw/<name>.png`, or `agy/raw/<name>.png` for
agy), or is listed as failed with its error.

## 5. Post, look, fix

`kit.mjs post` keys agy rows (flood-fill from the border plus pure-key holes, so artwork in a
colour near the key survives), trims every row to its content, caps the size by category, and
writes `manifest.json` with `borderPx` for every sliced row. Exit 1 lists rows with a missing raw
or an alpha row under 1% transparent.

Then `kit.mjs sheet` and open `sheet.png`, plus every PNG that looks off at sheet size. Check:
- **set consistency**: one palette, one rim / outline weight, one light direction, variants
  share a shape.
- **empty chrome**: no text, letters or stray icons on buttons, panels, cards, ribbons.
- **clean alpha**: no backdrop fringe, no holes eaten into the artwork, enclosed gaps cleared.
- **slice-safe**: decoration sits inside the caps, the middle band stretches without visible
  repeats (a sliced row whose centre has a motif gets `slice` removed or is regenerated).

`post` also checks chrome faces: a button / panel / card / ribbon / tab / bar row must have an
opaque centre (≥ 97 % of the centre box) unless its subject says glass / translucent / frosted or
`"face": "translucent"`; every chrome prompt carries a solid-face clause. Every alpha row is
defringed (semi-transparent edge pixels take the colour of the opaque pixels beside them).

`post` also fails an alpha row whose subject touches the generated canvas edge on more than
0.5 % of the border (likely cropped by the generator; S20 loading hero). Regenerate it (every
prompt asks for a clear margin), set `"allowEdge": true` when the design really bleeds, and use
`"pad": <px>` when the game needs transparent room around the trimmed subject.

**Hero grade post-step.** ChatGPT may ignore hex values in the prompt (S20: sky R 159 vs target
184 ± 12, twice). Give the hero row `"grade": { "target": "#B8E2F7", "band": [0, 0.35], "hue":
[180, 240], "minSat": 0.08, "tol": 12 }`: `post` moves the mean colour of the masked band (opaque
pixels in that vertical range, in that hue range) to the target with per-channel gain, feathers
only the band edge, re-measures, fails outside `tol`, and `gate` records it as a deviation. The
title or character over the band stays untouched. Use it instead of a third regeneration.

Regenerate only failing rows (codex: a jobs file with those rows and `--overwrite`; agy: delete
the bad files and re-run `kit.mjs agy`, which sends the same brief), at most 2 rounds, then `post`
again. At the cap, take a fallback instead of stopping, and the gate records it as a deviation:
- face FAIL → first `"flattenFace": true` on the row and `post` again: semi-transparent pixels
  inside the outline turn opaque, coloured by the face around them (the generated look stays).
  Still wrong (blotchy colour) → `kit.mjs recolour --kit kit.json --row <failing> --from <passing
  sibling> --color '#hex'` (same shape, rim and shading, new colour; raw kept as `.generated.png`).
- halo / fringe still visible → `"defringe": <px>` on the row (erodes the alpha edge), `post` again.

Completion criterion: every row passes the four checks, or is reported as failed with the reason.

## 6. Fleet route (art-2d)

The art-2d worker prompt ("art-2d / ui-kit route" in cocos-asset-gen's worker-prompts-art.md)
runs: `from-manifest --art-manifest <art_paths>/manifest.json --art-backend <locked> --dir
evidence/art/2d/ui-kit` → write `kit.style` (it stays `TODO` and `jobs` refuses until you do)
→ §4 generate (agy with `--skip-permissions`; procedural script at `evidence/art/2d/gen_2d.py`)
→ `post --to-project .` → `sheet` + look → `gate --look PASS|FAIL:<why>`. `from-manifest` maps
the lock (`antigravity`→agy, `codex-image`→codex, `gpt-image-gen`→codex with hero rows on
ChatGPT; `cursor` has no kit route) and lists sprite-sheet / aperture rows as `manual` for
the normal art-2d route. After import the integrator runs `kit.mjs meta --kit
evidence/art/2d/ui-kit/kit.json --project .` to write `borderPx` into the sprite-frame `.meta`.

## 7. Figma (optional)

When the user wants the kit in Figma or the brief came from a Figma file:
`node $K/figma-kit.mjs --manifest <dir>/manifest.json [--file-key <key>]`. It builds a
"UI Kit · <name>" board and a hidden "Image library · <name>" frame whose rectangles carry each
image by row name, so screen renderers can fill nodes from it (nine-slice with `borderPx`).
The Figma tab must be open in Orca's browser; reload it first if `figma` is missing.

## 8. Report

- the art bible, the backend per row, every override and fallback with its reason
- `sheet.png` and `manifest.json` as clickable paths; each failed row with its error
- for agy runs, the terminal handle (it stays open: close it or reuse it for regenerations)
