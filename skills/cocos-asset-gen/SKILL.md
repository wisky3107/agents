---
name: cocos-asset-gen
description: >-
  Art/asset generation contract for Cocos Creator projects: locks the 2D art backend
  (antigravity | cursor | gpt-image-gen), runs the 3D pipeline (Antigravity concept pack →
  mesh → iso/compare verify), and routes each mesh to a mesh backend — Blender python
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
| `art_backend` | `antigravity` | `antigravity` · `cursor` · `gpt-image-gen` | who authors 2D files and Blender mesh generators |
| `mesh_backend` | `auto` | `auto` · `blender` · `3dgenstudio` | how `.glb` meshes are produced (see routing) |

Synonyms at first resolve only: `agy` → `antigravity`; `gpt image` / `chatgpt image` /
`orca-gpt-image-gen` → `gpt-image-gen`; `3dgs` / `gen studio` / `tripo` → `3dgenstudio`;
`script` / `bpy` → `blender`. Announce `Art: backend=<v> · mesh=<v>` once; never re-ask or
switch mid-task. `gpt-image-gen` without the `orca-gpt-image-gen` skill installed → one `ask`
to pick `antigravity` or `cursor`.

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
art-manifest → art-concept-<stem> (ALWAYS antigravity) ──CONCEPT: PASS──▶ art-mesh-<stem>
                                                                            │ route (below)
                                                                            ▼
                                                    render_model_iso.py → model-check.md → VERDICT
```

Concept pack: `concept-front.png`, `concept-threequarter.png`, `concept-back.png`
(`concept-turnaround.png` optional) authored **only** with Antigravity's own image tools, then
`evidence/art/<stem>/concept-check.md` ending `CONCEPT: PASS|FAIL` (max 2 rounds). No PASS →
no mesh. The concept-front is also the image-to-3D input for the studio route.

### Mesh routing (`mesh_backend`)

```
mesh_backend = blender      → Blender route, no probe
mesh_backend = 3dgenstudio  → probe; unavailable → ask once, or Blender if director pre-approved fallback
mesh_backend = auto (default):
    complexity == simple    → Blender route
    complexity == complex   → probe gen3d_studio.py --check
                                exit 0 → 3D Gen Studio route
                                exit 2 → Blender route (record "fallback: studio unavailable")
```

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

Unchanged from the classic fleet flow: `art_paths/gen_<stem>_*.py` reproducible generator that
cites the concept paths, exports `art_paths/<stem>.glb` at manifest dims/pivot/forward, then
verify (below). Blender missing → one `ask`.

### Route B — 3D Gen Studio (complex)

Precondition (the `--check` probe does all of it): 3D Gen Studio desktop app running (backend
`http://127.0.0.1:3001`, port auto-discovered from its `runtime.json`), **Tripo AI API key**
set in Settings → Tripo AI, Mesh Tools python service up (`:8200`; without it bake/collision
are skipped and reported). ComfyUI is **not** required for this route.

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
  --concepts <art_paths>/concepts/<stem>
```

Writes `iso-{ne,nw,sw,se}.png`, `contact-sheet.png`, `match-*.png`, `compare-sheet.png`
(concept | model rows), `stats.json`. The worker **Reads** contact-sheet, compare-sheet,
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
concept, then `ask` with the sheets. PASS → patch only this manifest row:
`"verify": {"status":"PASS","route":"<route>","evidence":"<contact-sheet>","compare":"<compare-sheet>","concept":"<concept-front>","round":n}`.

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
tools; `gpt-image-gen` **must** go through `orca-gpt-image-gen` (+ `gpt-image-2-style-library`
when present) — no freehand final pixels. Textures/sprites only; concepts and meshes are never
produced here. Every file counts against `max_assets`.

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
- Silently switching to Blender after a studio failure with exit `3` (a real error) — exit `2`
  is the only automatic fallback; `3` needs the report read and, if unclear, an `ask`.
- Regenerating with Tripo to fix a finishing problem (costs credits) instead of
  `--source-glb <stem>_high.glb`.
- Giving 3D concepts to ChatGPT / `orca-gpt-image-gen`; concepts are Antigravity-only.
- `VERDICT: PASS` without opening `compare-sheet.png`, or `concept match: PASS` from stats alone.
- Two workers sharing a stem's paths, or a shared `model-check.md` across stems.

## Resources

- [reference/worker-prompts-art.md](reference/worker-prompts-art.md) — dispatch specs for
  `art-manifest`, `art-concept-<stem>`, `art-mesh-<stem>` (both routes), `art-2d`, legacy `art`.
- [reference/3dgenstudio-walkthrough.md](reference/3dgenstudio-walkthrough.md) — Mac setup,
  MCP hookup, REST endpoints, and the measured robot run (501k → 12.5k tris) this route is
  calibrated on.
- [scripts/gen3d_studio.py](scripts/gen3d_studio.py) — execute; `--check` / `--image` /
  `--prompt` / `--source-glb`; exit 0/2/3.
- [scripts/render_model_iso.py](scripts/render_model_iso.py) — execute under headless Blender;
  iso views, concept-angle match, compare-sheet, `stats.json`.
- `../cocos-orca-fleet/SKILL.md` — Task topology, DAG, and locks that call into this skill.
