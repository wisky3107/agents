import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMirror, reconcile, slotKey, keyOfHome, slotHome } from '../slot.mjs';

function fakeHomes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-slot-test-'));
  const real = path.join(root, 'real');
  const cli = path.join(real, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(cli, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(real, 'Library', 'Keychains'), { recursive: true });
  fs.writeFileSync(path.join(real, '.gitconfig'), 'x');
  fs.writeFileSync(path.join(real, '.gemini', 'trustedFolders.json'), JSON.stringify({ '/a': 'TRUST_FOLDER' }));
  fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), 'shared-token');
  fs.writeFileSync(path.join(cli, 'settings.json'), '{}');
  return { root, real, home: path.join(root, 'slot', 'home') };
}

test('the mirror links the real home except Library/ and the shared token', () => {
  const { root, real, home } = fakeHomes();
  ensureMirror(home, real);
  const link = (rel) => fs.readlinkSync(path.join(home, rel));
  assert.equal(link('.gitconfig'), path.join(real, '.gitconfig'));
  assert.equal(link('.gemini/trustedFolders.json'), path.join(real, '.gemini/trustedFolders.json'));
  assert.equal(link('.gemini/antigravity-cli/conversations'), path.join(real, '.gemini/antigravity-cli/conversations'));
  assert.equal(fs.lstatSync(path.join(home, '.gemini/antigravity-cli')).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token')), false);
  // Entries the real home gains later are linked on the next call.
  fs.writeFileSync(path.join(real, '.npmrc'), 'y');
  ensureMirror(home, real);
  assert.equal(link('.npmrc'), path.join(real, '.npmrc'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('reconcile moves rename-written and new files back, merges trust, keeps the slot token and db side files', () => {
  const { root, real, home } = fakeHomes();
  ensureMirror(home, real);
  const cli = path.join(home, '.gemini', 'antigravity-cli');
  // agy accepts a folder trust in the slot: tmp + rename replaces the link with a file.
  const trust = path.join(home, '.gemini', 'trustedFolders.json');
  fs.rmSync(trust);
  fs.writeFileSync(trust, JSON.stringify({ '/b': 'TRUST_FOLDER' }));
  fs.writeFileSync(path.join(real, '.gemini', 'trustedFolders.json'), JSON.stringify({ '/a': 'TRUST_FOLDER', '/c': 'TRUST_FOLDER' }));
  fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), 'slot-token');
  fs.writeFileSync(path.join(cli, 'new-state.json'), 'n');
  fs.writeFileSync(path.join(cli, 'summaries.db-wal'), 'w');
  const moved = reconcile(home, real).sort();
  assert.deepEqual(moved, ['.gemini/antigravity-cli/new-state.json', '.gemini/trustedFolders.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(real, '.gemini/trustedFolders.json'), 'utf8')),
    { '/a': 'TRUST_FOLDER', '/b': 'TRUST_FOLDER', '/c': 'TRUST_FOLDER' });
  assert.equal(fs.lstatSync(trust).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(real, '.gemini/antigravity-cli/new-state.json'), 'utf8'), 'n');
  assert.equal(fs.readFileSync(path.join(real, '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8'), 'shared-token');
  assert.equal(fs.readFileSync(path.join(cli, 'antigravity-oauth-token'), 'utf8'), 'slot-token');
  assert.equal(fs.lstatSync(path.join(cli, 'summaries.db-wal')).isFile(), true);
  // Removing a slot never follows its links into the real home.
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(real, '.gemini/antigravity-cli/conversations')), true);
  assert.equal(fs.existsSync(path.join(real, '.gitconfig')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('slot keys come from the Orca terminal handle, else the agy pid; a mirror home maps back to its key', () => {
  assert.equal(slotKey({ ORCA_TERMINAL_HANDLE: 'term_ab-12' }, 5), 'term_ab-12');
  assert.equal(slotKey({}, 4242), 'pid-4242');
  assert.equal(keyOfHome(slotHome('term_ab-12')), 'term_ab-12');
  assert.equal(keyOfHome('/Users/w'), null);
  assert.equal(keyOfHome(null), null);
});
