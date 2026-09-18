# Brief templates

Fill every section; write `n/a — not observed` rather than deleting. Cite paths under `ripped/` or `output/`.

## GAME_BRIEF.md

```markdown
# Game Brief — <Title>
> Build: <package> v<version> (Unity <ver>, <Mono|IL2CPP>). Core module: <name>.

## One-liner
## Fantasy & tone
## Player loop            (ascii flow: Home → … → Win/Lose)
## How the game operates  (table: Layer | Module | Role)
## Session rules          (numbered, player-facing)
## Progression & economy  (meta modules, configs found)
## Special systems        (cannons / boosters / power-ups…)
## FTUE                   (tutorial scripts found)
## Tech snapshot
## Case-study takeaways
```

## 2D_ART_BRIEF.md

Design overview of **all** 2D (incl. meta/live-ops not in `images_ingame/`). File-level how-to lives in `IMAGES_INGAME_GUIDE.md` — link, don't duplicate.

```markdown
# 2D Art Brief — <Title>
> Source: output/images (~N de-atlased PNGs) + output/fonts/ (~N .ttf/.otf). UI prefabs under <path>.
> **Per-file how-to (board/HUD subset):** ../IMAGES_INGAME_GUIDE.md + ../images_ingame_catalog.json
> **This brief** = design overview of *all* 2D.

## Role of 2D in the game   (what 2D does NOT draw; fonts → output/fonts/)
## Where it shows up        (table: Surface | Example assets | Notes — cite atlas *families* / sprite names, not sactx pages)
## Art system               (naming prefixes → kits; canvas vs world; de-atlased families; fonts/)
## Pipeline observations    (de_atlas_images.py, @2x, _0 dupes, ASTC→PNG)
## Design rules for a remake
## Not 2D                   (→ ../MESHES_GUIDE.md; UI-hierarchy GLB noise)
```

## 3D_ART_BRIEF.md (stub)

`MESHES_GUIDE.md` + `meshes_catalog.json` cover per-file 3D usage; a full brief was redundant. Keep this as a ≤ 20-line stub so the four-brief pack stays intact.

```markdown
# 3D Art Brief — <Title>
> Stub. Full agent guidance: ../MESHES_GUIDE.md · per-GLB lookup: ../meshes_catalog.json

## One-liner
<2D / 2.5D / 3D>: what meshes actually carry (topology, shells, view roots) vs. what is sprite-driven.
~<N>/<total> GLBs are uGUI/meta dumps — skip `*PopUp*`, `Toolbar*`, `*Leaderboard*`.

## Runtime path (one line)
<LevelModel> → factories → <Item views> → tint by <ColorEnum> → clear FX.

See GAMEPLAY_BRIEF.md and 2D_ART_BRIEF.md for design context.
```

If the game is genuinely 3D-heavy (hero meshes, PropId catalogs, destruction states), expand this brief instead of stubbing — use: Role of 3D · Asset families · Material/prop vocabulary · Runtime usage path · Hero objects · Production notes · Remake checklist.

## GAMEPLAY_BRIEF.md

```markdown
# Gameplay Brief — <Title>
> Logic from <Core scripts path> + output/levels.

## Core verb
## Data model               (level JSON schema block + supporting configs table)
## Session state machine    (ascii)
## Input / action model
## Physics & destruction (or equivalent core system)
## Win / Lose rules         (table: Signal | Condition; quote TuningProfile tooltips if present)
## Difficulty               (distribution from manifest)
## Boosters & meta hooks
## Progression logic
## FTUE script machine
## Design implications
## File map
```
