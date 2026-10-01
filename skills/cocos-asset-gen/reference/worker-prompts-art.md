# Art worker dispatch specs

Copy the block for each art role into `.cursor/evidence/tasks/<TASK_ID>/specs/<role>.md`, fill
the `<...>` placeholders from `docs/plans/<feature>.md`, prepend the fleet's shared header
(`cocos-orca-fleet/reference/worker-prompts.md`), run
`python3 ~/.agents/skills/orca-agent-fleet/scripts/clean_spec.py <file>`, then pass the content to
`orca orchestration task-create --spec`.

Shared art rules — every art Task owns only its allowlisted paths under `PLAN.art_paths`,
never creates `.meta`, never opens Creator, never touches `.scene`/`.prefab`, never calls
Funplay / `refresh_assets`. Evidence stays under the evidence root.
A `MEMORY:` line in an art spec follows the shared-header memory rule: advisory, no
permission, cite ids used; art verdicts still come from your own checks.

**Import rows (rip pack present).** When `ASSET_MANIFEST.md` has a `Source` column, rows marked
`import` name exact staged files under reference (including rip/images_ingame, fonts, meshes,
models, and isolated rip-sources/<id> packs). For those rows the art Task **copies/converts**
raw files into its `art_paths` destination; the integrator owns editor import. Sprites are
already de-atlased; a legacy packed atlas goes back to the rip de-atlas pipeline. The Task
generates nothing; `manifest.json` row gets `"source": "import",
"source_path": "<reference path>"`. `art-concept-*` is skipped for imported meshes (no concept
pack needed). Only rows marked `generate` (or rows without a `Source` column) go through the
backend blocks below. Never import a file the rip catalogs mark P3 / uGUI / meta.
Imported meshes use `art-import-<stem>` on the locked writer agent, without a
generation provider. Inspect source comparison, topology, pivot/scale/axis, materials and
budget; record route=import with model-check.md and VERDICT. The integrator requires that
check, not CONCEPT: PASS. Reuse inspected rig/clips for imported animated rows; char-anim is
only for missing clips/rig work explicitly scoped in the slice.

When the PLAN has **no** meshes, use the single legacy `art` Task at the bottom. When it lists
generated meshes, fan out to `art-manifest` + `art-concept-<stem>`×N + `art-mesh-<stem>`×N;
imported meshes use a copy/conversion role and skip concept/mesh generation (+ `art-2d`).
Each **animated** row (a rigged character with clips or FBF sprites; manifest `animated` set) also gets
`art-anim-<stem>` after its mesh. Its concept and mesh follow the animated addenda below; the
pipeline side is the `char-anim` skill (`~/.agents/skills/char-anim/SKILL.md`).

---

## art-manifest (cursor --model auto)

```text
ROLE: writer (assets) — manifest skeleton only.
Owns: <ART_PATHS>/manifest.json

Do:
1. Write manifest.json listing every planned asset row from PLAN (meshes + 2D). Mesh rows include
   source=import/generate from ASSET_MANIFEST. Imported rows preserve source format, existing
   rig/clip inventory and exact source_path; the generated FBX defaults below do not rewrite them.
   file, format, expect_dims [x,y,z] in Blender/export order, pivot, forward, intended_node,
   notes, tri_budget, "complexity": "simple" | "complex" (cocos-asset-gen SKILL.md routing table;
   ties → simple), "concepts": [], "verify": null. Do not invent assets beyond change_budget.
   A character that must move (PLAN lists clips / sprite animation for it) is an **animated** row:
     "complexity": "complex", "tri_budget": 30000, "file": "<Stem>.fbx" (or null when export is fbf only),
     "animated": {"clips": ["idle","run",...], "mocap": {"<clip>": "<take path>"},
                  "export": ["fbx"] | ["fbf"] | ["fbx","fbf"], "fbf_dir": "anim/<stem>/"},
     "anim_verify": null
   Authored clips are idle, run, jump, attack; every other clip needs a mocap take (FBX/BVH).
   A clip with neither → list it under notes and `ask`; never drop it silently.
2. `orca orchestration send --type status` to every art-concept / art-mesh / art-anim / art-2d /
   implement handle with the manifest path.
3. worker_done.

Never: write concept PNGs, generators, or .glb files; edit evidence/art except listing the path.
```

---

## art-import-<stem> (locked writer_agent, recipe A/B)

```text
ROLE: writer (raw assets). Own only this stem's planned runtime asset files and
evidence/art/<STEM>/. Sources under reference/ and original Unity trees remain read-only.
Read ASSET_MANIFEST and the slice's selected RIP_ASSET_MAP/Port evidence rows.
1. Verify exact source path/hash; copy the existing asset and referenced dependencies into
   the allowlisted destination. Perform only conversions required by the contract and record
   the reproducible command. No generation provider, concept art, or manual atlas cropping.
2. Inspect sprite alpha/size, font identity, or mesh topology/scale/pivot/axis/material/texture
   and budget as applicable. Compare to the cited source; capture suitable visual evidence.
3. Write model-check.md (meshes) or import-check.md (other assets): route=import, source/hash,
   destination, conversion, checks and VERDICT: PASS|FAIL. For existing rig/clip imports also
   write anim-check.md with clip names/duration/loop and ANIM: PASS|FAIL; missing required clips
   go to the coordinator instead of fabricating a pass or generating an unscoped replacement.
4. Update only this manifest row's source/source_path/verify (anim_verify when relevant).
   Report artifacts with worker_done. The integrator refreshes/imports and validates runtime
   rendering/playback; this task never creates .meta, opens Creator, or claims runtime PASS.
```

## art-concept-<stem> (ALWAYS antigravity — recipe C, no AGENTS.md boot)

Launch with SKILL.md **recipe C**: `orca terminal create` → first `tui-idle` →
`worker-start --terminal` with this spec as the first turn. Do **not** send the AGENTS.md
startup prompt used by plan/implement/review (recipe B).

```text
ROLE: writer (assets) — 3D concept pack. art_backend forced to antigravity for this Task.
Owns ONLY: <ART_PATHS>/concepts/<STEM>/** and
evidence/art/<STEM>/concept-check.md (create the stem evidence dir if needed).

Do:
1. With THIS Antigravity session's own image tools, generate real PNGs:
     concept-front.png, concept-threequarter.png, concept-back.png
     (concept-turnaround.png optional). Same character / palette / outfit across all angles.
   concept-front.png must be a clean single subject on a plain background — it is also the
   image-to-3D input when the mesh routes to 3D Gen Studio.
   Do NOT call orca-gpt-image-gen / ChatGPT for these concepts.
2. Read every PNG. Write evidence/art/<STEM>/concept-check.md (never a shared file):
     ## <STEM> — concept round <n>
     files: ...
     readability: PASS|FAIL — ...
     style: PASS|FAIL — vs GAME_BRIEF / PLAN
     anatomy: PASS|FAIL — ...
     cross-angle consistency: PASS|FAIL — front/3/4/back are the same design
     CONCEPT: PASS | CONCEPT: FAIL — <reason>
3. CONCEPT FAIL → regenerate (max 2 rounds). No PASS → worker_done --outcome failed; do not
   signal the mesh worker to start.
4. On PASS: `orca orchestration send --type status --to <MESH_HANDLE> --subject "concept ready"
   --body "<concepts dir>"` then worker_done listing the PNGs.

Never: write .glb / generators; edit other stems; edit manifest.json; open Creator.
```

**Animated addendum** (append to the spec when the row has `animated`):

```text
This concept feeds an auto-rig. Build every prompt from
~/.agents/skills/char-anim/reference/concept-prompt.md: A-pose (arms 35–45° down with a gap to
the torso, legs apart, feet forward), normal proportions, no cape / long skirt / loose sleeves /
props / base, EXACTLY ONE FIGURE PER IMAGE (never a multi-view sheet). Add that file's rig lines
(single figure, a-pose, hands, proportions, rig-hostile parts, background) to concept-check.md.
On PASS, send status to the art-mesh handle; art-anim waits on the mesh.
```

---

## art-mesh-<stem> (per locked art_backend; mesh_backend decides the route)

Launch: `cursor` art_backend → recipe **A**; `antigravity` / `gpt-image-gen` (codex) → recipe **C**
(no AGENTS.md boot — art spec is the first turn).

```text
ROLE: writer (assets) — one mesh. Depends on art-concept-<STEM> CONCEPT: PASS.
mesh_backend=<MESH_BACKEND> (auto | blender | 3dgenstudio). complexity=<from manifest row>.
Owns ONLY: <ART_PATHS>/gen_<STEM>_*.py, <ART_PATHS>/gen3d/<STEM>/**, <ART_PATHS>/<MODEL_FILE>,
evidence/art/<STEM>/**, evidence/art/<STEM>/model-check.md, and a read-modify-write of THAT ROW
ONLY in manifest.json (complexity if missing, concepts, verify).

Do:
1. Confirm CONCEPT: PASS for <STEM> (read concept-check.md + concept PNGs). Missing → ask /
   worker_done failed; never invent a concept.
2. Route (cocos-asset-gen SKILL.md → "Mesh routing"):
     blender      → step 3A
     3dgenstudio  → probe `python3 .cursor/skills/cocos-asset-gen/scripts/gen3d_studio.py --check`;
                    exit 0 → 3B; exit 2 → ask once ("studio down: wait or Blender?") unless the
                    PLAN says fallback_ok → 3A
     auto         → complexity simple → 3A; complex → probe; exit 0 → 3B; exit 2 → 3A and note
                    "fallback: studio unavailable" in model-check.md
3A. BLENDER: write <ART_PATHS>/gen_<STEM>_*.py citing the concept paths as source of truth;
    export <ART_PATHS>/<MODEL_FILE> at manifest dims / pivot / forward; respect tri_budget.
3B. 3D GEN STUDIO:
      python3 .cursor/skills/cocos-asset-gen/scripts/gen3d_studio.py \
        --image <ART_PATHS>/concepts/<STEM>/concept-front.png --stem <STEM> \
        --out-dir <ART_PATHS>/gen3d/<STEM> --evidence-dir <EVIDENCE_ROOT>/art/<STEM> \
        --project "<PROJECT_SLUG>" --target-tris <tri_budget> --collision decomposition
      cp <ART_PATHS>/gen3d/<STEM>/<STEM>.glb <ART_PATHS>/<MODEL_FILE>
    Read gen3d-report.json: seam_limited false, bake coverage ≥ 0.95, game.triangles ≤ budget,
    world_bounds_after_pivot.min[1] == 0. Finishing problems → rerun with
    --source-glb <ART_PATHS>/gen3d/<STEM>/<STEM>_high.glb (no credits), max 2. Exit 3 → read
    `error`; unclear → ask. Never regenerate just to fix finishing.
4. Verify render (iso + concept-angle compare):
     BLENDER="${BLENDER_BIN:-$(command -v blender || echo /Applications/Blender.app/Contents/MacOS/Blender)}"
     "$BLENDER" --background --python .cursor/skills/cocos-asset-gen/scripts/render_model_iso.py -- \
       --input <ART_PATHS>/<MODEL_FILE> \
       --out <EVIDENCE_ROOT>/art/<STEM>[/round-<n>] \
       --expect-dims "<x,y,z>" \
       --concepts <ART_PATHS>/concepts/<STEM>
5. Read contact-sheet.png, compare-sheet.png, stats.json, the concept PNGs (and gen3d-report.json
   on route 3B). Write evidence/art/<STEM>/model-check.md (per-stem file):
     ## <MODEL_FILE> — round <n>
     route: blender | 3dgenstudio — <reason / fallback note>
     source: gen_<STEM>.py | gen3d-report.json (high <n> tris → game <n>, coverage <c>, ~<n> credits)
     views: <contact-sheet>   compare: <compare-sheet>   stats: <stats.json>
     topology / holes-hollow / normals / scale / silhouette / style fit: PASS|FAIL
     tri budget: PASS|FAIL — <n> ≤ <tri_budget>; LODs <...>; collision <parts>
     concept match: PASS|FAIL — cite front / threequarter / back rows of compare-sheet
     pivot/axis: PASS|FAIL
     VERDICT: PASS | VERDICT: FAIL — <reason>
6. FAIL → fix (3A: generator; 3B: finishing rerun or, if the silhouette itself is wrong, one
   regeneration with a better prompt/concept), re-render into round-<n+1> (max 3). PASS → patch
   only this manifest row:
     "complexity": "<value>", "concepts": [...],
     "verify": {"status":"PASS","route":"<route>","evidence":"<contact-sheet>",
                "compare":"<compare-sheet>","concept":"<concept-front>","round":n}
7. worker_done --files-modified (list the .glb, LODs, collision, maps, and evidence files).

Never: touch other stems; create .meta; open Creator; skip --concepts; PASS without opening
compare-sheet.png; ship the Tripo high-poly as the asset; pick 3dgenstudio for a simple prop.
```

**Animated addendum** (append when the row has `animated`):

```text
Route is always 3dgenstudio (a Blender primitive figure cannot be rigged). Studio down → ask;
no Blender fallback. Use --target-tris 30000 --lod-ratios 0.5 --collision none.
Do NOT cp the glb to <MODEL_FILE>: the static mesh stays in gen3d/<STEM>/, and art-anim ships
the rigged file.
Studio glbs face +X; render_model_iso's front camera expects -Y. Render a turned copy:
  <CHAR_ANIM_HOME>/anim normalize <ART_PATHS>/gen3d/<STEM>/<STEM>.glb \
    --out <EVIDENCE_ROOT>/art/<STEM>/review/<STEM>-front.glb --face=-Y
and pass that copy as --input (omit --expect-dims; normalize scales to 1.7 m).
model-check.md adds: rig readiness: PASS|FAIL — one humanoid, arms clear of the torso, two
separate legs down to the feet, hands present, no fused props.
PASS → send status "mesh ready" to the art-anim handle, with body <ART_PATHS>/gen3d/<STEM>/<STEM>.glb.
```

---

## art-anim-<stem> (locked art_backend; char-anim-pipeline)

Launch: like art-mesh (`cursor` → recipe **A**; antigravity / codex → recipe **C**). The worker
needs local Blender, and write access to `<CHAR_ANIM_HOME>` (PLAN `char_anim_home`, default
`/Users/wikz/Works/agent/char-anim-pipeline`), which lives outside the worktree.

```text
ROLE: writer (assets) — rig + animate one character. Depends on art-mesh-<STEM> VERDICT: PASS.
Pipeline: <CHAR_ANIM_HOME> (read its CLAUDE.md first). Pipeline id: <ANIM_ID> = <project-slug>-<stem>,
lowercase [a-z0-9_-], unique across games because the pipeline dir is shared.
Owns ONLY: the <ANIM_ID> files in <CHAR_ANIM_HOME> (characters/<ANIM_ID>/, jobs/<ANIM_ID>-core.json,
mocap/<ANIM_ID>-*, out/<ANIM_ID>-core/, build/<ANIM_ID>-core/, build/rig/<ANIM_ID>*),
<ART_PATHS>/<MODEL_FILE>, <ART_PATHS>/<fbf_dir>/**, evidence/art/<STEM>/anim/**,
evidence/art/<STEM>/anim-check.md, and a read-modify-write of THAT ROW ONLY in manifest.json
(anim_verify).

Do:
1. Confirm model-check.md ends VERDICT: PASS. Read the manifest row's `animated`.
2. From the worktree root (the mesh path resolves from cwd):
     <CHAR_ANIM_HOME>/anim character <ART_PATHS>/gen3d/<STEM>/<STEM>.glb --id <ANIM_ID> --name <Stem> \
       --clips <authored clips> --export <export joined by ,> --run
   RIG_REPORT must show pose "A", normalize.scale sane (≈1.7 for a studio glb),
   empty_bone_groups [] and unweighted_vertices 0. A rig failure or pose T/other means the concept
   is wrong → escalation with the RIG_REPORT line (the coordinator reopens art-concept). Never
   hand-edit the mesh.
3. Mocap clips: copy each take to <CHAR_ANIM_HOME>/mocap/<ANIM_ID>-<clip>.<ext>, then run
   `anim inspect` on it. Add the clip with a "source" block (<CHAR_ANIM_HOME>/mocap/README.md §4)
   to jobs/<ANIM_ID>-core.json, then run `anim run jobs/<ANIM_ID>-core.json --clips <clip>`.
   Don't use `anim mocap`: it writes a shared jobs/<clip>.json.
4. Check out/<ANIM_ID>-core/qa.json (verdict pass) and open every
   out/<ANIM_ID>-core/evidence/<clip>-contact-sheet.png. Write evidence/art/<STEM>/anim-check.md:
     ## <STEM> — anim round <n>
     rig: pose <A>, scale <s>, empty groups <[]>, unweighted <0>
     <clip>: QA <pass|fail> — <what the contact sheet shows>   (one line per clip)
     deliverables: <paths>
     ANIM: PASS | ANIM: FAIL — <clip>: <reason>
   Pose / timing fixes → edit that clip in jobs/<ANIM_ID>-core.json, then rerun with --clips <clip>
   (max 2 rounds per clip).
5. Ship. Cocos imports everything under assets/, so copy engine files only:
     fbx → out/<ANIM_ID>-core/fbx/<Stem>.fbx to <ART_PATHS>/<MODEL_FILE> (one take per clip)
     fbf → out/<ANIM_ID>-core/fbf/atlas_*.png + animations.json to <ART_PATHS>/<fbf_dir>
           (NOT animations.js: it would import as a script; NOT frames/)
     evidence → player.html, qa.json, manifest.json, evidence/*.png to evidence/art/<STEM>/anim/
6. Patch only this manifest row:
     "anim_verify": {"status":"PASS","qa":"evidence/art/<STEM>/anim/qa.json",
       "clips": {"<clip>": {"seconds": s, "loop": b, "events": [...]}},   (from the pipeline manifest.json)
       "fbx_axes": "faces +Z, Y up", "round": n}
7. worker_done --files-modified, with the clip table for the implement/integrate handles.

Never: create .meta; open Creator; touch other characters' files in <CHAR_ANIM_HOME>; edit
pipeline code (pipeline bugs go in an escalation); ship with any clip QA fail.
```

---

## art / art-2d (locked art_backend — 2D only, parallel with concepts)

Launch: `cursor` → recipe **A**; `antigravity` / `gpt-image-gen` (codex) → recipe **C** (no
AGENTS.md boot).

```text
ROLE: writer (assets) — 2D textures/sprites only.
Owns: PLAN 2D paths under art_paths (not concepts/, not gen3d/, not .glb).

Do: produce listed 2D files per backend block below; update those manifest rows only.
Never: 3D concepts or meshes (those are art-concept / art-mesh Tasks).
```

### art-2d / antigravity

```text
Produce 2D files with this Antigravity session's own tools.
Also owns evidence/art/2d/2d-check.md (create the dir if needed).

Check, before worker_done:
1. Measure every file you wrote (never guess):
     sips -g pixelWidth -g pixelHeight -g hasAlpha <file>
2. Read every PNG, then write evidence/art/2d/2d-check.md:
     ## 2D — round <n>
     <file>: size <w>x<h> vs row <w>x<h> | alpha yes/no vs row | PASS|FAIL — <reason>
     ...
     size: PASS|FAIL — every file matches its manifest row (or PLAN when the row has none)
     alpha: PASS|FAIL — sprites/icons/UI on transparent background, no matte or halo;
       opaque only when the row says texture/background
     tiling: PASS|FAIL|n/a — rows noted tileable have no visible seam when repeated
     style: PASS|FAIL — vs GAME_BRIEF / PLAN art direction
     set consistency: PASS|FAIL — one palette, outline weight, light direction and
       relative scale across the set
     readability: PASS|FAIL — silhouette and icon meaning hold at in-game size
     ART2D: PASS | ART2D: FAIL — <failing files + reason>
3. ART2D FAIL → regenerate only the failing files and append a new round (max 2 rounds).
   Still FAIL → worker_done --outcome failed listing those files.
4. On PASS set each 2D row's
   "verify": {"status":"PASS","check":"evidence/art/2d/2d-check.md","round":n}.
```

### art-2d / cursor

```text
Produce 2D files with this Cursor session's own tools.
```

### art-2d / gpt-image-gen

```text
Produce every 2D manifest file via the installed orca-gpt-image-gen skill (and
gpt-image-2-style-library when present). Destination = absolute paths under art_paths.
Do not freehand final pixels. Verify each download exists before worker_done.
```

---

## art (legacy single Task — 2D-only features, no meshes)

```text
ROLE: writer (assets). art_backend=<ART_BACKEND>. Owns PLAN.art_paths only
(+ evidence/art/2d/2d-check.md when art_backend=antigravity).

Do, in this order:
1. Write <ART_PATHS>/manifest.json FIRST.
2. status to implement handle.
3. Produce every 2D file (backend-specific; antigravity also runs that block's 2d-check to
   ART2D: PASS). Report the count vs max_assets; over it → note
   `budget_bump` (advisory) — never skip a manifest row to fit.

Never: .meta; Creator; .scene/.prefab; Funplay/refresh_assets; invent 3D here — if PLAN gains
meshes, coordinator must switch to the fan-out Tasks above.
Done: worker_done --files-modified.
```

---

## fix — art variant (3D)

```text
Concept findings → new art-concept-<stem> (antigravity) must re-PASS concept-check before remesh.
Mesh / compare-sheet findings → art-mesh-<stem>: Blender route re-exports; 3dgenstudio route
reruns gen3d_studio.py --source-glb <stem>_high.glb (finishing) or regenerates once when the
silhouette is the finding; both re-run render_model_iso.py with --concepts into round-<n+1>.
Closed only by new CONCEPT: PASS (when needed) + VERDICT: PASS with both sheets on disk.
Animation findings (pose, timing, events, clipping) → art-anim-<stem>: edit the clip in
jobs/<ANIM_ID>-core.json, then `anim run --clips <clip>`, re-ship, and write a new anim-check round.
A new mesh or concept invalidates the rig: rerun the full art-anim (`anim character ... --run`
rebuilds the rig). Closed only by ANIM: PASS.
```
