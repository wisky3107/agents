#!/usr/bin/env python3
"""List the most-called unnamed functions in pseudo_c with sample call sites.

Usage: suggest_helpers.py <decompiled> [--top 12] [--samples 3]

Prints one block per callee: file vaddr (Ghidra address minus ghidra_address_delta), call
count and sample lines with the preceding line. Name a callee only when its call pattern
matches a row of references/reading-pseudo-c.md § Runtime helpers, then add
`vaddr<TAB>name<TAB>pattern` to decompiled/helpers.tsv and rerun
decompile_il2cpp.py --from symbols. Leave uncertain callees unnamed.
"""
import argparse
import collections
import json
import os
import re

CALL = re.compile(r'\b(?:func_0x|FUN_|thunk_FUN_)([0-9a-f]{6,})\s*\(')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--top', type=int, default=12)
    ap.add_argument('--samples', type=int, default=3)
    a = ap.parse_args()
    manifest = json.load(open(os.path.join(a.root, 'manifest.json')))
    delta = int(manifest.get('ghidra_address_delta', '0x0'), 16)
    counts, samples = collections.Counter(), collections.defaultdict(list)
    for dirpath, _, files in os.walk(os.path.join(a.root, 'pseudo_c')):
        for fn in files:
            prev = ''
            for line in open(os.path.join(dirpath, fn), encoding='utf-8', errors='replace'):
                for m in CALL.finditer(line):
                    addr = int(m.group(1), 16)
                    counts[addr] += 1
                    if len(samples[addr]) < a.samples:
                        samples[addr].append((prev.strip(), line.strip()))
                prev = line
    print(f'{sum(counts.values())} unnamed calls to {len(counts)} functions')
    for addr, n in counts.most_common(a.top):
        print(f'\n## vaddr 0x{addr - delta:X}  (ghidra 0x{addr:x})  {n} calls')
        for p, l in samples[addr]:
            print(f'   {p[:110]}\n   > {l[:140]}')


if __name__ == '__main__':
    main()
