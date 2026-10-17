#!/usr/bin/env node
// boot-idea: start a new game the way the director does it by hand in orca-global — one Claude
// session in an Orca terminal there, given /new-cocos-game (an idea), /store-game-clone (an App Store
// link) or /figma-game-clone (a Figma link) plus the usual options (README of orca-global).
//   node boot-idea.mjs --source idea|store|figma --text "…" [--link URL] [--slug cc-x]
//     [--template default|playable|cc4] [--brief inline|deep] [--goal e2e|playable]
//     [--deploy preview|prod|none] [--impl-agent "claude --model opus"] [--memory on|off]
//     [--agent "claude --model opus"] [--images-dir <dir>] [--dry-run]
// Images in --images-dir are moved to <orca-global>/misc/boot-inbox/<stamp>-<slug>/ and named in
// the prompt. Prints {ok, prompt, handle, inbox}; each boot is one row in <logs>/boot-idea.jsonl and
// one in the spawn registry (role "boot"), so token-report books it.
// Env: BOOT_IDEA_ROOT (orca-global), BOOT_IDEA_ORCA, BOOT_IDEA_LOG_DIR, CC_SPAWN_REGISTRY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const ROOT = process.env.BOOT_IDEA_ROOT ?? path.join(HOME, 'orca-global');
const ORCA = process.env.BOOT_IDEA_ORCA ?? 'orca';
const LOGS = process.env.BOOT_IDEA_LOG_DIR ?? path.join(HOME, '.agents', 'logs');
const REGISTRY = process.env.CC_SPAWN_REGISTRY ?? path.join(HOME, '.agents', 'logs', 'spawns.jsonl');
const IMG = /\.(png|jpe?g|webp|gif)$/i;

const say = (o) => console.log(JSON.stringify(o));
const die = (msg) => { say({ ok: false, error: msg }); process.exit(1); };

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected ${a}`);
    const k = a.slice(2);
    if (k === 'dry-run') { o.dry = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    o[k] = v;
  }
  return o;
}

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();
const pick = (v, allowed, name, dflt) => {
  const x = v ?? dflt;
  if (!allowed.includes(x)) die(`--${name} must be ${allowed.join('|')}`);
  return x;
};

/** The options in the director's own words (orca-global README "Tuỳ chọn hay dùng"). */
export function optionWords(o) {
  return [
    { default: null, playable: 'template playable', cc4: 'cc4 (Cocos 4)' }[o.template],
    { inline: 'brief inline', deep: 'brief sâu bằng fable' }[o.brief],
    { e2e: 'end to end', playable: 'playable first' }[o.goal],
    { preview: 'deploy preview', prod: 'lên prod', none: 'không deploy' }[o.deploy],
    o.implAgent ? `agent ${o.implAgent}` : null,
    o.memory === 'on' ? 'có hỗ trợ từ orca memory và playbook' : null,
  ].filter(Boolean);
}

/** The one-line prompt the boot session gets: a single line, so the TUI submits it whole. */
export function bootPrompt(o) {
  const words = optionWords(o);
  const text = oneLine(o.text);
  // " — " between parts: a link never ends on a full stop the skill could read as part of it
  const parts = o.source === 'idea'
    ? [`/new-cocos-game ${o.slug ? `${o.slug}: ` : ''}${text}`, o.link ? `media/tham chiếu: ${o.link}` : null]
    : [`${o.source === 'store' ? '/store-game-clone' : '/figma-game-clone'} ${o.link}`, o.slug ? `tên project ${o.slug}` : null, text ? `ghi chú gameplay của director: ${text}` : null];
  parts.push(words.length ? `tuỳ chọn: ${words.join(', ')}` : null, o.inbox ? `ảnh tham chiếu của director: ${o.inbox}` : null);
  return oneLine(parts.filter(Boolean).join(' — '));
}

const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function moveImages(dir, label) {
  if (!dir) return null;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => IMG.test(f)) : [];
  if (!files.length) return null;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const inbox = path.join(ROOT, 'misc', 'boot-inbox', `${stamp}-${slugify(label) || 'idea'}`);
  fs.mkdirSync(inbox, { recursive: true });
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(inbox, path.basename(f));
    try { fs.renameSync(src, dst); } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return inbox;
}

function orca(args, timeout = 30000) {
  const r = spawnSync(ORCA, [...args, '--json'], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
  const ok = r.status === 0 && parsed?.ok !== false;
  return { ok, parsed, err: ok ? null : (parsed?.error?.message ?? (r.stderr || r.stdout || r.error?.message || '').trim().slice(-300)) };
}

// claude only, like the director's own orca-global sessions; --agent may add --model/--effort
function launchCommand(spec) {
  const s = oneLine(spec || 'claude');
  if (!/^claude(\s+--(model|effort)\s+[\w.-]+)*$/.test(s)) die('--agent must be "claude [--model m] [--effort e]"');
  return `${s} --dangerously-skip-permissions`;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const o = {
    source: pick(a.source, ['idea', 'store', 'figma'], 'source', 'idea'),
    text: a.text ?? '', link: a.link ? oneLine(a.link) : null, slug: a.slug ? slugify(a.slug) : null,
    template: pick(a.template, ['default', 'playable', 'cc4'], 'template', 'default'),
    brief: pick(a.brief, ['inline', 'deep'], 'brief', 'deep'),
    goal: pick(a.goal, ['e2e', 'playable'], 'goal', 'e2e'),
    deploy: pick(a.deploy, ['preview', 'prod', 'none'], 'deploy', 'preview'),
    memory: pick(a.memory, ['on', 'off'], 'memory', 'on'),
    implAgent: a['impl-agent'] ? oneLine(a['impl-agent']) : null,
  };
  if (o.slug && !o.slug.startsWith('cc-')) o.slug = `cc-${o.slug}`;
  if (o.source === 'idea' && oneLine(o.text).length < 10) die('write the idea (at least a sentence)');
  if (o.source === 'store' && !/^https:\/\/apps\.apple\.com\//.test(o.link ?? '')) die('--link must be an apps.apple.com link');
  if (o.source === 'figma' && !/^https:\/\/(www\.)?figma\.com\/(design|file|proto)\//.test(o.link ?? '')) die('--link must be a figma.com/design link');
  if (o.link && /\s/.test(o.link)) die('--link has spaces');
  const cmd = launchCommand(a.agent);
  if (!fs.existsSync(ROOT)) die(`${ROOT} does not exist`);
  const label = o.slug ?? (o.source === 'idea' ? o.text.split(/\s+/).slice(0, 5).join(' ') : o.source);
  if (a.dry) {
    say({ ok: true, dry_run: true, prompt: bootPrompt({ ...o, inbox: a['images-dir'] ? '<boot-inbox>' : null }), command: cmd, root: ROOT });
    return;
  }
  const inbox = moveImages(a['images-dir'], label);
  const prompt = bootPrompt({ ...o, inbox });
  const title = `boot ${o.slug ?? (slugify(label).slice(0, 24) || o.source)}`;
  const created = orca(['terminal', 'create', '--worktree', `path:${ROOT}`, '--title', title, '--command', cmd, '--focus']);
  const handle = created.parsed?.result?.handle ?? created.parsed?.result?.terminal?.handle ?? null;
  const row = { at: new Date().toISOString(), source: o.source, slug: o.slug, link: o.link, text: o.text.slice(0, 2000), inbox, prompt, title, handle };
  fs.mkdirSync(LOGS, { recursive: true });
  const logRow = (extra) => fs.appendFileSync(path.join(LOGS, 'boot-idea.jsonl'), JSON.stringify({ ...row, ...extra }) + '\n');
  if (!handle) { logRow({ ok: false, error: created.err }); die(`orca terminal create failed: ${created.err ?? 'no handle'}`); }
  fs.appendFileSync(REGISTRY, JSON.stringify({ ts: row.at, project: ROOT, cwd: ROOT, role: 'boot', slice: null, agentSpec: oneLine(a.agent || 'claude'), command: cmd, title, handle }) + '\n');
  const idle = orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '90000'], 100000);
  if (!idle.ok) { logRow({ ok: false, error: `tui-idle: ${idle.err}` }); die(`the session did not get ready (${idle.err}); paste the prompt yourself: ${prompt}`); }
  const sent = orca(['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', '5'], 30000);
  if (!sent.ok) { logRow({ ok: false, error: `send: ${sent.err}` }); die(`prompt not sent (${sent.err}); paste it yourself: ${prompt}`); }
  logRow({ ok: true });
  say({ ok: true, handle, title, prompt, inbox });
}

if (import.meta.url === `file://${fs.realpathSync(process.argv[1] ?? '')}`) main();
