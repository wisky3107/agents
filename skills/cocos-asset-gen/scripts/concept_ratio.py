#!/usr/bin/env python3
"""Measure the subject's width:height in a concept view and compare it with manifest expect_dims.

Usage:
  python3 concept_ratio.py --image <concepts>/<stem>/concept-front.png \
      --expect-dims "x,y,z" [--forward -Z] [--tolerance 0.15]

The subject is every pixel that differs from its row's background, sampled at the row's left
and right edges (concept backgrounds are plain but often a vertical gradient). Its bounding box gives width:height. The expected
ratio is the manifest's front width over height: x:y when the model faces ±Z, z:y when it faces ±X.

Prints one JSON line and exits 0 when the ratios agree within --tolerance, 1 when they do not
(the concept-check gets `proportions: WARN` and the coordinator decides which wins), 2 on a usage
or image error.
"""
import argparse
import json
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print(json.dumps({"error": "Pillow missing: python3 -m pip install pillow"}))
    sys.exit(2)


def subject_bbox(path, threshold=45, edge=6):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    step = max(1, min(w, h) // 512)  # sample: concepts are ~1-2k px, 512 columns is plenty
    for y in range(0, h, step):
        side = [px[x, y] for x in (*range(edge), *range(w - edge, w))]
        bg = tuple(sum(c[i] for c in side) / len(side) for i in range(3))
        for x in range(edge, w - edge, step):
            p = px[x, y]
            if abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) > threshold:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--expect-dims", required=True, help='manifest expect_dims "x,y,z" (glTF order)')
    ap.add_argument("--forward", default="-Z", choices=("-Z", "+Z", "-X", "+X"))
    ap.add_argument("--tolerance", type=float, default=0.15)
    argv = sys.argv[1:]
    for i, v in enumerate(argv[:-1]):  # argparse reads "-Z" as an option
        if v == "--forward":
            argv[i : i + 2] = [f"--forward={argv[i + 1]}"]
            break
    a = ap.parse_args(argv)
    try:
        x, y, z = (float(v) for v in a.expect_dims.split(","))
        box = subject_bbox(a.image)
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(2)
    if not box:
        print(json.dumps({"error": "no subject found (background not plain?)"}))
        sys.exit(2)
    bw, bh = box[2] - box[0] + 1, box[3] - box[1] + 1
    concept = bw / bh
    expected = (x if a.forward in ("-Z", "+Z") else z) / y
    off = concept / expected - 1
    ok = abs(off) <= a.tolerance
    # Height that would make the manifest match the concept, keeping the front width.
    width = x if a.forward in ("-Z", "+Z") else z
    print(json.dumps({"image": a.image, "bbox_px": [bw, bh], "concept_w_h": round(concept, 3),
                      "manifest_w_h": round(expected, 3), "off": round(off, 3), "ok": ok,
                      "height_for_concept": round(width / concept, 3)}))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
