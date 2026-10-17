#!/usr/bin/env python3
"""Build a label table from Il2CppInspector's metadata.json for Il2CppDecompile.java.

Usage: build_labels.py <metadata.json> <symbols.tsv> <out labels.tsv> [helpers.tsv]

Columns: vaddr, kind (F = function entry, D = data label), name, note
Function entries already present in symbols.tsv (Cpp2IL names) are skipped.
helpers.tsv names runtime helpers the metadata does not name (vaddr<TAB>name[<TAB>note]);
it is per binary, filled from suggest_helpers.py output (see references/reading-pseudo-c.md).
"""
import json
import os
import re
import sys

BUILTINS = {'v': 'void', 'b': 'bool', 'c': 'char', 'a': 'sbyte', 'h': 'byte', 's': 'short',
            't': 'ushort', 'i': 'int', 'j': 'uint', 'l': 'long', 'm': 'ulong', 'x': 'long',
            'y': 'ulong', 'f': 'float', 'd': 'double', 'w': 'char'}


def read_helpers(path):
    helpers = {}
    if not path or not os.path.exists(path):
        return helpers
    with open(path, encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            c = line.rstrip('\n').split('\t')
            helpers[int(c[0], 16)] = (c[1], c[2] if len(c) > 2 else 'inferred from call pattern')
    return helpers


class Demangler:
    """Just enough Itanium nested-name parsing for Il2CppInspector's
    _ZN<kind>...E names: identifiers, nested names and template args."""

    def __init__(self, s):
        self.s, self.i = s, 0

    def peek(self):
        return self.s[self.i] if self.i < len(self.s) else ''

    def ident(self):
        m = re.match(r'\d+', self.s[self.i:])
        n = int(m.group(0))
        self.i += len(m.group(0))
        out = self.s[self.i:self.i + n]
        self.i += n
        return out

    def type_(self):
        c = self.peek()
        if c in ('P', 'R', 'K'):
            self.i += 1
            return self.type_()
        if c == 'N':
            return self.nested()[-1]
        if c.isdigit():
            return self.with_args(self.ident())
        if c in BUILTINS:
            self.i += 1
            return BUILTINS[c]
        raise ValueError(f'unsupported {c!r} at {self.i}')

    def with_args(self, name):
        if self.peek() == 'I':
            self.i += 1
            args = []
            while self.peek() != 'E':
                args.append(self.type_())
            self.i += 1
            name = f"{name}<{','.join(args)}>"
        return name

    def nested(self):
        assert self.peek() == 'N'
        self.i += 1
        parts = []
        while self.peek() != 'E':
            if self.peek() in ('C', 'D') and self.s[self.i + 1:self.i + 2].isdigit():
                parts.append('.ctor' if self.peek() == 'C' else '.dtor')
                self.i += 2
                continue
            parts.append(self.with_args(self.ident()))
        self.i += 1
        return parts


def demangle(mangled):
    if not mangled.startswith('_ZN'):
        return None
    try:
        parts = Demangler(mangled[2:]).nested()
        return parts[1:]  # drop the "MethodInfo"/"TypeInfo" kind prefix
    except (ValueError, AttributeError, AssertionError, IndexError):
        return None


def clean(s, limit=None):
    s = re.sub(r'\s+', '', s)
    s = re.sub(r'[^\w.<>,`\[\]$]', '_', s)
    return s[:limit] if limit else s


def main():
    meta_path, symbols_path, out_path = sys.argv[1:4]
    helpers = read_helpers(sys.argv[4] if len(sys.argv) > 4 else None)
    have = set()
    with open(symbols_path, encoding='utf-8') as f:
        for line in f:
            have.add(int(line.split('\t', 1)[0], 16))
    am = json.load(open(meta_path, encoding='utf-8'))['addressMap']
    rows = []

    def add(addr, kind, name, note=''):
        note = note.replace('\t', ' ').replace('\r', '\\r').replace('\n', '\\n')
        rows.append((addr, kind, name, ''.join(ch for ch in note if ch.isprintable())))

    for a, (n, note) in helpers.items():
        add(a, 'F', n, note)
    for key in ('methodDefinitions', 'constructedGenericMethods', 'apis', 'exports'):
        for e in am.get(key, []):
            a = int(e['virtualAddress'], 16)
            if a == 0 or a in have or a in helpers:
                continue
            sig = e.get('signature', '')
            name = sig.split('(', 1)[0].split()[-1] if sig else e['name']
            add(a, 'F', clean(name), e.get('dotNetSignature', ''))
            have.add(a)
    for e in am.get('stringLiterals', []):
        text = e.get('string', '')
        add(int(e['virtualAddress'], 16), 'D', 'StringLiteral_' + clean(re.sub(r'\W+', '_', text), 48), text[:400])
    for e in am.get('typeInfoPointers', []):
        add(int(e['virtualAddress'], 16), 'D', 'TypeInfo_' + clean(e['dotNetType']), e.get('type', ''))
    for e in am.get('typeRefPointers', []):
        add(int(e['virtualAddress'], 16), 'D', 'TypeRef_' + clean(e['dotNetType']))
    for e in am.get('methodInfoPointers', []):
        parts = demangle(e['name'])
        sig = e.get('dotNetSignature', '')
        head = sig.split('(', 1)[0].split()
        method = head[-1] if len(head) > 1 else '.ctor'
        if parts and parts[-1] == '.cctor' or method == '.ctor' and ' static ' in sig:
            method = '.cctor'
        owner = parts[-2] if parts and len(parts) >= 2 else '?'
        add(int(e['virtualAddress'], 16), 'D', clean(f'MethodInfo_{owner}$${method}'), sig)
    for e in am.get('fields', []) + am.get('fieldRvas', []):
        add(int(e['virtualAddress'], 16), 'D', clean(e['name'], 80))

    rows.sort()
    with open(out_path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(f'{r[0]:x}\t{r[1]}\t{r[2]}\t{r[3]}\n')
    kinds = {}
    for r in rows:
        kinds[r[1]] = kinds.get(r[1], 0) + 1
    print(f'{len(rows)} labels {kinds} -> {out_path}')


if __name__ == '__main__':
    main()
