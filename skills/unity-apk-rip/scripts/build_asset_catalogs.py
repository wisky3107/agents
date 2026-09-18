#!/usr/bin/env python3
"""Build per-file asset catalogs (JSON) + agent guides (Markdown) for a ripped case-study pack.

Image entries are classified per de-atlased sprite (category atlas_sprite / board_piece with
maps_to = SpriteAtlas family via output/de_atlas_lookup.json); legacy whole sactx-* pages get
category atlas_page. Font atlas PNGs → P3 font_atlas_skip (fonts live in output/fonts/).

Produces under <workdir>/output/:
  images_ingame_catalog.json   IMAGES_INGAME_GUIDE.md
  meshes_catalog.json          MESHES_GUIDE.md

Workflow (stdlib only):
  1. python3 build_asset_catalogs.py --workdir W                 # classify + write JSON + render MD
  2. edit the JSON: fix priority / how_to_use / maps_to, fill "wiring" and "color_map"
  3. python3 build_asset_catalogs.py --workdir W --render-only   # re-render MD from edited JSON

Re-running without --render-only MERGES: files already in the JSON keep their edited fields
(pass --reclassify to overwrite). Entries the heuristics could not place carry "_agent_todo": true.

Game-specific hints:
  --image-p0 "gameplayatlas,ingameui"   substrings that force P0 for images (atlas family or name)
  --mesh-p0  "BlockPiece-,DoorPiece"    substrings that force P0 for meshes
  --game "Title (package)"              header text
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

IMG_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".webp", ".bmp"}
MESH_EXTS = {".glb", ".gltf", ".fbx", ".obj"}

COLOR_WORDS = (
    "red", "blue", "yellow", "green", "purple", "orange", "pink", "darkblue", "dark_blue",
    "turqoise", "turquoise", "darkgreen", "dark_green", "white", "black", "cyan", "magenta",
    "brown", "gray", "grey", "lime", "violet", "teal", "gold", "silver",
)
IMG_FX_WORDS = ("glow", "flare", "spark", "spike", "smoke", "shockwave", "blast", "trail",
                "particle", "_fx", "fx_", "confetti", "burst", "ring", "slash", "flash", "beam")
IMG_UI_WORDS = ("btn", "button", "popup", "pop_up", "panel", "frame", "banner", "ribbon",
                "tooltip", "bar_", "_bar", "slider", "toggle", "close", "tab")
IMG_META_WORDS = ("token", "collection", "profile", "leaderboard", "arena", "journey", "pass",
                  "store", "shop", "offer", "bundle", "chest", "daily", "streak", "tournament",
                  "avatar", "badge", "medal", "cup", "trophy", "league")
IMG_SHADER_WORDS = ("matcap", "cubemap", "noise", "palette", "lut", "gradient", "ramp", "mask_")
MESH_UI_WORDS = ("popup", "pop_up", "leaderboard", "toolbar", "button", "panel", "tab", "option",
                 "view", "reveal", "bundle", "category", "console", "debug", "dock", "sheet",
                 "popover", "reporter", "controller", "entry", "pinned", "system", "item",
                 "scene", "about", "account", "ban", "terms", "rateus", "settings", "login",
                 "notification", "store", "shop", "offer", "reward", "daily", "journey", "pass",
                 "arena", "streak", "tournament", "skyjump", "jetpack", "treasure", "chest",
                 "collection", "profile", "badge", "token", "coin", "life", "noads", "bulk")
MESH_PRIM_RE = re.compile(
    r"^(capsule|cone|cone_uncapped|cylinder|sphere|icosphere|icosahedron|torus|triangle|quad|"
    r"plane|cube|cuboid|disc|rect|polygon|pyramid|p(cylinder|plane|sphere|cube)\d*)(_\d+)?(__[0-9a-f]{8})?$",
    re.I,
)
MESH_META_WORDS = ("token", "collection", "crystal", "polysurface", "sm_", "acorn", "badge", "card", "variety", "leaf")

# Populated from output/de_atlas_lookup.json when present.
DE_ATLAS_BY_FILE: dict[str, str | None] = {}


def strip_collision(name: str) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot:
        return name
    return re.sub(r"__[0-9a-f]{8}$", "", stem) + "." + ext


def load_de_atlas_lookup(workdir: Path) -> None:
    global DE_ATLAS_BY_FILE
    p = workdir / "output" / "de_atlas_lookup.json"
    if not p.is_file():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    DE_ATLAS_BY_FILE = dict(data.get("by_file") or {})


def atlas_family(name: str) -> str | None:
    base = Path(name).name
    if base in DE_ATLAS_BY_FILE and DE_ATLAS_BY_FILE[base]:
        return str(DE_ATLAS_BY_FILE[base])
    plain = strip_collision(base)
    if plain in DE_ATLAS_BY_FILE and DE_ATLAS_BY_FILE[plain]:
        return str(DE_ATLAS_BY_FILE[plain])
    if not name.lower().startswith("sactx-"):
        return None
    if "-ASTC " in name:
        mid = name.split("-ASTC ", 1)[1]
        if mid.startswith(("4x4-", "5x5-", "6x6-", "8x8-")):
            mid = mid.split("-", 1)[1]
        return mid.rsplit("-", 1)[0]
    # sactx-N-WxH-<Format>-<Name>-<hash>
    parts = name.rsplit(".", 1)[0].split("-")
    return "-".join(parts[4:-1]) if len(parts) >= 6 else parts[-2] if len(parts) >= 2 else name


def has_any(text: str, words) -> bool:
    t = text.lower()
    return any(w in t for w in words)


# ------------------------------------------------------------------ images
def classify_image(name: str, p0_hints: tuple[str, ...]) -> dict:
    plain = strip_collision(name)
    low = plain.lower()
    stem = plain.rsplit(".", 1)[0]
    e = {"file": name, "priority": "P2", "category": "misc", "maps_to": "", "how_to_use": "", "remake_note": ""}

    # Legacy packed page (pre–de-atlas dumps)
    if plain.lower().startswith("sactx-"):
        fam = atlas_family(plain) or "unknown"
        e.update(category="atlas_page", maps_to=fam,
                 how_to_use=f"Packed SpriteAtlas page `{fam}`. Prefer de-atlased individual PNGs; never place the full page as one sprite.",
                 remake_note="Re-run de_atlas_images.py; use sliced sprites instead.")
        e["priority"] = "P0" if has_any(fam, p0_hints) else "P1"
        return e

    fam = atlas_family(plain)
    if fam:
        e.update(category="atlas_sprite", maps_to=fam,
                 how_to_use=f"De-atlased sprite from `{fam}`. Use as a single board/HUD element (already sliced).",
                 remake_note=f"Redraw as an individual sprite; originally packed in `{fam}`.")
        e["priority"] = "P0" if has_any(fam, p0_hints) else "P1"
        # refine common board piece names still tagged with family
        m_piece = re.match(
            r"^(\d+[a-z]?)_(" + "|".join(COLOR_WORDS) + r")$",
            stem.lower(),
        )
        if m_piece:
            e.update(category="board_piece", maps_to=f"piece:{m_piece.group(1)}/color:{m_piece.group(2)}",
                     how_to_use=f"Board polyomino face `{m_piece.group(1)}` tinted/skinned as `{m_piece.group(2)}` (from `{fam}`).")
            e["priority"] = "P0"
        return e

    if "sdf" in low or low.endswith(" atlas.png") or "digits_atlas" in low or ("font" in low and "atlas" in low):
        e.update(priority="P3", category="font_atlas_skip", maps_to="fonts/",
                 how_to_use="Font/TMP atlas PNG — excluded by de-atlas; use `output/fonts/` (.ttf/.otf) instead.",
                 remake_note="Do not crop as icons; rebuild as TMP/BMFont from vector fonts.")
        return e

    if re.fullmatch(r"\d+", stem):
        e.update(priority="P3", category="numbered", maps_to="debug_or_tutorial",
                 how_to_use="ASSUMPTION: numbered marker / tutorial step tile.", _agent_todo=True)
        return e

    m = re.match(r"^(" + "|".join(COLOR_WORDS) + r")[_-]([a-z0-9_]+)$", low.rsplit(".", 1)[0])
    if m:
        e.update(priority="P0", category="color_kit", maps_to=f"color:{m.group(1)}/{m.group(2)}",
                 how_to_use=f"Per-color kit piece `{m.group(2)}` for color `{m.group(1)}`. Map to the game's color enum.",
                 remake_note="Keep full part set per color, or tint a neutral sprite at runtime.")
        return e

    if "icon" in low:
        key = re.sub(r"[_-]?icon[_-]?(new|old)?", "", stem, flags=re.I).strip("_- ") or stem
        e.update(category="icon", maps_to=key, how_to_use=f"Icon `{key}` — obstacle intro, HUD badge, or toolbar.",
                 remake_note="Use as thumbnail/badge; check for _New/_Old pairs.")
        e["priority"] = "P3" if re.search(r"_old", low) else "P1"
        if e["priority"] == "P3":
            e["how_to_use"] += " Legacy `_Old` variant — prefer `_New`."
        return e

    if "shadow" in low:
        e.update(priority="P1", category="board_shadow", maps_to="shadow", how_to_use="Drop/contact shadow layered under board pieces.")
        return e
    if has_any(low, IMG_SHADER_WORDS):
        e.update(priority="P3", category="shader_helper", maps_to="material", how_to_use="Shader/material helper texture (matcap, noise, ramp) — not UI art.")
        return e
    if has_any(low, IMG_FX_WORDS):
        e.update(priority="P2", category="fx", maps_to="vfx", how_to_use="VFX chip (additive/particle). Used on clears, boosters, hits.")
        return e
    if has_any(low, IMG_META_WORDS):
        e.update(priority="P3", category="leak_meta", maps_to="meta/ignore",
                 how_to_use="Meta/live-ops art that leaked through shared prefab refs. Skip for core remake.")
        return e
    if re.fullmatch(r"(\d+x\d+[-_]?)?(white|black|circle\d*|square\s?\d*|point\d*|dot|pixel)", stem.lower().replace(" ", "")) or "circle" in low:
        e.update(priority="P2", category="ui_primitive", maps_to="mask/particle", how_to_use="Solid/circle primitive for masks, fades, particles.")
        return e
    if has_any(low, IMG_UI_WORDS):
        e.update(priority="P1", category="ui", maps_to="UI", how_to_use="In-level UI chrome (button/frame/tooltip).")
        return e

    e.update(_agent_todo=True, how_to_use="Referenced from gameplay dependency walk; identify via ripped Texture2D/Sprite name and fill this in.")
    if has_any(low, p0_hints):
        e["priority"] = "P0"
    return e


# ------------------------------------------------------------------ meshes
def classify_mesh(name: str, p0_hints: tuple[str, ...]) -> dict:
    plain = strip_collision(name)
    stem = plain.rsplit(".", 1)[0]
    low = stem.lower()
    e = {"file": name, "priority": "P1", "category": "gameplay_candidate", "maps_to": "", "how_to_use": "", "remake_note": ""}

    if has_any(low, [h.lower() for h in p0_hints]):
        e.update(priority="P0", category="board_geometry", maps_to=stem,
                 how_to_use="Board geometry family (matched --mesh-p0). Describe role + level key.", _agent_todo=True)
        return e
    if MESH_PRIM_RE.match(stem):
        e.update(priority="P3", category="primitive", maps_to="Shapes/debug", how_to_use="Primitive / helper mesh — not board content.", remake_note="Skip.")
        return e
    if low.startswith(("editor", "example")):
        e.update(priority="P2", category="editor_helper", maps_to="LevelEditor",
                 how_to_use="Level-editor / example prefab shipped in APK. Scale/pivot reference only.", remake_note="Skip for player remake.")
        return e
    if low.endswith("scene"):
        e.update(priority="P2", category="scene_export", maps_to=stem, how_to_use="Whole-scene hierarchy export — inspection only, not a prop.", remake_note="Do not import as mesh.")
        return e
    if has_any(low, MESH_META_WORDS):
        e.update(priority="P3", category="meta_leak", maps_to="Collection/meta", how_to_use="Collection / profile / meta presentation mesh.", remake_note="Skip.")
        return e
    if has_any(low, MESH_UI_WORDS) and not has_any(low, ("block", "door", "generator", "cell", "wall", "grinder", "elevator", "lock", "ivy", "obstacle")):
        e.update(priority="P3", category="ui_prefab_noise", maps_to="uGUI",
                 how_to_use="UI prefab hierarchy exported as GLB — not a 3D prop. Use 2D atlases instead.", remake_note="Do not remodel.")
        return e
    if "fx" in low or "particle" in low or "trail" in low:
        e.update(priority="P1", category="fx", maps_to="vfx", how_to_use="FX prefab root (particles / trails).", remake_note="2D particles OK.")
        return e

    e.update(_agent_todo=True, how_to_use="Likely gameplay view root. Confirm via prefab/scripts and set P0 if board-critical.")
    return e


# ------------------------------------------------------------------ io
def load_existing(path: Path) -> dict:
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def merge(old: dict, new_entries: list[dict], reclassify: bool) -> list[dict]:
    if reclassify or not old.get("entries"):
        return new_entries
    by_file = {e["file"]: e for e in old["entries"]}
    out = []
    for e in new_entries:
        prev = by_file.get(e["file"])
        if prev:
            keep = {k: prev[k] for k in ("priority", "category", "maps_to", "how_to_use", "remake_note") if k in prev}
            e.update(keep)
            e.pop("_agent_todo", None)
            if prev.get("_agent_todo"):
                e["_agent_todo"] = True
        out.append(e)
    return out


def build_catalog(kind: str, files: list[Path], old: dict, args) -> dict:
    hints = tuple(h.strip().lower() for h in (args.image_p0 if kind == "images" else args.mesh_p0).split(",") if h.strip())
    entries = []
    for p in files:
        e = classify_image(p.name, hints) if kind == "images" else classify_mesh(p.name, hints)
        e["bytes"] = p.stat().st_size
        entries.append(e)
    entries = merge(old, entries, args.reclassify)
    cat = {
        "game": args.game or old.get("game", ""),
        "source_dir": f"output/{args.images_dir}" if kind == "images" else "output/meshes",
        "kind": kind,
        "priority_legend": {
            "P0": "Required for a playable board / core HUD",
            "P1": "Obstacles, boosters, win/fail/FTUE, supporting views",
            "P2": "Polish FX, primitives, editor/reference",
            "P3": "Skip unless implementing that meta feature (leaks, legacy, UI dumps)",
        },
        "rules": old.get("rules") or (
            [
                "Images are de-atlased: each PNG is one sprite (no sactx-* packed pages).",
                "Board look → sprites from GameplayAtlas1–5 / GameplayNineSlice first (filter by `maps_to` / catalog).",
                "HUD/boosters/stuck/win/fail → InGameUI / Booster / Stuck / Level_* families + *_Icon_New.",
                "Color is a per-color kit or runtime tint — map prefixes to the game's color enum.",
                "Fonts: use `output/fonts/` (.ttf/.otf); SDF/BMF atlas PNGs were skipped at de-atlas.",
                "Ignore P3 leak_meta / shader_helper / legacy unless doing that feature.",
            ] if kind == "images" else [
                "Prefer 2D sprites for look; meshes are often thin prefab shells.",
                "Use P0 board geometry for shape topology / door / generator shells.",
                "Color is runtime tint — do not duplicate meshes per color.",
                "Skip P3 ui_prefab_noise / meta_leak / primitives.",
                "Editor*/Example* are level-editor helpers — reference only.",
            ]
        ),
        "color_map": old.get("color_map", {}),
        "wiring": old.get("wiring", []),
        "count": len(entries),
        "entries": entries,
    }
    return cat


def render_md(cat: dict, title: str, twin: str) -> str:
    entries = cat["entries"]
    L: list[str] = []
    A = L.append
    A(f"# {title} — Agent Usage Guide\n")
    A(f"> Game: **{cat.get('game') or 'n/a'}** · Source: `{cat['source_dir']}` ({cat['count']} files).")
    A(f"> Machine-readable twin: [`{twin}`]({twin}) — every file has `priority`, `category`, `maps_to`, `how_to_use`.\n")
    todo = sum(1 for e in entries if e.get("_agent_todo"))
    if todo:
        A(f"> ⚠ {todo} entries still flagged `_agent_todo` in the JSON — enrich them, then re-render with `--render-only`.\n")
    A("## Quick rules\n")
    for r in cat.get("rules") or []:
        A(f"- {r}")
    A("")
    A("## Priority legend\n")
    A("| Priority | Meaning | Count |")
    A("|----------|---------|------:|")
    pc = Counter(e["priority"] for e in entries)
    for p, desc in (cat.get("priority_legend") or {}).items():
        A(f"| {p} | {desc} | {pc.get(p, 0)} |")
    A("")
    if cat.get("color_map"):
        A("## Color map\n")
        A("| Filename prefix | Enum | Id |")
        A("|-----------------|------|----|")
        for pref, v in cat["color_map"].items():
            if isinstance(v, dict):
                A(f"| `{pref}_*` | {v.get('name', '')} | {v.get('id', '')} |")
            else:
                A(f"| `{pref}_*` | {v} | |")
        A("")
    if cat["kind"] == "images":
        # One row per SpriteAtlas family: de-atlased sprites, board pieces, legacy whole pages.
        fam_rows: dict[str, dict] = {}
        for e in entries:
            if e["category"] not in ("atlas_sprite", "atlas_page", "board_piece"):
                continue
            fam = e["maps_to"] if e["category"] != "board_piece" else atlas_family(e["file"])
            if not fam:
                continue
            row = fam_rows.setdefault(
                fam, {"priority": e["priority"], "count": 0, "how": f"Sprites packed in `{fam}` (already sliced).", "samples": []}
            )
            row["count"] += 1
            row["priority"] = min(row["priority"], e["priority"])  # "P0" < "P1" < …
            if len(row["samples"]) < 3:
                row["samples"].append(e["file"])
        if fam_rows:
            A("## SpriteAtlas families (already sliced)\n")
            A("| Family | Priority | Sprites | Sample files | How to use |")
            A("|--------|----------|--------:|--------------|------------|")
            for fam, row in sorted(fam_rows.items(), key=lambda kv: (kv[1]["priority"], -kv[1]["count"], kv[0])):
                samples = ", ".join(f"`{s}`" for s in row["samples"]) or "—"
                A(f"| `{fam}` | {row['priority']} | {row['count']} | {samples} | {row['how']} |")
            A("")
            A("Filter catalog `entries[]` where `maps_to == \"<Family>\"` or `category == \"atlas_sprite\"`.\n")
    ATLAS_SKIP = {"atlas", "atlas_page", "atlas_sprite", "board_piece"}
    for pr, heading in (("P0", "P0 — Core (remake these)"), ("P1", "P1 — Supporting")):
        rows = [e for e in entries if e["priority"] == pr and e["category"] not in ATLAS_SKIP]
        if not rows:
            continue
        A(f"## {heading}\n")
        A("| File | Category | Maps to | How to use |")
        A("|------|----------|---------|------------|")
        # Cap huge tables — prefer icons/color_kit; dump rest to catalog
        shown = rows if len(rows) <= 120 else [e for e in rows if e["category"] in ("color_kit", "icon", "ui", "board_shadow")][:120]
        for e in shown:
            flag = " ⚠" if e.get("_agent_todo") else ""
            A(f"| `{e['file']}`{flag} | {e['category']} | {e['maps_to']} | {e['how_to_use']} |")
        if len(rows) > len(shown):
            A(f"\n…and {len(rows) - len(shown)} more `{pr}` rows — see `{twin}`.\n")
        A("")
    rows = [e for e in entries if e["priority"] == "P2"]
    if rows:
        A("## P2 — Polish / reference\n")
        A("| File | Category | How to use |")
        A("|------|----------|------------|")
        for e in rows:
            A(f"| `{e['file']}` | {e['category']} | {e['how_to_use']} |")
        A("")
    rows = [e for e in entries if e["priority"] == "P3"]
    if rows:
        A(f"## P3 — Skip ({len(rows)} files)\n")
        cc = Counter(e["category"] for e in rows)
        A("| Category | Count | Typical reason |")
        A("|----------|------:|----------------|")
        for c, n in cc.most_common():
            sample = next(e for e in rows if e["category"] == c)
            A(f"| {c} | {n} | {sample['how_to_use']} |")
        A("")
        A(f"Full list: filter `{twin}` where `priority == \"P3\"`.\n")
    if cat.get("wiring"):
        A("## Wiring cheat-sheet (code ↔ asset)\n")
        A("| Game need | Data / code key | Asset to open |")
        A("|-----------|-----------------|---------------|")
        for w in cat["wiring"]:
            A(f"| {w.get('need', '')} | {w.get('key', '')} | {w.get('asset', '')} |")
        A("")
    A("## Full inventory\n")
    A(f"Every file is in `{twin}` → `entries[]` with `file`, `priority`, `category`, `maps_to`, `how_to_use`, `remake_note`, `bytes`.\n")
    A("Also see `output/README.md` (folder map) and `output/briefs/`.")
    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Build asset catalogs + guides for a ripped Unity case-study pack")
    ap.add_argument("--workdir", required=True, type=Path)
    ap.add_argument("--images-dir", default="images_ingame", help="image folder under output/ to catalog (default images_ingame; use images for full dump)")
    ap.add_argument("--game", default="", help="game title / package for headers")
    ap.add_argument("--image-p0", default="gameplay,ingame,hud,booster,stuck,level_win,level_fail,pause,nineslice", help="comma substrings → P0 for images")
    ap.add_argument("--mesh-p0", default="", help="comma substrings → P0 for meshes (e.g. 'BlockPiece-,DoorPiece,Generator')")
    ap.add_argument("--render-only", action="store_true", help="skip classification; render MD from existing JSON")
    ap.add_argument("--reclassify", action="store_true", help="overwrite edited fields with fresh heuristics")
    args = ap.parse_args()

    out = args.workdir.resolve() / "output"
    if not out.is_dir():
        print(f"missing {out}", file=sys.stderr)
        return 1

    load_de_atlas_lookup(args.workdir.resolve())
    if DE_ATLAS_BY_FILE:
        print(f"[de-atlas] lookup: {len(DE_ATLAS_BY_FILE)} sprites")

    jobs = [
        ("images", out / args.images_dir, IMG_EXTS, out / f"{args.images_dir}_catalog.json", out / f"{args.images_dir.upper()}_GUIDE.md", f"Images ({args.images_dir})"),
        ("meshes", out / "meshes", MESH_EXTS, out / "meshes_catalog.json", out / "MESHES_GUIDE.md", "Meshes (3D)"),
    ]
    for kind, src, exts, json_path, md_path, title in jobs:
        if not src.is_dir():
            print(f"[skip] {src} not found")
            continue
        old = load_existing(json_path)
        if args.render_only:
            if not old:
                print(f"[skip] {json_path} missing; run without --render-only first")
                continue
            cat = old
        else:
            files = sorted(p for p in src.iterdir() if p.is_file() and p.suffix.lower() in exts)
            cat = build_catalog(kind, files, old, args)
            json_path.write_text(json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8")
        md_path.write_text(render_md(cat, title, json_path.name), encoding="utf-8")
        pc = Counter(e["priority"] for e in cat["entries"])
        todo = sum(1 for e in cat["entries"] if e.get("_agent_todo"))
        print(f"[{kind}] {cat['count']} files  P0={pc.get('P0',0)} P1={pc.get('P1',0)} P2={pc.get('P2',0)} P3={pc.get('P3',0)}  todo={todo}")
        print(f"        → {json_path.name}, {md_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
