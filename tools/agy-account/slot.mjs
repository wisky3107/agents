/**
 * Per-terminal agy account slots.
 *
 * agy reads its token from the login Keychain and, only when that is unreachable, from
 * $HOME/.gemini/antigravity-cli/antigravity-oauth-token. A HOME without Library/ hides the login
 * Keychain (`security` then sees only the System keychain; verified 2026-10-05), so a slot is a
 * mirror of the real home with every entry symlinked except Library/ and that token file, plus
 * its own token. Logs, conversations, config and trust stay shared through the links, so
 * `--conversation` and rotate.mjs work across slots, and one slot switching account no longer
 * moves every agy started after it.
 *
 *   ~/.agents/run/agy-slots/<key>/home/…      the mirror (key = Orca terminal handle, else pid-<pid>)
 *   ~/.agents/run/agy-slots/<key>/slot.json   { key, email, pid, at }
 *
 * bin/agy runs `agy-account.mjs prepare` (pick a usable account, probe it, write the token) and
 * then execs the real agy with HOME=<mirror>. A write that replaces a linked file (tmp + rename,
 * e.g. trustedFolders.json) or adds an entry lands in the mirror only; `reconcile` (every launch
 * and every rotate pass) moves it back to the real home and relinks it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { omniAccounts, tokenFor, AccountError } from './accounts.mjs';
import { loadState, saveState, probe, isExhausted, INVALID_MS, event } from './rotate.mjs';

export const REAL_HOME = os.userInfo().homedir;
export const SLOTS_DIR = path.join(REAL_HOME, '.agents', 'run', 'agy-slots');
export const WRAPPER = path.join(path.dirname(new URL(import.meta.url).pathname), 'bin', 'agy');
const TOKEN_REL = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
// Mirrored levels: [dir relative to home, names not linked there]. A skipped name is either the
// next mirrored level, Library/ (keeps the Keychain away) or the token itself.
const LEVELS = [
  ['', ['.gemini', 'Library']],
  ['.gemini', ['antigravity-cli']],
  [path.join('.gemini', 'antigravity-cli'), ['antigravity-oauth-token']],
];
// Never moved back: live database side files and half-written temp files.
const NO_RECONCILE = /(?:-wal|-shm|-journal|\.db|\.lock|\.tmp|\.agy-slot-\d+)$/;
const UNION_JSON = new Set(['trustedFolders.json']);
const SLOT_TTL_MS = 7 * 24 * 3600_000;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function slotKey(env = process.env, pid = process.ppid) {
  const handle = env.ORCA_TERMINAL_HANDLE;
  return (handle ? handle : `pid-${pid}`).replace(/[^\w.-]/g, '_');
}

export const slotDir = (key) => path.join(SLOTS_DIR, key);
export const slotHome = (key) => path.join(slotDir(key), 'home');
/** Slot key of a mirror home path (AGY_SLOT_HOME), or null. */
export const keyOfHome = (home) => (home && path.dirname(path.dirname(home)) === SLOTS_DIR ? path.basename(path.dirname(home)) : null);

/** Create the mirror or add links for entries the real home gained since. */
export function ensureMirror(home, realHome = REAL_HOME) {
  for (const [rel, skip] of LEVELS) {
    const dir = path.join(home, rel);
    fs.mkdirSync(dir, { recursive: true });
    let names = [];
    try { names = fs.readdirSync(path.join(realHome, rel)); } catch { continue; }
    for (const name of names) {
      if (skip.includes(name)) continue;
      const at = path.join(dir, name);
      try { fs.lstatSync(at); } catch { fs.symlinkSync(path.join(realHome, rel, name), at); }
    }
  }
}

function writeAtomic(file, data, mode) {
  const tmp = `${file}.agy-slot-${process.pid}`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * Move what agy wrote into the mirror back to the real home and relink it. A file the real home
 * also has wins by mtime, except trustedFolders.json whose keys are merged. Returns moved paths.
 */
export function reconcile(home, realHome = REAL_HOME) {
  const moved = [];
  for (const [rel, skip] of LEVELS) {
    let names = [];
    try { names = fs.readdirSync(path.join(home, rel)); } catch { continue; }
    for (const name of names) {
      if (skip.includes(name) || NO_RECONCILE.test(name)) continue;
      const at = path.join(home, rel, name);
      const real = path.join(realHome, rel, name);
      let st;
      try { st = fs.lstatSync(at); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      let realSt = null;
      try { realSt = fs.lstatSync(real); } catch { /* new entry */ }
      try {
        if (!realSt) {
          fs.renameSync(at, real);
        } else if (st.isFile() && realSt.isFile()) {
          if (UNION_JSON.has(name)) {
            const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
            const mine = read(at);
            const theirs = read(real);
            if (mine && theirs) writeAtomic(real, `${JSON.stringify({ ...theirs, ...mine }, null, 2)}\n`);
            else if (mine && st.mtimeMs > realSt.mtimeMs) fs.copyFileSync(at, real);
          } else if (st.mtimeMs > realSt.mtimeMs) {
            writeAtomic(real, fs.readFileSync(at), st.mode & 0o777);
          }
          fs.rmSync(at);
        } else {
          continue; // a directory on both sides: leave it in the mirror
        }
        fs.symlinkSync(real, at);
        moved.push(path.join(rel, name));
      } catch { /* raced with agy; the next pass retries */ }
    }
  }
  return moved;
}

/** Slots on disk with their record (key, email, pid, at). */
export function listSlots() {
  let keys = [];
  try { keys = fs.readdirSync(SLOTS_DIR); } catch { return []; }
  return keys.map((key) => {
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(path.join(slotDir(key), 'slot.json'), 'utf8')); } catch { /* half made */ }
    return { key, home: slotHome(key), ...rec, live: !!rec.pid && alive(rec.pid) };
  });
}

function writeRecord(key, rec) {
  writeAtomic(path.join(slotDir(key), 'slot.json'), `${JSON.stringify({ key, ...rec, at: new Date().toISOString() })}\n`);
}

/** Email of the account whose token sits in a slot, or null. */
export function slotEmail(home, accounts) {
  try {
    const tok = JSON.parse(fs.readFileSync(path.join(home, TOKEN_REL), 'utf8'));
    return accounts.find((a) => a.refreshToken && a.refreshToken === tok.token?.refresh_token)?.email || null;
  } catch {
    return null;
  }
}

/** Put an OmniRoute account's token into a slot (mirror made if needed). */
export function writeSlotToken(key, account, pid = null) {
  const home = slotHome(key);
  ensureMirror(home);
  writeAtomic(path.join(home, TOKEN_REL), JSON.stringify(tokenFor(account)), 0o600);
  fs.chmodSync(path.join(home, TOKEN_REL), 0o600);
  const prev = listSlots().find((s) => s.key === key);
  writeRecord(key, { email: account.email, pid: pid ?? prev?.pid ?? null });
}

const hasLiveExhaustion = (state, email, now) =>
  Object.values(state.exhausted?.[email] || {}).some((t) => Date.parse(t) > now);

/**
 * Accounts a slot may take, best first: usable (active, refresh token, not blocked, not out for
 * `model`), then no live exhaustion on any model, then held by the fewest live slots (spreads
 * concurrent workers), then OmniRoute priority.
 */
export function rankAccounts(accounts, state, { model = '*', slots = [], now = Date.now() } = {}) {
  const load = {};
  for (const s of slots) if (s.live && s.email) load[s.email] = (load[s.email] || 0) + 1;
  return accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.active && a.refreshToken && a.email && !isExhausted(state, a.email, model, now))
    .sort((x, y) => (hasLiveExhaustion(state, x.a.email, now) - hasLiveExhaustion(state, y.a.email, now))
      || ((load[x.a.email] || 0) - (load[y.a.email] || 0)) || (x.i - y.i))
    .map(({ a }) => a);
}

/**
 * First ranked account Google still lets in (probe), recording the blocked ones; null when none.
 * `prefer` (the slot's current account) is tried first while it is still usable and clean.
 */
export async function pickProbed(accounts, state, { model = '*', slots = [], prefer = null, now = Date.now(), onBlocked } = {}) {
  let ranked = rankAccounts(accounts, state, { model, slots, now });
  const cur = ranked.find((a) => a.email === prefer);
  if (cur && !hasLiveExhaustion(state, cur.email, now)) ranked = [cur, ...ranked.filter((a) => a !== cur)];
  for (const a of ranked) {
    if ((await probe(a)) !== 'invalid') return a;
    state.invalid[a.email] = new Date(now + INVALID_MS).toISOString();
    onBlocked?.(a);
  }
  return null;
}

/**
 * Get a slot ready for one agy launch; returns its mirror home. Keeps the slot's account while it
 * is usable, otherwise writes the best one. With none usable it keeps (or writes) the account
 * that frees up first and warns on stderr: agy still starts and rotate.mjs takes over.
 */
export async function prepare({ env = process.env, pid = process.ppid, now = Date.now() } = {}) {
  const key = slotKey(env, pid);
  const home = slotHome(key);
  ensureMirror(home);
  reconcile(home);
  const accounts = omniAccounts();
  const state = loadState();
  const slots = listSlots().filter((s) => s.key !== key);
  const current = slotEmail(home, accounts);
  let blocked = false;
  const pick = await pickProbed(accounts, state, {
    slots, prefer: current, now,
    onBlocked: (a) => { blocked = true; event({ action: 'needs-verification', account: a.email, until: state.invalid[a.email], slot: key }, { echo: false }); },
  });
  if (blocked) saveState(state);
  let chosen = pick;
  if (!chosen) {
    const resetOf = (a) => [state.invalid?.[a.email], ...Object.values(state.exhausted?.[a.email] || {})].filter(Boolean).sort().pop() || '';
    chosen = accounts.find((a) => a.email === current)
      || accounts.filter((a) => a.active && a.refreshToken).sort((x, y) => resetOf(x).localeCompare(resetOf(y)))[0];
    if (!chosen) throw new AccountError('no OmniRoute agy account with a refresh token');
    process.stderr.write(`agy-slot: every Antigravity account is out of quota or blocked; starting on ${chosen.email} (frees up ${resetOf(chosen) || 'soon'})\n`);
  }
  if (chosen.email !== current) {
    writeSlotToken(key, chosen, pid);
    event({ action: 'slot-assign', slot: key, from: current, to: chosen.email, pid }, { echo: false });
  } else {
    writeRecord(key, { email: chosen.email, pid });
  }
  return home;
}

/** Reconcile every slot; drop slots idle for a week whose agy is gone. */
export function maintainSlots(now = Date.now()) {
  for (const s of listSlots()) {
    reconcile(s.home);
    if (!s.live && s.at && now - Date.parse(s.at) > SLOT_TTL_MS) fs.rmSync(slotDir(s.key), { recursive: true, force: true });
  }
}
