#!/usr/bin/env python3
"""Filter output/images → output/images_ingame using GamePlay dependency walk + atlas allowlist.

Works on de-atlased packs (reads output/de_atlas_lookup.json → sprite → SpriteAtlas family) and on
legacy packs where sactx-* pages are still whole files. Font atlas PNGs are always dropped
(fonts live in output/fonts/).

Stdlib only. Usage:
  python3 filter_ingame_images.py --workdir /path/to/case-study --list-atlases   # triage first
  python3 filter_ingame_images.py --workdir /path/to/case-study \
      --deny arenaatlas,journeyspriteatlas --allow gameplayatlas,ingameuiatlas

Defaults below were tuned on Block Out! (grandgames). For a new game:
  1. run --list-atlases, 2. pass --allow/--deny (or --config JSON), 3. run.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import deque
from pathlib import Path

IMG_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".webp", ".bmp"}
FOLLOW_EXTS = {
    ".prefab",
    ".unity",
    ".mat",
    ".asset",
    ".controller",
    ".anim",
    ".overridecontroller",
    ".spriteatlas",
    ".spriteatlasv2",
}

# Always keep these atlas families (core board / in-level UI).
ATLAS_ALLOW = (
    "gameplayatlas",
    "gameplaynineslice",
    "ingameuiatlas",
    "boosterspriteatlas",
    "commonfxatlas",
    "newobstacleintro",
    "level_fail",
    "level_win",
    "pausepopup",
    "stuck_atlas",
    "coinanimationspriteatlas",
    "superrocketatlas",  # in-level power-up VFX
)

# Drop these atlas families even if a shared GUID pull includes them.
ATLAS_DENY = (
    "arenaatlas",
    "jetpackspriteatlas",
    "jetpackraceparticles",
    "blockoutcollection",
    "gaziatlas",
    "streakspriteatlas",
    "lilyleapatlas",
    "storeatlas",
    "magiclabspriteatlas",
    "dailyrewardatlas",
    "cardpacks",
    "treasure_drill",
    "magicpass",
    "journeyspriteatlas",
    "chestatlas",
    "gaeatlas",
    "leaderboardatlas",
    "settingsatlas",
    "collectionpopup",
    "infopopup",
    "skyjumpatlas",
    "skyjumpwithstage",
    "cardview",
    "paw_touch",
    "cart_craze",
    "homespriteatlas",
    "surf_sale",
    "ocean_riches",
    "uforiseatlas",
    "fb_login",
    "profileatlas",
)

SEED_NAME_KEYS = (
    "gameplay",
    "ingame",
    "board",
    "blockpiece",
    "doorpiece",
    "booster",
    "levelwin",
    "levelfail",
    "levelstuck",
    "obstacle",
    "generator",
    "powerup",
    "tutorialhand",
    "newobstacle",
)

GUID_RE = re.compile(r"guid:\s*([a-f0-9]{32})", re.I)


def log(msg: str) -> None:
    print(f"[filter-images] {msg}", flush=True)


# Populated from output/de_atlas_lookup.json when present (de-atlased packs).
DE_ATLAS_BY_FILE: dict[str, str | None] = {}
DE_ATLAS_PAGE_TO_SPRITES: dict[str, list[str]] = {}


def atlas_family(name: str) -> str | None:
    """Extract SpriteAtlas family from sactx-* page OR de-atlas lookup."""
    base = Path(name).name
    if base in DE_ATLAS_BY_FILE and DE_ATLAS_BY_FILE[base]:
        return str(DE_ATLAS_BY_FILE[base])
    plain = re.sub(r"__[0-9a-f]{8}$", "", Path(base).stem) + Path(base).suffix
    if plain in DE_ATLAS_BY_FILE and DE_ATLAS_BY_FILE[plain]:
        return str(DE_ATLAS_BY_FILE[plain])

    n = name
    if not n.lower().startswith("sactx-"):
        return None
    if "-ASTC " not in n:
        # fallback: last meaningful chunk before hash
        return n.rsplit(".", 1)[0]
    mid = n.split("-ASTC ", 1)[1]
    if mid.startswith(("4x4-", "6x6-")):
        mid = mid.split("-", 1)[1]
    return mid.rsplit("-", 1)[0]


def load_de_atlas_lookup(workdir: Path) -> None:
    global DE_ATLAS_BY_FILE, DE_ATLAS_PAGE_TO_SPRITES
    p = workdir / "output" / "de_atlas_lookup.json"
    if not p.is_file():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    DE_ATLAS_BY_FILE = dict(data.get("by_file") or {})
    DE_ATLAS_PAGE_TO_SPRITES = dict(data.get("page_to_sprites") or {})
    log(f"de-atlas lookup: {len(DE_ATLAS_BY_FILE)} sprites, {len(DE_ATLAS_PAGE_TO_SPRITES)} pages")


def matches_any(hay: str, needles: tuple[str, ...]) -> bool:
    h = hay.lower()
    return any(n in h for n in needles)


def build_guid_map(assets: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for meta in assets.rglob("*.meta"):
        try:
            text = meta.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        m = re.search(r"^guid:\s*([a-f0-9]{32})", text, re.M)
        if not m:
            continue
        target = Path(str(meta)[:-5])  # strip .meta
        out[m.group(1).lower()] = target
    return out


def collect_seeds(assets: Path) -> list[Path]:
    seeds: list[Path] = []
    scenes = assets / "Scenes"
    for name in ("GamePlayScene.unity", "GameplayScene.unity"):
        p = scenes / name
        if p.is_file():
            seeds.append(p)
    for p in assets.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".prefab", ".unity", ".asset"}:
            continue
        if matches_any(p.as_posix(), SEED_NAME_KEYS):
            seeds.append(p)
    # dedupe
    seen: set[Path] = set()
    uniq: list[Path] = []
    for s in seeds:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq


def bfs_image_names(assets: Path, guid_map: dict[str, Path], seeds: list[Path]) -> set[str]:
    used: set[str] = set()
    q: deque[Path] = deque()
    seen_files: set[Path] = set()
    seen_guids: set[str] = set()

    for s in seeds:
        q.append(s)
        seen_files.add(s)

    while q:
        f = q.popleft()
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # Sprite .asset itself → de-atlased filename stem.png
        if f.suffix.lower() == ".asset" and f.parent.name == "Sprite":
            used.add(f"{f.stem}.png")

        for g in GUID_RE.findall(text):
            g = g.lower()
            if g in seen_guids:
                continue
            seen_guids.add(g)
            tgt = guid_map.get(g)
            if tgt is None or not tgt.is_file():
                continue
            suf = tgt.suffix.lower()
            if suf in IMG_EXTS:
                used.add(tgt.name)
                # expand atlas page → cropped sprite filenames
                for spr in DE_ATLAS_PAGE_TO_SPRITES.get(tgt.name, []):
                    used.add(spr)
            if tgt.parent.name == "Sprite" and suf == ".asset":
                used.add(f"{tgt.stem}.png")
            if suf in FOLLOW_EXTS and tgt not in seen_files:
                seen_files.add(tgt)
                q.append(tgt)
    return used


NAME_ALLOW: tuple[str, ...] = ()
NAME_DENY: tuple[str, ...] = ()


def decide(filename: str, bfs_names: set[str]) -> tuple[bool, str]:
    """Return (keep, reason)."""
    base = filename
    # collected names may have __hash8 collision suffix
    stem = Path(base).stem
    plain = re.sub(r"__[0-9a-f]{8}$", "", stem) + Path(base).suffix

    if NAME_DENY and matches_any(base, NAME_DENY):
        return False, "name_deny"

    fam = atlas_family(base) or atlas_family(plain)
    if fam:
        if matches_any(fam, ATLAS_ALLOW):
            return True, f"atlas_allow:{fam}"
        if matches_any(fam, ATLAS_DENY):
            return False, f"atlas_deny:{fam}"

    # Font atlas PNGs are excluded at de-atlas time; if any remain, drop them.
    if (
        "sdf" in base.lower()
        or base.lower().endswith(" atlas.png")
        or base.lower().startswith("digits_atlas")
        or ("font" in base.lower() and "atlas" in base.lower())
    ):
        return False, "font_atlas_skip"

    if base in bfs_names or plain in bfs_names:
        # still drop denied atlas pages that somehow matched plain name only
        if fam and matches_any(fam, ATLAS_DENY):
            return False, f"atlas_deny:{fam}"
        return True, "bfs_gameplay"

    if fam and matches_any(fam, ATLAS_ALLOW):
        return True, f"atlas_allow:{fam}"

    if NAME_ALLOW and matches_any(base, NAME_ALLOW):
        return True, "name_allow"

    return False, "not_referenced"


def _csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(v.strip().lower() for v in value.split(",") if v.strip())


def list_atlas_families(src: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    if DE_ATLAS_BY_FILE:
        for name, fam in DE_ATLAS_BY_FILE.items():
            if not fam or not (src / name).is_file():
                continue
            counts[fam] = counts.get(fam, 0) + 1
        if counts:
            return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower())))
    for p in src.iterdir():
        if not p.is_file():
            continue
        fam = atlas_family(p.name)
        if fam:
            counts[fam] = counts.get(fam, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower())))


def main() -> int:
    global ATLAS_ALLOW, ATLAS_DENY, SEED_NAME_KEYS, NAME_ALLOW, NAME_DENY

    ap = argparse.ArgumentParser(description="Filter ripped images to in-game / gameplay set")
    ap.add_argument("--workdir", required=True, type=Path, help="case-study root (contains ripped/ + output/)")
    ap.add_argument("--keep-fonts", action="store_true", help=argparse.SUPPRESS)  # legacy no-op
    ap.add_argument("--no-keep-fonts", action="store_true", help=argparse.SUPPRESS)  # legacy no-op
    ap.add_argument("--dest-name", default="images_ingame", help="output subfolder under output/ (default images_ingame)")
    ap.add_argument("--list-atlases", action="store_true", help="print SpriteAtlas families found in output/images and exit (no copy)")
    ap.add_argument("--config", type=Path, help="JSON with optional keys: atlas_allow, atlas_deny, seed_keys, seed_scenes (lists). Replaces defaults.")
    ap.add_argument("--allow", help="comma list appended to atlas allowlist (case-insensitive substrings)")
    ap.add_argument("--deny", help="comma list appended to atlas denylist")
    ap.add_argument("--seed-keys", help="comma list appended to prefab/scene path keywords used as BFS seeds")
    ap.add_argument(
        "--seed-scene",
        action="append",
        default=[],
        help="extra scene to seed: bare name under Assets/Scenes, or relative path under Assets/ (repeatable)",
    )
    ap.add_argument(
        "--name-allow",
        help="comma substrings: keep images whose filename matches even if BFS missed (e.g. tex_,SPR_,Tfx_,Icn_)",
    )
    ap.add_argument(
        "--name-deny",
        help="comma substrings: drop images whose filename matches even if BFS hit (e.g. Meta_,LDR_,console)",
    )
    args = ap.parse_args()

    workdir: Path = args.workdir.resolve()
    assets = workdir / "ripped" / "UnityProject" / "ExportedProject" / "Assets"
    src = workdir / "output" / "images"
    dest = workdir / "output" / args.dest_name
    manifest_path = workdir / "output" / f"{args.dest_name}_manifest.json"

    if not src.is_dir():
        print(f"missing output/images: {src}", file=sys.stderr)
        return 1

    load_de_atlas_lookup(workdir)

    if args.list_atlases:
        fams = list_atlas_families(src)
        print(f"{'sprites':>7}  atlas family")
        for fam, n in fams.items():
            tag = "ALLOW" if matches_any(fam, ATLAS_ALLOW) else ("DENY " if matches_any(fam, ATLAS_DENY) else "?    ")
            print(f"{n:>7}  [{tag}] {fam}")
        print("\nPass --allow/--deny (comma lists, substrings) or --config to change tags marked '?'.")
        return 0

    if args.config:
        cfg = json.loads(args.config.read_text(encoding="utf-8"))
        if "atlas_allow" in cfg:
            ATLAS_ALLOW = tuple(str(x).lower() for x in cfg["atlas_allow"])
        if "atlas_deny" in cfg:
            ATLAS_DENY = tuple(str(x).lower() for x in cfg["atlas_deny"])
        if "seed_keys" in cfg:
            SEED_NAME_KEYS = tuple(str(x).lower() for x in cfg["seed_keys"])
        if "name_allow" in cfg:
            NAME_ALLOW = tuple(str(x).lower() for x in cfg["name_allow"])
        if "name_deny" in cfg:
            NAME_DENY = tuple(str(x).lower() for x in cfg["name_deny"])
        for s in cfg.get("seed_scenes", []):
            args.seed_scene.append(str(s))
    ATLAS_ALLOW = ATLAS_ALLOW + _csv(args.allow)
    ATLAS_DENY = ATLAS_DENY + _csv(args.deny)
    SEED_NAME_KEYS = SEED_NAME_KEYS + _csv(args.seed_keys)
    NAME_ALLOW = NAME_ALLOW + _csv(args.name_allow)
    NAME_DENY = NAME_DENY + _csv(args.name_deny)

    if not assets.is_dir():
        print(f"missing Unity export: {assets}", file=sys.stderr)
        return 1

    log(f"guid map from {assets}")
    guid_map = build_guid_map(assets)
    log(f"guids={len(guid_map)}")

    seeds = collect_seeds(assets)
    for extra in args.seed_scene:
        candidates = []
        if "/" in extra or extra.endswith(".unity"):
            candidates.append(assets / extra)
            candidates.append(assets / "Scenes" / Path(extra).name)
        else:
            candidates.append(assets / "Scenes" / extra)
            # also search by basename under Assets
            for hit in assets.rglob(extra if extra.endswith(".unity") else f"{extra}.unity"):
                candidates.append(hit)
                break
        for p in candidates:
            if p.is_file() and p not in seeds:
                seeds.append(p)
                break
    log(f"seeds={len(seeds)}")
    bfs_names = bfs_image_names(assets, guid_map, seeds)
    log(f"bfs image names={len(bfs_names)}")

    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    kept: list[dict] = []
    dropped: list[dict] = []
    for p in sorted(src.iterdir()):
        if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
            continue
        keep, reason = decide(p.name, bfs_names)
        entry = {"file": p.name, "reason": reason, "bytes": p.stat().st_size}
        if keep:
            shutil.copy2(p, dest / p.name)
            kept.append(entry)
        else:
            dropped.append(entry)

    kept_bytes = sum(e["bytes"] for e in kept)
    drop_bytes = sum(e["bytes"] for e in dropped)
    manifest = {
        "workdir": str(workdir),
        "source": str(src),
        "dest": str(dest),
        "method": "gameplay_bfs + atlas_allow - atlas_deny + name_allow - name_deny (atlas family via de_atlas_lookup.json when present)",
        "de_atlas_lookup": bool(DE_ATLAS_BY_FILE),
        "seeds": len(seeds),
        "bfs_image_names": len(bfs_names),
        "atlas_allow": list(ATLAS_ALLOW),
        "atlas_deny": list(ATLAS_DENY),
        "name_allow": list(NAME_ALLOW),
        "name_deny": list(NAME_DENY),
        "counts": {"kept": len(kept), "dropped": len(dropped), "source": len(kept) + len(dropped)},
        "sizes_bytes": {"kept": kept_bytes, "dropped": drop_bytes},
        "kept": kept,
        "dropped": dropped,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # also patch main manifest if present
    main_man = workdir / "output" / "manifest.json"
    if main_man.is_file():
        try:
            data = json.loads(main_man.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        data["images_ingame"] = {
            "count": len(kept),
            "bytes": kept_bytes,
            "dir": args.dest_name,
            "manifest": manifest_path.name,
        }
        main_man.write_text(json.dumps(data, indent=2), encoding="utf-8")

    log(f"kept={len(kept)} ({kept_bytes/1e6:.1f} MB)  dropped={len(dropped)} ({drop_bytes/1e6:.1f} MB)")
    log(f"→ {dest}")
    log(f"→ {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
