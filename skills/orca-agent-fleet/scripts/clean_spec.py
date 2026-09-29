#!/usr/bin/env python3
"""Strip invisible Unicode from Orca Task specs and worker prompts.

Usage:
  python3 clean_spec.py FILE...          strip in place; report each changed file on stderr
  python3 clean_spec.py --check FILE...  report only; exit 1 when any file contains them
  python3 clean_spec.py < in > out       filter stdin to stdout

Run it on every spec file before `orca orchestration task-create --spec "$(cat FILE)"`.

Why: Claude Code removes zero-width characters when Enter is pressed and then waits for a
second Enter ("Removed N invisible character · review and press Enter to send"). Orca's
prompt delivery presses Enter once, so the Dispatch fails with `agent_prompt_stalled`
(stage `dispatch_input`), and every retry of the same spec stalls again, whatever the
provider, model, or terminal. Coordinator models leak these characters into the specs they
write, most often a ZWJ inside the word "cursor" (`.cursor/`, "Cursor Browser").
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter

# Soft hyphen, Mongolian vowel separator, zero-width space/non-joiner/joiner, LRM/RLM,
# bidi embeddings and isolates, word joiner and invisible operators, BOM / ZWNBSP.
INVISIBLE = re.compile("[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")


def clean(text: str) -> tuple[str, Counter]:
    found = Counter(f"U+{ord(ch):04X}" for ch in INVISIBLE.findall(text))
    return INVISIBLE.sub("", text), found


def describe(found: Counter) -> str:
    return ", ".join(f"{code}x{n}" for code, n in sorted(found.items()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="*", help="spec files to clean in place (default: stdin to stdout)")
    parser.add_argument("--check", action="store_true", help="report only; exit 1 when anything is found")
    args = parser.parse_args()

    if not args.files:
        text, found = clean(sys.stdin.read())
        if found:
            print(f"clean_spec: <stdin>: removed {describe(found)}", file=sys.stderr)
        if args.check:
            return 1 if found else 0
        sys.stdout.write(text)
        return 0

    dirty = False
    for path in args.files:
        with open(path, encoding="utf-8", newline="") as fh:
            original = fh.read()
        text, found = clean(original)
        if not found:
            continue
        dirty = True
        verb = "contains" if args.check else "removed"
        print(f"clean_spec: {path}: {verb} {describe(found)}", file=sys.stderr)
        if not args.check:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
    return 1 if (args.check and dirty) else 0


if __name__ == "__main__":
    sys.exit(main())
