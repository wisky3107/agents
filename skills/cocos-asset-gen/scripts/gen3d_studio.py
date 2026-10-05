#!/usr/bin/env python3
"""Generate a game-ready mesh through a running 3D Gen Studio (Tripo cloud API + local mesh tools).

Stdlib only (urllib/json/struct) — runs with any python3, no venv.

Modes
  --check                      probe availability only; exit 0 = usable, 2 = unavailable
  --image <concept.png>        image-to-3D (preferred: use the PASSed concept-front.png)
  --prompt "<text>"            text-to-3D (no concept available)
  --source-glb <high.glb>      skip generation, only run the game-ready finishing pass

Finishing pass (always): simplify to --target-tris, ground pivot, LOD chain, bake normal+AO
from the high-poly onto the low-poly (embedded into the output GLB), collision hulls.

Outputs (under --out-dir, base name = --stem)
  <stem>.glb                 game mesh: <= target tris, pivot on ground, baked normal/AO embedded
  <stem>_high.glb            the generated high-poly (kept for re-bakes)
  <stem>_LOD<n>.glb          LOD chain (LOD1..n; LOD0 == <stem>.glb)
  <stem>_collision.glb       convex hull scene (one node per hull)
  <stem>_normal.png / _ao.png
  gen3d-report.json          every stat the model-check needs (route, tris, coverage, credits hint)

Exit codes: 0 ok · 2 studio unavailable (caller must fall back to Blender) · 3 generation/finish failed · 1 usage.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import platform
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

EXIT_OK, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_FAILED = 0, 1, 2, 3
TRIPO_API_ID = "tripo_meshgeneration"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


# ----------------------------------------------------------------------------- HTTP helpers

def _request(url: str, data: bytes | None = None, headers: dict | None = None, method: str | None = None, timeout: int = 120):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method or ("POST" if data else "GET"))
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        # The studio answers {"error": "..."}: keep the reason (e.g. Tripo "not enough credit"),
        # not just "HTTP Error 500".
        body = exc.read().decode(errors="replace")
        try:
            parsed = json.loads(body)
            reason = parsed.get("error") or parsed.get("message") or body
        except (json.JSONDecodeError, AttributeError):
            reason = body
        raise RuntimeError(f"HTTP {exc.code} from {url}: {str(reason)[:300]}") from exc


def get_json(url: str, timeout: int = 20):
    with _request(url, timeout=timeout) as res:
        return json.loads(res.read().decode())


def post_json(url: str, body: dict, timeout: int = 120):
    data = json.dumps(body).encode()
    with _request(url, data, {"Content-Type": "application/json"}, timeout=timeout) as res:
        return json.loads(res.read().decode())


def _multipart(fields: dict, files: dict):
    boundary = "----Gen3dBoundary" + uuid.uuid4().hex
    body = bytearray()
    for key, value in fields.items():
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
    for name, (filename, content, ctype) in files.items():
        body.extend(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n".encode()
        )
        body.extend(content)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def post_multipart(url: str, fields: dict, files: dict, timeout: int = 600):
    body, headers = _multipart(fields, files)
    with _request(url, body, headers, timeout=timeout) as res:
        return json.loads(res.read().decode())


def post_multipart_sse(url: str, fields: dict, files: dict, timeout: int = 1800, log=print):
    """POST multipart to an SSE endpoint; return the terminal `done` payload."""
    body, headers = _multipart(fields, files)
    headers["Accept"] = "text/event-stream"
    done = error = None
    started = time.time()
    with _request(url, body, headers, timeout=timeout) as res:
        buf = ""
        while True:
            chunk = res.read(4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="replace")
            while "\n\n" in buf:
                event, buf = buf.split("\n\n", 1)
                lines = [ln[5:].strip() for ln in event.split("\n") if ln.startswith("data:")]
                if not lines:
                    continue
                try:
                    payload = json.loads(lines[-1])
                except json.JSONDecodeError:
                    continue
                kind = payload.get("type")
                if kind == "progress":
                    log(f"    [{time.time() - started:6.1f}s] {payload.get('stage')}: {payload.get('message')}")
                elif kind == "done":
                    done = payload
                elif kind == "error":
                    error = payload
    if error:
        raise RuntimeError(error.get("detail") or json.dumps(error))
    if not done:
        raise RuntimeError("SSE stream ended without a done event")
    return done


# ----------------------------------------------------------------------------- GLB helpers

def _glb_parts(data: bytes):
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("GLB: first chunk is not JSON")
    js = json.loads(data[20:20 + json_len])
    bin_off = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<II", data, bin_off)
    if bin_type != 0x004E4942:
        raise ValueError("GLB: second chunk is not BIN")
    blob = bytearray(data[bin_off + 8: bin_off + 8 + bin_len])
    return js, blob


def glb_stats(data: bytes) -> dict:
    js, _ = _glb_parts(data)
    accessors = js.get("accessors", [])
    verts = tris = 0
    attrs: set[str] = set()
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            a = prim.get("attributes", {})
            attrs.update(a.keys())
            if "POSITION" in a:
                verts += accessors[a["POSITION"]]["count"]
            mode = prim.get("mode", 4)
            if "indices" in prim:
                n = accessors[prim["indices"]]["count"]
                tris += n // 3 if mode == 4 else n
            elif "POSITION" in a:
                n = accessors[a["POSITION"]]["count"]
                tris += n // 3 if mode == 4 else n
    mins = maxs = None
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            acc = accessors[prim["attributes"]["POSITION"]]
            if "min" in acc and "max" in acc:
                mn, mx = acc["min"], acc["max"]
                mins = mn[:] if mins is None else [min(mins[i], mn[i]) for i in range(3)]
                maxs = mx[:] if maxs is None else [max(maxs[i], mx[i]) for i in range(3)]
    return {
        "vertices": verts,
        "triangles": tris,
        "bytes": len(data),
        "materials": len(js.get("materials", [])),
        "textures": len(js.get("textures", [])),
        "has_uv": "TEXCOORD_0" in attrs,
        "has_skin": bool(js.get("skins")),
        "animations": len(js.get("animations", [])),
        # accessor-local bounds (node transforms such as a moved pivot are NOT applied)
        "local_bounds_min": mins,
        "local_bounds_max": maxs,
        "dims": [maxs[i] - mins[i] for i in range(3)] if mins and maxs else None,
    }


def _pad4(n: int) -> int:
    return (4 - n % 4) % 4


def embed_maps(glb: bytes, maps: dict[str, bytes]) -> bytes:
    """Attach baked normal / ao PNGs to every material of a GLB (in-place buffer append)."""
    js, blob = _glb_parts(glb)
    images = js.setdefault("images", [])
    textures = js.setdefault("textures", [])
    views = js.setdefault("bufferViews", [])
    materials = js.setdefault("materials", [])
    buffers = js.setdefault("buffers", [{"byteLength": len(blob)}])

    def add_png(png: bytes, name: str) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(png)})
        blob.extend(png)
        images.append({"name": name, "mimeType": "image/png", "bufferView": len(views) - 1})
        textures.append({"source": len(images) - 1, "name": name})
        return len(textures) - 1

    if "normal" in maps:
        idx = add_png(maps["normal"], "BakedNormal")
        for mat in materials:
            mat["normalTexture"] = {"index": idx, "scale": 1.0}
    if "ao" in maps:
        idx = add_png(maps["ao"], "BakedAO")
        for mat in materials:
            mat["occlusionTexture"] = {"index": idx, "strength": 1.0}

    buffers[0]["byteLength"] = len(blob)
    json_bytes = json.dumps(js, separators=(",", ":")).encode()
    json_bytes += b" " * _pad4(len(json_bytes))
    bin_bytes = bytes(blob) + b"\x00" * _pad4(len(blob))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    out += struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
    out += struct.pack("<I4s", len(bin_bytes), b"BIN\x00") + bin_bytes
    return bytes(out)


# ----------------------------------------------------------------------------- Studio discovery

def runtime_dirs() -> list[pathlib.Path]:
    dirs = []
    if os.environ.get("GENSTUDIO_DATA_ROOT"):
        dirs.append(pathlib.Path(os.environ["GENSTUDIO_DATA_ROOT"]) / "data")
    home = pathlib.Path.home()
    system = platform.system()
    if system == "Darwin":
        dirs.append(home / "Library" / "Application Support" / "3DGenStudio" / "data")
    elif system == "Windows" and os.environ.get("APPDATA"):
        dirs.append(pathlib.Path(os.environ["APPDATA"]) / "3DGenStudio" / "data")
    else:
        dirs.append(pathlib.Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "3DGenStudio" / "data")
    return dirs


def candidate_urls() -> list[str]:
    urls: list[str] = []

    def add(u):
        u = str(u).rstrip("/")
        if u and u not in urls:
            urls.append(u)

    if os.environ.get("GENSTUDIO_URL"):
        add(os.environ["GENSTUDIO_URL"])
    for d in runtime_dirs():
        try:
            info = json.loads((d / "runtime.json").read_text())
            if info.get("port"):
                add(info.get("origin") or f"http://127.0.0.1:{info['port']}")
        except (OSError, ValueError):
            pass
    add("http://127.0.0.1:3001")
    return urls


class Studio:
    def __init__(self, base: str, settings: dict):
        self.base = base
        self.settings = settings
        mesh = settings.get("apis", {}).get("meshtools", {})
        mesh_url = mesh.get("url", "http://127.0.0.1")
        # Settings store mesh-tools as seen from the studio's own machine; a remote studio
        # (GENSTUDIO_URL on another host) means its loopback is that host, not ours.
        studio_host = urllib.parse.urlsplit(base).hostname
        if studio_host not in LOOPBACK and urllib.parse.urlsplit(mesh_url).hostname in LOOPBACK:
            mesh_url = f"http://{studio_host}"
        self.meshtools = f"{mesh_url}:{mesh.get('port', '8200')}"

    @property
    def tripo_key(self) -> str:
        return str(self.settings.get("apis", {}).get("tripoai", {}).get("apiKey") or "")

    def meshtools_up(self) -> bool:
        try:
            return get_json(f"{self.meshtools}/health", timeout=5).get("status") == "ok"
        except Exception:
            return False

    def api(self, path: str) -> str:
        return f"{self.base}/api{path}"

    def asset_bytes(self, filename: str) -> bytes:
        rel = str(filename).lstrip("/")
        if rel.startswith("data/assets/"):
            rel = rel[len("data/assets/"):]
        with _request(f"{self.base}/assets/{rel}", timeout=300) as res:
            return res.read()


TRIPO_BALANCE_URL = "https://api.tripo3d.ai/v2/openapi/user/balance"


def tripo_balance(key: str) -> int | None:
    """Credits left on the Tripo account behind the studio's key; None when Tripo can't be asked."""
    try:
        res = get_json_auth(TRIPO_BALANCE_URL, key)
        return int(res["data"]["balance"])
    except Exception:  # noqa: BLE001 — an unknown balance must not block a run that may still work
        return None


def get_json_auth(url: str, key: str, timeout: int = 15):
    with _request(url, headers={"Authorization": f"Bearer {key}"}, timeout=timeout) as res:
        return json.loads(res.read().decode())


def credits_needed(args) -> int:
    """Tripo cost of one generation with these options (walkthrough §3)."""
    credits = 30 if not args.tripo_no_texture else 20
    credits += 10 if args.tripo_texture_quality == "detailed" else 0
    credits += 10 if args.tripo_smart_low_poly else 0
    return credits


def discover(log=print) -> tuple[Studio | None, list[str]]:
    reasons = []
    for url in candidate_urls():
        try:
            health = get_json(f"{url}/api/health", timeout=4)
            if not health.get("ok"):
                reasons.append(f"{url}: health not ok")
                continue
            settings = get_json(f"{url}/api/settings", timeout=10)
            log(f"  studio {url} v{health.get('version')} ({health.get('mode')})")
            return Studio(url, settings), reasons
        except Exception as exc:  # noqa: BLE001 — every probe failure is a reason, not a crash
            reasons.append(f"{url}: {exc}")
    return None, reasons


# ----------------------------------------------------------------------------- Pipeline

def ensure_project(studio: Studio, name: str, log=print) -> int:
    for project in get_json(studio.api("/projects")):
        if project.get("name") == name:
            log(f"  project #{project['id']} '{name}' (reused)")
            return int(project["id"])
    created = post_json(studio.api("/projects"), {"name": name, "description": "cocos-asset-gen", "preset": "Graph"})
    log(f"  project #{created['id']} '{name}' (created)")
    return int(created["id"])


def upload_image(studio: Studio, project_id: int, path: pathlib.Path, log=print) -> int:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    saved = post_multipart(studio.api("/assets/upload"), {
        "projectId": str(project_id), "type": "image", "name": path.stem, "metadata": json.dumps({"source": "concept"}),
    }, {"file": (path.name, path.read_bytes(), mime)})
    log(f"  concept uploaded as image asset #{saved.get('id')}")
    return int(saved["id"])


def generate_tripo(studio: Studio, project_id: int, name: str, *, prompt: str | None, image_asset: int | None,
                   opts: dict, poll_s: int, timeout_s: int, log=print) -> tuple[bytes, dict]:
    body = {"projectId": project_id, "selectedApi": TRIPO_API_ID, "name": name, **opts}
    if prompt:
        body["prompt"] = prompt
    if image_asset is not None:
        body["imageSource"] = image_asset
    submit = post_json(studio.api("/meshes/generate"), body, timeout=300)
    task_id, card_id = submit.get("taskId"), submit.get("cardId")
    if not task_id:
        raise RuntimeError(f"Tripo submit returned no taskId: {submit}")
    log(f"  tripo task {task_id} queued")
    deadline = time.time() + timeout_s
    poll_body = {"projectId": project_id, "name": name, "taskId": task_id, "cardId": card_id,
                 "selectedApi": TRIPO_API_ID, "prompt": prompt or ""}
    while time.time() < deadline:
        time.sleep(poll_s)
        status = post_json(studio.api("/meshes/generate/tripo/result"), poll_body, timeout=120)
        state = status.get("status")
        log(f"    tripo {state} {status.get('taskStatus') or ''} {status.get('progressPercent') or status.get('progress') or ''}")
        if state == "completed":
            assets = status.get("assets") or []
            if not assets:
                raise RuntimeError("Tripo completed without assets")
            asset = assets[0]
            return studio.asset_bytes(asset.get("filename") or asset["filePath"]), {
                "taskId": task_id, "assetId": asset.get("id"), "filePath": asset.get("filePath"),
                "previewImageUrl": (asset.get("metadata") or {}).get("previewImageUrl"),
            }
        if state == "error":
            raise RuntimeError(status.get("error") or "Tripo generation failed")
    raise RuntimeError(f"Tripo task {task_id} still running after {timeout_s}s — re-poll via get_mesh_result")


def simplify_and_lods(studio: Studio, high: bytes, ratios: list[float], simplify_error: float,
                      seam_breaking: bool, log=print) -> list[dict]:
    done = post_multipart(studio.api("/meshes/lods"), {"options": json.dumps({
        "ratios": ratios, "simplify_error": simplify_error, "allow_seam_breaking": seam_breaking,
        "aggressive": seam_breaking, "permissive": False, "lock_border": False,
    })}, {"meshFile": ("high.glb", high, "model/gltf-binary")}, timeout=900)
    levels = []
    for lod in done.get("lods", []):
        buf = high if lod.get("passthrough") or not lod.get("mesh_b64") else base64.b64decode(lod["mesh_b64"])
        levels.append({"level": lod.get("level"), "ratio": lod.get("ratio"), "achieved_ratio": lod.get("achieved_ratio"),
                       "seam_limited": lod.get("seam_limited"), "buffer": buf, **glb_stats(buf)})
        log(f"  LOD{lod.get('level')} ratio={lod.get('ratio')} tris={levels[-1]['triangles']} seam_limited={lod.get('seam_limited')}")
    if not levels:
        raise RuntimeError("/meshes/lods returned no levels")
    return levels


def ground_pivot(studio: Studio, mesh: bytes, log=print) -> tuple[bytes, dict]:
    done = post_multipart(studio.api("/meshes/pivot"), {"options": json.dumps({"mode": "ground_pivot"})},
                          {"meshFile": ("mesh.glb", mesh, "model/gltf-binary")}, timeout=300)
    stats = done.get("stats") or {}
    log(f"  pivot moved={stats.get('moved')} offset={stats.get('offset')}")
    return (base64.b64decode(done["mesh_b64"]) if done.get("mesh_b64") else mesh), stats


def bake(studio: Studio, low: bytes, high: bytes, resolution: int, log=print) -> tuple[dict[str, bytes], dict]:
    done = post_multipart_sse(f"{studio.meshtools}/meshes/bake", {"options": json.dumps({
        "maps": ["normal", "ao"], "resolution": resolution, "samples": 8, "cage_extrusion": 0,
        "max_ray_distance": 0, "margin": 8, "align_source": True, "require_overlap": 0.3,
    })}, {"meshFile": ("low.glb", low, "model/gltf-binary"), "sourceFile": ("high.glb", high, "model/gltf-binary")},
        timeout=3600, log=log)
    maps = {k: base64.b64decode(v) for k, v in (done.get("maps") or {}).items()}
    stats = (done.get("stats") or {}).get("tool") or done.get("stats") or {}
    log(f"  bake coverage={stats.get('coverage')} maps={list(maps)}")
    return maps, stats


def collision(studio: Studio, low: bytes, method: str, max_hulls: int, log=print) -> tuple[bytes, dict]:
    opts = {"method": method, "max_hulls": max_hulls, "threshold": 0.3, "input_faces": 1500, "max_hull_vertices": 64,
            "resolution": 800, "mcts_nodes": 6, "mcts_iterations": 40, "mcts_max_depth": 2, "preprocess_resolution": 50, "seed": 0}
    done = post_multipart_sse(f"{studio.meshtools}/meshes/collision", {"options": json.dumps(opts), "format": "glb"},
                              {"meshFile": ("low.glb", low, "model/gltf-binary")}, timeout=900, log=log)
    stats = (done.get("stats") or {}).get("tool") or done.get("stats") or {}
    log(f"  collision {method}: parts={stats.get('parts')} faces={stats.get('faces')}")
    return base64.b64decode(done["mesh_b64"]), stats


def save_version(studio: Studio, asset_id: int, name: str, mesh: bytes) -> dict | None:
    try:
        return post_multipart(studio.api("/meshes/editor/save"), {
            "assetId": str(asset_id), "filePath": "", "name": name, "saveMode": "version",
        }, {"meshFile": ("mesh.glb", mesh, "model/gltf-binary")}, timeout=300)
    except Exception:  # noqa: BLE001 — saving back to the studio is best-effort bookkeeping
        return None


# ----------------------------------------------------------------------------- main

def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--check", action="store_true", help="probe studio + Tripo key + mesh-tools and exit")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--image", type=pathlib.Path, help="concept PNG/JPG for image-to-3D (preferred)")
    src.add_argument("--prompt", help="text prompt for text-to-3D")
    src.add_argument("--source-glb", type=pathlib.Path, help="existing high-poly GLB: skip generation, finish only")
    p.add_argument("--stem", required=not any(a in argv for a in ("--check", "-h", "--help")), help="asset stem, e.g. player_ship")
    p.add_argument("--out-dir", type=pathlib.Path, help="folder for the output GLBs/PNGs (default: cwd)")
    p.add_argument("--evidence-dir", type=pathlib.Path, help="folder for gen3d-report.json (default: out-dir)")
    p.add_argument("--project", default="cocos-asset-gen", help="3D Gen Studio project name to reuse/create")
    p.add_argument("--target-tris", type=int, default=12000, help="triangle budget for the game mesh (LOD0)")
    p.add_argument("--lod-ratios", default="0.5,0.25,0.12", help="LOD1..n as fractions of --target-tris")
    p.add_argument("--simplify-error", type=float, default=0.2)
    p.add_argument("--no-seam-breaking", action="store_true", help="keep UV seams (may not reach target)")
    p.add_argument("--bake-resolution", type=int, default=1024)
    p.add_argument("--no-bake", action="store_true")
    p.add_argument("--collision", default="decomposition", choices=["decomposition", "convex_hull", "box", "sphere", "none"])
    p.add_argument("--max-hulls", type=int, default=12)
    p.add_argument("--tripo-model", default="v2.5-20250123")
    p.add_argument("--tripo-texture-quality", default="standard", choices=["standard", "detailed"])
    p.add_argument("--tripo-no-texture", action="store_true", help="geometry only (-10 credits)")
    p.add_argument("--tripo-smart-low-poly", action="store_true", help="+10 credits; cleaner low-poly topology")
    p.add_argument("--tripo-face-limit", type=int)
    p.add_argument("--poll-seconds", type=int, default=10)
    p.add_argument("--timeout-seconds", type=int, default=1200)
    p.add_argument("--save-to-studio", action="store_true", help="also save LODs/game mesh as versions in the studio")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    log = lambda msg: print(msg, flush=True)  # noqa: E731

    log("[gen3d] probing 3D Gen Studio…")
    studio, reasons = discover(log)
    if studio is None:
        log("[gen3d] UNAVAILABLE: " + " | ".join(reasons))
        return EXIT_UNAVAILABLE
    meshtools_up = studio.meshtools_up()
    has_key = bool(studio.tripo_key)
    log(f"  tripo key: {'configured' if has_key else 'MISSING'} · mesh-tools {studio.meshtools}: {'up' if meshtools_up else 'down'}")

    balance = tripo_balance(studio.tripo_key) if has_key else None
    need = credits_needed(args)
    if has_key:
        log(f"  tripo credits: {'unknown (balance check failed)' if balance is None else balance} · one generation needs {need}")
    short = balance is not None and balance < need

    if args.check:
        ok = has_key and not short
        reason = ("no Tripo API key in Settings → Tripo AI" if not has_key else
                  f"Tripo balance {balance} credits < {need} needed; top up at tripo3d.ai or use --source-glb")
        log("[gen3d] " + ("USABLE" if ok else f"UNAVAILABLE ({reason})"))
        if not meshtools_up:
            log("  note: mesh-tools down → bake/collision would be skipped; start it from Settings → Mesh Tools")
        return EXIT_OK if ok else EXIT_UNAVAILABLE

    if not (args.image or args.prompt or args.source_glb):
        log("[gen3d] one of --image / --prompt / --source-glb is required")
        return EXIT_USAGE
    if (args.image or args.prompt) and not has_key:
        log("[gen3d] UNAVAILABLE: Tripo API key not configured")
        return EXIT_UNAVAILABLE
    if (args.image or args.prompt) and short:
        log(f"[gen3d] UNAVAILABLE: Tripo balance {balance} credits < {need} needed")
        return EXIT_UNAVAILABLE

    out_dir = (args.out_dir or pathlib.Path.cwd()).resolve()
    evidence_dir = (args.evidence_dir or out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    stem = args.stem
    report: dict = {"route": "3dgenstudio", "stem": stem, "studio": studio.base, "tripo_balance_before": balance,
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "steps": {}, "warnings": []}

    try:
        # 1. high-poly
        if args.source_glb:
            high = args.source_glb.read_bytes()
            report["steps"]["generate"] = {"skipped": True, "source": str(args.source_glb)}
            project_id = None
        else:
            project_id = ensure_project(studio, args.project, log)
            image_asset = upload_image(studio, project_id, args.image, log) if args.image else None
            tripo_opts = {"modelVersion": args.tripo_model, "texture": not args.tripo_no_texture, "pbr": not args.tripo_no_texture,
                          "textureQuality": args.tripo_texture_quality, "smartLowPoly": args.tripo_smart_low_poly}
            if args.tripo_face_limit:
                tripo_opts["faceLimit"] = args.tripo_face_limit
            log("[gen3d] generating with Tripo…")
            high, gen_info = generate_tripo(studio, project_id, stem, prompt=args.prompt, image_asset=image_asset,
                                            opts=tripo_opts, poll_s=args.poll_seconds, timeout_s=args.timeout_seconds, log=log)
            credits = credits_needed(args)
            report["steps"]["generate"] = {**gen_info, "options": tripo_opts, "credits_estimate": credits,
                                           "input": "image" if image_asset else "prompt"}
        high_stats = glb_stats(high)
        (out_dir / f"{stem}_high.glb").write_bytes(high)
        report["high"] = high_stats
        log(f"  high-poly: {high_stats['triangles']} tris / {high_stats['vertices']} verts")

        # 2. simplify high → LOD0 (game mesh). gltfpack floors the ratio at 0.01, so a 500k
        #    AI mesh can only reach 5k in one step; LOD1..n are therefore cut from LOD0 below.
        src_tris = max(high_stats["triangles"], 1)
        base_ratio = min(1.0, max(0.01, args.target_tris / src_tris))
        if args.target_tris / src_tris < 0.01:
            report["warnings"].append(f"target {args.target_tris} < 1% of {src_tris}; gltfpack floor 0.01 applied to LOD0")
        log(f"[gen3d] simplifying high → LOD0 (ratio {base_ratio:.4f})…")
        lod0 = simplify_and_lods(studio, high, [base_ratio], args.simplify_error, not args.no_seam_breaking, log)[0]
        report["steps"]["simplify"] = {k: lod0[k] for k in ("ratio", "achieved_ratio", "seam_limited", "triangles", "vertices")}
        if lod0["triangles"] > args.target_tris * 1.02:
            # floored (or overshot) first pass: a second pass from LOD0 reaches the budget
            second = args.target_tris / lod0["triangles"]
            log(f"[gen3d] LOD0 {lod0['triangles']} > {args.target_tris}; second pass (ratio {second:.3f})…")
            lod0 = simplify_and_lods(studio, lod0["buffer"], [second], args.simplify_error, not args.no_seam_breaking, log)[0]
            report["steps"]["simplify"]["second_pass"] = {k: lod0[k] for k in ("ratio", "achieved_ratio", "seam_limited", "triangles", "vertices")}

        # 3. LOD chain from LOD0 (fractions of the game mesh, all >= 1% so no floor issue)
        lod_fracs = [min(1.0, max(0.01, float(x))) for x in args.lod_ratios.split(",") if x.strip()]
        lods = []
        if lod_fracs:
            log(f"[gen3d] LOD1..{len(lod_fracs)} from LOD0 at {lod_fracs}…")
            lods = simplify_and_lods(studio, lod0["buffer"], lod_fracs, args.simplify_error, not args.no_seam_breaking, log)

        # 4. ground pivot on LOD0 and every LOD so they stay aligned
        log("[gen3d] pivot → ground…")
        game, pivot_stats = ground_pivot(studio, lod0["buffer"], log)
        report["steps"]["pivot"] = pivot_stats
        lod_files = []
        for idx, lvl in enumerate(lods, start=1):
            moved, _ = ground_pivot(studio, lvl["buffer"], lambda _m: None)
            path = out_dir / f"{stem}_LOD{idx}.glb"
            path.write_bytes(moved)
            lod_files.append({"level": idx, "path": str(path), "triangles": lvl["triangles"], "vertices": lvl["vertices"],
                              "ratio_of_lod0": lvl["ratio"], "achieved_ratio": lvl["achieved_ratio"], "seam_limited": lvl["seam_limited"]})
        report["lods"] = lod_files

        # 5. bake normal + AO from high onto game mesh
        maps: dict[str, bytes] = {}
        if args.no_bake:
            report["steps"]["bake"] = {"skipped": True}
        elif not meshtools_up:
            report["warnings"].append("mesh-tools service down → bake skipped")
            report["steps"]["bake"] = {"skipped": True, "reason": "meshtools down"}
        elif not glb_stats(game)["has_uv"]:
            report["warnings"].append("game mesh has no UVs → bake skipped (run auto_uv first)")
            report["steps"]["bake"] = {"skipped": True, "reason": "no UVs"}
        else:
            log("[gen3d] baking normal + AO (high → low)…")
            maps, bake_stats = bake(studio, game, high, args.bake_resolution, log)
            report["steps"]["bake"] = {k: bake_stats.get(k) for k in ("coverage", "resolution", "cage_extrusion", "low_faces", "high_faces", "alignment")}
            for name, png in maps.items():
                (out_dir / f"{stem}_{name}.png").write_bytes(png)
            if (bake_stats.get("coverage") or 0) < 0.95:
                report["warnings"].append(f"bake coverage {bake_stats.get('coverage')} < 0.95 — check alignment / cage")
            game = embed_maps(game, maps)

        game_path = out_dir / f"{stem}.glb"
        game_path.write_bytes(game)
        # glb_stats bounds are accessor-local; the pivot tool moves the node transform, so the
        # world-space footprint after grounding comes from the pivot step instead.
        report["game"] = {"path": str(game_path), **glb_stats(game), "baked_maps": sorted(maps),
                          "world_bounds_after_pivot": pivot_stats.get("bounds_after")}
        log(f"  game mesh: {report['game']['triangles']} tris / {report['game']['vertices']} verts → {game_path}")

        # 6. collision
        if args.collision == "none":
            report["steps"]["collision"] = {"skipped": True}
        elif not meshtools_up:
            report["warnings"].append("mesh-tools service down → collision skipped")
            report["steps"]["collision"] = {"skipped": True, "reason": "meshtools down"}
        else:
            log(f"[gen3d] collision ({args.collision})…")
            hull, hull_stats = collision(studio, game, args.collision, args.max_hulls, log)
            hull_path = out_dir / f"{stem}_collision.glb"
            hull_path.write_bytes(hull)
            report["steps"]["collision"] = {"path": str(hull_path), **{k: hull_stats.get(k) for k in ("method", "parts", "faces", "vertices", "volume_ratio")}}

        # 7. optional bookkeeping in the studio
        if args.save_to_studio and project_id is not None and report["steps"]["generate"].get("assetId"):
            aid = int(report["steps"]["generate"]["assetId"])
            save_version(studio, aid, f"{stem} GAME ({report['game']['triangles']} tris)", game)
            for f in lod_files:
                save_version(studio, aid, f"{stem} LOD{f['level']} ({f['triangles']} tris)", pathlib.Path(f["path"]).read_bytes())

    except (urllib.error.URLError, RuntimeError, OSError, ValueError, KeyError) as exc:
        report["error"] = str(exc)
        (evidence_dir / "gen3d-report.json").write_text(json.dumps(report, indent=2))
        log(f"[gen3d] FAILED: {exc}")
        return EXIT_FAILED

    report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    (evidence_dir / "gen3d-report.json").write_text(json.dumps(report, indent=2))
    log(f"[gen3d] OK — report {evidence_dir / 'gen3d-report.json'}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
