import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, extFor, fontQuery, imageSize, manifestTable, parseFigmaUrl, replaceBlock, slugify, validatePlan } from '../scripts/figma.mjs';

const script = fileURLToPath(new URL('../scripts/figma.mjs', import.meta.url));
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000003000000020806000000', 'hex');

test('parseFigmaUrl reads file key and node id from design/file/proto links', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/gfia1k3n3KDDtvK6mzjQ67/LoveTrain-Dev?node-id=1-326&t=x'),
    { fileKey: 'gfia1k3n3KDDtvK6mzjQ67', rootNode: '1:326' });
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/file/AbC123/Game'), { fileKey: 'AbC123', rootNode: '' });
  assert.equal(parseFigmaUrl('https://www.figma.com/proto/Key9/x?node-id=12-3').rootNode, '12:3');
  assert.throws(() => parseFigmaUrl('https://example.com/design/x'));
});

test('slugify folds Vietnamese to kebab', () => {
  assert.equal(slugify('Gấu Trúc · Đỏ'), 'gau-truc-do');
  assert.equal(slugify('Rectangle 4847'), 'rectangle-4847');
});

test('imageSize and extFor read PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(PNG_1x1), { w: 3, h: 2 });
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108002000400301220002110103110100', 'hex');
  assert.deepEqual(imageSize(jpg), { w: 64, h: 32 });
  assert.equal(extFor(PNG_1x1), '.png');
  assert.equal(extFor(jpg), '.jpg');
  assert.equal(imageSize(Buffer.from('nope')), null);
});

test('validatePlan rejects names that are not kebab name-name', () => {
  assert.deepEqual(validatePlan({ ids: { '1:2': 'love-bar' }, names: { 'Rectangle 1': 'love-bar-fill' } }), []);
  assert.equal(validatePlan({ ids: { '1:2': 'Love Bar' } }).length, 1);
  assert.equal(validatePlan({}).length, 1);
});

test('fontQuery maps Figma styles to Google Fonts axes', () => {
  const q = fontQuery('Inter', 'Semi Bold Italic');
  assert.equal(q.weight, 600);
  assert.equal(q.italic, true);
  assert.equal(q.file, 'Inter-SemiBoldItalic.ttf');
  assert.match(q.url, /family=Inter:ital,wght@1,600$/);
  assert.match(fontQuery('Be Vietnam Pro', 'Black').url, /family=Be\+Vietnam\+Pro:ital,wght@0,900$/);
  assert.equal(fontQuery('Lobster', 'Regular').weight, 400);
});

test('replaceBlock keeps hand-written notes around the generated table', () => {
  const first = replaceBlock('# Manifest\n\nnotes', 'T1');
  assert.match(first, /notes\n\n<!-- figma-assets:start -->\nT1\n<!-- figma-assets:end -->/);
  const second = replaceBlock(`${first}\nfooter`, 'T2');
  assert.match(second, /T2/);
  assert.doesNotMatch(second, /T1/);
  assert.match(second, /footer/);
});

test('buildManifest keeps extra keys and records the figma source', () => {
  const m = buildManifest({ cfg: { fileKey: 'K', url: 'u', rootNode: '1:2', fileName: 'Game', designResolution: { width: 1080, height: 1920 } },
    slug: 'demo', files: [{ path: 'ui/a.png' }], previous: { genre: 'pet', files: [] } });
  assert.equal(m.genre, 'pet');
  assert.equal(m.source.type, 'figma');
  assert.equal(m.designResolution.width, 1080);
  assert.equal(m.files.length, 1);
  assert.match(manifestTable([{ path: 'ui/a.png', w: 3, h: 2, bytes: 10, figmaNode: '1:5', figmaName: 'a', mode: 'node' }]), /`ui\/a.png` \| 3×2 \| `1:5` a \| node/);
});

test('init, views add, manifest and guide work offline on a game folder', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-clone-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const G = path.join(tmp, 'demo');
  const run = (...a) => execFileSync(process.execPath, [script, ...a, '--game', G], { encoding: 'utf8' });
  const init = JSON.parse(run('init', '--url', 'https://www.figma.com/design/Key1/Demo?node-id=4-5'));
  assert.equal(init.config.rootNode, '4:5');
  assert.ok(fs.existsSync(path.join(G, 'tools/figma/figma.mjs')));
  run('views', 'add', 'screen-01-home', '4-6', '--kind', 'screen', '--desc', 'home');
  assert.throws(() => run('views', 'add', 'Bad Key', '4:7'));
  const views = JSON.parse(fs.readFileSync(path.join(G, 'tools/figma/views.json'), 'utf8')).views;
  assert.deepEqual(views['screen-01-home'], { node: '4:6', kind: 'screen', desc: 'home' });

  fs.mkdirSync(path.join(G, 'assets/ui'), { recursive: true });
  fs.mkdirSync(path.join(G, 'assets/reference'), { recursive: true });
  fs.writeFileSync(path.join(G, 'assets/ui/btn.png'), PNG_1x1);
  fs.writeFileSync(path.join(G, 'assets/reference/figma-tree.txt'), 'tree');
  fs.writeFileSync(path.join(G, 'assets/reference/export-log.json'),
    JSON.stringify([{ file: 'ui/btn.png', node: '4:9', figmaName: 'btn', mode: 'node', bytes: PNG_1x1.length }]));
  run('manifest');
  const m = JSON.parse(fs.readFileSync(path.join(G, 'assets/manifest.json'), 'utf8'));
  assert.deepEqual(m.files.map((f) => f.path), ['ui/btn.png']);
  assert.equal(m.files[0].figmaNode, '4:9');
  assert.equal(m.files[0].w, 3);
  fs.appendFileSync(path.join(G, 'ASSET_MANIFEST.md'), '\nhand note\n');
  run('manifest');
  assert.match(fs.readFileSync(path.join(G, 'ASSET_MANIFEST.md'), 'utf8'), /hand note/);

  run('guide');
  const guide = fs.readFileSync(path.join(G, 'FIGMA_GUIDE.md'), 'utf8');
  assert.match(guide, /`screen-01-home` \| `4:6` \| screen \| home/);
  assert.doesNotMatch(guide, /\{\{/);
  fs.appendFileSync(path.join(G, 'FIGMA_GUIDE.md'), '\n## Checklist riêng\n');
  run('guide');
  assert.match(fs.readFileSync(path.join(G, 'FIGMA_GUIDE.md'), 'utf8'), /## Checklist riêng/);
});
