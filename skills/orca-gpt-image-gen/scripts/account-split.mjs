#!/usr/bin/env node
/**
 * ChatGPT ↔ Codex account split.
 *
 * The Orca ChatGPT profiles (gpt-1, gpt-2, …) and OmniRoute's codex connections are the same OpenAI accounts. Heavy
 * use of one account in both places preceded two session revocations (pilot 23, 2026-10-13), so each account works in
 * one place only: the profiles in the ChatGPT set are the only ones `gpt-profiles.mjs pick` returns, and their codex
 * connections are inactive in OmniRoute; every other codex connection is active unless it is held (revoked token).
 *
 *   status [--json]               the set, each profile's verdict and email, each codex connection
 *   apply <label,label…>          set the ChatGPT set, then sync OmniRoute
 *   rotate [--size N]             drop set members that are limited / signed out, fill with the best usable profiles, sync
 *   sync                          re-apply the set to OmniRoute (after a re-login)
 *   heal                          hold + deactivate active codex connections whose last error is a 401
 *   off                           forget the split (pick sees every gpt profile again); OmniRoute is left as it is
 * sync options: --no-verify skips the one Codex probe edit that runs after a connection is switched on; a probe that
 * gets a 401 switches the newly activated connections off again and holds them until their token is renewed.
 *
 * State: ~/.agents/logs/gpt-codex-split.json { set, size, emails {label: email}, held {email: {at, expiresAt}}, log }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SPLIT_FILE = path.join(os.homedir(), '.agents', 'logs', 'gpt-codex-split.json');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CODEX_IMAGE = path.join(HERE, '../../codex-image-gen/scripts/codex-image.mjs');
const ORCA = process.env.ORCA_BIN || 'orca';
const OMNIROUTE = process.env.OMNIROUTE_BIN || 'omniroute';

export function loadSplit(file = SPLIT_FILE) {
  try { return { set: [], size: 2, emails: {}, held: {}, log: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return null; }
}
export function saveSplit(s, file = SPLIT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  s.log = (s.log || []).slice(-50);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}
/** Label pattern for gpt-profiles when a split is on: only the set. */
export const setPattern = (s) => (s && s.set.length ? `^(${s.set.map((l) => l.replace(/[^\w-]/g, '')).join('|')})$` : null);

/** Keep usable members, fill up to `size` with the best usable others (most images left, then label order). */
export function chooseSet(rows, current, size) {
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  const left = (r) => (r.verdict.remaining == null ? Infinity : r.verdict.remaining);
  const keep = current.filter((l) => by[l]?.verdict.usable);
  const extra = rows.filter((r) => r.verdict.usable && !keep.includes(r.label))
    .sort((a, b) => left(b) - left(a) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  return [...keep, ...extra.map((r) => r.label)].slice(0, size);
}

/**
 * The OmniRoute switches for a set. A connection whose email is in the set goes inactive; one that is held stays
 * inactive until its token was renewed after the hold (expiresAt moved); every other one goes active.
 */
export function plan(connections, setEmails, held = {}) {
  const inSet = new Set(setEmails.map((e) => e.toLowerCase()));
  return connections.map((c) => {
    const email = c.email.toLowerCase(), h = held[email];
    const stillHeld = h && !(Date.parse(c.expiresAt) > Date.parse(h.expiresAt || 0));
    const want = inSet.has(email) || stillHeld ? 'inactive' : 'active';
    return { id: c.id, email: c.email, from: c.isActive ? 'active' : 'inactive', to: want, held: Boolean(stillHeld), chatgpt: inSet.has(email) };
  });
}

// omniroute prints ANSI "Loaded env" lines first: start at the first line that opens a JSON value
const json = (raw) => JSON.parse(raw.slice(raw.search(/^[[{]/m)));
function codexConnections() {
  const d = json(execFileSync(OMNIROUTE, ['--output', 'json', 'oauth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return (Array.isArray(d) ? d : d.connections || d.data || Object.values(d)).filter((c) => c.provider === 'codex');
}
const setActive = (id, on) => execFileSync(OMNIROUTE, ['providers', 'edit', id, on ? '--active' : '--inactive'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function profiles() {
  const out = execFileSync('node', [path.join(HERE, 'gpt-profiles.mjs'), 'status', '--json', '--pattern', '^gpt-\\d+$'], { encoding: 'utf8', maxBuffer: 16 << 20 });
  return JSON.parse(out).profiles;
}
const SESSION_EMAIL = "(async()=>{const s=await (await fetch('/api/auth/session',{credentials:'include'})).json();return (s&&s.user&&s.user.email)||''})()";
function emailOf(page) {
  try { return json(execFileSync(ORCA, ['eval', '--page', page, '--expression', SESSION_EMAIL, '--json'], { encoding: 'utf8', timeout: 60_000 })).result?.result || null; } catch { return null; }
}
/** Full account email per profile label (cached; the probe only reads the signed-in session). */
function fillEmails(s, rows) {
  for (const r of rows) if (!s.emails[r.label] && r.page) { const e = emailOf(r.page); if (e) s.emails[r.label] = e; }
}

/** One Codex reference edit through OmniRoute → 'ok' | '401' | 'other'. */
function codexProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-probe-'));
  try {
    execFileSync('python3', ['-c', "from PIL import Image; Image.new('RGB',(256,256),(200,80,80)).save(__import__('sys').argv[1])", path.join(dir, 'ref.png')]);
    let out = '';
    try { out = execFileSync('node', [CODEX_IMAGE, 'gen', '--prompt', 'a small cartoon cat sitting on this red square, game sprite', '--ref', path.join(dir, 'ref.png'), '--out', path.join(dir, 'out.png'), '--attempts', '2', '--json'], { encoding: 'utf8', timeout: 300_000 }); }
    catch (e) { out = String(e.stdout || ''); }
    return /"ok":\s*1/.test(out) ? 'ok' : /HTTP401/.test(out) ? '401' : 'other';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Apply the set to OmniRoute. Returns the switches made and the probe verdict. */
function sync(s, { verify = true } = {}) {
  const conns = codexConnections();
  const setEmails = s.set.map((l) => s.emails[l]).filter(Boolean);
  const missing = s.set.filter((l) => !s.emails[l]);
  if (missing.length) throw new Error(`no account email known for ${missing.join(', ')}: is the profile signed in?`);
  const steps = plan(conns, setEmails, s.held);
  const changed = steps.filter((p) => p.from !== p.to);
  for (const p of changed.filter((x) => x.to === 'inactive')) setActive(p.id, false);
  const turnedOn = changed.filter((x) => x.to === 'active');
  for (const p of turnedOn) setActive(p.id, true);
  let probe = null;
  if (verify && turnedOn.length) {
    probe = codexProbe();
    if (probe === '401') {
      for (const p of turnedOn) {
        setActive(p.id, false);
        s.held[p.email.toLowerCase()] = { at: new Date().toISOString(), expiresAt: conns.find((c) => c.id === p.id)?.expiresAt || null };
      }
    }
  }
  s.log.push({ at: new Date().toISOString(), set: s.set, switched: changed.map((p) => `${p.email}:${p.to}`), probe });
  return { steps, changed, probe };
}

function heal(s) {
  const held = [];
  for (const c of codexConnections()) {
    if (!c.isActive || !/^401/.test(String(c.errorCode || '')) && !/invalid|revoked|invalidated/i.test(String(c.lastError || ''))) continue;
    setActive(c.id, false);
    s.held[c.email.toLowerCase()] = { at: new Date().toISOString(), expiresAt: c.expiresAt || null };
    held.push(c.email);
  }
  s.log.push({ at: new Date().toISOString(), heal: held });
  return held;
}

/** Rotate when needed: the hook gpt-profiles calls after `mark --limited` and when pick finds nothing in the set. */
export function rotate(s, { size = s.size || 2, verify = true } = {}) {
  const rows = profiles();
  fillEmails(s, rows);
  const next = chooseSet(rows, s.set, size);
  if (!next.length) return { ok: false, reason: 'no usable ChatGPT profile', set: s.set };
  const before = s.set;
  s.set = next; s.size = size;
  const r = sync(s, { verify });
  return { ok: true, before, set: next, switched: r.changed.map((p) => `${p.email}:${p.to}`), probe: r.probe };
}

function main(argv) {
  const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
  const flag = (k) => argv.includes('--' + k);
  const val = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
  const verify = !flag('no-verify');
  let s = loadSplit();
  const out = (o) => console.log(JSON.stringify(o, null, 1));

  if (cmd === 'status') {
    const conns = codexConnections();
    out({ split: s ? { set: s.set, size: s.size, held: Object.keys(s.held || {}) } : null,
      codex: conns.map((c) => ({ email: c.email, active: c.isActive, error: c.errorCode || null, chatgpt: Boolean(s && s.set.some((l) => s.emails[l]?.toLowerCase() === c.email.toLowerCase())) })) });
    return 0;
  }
  if (cmd === 'off') { if (fs.existsSync(SPLIT_FILE)) fs.rmSync(SPLIT_FILE); out({ ok: true, split: null }); return 0; }
  s = s || { set: [], size: 2, emails: {}, held: {}, log: [] };
  if (cmd === 'apply') {
    const labels = String(arg || '').split(',').filter(Boolean);
    if (!labels.length) throw new Error('apply <gpt-N,gpt-M>');
    fillEmails(s, profiles().filter((r) => labels.includes(r.label)));
    s.set = labels; s.size = labels.length;
    const r = sync(s, { verify });
    saveSplit(s);
    out({ ok: true, set: s.set, emails: s.set.map((l) => s.emails[l]), switched: r.changed.map((p) => `${p.email}:${p.to}`), probe: r.probe });
    return 0;
  }
  if (cmd === 'rotate') { const r = rotate(s, { size: Number(val('size', s.size || 2)), verify }); saveSplit(s); out(r); return r.ok ? 0 : 2; }
  if (cmd === 'sync') { const r = sync(s, { verify }); saveSplit(s); out({ ok: true, set: s.set, switched: r.changed.map((p) => `${p.email}:${p.to}`), probe: r.probe }); return 0; }
  if (cmd === 'heal') { const held = heal(s); saveSplit(s); out({ ok: true, held }); return 0; }
  console.error('usage: account-split.mjs status | apply <gpt-N,…> | rotate [--size N] | sync | heal | off  [--no-verify]');
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
}
