#!/usr/bin/env node
/**
 * Switch the Antigravity CLI (`agy`) between the Google accounts OmniRoute already holds, and
 * rotate automatically on 429 QUOTA_EXHAUSTED.
 *
 *   node agy-account.mjs list [--probe]       # OmniRoute agy accounts; * = agy's slot, ! = out
 *                                             # (--probe asks Google which need re-verification)
 *   node agy-account.mjs current
 *   node agy-account.mjs use <email|prefix>   # copy that account's OmniRoute token into agy
 *   node agy-account.mjs restore [<email>]    # put back a saved agy token (default: newest backup)
 *   node agy-account.mjs status               # exhausted accounts per model + live agy processes
 *   node agy-account.mjs check [--dry-run]    # one rotation pass (rotate.mjs)
 *   node agy-account.mjs watch [--interval 15]
 *   node agy-account.mjs install-launchd | uninstall-launchd   # run `watch` as a login agent
 *   node agy-account.mjs slots                # per-terminal slots: account, live pid
 *   node agy-account.mjs prepare              # (bin/agy) ready this terminal's slot, print its HOME
 *   node agy-account.mjs install-wrapper      # ~/.agents/bin/agy -> bin/agy, first on PATH
 *
 * accounts.mjs has the token format; rotate.mjs the rotation rules; slot.mjs the per-terminal
 * slots that bin/agy runs agy in. `use` / `restore` change agy's shared Keychain slot, which only
 * agy started without bin/agy reads; before every write the current token is saved to Keychain
 * "gemini" / "antigravity@<email>".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ACCOUNT, SERVICE, AccountError, omniAccounts, currentEmail, pickAccount, switchTo, restoreSlot, keychainSlots,
} from './accounts.mjs';
import { check, watch, loadState, probeAll, EVENTS_FILE } from './rotate.mjs';
import { prepare, listSlots, slotEmail, WRAPPER } from './slot.mjs';

const LABEL = 'com.agents.agy-rotate';
const BIN_DIR = path.join(os.homedir(), '.agents', 'bin');
const PATH_LINE = 'export PATH="$HOME/.agents/bin:$PATH"  # agy per-terminal account slots (tools/agy-account)';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function agyRunning() {
  try {
    return execFileSync('pgrep', ['-x', 'agy'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function plist() {
  const out = path.join(os.homedir(), '.agents', 'logs', 'agy-rotate.out');
  const script = new URL(import.meta.url).pathname;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--no-warnings</string>
    <string>${script}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.join(os.homedir(), '.local', 'bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <!-- agy-rotate: relaunch agy workers on another OmniRoute account after 429 QUOTA_EXHAUSTED. -->
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
</dict>
</plist>
`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.find((a) => !a.startsWith('--'));
  const flag = (name) => rest.includes(name);
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

  if (cmd === 'list' || !cmd) {
    const accounts = omniAccounts();
    const now = currentEmail(accounts);
    if (flag('--probe')) await probeAll(accounts);
    const { exhausted, invalid } = loadState();
    for (const a of accounts) {
      const out = Object.entries(exhausted[a.email] || {}).filter(([, t]) => Date.parse(t) > Date.now());
      const bad = invalid[a.email] && Date.parse(invalid[a.email]) > Date.now();
      const mark = (a.email && a.email === now ? '*' : ' ') + (out.length || bad ? '!' : ' ');
      const tail = (bad ? ' BLOCKED (needs verification or ineligible)' : '') + out.map(([m, t]) => ` ${m} until ${t}`).join(',');
      console.log(`${mark} p${a.priority} ${a.email || '(no email)'} ${a.active ? 'active' : 'disabled'}${a.refreshToken ? '' : ' NO-REFRESH-TOKEN'}${tail}`);
    }
    if (now && !accounts.some((a) => a.email === now)) console.log(`*  agy: ${now} (not in OmniRoute)`);
  } else if (cmd === 'current') {
    console.log(currentEmail(omniAccounts()) || 'agy is not signed in, or its account is unknown');
  } else if (cmd === 'use') {
    const accounts = omniAccounts();
    const target = pickAccount(accounts, arg);
    if (target.email === currentEmail(accounts)) { console.log(`agy already uses ${target.email}`); return; }
    const slot = switchTo(target, accounts);
    console.log(`agy -> ${target.email}${slot ? ` (previous token saved to Keychain ${SERVICE}/${slot})` : ''}`);
    const pids = agyRunning();
    if (pids.length) console.log(`warning: ${pids.length} agy process(es) running (${pids.join(', ')}); restart them to pick up the switch`);
  } else if (cmd === 'restore') {
    const slots = keychainSlots();
    const slot = arg ? `${ACCOUNT}@${arg}` : slots.filter((s) => s.startsWith(`${ACCOUNT}.bak-`)).sort().pop() || slots[0];
    if (!slot) throw new AccountError('no saved agy token in Keychain');
    restoreSlot(slot, omniAccounts());
    console.log(`agy -> token from Keychain ${SERVICE}/${slot}`);
  } else if (cmd === 'status' || cmd === 'check') {
    const { actions, exhausted, procs } = await check({ dryRun: cmd === 'status' || flag('--dry-run') });
    const live = Object.entries(exhausted).flatMap(([e, m]) => Object.entries(m).map(([model, t]) => `  ${e} ${model} until ${t}`));
    console.log(`exhausted:${live.length ? `\n${live.join('\n')}` : ' none'}`);
    console.log(`agy processes: ${procs.length ? '' : 'none'}`);
    const accounts = procs.length ? omniAccounts() : [];
    for (const p of procs) {
      const who = p.slotHome ? `slot ${slotEmail(p.slotHome, accounts) || '?'}` : `shared ${currentEmail(accounts) || '?'}`;
      console.log(`  pid ${p.pid} ${p.handle || '(no Orca terminal)'} ${who} ${p.cwd || ''}`);
    }
    if (cmd === 'check') for (const a of actions) console.log(JSON.stringify(a));
    else if (actions.length) console.log(`would do:\n${actions.map((a) => `  ${JSON.stringify(a)}`).join('\n')}`);
  } else if (cmd === 'prepare') {
    process.stdout.write(`${await prepare()}\n`);
  } else if (cmd === 'slots') {
    const slots = listSlots().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!slots.length) console.log('no slots yet');
    for (const s of slots) console.log(`${s.live ? 'live' : '    '} ${s.email || '(no account)'} ${s.key} ${s.at || ''}${s.pid ? ` pid ${s.pid}` : ''}`);
  } else if (cmd === 'install-wrapper') {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const link = path.join(BIN_DIR, 'agy');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(WRAPPER, link);
    for (const rc of ['.zprofile', '.zshrc']) {
      const file = path.join(os.homedir(), rc);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (text.includes('.agents/bin')) continue;
      fs.appendFileSync(file, `${text.endsWith('\n') || !text ? '' : '\n'}${PATH_LINE}\n`);
      console.log(`added ~/.agents/bin to PATH in ~/${rc}`);
    }
    console.log(`${link} -> ${WRAPPER}; new terminals run agy in per-terminal slots (agy-rotate relaunches use it already)`);
  } else if (cmd === 'watch') {
    await watch({ intervalMs: Math.max(5, Number(opt('--interval') || 15)) * 1000 });
  } else if (cmd === 'install-launchd') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plist());
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]);
    console.log(`loaded ${LABEL} (${PLIST}); events: ${EVENTS_FILE}`);
  } else if (cmd === 'uninstall-launchd') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
    fs.rmSync(PLIST, { force: true });
    console.log(`removed ${LABEL}`);
  } else {
    throw new AccountError(`unknown command "${cmd}" (list | current | use | restore | status | check | watch | slots | prepare | install-wrapper | install-launchd | uninstall-launchd)`);
  }
}

main().catch((e) => {
  console.error(`agy-account: ${e instanceof AccountError ? e.message : e?.stack || e}`);
  process.exit(1);
});
