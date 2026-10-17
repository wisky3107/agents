#!/usr/bin/env python3
"""Look up a class or method in a decompiled/ tree.

Usage:
  lookup.py <decompiled> <Class> [<Method>] [--callers] [--raw]

Prints the C# declaration (fields with offsets, signatures) from cpp2il_cs, the pseudo-C
body of each matching method from pseudo_c, and with --callers every pseudo-C call site.
Class matches the last type segment (GP_CameraController) or a full name
(GamePlay.GameControllerBase, Outer$Nested). --raw keeps null-check noise.
"""
import argparse
import os
import re
import sys

GUARD_IF = re.compile(r'^\s*if \(.+ == (0|\(.*\)0x0)\) \{$')
GUARD_BODY = re.compile(r'^\s*(ThrowNullReferenceException|il2cpp_codegen_runtime_class_init)\(\);$')
DECL_NOISE = re.compile(r'^\s*\[(Token|Address|FieldOffset)\(')


def display(sym):
    """Ghidra's rendering of a build_symbols.py name in pseudo-C."""
    return sym.replace('$$', '__').replace('$', '_').replace('.', '_')


def load(root):
    rows = []
    with open(os.path.join(root, 'symbols.tsv'), encoding='utf-8') as f:
        for line in f:
            c = line.rstrip('\n').split('\t')
            typ, _, meth = c[2].partition('$$')
            rows.append({'rva': int(c[0], 16), 'sym': c[2], 'type': typ, 'method': meth,
                         'file': c[4], 'sig': c[5], 'decompiled': c[6] == '1'})
    return rows


def type_matches(typ, want):
    return typ == want or typ.rsplit('.', 1)[-1] == want or typ.split('$')[-1] == want \
        or typ.rsplit('.', 1)[-1].split('$')[0] == want


def strip_guards(lines):
    """Drop the compiler's 'if (x == 0) { ThrowNullReferenceException(); }' and class-init blocks."""
    out, i = [], 0
    while i < len(lines):
        if i + 2 < len(lines) and GUARD_IF.match(lines[i]) and GUARD_BODY.match(lines[i + 1]) \
                and lines[i + 2].strip() == '}':
            i += 3
            continue
        out.append(lines[i])
        i += 1
    return out


def sections(cfile):
    lines = open(cfile, encoding='utf-8', errors='replace').read().split('\n')
    starts = [i - 1 for i, l in enumerate(lines) if l.startswith('// RVA 0x')]
    for n, s in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        rva = int(lines[s + 1].split()[2], 16)
        yield rva, lines[s:end]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('cls')
    ap.add_argument('method', nargs='?')
    ap.add_argument('--callers', action='store_true')
    ap.add_argument('--raw', action='store_true')
    a = ap.parse_args()
    rows = [r for r in load(a.root) if type_matches(r['type'], a.cls) and (not a.method or r['method'] == a.method)]
    if not rows:
        sys.exit(f'no symbol for {a.cls} {a.method or ""} in symbols.tsv')
    decl_root = os.path.join(a.root, 'cpp2il_cs/DiffableCs')
    if not a.method:
        for rel in sorted({r['file'] for r in rows}):
            print(f'===== declaration: cpp2il_cs/DiffableCs/{rel}')
            for line in open(os.path.join(decl_root, rel), encoding='utf-8', errors='replace'):
                if line.strip() and not DECL_NOISE.match(line):
                    print(line.rstrip())
    wanted = {r['rva']: r for r in rows if r['decompiled']}
    for rel in sorted({r['file'] for r in wanted.values()}):
        cfile = os.path.join(a.root, 'pseudo_c', rel[:-3] + '.c')
        if not os.path.exists(cfile):
            continue
        for rva, body in sections(cfile):
            if rva in wanted and (a.method or len(wanted) <= 12):
                print(f'===== pseudo_c/{rel[:-3]}.c  RVA 0x{rva:x}')
                print('\n'.join(body if a.raw else strip_guards(body)).rstrip())
    if not a.method and len(wanted) > 12:
        print(f'===== {len(wanted)} methods; pass a method name for bodies')
    not_dec = [r for r in rows if not r['decompiled']]
    if not_dec:
        print(f'===== {len(not_dec)} matching methods are outside the decompiled assemblies '
              f'(rerun decompile_il2cpp.py --from symbols --assemblies ... {not_dec[0]["file"].split("/")[0]})')
    if a.callers:
        names = {display(r['sym']): r for r in rows}
        pat = re.compile(r'\b(' + '|'.join(re.escape(n) for n in names) + r')\s*\(')
        for dirpath, _, files in os.walk(os.path.join(a.root, 'pseudo_c')):
            for fn in sorted(files):
                path = os.path.join(dirpath, fn)
                owner = None
                for no, line in enumerate(open(path, encoding='utf-8', errors='replace'), 1):
                    if line.startswith('// ') and not line.startswith('// RVA') and '(' in line:
                        owner = line[3:].strip()
                    m = pat.search(line)
                    if m and not re.match(r'^\w[\w\s\*]*\s' + re.escape(m.group(1)) + r'\s*\(', line):
                        rel = os.path.relpath(path, os.path.join(a.root, 'pseudo_c'))
                        print(f'{rel}:{no}  [{owner}]  {line.strip()[:160]}')


if __name__ == '__main__':
    main()
