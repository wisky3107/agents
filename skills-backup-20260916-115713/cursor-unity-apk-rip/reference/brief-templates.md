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

```markdown
# 2D Art Brief — <Title>
> Source: output/images (~N PNG) + UI prefabs under <path>.

## Role of 2D in the game   (what 2D does NOT draw)
## Where it shows up        (table: Surface | Example assets | Notes)
## Art system               (naming prefixes → kits; canvas vs world; atlases; fonts)
## Pipeline observations    (@2x, _0 dupes, atlases, sliced sprites)
## Design rules for a remake
## Not 2D                   (pointers to 3D brief; UI-hierarchy GLB noise)
```

## 3D_ART_BRIEF.md

```markdown
# 3D Art Brief — <Title>
> Source: output/meshes (~N GLB), prefabs <Prop_*>, level PropIds.

## Role of 3D
## Asset families           (table: Family | Pattern | Used for)
## Material / prop vocabulary (top PropIds from manifest histogram)
## Runtime usage path       (LevelDoc → catalog → spawn → break/crush)
## Hero objects             (player tool / projectile / stage)
## Production notes
## Remake checklist
```

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
