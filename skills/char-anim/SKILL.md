---
name: char-anim
description: >-
  Animated game character from a brief: rig-ready A-pose concept → 3D mesh (3D Gen Studio /
  Tripo) → auto-rig + animation with char-anim-pipeline, exported as FBX (skinned + clips),
  frame-by-frame sprites (atlas + animations.json), or both. Use when a user, workflow or fleet
  asks for an animated / rigged character, character sprites or sprite sheets from 3D,
  idle/run/jump/attack clips, or retargeting mocap (Mixamo FBX/BVH) onto a new character.
---

# char-anim

One character flows through three gates: **CONCEPT: PASS** → **VERDICT: PASS** (mesh) →
**ANIM: PASS** (pipeline QA + contact sheets). Each gate has an evidence file, and a later
stage never starts on a missing or failed gate.

- Pipeline: `$CHAR_ANIM_HOME`, default `/Users/wikz/Works/agent/char-anim-pipeline`. Its
  `CLAUDE.md` is the source of truth for the `./anim` commands, job keys and export flags.
- Mesh tools: `cocos-asset-gen` scripts. Use the project copy `.cursor/skills/cocos-asset-gen/scripts/`
  when it exists, otherwise `~/.agents/skills/cocos-asset-gen/scripts/`. This is `$CAG` below.
- Blender: `$BLENDER`, otherwise `/Applications/Blender.app/Contents/MacOS/Blender`.

Neither variable is usually set. Define all three in every shell call before using them:

```bash
CHAR_ANIM_HOME=${CHAR_ANIM_HOME:-/Users/wikz/Works/agent/char-anim-pipeline}
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
CAG=$( [ -d .cursor/skills/cocos-asset-gen/scripts ] && echo .cursor/skills/cocos-asset-gen/scripts || echo ~/.agents/skills/cocos-asset-gen/scripts )
```

## 0. Resolve the run

Record these before any generation:

| Field | Default | Notes |
|---|---|---|
| `id` | slug of the character name | lowercase `[a-z0-9_-]`; it is the stem everywhere |
| `export` | `fbf,fbx` | sprite / 2D / atlas → `fbf`; Unity / Cocos / Godot / "model có animation" → `fbx` |
| `clips` | `idle,run,jump,attack` | authored: `idle,walk,run,jump,attack` (list in `$CHAR_ANIM_HOME/pipeline/clip_templates.json`); anything else is a mocap clip (FBX/BVH file needed) |
| `art` | the project's `art_paths`, else the folder the user names, else `./char-anim` | root for `concepts/<id>/` and `gen3d/<id>/`; the extra `<id>` level is intentional, so several characters can share one root |
| `dest` | `<art>/characters/<id>/`, or the folder the user names | where deliverables are copied (matches fleet-tasks.md) |
| `concept_backend` | `antigravity` | `antigravity` · `codex-image` · `gpt-image-gen`; see step 1 |
| `height_m` | 1.7 | real height of the character in metres |
| `pixel` | off | fbf only. Turn on **only** when the brief or prompt asks for pixel art / pixelate / 8-bit / 16-bit / retro sprite. Value = art px per metre: 48 by default, 32 for chunkier, 24 for 8-bit. Never switch it on because the game "looks retro" |

If the user supplies a concept image, start at step 1's check. If they supply a mesh, start at
step 3. Completion criterion: every field has a value, and the entry step is known.

## 1. Concept (rig-ready)

**Leading word: mannequin.** The concept is a clean, neutral mannequin sheet of the design.
Style lives in the outfit and face, never in the pose.

1. Build the prompt from [reference/concept-prompt.md](reference/concept-prompt.md), which holds the A-pose
   rules, the prompt template and the per-view lines. Generate three **separate** PNGs:
   `concept-front.png` (the image→3D input), `concept-threequarter.png` and `concept-back.png`.
   Put them in `<art>/concepts/<id>/`.
2. Backend. Inside `cocos-orca-fleet`, the cocos-asset-gen concept route decides (antigravity,
   or codex-image when `art_backend` is gpt-image-gen / codex-image). Every backend keeps the
   concept on a plain light-grey or white background, never transparent, because Tripo reads
   alpha edges badly.
   - `antigravity` (default) uses its own image tools. A session without image tools (for
     example Claude Code) spawns an Antigravity worker with orca: recipe C from
     `cocos-orca-fleet/SKILL.md` inside a fleet, or the solo launch in
     [reference/fleet-tasks.md § Solo launch](reference/fleet-tasks.md#solo-launch-no-fleet) otherwise,
     with the `char-concept-<id>` task spec. When its image tool hits HTTP 429 or a quota
     error, the worker switches to `codex-image`.
   - `codex-image` runs `codex-image-gen` from any session with a shell, no worker needed. Use
     one jobs file: `concept-front.png` as a generation, then the ¾ and back views as edits
     with the front as `ref`, where only the VIEW line changes.
   - `gpt-image-gen` goes through `orca-gpt-image-gen`. Use it only when the user asks for it
     outside a Cocos fleet.
3. Open every PNG and write `evidence/art/<id>/concept-check.md` using the checklist in
   `reference/concept-prompt.md`. It ends with `CONCEPT: PASS` or `CONCEPT: FAIL — <reason>`.
   On FAIL, regenerate at most twice, then stop and report with the images.

Completion criterion: three single-figure PNGs exist, and concept-check.md ends in `CONCEPT: PASS`.

## 2. Mesh (3D Gen Studio)

```bash
python3 $CAG/gen3d_studio.py --check        # 0 usable · 2 unavailable → stop and ask (Blender primitives can't build a character)
python3 $CAG/gen3d_studio.py --image <art>/concepts/<id>/concept-front.png --stem <id> \
  --out-dir <art>/gen3d/<id> --evidence-dir evidence/art/<id> --project "<project or id>" \
  --target-tris 30000 --lod-ratios 0.5 --collision none      # ≈30 credits
```
- Read `gen3d-report.json`. Check `game.triangles` ≤ 40000, bake coverage ≥ 0.95,
  `seam_limited` false. If the finishing pass needs fixing, rerun with
  `--source-glb <art>/gen3d/<id>/<id>_high.glb` (costs no credits, at most twice). Generate
  again only when the silhouette itself is wrong. In that case fix the concept first.
- Review render: studio glbs face +X. Turn a copy to face Blender -Y (glTF +Z) first:
  ```bash
  $CHAR_ANIM_HOME/anim normalize <art>/gen3d/<id>/<id>.glb --out evidence/art/<id>/review/<id>-front.glb \
    --face=-Y --height <height_m>
  "$BLENDER" -b --python $CAG/render_model_iso.py -- --input evidence/art/<id>/review/<id>-front.glb \
    --out evidence/art/<id>/model[/round-<n>] --forward +Z --concepts <art>/concepts/<id>
  ```
  The normals flag only counts closed parts that are inside out, so studio meshes with thin
  limbs no longer trip it falsely. Still trust the renders: flipped normals show as dark or
  see-through patches in the sheets.
- Open `compare-sheet.png` and `contact-sheet.png`. Write `evidence/art/<id>/model-check.md`
  covering concept match (front / three-quarter / back rows), arms clear of the torso, the legs
  as two separate columns down to the feet, hands present, no fused props, and the tri budget.
  It ends with `VERDICT: PASS` or `VERDICT: FAIL — <reason>`. Allow at most 3 rounds.

Completion criterion: `<id>.glb` exists, and model-check.md ends in `VERDICT: PASS` with both
sheets opened.

## 3. Animate (char-anim-pipeline)

```bash
A=$CHAR_ANIM_HOME/anim        # run from the project dir; the mesh path resolves from cwd
$A character <art>/gen3d/<id>/<id>.glb --id <id> --height <height_m> --clips <authored clips> --export <export> [--pixel <px_per_m>] --run
```
`--pixel` appears only when the `pixel` field is on. Other pixel options (`colors`, `scale`,
`outline`) go in the job's `"pixel"` block; see README § pixel in `$CHAR_ANIM_HOME`. To add
pixel mode after a normal run, or to tune it, edit that block and run
`$A run jobs/<id>-core.json --repack`. This re-packages fbf in seconds without re-rendering.
`character` accepts authored clips only. It writes `characters/<id>/` and `jobs/<id>-core.json`
inside `$CHAR_ANIM_HOME`, not in cwd. Every later `$A run jobs/...` is relative to `$CHAR_ANIM_HOME`,
so run those commands from there. Running `character` again keeps the mocap clips already in the job.
- Mocap clips (Mixamo: FBX Binary, Without Skin, 30 fps, In Place). Don't use `anim mocap`: it
  writes the shared `jobs/<clip>.json`.
  1. Copy the take into `$CHAR_ANIM_HOME/mocap/`.
  2. Run `$A inspect <take>` to get the frame range.
  3. Add a clip with a `source` block to `$CHAR_ANIM_HOME/jobs/<id>-core.json`. The format is in
     `$CHAR_ANIM_HOME/mocap/README.md` §4.
  4. Run `$A run jobs/<id>-core.json --clips <clip>`.

  Keeping every clip in the one job gives one FBX with every take, and parallel characters
  never write the same `jobs/<clip>.json`.
- Outputs go to `$CHAR_ANIM_HOME/out/<id>-core/`.
- Read the `RIG_REPORT` line. It must show `"pose": "A"`, a sane `normalize.scale`
  (a studio glb is 1 m tall, so the scale ≈ `height_m`), `empty_bone_groups: []` and
  `unweighted_vertices: 0`. When rig fails with "not a single A-pose humanoid", no hand, or
  T-pose, the fix is the concept. Go back to step 1 and state the reason in concept-check.md.
- Open `out/<job>/qa.json` (`verdict` must be `pass`) and every
  `out/<job>/evidence/<clip>-contact-sheet.png`. Numbers miss mesh tearing, arms through the
  body, and a skirt or hair clipping the legs.
  In pixel mode, also check the sheets for:
  - a face and hands that still read at that size
  - the palette keeping the key outfit colours
  - a closed outline
  - feet on the ground line
  - no flickering stray pixels between frames
  If the character is unreadable, raise `px_per_m`.
- Write `evidence/art/<id>/anim-check.md`: one line per clip with its QA verdict and what the
  contact sheet shows, then `ANIM: PASS` or `ANIM: FAIL — <clip>: <reason>`. For pose or timing
  problems, edit the clip in `jobs/<id>-core.json` (frames, `duration_ms`, events) and run
  `$A run jobs/<id>-core.json --clips <clip>`. Allow at most 2 rounds per clip.
- Copy from `$CHAR_ANIM_HOME/out/<id>-core/` to `dest`:
  - `fbx/*`
  - `fbf/` (the atlas pages and `animations.json`/`.js`)
  - `player.html`
  - `manifest.json`
  - `qa.json`

  Never write `.meta` files, and don't open Cocos Creator: the engine imports on its own.

Completion criterion: every requested clip × export is in `dest`, qa.json verdict is `pass`,
every contact sheet has been opened, and anim-check.md ends in `ANIM: PASS`.

## Report

End with:
- the deliverable paths for each requested export: the FBX with its takes, the atlas pages
  plus `animations.json`, and `player.html`
- the three gate files
- the credits spent
- the manifest facts an engine integrator needs:
  - clip seconds (the sum of `duration_ms`) and loop flags
  - FBX: faces +Z with Y up; events carry `time_s` in `manifest.json`
  - fbf: cell (`canvas`), `pivot` (feet), `px_per_m`, and camera (side view, facing right);
    events carry `frame`, a 0-based index into the clip's frames, with no `time_s`
  - pixel mode: `manifest.fbf.pixel` gives `art_px_per_m`, `scale` and the palette size.
    The engine must sample with nearest filtering (Cocos: filter `nearest`; Unity: Point,
    no compression)

Answer in the user's language.

## Fleet use

Split the work into tasks along the gates: `char-concept-<id>` → `char-mesh-<id>` → `char-anim-<id>`.
Several characters run in parallel, one chain each. The anim task needs local Blender and
`$CHAR_ANIM_HOME`; different ids never share a job or rig file, so their anim tasks can run
side by side. Paste the task specs from [reference/fleet-tasks.md](reference/fleet-tasks.md). Ownership and messaging follow the
host fleet skill (`cocos-orca-fleet` / `orca-agent-fleet`).
