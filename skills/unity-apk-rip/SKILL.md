---
name: unity-apk-rip
description: >-
  Rip a Unity Android APK/XAPK into a case-study pack with AssetRipper: extract the archive,
  export the Unity project + primary content headlessly, de-atlas SpriteAtlas pages into named
  PNGs (skip font/SDF atlases; copy .ttf/.otf/.fnt to fonts/), filter in-game-only images, build
  per-file asset catalogs + agent guides (IMAGES_INGAME_GUIDE, MESHES_GUIDE), author GAME / 2D art /
  3D art / GAMEPLAY briefs, and write an output/README.md folder guide. Use when the user gives a
  .apk/.xapk path and asks to rip assets, extract game assets, make a case study, filter used
  images, de-atlas sprites, or explain how to use a ripped output folder.
disable-model-invocation: true
---

# Unity APK Rip → case-study pack

Input: one `.apk` or `.xapk` the user owns / is allowed to analyze.
Output: `<workdir>/output/` with `images/` (de-atlased sprites), `images_ingame/`, `fonts/`,
`meshes/`, `levels/`, `briefs/`, per-file catalogs (`*_catalog.json`), agent guides (`*_GUIDE.md`),
`de_atlas_*.json`, `README.md`, `manifest.json`.

The output manifest retains `source_paths` for the original UnityProject/PrimaryContent
trees and `code_availability: unassessed`. Report these paths with the output path. A clone
or port caller routes through `rip-port-analysis` before game-brief, even when invoked as
store-game-clone. Extraction alone does not launch a port. Preserve `ripped/` for the
mid-tier analyst; distinguish readable bodies from stubs before making logic claims.

## Constants

| Key | Value |
|-----|-------|
| AssetRipper binary | `/Users/wikz/Works/agent/assets-ripper/AssetRipper.GUI.Free` (override `ASSETRIPPER_BIN`) |
| Rip pipeline | `scripts/rip_apk.py` |
| In-game image filter | `scripts/filter_ingame_images.py` |
| Catalog + guide builder | `scripts/build_asset_catalogs.py` |
| De-atlas (Sprite → PNG) + fonts | `scripts/de_atlas_images.py` (Pillow; run with `.venv/bin/python`) |
| Skill venv | `~/.cursor/skills/unity-apk-rip/.venv` — auto-created by `rip_apk.py` from `requirements.txt`; manual: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| Brief templates | [reference/brief-templates.md](reference/brief-templates.md) |
| README template | [reference/output-readme-template.md](reference/output-readme-template.md) |
| Level heuristics | [reference/level-detection.md](reference/level-detection.md) |

All scripts are Python 3 and stdlib-only **except** `de_atlas_images.py` (Pillow, via the skill `.venv`).
Execute them — do not rewrite them inline.

## Progress checklist

```
Unity APK Rip:
- [ ] 0. Confirm input path exists; pick <workdir> (default: folder containing the apk)
- [ ] 1. rip_apk.py            → ripped/ + output/{images,fonts,meshes,levels} + manifest.json
      (images are de-atlased slices; font atlases skipped; .ttf/.otf/.fnt → fonts/)
- [ ] 2. Understand the game   → manifest, core scripts, 2–3 levels, asset name prefixes
- [ ] 3. filter_ingame_images  → --list-atlases, choose allow/deny, run → output/images_ingame/
- [ ] 4. build_asset_catalogs  → *_catalog.json + *_GUIDE.md; enrich JSON; --render-only
- [ ] 5. Briefs                → GAME, GAMEPLAY, 2D_ART (overview), 3D_ART (stub unless 3D-heavy)
- [ ] 6. output/README.md      → folder guide from template
- [ ] 7. Report table + open questions
```

Steps 3–4 are the "how do I use these assets" layer; steps 5–6 are the "what is this game" layer. Do both unless the user scopes the request.

## Step 1 — Run the pipeline

```bash
python3 ~/.cursor/skills/unity-apk-rip/scripts/rip_apk.py "<path/to/game.xapk>" \
  --workdir "<workdir>"            # optional, default = apk's folder
  # --port 27890                   # AssetRipper port
  # --levels-glob "Assets/**/Levels/*.json"  # force level source if heuristic misses
  # --skip-rip                     # reuse existing ripped/ (re-collect only)
```

Order of operations inside: unzip xapk → merge split `lib/` into `apk_base/` → AssetRipper headless
`LoadFolder` + `Export/UnityProject` + `Export/PrimaryContent` → **de-atlas** (`de_atlas_images.py`:
Sprite `m_Rect` × texture GUID → one PNG per sprite in `output/images/`; whole-texture sprites copy the
original file; font/SDF/BMF/digit atlas pages skipped; `.ttf/.otf/.fnt` → `output/fonts/`) → collect meshes
(content-hash dedupe, `__<hash8>` on collisions) → detect levels → `manifest.json`.

`manifest.json.images_method` is `de_atlas` normally. It is `plain_copy` (packed `sactx-*` pages kept whole,
no `de_atlas_*.json`) only when the venv/Pillow could not be set up or the export has no
`UnityProject/.../Assets/Sprite/` — fix the venv and rerun with `--skip-rip` before Step 3.

De-atlas outputs next to `images/`: `de_atlas_manifest.json` (counts, per-sprite `atlas`/`page`/`rect`,
skipped font pages) and `de_atlas_lookup.json` (`by_file` → family, `page_to_sprites`) — the filter and
catalog builder read the lookup automatically.

Exit ≠ 0 → read `<workdir>/assetripper.log`; rerun with `--skip-rip` if export already finished.

## Step 2 — Understand the game before writing

Read, in this order (skip what is missing):

- `output/manifest.json`
- `ripped/UnityProject/ExportedProject/Assets/Scripts/<GameAssembly>/` — look for `*Model`, `*Core`, `*Sim`, `*LevelDef`, `*StateType`, color/kind enums, `*Manager` (PrimaryContent has no scripts). If `assetripper.log` shows a Cpp2IL metadata failure, every script is a `Dummy class`: names/fields only
- Serialized MonoBehaviour `.asset` files under `ExportedProject/Assets/**` (e.g. `assetstobundle/`) — tuning/config values; `rip-port-analysis/scripts/inventory-rip.mjs` lists them
- 2–3 files in `output/levels/` + any config dir (`Resources/*config*`)
- `ls output/images | sed 's/[-_].*//' | sort | uniq -c | sort -rn | head` — prefixes reveal art kits
- `python3 $S/filter_ingame_images.py --workdir "<workdir>" --list-atlases` — sprite count per SpriteAtlas family (from `de_atlas_lookup.json`)
- `ls output/fonts` — font stack (TMP source faces)
- `ls output/meshes | head -60` — expect many uGUI prefab trees exported as GLB

Only state what is OBSERVED in files. Mark inferences `ASSUMPTION`.

## Step 3 — Filter in-game images

`output/images` is the **de-atlased** Texture dump (individual sprite PNGs + loose non-atlas
textures; no `sactx-*` pages; no SDF/BMF/digit font atlases). Fonts are in `output/fonts/`.
Build the board/HUD subset:

```bash
S=~/.cursor/skills/unity-apk-rip/scripts
# Pack ripped before de-atlas existed (manifest.images_method missing/plain_copy)? Rebuild images first:
# ~/.cursor/skills/unity-apk-rip/.venv/bin/python $S/de_atlas_images.py --workdir "<workdir>"
python3 $S/filter_ingame_images.py --workdir "<workdir>" --list-atlases      # 1. see atlas families (may be empty)
python3 $S/filter_ingame_images.py --workdir "<workdir>" \
  --seed-scene "_Games/Shared/Scenes/Main.unity" \   # path under Assets/ if not Assets/Scenes/
  --seed-keys "physicsfun,cannon,hud,booster" \
  --name-allow "tex_,SPR_Cannon,Tfx_,Icn_Block,BG_,Hand" \
  --name-deny "Meta_,LDR_,console,UnityWatermark" \
  --allow "gameplayatlas,ingameui" \                 # atlas games only
  --deny  "arena,journey,store,leaderboard"          # atlas games only
```

Method = GUID dependency walk from play scene + named prefabs ∪ atlas allowlist ∪ `--name-allow` − atlas denylist − `--name-deny`.
Uses `output/de_atlas_lookup.json` so allow/deny apply to **sprite membership** in a family (not page filenames).
Writes `output/images_ingame/`, `output/images_ingame_manifest.json` (keep/drop reason), updates `manifest.json`.
Defaults / atlas lists are Block Out–tuned; for other games pass `--allow/--deny`, `--name-allow/--name-deny`, `--seed-keys`, `--seed-scene` (bare name under `Assets/Scenes/` **or** relative path under `Assets/`), or `--config file.json`.

No packed atlases in the ripped project (e.g. Tiki Smash) → de-atlas mostly copies loose textures; rely on seeds + `--name-allow/--name-deny`. Expect ~25–50% of files kept.

## Step 4 — Per-file catalogs + agent guides

```bash
python3 $S/build_asset_catalogs.py --workdir "<workdir>" \
  --game "<Title> (<package>)" \
  --mesh-p0 "BlockPiece-,DoorPiece,Generator"     # board-geometry name stems seen in Step 2
```

Produces `images_ingame_catalog.json` + `IMAGES_INGAME_GUIDE.md`, `meshes_catalog.json` + `MESHES_GUIDE.md`.
Image heuristics classify per de-atlased sprite: `atlas_sprite` / `board_piece` (`maps_to` = SpriteAtlas
family from `de_atlas_lookup.json`), `color_kit`, `icon`, `fx`, `ui_primitive`, `leak_meta`, `font_atlas_skip`
(P3 — fonts live in `fonts/`), legacy `atlas_page` for whole `sactx-*` files. Meshes: primitives / UI-prefab
noise / meta leaks. The guide renders one row per family ("SpriteAtlas families (already sliced)") and caps
P0/P1 tables at 120 rows — the catalog JSON is the full inventory.

Then **enrich the JSON** (this is the value-add):

1. Fix `priority` / `how_to_use` / `maps_to` on entries flagged `_agent_todo`, and on P0 rows — tie each to a level key or class (`BMS`, `DoorPieceItemView`, …). Delete the `_agent_todo` key when done.
2. Fill `color_map` (`{"red": {"name": "Red", "id": 0}, …}`) from the game's color enum.
3. Fill `wiring` (`[{"need": "Colored doors", "key": "DMS/BCT", "asset": "DoorPiece* + {color}_start"}]`).
4. Re-render: `python3 $S/build_asset_catalogs.py --workdir "<workdir>" --render-only`

Re-running without `--render-only` merges (keeps edits); `--reclassify` discards them. Use `--reclassify`
once after re-running de-atlas on a pack whose catalog still has `category: "atlas"` page rows.
If the auto guide is too generic for the game, hand-write the `*_GUIDE.md` instead — keep the same sections (rules, priority legend, color map, SpriteAtlas families, P0/P1 tables, P3 summary, wiring cheat-sheet, full-inventory pointer).

## Step 5 — Author the briefs

Write to `output/briefs/` using [reference/brief-templates.md](reference/brief-templates.md):

| File | Answers | Notes |
|------|---------|-------|
| `GAME_BRIEF.md` | Loop, meta/progression, system map, tech snapshot | |
| `GAMEPLAY_BRIEF.md` | Level schema, session FSM, win/lose, boosters, difficulty, FTUE | Quote enums verbatim |
| `2D_ART_BRIEF.md` | Overview of **all** 2D surfaces incl. meta; link to `IMAGES_INGAME_GUIDE` for file-level | Don't duplicate the guide |
| `3D_ART_BRIEF.md` | **Stub** → `MESHES_GUIDE.md` for 2.5D/sprite boards; **keep full** if game is 3D-heavy (props, shards, cannons) | Tiki Smash = full |

Keep each ≤ ~120 lines. Tables over prose. Cite file paths.

## Step 6 — output/README.md

Fill [reference/output-readme-template.md](reference/output-readme-template.md): layout tree with counts, task → file routing table, `levels/` schema keys, `images/` vs `images_ingame/` vs `fonts/`, mesh P0 families, brief reading order, `../ripped/` pointers, core facts, rules of thumb. This is the entry point another agent reads first.

## Step 7 — Report

Print a table: images / images_ingame / fonts / meshes / levels / briefs / guides (count, size), Unity version,
scripting backend, `images_method` (+ de-atlas counts: cropped / loose / font pages skipped / unresolved),
`--levels-glob` or `--allow/--deny` the user may want to change, open questions.
Do not delete `ripped/` (source of truth for follow-ups).

## Lessons from runs

- **2.5D casual puzzlers**: board look is sprites; most GLBs are uGUI hierarchies. Say so in README + MESHES_GUIDE so agents don't remodel popups.
- **Color is data**: one color enum × neutral art (or a `{color}_{part}.png` kit). Never author per-color meshes.
- **`sactx-*` atlas pages** are unpacked by `de_atlas_images.py` into named PNGs under `output/images/`; font/TMP/SDF atlas pages are skipped; vector fonts land in `output/fonts/`. Guides still say prefer atlas-sourced sprites over random loose UI dumps.
- **De-atlas data lives in `UnityProject/`, not `PrimaryContent/`**: Sprite `.asset` → `m_Rect` + texture GUID → `Texture2D/*.png.meta`. `PrimaryContent/Assets/SpriteAtlas/*.json` has the same rects but references textures by PathID with no sidecar to resolve them — use it only for sprite → family names.
- **Whole-texture sprites** (rect == texture size on a non-`sactx` PNG) are not re-encoded — the loose copy wins, otherwise every loose icon shows up twice (`01.png` + `01__hash.png`). Remaining `__hash` files are real same-name/different-art collisions.
- **`digits_atlas*` digit strips are sprites inside `GameplayAtlas*`**, so page-name checks alone miss them — de-atlas also tests the sprite name against the font heuristics.
- **`_New` / `_Old` icon pairs** → mark `_Old` P3.
- **Empty `LID`-style ids** in level JSON → filename is the practical id; say so in GAMEPLAY brief.
- **Briefs vs guides**: briefs = design overview; guides = per-file how-to. When they overlap, stub the brief and link.

## Guardrails

- Never download APKs; only operate on a local file the user provides.
- Do not modify the AssetRipper install; if the binary is missing, tell the user the path and stop.
- Never hand-crop atlas pages or place a packed `sactx-*` page as one sprite; if `images_method` is `plain_copy`, fix the venv and re-run de-atlas instead.
- Do not commit anything.
- Enrich catalogs from observed scripts/prefabs; mark guesses `ASSUMPTION` inside `how_to_use`.
