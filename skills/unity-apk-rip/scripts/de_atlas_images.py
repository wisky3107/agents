#!/usr/bin/env python3
"""De-atlas SpriteAtlas pages into individual PNGs for output/images + copy fonts.

Reads UnityProject Sprite .asset (m_Rect + texture GUID) → crop from Texture2D PNG.
Sprites whose rect covers the whole (non-atlas) texture are NOT re-encoded — the original
texture is copied once instead (avoids `name__hash.png` duplicates).
Skips font / TMP / BMF atlas pages. Copies .ttf/.otf/.fnt → output/fonts/.

Exit codes: 0 ok · 1 usage/IO error · 2 Pillow missing · 3 no UnityProject Sprite/Texture2D export
(rip_apk.py falls back to a plain texture copy on 2/3).

Requires Pillow (skill .venv). Usage:
  ~/.cursor/skills/unity-apk-rip/.venv/bin/python \\
    ~/.cursor/skills/unity-apk-rip/scripts/de_atlas_images.py --workdir /path/to/case-study
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

EXIT_NO_PILLOW = 2
EXIT_NO_SPRITES = 3

try:
    from PIL import Image
except ImportError:
    print(
        "Pillow required. Use skill venv:\n"
        "  python3 -m venv ~/.cursor/skills/unity-apk-rip/.venv\n"
        "  ~/.cursor/skills/unity-apk-rip/.venv/bin/pip install -r ~/.cursor/skills/unity-apk-rip/requirements.txt",
        file=sys.stderr,
    )
    sys.exit(EXIT_NO_PILLOW)

IMG_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".webp", ".bmp"}
FONT_EXTS = {".ttf", ".otf", ".fnt"}

# Filename heuristics: bitmap / TMP / SDF font pages — never crop or copy into images/.
FONT_ATLAS_SUBSTR = (
    "digits_atlas",
    " font atlas",
    "fontatlas",
    "bmfont",
    "bitmapfont",
    "tmp_font",
    "textmeshpro",
)
SDF_RE = re.compile(r"(^|[\s_\-])sdf([\s_\-.]|$)", re.I)

GUID_RE = re.compile(r"^guid:\s*([0-9a-f]{32})", re.I | re.M)
RECT_RE = re.compile(
    r"m_Rect:\s*\n\s*serializedVersion:\s*\d+\s*\n"
    r"\s*x:\s*([-\d.]+)\s*\n"
    r"\s*y:\s*([-\d.]+)\s*\n"
    r"\s*width:\s*([-\d.]+)\s*\n"
    r"\s*height:\s*([-\d.]+)",
    re.M,
)
TEX_GUID_RE = re.compile(
    r"texture:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})",
    re.I,
)
# sactx-N-WxH-Format-AtlasName-hash.png
SACTX_FAM_RE = re.compile(
    r"^sactx-\d+-\d+x\d+-[^-]+-(.+?)-[0-9a-f]{8}$",
    re.I,
)


def log(msg: str) -> None:
    print(f"[de-atlas] {msg}", flush=True)


def is_font_atlas_name(name: str) -> bool:
    low = name.lower()
    if low.endswith(" atlas.png") or low.endswith(" atlas.jpg"):
        return True
    if SDF_RE.search(low):
        return True
    return any(s in low for s in FONT_ATLAS_SUBSTR)


def atlas_family_from_page(page_name: str) -> str | None:
    stem = Path(page_name).stem
    m = SACTX_FAM_RE.match(stem)
    if m:
        return m.group(1)
    if stem.lower().startswith("sactx-"):
        # fallback: strip prefix pieces
        parts = stem.split("-", 4)
        if len(parts) >= 5:
            rest = parts[4]
            return re.sub(r"-[0-9a-f]{8}$", "", rest, flags=re.I)
    return None


def build_guid_map(tex_dir: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    if not tex_dir.is_dir():
        return out
    for meta in tex_dir.glob("*.meta"):
        text = meta.read_text(encoding="utf-8", errors="ignore")
        m = GUID_RE.search(text)
        if not m:
            continue
        png = Path(str(meta)[:-5])  # strip .meta
        if png.is_file() and png.suffix.lower() in IMG_EXTS:
            out[m.group(1).lower()] = png
    return out


def build_sprite_to_atlas(primary: Path) -> dict[str, str]:
    """Map sprite name → SpriteAtlas tag/family from PrimaryContent JSON."""
    sa_dir = primary / "Assets" / "SpriteAtlas"
    mapping: dict[str, str] = {}
    if not sa_dir.is_dir():
        return mapping
    for p in sa_dir.glob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            continue
        fam = d.get("m_Tag") or d.get("m_Name") or p.stem
        for name in d.get("m_PackedSpriteNamesToIndex") or []:
            if isinstance(name, str) and name:
                mapping[name] = str(fam)
    return mapping


def safe_copy(src: Path, dest_dir: Path, seen: dict[str, str]) -> str | None:
    """Copy with content-hash collision rename. Returns dest filename or None if skipped."""
    data = src.read_bytes()
    h = hashlib.md5(data).hexdigest()[:8]
    name = src.name
    key = name.lower()
    if key in seen:
        if seen[key] == h:
            return None
        name = f"{src.stem}__{h}{src.suffix}"
        key = name.lower()
        if key in seen:
            return None
    seen[key] = h
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest_dir / name)
    return name


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as im:
            return im.size
    except OSError:
        return None


def save_png(img: Image.Image, dest: Path, name: str, seen: dict[str, str]) -> str | None:
    dest.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    h = hashlib.md5(data).hexdigest()[:8]
    out_name = name
    key = out_name.lower()
    if key in seen:
        if seen[key] == h:
            return None
        stem = Path(name).stem
        suf = Path(name).suffix
        out_name = f"{stem}__{h}{suf}"
        key = out_name.lower()
        if key in seen:
            return None
    seen[key] = h
    (dest / out_name).write_bytes(data)
    return out_name


def crop_sprite(page: Path, x: float, y: float, w: float, h: float) -> Image.Image | None:
    if w <= 0 or h <= 0:
        return None
    im = Image.open(page).convert("RGBA")
    W, H = im.size
    xi, yi, wi, hi = int(round(x)), int(round(y)), int(round(w)), int(round(h))
    # Unity rect origin = bottom-left
    top = H - yi - hi
    left, right, bottom = xi, xi + wi, top + hi
    if left < 0 or top < 0 or right > W or bottom > H:
        # clamp soft failures
        left = max(0, left)
        top = max(0, top)
        right = min(W, right)
        bottom = min(H, bottom)
        if right <= left or bottom <= top:
            return None
    return im.crop((left, top, right, bottom))


def copy_fonts(ripped: Path, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    copied: list[str] = []
    roots = [
        ripped / "PrimaryContent",
        ripped / "UnityProject" / "ExportedProject",
    ]
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in FONT_EXTS:
                continue
            if p.name.endswith(".meta"):
                continue
            name = safe_copy(p, dest, seen)
            if name:
                copied.append(name)
    return copied


def main() -> None:
    ap = argparse.ArgumentParser(description="De-atlas ripped sprites into output/images + fonts/")
    ap.add_argument("--workdir", type=Path, required=True)
    ap.add_argument(
        "--keep-atlas-pages",
        action="store_true",
        help="also copy sactx-* pages into images/ (default: omit pages; only slices)",
    )
    args = ap.parse_args()

    work = args.workdir.expanduser().resolve()
    ripped = work / "ripped"
    unity_assets = ripped / "UnityProject" / "ExportedProject" / "Assets"
    primary = ripped / "PrimaryContent"
    spr_dir = unity_assets / "Sprite"
    tex_dir = unity_assets / "Texture2D"
    out_images = work / "output" / "images"
    out_fonts = work / "output" / "fonts"

    if not spr_dir.is_dir() or not tex_dir.is_dir():
        print(f"missing UnityProject Sprite/Texture2D under {ripped}", file=sys.stderr)
        sys.exit(EXIT_NO_SPRITES)

    log("building GUID → Texture2D map …")
    guid_map = build_guid_map(tex_dir)
    log(f"texture GUIDs: {len(guid_map)}")

    log("loading SpriteAtlas name → family …")
    spr_atlas = build_sprite_to_atlas(primary)
    log(f"packed sprite names: {len(spr_atlas)}")

    if out_images.exists():
        shutil.rmtree(out_images)
    out_images.mkdir(parents=True, exist_ok=True)

    seen: dict[str, str] = {}
    cropped = 0
    skipped_font_page = 0
    skipped_bad = 0
    skipped_dup = 0
    skipped_full_rect = 0
    page_to_sprites: dict[str, list[str]] = defaultdict(list)
    sprite_entries: list[dict] = []
    font_pages_seen: set[str] = set()
    page_sizes: dict[Path, tuple[int, int] | None] = {}

    assets = sorted(spr_dir.glob("*.asset"))
    log(f"cropping {len(assets)} Sprite assets …")
    for i, asset in enumerate(assets):
        if i and i % 1000 == 0:
            log(f"  … {i}/{len(assets)} (cropped={cropped})")
        text = asset.read_text(encoding="utf-8", errors="ignore")
        gm = TEX_GUID_RE.search(text)
        rm = RECT_RE.search(text)
        if not gm or not rm:
            skipped_bad += 1
            continue
        page = guid_map.get(gm.group(1).lower())
        if page is None:
            skipped_bad += 1
            continue
        if is_font_atlas_name(page.name) or is_font_atlas_name(asset.stem + ".png"):
            if is_font_atlas_name(page.name):
                font_pages_seen.add(page.name)
            skipped_font_page += 1
            continue
        x, y, w, h = map(float, rm.groups())
        # Whole-texture sprite on a loose (non-atlas) texture → the loose-copy pass
        # emits the original file; re-encoding it here would only create `__hash` dupes.
        if not page.name.startswith("sactx-"):
            if page not in page_sizes:
                page_sizes[page] = png_size(page)
            size = page_sizes[page]
            if size and int(round(x)) == 0 and int(round(y)) == 0 \
                    and int(round(w)) == size[0] and int(round(h)) == size[1]:
                skipped_full_rect += 1
                continue
        try:
            tile = crop_sprite(page, x, y, w, h)
        except OSError:
            skipped_bad += 1
            continue
        if tile is None:
            skipped_bad += 1
            continue
        out_name = f"{asset.stem}.png"
        saved = save_png(tile, out_images, out_name, seen)
        if saved is None:
            skipped_dup += 1
            continue
        cropped += 1
        fam = spr_atlas.get(asset.stem) or atlas_family_from_page(page.name)
        page_to_sprites[page.name].append(saved)
        sprite_entries.append(
            {
                "file": saved,
                "sprite": asset.stem,
                "atlas": fam,
                "page": page.name,
                "rect": {"x": x, "y": y, "w": w, "h": h},
            }
        )

    # Loose textures: non-sactx, non-font, not already covered as whole-page
    log("copying loose (non-atlas) textures …")
    loose = 0
    skipped_sactx = 0
    skipped_font_tex = 0
    for p in sorted(tex_dir.glob("*")):
        if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
            continue
        if p.name.startswith("sactx-"):
            skipped_sactx += 1
            if args.keep_atlas_pages and not is_font_atlas_name(p.name):
                name = safe_copy(p, out_images, seen)
                if name:
                    loose += 1
            continue
        if is_font_atlas_name(p.name):
            font_pages_seen.add(p.name)
            skipped_font_tex += 1
            continue
        name = safe_copy(p, out_images, seen)
        if name:
            loose += 1

    log("copying fonts (.ttf/.otf/.fnt) …")
    fonts = copy_fonts(ripped, out_fonts)

    manifest = {
        "method": "unityproject_sprite_rect_crop",
        "images_dir": "output/images",
        "fonts_dir": "output/fonts",
        "counts": {
            "sprites_cropped": cropped,
            "loose_textures": loose,
            "fonts": len(fonts),
            "skipped_font_page_sprites": skipped_font_page,
            "skipped_font_textures": skipped_font_tex,
            "skipped_sactx_pages": skipped_sactx,
            "skipped_bad_or_unresolved": skipped_bad,
            "skipped_dup": skipped_dup,
            "skipped_full_rect_loose": skipped_full_rect,
            "images_total": cropped + loose,
        },
        "font_atlas_pages_skipped": sorted(font_pages_seen),
        "fonts": fonts,
        "page_to_sprites": {k: v for k, v in sorted(page_to_sprites.items())},
        "sprites": sprite_entries,
    }
    man_path = work / "output" / "de_atlas_manifest.json"
    # sprites list is large — still useful for filter; write it
    man_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # compact lookup for filter (name → atlas)
    lookup = {
        "by_file": {e["file"]: e.get("atlas") for e in sprite_entries},
        "page_to_sprites": manifest["page_to_sprites"],
    }
    (work / "output" / "de_atlas_lookup.json").write_text(
        json.dumps(lookup, indent=2), encoding="utf-8"
    )

    # update manifest.json if present (same keys rip_apk.py writes: counts / sizes_bytes)
    root_man = work / "output" / "manifest.json"
    if root_man.exists():
        try:
            data = json.loads(root_man.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        counts = data.setdefault("counts", {})
        counts["images"] = cropped + loose
        counts["fonts"] = len(fonts)
        sizes = data.setdefault("sizes_bytes", {})
        sizes["images"] = sum(f.stat().st_size for f in out_images.iterdir() if f.is_file())
        sizes["fonts"] = (
            sum(f.stat().st_size for f in out_fonts.iterdir() if f.is_file()) if out_fonts.exists() else 0
        )
        data["de_atlas"] = manifest["counts"]
        for stale in ("images", "fonts", "bytes"):  # keys written by an earlier version
            data.pop(stale, None)
        root_man.write_text(json.dumps(data, indent=2), encoding="utf-8")

    log(
        f"done: images={cropped + loose} (cropped={cropped} loose={loose} "
        f"full_rect_skipped={skipped_full_rect}) fonts={len(fonts)} font_pages_skipped={len(font_pages_seen)}"
    )
    log(f"wrote {man_path}")


if __name__ == "__main__":
    main()
