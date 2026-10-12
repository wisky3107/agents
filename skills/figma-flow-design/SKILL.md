---
name: figma-flow-design
description: Design a game's screen flow in Figma for approval before any code — hi-fi screens from a spec, prototype hotspots, labelled flow arrows and re-skin variants side by side, rendered into the Figma tab open in Orca (Plugin API, no token). Use when the user wants a flow / views / screen map / mockups of a game in Figma ("tạo flow views trên figma", "dựng màn hình game cho mình duyệt", "làm hi-fi từ wireframe"), or a second look (v2) of an existing flow. Its output feeds figma-game-clone.
---

# Figma Flow Design

Spec in, board out: a folder of small spec modules renders into the open Figma file as hi-fi
screens, prototype reactions, flow arrows with labels and a header. Rendering is idempotent
(screens are replaced by name), so the loop is **edit spec → render → look**.

```bash
R=~/.agents/skills/figma-flow-design/scripts/render.mjs     # all commands take --flow <dir>
node $R upload <kit dir>/kit/*.png <art>/*.jpg   # images → "Image library · <flow>"
node $R screens [spec/02-play.mjs]               # (re)build screens
node $R links                                    # reactions + arrows + header
node $R board shots/board.png 2400               # look at it
node $R screens --variant v2 && node $R links --variant v2   # re-skin beside v1
```

Spec format, node types, fills, nine-slice, link routing and variants:
[reference/spec-dsl.md](reference/spec-dsl.md). Worked example: `reference/example/`
(Melody Tiles, 10 screens, v2 variant). It references images by name; upload the kit first.

## 1. Settle the flow

From the brief (or a wireframe Figma): the screen list, what each screen holds, and every
transition with its trigger. Group screens on the board: main loop on row 0 left→right,
branches and overlays on row 1 under the screen they leave from, meta screens (shop,
settings, daily) under home. Name the game generically when it is "like" a real one, and use
public-domain content (no real brands, logos or copyrighted song titles).

Completion criterion: a table of screens (id, name, col, row) and links (from, hotspot, to,
kind) that covers every button the screens will show.

## 2. Art first

Run `game-ui-kit` for the art the screens need (backgrounds, covers, illustrations, and for a
re-skin the chrome kit), then `node $R upload` its files. Vector-only screens can skip this.

## 3. Write the flow folder

`flow.json` (`name`, `title`, `subtitle`, `fileKey` from the Figma URL, `page`, `fonts`,
`layout`), `spec/_kit.mjs` (palette + shared components, copy the example's and restyle),
then `spec/NN-*.mjs` with **two or three screens per file**. Small files keep each turn short:
one huge spec written in one response is the pattern that stalls the model stream.

Completion criterion: every screen and link of §1 is in a spec file; every hotspot node has a
kebab `n`.

## 4. Render and look

`screens` → `shot` or `board` → Read the PNG → fix → re-render only the changed spec file.
Then `links` and `board`. Check: text never touches or overlaps (pills, rows, tags), contrast
on image backgrounds (add `dim`), nothing important sits under an overlay, arrows and labels do
not cross labels (`lt`, `dy`), the `missing` list from `links` is empty.

Completion criterion: `links` prints `missing: []` and the board passes the checks above.

## 5. Variants (optional)

For a second look (another kit, another art direction) write `variants/<name>.mjs`
(spec-dsl.md §Variant) and render with `--variant <name>`. It lands below v1 with its own
arrows, header and prototype flow; v1 stays as it is.

## 6. Hand-off

Report the board PNG(s), the Figma page, the prototype flow names and the hotspot count.
When the director approves, `figma-game-clone` takes the same Figma link: its rename step can
be skipped (names are already kebab), and the kit images are taken from the kit, not
re-exported (`draft-jobs` skips `Image library…` hashes).

## Notes

- Before the first render, check the Figma file is the one to write: a designer's shared file
  gets a new page (`flow.json` `page`) rather than edits to theirs.
- `orca eval` carries ≤ ~1 MB per call: upload images one per call (the command does), keep
  JPEG backgrounds ≈ 200–400 KB.
- `board` moves nodes into a temporary frame to export and puts them back at their absolute
  positions; if a run is interrupted, re-run `screens` and `links` to restore the layout.
