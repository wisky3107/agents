#!/usr/bin/env python3
"""Name a virtual call `(**(code **)(*obj + OFFSET))(...)` from pseudo-C.

Usage:
  vcall.py <decompiled> <Class> <offset> [--base 0xC0] [--save-base]

slot = (offset - vtable_base) / (2 * pointer_size); names come from the
`struct <Class>__VTable` in il2cppinspector/cpp/appdata/il2cpp-types.h.
vtable_base is the Il2CppClass header size. The generated header can disagree with the
runtime struct (Cat Dash armv7: header 0xBC, runtime 0xC0), so without a calibrated base
this prints candidates. Calibrate once per binary on a call whose target is certain (the
method's own MethodInfo argument, or an override that must be called there), then
--save-base stores it in decompiled/manifest.json.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile


def vtable(header, cls):
    text = open(header, encoding='utf-8', errors='replace').read()
    m = re.search(r'^struct ' + re.escape(cls) + r'__VTable \{\n(.*?)^\};', text, re.M | re.S)
    if not m:
        near = sorted(set(re.findall(r'^struct (\w*' + re.escape(cls) + r'\w*)__VTable \{', text, re.M)))[:15]
        sys.exit(f'no struct {cls}__VTable; candidates: {", ".join(near) or "none"}')
    return re.findall(r'VirtualInvokeData (\w+);', m.group(1))


def header_base(header, cls, ptr):
    target = 'aarch64-linux-android' if ptr == 8 else 'armv7-linux-androideabi'
    probe = (f'#include <stdint.h>\n#include <stddef.h>\n#include "{os.path.basename(header)}"\n'
             f'using namespace app;\ntemplate<int N> struct Show;\nShow<offsetof({cls}__Class, vtable)> s;\n')
    with tempfile.NamedTemporaryFile('w', suffix='.cpp', delete=False) as f:
        f.write(probe)
    try:
        res_dir = subprocess.run(['clang', '-print-resource-dir'], capture_output=True, text=True).stdout.strip()
        out = subprocess.run(['clang++', f'--target={target}', '-nostdinc', f'-I{res_dir}/include',
                              f'-I{os.path.dirname(header)}', '-fsyntax-only', '-w', f.name],
                             capture_output=True, text=True).stderr
    finally:
        os.unlink(f.name)
    m = re.search(r"Show<(\d+)>", out)
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('cls')
    ap.add_argument('offset', type=lambda x: int(x, 0))
    ap.add_argument('--base', type=lambda x: int(x, 0))
    ap.add_argument('--save-base', action='store_true')
    a = ap.parse_args()
    mpath = os.path.join(a.root, 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    ptr = manifest.get('pointer_size', 4)
    header = os.path.join(a.root, 'il2cppinspector/cpp/appdata/il2cpp-types.h')
    slots = vtable(header, a.cls)
    pair = 2 * ptr
    base = a.base if a.base is not None else manifest.get('vtable_base')
    base = int(base, 0) if isinstance(base, str) else base

    def show(b, tag):
        idx, rem = divmod(a.offset - b, pair)
        name = slots[idx] if rem == 0 and 0 <= idx < len(slots) else '(misaligned or out of range)'
        print(f'{tag}: base 0x{b:x} -> slot {idx}{"" if rem == 0 else f" +{rem}"} = {name}'
              f'  (methodPtr +0x{a.offset:x}, MethodInfo +0x{a.offset + ptr:x})')

    if base is not None:
        show(base, 'calibrated' if a.base is None else 'given')
    else:
        hb = header_base(header, a.cls, ptr)
        if hb is None:
            sys.exit('clang could not compute the header vtable offset; pass --base')
        for b in sorted({hb, -(-hb // pair) * pair, hb + ptr}):
            show(b, 'header' if b == hb else 'candidate')
        print('uncalibrated: confirm one candidate on a known call, then rerun with --base X --save-base')
    if a.save_base and a.base is not None:
        manifest['vtable_base'] = hex(a.base)
        json.dump(manifest, open(mpath, 'w'), indent=2)
        print(f'saved vtable_base={hex(a.base)} to {mpath}')


if __name__ == '__main__':
    main()
