# 3D Gen Studio — setup, agent access, and the calibrated robot run

Source: [visualbruno/3DGenStudio](https://github.com/visualbruno/3DGenStudio) v3.3.1. Electron
desktop app; Node/Express backend serves the UI + REST API on `:3001` (SQLite), a Python
FastAPI **mesh-tools** service on `:8200` (Blender `bpy`, gltfpack, CoACD), optional rigging
service `:8300`, optional ComfyUI `:8188` for local image/3D models.

## 1. Mac install (Apple Silicon, tested M1 Pro 16 GB, macOS 26)

```bash
# app
open ~/Downloads/3DGenStudio-<ver>-mac-arm64.dmg   # drag to /Applications
xattr -dr com.apple.quarantine "/Applications/3D Gen Studio.app"
codesign --force --deep --sign - "/Applications/3D Gen Studio.app"
# mesh tools need python 3.13 (bpy >= 5.0)
brew install python@3.13
# first launch creates ~/Library/Application Support/3DGenStudio/python-venv and installs deps
```

Data root: `~/Library/Application Support/3DGenStudio/data/` (`app.db`, `assets/`,
`runtime.json` = `{"port":3001,"origin":"http://127.0.0.1:3001"}`). Logs one level up in
`logs/{desktop,backend,python}.log`. 16 GB Macs: use cloud providers for 3D (Tripo / Hunyuan /
Hitem3D) — local Trellis/Hunyuan checkpoints do not fit comfortably.

Health: `GET /api/health` → `{ok,version,mode}`; mesh tools `GET :8200/health` → `{status:"ok"}`.

## 2. Agent access

- **MCP**: stateless Streamable-HTTP `POST http://127.0.0.1:3001/mcp` (stdio bridge
  `Contents/Resources/app/mcp/stdio.js`). ~67 tools in groups
  `projects,cards,graph,workflows,actions,mesh,tree,assets,settings` (~25k tokens if all
  loaded) — filter with `?tools=projects,graph,actions,assets,workflows`. Loopback-only unless
  `settings.mcp.token` is set. Cursor: `~/.cursor/mcp.json` →
  `"3d-gen-studio": {"url": "http://127.0.0.1:3001/mcp?tools=..."}`.
- **REST** (what `gen3d_studio.py` uses; no MCP client needed):

| Step | Endpoint | Notes |
|---|---|---|
| settings | `GET/PUT /api/settings` | `apis.tripoai.apiKey`, `apis.meshtools.{url,port}`, `mcp.enabled` |
| project | `GET /api/projects`, `POST /api/projects {name,description,preset:"Graph"}` | |
| upload concept | `POST /api/assets/upload` multipart `file,projectId,type=image,name,metadata` | returns asset `id` |
| generate | `POST /api/meshes/generate {projectId,selectedApi:"tripo_meshgeneration",name,prompt?,imageSource?,texture,pbr,textureQuality,modelVersion,smartLowPoly,faceLimit?}` | `{status:"queued",taskId,cardId}` |
| poll | `POST /api/meshes/generate/tripo/result {projectId,name,taskId,cardId,selectedApi,prompt}` | until `status:"completed"` → `assets[]`; download `GET /assets/<filename>` |
| list assets | `GET /api/assets?projectId=…` | (`/api/projects/:id/assets` is not JSON) |
| simplify / LOD | `POST /api/meshes/lods` multipart `meshFile` + `options={ratios[],simplify_error,allow_seam_breaking,aggressive,permissive,lock_border}` | `lods[{level,ratio,achieved_ratio,seam_limited,triangles,mesh_b64,passthrough}]`; ratio floor **0.01** |
| pivot | `POST /api/meshes/pivot` multipart + `options={mode:"ground_pivot"}` | `{mesh_b64,stats{moved,offset,bounds_after}}` — moves the node transform, not vertices |
| bake | `POST :8200/meshes/bake` SSE multipart `meshFile`(low) `sourceFile`(high) `options={maps:["normal","ao"],resolution,samples,align_source:true,…}` | `done.maps{normal,ao}` b64 PNG, `stats.tool.coverage` |
| collision | `POST :8200/meshes/collision` SSE multipart `meshFile,options={method,max_hulls,…},format=glb` | `done.mesh_b64`, `stats.tool{parts,faces,volume_ratio}` |
| save version | `POST /api/meshes/editor/save` fields `assetId,filePath:'',name,saveMode:'version',meshFile` | optional bookkeeping |

SSE shape: `data: {"type":"progress"|"done"|"error", ...}` events separated by blank lines.
Other mesh-tools endpoints available for edge cases: `/meshes/inspect`, `/meshes/repair`,
`/meshes/auto-uv`, `/meshes/auto-retopo`, `/meshes/convert`.

## 3. Cloud provider choice

| Provider | Free credits | Cost | Verdict |
|---|---|---|---|
| **Tripo AI** | 2000 on first API key | $0.01/credit · text→3D 20 (textured) / 10 · image→3D 30 / 20 · `detailed` texture +10 · smart low-poly +10 | default — cheapest to try, ~70 s per model |
| Tencent Hunyuan | trial quota via Tencent Cloud | per-call | needs secretId/secretKey |
| Hitem3D | small trial | per-call | access/secret/token |

## 4. Calibrated run (what the defaults are tuned on)

Prompt `"cute red robot"` → Tripo v2.5, standard PBR texture, ~70 s, 20 credits.

| Stage | Result |
|---|---|
| Raw Tripo GLB | 14.4 MB, **263,099 verts / 501,216 tris**, 1 material, 3 textures — not a game asset |
| gltfpack simplify (seam-breaking, err 0.2) → LOD0 | 8,536 v / **12,530 t** (≈40×), `seam_limited:false` |
| LOD chain from LOD0 at 0.5 / 0.25 / 0.12 | 6,000 / 3,000 / 1,438 tris |
| ground pivot | offset y +0.4998, world min y = 0 |
| bake normal + AO high→low (1024², `align_source`) | coverage **1.0**; embedded → 2.6 MB GLB |
| CoACD collision (decomposition, ≤12 hulls) | 2 hulls / 248 faces, volume ratio 0.88; convex 1 hull; box 12 tris |

Lessons encoded in `gen3d_studio.py`:

- One-step simplify cannot go below 1 % of the source, so LOD1..n are cut from LOD0.
- The pivot tool edits the node transform; accessor `min/max` still show the old bounds — read
  `stats.bounds_after`, not the GLB header.
- Bake needs `align_source:true` because the low-poly was grounded and the high-poly was not.
- Seam-breaking simplify fragments the UV atlas; the baked maps still cover 100 %, but if a
  clean hand-editable atlas is required run `/meshes/auto-uv` on LOD0 and bake again.
- Finishing reruns are free (`--source-glb <stem>_high.glb`); only regeneration costs credits.

## 5. Game-ready checklist the route enforces

1. Triangle budget per asset class (hero 15–40k, prop 1–8k, far LOD ≤ 5k) — `--target-tris`.
2. LOD chain ≈ 100/50/25/12 %.
3. Pivot on the ground; forward axis per manifest; 1 unit = 1 m.
4. Normal + AO baked from the high-poly so the low-poly keeps the surface read.
5. Collision from a hull scene (`_collision.glb`), never the render mesh.
6. Textures ≤ 2K hero / ≤ 1K prop; 1–2 materials.
7. Evidence: `gen3d-report.json` + `render_model_iso.py` sheets + `model-check.md` `VERDICT`.
