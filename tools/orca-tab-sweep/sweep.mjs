#!/usr/bin/env node
// Close Orca browser tabs a finished slice left behind in one worktree.
// Keeps one tab per localhost preview port; closes every other preview duplicate and every
// chatgpt.com tab (blank, logged-out or old conversations). Run it right after a slice merges,
// before the next slice's writer opens its own tabs.
//   node sweep.mjs --worktree <abs path> [--dry-run]
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const worktree = opt('--worktree');
const dry = args.includes('--dry-run');
if (!worktree) { console.error('usage: sweep.mjs --worktree <abs path> [--dry-run]'); process.exit(2); }

const orca = (...a) => execFileSync('orca', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tabs = JSON.parse(orca('tab', 'list', '--worktree', 'all', '--show-profile', '--json')).result.tabs
  .filter((t) => (t.worktreeId || '').endsWith(`::${worktree}`));

const keptPorts = new Set();
const close = [];
for (const t of tabs) {
  const url = t.url || '';
  const port = url.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/)?.[1];
  if (port) {
    if (keptPorts.has(port)) close.push(t); else keptPorts.add(port);
  } else if (/^https:\/\/chatgpt\.com\//.test(url)) {
    close.push(t);
  }
}

let closed = 0;
for (const t of close) {
  const label = `${t.profileLabel || 'default'} ${(t.url || '').slice(0, 60)}`;
  if (dry) { console.log(`would close ${label}`); continue; }
  try { orca('tab', 'close', '--page', t.browserPageId, '--worktree', `path:${worktree}`, '--json'); closed++; }
  catch (e) { console.error(`failed ${label}: ${String(e.stderr || e.message).slice(0, 160)}`); }
}
console.log(JSON.stringify({ worktree, tabs: tabs.length, closed: dry ? 0 : closed, would_close: dry ? close.length : undefined, kept: tabs.length - (dry ? 0 : closed) }));
