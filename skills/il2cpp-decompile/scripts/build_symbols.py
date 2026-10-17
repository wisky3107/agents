#!/usr/bin/env python3
"""Build an RVA -> method symbol table from Cpp2IL "diffable-cs" output.

Usage: build_symbols.py <DiffableCs dir> <out.tsv> [assembly-to-decompile ...]

Columns: rva, length, symbol, assembly, rel_file, signature, decompile(0/1)
The first method seen at an RVA wins (shared generic bodies map to many methods).
"""
import os
import re
import sys

ADDR_RE = re.compile(r'\[Address\(RVA = "0x([0-9A-Fa-f]+)", Offset = "0x[0-9A-Fa-f]+", Length = "0x([0-9A-Fa-f]+)"\)\]')
TYPE_RE = re.compile(r'\b(class|struct|interface|enum)\s+([^\s:{(]+(?:<[^>]*>)?)')
NS_RE = re.compile(r'^namespace\s+([\w.]+)\s*;')
ACCESSOR_RE = re.compile(r'^(?:(?:private|protected|internal)\s+)*(get|set|add|remove|init)\s*\{')
BAD_CHARS = re.compile(r'[^\w.$<>`\[\],]')


def method_name(sig, type_name, is_static):
    head = sig.split('(', 1)[0].strip()
    name = head.split()[-1] if head else '?'
    bare_type = type_name.split('<', 1)[0].split('`', 1)[0]
    if name.split('<', 1)[0] == bare_type and name.split('<', 1)[0] != '':
        name = '.cctor' if is_static else '.ctor'
    return name


def parse_file(path):
    ns = ''
    stack = []  # [(type_name, depth_at_open)]
    depth = 0
    pending = None
    with open(path, encoding='utf-8', errors='replace') as f:
        for raw in f:
            line = raw.strip()
            m = NS_RE.match(line)
            if m:
                ns = m.group(1)
                continue
            m = ADDR_RE.search(line)
            if m:
                pending = (int(m.group(1), 16), int(m.group(2), 16))
                continue
            if pending and line and not line.startswith('['):
                if not ACCESSOR_RE.match(line) and stack:
                    is_static = ' static ' in f' {line} '
                    type_path = '$'.join(t for t, _ in stack)
                    full_type = f'{ns}.{type_path}' if ns else type_path
                    name = method_name(line, stack[-1][0], is_static)
                    sig = line.split('{', 1)[0].strip()
                    yield pending[0], pending[1], f'{full_type}$${name}', sig
                pending = None
            if not pending and not line.startswith('[') and not line.startswith('//'):
                m = TYPE_RE.search(line)
                if m and '(' not in line.split(m.group(0), 1)[0]:
                    stack.append((m.group(2), depth))
            depth += line.count('{') - line.count('}')
            # A type's '{' is on the line after its declaration, so only pop
            # once depth has dropped back to where the type was declared.
            if line.startswith('}'):
                while stack and depth <= stack[-1][1]:
                    stack.pop()


def main():
    root, out = sys.argv[1], sys.argv[2]
    wanted = set(sys.argv[3:]) or {'Assembly-CSharp'}
    seen = {}
    rows = []
    for asm in sorted(os.listdir(root)):
        asm_dir = os.path.join(root, asm)
        if not os.path.isdir(asm_dir):
            continue
        for dirpath, _, files in os.walk(asm_dir):
            for fn in sorted(files):
                if not fn.endswith('.cs'):
                    continue
                path = os.path.join(dirpath, fn)
                rel = os.path.relpath(path, root)
                for rva, length, sym, sig in parse_file(path):
                    if rva == 0 or rva in seen:
                        continue
                    seen[rva] = sym
                    sym = BAD_CHARS.sub('_', sym).replace(',', '_')
                    rows.append((rva, length, sym, asm, rel, sig.replace('\t', ' '), int(asm in wanted)))
    rows.sort()
    with open(out, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(f'{r[0]:x}\t{r[1]:x}\t{r[2]}\t{r[3]}\t{r[4]}\t{r[5]}\t{r[6]}\n')
    print(f'{len(rows)} unique RVAs, {sum(r[6] for r in rows)} marked for decompilation -> {out}')


if __name__ == '__main__':
    main()
