# output/README.md template

Write this as `<workdir>/output/README.md` after briefs + guides exist. Replace `<…>`; delete rows for files that were not produced. Keep ≤ ~160 lines.

```markdown
# Output folder — agent guide

Case-study pack for **<Title>** (`<package>` v<version>). Produced by the Unity APK rip pipeline.

**Start here.** This folder is the curated deliverable. `../ripped/` is the full AssetRipper export (scripts, prefabs, YAML) — use it for code/GUID lookups, not day-to-day art/level work.

## Layout

```
output/
├── README.md                      ← you are here
├── manifest.json                  ← counts, Unity version, paths
├── images/                        ← de-atlased PNGs (<N>; no sactx pages / no font atlases)
├── images_ingame/                 ← filtered in-level art (<N>)
├── images_ingame_manifest.json    ← keep/drop reason per image
├── images_ingame_catalog.json     ← per-file usage (machine)
├── IMAGES_INGAME_GUIDE.md         ← per-file usage (human)
├── de_atlas_lookup.json           ← sprite → SpriteAtlas family
├── de_atlas_manifest.json         ← de-atlas run stats
├── fonts/                         ← .ttf / .otf / .fnt
├── meshes/                        ← GLB exports (<N>; many are UI prefab trees)
├── meshes_catalog.json            ← per-GLB usage (machine)
├── MESHES_GUIDE.md                ← 3D usage (human)
├── levels/                        ← level data (<N>)
└── briefs/                        ← GAME / 2D_ART / 3D_ART(stub) / GAMEPLAY
```

| Path | Count | Size | Use when |
|------|------:|------|----------|
| `images/` | | | Every de-atlased sprite + loose texture (incl. meta) |
| `images_ingame/` | | | Remaking board + in-level HUD |
| `fonts/` | | | Vector fonts for UI/TMP (not SDF atlas PNGs) |
| `meshes/` | | | Shape topology / door / spawner shells |
| `levels/` | | | Level data, difficulty, obstacle mix |
| `briefs/` | 4 | | Loop, schema, art systems |

## What task → what to open

| Task | Read first | Then use |
|------|------------|----------|
| Understand the game | `briefs/GAME_BRIEF.md` | `briefs/GAMEPLAY_BRIEF.md` |
| Remake board art | `briefs/2D_ART_BRIEF.md` | `IMAGES_INGAME_GUIDE.md` + `images_ingame/` |
| Remake 3D pieces | `MESHES_GUIDE.md` | `meshes/` P0 + `meshes_catalog.json` |
| Implement level loader | `briefs/GAMEPLAY_BRIEF.md` | `levels/*.json` + `../ripped/.../<LevelModel>.cs` |
| Look up one asset | `*_catalog.json` | search `entries[].file` → `how_to_use` / `maps_to` |
| Fonts / HUD text | `fonts/` | not SDF atlas PNGs under `images/` |
| Meta / live-ops art | `images/` | not in `images_ingame/` by design |
| Trace prefab / script | `../ripped/PrimaryContent/Scripts/` | `../ripped/UnityProject/ExportedProject/Assets/` |

## manifest.json
Read first — `unity_version`, `scripting_backend`, `counts`, `de_atlas`, `levels_detected`, `images_ingame`.

## levels/
<naming pattern>, <N> files, schema class `<LevelModel>` at `<path>`. Top-level keys table (key → meaning).

## images/ vs images_ingame/
`images/` = de-atlased sprites (one PNG per Unity Sprite) + loose non-atlas textures. No `sactx-*` pages; no SDF/BMF/digit font atlases.
`images_ingame/` = GamePlay BFS + allowlisted atlas **families** − denied live-ops families. Default for remakes.
`fonts/` = `.ttf`/`.otf`/`.fnt` for text.
Lookup: guide → catalog `entries[]` (`maps_to` = atlas family) → `de_atlas_lookup.json` → filter manifest `kept/dropped`.
Sprites are **already sliced** — do not place packed pages.

## meshes/
Game is <2D/2.5D/3D>. P0 families: `<pattern list>`. Ignore `*PopUp*`, `Toolbar*`, `*Leaderboard*`, primitives.

## briefs/ reading order
1. GAME_BRIEF  2. GAMEPLAY_BRIEF  3. 2D_ART_BRIEF (overview of *all* 2D)  4. 3D_ART_BRIEF (stub → MESHES_GUIDE)
Facts marked **ASSUMPTION** are hypotheses.

## ../ripped/ (upstream)
| Path | Purpose |
|------|---------|
| `PrimaryContent/Scripts/` | Decompiled C# |
| `PrimaryContent/Assets/Resources/` | Configs / levels |
| `UnityProject/ExportedProject/Assets/` | Prefabs, scenes, `.meta` GUIDs |
Do **not** delete `ripped/`.

## Core game facts
- Verb: <…>  - Fail: <…>  - Boosters: <…>  - Engine: Unity <ver>, <backend>

## Agent rules of thumb
1. Read `manifest.json` first.  2. `images_ingame/` over `images/`.
3. Sprites are de-atlased — filter by atlas family via catalog / `de_atlas_lookup.json`.
4. Fonts in `fonts/` (not SDF atlas PNGs).  5. Ignore P3 unless doing that feature.
6. Not every GLB is 3D art.  7. Never modify `../ripped/` unasked.
```
