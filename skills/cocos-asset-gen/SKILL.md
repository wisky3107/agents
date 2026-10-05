---
name: cocos-asset-gen
description: >-
  Art/asset generation contract for Cocos Creator projects: locks the 2D art backend
  (antigravity | cursor | gpt-image-gen | codex-image), runs the 3D pipeline (concept pack from
  Antigravity or Codex image → mesh → iso/compare verify), and routes each mesh to a mesh backend — Blender python
  generator for simple hard-surface props, 3D Gen Studio (Tripo cloud + local mesh tools:
  simplify, LOD, pivot, bake, collision) for complex/organic models, with automatic fallback
  to Blender when the studio is unavailable. Use when a fleet or single agent must produce
  textures, sprites, concepts, or .glb meshes under art_paths, or when the director says
  "gen assets", "3D Gen Studio", "Tripo", "mesh backend", "game-ready mesh".
disable-model-invocation: true
---

# Cocos Asset Gen

Owns everything under `PLAN.art_paths`: 2D files, 3D concept packs, meshes, and their evidence.
Called by `cocos-orca-fleet` (which wires the Tasks) or directly by a single agent doing an
art-only slice. Hard rules inherited from the fleet: art never creates `.meta`, never opens
Creator, never touches `.scene`/`.prefab`, never calls Funplay / `refresh_assets`. Non-Cursor
art workers launch with fleet **recipe C** — no AGENTS.md startup boot; the art spec is the
first turn (see `cocos-orca-fleet` Worker start recipes).

## Locks (resolve once, prompt > `AGENT_NOTES.md` > default)

| Key (`fleet:` yaml) | Default | Values | Meaning |
|---|---|---|---|
| `art_backend` | `antigravity` | `antigravity` · `cursor` · `gpt-image-gen` · `codex-image` | who makes concepts and 2D files |
| `mesh_backend` | `auto` | `auto` · `blender` · `3dgenstudio` | how `.glb` meshes are produced (see routing) |
| `mesh_agent` | `claude --model opus` | a fleet launch spec (`claude --model <m> [--effort <e>]` · `codex` · `cursor --model <m>` · `antigravity`) · `art_backend` | who runs `art-mesh-<stem>` and `art-anim-<stem>`: writes the Blender generator, runs the studio route, judges the sheets |

Synonyms at first resolve only: `agy` → `antigravity`; `gpt image` / `chatgpt image` /
`orca-gpt-image-gen` → `gpt-image-gen`; `codex image` / `omniroute image` / `codex-image-gen` →
`codex-image`; `3dgs` / `gen studio` / `tripo` → `3dgenstudio`; `script` / `bpy` → `blender`;
`mesh_agent` `opus` / bare `claude` → `claude --model opus`, `agy` → `antigravity`, and
`art_backend` → the agent that `art_backend` launches (the pre-2026-10 behaviour).
Announce `Art: backend=<v> · mesh=<v> · mesh_agent=<spec>` once; never re-ask or switch mid-task. `gpt-image-gen`
without the `orca-gpt-image-gen` skill installed, or `codex-image` when
`node ~/.agents/skills/codex-image-gen/scripts/codex-image.mjs check` exits 2 → one `ask` to
pick another backend. `mesh_agent` on Cursor with Cursor off → `claude --model opus`, said in
the announce line (unlike `art_backend`, a mesh worker needs no image tools, so claude is a
full substitute).

**Why `mesh_agent` defaults to Opus.** Two blind A/B rounds on 8 meshes (2026-10-05,
`~/Works/games/pilots/opus-bpy-2026-10-05` and `…-r2-2026-10-05`, `results/results.md`): four
simple cc-bus-fever-party meshes and four coloured hard-surface ones (fire truck, double-decker,
kiosk, boom barrier), same spec for both arms. The director picked the Opus generator 7 times,
tied once and never picked Antigravity; Opus meshes were shippable 7/8 against 6/8. Opus took
~8 min a mesh against ~14 for Antigravity (Gemini 3.8 Flash), ~100–140k tokens, with generators
half as long and 1–5 nodes per mesh instead of up to 45.

**OpenAI image lanes.** `gpt-image-gen` splits by row with the `codex-image-gen` "Pick the
backend" rule: rows with `"tier": "hero"` go through `orca-gpt-image-gen` (ChatGPT,
GPT Image 2.5), and every other `image-gen` row goes through `codex-image-gen` as a batch. If the
Codex lane is down (`check` exit 2), every row goes through `orca-gpt-image-gen`. `codex-image`
sends every row, hero included, through `codex-image-gen`.

## Existing assets and port imports

Resolve ASSET_MANIFEST Source before selecting a generation backend. Source=import means
copy/convert the exact referenced raw asset into its allowlisted runtime destination, record
source path/hash and conversion, and inspect it. This applies to sprites, fonts, meshes,
VFX and existing animation clips. Integrator owns editor import and .meta generation.
Imported meshes bypass concept creation, Tripo/Blender generation and studio availability
probes; verify scale/pivot/axis, topology, materials/textures, budget and reference appearance.
Use source asset/store evidence for comparison and record route=import with VERDICT PASS/FAIL.
Use de-atlased PNGs; a packed legacy atlas needs the rip de-atlas pipeline, not manual cropping.
Only missing/inadequate assets explicitly marked generate follow the pipeline below.

## 3D generation pipeline (per stem, parallel across stems)

```
art-manifest → art-concept-<stem> (concept route) ──CONCEPT: PASS──▶ art-mesh-<stem>
                                                                            │ route (below)
                                                                            ▼
                                                    render_model_iso.py → model-check.md → VERDICT
```

An **animated / rigged character** (skinned FBX clips or frame-by-frame sprites) is a `char-anim`
chain: an A-pose rig-ready concept, this studio mesh route, then char-anim-pipeline. See
`~/.agents/skills/char-anim/SKILL.md`.

Concept pack: `concept-front.png`, `concept-threequarter.png`, `concept-back.png`
(`concept-turnaround.png` optional), then `evidence/art/<stem>/concept-check.md` ending
`CONCEPT: PASS|FAIL` (max 2 rounds). No PASS → no mesh. The concept-front is also the
image-to-3D input for the studio route.

The concept check also measures proportions, because neither the worker nor a reviewer judges
them reliably by eye:
`python3 <scripts>/concept_ratio.py --image <concepts>/<stem>/concept-front.png --expect-dims "<x,y,z>" --forward <f>`.
It compares the subject's width:height with the manifest row's. Exit 1 → `proportions: WARN`
with the measured ratio and `height_for_concept`. The coordinator then picks the manifest size
or the concept's ratio before the mesh starts, so the mesh worker never has to choose. On the
2026-10-05 pilots it flagged env_lot (thick tray vs a 0.1 m slab, unshippable in both arms),
bus_small and double_decker, and confirmed the pig at 0.5 × 0.5.

**Concept route** (who makes the pack):
- `art_backend` `antigravity` or `cursor` → an Antigravity worker with its own image tools.
  When that image tool returns HTTP 429 or a quota error, the same worker makes the pack with
  `codex-image-gen` and notes `backend: codex-image (antigravity 429)` in concept-check.md.
  If the Codex lane is down too (`codex-image.mjs check` exits 2), the worker does not wait: it
  sends the coordinator one `ask` naming both lanes' state, the earliest `until` from
  `node ~/.agents/tools/agy-account/agy-account.mjs status` and whether any account is still
  unexhausted, and waits. The coordinator opens one gate for the director and replies
  `wait until <ts>` or `exception: <lane> for <stem>` (a written exception for that stem). ChatGPT
  stays off the concept route unless that gate grants it (cc-lego-stack S11 sat ~5 h on a silent
  Antigravity wait, 2026-10-05).
- `art_backend` `gpt-image-gen` or `codex-image` → a codex worker running `codex-image-gen`.
  The front is a generation; the ¾ and back views are edits that take `concept-front.png` as
  the reference. If `check` exits 2 mid-run, the worker sends the same single `ask` instead of
  waiting.
- Never ChatGPT / `orca-gpt-image-gen`: each browser chat makes one image and cannot hold a
  design across views. Only a director gate can grant a written exception for one slice.

### Mesh routing (`mesh_backend`)

```
mesh_backend = blender      → Blender route, no probe
mesh_backend = 3dgenstudio  → probe; unavailable → ask once, or Blender if director pre-approved fallback
mesh_backend = auto (default):
    complexity == simple    → Blender route
    complexity == complex   → probe gen3d_studio.py --check
                                exit 0 → 3D Gen Studio route
                                exit 2 → PLAN fallback_ok: true → Blender route (record
                                         "fallback: studio unavailable"); otherwise one ask
```

**Studio down for a complex mesh is a director decision.** Blender is a full substitute for
hard-surface shapes. For organic ones it gives a block-out: the 2026-10-05 pig came out with
slab ears and a boxy body. So the coordinator probes once at Step 0.2 and, when the studio is down
and the PLAN has complex Source=generate meshes, asks once for all of them: "open 3D Gen Studio
and re-probe, or accept a Blender block-out for <stems>". The answer goes into the PLAN as
`fallback_ok: true|false`, and mesh workers read it instead of asking again.

`complexity` is set per manifest row by `art-manifest` (`"complexity": "simple" | "complex"`).
Missing → the mesh worker classifies from the concept + row `notes` and writes the value back
into its own row.

| `simple` (Blender) | `complex` (3D Gen Studio) |
|---|---|
| hard-surface props buildable from ≤ ~8 primitives + booleans/bevels: crates, coins, gates, rings, platforms, tiles, pickups, simple ships/vehicles with flat panels | organic or character-like: bodies, faces, hair, cloth, creatures, plants, detailed vehicles, anything the concept shows with curved sculpted surfaces or dense surface detail |
| flat/vertex colour or a single tiling material is enough | needs a baked/painted texture to read at all |
| exact dims / pivot / modular snapping matter more than surface fidelity | silhouette fidelity to the concept matters more than exact dims |

Ties → `simple` (cheaper, deterministic, no credits). The chosen route and the reason go into
`model-check.md` as `route: blender | 3dgenstudio — <reason>`.

### Route A — Blender generator (simple, or fallback)

The `mesh_agent` worker writes `art_paths/gen_<stem>_*.py`: a reproducible generator that
cites the concept paths, builds from a factory-empty scene, and exports `art_paths/<stem>.glb`
at manifest dims/pivot/forward, then verify (below). Blender missing → one `ask`.

Generator habits that held up in the pilot:
- Few nodes: one body mesh plus a separate node only where the manifest asks for one (a decal
  plate, a part the code moves). Windows, lamps and grilles are cut into the body shell, not
  closed boxes with hidden backs. Fewer nodes mean fewer draw calls.
- Bevel with per-edge bevel weights. A bevel with `clamp_overlap` shrinks to the shortest edge.
- A closed part's signed volume must be positive. Have the generator check it and fail loudly.
- Spend the triangle budget where the game camera sees it, and print tris per part while
  tuning.

### Route B — 3D Gen Studio (complex)

Precondition (the `--check` probe does all of it): 3D Gen Studio desktop app running (backend
`http://127.0.0.1:3001`, port auto-discovered from its `runtime.json`), **Tripo AI API key**
set in Settings → Tripo AI, enough **Tripo credits** for one generation (the probe reads the
account balance; short → exit 2, which goes to the `fallback_ok` question like a closed studio),
Mesh Tools python service up (`:8200`; without it bake/collision are skipped and reported).
ComfyUI is **not** required for this route. The coordinator may open the app itself
(`open -a "3D Gen Studio"`, then wait for `/api/health`) before probing; it never buys credits.
Studio errors carry the server's reason (e.g. "not enough credit"), not a bare HTTP 500.

```bash
GEN3D=.cursor/skills/cocos-asset-gen/scripts/gen3d_studio.py
python3 "$GEN3D" --check || { echo "studio unavailable → Blender route"; }

python3 "$GEN3D" \
  --image  <art_paths>/concepts/<stem>/concept-front.png \   # or --prompt "<text>" when no concept
  --stem   <stem> \
  --out-dir <art_paths>/gen3d/<stem> \
  --evidence-dir .cursor/evidence/tasks/<T>/art/<stem> \
  --project "<game slug>" \
  --target-tris <from manifest tri_budget, default 12000> \
  --lod-ratios 0.5,0.25,0.12 \
  --collision decomposition            # convex_hull | box | none for tiny props
cp <art_paths>/gen3d/<stem>/<stem>.glb <art_paths>/<MODEL_FILE>
```

What the script does (all through the studio's REST + mesh-tools API, stdlib python):
Tripo image→3D (≈30 credits standard texture; `--tripo-no-texture` 20) → high-poly kept as
`<stem>_high.glb` → gltfpack simplify to `--target-tris` (LOD0) → LOD1..n cut from LOD0 →
ground pivot on every level → bake **normal + AO** high→LOD0 and embed into `<stem>.glb` →
CoACD collision `<stem>_collision.glb` → `gen3d-report.json`. Exit `2` = studio unavailable
(fall back to Blender), `3` = a step failed (read the report `error`; do not retry blindly).

Read `gen3d-report.json` before verify: `steps.simplify.seam_limited` false, `steps.bake.coverage`
≥ 0.95, `game.triangles` ≤ budget, `game.world_bounds_after_pivot.min[1] == 0`. Coverage
< 0.95 or seam-limited → rerun with `--no-seam-breaking` off/on or a higher `--target-tris`, max
2 reruns, then `ask`. Every rerun costs credits only if you regenerate; reuse the high-poly with
`--source-glb <stem>_high.glb` for finishing-only reruns (free).

Credits budget: text→3D 20, image→3D 30, `--tripo-texture-quality detailed` +10,
`--tripo-smart-low-poly` +10. Log the estimate from the report in `model-check.md`. Free tier is
a one-time grant; the coordinator's PLAN `change_budget` should carry a `tripo_credits` cap when
more than ~5 complex meshes are planned.

### Verify (both routes)

```bash
BLENDER="${BLENDER_BIN:-$(command -v blender || echo /Applications/Blender.app/Contents/MacOS/Blender)}"
"$BLENDER" --background --python .cursor/skills/cocos-asset-gen/scripts/render_model_iso.py -- \
  --input <art_paths>/<MODEL_FILE> \
  --out .cursor/evidence/tasks/<T>/art/<stem>[/round-<n>] \
  --expect-dims "<x,y,z from manifest>" \
  --forward <manifest forward, e.g. -Z> \
  --concepts <art_paths>/concepts/<stem>
```

Writes `iso-{ne,nw,sw,se}.png`, `contact-sheet.png`, `match-*.png`, `compare-sheet.png`
(concept | model rows), `stats.json`. `expect_dims` is glTF order (x width, y height, z depth),
which the script reads by default; `--forward` places the front / three-quarter / back cameras
on the side the model faces. Workbench shows vertex colours only when every mesh has them;
`render_notes` in stats.json says when to re-render with `--engine eevee` to judge colour. The
normals flag counts closed parts that are inside out (negative volume) and edges between faces
of opposite winding; a ring, a concave shape or an inner wall no longer trips it. The worker **Reads** contact-sheet, compare-sheet,
stats.json and the concept PNGs, then writes `evidence/art/<stem>/model-check.md`:

```
## <MODEL_FILE> — round <n>
route: blender | 3dgenstudio — <reason / fallback note>
source: gen_<stem>.py | gen3d-report.json (high 501k tris → game 12k, bake coverage 1.0, ~30 credits)
views: <contact-sheet>   compare: <compare-sheet>   stats: <stats.json>
topology / holes-hollow / normals / scale / silhouette / style fit: PASS|FAIL
tri budget: PASS|FAIL — <n> ≤ <budget>; LODs <n1,n2,n3>; collision <parts>
concept match: PASS|FAIL — cite front / threequarter / back rows
pivot/axis: PASS|FAIL
VERDICT: PASS | VERDICT: FAIL — <reason>
```

Topology CLEAN that fails a compare-sheet row is still FAIL. Max 3 mesh rounds after a PASSed
concept, then `ask` with the sheets.

**Look check (independent, advisory).** After the worker's own `VERDICT: PASS`, a fresh session
that did not build the mesh reviews the same sheets:
`python3 <scripts>/look_check.py --stem <stem> --concepts <concepts dir> --render <round dir> --out evidence/art/<stem>/look-check.md --dims "<x,y,z>" --tri-budget <n> --features "<signature features from concept-check>" --round <n>`
(`claude -p --model sonnet`, Read only; exit 0 PASS, 1 FAIL, 2 judge unavailable). A LOOK FAIL
with rounds left counts as a failed round: fix its items. After the last round the worker keeps
its own verdict, but copies the open LOOK items into model-check.md, each with a one-line reason
it ships anyway, and the reviewer decides. It is advisory, not a gate, because it is stricter
than the director. Calibrated 2026-10-05 on 8 director-labelled meshes, it agreed on 5: it caught
2 of the 3 unshippable meshes and failed 3 of the 5 shippable ones. An Opus judge was stricter
still. Its value is the defect list, such as floating fragments, notches and mis-seated parts,
that a self-graded worker skips.

PASS → patch only this manifest row:
`"verify": {"status":"PASS","route":"<route>","evidence":"<contact-sheet>","compare":"<compare-sheet>","concept":"<concept-front>","round":n,"look":"PASS|FAIL (advisory)|not run"}`.
`look` repeats the last look check so the integrator and reviewer see a disputed mesh in the
manifest without opening look-check.md.

### Game-ready budgets (what the studio route enforces, what the Blender route must respect)

| Target | Hero / character | Prop | Mobile batch / far LOD |
|---|---|---|---|
| Triangles (LOD0) | 15k–40k | 1k–8k | 0.5k–5k |
| Texture | 1–2K | 512–1K | 256–512 |
| Materials | 1–2 | 1 | 1 |

Plus: pivot on the ground (props/characters) or bbox centre (spinning pickups); 1 unit = 1 m;
LOD chain ≈ 100/50/25/12 %; collision from a hull scene, never the render mesh; a mesh straight
from Tripo (≈250k verts / 500k tris) is a **source**, never an asset — always finish it.

## 2D art (`art` / `art-2d` Tasks)

Per locked `art_backend`: `antigravity` and `cursor` author raw files with the session's own
tools; `gpt-image-gen` and `codex-image` **must** put every `image-gen` row through their
lanes (OpenAI image lanes above; `gpt-image-2-style-library` when present) — no freehand final
pixels. Textures/sprites
only; concepts and meshes are never produced here. Every file is reported against `max_assets`
(an estimate in advisory mode — never drop a manifest row to fit).

Each 2D row has a `method`, written by `art-manifest`. The art worker does not change it. If a
row needs a different method, the worker sends an `ask`.

| `method` | Use for | How |
| --- | --- | --- |
| `image-gen` | anything that depicts something: character/item sprites, icons with a picture, backgrounds, painted textures, illustrated VFX | the backend's image-generation tool (`gpt-image-gen` → hero rows `orca-gpt-image-gen`, the rest `codex-image-gen`; `codex-image` → `codex-image-gen`) |
| `procedural` | flat geometric UI with no picture: pills, panels, cards, slots, plain buttons, 9-slice frames, rings, glows, soft shadows, gradients | a script (Pillow / SVG), saved as `evidence/art/2d/gen_2d.py` so it can be re-run |
| `acquire` | fonts and other licensed files | download from the official source; record URL, commit/version, sha256 and licence |

Tie → `image-gen` if the file shows an object, character or symbol; otherwise `procedural`.
`art-manifest` marks hero `image-gen` rows `"tier": "hero"`: key art, splash / title, store
art, logo, full-scene backgrounds and character hero art. A row without `tier` (older
manifests) is routed by that same list.

Every 2D backend but `cursor` has a gate: the worker measures each file with `sips` (size, alpha),
Reads every PNG, and writes `evidence/art/2d/2d-check.md` (size / alpha / tiling / style /
set consistency / readability / method) ending `ART2D: PASS|FAIL`, max 2 rounds regenerating
only the failing files. PASS → each 2D row gets `verify`, including the `tool` that actually
made the file. No `ART2D: PASS` → the integrator does not import those files.

## Manifest row (2D)

```json
{ "file": "ui/hud_pill.png", "size": [560, 192], "alpha": true, "method": "procedural",
  "notes": "cream pill, ink outline, 9-slice 24px", "verify": null }
```

## Manifest row (mesh)

```json
{ "file": "player_ship.glb", "format": "glb", "expect_dims": [1.2, 0.4, 2.0], "pivot": "ground",
  "forward": "-Z", "intended_node": "Player/ShipMesh", "complexity": "complex",
  "tri_budget": 12000, "notes": "sleek racer, two engines", "concepts": [], "verify": null }
```

`art-manifest` writes the skeleton (all rows); each mesh worker read-modify-writes **only its
row** (`complexity` if missing, `concepts`, `verify`).

## Anti-patterns

- Sending a 500k-tri Tripo output into `art_paths/<stem>.glb` without the finishing pass.
- Choosing `3dgenstudio` for a crate "because it looks nicer" — simple → Blender, always.
- Silently switching to Blender after a studio failure. Exit `2` falls back only with PLAN
  `fallback_ok: true`; exit `3` is a real error that needs the report read and, if unclear, an `ask`.
- Shipping a `VERDICT: PASS` over a LOOK FAIL without listing the open items in model-check.md.
- Regenerating with Tripo to fix a finishing problem (costs credits) instead of
  `--source-glb <stem>_high.glb`.
- Giving 3D concepts to ChatGPT / `orca-gpt-image-gen`; concepts follow the concept route.
- `VERDICT: PASS` without opening `compare-sheet.png`, or `concept match: PASS` from stats alone.
- `ART2D: PASS` from file names or prompts alone, without `sips` numbers and a Read of each PNG.
- Drawing an `image-gen` row with a Pillow/SVG/canvas script, or recording only
  `route: antigravity` so the manifest hides how the file was made.
- Two workers sharing a stem's paths, or a shared `model-check.md` across stems.

## Resources

- [reference/worker-prompts-art.md](reference/worker-prompts-art.md) — dispatch specs for
  `art-manifest`, `art-concept-<stem>`, `art-mesh-<stem>` (both routes), `art-2d`, legacy `art`.
- [reference/3dgenstudio-walkthrough.md](reference/3dgenstudio-walkthrough.md) — Mac setup,
  MCP hookup, REST endpoints, and the measured robot run (501k → 12.5k tris) this route is
  calibrated on.
- [scripts/gen3d_studio.py](scripts/gen3d_studio.py) — execute; `--check` / `--image` /
  `--prompt` / `--source-glb`; exit 0/2/3.
- [scripts/concept_ratio.py](scripts/concept_ratio.py) — execute; concept width:height vs
  manifest `expect_dims` (exit 0 agree, 1 WARN, 2 error).
- [scripts/look_check.py](scripts/look_check.py) — execute; independent advisory look check
  through `claude -p` (exit 0 PASS, 1 FAIL, 2 judge unavailable).
- `../cocos-orca-fleet/SKILL.md` — Task topology, DAG, and locks that call into this skill.
- [scripts/render_model_iso.py](scripts/render_model_iso.py) — execute under headless Blender;
  iso views, concept-angle match, compare-sheet, `stats.json`.
