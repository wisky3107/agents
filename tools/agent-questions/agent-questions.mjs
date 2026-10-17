#!/usr/bin/env node
// agent-questions: every question a Claude Code agent asks the director in an Orca terminal, in one
// queue the director console shows next to the runner's own questions.
//   hook                         Claude Code hook (stdin payload): records AskUserQuestion dialogs and turns
//                                that end on a question; closes them when the chat answers. Prints nothing.
//   list [--all] [--json]        open questions (or every recent one)
//   answer --id <id> [--pick "<n>=<label>"]... [--text "..."]
//                                types the answer into the agent's own terminal (an open dialog is
//                                closed with Esc first, then the choice goes in as a chat message)
//   dismiss --id <id> --note "…"  closes it without answering (the agent is not told)
//   focus --id <id>              shows the agent's terminal in Orca
//   install-hook [--settings <file>]  adds the hook to ~/.claude/settings.json (once; a .bak is kept)
// Env: AGENT_QUESTIONS_HOME (store dir), AGENT_QUESTIONS_LOG, AGENT_QUESTIONS_ORCA (orca binary).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';

const ORCA = () => process.env.AGENT_QUESTIONS_ORCA ?? 'orca';
const say = (o) => console.log(JSON.stringify(o));
const die = (msg, extra = {}) => { say({ ok: false, error: msg, ...extra }); process.exit(1); };

function orca(args, timeout = 20000) {
  const r = spawnSync(ORCA(), [...args, '--json'], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
  const ok = r.status === 0 && parsed?.ok !== false;
  return { ok, parsed, err: ok ? null : (parsed?.error?.message ?? (r.stderr || r.stdout || r.error?.message || '').trim().slice(-300)) };
}

// ------------------------------------------------------------------ hook

const ASK = 'AskUserQuestion';
const oneLine = (s, n = 4000) => String(s ?? '').replace(/\s*\n\s*/g, ' / ').trim().slice(0, n);

function hook(p, env = process.env) {
  const ev = p.hook_event_name;
  const sid = store.safeId(p.session_id);
  if (!sid) return;
  // the chat answered (a prompt typed while a question was open) or the session ended
  if (ev === 'UserPromptSubmit' || ev === 'SessionEnd') {
    for (const q of store.open({ session: sid })) {
      store.close(q, ev === 'SessionEnd' ? 'gone' : 'answered', ev === 'SessionEnd' ? {} : { answer: { via: 'chat', text: oneLine(p.prompt, 2000), at: new Date().toISOString() } });
    }
    if (ev === 'SessionEnd') store.prune();
    return;
  }
  if ((ev === 'PostToolUse' || ev === 'PostToolUseFailure') && p.tool_name === ASK) {
    const q = store.open({ session: sid }).find((x) => x.tool_use_id && x.tool_use_id === p.tool_use_id);
    if (q) store.close(q, 'answered', { answer: { via: 'chat', result: p.tool_response ?? p.error ?? null, at: new Date().toISOString() } });
    return;
  }
  // a new question needs a terminal to answer into, in an interactive session
  const handle = env.ORCA_TERMINAL_HANDLE;
  if (!handle || (env.CLAUDE_CODE_ENTRYPOINT && env.CLAUDE_CODE_ENTRYPOINT !== 'cli')) return;
  const base = {
    session_id: sid, handle, pane_key: env.ORCA_PANE_KEY ?? null, worktree_id: env.ORCA_WORKTREE_ID ?? null,
    cwd: p.cwd ?? null, project: store.projectOf(p.cwd, env.CC_PROJECT), role: env.CC_ROLE || null, slice: env.CC_SLICE || null,
    agent: 'claude', transcript_path: p.transcript_path ?? null, asked_at: new Date().toISOString(), status: 'open',
  };
  if (ev === 'PreToolUse' && p.tool_name === ASK) {
    const qs = (p.tool_input?.questions ?? []).map((x) => ({
      header: x.header ?? null, question: x.question ?? '', multiSelect: !!x.multiSelect,
      options: (x.options ?? []).map((o) => ({ label: o.label ?? String(o), description: o.description ?? null, preview: o.preview ?? null })),
    }));
    if (!qs.length) return;
    const context = store.lastAssistantText(p.transcript_path);
    const texts = [context, ...qs.flatMap((x) => [x.question, ...x.options.flatMap((o) => [o.label, o.description, o.preview])])];
    const q = store.save({ ...base, id: store.newId(), kind: 'ask', tool_use_id: p.tool_use_id ?? null, questions: qs, context, images: store.imagesIn(texts, p.cwd) });
    store.log({ event: 'asked', id: q.id, kind: 'ask', project: q.project, handle });
    return;
  }
  if (ev === 'Stop') {
    if (p.stop_hook_active) return;
    // a turn that ended moves past the last plain-text question of this session
    for (const q of store.open({ session: sid }).filter((x) => x.kind === 'stop')) store.close(q, 'superseded');
    if (store.RUNNER_ROLES.has(base.role)) return;
    const text = p.last_assistant_message ?? store.lastAssistantText(p.transcript_path);
    if (!store.looksLikeQuestion(text)) return;
    const q = store.save({ ...base, id: store.newId(), kind: 'stop', text: String(text).slice(-12000), images: store.imagesIn([text], p.cwd) });
    store.log({ event: 'asked', id: q.id, kind: 'stop', project: q.project, handle });
  }
}

// ------------------------------------------------------------------ director side

function parseArgs(argv) {
  const o = { _: [], pick: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['all', 'json'].includes(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    if (k === 'pick') o.pick.push(v); else o[k] = v;
  }
  return o;
}

/** The chat message an answer becomes. → string */
export function answerText(q, picks, text) {
  const note = oneLine(text);
  if (q.kind === 'stop') return `[director console] ${note}`;
  const parts = q.questions.map((x, i) => {
    const chosen = picks.filter((p) => p.n === i + 1).map((p) => p.label);
    return `(${i + 1}) ${oneLine(x.header || x.question, 160)}: ${chosen.length ? chosen.join(', ') : 'không chọn'}`;
  });
  return `[director console] Trả lời câu hỏi bạn vừa hỏi (hộp chọn đã đóng): ${parts.join(' ')}${note ? ` · Ghi chú: ${note}` : ''}. Làm tiếp theo câu trả lời này.`;
}

function parsePicks(q, raw) {
  return raw.map((s) => {
    const m = String(s).match(/^(\d+)=(.+)$/s);
    if (!m) die(`--pick must be "<n>=<label>", got ${s}`);
    const n = Number(m[1]);
    const x = q.questions?.[n - 1];
    if (!x) die(`question ${n} does not exist`);
    if (!x.options.some((o) => o.label === m[2])) die(`"${m[2]}" is not an option of question ${n}`);
    return { n, label: m[2] };
  });
}

/** Does the terminal's screen show a choice dialog (Claude Code's "Enter to select · … · Esc to cancel")? */
function dialogOpen(handle) {
  const r = orca(['terminal', 'read', '--terminal', handle, '--screen']);
  const t = r.parsed?.result?.terminal ?? r.parsed?.result ?? {};
  const lines = t.tail ?? t.lines ?? [];
  return lines.slice(-8).some((l) => /Enter to select|Esc to cancel/.test(String(l)));
}

/** Type the text, then a separate Enter: input Orca passes through while it holds the pane as blocked. */
function typeRaw(handle, text, fail) {
  const t = orca(['terminal', 'send', '--terminal', handle, '--text', text.startsWith('-') ? ` ${text}` : text]);
  if (!t.ok) fail(`typing the answer failed: ${t.err}`);
  spawnSync('sleep', ['0.4']);
  const e = orca(['terminal', 'send', '--terminal', handle, '--text', '\r']);
  if (!e.ok) fail(`Enter failed: ${e.err}`);
}

function answer(o) {
  const q = store.get(o.id ?? die('--id is required'));
  if (q.status !== 'open') die(`question ${q.id} is ${q.status}`, { status: q.status });
  const picks = q.kind === 'ask' ? parsePicks(q, o.pick) : [];
  if (q.kind === 'ask' && !picks.length && !o.text?.trim()) die('pick an option or write an answer');
  if (q.kind === 'stop' && !o.text?.trim()) die('--text is required');
  const show = orca(['terminal', 'show', '--terminal', q.handle]);
  const term = show.parsed?.result?.terminal ?? show.parsed?.result ?? null;
  if (!show.ok || term?.connected === false || term?.orphaned) {
    store.close(q, 'gone');
    die(`the agent's terminal ${q.handle} is gone: ${show.err ?? 'not connected'}`);
  }
  const msg = answerText(q, picks, o.text);
  // claim it first, so the chat hooks that our own keystrokes fire do not close it as a chat answer
  store.save({ ...q, status: 'answering' });
  const fail = (why) => {
    store.save({ ...q, status: 'open', last_error: why });
    die(why);
  };
  if (q.kind === 'ask') {
    // the dialog takes keys, not text, and Orca refuses a prompt while it is open (agent_prompt_blocked).
    // A raw Esc closes it ("User declined to answer"; `--interrupt` does not), but Orca keeps the
    // pane marked blocked, so the answer is typed raw and submitted with a raw Enter.
    const esc = orca(['terminal', 'send', '--terminal', q.handle, '--text', '\u001b']);
    if (!esc.ok) fail(`Esc to the dialog failed: ${esc.err}`);
    orca(['terminal', 'wait', '--terminal', q.handle, '--for', 'tui-idle', '--timeout-ms', '8000'], 15000);
    if (dialogOpen(q.handle)) fail('the dialog is still open after Esc; answer it in the terminal');
    typeRaw(q.handle, msg, fail);
  } else {
    const sent = orca(['terminal', 'send', '--terminal', q.handle, '--text', msg, '--enter', '--wait-submit', '5'], 30000);
    if (!sent.ok && /agent_prompt_blocked/.test(sent.err ?? '')) {
      // Orca still thinks a dialog is up: type it only if the screen shows none
      if (dialogOpen(q.handle)) fail('a dialog is open in the agent\'s terminal; answer it there');
      typeRaw(q.handle, msg, fail);
    } else if (!sent.ok) fail(`send failed: ${sent.err}`);
  }
  const done = store.close({ ...q, status: 'answering' }, 'answered', { answer: { via: 'console', picks, text: o.text ?? null, message: msg, at: new Date().toISOString() } });
  say({ ok: true, id: q.id, status: done.status, message: msg, handle: q.handle });
}

// the events the hook needs; AskUserQuestion only for the tool events, so other tool calls never start it
const HOOK_EVENTS = [['PreToolUse', ASK], ['PostToolUse', ASK], ['PostToolUseFailure', ASK], ['Stop', null], ['UserPromptSubmit', null], ['SessionEnd', null]];

/** Add the hook to a Claude Code settings file (once per event; other hooks are left as they are). → events added */
export function installHook(file, self = new URL(import.meta.url).pathname) {
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(self)} hook`;
  settings.hooks ??= {};
  const added = [];
  for (const [ev, matcher] of HOOK_EVENTS) {
    const list = (settings.hooks[ev] ??= []);
    if (list.some((e) => (e.hooks ?? []).some((x) => String(x.command).includes('agent-questions.mjs')))) continue;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] });
    added.push(ev);
  }
  if (added.length) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-agent-questions`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return added;
}

const commands = {
  'install-hook': (o) => {
    const file = o.settings ?? `${process.env.HOME}/.claude/settings.json`;
    say({ ok: true, settings: file, added: installHook(file) });
  },
  hook: () => {
    let s = '';
    process.stdin.on('data', (c) => (s += c)).on('end', () => {
      try { hook(JSON.parse(s)); } catch (e) { store.log({ event: 'hook-error', error: String(e?.message ?? e).slice(0, 300) }); }
      process.exit(0);
    });
  },
  list: (o) => say({ ok: true, questions: o.all ? store.all() : store.open() }),
  answer,
  dismiss: (o) => {
    const q = store.get(o.id ?? die('--id is required'));
    if (!o.note?.trim()) die('--note is required');
    const done = store.close(q, 'dismissed', { note: o.note.trim() });
    say({ ok: done.status === 'dismissed', id: q.id, status: done.status });
  },
  focus: (o) => {
    const q = store.get(o.id ?? die('--id is required'));
    const r = orca(['terminal', 'switch', '--terminal', q.handle]);
    if (!r.ok) die(`switch failed: ${r.err}`);
    say({ ok: true, id: q.id, handle: q.handle });
  },
};

if (import.meta.url === `file://${fs.realpathSync(process.argv[1] ?? '')}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!commands[cmd]) die(`usage: agent-questions.mjs <${Object.keys(commands).join('|')}> …`);
  commands[cmd](parseArgs(rest));
}

export { hook };
