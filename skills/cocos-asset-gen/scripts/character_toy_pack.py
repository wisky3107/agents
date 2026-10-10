#!/usr/bin/env python3
"""Toy concept + face decal for a character or creature mesh on the Blender route.

Usage:
  python3 character_toy_pack.py --concepts <dir with concept-front.png> --out <dir> \
      --subject "<noun, e.g. kid character | knight character | cat>" [--face-extra "whiskers"] [--dry-run]

A bpy generator cannot reach a painterly concept: hair strands, fur and a modelled face come out
as a block-out. Mesh round 5 (2026-10-10, ~/Works/games/pilots/mesh-agent-r5-2026-10-10) fixed
that for characters by giving the mesh worker two extra inputs, both edits of the approved
concept-front.png through codex-image-gen:
  <out>/concept-front.png, concept-threequarter.png, concept-back.png
      the same character redesigned as a chunky vinyl toy of rounded primitives (shape source)
  <out>/face-decal.png
      the face graphics only (eyes, brows, nose, mouth, blush), RGBA on transparent background,
      for a decal shell on the head instead of modelled eyes
Blind judged against the original concept, that won 3/3 and shipped 3/3 against 0/3.

Also writes <out>/art-bible-toy.txt, <out>/toy-jobs.json and <out>/toy-report.json.

Exit codes: 0 ok · 1 usage · 2 codex-image unavailable (`codex-image.mjs check` failed) · 3 generation failed.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

CODEX_IMAGE = pathlib.Path.home() / ".agents/skills/codex-image-gen/scripts/codex-image.mjs"

ART_BIBLE = (
    "Concept art for a casual mobile 3D game, made to be modelled from simple shapes. Style: chunky vinyl "
    "designer-toy, every part a simple rounded primitive (spheres, capsules, rounded boxes, cylinders, cones), "
    "smooth matte-satin surfaces, flat solid colours with no texture noise, no fur, no individual hair strands "
    "(hair is one or a few smooth chunky lobes), soft studio lighting with a faint contact shadow. Eyes, brows, "
    "mouth and blush are flat printed graphics on the face surface. One single subject, centred, fully in frame, "
    "on a plain seamless light-grey background. Camera at about the subject's mid height. No text, no letters, "
    "no logos, no extra props, no ground plane."
)
FRAME = "Aspect: square 1:1, the subject fills about 80% of the frame."


def jobs_for(front: pathlib.Path, out: pathlib.Path, subject: str, face_extra: str) -> list[dict]:
    toy_front = out / "concept-front.png"
    same = f"The exact same {subject} toy from the reference, same design, colours and proportions."
    extra = f", {face_extra}" if face_extra else ""
    return [
        {"out": str(toy_front), "ref": str(front),
         "prompt": f"The same {subject} as the reference (same identity, pose, proportions, colours, outfit and props), "
                   "redesigned as a chunky vinyl toy built from simple rounded primitives, with hair or fur as a few "
                   f"smooth chunky lobes and a flat printed face. VIEW: straight-on front view. {FRAME}"},
        {"out": str(out / "concept-threequarter.png"), "ref": str(toy_front),
         "prompt": f"{same} VIEW: three-quarter view from the front, rotated 45 degrees so the front faces toward the "
                   f"right of the image and one side is visible, camera slightly above. {FRAME}"},
        {"out": str(out / "concept-back.png"), "ref": str(toy_front),
         "prompt": f"{same} VIEW: straight-on rear view. {FRAME}"},
        {"out": str(out / "face-decal.png"), "ref": str(toy_front), "alpha": True,
         "prompt": f"A flat 2D face decal texture for the {subject} in the reference: only the printed face graphics "
                   f"(eyes with highlights, eyebrows, nose, mouth, cheek blush{extra}) drawn flat, straight-on, exactly "
                   "as they sit on the reference face, centred and filling about 70% of the width. No head, no skin, "
                   "no hair, no outline of the face shape. Transparent background. Aspect: square 1:1."},
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--concepts", required=True, help="folder holding the approved concept-front.png")
    ap.add_argument("--out", required=True, help="output folder, e.g. <art_paths>/concepts/<stem>/toy")
    ap.add_argument("--subject", required=True, help='short noun: "kid character", "knight character", "cat"')
    ap.add_argument("--face-extra", default="", help='extra face graphics, e.g. "whiskers"')
    ap.add_argument("--dry-run", action="store_true", help="write the jobs and art bible, generate nothing")
    a = ap.parse_args()

    front = pathlib.Path(a.concepts).resolve() / "concept-front.png"
    if not front.is_file():
        print(f"[toy_pack] missing {front}", file=sys.stderr)
        return 1
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    bible, jobs_file, report = out / "art-bible-toy.txt", out / "toy-jobs.json", out / "toy-report.json"
    bible.write_text(ART_BIBLE + "\n")
    jobs_file.write_text(json.dumps(jobs_for(front, out, a.subject, a.face_extra), indent=1))
    print(f"[toy_pack] jobs → {jobs_file}")
    if a.dry_run:
        return 0

    if subprocess.run(["node", str(CODEX_IMAGE), "check"]).returncode != 0:
        print("[toy_pack] codex-image unavailable (check failed; see its message above)", file=sys.stderr)
        return 2
    gen = subprocess.run(["node", str(CODEX_IMAGE), "gen", "--jobs", str(jobs_file),
                          "--prefix-file", str(bible), "--report", str(report)])
    missing = [j["out"] for j in json.loads(jobs_file.read_text()) if not pathlib.Path(j["out"]).is_file()]
    if gen.returncode != 0 or missing:
        print(f"[toy_pack] generation failed (exit {gen.returncode}); missing: {', '.join(missing) or 'none'}",
              file=sys.stderr)
        return 3
    print(f"[toy_pack] ok → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
