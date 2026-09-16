#!/usr/bin/env python3
"""Rip a Unity APK/XAPK into a case-study pack with AssetRipper.

Steps: extract → merge native libs → AssetRipper headless export → collect images/meshes →
detect & copy level data → write manifest.json.  Stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

DEFAULT_BIN = "/Users/wikz/Works/agent/assets-ripper/AssetRipper.GUI.Free"
IMG_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".webp", ".bmp"}
MESH_EXTS = {".glb", ".gltf", ".fbx", ".obj"}
LEVEL_DIR_RE = re.compile(r"(?i)^(levels?|stages?|maps?|puzzles?|boards?|definitions)$")
LEVEL_FILE_EXTS = {".json", ".bytes", ".txt", ".asset", ".unity"}
CATALOG_KEYS = ("Levels", "levels", "stages", "Stages", "ids", "Ids")


def log(step: str, msg: str) -> None:
    print(f"[{step}] {msg}", flush=True)


def die(step: str, msg: str, code: int = 1) -> None:
    print(f"[{step}] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------- extract
def extract_archive(src: Path, work: Path) -> Path:
    """Return path to the base APK folder with all split libs merged in."""
    extracted = work / "extracted"
    extracted.mkdir(parents=True, exist_ok=True)
    apks: list[Path] = []

    if src.suffix.lower() in {".xapk", ".apks", ".zip"}:
        log("extract", f"unzipping bundle {src.name}")
        with zipfile.ZipFile(src) as z:
            z.extractall(extracted)
        apks = sorted(extracted.rglob("*.apk"))
        if not apks:
            die("extract", "no .apk inside bundle")
    else:
        apks = [src]

    manifest = extracted / "manifest.json"
    base_name = None
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            for s in m.get("split_apks", []):
                if s.get("id") == "base":
                    base_name = s.get("file")
        except json.JSONDecodeError:
            pass

    base_apk = None
    for a in apks:
        if base_name and a.name == base_name:
            base_apk = a
    if base_apk is None:
        # largest apk that is not a config split
        cands = [a for a in apks if not a.name.startswith("config.")] or apks
        base_apk = max(cands, key=lambda p: p.stat().st_size)

    base_dir = work / "apk_base"
    if base_dir.exists():
        shutil.rmtree(base_dir)
    log("extract", f"unzipping base {base_apk.name} → {base_dir.name}")
    with zipfile.ZipFile(base_apk) as z:
        z.extractall(base_dir)

    for a in apks:
        if a == base_apk:
            continue
        split_dir = work / f"apk_{a.stem.replace('config.', '')}"
        if split_dir.exists():
            shutil.rmtree(split_dir)
        log("extract", f"unzipping split {a.name}")
        with zipfile.ZipFile(a) as z:
            z.extractall(split_dir)
        lib_src = split_dir / "lib"
        if lib_src.is_dir():
            log("extract", f"merging {lib_src.relative_to(work)} → apk_base/lib")
            shutil.copytree(lib_src, base_dir / "lib", dirs_exist_ok=True)
        # some splits ship assets too (asset packs)
        assets_src = split_dir / "assets"
        if assets_src.is_dir():
            shutil.copytree(assets_src, base_dir / "assets", dirs_exist_ok=True)

    if not (base_dir / "assets" / "bin" / "Data").is_dir():
        die("extract", "assets/bin/Data not found — not a Unity APK?")
    return base_dir


# ---------------------------------------------------------------- assetripper
def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def post_form(url: str, data: dict, timeout: int) -> None:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):  # noqa: D401
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303):
            raise


def run_assetripper(binary: Path, base_dir: Path, ripped: Path, port: int, log_path: Path) -> None:
    if not binary.exists():
        die("assetripper", f"binary not found: {binary} (set ASSETRIPPER_BIN)")
    if port_open(port):
        die("assetripper", f"port {port} already in use; pass --port")

    ripped.mkdir(parents=True, exist_ok=True)
    unity_out = ripped / "UnityProject"
    primary_out = ripped / "PrimaryContent"
    for d in (unity_out, primary_out):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    log("assetripper", f"starting headless on :{port}")
    proc = subprocess.Popen(
        [str(binary), "--headless", "--port", str(port), "--log-path", str(log_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=str(binary.parent),
    )
    try:
        for _ in range(60):
            if port_open(port):
                break
            if proc.poll() is not None:
                die("assetripper", "process exited before listening; check --help / permissions")
            time.sleep(0.5)
        else:
            die("assetripper", "server did not come up in 30s")

        base = f"http://127.0.0.1:{port}"
        log("assetripper", "LoadFolder …")
        post_form(f"{base}/LoadFolder", {"path": str(base_dir)}, timeout=1800)
        log("assetripper", "Export/UnityProject …")
        post_form(f"{base}/Export/UnityProject", {"path": str(unity_out)}, timeout=3600)
        log("assetripper", "Export/PrimaryContent …")
        post_form(f"{base}/Export/PrimaryContent", {"path": str(primary_out)}, timeout=3600)
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        log("assetripper", "stopped")

    if not (unity_out / "ExportedProject" / "Assets").is_dir():
        die("assetripper", f"UnityProject export missing; see {log_path}")


# ---------------------------------------------------------------- collect
def collect_files(roots: list[Path], exts: set[str], dest: Path) -> tuple[int, int]:
    dest.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    copied = skipped = 0
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in exts:
                continue
            h = hashlib.md5(p.read_bytes()).hexdigest()[:8]
            name = p.name
            key = name.lower()
            if key in seen:
                if seen[key] == h:
                    skipped += 1
                    continue
                name = f"{p.stem}__{h}{p.suffix}"
                key = name.lower()
                if key in seen:
                    skipped += 1
                    continue
            seen[key] = h
            shutil.copy2(p, dest / name)
            copied += 1
    return copied, skipped


# ---------------------------------------------------------------- levels
def _level_files(d: Path) -> list[Path]:
    return [p for p in d.iterdir() if p.is_file() and p.suffix.lower() in LEVEL_FILE_EXTS and not p.name.endswith(".meta")]


def _json_keys(p: Path) -> frozenset | None:
    try:
        d = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except (json.JSONDecodeError, OSError):
        return None
    return frozenset(d.keys()) if isinstance(d, dict) else None


def detect_level_dirs(project: Path, assets: Path, levels_glob: str | None) -> list[Path]:
    if levels_glob:
        hits = {p.parent for p in project.glob(levels_glob) if p.is_file()}
        return sorted(hits)

    hits: list[Path] = []
    # 2. dir-name match
    for d in assets.rglob("*"):
        if d.is_dir() and LEVEL_DIR_RE.match(d.name) and len(_level_files(d)) >= 5:
            hits.append(d)
    if hits:
        return sorted(set(hits))

    # 3. catalog match
    for p in assets.rglob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(d, dict) or len(d) != 1:
            continue
        key = next(iter(d))
        if key not in CATALOG_KEYS or not isinstance(d[key], list):
            continue
        ids = {str(x) for x in d[key] if isinstance(x, (str, int))}
        if not ids:
            continue
        present = {f.stem for f in _level_files(p.parent)}
        if len(ids & present) >= max(1, len(ids) // 2):
            hits.append(p.parent)
    if hits:
        return sorted(set(hits))

    # 4. bulk-json fallback
    for d in assets.rglob("*"):
        if not d.is_dir():
            continue
        js = [p for p in d.iterdir() if p.suffix.lower() == ".json"]
        if len(js) < 20:
            continue
        keysets = [k for k in (_json_keys(p) for p in js[:40]) if k]
        if len(keysets) < 10:
            continue
        common = frozenset.intersection(*keysets)
        if len(common) >= 3:
            hits.append(d)
    return sorted(set(hits))


def copy_levels(dirs: list[Path], dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    flatten = len(dirs) == 1
    for d in dirs:
        target = dest if flatten else dest / d.name
        target.mkdir(parents=True, exist_ok=True)
        for f in _level_files(d):
            shutil.copy2(f, target / f.name)
            total += 1
    return total


def level_stats(dest: Path) -> dict:
    props: Counter = Counter()
    diffs: Counter = Counter()
    budgets: list[int] = []
    n = 0
    for p in dest.rglob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(d, dict) or "Tables" not in d and "Placements" not in json.dumps(d)[:2000]:
            continue
        n += 1
        diffs[d.get("Difficulty", "Normal")] += 1
        if isinstance(d.get("BallBudget"), int):
            budgets.append(d["BallBudget"])
        for t in d.get("Tables") or []:
            for s in t.get("Slices") or []:
                for pl in s.get("Placements") or []:
                    props[pl.get("PropId", "?")] += 1
    out: dict = {"json_levels_parsed": n}
    if n:
        out["difficulty"] = dict(diffs)
        out["top_prop_ids"] = props.most_common(30)
        if budgets:
            out["ball_budget"] = {"min": min(budgets), "max": max(budgets), "avg": round(sum(budgets) / len(budgets), 1)}
    return out


# ---------------------------------------------------------------- manifest
def read_unity_version(ripped_log: Path, base_dir: Path) -> str | None:
    if ripped_log.exists():
        m = re.search(r"found Unity version: (\S+)", ripped_log.read_text(errors="ignore"))
        if m:
            return m.group(1)
    ggm = base_dir / "assets" / "bin" / "Data" / "globalgamemanagers"
    if ggm.exists():
        m = re.search(rb"(\d{1,4}\.\d+\.\d+[a-z]\d+)", ggm.read_bytes()[:4096])
        if m:
            return m.group(1).decode()
    return None


def read_backend(ripped_log: Path, base_dir: Path) -> str:
    if ripped_log.exists() and "IL2Cpp" in ripped_log.read_text(errors="ignore"):
        return "IL2CPP"
    if (base_dir / "assets" / "bin" / "Data" / "Managed").is_dir():
        return "Mono"
    return "unknown"


def dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("apk", type=Path, help=".apk / .xapk / .apks path")
    ap.add_argument("--workdir", type=Path, default=None, help="default: folder containing the apk")
    ap.add_argument("--port", type=int, default=27890)
    ap.add_argument("--levels-glob", default=None, help="glob relative to ripped/UnityProject/ExportedProject")
    ap.add_argument("--skip-rip", action="store_true", help="reuse existing ripped/ and only collect")
    ap.add_argument("--bin", type=Path, default=Path(os.environ.get("ASSETRIPPER_BIN", DEFAULT_BIN)))
    args = ap.parse_args()

    src: Path = args.apk.expanduser().resolve()
    if not src.exists():
        die("input", f"not found: {src}")
    work: Path = (args.workdir or src.parent).expanduser().resolve()
    work.mkdir(parents=True, exist_ok=True)
    ripped = work / "ripped"
    output = work / "output"
    ar_log = work / "assetripper.log"

    t0 = time.time()
    if args.skip_rip:
        base_dir = work / "apk_base"
        if not ripped.exists():
            die("skip-rip", f"{ripped} missing")
        log("skip-rip", "reusing existing ripped/")
    else:
        base_dir = extract_archive(src, work)
        run_assetripper(args.bin, base_dir, ripped, args.port, ar_log)

    project = ripped / "UnityProject" / "ExportedProject"
    assets = project / "Assets"
    primary = ripped / "PrimaryContent"

    for sub in ("images", "meshes", "levels"):
        d = output / sub
        if d.exists():
            shutil.rmtree(d)
    (output / "briefs").mkdir(parents=True, exist_ok=True)

    log("collect", "images …")
    img_c, img_s = collect_files([primary, ripped / "UnityProject"], IMG_EXTS, output / "images")
    log("collect", f"images copied={img_c} dupes={img_s}")
    log("collect", "meshes …")
    mesh_c, mesh_s = collect_files([primary, ripped / "UnityProject"], MESH_EXTS, output / "meshes")
    log("collect", f"meshes copied={mesh_c} dupes={mesh_s}")

    log("levels", "detecting …")
    level_dirs = detect_level_dirs(project, assets, args.levels_glob) if assets.exists() else []
    lvl_n = copy_levels(level_dirs, output / "levels") if level_dirs else 0
    for d in level_dirs:
        log("levels", f"hit: {d.relative_to(project)}")
    if not level_dirs:
        log("levels", "none detected — see reference/level-detection.md, rerun with --skip-rip --levels-glob")
    stats = level_stats(output / "levels")

    manifest = {
        "input": str(src),
        "workdir": str(work),
        "unity_version": read_unity_version(ar_log, base_dir),
        "scripting_backend": read_backend(ar_log, base_dir),
        "assetripper_bin": str(args.bin),
        "counts": {
            "images": img_c,
            "meshes": mesh_c,
            "levels": lvl_n,
        },
        "sizes_bytes": {
            "images": dir_size(output / "images"),
            "meshes": dir_size(output / "meshes"),
            "levels": dir_size(output / "levels"),
            "ripped": dir_size(ripped),
        },
        "levels_detected": [str(d.relative_to(project)) for d in level_dirs],
        "level_stats": stats,
        "briefs_expected": ["GAME_BRIEF.md", "2D_ART_BRIEF.md", "3D_ART_BRIEF.md", "GAMEPLAY_BRIEF.md"],
        "elapsed_sec": round(time.time() - t0, 1),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    log("done", f"output → {output}  ({manifest['elapsed_sec']}s)")
    print(json.dumps({k: manifest[k] for k in ("unity_version", "scripting_backend", "counts", "levels_detected")}, indent=2))


if __name__ == "__main__":
    main()
