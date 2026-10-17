#!/usr/bin/env python3
"""Recover IL2CPP game code from an unity-apk-rip workdir into <workdir>/decompiled/.

Usage:
  decompile_il2cpp.py --workdir <dir> [--out <dir>] [--abi arm64-v8a|armeabi-v7a]
                      [--assemblies Assembly-CSharp Assembly-CSharp-firstpass ...]
                      [--helpers <helpers.tsv>] [--from cpp2il|inspector|symbols|ghidra|rea|manifest]

Stages: cpp2il (C# declarations + stub DLLs) -> inspector (address map + C++ headers)
-> symbols (symbols.tsv, labels.tsv) -> ghidra (named project + pseudo_c/) -> rea (Java-side
Evidence) -> manifest (decompiled/manifest.json, README.md, output/manifest.json pointer).
Tools come from setup_tools.sh (run it first). Expect ~5 min for a 50 MB libil2cpp.so on Apple silicon.
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGES = ['cpp2il', 'inspector', 'symbols', 'ghidra', 'rea', 'manifest']
METADATA_MAGIC = bytes.fromhex('af1bb1fa')
ANSI = re.compile(r'\x1b\[[0-9;]*m')
THIRD_PARTY = re.compile(
    r'^(Unity|UnityEngine|System|Mono|mscorlib|netstandard|Microsoft|Newtonsoft|TMPro|DOTween|DG\.|Cinemachine|'
    r'com\.|Google|Firebase|Facebook|AppsFlyer|Sentry|MaxSdk|GoogleMobileAds|Sirenix|spine|Spine|PrimeTween|'
    r'Coffee|Balancy|revenuecat|Lofelt|NaughtyAttributes|__Generated|Assembly-CSharp)', re.I)


def log(msg):
    print(f'[decompile] {msg}', file=sys.stderr, flush=True)


def tool_env():
    out = subprocess.run([str(HERE / 'setup_tools.sh'), '--check'], capture_output=True, text=True)
    if out.returncode:
        sys.exit(f'toolchain incomplete; run {HERE / "setup_tools.sh"}\n{out.stderr}')
    env = dict(os.environ)
    for line in out.stdout.splitlines():
        k, v = line.removeprefix('export ').split('=', 1)
        env[k] = v
    return env


def run(cmd, logfile, env, cwd=None):
    log(' '.join(str(c) for c in cmd[:3]) + ' ...')
    with open(logfile, 'w', encoding='utf-8') as f:
        proc = subprocess.run([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, env=env, cwd=cwd)
        f.write(ANSI.sub('', proc.stdout))
    if proc.returncode:
        sys.exit(f'{cmd[0]} failed ({proc.returncode}); see {logfile}')
    return ANSI.sub('', proc.stdout)


def find_inputs(work, abi):
    abis = [abi] if abi else ['arm64-v8a', 'armeabi-v7a']
    so = None
    for a in abis:
        hits = sorted(glob.glob(str(work / 'apk_base/lib' / a / 'libil2cpp.so'))) + \
            sorted(glob.glob(str(work / 'apk_*/lib' / a / 'libil2cpp.so')))
        if hits:
            so, abi = Path(hits[0]), a
            break
    if not so:
        sys.exit(f'no libil2cpp.so for {abis} under {work}/apk_*/lib (Mono build? then scripts are already readable)')
    meta = work / 'apk_base/assets/bin/Data/Managed/Metadata/global-metadata.dat'
    if not meta.exists():
        hits = glob.glob(str(work / 'apk_*/**/global-metadata.dat'), recursive=True)
        meta = Path(hits[0]) if hits else None
    if not meta:
        sys.exit('global-metadata.dat not found (encrypted or embedded metadata: needs a dumped/decrypted file)')
    with open(meta, 'rb') as f:
        head = f.read(8)
    if head[:4] != METADATA_MAGIC:
        sys.exit(f'{meta}: magic {head[:4].hex()} != af1bb1fa; metadata is encrypted/obfuscated. '
                 'Recover a decrypted global-metadata.dat first (runtime dump), then pass it via apk_base.')
    return so, abi, meta, int.from_bytes(head[4:8], 'little')


def unity_version(work, so):
    try:
        v = json.loads((work / 'output/manifest.json').read_text()).get('unity_version')
        if v:
            return v
    except (OSError, ValueError):
        pass
    for p in glob.glob(str(work / 'ripped/UnityProject/**/ProjectSettings/ProjectVersion.txt'), recursive=True):
        m = re.search(r'm_EditorVersion:\s*(\S+)', Path(p).read_text())
        if m:
            return m.group(1)
    lib = so.parent / 'libunity.so'
    if lib.exists():
        m = re.search(rb'(20\d\d\.\d+\.\d+[abfp]\d+|6000\.\d+\.\d+[abfp]\d+)', lib.read_bytes())
        if m:
            return m.group(1).decode()
    sys.exit('Unity version unknown; add it to output/manifest.json unity_version')


def base_apk(work):
    apks = [p for p in glob.glob(str(work / 'extracted/*.apk')) if not os.path.basename(p).startswith('config.')]
    if not apks:
        apks = glob.glob(str(work / '*.apk'))
    return Path(max(apks, key=os.path.getsize)) if apks else None


def ghidra_stats(logtext):
    stats = {}
    for line in logtext.splitlines():
        m = re.search(r'address delta: 0x([0-9a-f]+)', line)
        if m:
            stats['ghidra_address_delta'] = '0x' + m.group(1)
        m = re.search(r'Functions named: (\d+), failed: (\d+), to decompile: (\d+)', line)
        if m:
            stats.update(functions_named=int(m.group(1)), functions_failed=int(m.group(2)))
        m = re.search(r'Decompiled (\d+) functions into (\d+) files', line)
        if m:
            stats.update(functions_decompiled=int(m.group(1)), pseudo_c_files=int(m.group(2)))
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workdir', required=True, type=Path)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--abi')
    ap.add_argument('--assemblies', nargs='+', default=['Assembly-CSharp', 'Assembly-CSharp-firstpass'])
    ap.add_argument('--helpers', type=Path)
    ap.add_argument('--from', dest='start', choices=STAGES, default='cpp2il')
    a = ap.parse_args()
    work = a.workdir.resolve()
    out = (a.out or work / 'decompiled').resolve()
    (out / 'logs').mkdir(parents=True, exist_ok=True)
    env = tool_env()
    so, abi, meta, meta_ver = find_inputs(work, a.abi)
    uver = unity_version(work, so)
    helpers = (a.helpers or out / 'helpers.tsv').resolve()
    log(f'{so} ({abi}), metadata v{meta_ver}, Unity {uver}')
    todo = STAGES[STAGES.index(a.start):]
    cpp2il = [env['IL2CPP_CPP2IL'], '--force-binary-path', so, '--force-metadata-path', meta,
              '--force-unity-version', uver, '--use-processor', 'attributeinjector']

    if 'cpp2il' in todo:
        for d in ('cpp2il_cs', 'dummy_dll'):
            shutil.rmtree(out / d, ignore_errors=True)
        run(cpp2il + ['--output-as', 'diffable-cs', '--output-to', out / 'cpp2il_cs'], out / 'logs/cpp2il_cs.log', env)
        run(cpp2il + ['--output-as', 'dll_default', '--output-to', out / 'dummy_dll'], out / 'logs/cpp2il_dll.log', env)

    if 'inspector' in todo:
        shutil.rmtree(out / 'il2cppinspector', ignore_errors=True)
        (out / 'il2cppinspector').mkdir()
        run([env['IL2CPP_INSPECTOR'], '-i', so, '-m', meta, '--select-outputs',
             '-o', out / 'il2cppinspector/metadata.json', '-h', out / 'il2cppinspector/cpp'],
            out / 'logs/il2cppinspector.log', env)

    if 'symbols' in todo:
        run([sys.executable, '-I', HERE / 'build_symbols.py', out / 'cpp2il_cs/DiffableCs', out / 'symbols.tsv',
             *a.assemblies], out / 'logs/symbols.log', env)
        run([sys.executable, '-I', HERE / 'build_labels.py', out / 'il2cppinspector/metadata.json',
             out / 'symbols.tsv', out / 'labels.tsv', helpers], out / 'logs/labels.log', env)

    if 'ghidra' in todo:
        for d in ('ghidra_project', 'pseudo_c'):
            shutil.rmtree(out / d, ignore_errors=True)
        (out / 'ghidra_project').mkdir()
        genv = dict(env, MAXMEM=env.get('MAXMEM', '10G'))
        run([Path(env['GHIDRA_INSTALL_DIR']) / 'support/analyzeHeadless', out / 'ghidra_project', 'il2cpp',
             '-import', so, '-noanalysis', '-scriptPath', HERE, '-postScript', 'Il2CppDecompile.java',
             out / 'symbols.tsv', out / 'pseudo_c', so, out / 'labels.tsv'],
            out / 'logs/ghidra.log', genv, cwd=out / 'ghidra_project')

    if 'rea' in todo:
        apk = base_apk(work)
        (out / 'rea_evidence').mkdir(exist_ok=True)
        if apk:
            pkg_json = out / 'rea_evidence/inspect-android-package.json'
            pkg_json.write_text(run([env['IL2CPP_REA'], 'inspect-android-package', apk, '--json'],
                                    out / 'logs/rea_package.log', env))
            pkg = json.loads(pkg_json.read_text())['normalized_result']['package_name']
            (out / 'rea_evidence/search-android-classes.json').write_text(
                run([env['IL2CPP_REA'], 'search-android-classes', apk, pkg, '--json'], out / 'logs/rea_search.log', env))
        else:
            log('no base .apk under extracted/; skipping REA Java-side Evidence')

    if 'manifest' in todo:
        prev = {}
        try:
            prev = json.loads((out / 'manifest.json').read_text())
        except (OSError, ValueError):
            pass
        assemblies = sorted(p.name for p in (out / 'cpp2il_cs/DiffableCs').iterdir() if p.is_dir())
        glog = (out / 'logs/ghidra.log').read_text() if (out / 'logs/ghidra.log').exists() else ''
        m = {
            'tool': 'il2cpp-decompile',
            'created': datetime.datetime.now().isoformat(timespec='seconds'),
            'workdir': str(work), 'binary': str(so), 'abi': abi, 'pointer_size': 8 if '64' in abi else 4,
            'metadata': str(meta), 'metadata_version': meta_ver, 'unity_version': uver,
            'decompiled_assemblies': a.assemblies,
            'other_game_assembly_candidates': [x for x in assemblies if not THIRD_PARTY.match(x)],
            'helpers': str(helpers) if helpers.exists() else None,
            # Il2CppClass vtable start; calibrate with vcall.py --save-base before trusting slot names.
            'vtable_base': prev.get('vtable_base'),
            'paths': {k: str(out / v) for k, v in {
                'declarations': 'cpp2il_cs/DiffableCs', 'pseudo_c': 'pseudo_c', 'dummy_dll': 'dummy_dll',
                'symbols': 'symbols.tsv', 'labels': 'labels.tsv', 'headers': 'il2cppinspector/cpp',
                'address_map': 'il2cppinspector/metadata.json', 'ghidra_project': 'ghidra_project/il2cpp.gpr',
                'rea_evidence': 'rea_evidence'}.items()},
            **ghidra_stats(glog),
        }
        (out / 'manifest.json').write_text(json.dumps(m, indent=2) + '\n')
        shutil.copy(HERE.parent / 'references/decompiled-readme.md', out / 'README.md')
        om = work / 'output/manifest.json'
        if om.exists():
            doc = json.loads(om.read_text())
            doc.setdefault('source_paths', {})['decompiled'] = str(out)
            doc['code_recovery'] = {'tool': 'il2cpp-decompile', 'pseudo_c_functions': m.get('functions_decompiled'),
                                    'assemblies': a.assemblies, 'manifest': str(out / 'manifest.json')}
            om.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps({k: m.get(k) for k in ('abi', 'unity_version', 'metadata_version', 'functions_named',
                                                 'functions_decompiled', 'pseudo_c_files',
                                                 'other_game_assembly_candidates')}, indent=2))


if __name__ == '__main__':
    main()
