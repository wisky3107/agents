---
name: unity-apk-rip
description: >-
  Rip a Unity Android APK/XAPK into a case-study pack with AssetRipper: extract the archive,
  export the Unity project + primary content headlessly, collect all images (PNG) and meshes (GLB),
  copy level/config JSON, then author GAME / 2D art / 3D art / GAMEPLAY briefs. Use when the user
  gives a .apk/.xapk path and asks to rip assets, extract game assets, make a case study, or
  reproduce the tiki-smash output folder (images/, meshes/, levels/, briefs/).
disable-model-invocation: true
---

# Unity APK Rip → case-study pack

Input: one `.apk` or `.xapk` the user owns / is allowed to analyze.
Output: `<workdir>/output/{images,meshes,levels,briefs}` + `manifest.json`.

## Constants

| Key | Value |
|-----|-------|
| AssetRipper binary | `/Users/wikz/Works/agent/assets-ripper/AssetRipper.GUI.Free` (override `ASSETRIPPER_BIN`) |
| Pipeline script | `scripts/rip_apk.py` (Python 3, stdlib only) |
| Brief templates | [reference/brief-templates.md](reference/brief-templates.md) |
| Level heuristics | [reference/level-detection.md](reference/level-detection.md) |

## Progress checklist

```
Unity APK Rip:
- [ ] 0. Confirm input path exists; pick <workdir> (default: folder containing the apk)
- [ ] 1. Run scripts/rip_apk.py  → ripped/ + output/{images,meshes,levels} + manifest.json
- [ ] 2. Read manifest.json; inspect ripped/PrimaryContent/Scripts + output/levels
- [ ] 3. Write output/briefs/{GAME_BRIEF,2D_ART_BRIEF,3D_ART_BRIEF,GAMEPLAY_BRIEF}.md
- [ ] 4. Report table (counts/sizes) + open questions
```

## Step 1 — Run the pipeline (execute, do not rewrite)

```bash
python3 ~/.cursor/skills/unity-apk-rip/scripts/rip_apk.py "<path/to/game.xapk>" \
  --workdir "<workdir>"            # optional, default = apk's folder
  # --port 27890                   # AssetRipper port
  # --levels-glob "Assets/**/Levels/*.json"  # force level source if heuristic misses
  # --skip-rip                     # reuse existing ripped/ (re-collect only)
```

What it does, in order:

1. Unzip `.xapk` → base + split APKs; unzip each APK into `apk_base/` / `apk_<split>/`.
2. Merge `lib/` from splits into `apk_base/lib/` (IL2CPP needs `libil2cpp.so` + `global-metadata.dat` together).
3. Start `AssetRipper.GUI.Free --headless --port N`, `POST /LoadFolder path=apk_base`,
   `POST /Export/UnityProject`, `POST /Export/PrimaryContent`, then kill it.
4. Collect every image (`png/jpg/tga/webp`) → `output/images/`, every `glb/gltf/fbx/obj` → `output/meshes/`
   (dedupe by content hash; name collisions get `__<hash8>` suffix).
5. Detect level data (see reference) → `output/levels/`.
6. Write `output/manifest.json` (unity version, counts, detected level dir, prop-id histogram if JSON levels).

Exit code ≠ 0 → read `<workdir>/assetripper.log` and the printed step; fix and rerun with `--skip-rip` if export already finished.

## Step 2 — Understand the game before writing

Read, in this order (skip what is missing):

- `output/manifest.json`
- `ripped/PrimaryContent/Scripts/<GameCore>*/` — classes named `*Core`, `*Sim`, `*LevelDef`, `*Document`, `TuningProfile`
- 2–3 files in `output/levels/` + any `Config/*.json`
- `ls output/images | head`, `ls output/meshes | head` — naming prefixes reveal art systems

Only state what is OBSERVED in files. Mark inferences `ASSUMPTION`.

## Step 3 — Author the four briefs

Write to `output/briefs/`. Use the section skeletons in [reference/brief-templates.md](reference/brief-templates.md):

| File | Answers |
|------|---------|
| `GAME_BRIEF.md` | How to play, loop, meta/progression, system map, tech snapshot |
| `2D_ART_BRIEF.md` | Where 2D is used (UI kit, BG, icons, fonts), naming conventions, rules |
| `3D_ART_BRIEF.md` | Mesh families, PropId→mesh, runtime spawn path, destruction states |
| `GAMEPLAY_BRIEF.md` | Data model (level schema), session state machine, win/lose rules, difficulty, FTUE |

Keep each brief ≤ ~120 lines. Tables over prose. Cite file paths.

## Step 4 — Report

Print a table: images / meshes / levels / briefs (count, size), Unity version, scripting backend, and any `--levels-glob` the user may need to set. Do not delete `ripped/` (source of truth for follow-ups).

## Guardrails

- Never download APKs; only operate on a local file the user provides.
- Do not modify the AssetRipper install; if the binary is missing, tell the user the path and stop.
- Do not commit anything.
