#!/usr/bin/env node
/**
 * coordinator-guard — provider-agnostic shell-command guard for the producer / fleet coordinator
 * (M2 of docs/plans/2026-10-01-coordinator-token-optimization).
 *
 * classify() is pure: one command (plus the session's history) → allow | warn | deny. Adapters only
 * translate each CLI's hook I/O:
 *   node coordinator-guard.mjs --cli claude|codex   PreToolUse JSON on stdin; deny = exit 2 + stderr
 *   node coordinator-guard.mjs --cli cursor         beforeShellExecution JSON on stdin; JSON permission on stdout
 *   adapters/opencode-plugin.js                     in-process `tool.execute.before`; deny = throw
 *
 * Active only when the launcher tagged the session (CC_ROLE, see bootstrap.mjs --role):
 *   - every role:            no writes to an agent CLI's global MCP config
 *   - producer:              never mutate a lane's Run (run-use, gate-resolve, task-*, dispatch, send/reply, --from)
 *   - producer, coordinator: no polling: bare `check` loops, unbounded or repeated `terminal read`, long
 *                            sleeps or sleep loops, detached or over-cap waits, repeated `--help`
 * CC_GUARD_MODE: shadow (default: log only) | block | off. A PreToolUse hook sees commands, never their
 * results or the wake-up text Orca injects, so every rule works on the command history alone. The
 * command is read with a small shell lexer: quoted text, heredoc bodies and comments are data, never
 * commands. Every scan is linear. Any internal error fails open (allow) and is logged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHEATSHEET = '~/.agents/skills/cocos-orca-fleet/reference/orca/cheatsheet.md';
const WAIT_ROLES = new Set(['producer', 'coordinator']);
const DEFAULT_MAX_WAIT_MS = 570000; // Claude Code Bash caps a command at 600000 ms
const READ_LIMIT = 40;
const MAX_INPUT = 200000; // longer commands are judged on their first 200k characters
const STATE_TTL_MS = 12 * 3600 * 1000;

const GLOBAL_MCP_CONFIG_RE =
  /(?:~|\$\{?HOME\}?|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)\/(?:\.codex\/config\.toml|\.cursor\/mcp\.json|\.config\/opencode\/opencode\.jsonc?|\.claude\.json)(?![\w.-])/;
const MCP_CONFIG_SUGGESTION = 'per-checkout MCP comes only from `node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs mcp-config --path <checkout>`';

// ------------------------------------------------------------------ shell lexing

/** Heredoc bodies are data (specs, prompts, notes), never commands: keep only their opening line. */
export function stripHeredocs(cmd) {
  const out = [];
  let end = null;
  for (const line of String(cmd).split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) end = m[2];
  }
  return out.join('\n');
}

/**
 * Split into simple commands at the top level only: `;` `&&` `||` `|` `&` and newlines inside quotes
 * or `$( … )` do not split; `$( … )` and backtick bodies are lexed as commands of their own.
 * Each segment: { raw, bare (quoted text emptied), bg (ended by `&`), piped (feeds a `|`) }.
 */
export function lex(cmd) {
  const text = stripHeredocs(String(cmd).slice(0, MAX_INPUT)).replace(/\\\r?\n/g, ' ');
  const out = [];
  let raw = '';
  let bare = '';
  let quote = null;
  const flush = (bg = false, piped = false) => {
    if (raw.trim()) out.push({ raw: raw.trim(), bare: bare.trim(), bg, piped });
    raw = '';
    bare = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      raw += c;
      if (quote === '"' && c === '\\') {
        raw += n ?? '';
        i++;
      } else if (c === quote) {
        quote = null;
        bare += c;
      } else if (quote === '"' && c === '$' && n === '(') {
        const end = matchParen(text, i + 1);
        out.push(...lex(text.slice(i + 2, end)));
        raw += text.slice(i + 1, end + 1);
        i = end;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      raw += c;
      bare += c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++;
      flush();
    } else if (c === '$' && n === '(') {
      const end = matchParen(text, i + 1);
      out.push(...lex(text.slice(i + 2, end)));
      raw += text.slice(i, end + 1);
      bare += '$()';
      i = end;
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1) === -1 ? text.length : text.indexOf('`', i + 1);
      out.push(...lex(text.slice(i + 1, end)));
      raw += text.slice(i, end + 1);
      bare += '``';
      i = end;
    } else if (c === '\n' || c === ';') {
      flush();
    } else if (c === '&' && n === '&') {
      flush();
      i++;
    } else if (c === '|' && n === '|') {
      flush();
      i++;
    } else if (c === '|') {
      flush(false, true);
    } else if (c === '&' && n !== '>' && text[i - 1] !== '>' && text[i - 1] !== '<') {
      flush(true);
    } else {
      raw += c;
      bare += c;
    }
  }
  flush();
  return out;
}

function matchParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** Simple commands for callers that only need the text. */
export const segments = (cmd) => lex(cmd).map((s) => s.raw);

/** Leading shell keywords, wrappers and env assignments off; reports nohup / setsid. */
function head(bare) {
  let s = bare;
  let detach = false;
  for (;;) {
    const m = s.match(/^(?:(?:do|then|else|elif|if|while|until|!|time|command|exec|env|sudo)\s+|(?:nohup|setsid)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/);
    if (!m) return { cmd: s, detach };
    if (/^(?:nohup|setsid)\s/.test(m[0])) detach = true;
    s = s.slice(m[0].length);
  }
}

function flagValue(raw, flag) {
  const m = raw.match(new RegExp(`${flag}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|(\\S+))`));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** `orca [--json] <sub…>` at the start of a simple command → the subcommand words, else null. */
function orcaSub(cmd) {
  const m = cmd.match(/^(?:\S*\/)?orca\s+(?:--json\s+)*(.*)$/);
  return m ? m[1] : null;
}

const isWait = (cmd) =>
  /^orchestration\s+check\b/.test(orcaSub(cmd) || '') && /\s--wait\b/.test(cmd) ||
  /^terminal\s+wait\b/.test(orcaSub(cmd) || '') ||
  /^(?:node\s+)?\S*orca-wait(?:\.mjs)?\s+(?:coord|lane)\b/.test(cmd);

function seconds(arg) {
  const m = String(arg).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return 0;
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

/** Redirect targets of stdout (`>`, `>>`, `&>`, `1>`), stderr-only redirects excluded. */
function stdoutTargets(raw) {
  const out = [];
  for (const m of raw.matchAll(/(^|[^0-9&<>])(&?)(1?)>{1,2}(?!&)\s*("([^"]*)"|'([^']*)'|([^\s;|&]+))/g)) {
    out.push(m[5] ?? m[6] ?? m[7]);
  }
  return out;
}

function argWords(raw) {
  return [...raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// ------------------------------------------------------------------ classify

export function emptyState() {
  return { bareChecks: 0, waited: [], waitedAny: false, read: [], help: {}, updated: null };
}

/**
 * input: { command?, filePath?, background? }   role: CC_ROLE value   state: from emptyState()
 * → { verdict: 'allow'|'warn'|'deny', rule, reason, suggestion, state } (state is the updated copy)
 */
export function classify(input, role, prevState = emptyState(), { maxWaitMs = DEFAULT_MAX_WAIT_MS, now = Date.now() } = {}) {
  const stale = prevState?.updated && now - Date.parse(prevState.updated) > STATE_TTL_MS;
  const state = JSON.parse(JSON.stringify({ ...emptyState(), ...(stale ? {} : prevState) }));
  state.updated = new Date(now).toISOString();
  const hits = [];
  const deny = (rule, reason, suggestion) => hits.push({ verdict: 'deny', rule, reason, suggestion });
  const warn = (rule, reason, suggestion) => hits.push({ verdict: 'warn', rule, reason, suggestion });
  const result = () => {
    const pick = hits.find((h) => h.verdict === 'deny') || hits.find((h) => h.verdict === 'warn');
    return pick ? { ...pick, state } : { verdict: 'allow', rule: null, reason: '', suggestion: '', state };
  };

  // Edit / Write tools: only the global-config rule applies
  if (input.filePath) {
    const p = input.filePath.replace(os.homedir(), '~');
    if (GLOBAL_MCP_CONFIG_RE.test(p)) deny('global-mcp-config', `writes ${p}, a global agent MCP config every session loads`, MCP_CONFIG_SUGGESTION);
    return result();
  }
  if (!String(input.command || '').trim()) return result();
  const segs = lex(input.command).map((s) => ({ ...s, ...head(s.bare) }));

  // every role: global MCP configs (as a write target only; reading them is fine)
  for (const s of segs) {
    if (/bootstrap\.mjs\s+mcp-(?:audit|config)\b/.test(s.cmd)) continue;
    const words = argWords(s.raw);
    const verb = s.cmd.split(/\s+/)[0];
    const target =
      stdoutTargets(s.raw).some((t) => GLOBAL_MCP_CONFIG_RE.test(t)) ||
      (/^(?:tee|truncate|rm)$/.test(verb) && words.some((w) => GLOBAL_MCP_CONFIG_RE.test(w))) ||
      (/^(?:sed|perl)$/.test(verb) && /\s-[a-zA-Z]*i|--in-place/.test(s.cmd) && words.some((w) => GLOBAL_MCP_CONFIG_RE.test(w))) ||
      (/^(?:cp|mv|ln|install|rsync)$/.test(verb) && GLOBAL_MCP_CONFIG_RE.test(words[words.length - 1] || '')) ||
      /^(?:codex|claude|opencode|cursor-agent)\s+mcp\s+(?:add|remove|rm|set|enable|disable)\b/.test(s.cmd);
    if (target) deny('global-mcp-config', 'edits a global agent MCP config every session on the machine loads', MCP_CONFIG_SUGGESTION);
  }

  if (role === 'producer') {
    for (const s of segs) {
      const sub = orcaSub(s.cmd);
      if (!sub || !/^orchestration\s/.test(sub) || /\s--help\b/.test(s.cmd)) continue;
      const m = sub.match(/^orchestration\s+(run-use|gate-resolve|task-create|task-update|worker-(?!list(?![-\w])|show(?![-\w])|read(?![-\w]))[a-z-]+|dispatch|send|reply)(?![-\w])/);
      if (m || /\s--from\b/.test(s.cmd)) {
        deny('producer-lane-run', `\`orca orchestration ${m ? m[1] : '… --from'}\` mutates a lane's Run (S08: run-use fenced the live coordinator)`,
          'send decisions to the coordinator as plain text with `orca terminal send`; gates are its to resolve');
      }
    }
  }

  if (!WAIT_ROLES.has(role)) return result();

  // waits: foreground, stdout to the tool, under the shell cap
  const disowned = segs.some((s) => /^disown\b/.test(s.cmd));
  for (const s of segs.filter((x) => isWait(x.cmd))) {
    if (s.detach || s.bg || disowned || input.background) {
      deny('detached-wait', 'a detached or background wait returns at once and nothing wakes you (S08 stalled ~3 h)', 'run the wait in the foreground');
    }
    const file = stdoutTargets(s.raw).find((t) => t !== '/dev/null');
    if (file) deny('detached-wait', `the wait's stdout goes to ${file}, which nobody reads`, 'pipe stdout only; keepalives stay on stderr');
    for (const t of s.cmd.matchAll(/--(?:timeout-ms|max-ms)(?:\s+|=)(\d+)/g)) {
      if (Number(t[1]) > maxWaitMs) {
        deny('wait-over-cap', `--timeout-ms ${t[1]} is above the shell tool's cap; the tool kills the wait mid-way`,
          `use ≤ ${maxWaitMs} (orca-wait does this for you)`);
      }
    }
  }

  // sleeps: as commands only (quoted text and arguments are not sleeps); loops by a linear walk
  let loopDepth = 0;
  for (const s of segs) {
    const first = s.cmd.split(/\s+/)[0];
    if (/^(?:for|while|until)$/.test(first)) loopDepth++;
    if (/^done\b/.test(s.bare)) loopDepth = Math.max(0, loopDepth - 1);
    const sl = s.cmd.match(/^sleep\s+(\S+)/);
    if (!sl) continue;
    if (loopDepth > 0) {
      deny('sleep-loop', 'a sleep loop polls; each wake-up is a paid turn',
        'one foreground wait: `orca-wait`, `orca terminal wait`, or `bootstrap.mjs wait-mcp` for an editor');
    } else if (seconds(sl[1]) > 30) {
      deny('long-sleep', `sleep ${sl[1]} waits blind`, 'wait on the event instead: `orca-wait`, `orca terminal wait`, `bootstrap.mjs wait-mcp`');
    }
  }

  for (const s of segs) {
    const sub = orcaSub(s.cmd) || '';
    // waits and sends earn reads; a coordinator wait that returned means a worker reported
    if ((/^orchestration\s+check\b/.test(sub) && /\s--wait\b/.test(s.cmd)) || /orca-wait(?:\.mjs)?\s+coord\b/.test(s.cmd)) {
      state.bareChecks = 0;
      state.waitedAny = true;
    }
    const h0 = (/^terminal\s+(?:wait|send)\b/.test(sub) || /orca-wait(?:\.mjs)?\s+lane\b/.test(s.cmd)) && (flagValue(s.raw, '--terminal') || flagValue(s.raw, '--handle'));
    if (h0) state.waited = [...new Set([...state.waited, h0])].slice(-50);
    else if (/orca-wait(?:\.mjs)?\s+lane\b/.test(s.cmd)) state.waitedAny = true; // --run: handle resolved inside orca-wait

    // bare check: one is the wake-up protocol, a second before the next wait is polling
    if (/^orchestration\s+check\b/.test(sub) && !/\s--(?:wait|ack|peek|all|help)\b/.test(s.cmd)) {
      if (state.bareChecks >= 1) {
        deny('check-polling', 'a second `check` without --wait before the next wait is polling',
          '`orca-wait coord` (or `check --ack <id> --wait …`) blocks until the next Delivery');
      }
      state.bareChecks += 1;
    }

    // terminal read: bounded, first look free, then only after a wait or send on that handle
    if (/^terminal\s+read\b/.test(sub) && !/\s--help\b/.test(s.cmd)) {
      const h = flagValue(s.raw, '--terminal') || '(active)';
      const limit = Number(flagValue(s.raw, '--limit'));
      const bounded = /\s--(?:screen|cursor)\b/.test(s.cmd) || s.piped || (limit > 0 && limit <= READ_LIMIT);
      if (!bounded) {
        deny('read-unbounded', '`terminal read` without --limit ≤ 40, --screen or --cursor pulls the whole scrollback into context',
          `add --limit ${READ_LIMIT} (or --screen)`);
      } else if (state.read.includes(h) && !state.waited.includes(h) && !state.waitedAny) {
        deny('read-without-wait', `reads ${h} again with no wait or send on it since the last read: that is polling`,
          `\`orca terminal wait --terminal ${h} --for tui-idle\` (or \`orca-wait lane\`) first; reading after a timed-out wait is fine`);
      } else {
        state.waited = state.waited.filter((x) => x !== h);
        state.waitedAny = false;
        if (!state.read.includes(h)) state.read = [...state.read, h].slice(-50);
      }
    }

    // --help: once per subcommand per session, then the cheatsheet
    const hm = sub.match(/^((?:[a-z][a-z-]*\s+){0,2})--help\b/) || sub.match(/^help\b\s*((?:[a-z][a-z-]*\s*){0,2})/);
    if (hm) {
      const hk = hm[1].trim() || '(top)';
      state.help[hk] = (state.help[hk] || 0) + 1;
      if (state.help[hk] > 1) deny('help-repeat', `\`orca ${hk} --help\` again this session`, `read ${CHEATSHEET} (\`--help\` once per subcommand is allowed)`);
      else warn('help-first', `\`orca ${hk} --help\` (first time this session)`, `the flags are in ${CHEATSHEET}`);
    }
  }
  return result();
}

// ---------------------------------------------------------------- state, log, adapters

const stateDir = () => path.join(process.env.TMPDIR || os.tmpdir(), 'coordinator-guard');
const safeId = (id) => String(id || `ppid-${process.ppid}`).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

export function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), `${safeId(sessionId)}.json`), 'utf8'));
  } catch {
    return emptyState();
  }
}

export function saveState(sessionId, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const file = path.join(stateDir(), `${safeId(sessionId)}.json`);
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {
    /* state is best-effort */
  }
}

export const logFile = () => process.env.CC_GUARD_LOG || path.join(os.homedir(), '.agents', 'logs', 'coordinator-guard.jsonl');

export function logDecision(entry) {
  try {
    const f = logFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, `${f}.1`);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never block a command */
  }
}

/**
 * Shared adapter body. → { block: bool, message } ; never throws.
 * cli: claude | codex | cursor | opencode   input: { command?, filePath?, background? } | null (not ours)
 */
export function guard(cli, sessionId, input, env = process.env) {
  const role = env.CC_ROLE || '';
  const mode = (env.CC_GUARD_MODE || 'shadow').toLowerCase();
  if (!role || mode === 'off' || !input) return { block: false, message: '' };
  try {
    const maxWaitMs = Number(env.CC_GUARD_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS;
    let r = classify(input, role, loadState(sessionId), { maxWaitMs });
    // hooks/tests/adapters-live.mjs: a side-effect-free command no CLI blocks on its own
    if (env.CC_GUARD_SELFTEST === '1' && /CC_GUARD_SELFTEST_DENY/.test(input.command || '')) {
      r = { ...r, verdict: 'deny', rule: 'selftest', reason: 'adapter self-test command', suggestion: 'expected in hooks/tests/adapters-live.mjs' };
    }
    saveState(sessionId, r.state);
    const block = r.verdict === 'deny' && mode === 'block';
    logDecision({
      ts: new Date().toISOString(), cli, session_id: sessionId || null, role, slice: env.CC_SLICE || '', project: env.CC_PROJECT || '',
      cwd: process.cwd(), mode, verdict: r.verdict, rule: r.rule, blocked: block,
      cmd: (input.command || input.filePath || '').slice(0, 200),
    });
    const message = r.verdict === 'allow' ? '' : `coordinator-guard (${r.rule}): ${r.reason}. ${r.suggestion}`;
    return { block, message };
  } catch (err) {
    logDecision({ ts: new Date().toISOString(), cli, session_id: sessionId || null, role, mode, verdict: 'error', error: String(err?.message || err) });
    return { block: false, message: '' };
  }
}

/**
 * Hook payload → guard input. Claude Code / Codex PreToolUse: Bash commands (with run_in_background) and
 * Claude's file-writing tools; every other tool is not ours (null). Cursor beforeShellExecution: shell only.
 */
export function inputFromPayload(cli, payload) {
  if (cli === 'cursor') return { sessionId: payload.conversation_id || payload.session_id, input: { command: payload.command || '' } };
  const ti = payload.tool_input || {};
  if (payload.tool_name === 'Bash') return { sessionId: payload.session_id, input: { command: ti.command || '', background: ti.run_in_background === true } };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) {
    return { sessionId: payload.session_id, input: { filePath: ti.file_path || ti.notebook_path || '' } };
  }
  return { sessionId: payload.session_id, input: null };
}

async function main() {
  const cli = process.argv[process.argv.indexOf('--cli') + 1];
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 4 * MAX_INPUT) break;
  }
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    /* unknown payload: allow */
  }
  const { sessionId, input } = inputFromPayload(cli, payload);
  const { block, message } = guard(cli, sessionId, input);
  if (cli === 'cursor') {
    process.stdout.write(JSON.stringify(block ? { permission: 'deny', user_message: message, agent_message: message } : { permission: 'allow' }));
    return;
  }
  if (block) {
    process.stderr.write(message + '\n');
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(() => process.exit(0));
}
