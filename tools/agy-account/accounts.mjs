/**
 * agy's account slot and the Antigravity accounts OmniRoute holds.
 *
 * agy keeps one token per macOS user: Keychain item service "gemini" / account "antigravity"
 * (value "go-keyring-base64:" + base64 JSON) plus the fallback file
 * ~/.gemini/antigravity-cli/antigravity-oauth-token. A running agy reads it once at start and
 * refreshes in memory, so a switch only reaches sessions started after it. slot.mjs gives one
 * agy its own token instead (a HOME without the login Keychain makes agy use the file).
 *
 * OmniRoute signs agy accounts in with the same Google OAuth client
 * (src/lib/oauth/constants/oauth.ts AGY_CONFIG), so its refresh token works in agy as-is; agy
 * refreshes the access token itself. OmniRoute stores tokens as "enc:v1:<iv>:<ct>:<tag>"
 * (aes-256-gcm, key = scrypt(STORAGE_ENCRYPTION_KEY, "omniroute-field-encryption-v1", 32)).
 *
 * Tokens are never printed and never passed on a command line.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const SERVICE = 'gemini';
export const ACCOUNT = 'antigravity';
const PREFIX = 'go-keyring-base64:';
const OMNI_DIR = path.join(os.homedir(), '.omniroute');
const OMNI_DB = path.join(OMNI_DIR, 'storage.sqlite');
const TOKEN_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

export class AccountError extends Error {}

function encryptionKey() {
  let secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret) {
    for (const file of [path.join(OMNI_DIR, '.env'), path.join(OMNI_DIR, 'server', '.env')]) {
      if (!fs.existsSync(file)) continue;
      const line = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
        .find((l) => l.startsWith('STORAGE_ENCRYPTION_KEY='));
      if (line) { secret = line.split('=').slice(1).join('=').trim().replace(/^["'](.*)["']$/, '$1'); break; }
    }
  }
  if (!secret) throw new AccountError('STORAGE_ENCRYPTION_KEY not found in ~/.omniroute/.env');
  return crypto.scryptSync(secret, 'omniroute-field-encryption-v1', 32);
}

function decrypt(value, key) {
  if (!value || !value.startsWith('enc:v1:')) return value || null;
  const [iv, ct, tag] = value.slice('enc:v1:'.length).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return d.update(ct, 'hex', 'utf8') + d.final('utf8');
}

/** OmniRoute agy connections, highest priority first, tokens decrypted. */
export function omniAccounts() {
  if (!fs.existsSync(OMNI_DB)) throw new AccountError(`no OmniRoute database at ${OMNI_DB}`);
  const db = new DatabaseSync(OMNI_DB, { readOnly: true });
  const rows = db.prepare(`select id, email, priority, is_active, rate_limited_until, access_token,
    refresh_token, token_expires_at, expires_at from provider_connections
    where provider = 'agy' order by priority`).all();
  db.close();
  const key = encryptionKey();
  return rows.map((r) => ({
    id: r.id,
    email: r.email || '',
    priority: r.priority,
    active: !!r.is_active,
    rateLimitedUntil: r.rate_limited_until || null,
    accessToken: decrypt(r.access_token, key),
    refreshToken: decrypt(r.refresh_token, key),
    expiry: r.token_expires_at || r.expires_at || null,
  }));
}

export function keychainRead(account) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// `security -i` takes the command on stdin, so the secret never shows up in `ps`.
function keychainWrite(account, value) {
  if (/["\\\n]/.test(value)) throw new AccountError('refusing to write a value with quotes or newlines');
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s "${SERVICE}" -l "${SERVICE}" -a "${account}" -w "${value}"\n`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}

/** Saved slots: "antigravity@<email>" and "antigravity.bak-<time>". */
export function keychainSlots() {
  let dump = '';
  try {
    dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch { /* locked or unavailable */ }
  const out = [];
  for (const block of dump.split('keychain: ')) {
    if (!block.includes(`"svce"<blob>="${SERVICE}"`)) continue;
    const m = block.match(/"acct"<blob>="([^"]+)"/);
    if (m && (m[1].startsWith(`${ACCOUNT}@`) || m[1].startsWith(`${ACCOUNT}.bak-`))) out.push(m[1]);
  }
  return out;
}

export function decodeValue(value) {
  if (!value || !value.startsWith(PREFIX)) return null;
  try { return JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64').toString('utf8')); } catch { return null; }
}

const encodeValue = (obj) => PREFIX + Buffer.from(JSON.stringify(obj)).toString('base64');

function idTokenEmail(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).email || null; } catch { return null; }
}

/** Email of the account in agy's slot: OmniRoute refresh-token match first, then the id_token. */
export function currentEmail(accounts, tok = decodeValue(keychainRead(ACCOUNT))) {
  if (!tok) return null;
  const hit = accounts.find((a) => a.refreshToken && a.refreshToken === tok.token?.refresh_token);
  return hit ? hit.email : idTokenEmail(tok.id_token || '') || null;
}

function writeAgy(value) {
  keychainWrite(ACCOUNT, value);
  const tok = decodeValue(value);
  if (fs.existsSync(path.dirname(TOKEN_FILE))) {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok), { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  }
}

/** Save agy's current token to "antigravity@<email>" (or a timestamped slot); returns the slot. */
function backupCurrent(accounts) {
  const value = keychainRead(ACCOUNT);
  if (!value) return null;
  const email = currentEmail(accounts, decodeValue(value));
  const slot = email ? `${ACCOUNT}@${email}` : `${ACCOUNT}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  keychainWrite(slot, value);
  return slot;
}

export function pickAccount(accounts, who) {
  const q = String(who || '').toLowerCase();
  if (!q) throw new AccountError('name an account: email or its prefix (see `list`)');
  const hits = accounts.filter((a) => a.email.toLowerCase() === q || a.email.toLowerCase().startsWith(q) || a.id.startsWith(q));
  if (hits.length !== 1) throw new AccountError(hits.length ? `"${who}" matches ${hits.length} accounts` : `no OmniRoute agy account matches "${who}"`);
  return hits[0];
}

/** agy's stored-token object for an OmniRoute account. */
export function tokenFor(target) {
  if (!target.refreshToken) throw new AccountError(`${target.email} has no refresh token in OmniRoute; reconnect it there`);
  // A near-expiry access token is dropped so agy refreshes before its first call.
  const fresh = target.accessToken && target.expiry && Date.parse(target.expiry) > Date.now() + 120_000;
  return {
    token: {
      access_token: fresh ? target.accessToken : '',
      token_type: 'Bearer',
      refresh_token: target.refreshToken,
      expiry: fresh ? target.expiry : new Date(Date.now() - 60_000).toISOString(),
    },
    auth_method: 'consumer',
    id_token: '',
  };
}

/** Put an OmniRoute account into agy's slot. Returns the backup slot, or null when nothing was there. */
export function switchTo(target, accounts) {
  const tok = tokenFor(target);
  const slot = backupCurrent(accounts);
  writeAgy(encodeValue(tok));
  return slot;
}

/** Put a saved slot back into agy's slot (the current token is saved first). */
export function restoreSlot(slot, accounts) {
  const value = keychainRead(slot);
  if (!value) throw new AccountError(`no saved agy token in Keychain ${SERVICE}/${slot}`);
  backupCurrent(accounts);
  writeAgy(value);
}
