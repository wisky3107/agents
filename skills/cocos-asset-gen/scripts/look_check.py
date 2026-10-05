#!/usr/bin/env python3
"""Independent look check for a generated mesh: a model that did not build it judges the sheets.

Usage:
  python3 look_check.py --stem <stem> --concepts <art_paths>/concepts/<stem> \
      --render <evidence>/art/<stem>/round-<n> --out <evidence>/art/<stem>/look-check.md \
      [--features "snout, curly tail, floppy ears"] [--dims "x,y,z"] [--tri-budget N] \
      [--judge-model sonnet] [--round <n>]

The mesh worker grades its own rounds and tends to pass them (pilot 2026-10-05: an Opus worker
called its own pig PASS "lenient"). This runs one fresh `claude -p` session on --judge-model
(default sonnet, so it differs from the default Opus mesh_agent) with Read only. It opens the
concept PNGs plus compare-sheet.png and contact-sheet.png from --render and answers a fixed
rubric. The verdict block is appended to --out.

Exit codes: 0 LOOK: PASS · 1 LOOK: FAIL · 2 judge unavailable or no verdict line.
"""
import argparse
import datetime
import pathlib
import re
import subprocess
import sys

RUBRIC = """You are an independent art reviewer for a casual mobile 3D game. You did not build this
mesh and you have no stake in it passing. Judge only what the images show.

What you are judging: a low-poly game asset (triangle budget {budget}, manifest size {dims} in
metres, glTF x width, y height, z depth) shown in a plain preview renderer. The concept is a
polished illustration of the same object. The question is whether the asset is good enough to
ship in the game, seen from the game's high isometric camera (the contact sheet is closest to
that view). It is not whether it matches the illustration's render quality.

Do not fail the asset for: preview lighting, gloss or sheen; softer or fewer bevels; dropped
micro detail (seams, bolts, slats, decals); mild faceting on curves; proportions that the
manifest size forces (say so instead).
Do fail it for: a missing or unrecognisable signature feature; visible broken geometry (holes,
notches, spikes, pinched or floating parts); wrong colours; a silhouette that does not read as
the object from the isometric angles; anything a player would read as a bug or a placeholder.

Open every image with the Read tool:
- concept views (source of truth): {concepts}
- compare sheet (left column concept, right column the model, rows front / three-quarter / back): {compare}
- contact sheet (the model from four isometric angles, roughly the game camera): {contact}

Signature features the mesh must show: {features}

Answer exactly this block, one line each, nothing before or after it:
silhouette: PASS|FAIL — <reads as the concept's object from the isometric angles>
signature features: PASS|FAIL — <each listed feature present and recognisable>
geometry: PASS|FAIL — <no visible holes, notches, spikes, pinched or floating parts>
colour and style: PASS|FAIL — <concept colours, same toy look within a low-poly budget>
proportions: PASS|FAIL|FORCED — <like the concept; FORCED when only the manifest size explains the difference>
LOOK: PASS | LOOK: FAIL — <the one or two things that must change, or why it ships>

LOOK is PASS when every line is PASS or FORCED."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stem", required=True)
    ap.add_argument("--concepts", required=True)
    ap.add_argument("--render", required=True, help="render_model_iso --out dir of the round")
    ap.add_argument("--out", required=True, help="look-check.md (appended)")
    ap.add_argument("--features", default="the parts that make the concept recognisable")
    ap.add_argument("--dims", default="see the manifest", help='manifest expect_dims "x,y,z"')
    ap.add_argument("--tri-budget", default="see the manifest")
    ap.add_argument("--judge-model", default="sonnet")
    ap.add_argument("--round", default="?")
    a = ap.parse_args()

    concepts = pathlib.Path(a.concepts).resolve()
    render = pathlib.Path(a.render).resolve()
    views = [concepts / f"concept-{v}.png" for v in ("front", "threequarter", "back")]
    compare, contact = render / "compare-sheet.png", render / "contact-sheet.png"
    missing = [str(p) for p in (*views, compare, contact) if not p.is_file()]
    if missing:
        print(f"[look_check] missing: {', '.join(missing)}", file=sys.stderr)
        return 2

    prompt = RUBRIC.format(concepts=", ".join(map(str, views)), compare=compare, contact=contact,
                           features=a.features, dims=a.dims, budget=a.tri_budget)
    try:
        res = subprocess.run(
            ["claude", "-p", prompt, "--model", a.judge_model, "--allowedTools", "Read",
             "--add-dir", str(concepts), "--add-dir", str(render)],
            capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[look_check] judge unavailable: {exc}", file=sys.stderr)
        return 2
    text = res.stdout.strip()
    m = re.search(r"^LOOK:\s*(PASS|FAIL)\b.*$", text, re.M)
    if res.returncode or not m:
        print(f"[look_check] no verdict (exit {res.returncode}): {(text or res.stderr)[-400:]}",
              file=sys.stderr)
        return 2

    block = text[text.find("silhouette:"):] if "silhouette:" in text else text
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("a", encoding="utf-8") as fh:
        fh.write(f"## {a.stem} — look round {a.round} · judge claude --model {a.judge_model} · {stamp}\n"
                 f"sheets: {compare} · {contact}\n{block}\n\n")
    print(m.group(0))
    return 0 if m.group(1) == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
