#!/usr/bin/env node
/**
 * Drive one ChatGPT page in Orca's browser entirely through `orca eval --page`, so nothing is
 * typed into whatever window has OS focus (`orca inserttext` / `keypress` go there — in a run
 * they landed in the agent's own terminal) and nothing goes through the Downloads folder.
 *
 *   send --page <id> (--prompt-file <f> | --prompt <text>)
 *        put the prompt in the composer, check it is there exactly once, press Send,
 *        and confirm the chat moved to a conversation
 *   state --page <id>
 *        { phase: idle|busy|done|limited|signed-out, images, limitText }
 *   wait --page <id> [--timeout-s 600] [--after <images>]
 *        poll state every 5 s until done (more than --after images), limited or signed-out
 *   save --page <id> --path <file.png> [--index <n>]
 *        write the generated image (last by default) to disk byte for byte
 *
 * All commands print JSON. Exit 0 ok, 1 error, 3 limited / signed out (rotate accounts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ORCA = process.env.ORCA_BIN || 'orca';
// Texts ChatGPT shows when an account cannot make more images now.
export const LIMIT_RE = /(hit|reached)[^.]{0,60}\blimit\b|image (generation|creation)s? limit|too many (image )?requests|limit resets|create more images (when|after|in)/i;

function evalPage(page, expression) {
  const raw = execFileSync(ORCA, ['eval', '--page', page, '--expression', expression, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  const d = JSON.parse(raw);
  if (!d.ok) throw new Error(`orca eval: ${JSON.stringify(d.error || d)}`);
  return JSON.parse(d.result.result);
}

const STATE_JS = `(() => {
  const imgs = [...new Map([...document.querySelectorAll('img[alt^="Generated image"]')].filter((i) => i.complete && i.naturalWidth > 256).map((i) => [i.src, i])).values()];
  // Conversation text reads "You said: <prompt> ChatGPT said: <reply> ChatGPT can make mistakes…".
  const main = (document.querySelector('main') || {}).innerText || '';
  const at = main.lastIndexOf('ChatGPT said:');
  const lastText = at < 0 ? '' : main.slice(at + 'ChatGPT said:'.length).split('ChatGPT can make mistakes')[0].trim().slice(0, 600);
  const busy = !!document.querySelector('[data-testid="stop-button"], button[aria-label^="Stop"]')
    || /Creating image|Generating image|Adding final touches|Getting started|^\d{1,3}%$/im.test(lastText);
  const signedOut = !document.querySelector('#prompt-textarea, [contenteditable="true"]')
    && !!document.querySelector('[data-testid="login-button"], a[href*="auth/login"], button[data-testid="welcome-login-button"]');
  return JSON.stringify({ busy, images: imgs.length, lastText, signedOut, url: location.href });
})()`;

/** Page facts → phase. `after` = image count before this prompt was sent. */
export function phase(s, after = 0) {
  if (s.signedOut) return 'signed-out';
  if (!s.busy && LIMIT_RE.test(s.lastText || '')) return 'limited';
  if (s.busy) return 'busy';
  return s.images > after ? 'done' : 'idle';
}

function state(page, after) {
  const s = evalPage(page, STATE_JS);
  const p = phase(s, after);
  return { phase: p, images: s.images, url: s.url, limitText: p === 'limited' ? s.lastText : null };
}

function send(page, prompt) {
  const js = `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    const ed = document.querySelector('#prompt-textarea, [contenteditable="true"]');
    if (!ed) return JSON.stringify({ ok: false, reason: 'no composer' });
    ed.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, prompt);
    await new Promise((r) => setTimeout(r, 600));
    const text = ed.innerText.trim();
    if (text !== prompt.trim()) return JSON.stringify({ ok: false, reason: 'composer text differs from prompt' });
    const btn = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]');
    if (!btn || btn.disabled) return JSON.stringify({ ok: false, reason: 'send button not ready' });
    const before = new Set([...document.querySelectorAll('img[alt^="Generated image"]')].map((i) => i.src)).size;
    btn.click();
    return JSON.stringify({ ok: true, imagesBefore: before });
  })()`;
  const r = evalPage(page, js);
  if (!r.ok) return r;
  // orca eval times out around 30 s, so confirm from here: a new conversation can take well
  // over 10 s to render the sent message.
  const check = `(() => {
    const norm = (t) => t.replace(/\\s+/g, ' ').trim();
    const main = norm((document.querySelector('main') || {}).innerText || '');
    const at = main.lastIndexOf('You said:');
    return JSON.stringify({ sent: at >= 0 && main.slice(at).includes(norm(${JSON.stringify(prompt)})), url: location.href });
  })()`;
  for (let i = 0; i < 30; i++) {
    execFileSync('sleep', ['1.5']);
    const c = evalPage(page, check);
    if (c.sent) return { ok: true, imagesBefore: r.imagesBefore, url: c.url };
  }
  return { ok: false, reason: 'prompt not visible as a sent message after 45 s' };
}

function save(page, file, index) {
  const js = `(async () => {
    const imgs = [...new Map([...document.querySelectorAll('img[alt^="Generated image"]')].filter((i) => i.complete && i.naturalWidth > 256).map((i) => [i.src, i])).values()];
    const im = ${index == null ? 'imgs[imgs.length - 1]' : `imgs[${Number(index) - 1}]`};
    if (!im) return JSON.stringify({ ok: false, reason: 'no generated image', count: imgs.length });
    const b = await (await fetch(im.src)).blob();
    const u8 = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return JSON.stringify({ ok: true, type: b.type, size: b.size, width: im.naturalWidth, height: im.naturalHeight, b64: btoa(s) });
  })()`;
  const r = evalPage(page, js);
  if (!r.ok) return r;
  const buf = Buffer.from(r.b64, 'base64');
  if (buf.length !== r.size) return { ok: false, reason: `size mismatch ${buf.length} != ${r.size}` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, type: r.type, bytes: r.size, width: r.width, height: r.height };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[k] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const page = args.page;
  const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 1)); return code; };
  if (!page && cmd) throw new Error('--page <browserPageId> is required');

  if (cmd === 'send') {
    const prompt = args['prompt-file'] ? fs.readFileSync(args['prompt-file'], 'utf8') : args.prompt;
    if (!prompt || prompt === true) throw new Error('send needs --prompt-file <f> or --prompt <text>');
    const r = send(page, prompt);
    return out(r, r.ok ? 0 : 1);
  }
  if (cmd === 'state') {
    const s = state(page, Number(args.after) || 0);
    return out(s, s.phase === 'limited' || s.phase === 'signed-out' ? 3 : 0);
  }
  if (cmd === 'wait') {
    const end = Date.now() + (Number(args['timeout-s']) || 600) * 1000;
    const after = Number(args.after) || 0;
    for (;;) {
      const s = state(page, after);
      if (s.phase === 'done') return out(s);
      if (s.phase === 'limited' || s.phase === 'signed-out') return out(s, 3);
      if (Date.now() > end) return out({ ...s, phase: 'timeout' }, 1);
      execFileSync('sleep', ['5']);
    }
  }
  if (cmd === 'save') {
    if (!args.path) throw new Error('save needs --path <file>');
    const r = save(page, path.resolve(args.path), args.index);
    return out(r, r.ok ? 0 : 1);
  }
  console.error('usage: chatgpt-page.mjs send|state|wait|save --page <id> [...]');
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = main(); } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
}
