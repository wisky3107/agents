import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRipPort, sha256 } from '../scripts/validate-rip-port.mjs';
import { classifyScript, resolveSource, buildInventory } from '../scripts/inventory-rip.mjs';
import { writeBundle, writeInventory, writeDecompiled } from './fixture.mjs';

const check = p => validateRipPort(p, 'reference/demo/rip-port');
const save = f => fs.writeFileSync(path.join(f.root, 'RIP_PORT_MANIFEST.json'), JSON.stringify(f.manifest));
function fixture(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-recovery-test-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return { p, ...writeBundle(p) };
}
// AssetRipper IL2CPP export: signatures kept, bodies emptied.
const STUB = `public class Cam : MonoBehaviour
{
	private Transform target;
	public Transform Target { get { return null; } set { } }
	public Cam() : base() { }
	private void LateUpdate()
	{
	}
	public bool TryGet(out int v)
	{
		v = default(int);
		return false;
	}
	public Kind Mode() { return Kind.None; }
	bool IEnumerator.MoveNext()
	{
		//ILSpy generated this explicit interface implementation from .override directive in MoveNext
		return this.MoveNext();
	}
	object IEnumerator.Current { get { return System_002ECollections_002EIEnumerator_002Eget_Current(); } }
}
`;

test('script classifier separates empty-body stubs from real bodies', () => {
  assert.equal(classifyScript(STUB), 'stub');
  assert.equal(classifyScript('// Dummy class\npublic class A { }'), 'dummy');
  assert.equal(classifyScript('public enum Kind { None = 0, Ball = 4 }\npublic class Data { public int x; }'), 'declarations');
  assert.equal(classifyScript('class Board { bool Won(int count) => count == 0; }'), 'bodied');
  assert.equal(classifyScript('class P { void Update() { if (x) { y = Lerp(a, b, t); } } }'), 'bodied');
  assert.equal(classifyScript('class S { string N => "a { } b"; void F() { } }'), 'stub');
});

test('an IL2CPP stub tree is stubs, and AssetRipper patches count as tooling, not bodies', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.up, 'Assets/Scripts/Game/Board.cs'), STUB);
  const patch = path.join(f.up, 'Assets/Editor/AssetRipperPatches/AudioMixerPostprocessor.cs');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, 'class P { static P() { var a = typeof(P).Assembly; Run(a); } }');
  const inv = buildInventory({ unityProject: f.up });
  assert.equal(inv.codeAvailability, 'stubs');
  assert.equal(inv.recommendedDepth, 'lightweight');
  assert.equal(inv.counts.scripts, 2);
  assert.equal(inv.unityProject.scripts.tooling, 1);
});

test('decompiled pseudo-C is resolved from the workdir and recommends full depth', t => {
  const f = fixture(t);
  const workdir = path.dirname(path.dirname(path.dirname(f.up)));
  const { dec } = writeDecompiled(workdir);
  assert.equal(resolveSource(f.out).decompiled, dec);
  fs.writeFileSync(path.join(f.up, 'Assets/Scripts/Game/Board.cs'), STUB);
  const inv = buildInventory({ unityProject: f.up, decompiled: dec });
  assert.equal(inv.codeAvailability, 'stubs');
  assert.equal(inv.decompiledLogic, true);
  assert.equal(inv.recommendedDepth, 'full');
});

test('stub rip plus decompiled pseudo-C supports readable_logic with decompiled evidence', t => {
  const f = fixture(t);
  const { dec, decl, body } = writeDecompiled(path.dirname(path.dirname(path.dirname(f.up))));
  fs.writeFileSync(path.join(f.up, 'Assets/Scripts/Game/Board.cs'), STUB);
  f.dec = dec;
  f.manifest.sources[0] = { ...f.manifest.sources[0], codeAvailability: 'stubs', decompiled: dec };
  f.manifest.evidence = [
    { id: 'E-001', source: 'main', tree: 'decompiled', path: body, sha256: sha256(path.join(dec, body)), kind: 'code', symbol: 'Board__Won' },
    { id: 'E-002', source: 'main', tree: 'decompiled', path: decl, sha256: sha256(path.join(dec, decl)), kind: 'metadata', symbol: 'Board.count @0x10' },
  ];
  f.manifest.claims[0].evidence = ['E-001', 'E-002'];
  writeInventory(f); save(f);
  assert.deepEqual(check(f.p).errors, []);

  f.manifest.evidence[1].kind = 'data'; save(f);
  assert.ok(check(f.p).errors.some(e => e.code === 'rip_evidence_tree'));
});

test('readable_logic on stubs still fails without decompiled pseudo-C', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.up, 'Assets/Scripts/Game/Board.cs'), STUB);
  f.manifest.sources[0].codeAvailability = 'stubs';
  f.manifest.evidence[0].sha256 = sha256(path.join(f.up, 'Assets/Scripts/Game/Board.cs'));
  writeInventory(f); save(f);
  assert.ok(check(f.p).errors.some(e => e.code === 'rip_false_coverage'));
});
