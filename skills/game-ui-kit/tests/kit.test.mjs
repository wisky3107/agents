import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alphaOk, artRows, faceOk, kitFromManifest, opaqueFace, pickKey, prompt, validate } from '../scripts/kit.mjs';

test('pickKey avoids the palette hue', () => {
  assert.equal(pickKey('cyan #3FE0FF, pink #FF4FD8, violet #8B5CFF'), 'green');
  assert.equal(pickKey('mint #3DDC97, lime #7CFF4F, blue #3F7BFF'), 'magenta');
  assert.equal(pickKey('greys only #888888 #222222'), 'magenta');
});

test('validate lists every problem and refuses a TODO art bible', () => {
  const errs = validate({ name: 'k', dir: 'rel', style: 'TODO: later', rows: [{ name: 'Bad Name', backend: 'auto' }] });
  assert.ok(errs.some((e) => /absolute/.test(e)));
  assert.ok(errs.some((e) => /TODO/.test(e)));
  assert.ok(errs.some((e) => /kebab/.test(e)));
  assert.ok(errs.some((e) => /backend must be/.test(e)));
  assert.deepEqual(validate({ name: 'k', dir: '/abs', style: 'glossy #FF0000', rows: [{ name: 'btn-a', backend: 'codex', subject: 's', aspect: 'wide 3:1' }] }), []);
});

test('agy prompts carry the key backdrop; codex prompts do not', () => {
  const kit = { style: 'pink #FF4FD8' }, row = { aspect: 'wide 3:1', subject: 'empty pill' };
  assert.match(prompt(kit, row, 'agy'), /PURE GREEN #00FF00/);
  assert.doesNotMatch(prompt(kit, row, 'codex'), /#00FF00|#FF00FF/);
  assert.doesNotMatch(prompt(kit, { ...row, alpha: false }, 'agy'), /background/);
});

const MAN = { slice: 'S99', assets: { '3d': [{ stem: 'truck', file: 'models/truck.glb', method: 'image-gen' }], '2d': [
  { id: 'btn_play', file: 'textures/ui/btn_play.png', size: [480, 160], alpha: true, method: 'image-gen', source: 'generate', notes: 'orange pill, 9-slice 40px' },
  { id: 'ic_coin', file: 'assets/art/ui/ic_coin.png', size: [128, 128], alpha: true, method: 'image-gen', source: 'generate', notes: 'gold coin icon' },
  { id: 'sky', file: 'textures/sky.png', final_path: 'assets/art/textures/sky.png', size: [2048, 1024], alpha: false, method: 'image-gen', source: 'generate', notes: 'sky gradient' },
  { id: 'logo', file: 'textures/ui/logo.png', size: [800, 400], method: 'image-gen', tier: 'hero', source: 'generate' },
  { id: 'toggle', file: 'textures/ui/toggle.png', size: [120, 60], method: 'procedural', source: 'generate' },
  { id: 'sheet', file: 'textures/ui/icons.png', size: [1536, 256], method: 'image-gen', source: 'generate', layout: { cells: '6x1' } },
  { id: 'font', file: null, method: 'acquire', source: 'existing' },
  { id: 'old', file: 'textures/ui/old.png', method: 'image-gen', source: 'existing' },
] } };

test('artRows keeps generated 2D image-gen / procedural rows only', () => {
  assert.deepEqual(artRows(MAN).map((r) => r.id), ['btn_play', 'ic_coin', 'sky', 'logo', 'toggle', 'sheet']);
  assert.equal(artRows({ assets: [{ stem: 'a', file: 'a.png', method: 'procedural' }] }).length, 1);
});

test('kitFromManifest maps backends, categories, paths and slices', () => {
  const { kit, manual } = kitFromManifest(MAN, { artBackend: 'antigravity', dir: '/tmp/k' });
  const by = Object.fromEntries(kit.rows.map((r) => [r.name, r]));
  assert.deepEqual(manual.map((m) => m.id), ['sheet']);
  assert.equal(by['btn-play'].backend, 'agy');
  assert.equal(by['btn-play'].cat, 'button');
  assert.equal(by['btn-play'].slicePx, 40);
  assert.equal(by['btn-play'].out, 'assets/art/textures/ui/btn_play.png');
  assert.equal(by['ic-coin'].out, 'assets/art/ui/ic_coin.png');
  assert.equal(by['ic-coin'].cat, 'icon');
  assert.equal(by.sky.cat, 'background');
  assert.equal(by.sky.alpha, false);
  assert.equal(by.sky.out, 'assets/art/textures/sky.png');
  assert.equal(by.logo.backend, 'gpt-image-gen');
  assert.equal(by.logo.cat, 'hero');
  assert.equal(by.toggle.backend, 'procedural');
  assert.match(kit.style, /TODO/);
  assert.equal(kitFromManifest(MAN, { artBackend: 'codex-image', override: { icon: 'agy' }, dir: '/tmp/k' }).kit.rows.find((r) => r.name === 'ic-coin').backend, 'agy');
  assert.throws(() => kitFromManifest(MAN, { artBackend: 'cursor', dir: '/tmp/k' }), /no kit route/);
});

test('alphaOk accepts sparse real alpha, rejects opaque art (S18 shadow / track primitives)', () => {
  assert.equal(alphaOk({ transparentPx: 524, cornersTransparent: 4, transparentPct: 0.4 }), true);    // 512x256, 24 px corners
  assert.equal(alphaOk({ transparentPx: 136, cornersTransparent: 4, transparentPct: 0.17 }), true);   // 1280x64 track
  assert.equal(alphaOk({ transparentPx: 0, cornersTransparent: 0, transparentPct: 0 }), false);       // fully opaque
  assert.equal(alphaOk({ transparentPx: 40, cornersTransparent: 0, transparentPct: 0.1 }), false);    // matte backdrop, a few holes
  assert.equal(alphaOk({ transparentPx: 9000, cornersTransparent: 0, transparentPct: 22 }), true);    // icon touching its corners after trim
  assert.equal(alphaOk({ transparentPct: 0.4 }), false);                                              // old manifest: 1 % rule
});

test('chrome faces must be opaque unless the design is translucent (S18 amber/mint buttons)', () => {
  const btn = { cat: 'button', subject: 'empty pill button, amber gradient' };
  assert.equal(opaqueFace(btn), true);
  assert.equal(faceOk(btn, { faceOpaquePct: 25.7 }), false);
  assert.equal(faceOk(btn, { faceOpaquePct: 100 }), true);
  assert.equal(opaqueFace({ cat: 'button', subject: 'frosted glass pill' }), false);
  assert.equal(opaqueFace({ cat: 'panel', subject: 'plate', face: 'translucent' }), false);
  assert.equal(opaqueFace({ cat: 'icon', subject: 'coin' }), false);
  assert.equal(opaqueFace({ cat: 'card', subject: 'exterior outside the card fully transparent' }), true);
  assert.match(prompt({ style: '#FF0000' }, { ...btn, aspect: 'wide 3:1' }, 'codex'), /fully opaque and solid/);
  assert.doesNotMatch(prompt({ style: '#FF0000' }, { cat: 'icon', subject: 'coin', aspect: 'square 1:1' }, 'codex'), /fully opaque/);
});

test('alpha prompts ask for a margin so subjects are not cropped (S20 loading hero)', () => {
  const r = { cat: 'hero', subject: 'truck', aspect: 'square 1:1' };
  assert.match(prompt({ style: '#B8E2F7' }, r, 'codex'), /margin on every side/);
  assert.match(prompt({ style: '#B8E2F7' }, r, 'agy'), /margin on every side/);
  assert.doesNotMatch(prompt({ style: '#B8E2F7' }, { ...r, alpha: false }, 'codex'), /margin/);
});
