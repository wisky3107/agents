/**
 * Judge (plan M4d): a question the runner cannot decide mechanically but the contracts can goes to
 * one read-only `claude -p` call before it reaches the human. Safety is mechanical, not prose:
 * - the call is sandboxed: --restricted --tools Read,Grep,Glob (no Bash/Edit/Write, settings files
 *   ignored), no MCP, no skills, no permission prompts (verified on claude 2.1.287);
 * - each kind offers the judge a fixed subset of options (never stop / block / skip / "answered");
 * - cost, budget, credit and PLAN-approval questions never reach it;
 * - "treat as approved" is offered only when the newest review file (review.md, or review-r<N>.md)
 *   really ends APPROVED;
 * - an answer from the contracts must quote a sentence (30+ characters, not front matter or a
 *   heading) that the runner finds in the slice file, SCOPE.md or MILESTONES.md;
 * - anything else — defer, error, an option outside the subset — goes to the human.
 * Phase 1 trusts only `claude` as the judge provider (`judge_agent` in AGENT_NOTES release: or fleet:).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as st from './state.mjs';
import * as io from './orca.mjs';
import { fleetHandoff } from './lanes.mjs';

const PROMPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference', 'judge-prompt.md');
/** The options each kind may offer the judge (a fleet gate: its own options, never stop). */
const ALLOW = {
  // a gate's options are lane-written: the runner's own actions are never the judge's to pick
  fleet_gate: (o) => !['stop', 'mark blocked', 'skip this slice'].includes(o),
  lane_blocked: (o) => o === 'send this answer to the lane',
  unknown_status: (o) => ['treat as working, keep waiting', 'treat as ready_for_review', 'treat as changes_requested', 'treat as offer_commit'].includes(o),
  verdict_mismatch: (o) => ['treat as approved', 'treat as changes_requested'].includes(o),
};
// Not here on purpose: coordinator_question (a keystroke relay into the coordinator's codex panel, whose
// options are screen text, not contract wording) and director_pending (the coordinator itself said the
// decision is the director's). Both always wait for the director; autopilot does not answer them either.
export const JUDGE_KINDS = new Set(Object.keys(ALLOW));
const FROM_CONTRACTS = new Set(['fleet_gate', 'lane_blocked']); // these answers must quote a contract line
const NEEDS_TEXT = new Set(['send this answer to the lane', 'answer with --text']);
// money, budget and plan sign-off are the director's (SKILL Step 2c / 2d), whatever the contracts say
const DIRECTORS = /PLAN approval|open questions|budget|credits?\b|tripo|bump|cut_to|\bcosts?\b|\bprice|deadline|priorit/i;
export const MAX_JUDGED = 2; // judge answers per slice and kind before every further one goes to the human

/** `judge_agent` → { model, spec } | { unsupported } | null (no judge: every question is the human's). */
export function judgeSpec(project) {
  const spec = String(project.release.judge_agent || project.fleet.judge_agent || '').trim();
  if (!spec) return null;
  const words = spec.split(/\s+/);
  if (words[0] !== 'claude') return { unsupported: spec };
  return { spec, model: words.includes('--model') ? words[words.indexOf('--model') + 1] : null };
}

/** The last JSON object in a text (the model may wrap it in prose or a fence). */
function lastJson(text) {
  const s = String(text || '');
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = s.lastIndexOf('{', start - 1)) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        /* widen */
      }
    }
  }
  return null;
}

const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const norm = (t) => oneLine(t).toLowerCase().replace(/[`*_"“”'’]/g, '');

/** The slice's evidence: the feature worktree's for a fleet lane, the main checkout's otherwise. */
function evidenceDir(project, slice) {
  if (st.readSliceState(project.root, slice).lane === 'fleet') {
    const { file } = fleetHandoff(project.root, slice);
    return path.dirname(file);
  }
  return path.join(st.sliceDir(project.root, slice), 'evidence');
}

/**
 * The judge's view of `dir`: a model reads "cursor" in its prompt with a zero-width joiner inside
 * (".c\u200dursor"), so every Read of a `.cursor/…` path came back not found (cc-firefighter-kids
 * S01 q6; reproduced with claude -p). A symlink under the temp dir names the same files without it.
 */
export function judgeView(dir, slice) {
  if (!/cursor/i.test(dir)) return dir;
  const base = /cursor/i.test(os.tmpdir()) ? '/tmp/producer-judge' : path.join(os.tmpdir(), 'producer-judge');
  const link = path.join(base, `${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 10)}-${slice || 'x'}-evidence`);
  try {
    fs.mkdirSync(base, { recursive: true });
    if (fs.existsSync(link) && fs.realpathSync(link) === fs.realpathSync(dir)) return link;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(dir, link);
    return link;
  } catch {
    return dir;
  }
}

/**
 * The newest review file's verdict is an unconditional APPROVED, markup aside: bare, or with one parenthetical
 * note that carries no condition ("APPROVED (minor notes only)"). Anything else — "APPROVED pending…",
 * "APPROVED, needs follow-up", a dash note — is not the judge's to accept.
 */
function verdictIsApproved(dir) {
  let last = '';
  try {
    last = fs.readFileSync(st.reviewFile(dir), 'utf8').trim().split('\n').pop();
  } catch {
    return false;
  }
  const m = last.replace(/^[*_`#>\s]+|[*_`.!\s]+$/g, '').match(/^APPROVED(?:\s*\(([^()]*)\))?$/);
  return Boolean(m) && !/\b(pending|but|unless|if|except|once|after|until|when|however|needs?|provisional\w*|subject|follow|condition\w*|todo|tbd|blocked|changes)\b/i.test(m[1] || '');
}

/**
 * Contract prose only: no fenced blocks (yaml, code), headings or table separators. A slice's
 * front matter is its contract (acceptance, runtime_checks, decisions), so its values stay and
 * only the yaml keys and list dashes go — cc-firefighter-kids S01 q4 deferred a runtime_checks line.
 */
function prose(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  const values = fm ? fm[1].split('\n').map((l) => l.replace(/^\s*(?:-\s+)?(?:[\w-]+:(?:\s+|$))?/, '')).join('\n') + '\n' : '';
  return (values + text.slice(fm ? fm[0].length : 0)).replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
    .split('\n').filter((l) => !/^\s*(#|\|?\s*:?-{3,})/.test(l)).join('\n');
}

/** Is `quote` (≥ 30 characters) a sentence of the slice file (front matter values included), SCOPE.md or MILESTONES.md prose? */
export function quoted(project, slice, quote) {
  const q = norm(quote);
  if (q.length < 30) return false;
  const files = [project.sliceFiles[slice], 'SCOPE.md', 'MILESTONES.md'].filter(Boolean);
  return files.some((f) => {
    try {
      return norm(prose(fs.readFileSync(path.join(project.root, f), 'utf8'))).includes(q);
    } catch {
      return false;
    }
  });
}

/**
 * The `env` block of the user's Claude settings (API route, token, model aliases): `--restricted`
 * skips settings files, and a runner started in a fresh Orca terminal does not inherit them, so the
 * judge gets them here — the same route and billing as every other session (checked on 2.1.287).
 */
function settingsEnv() {
  const f = process.env.PRODUCER_RUNNER_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const env = JSON.parse(fs.readFileSync(f, 'utf8')).env;
    return env && typeof env === 'object' ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) : {};
  } catch {
    return {};
  }
}

function prompt(project, q, options, dir) {
  const tpl = fs.readFileSync(PROMPT, 'utf8').match(/```text\n([\s\S]*?)\n```/)[1];
  const slice = q.slice || '-';
  const values = {
    PROJECT: project.root, KIND: q.kind, SLICE: slice, QUESTION: q.text, OPTIONS: options.map((o) => `- ${o}`).join('\n'),
    SLICE_FILE: project.sliceFiles[slice] || 'the slice file', EVIDENCE_DIR: dir,
  };
  // values may contain angle brackets (lane-written text): replace the template's keys only, once
  return tpl.replace(/<([A-Z_]+)>/g, (m, k) => (k in values ? values[k] : m));
}

/**
 * Ask the judge. → { choice, text, reason, quote } | { defer: reason }. Every call is logged in the
 * spawn registry (role judge) so token-report counts it with the producer.
 */
export function consult(project, q) {
  const spec = judgeSpec(project);
  if (!spec) return { defer: 'no judge_agent' };
  if (spec.unsupported) return { defer: `judge_agent "${spec.unsupported}" is not a verified provider (phase 1: claude only)` };
  if (!JUDGE_KINDS.has(q.kind)) return { defer: `${q.kind} questions are the director's` };
  if (DIRECTORS.test(`${q.text} ${q.options.join(' ')}`)) return { defer: 'a plan sign-off, budget, credit or cost question is the director\'s' };
  const dir = evidenceDir(project, q.slice);
  let options = q.options.filter(ALLOW[q.kind]);
  // approve only a review whose HANDOFF and verdict line both say approved (markup aside)
  if (!/^HANDOFF says approved\b/.test(q.text) || !verdictIsApproved(dir)) options = options.filter((o) => o !== 'treat as approved');
  if (!options.length) return { defer: 'no option the judge may choose' };
  const quoteNeeded = FROM_CONTRACTS.has(q.kind);
  const view = judgeView(dir, q.slice);
  const schema = {
    type: 'object',
    properties: { choice: { type: 'string', enum: [...options, 'defer'] }, text: { type: 'string' }, quote: { type: 'string' }, reason: { type: 'string' } },
    required: ['choice', 'reason'],
  };
  const bin = process.env.PRODUCER_RUNNER_JUDGE_CMD || 'claude';
  // read-only for real: --restricted drops code-running tools and ignores settings files, --tools
  // leaves Read/Grep/Glob, no MCP, no skills, nothing may prompt (a prompt is a denial)
  const args = ['-p', '--output-format', 'json', '--restricted', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--strict-mcp-config', '--disable-slash-commands', '--permission-prompts', 'none', '--json-schema', JSON.stringify(schema),
    ...(spec.model ? ['--model', spec.model] : []),
    // --restricted confines reads to the working dirs: a fleet lane's evidence is in its worktree
    ...(path.relative(project.root, view).startsWith('..') ? ['--add-dir', view] : [])];
  io.appendRegistry({ ts: st.now(), project: project.root, cwd: project.root, role: 'judge', slice: q.slice || null, agentSpec: spec.spec, command: 'claude -p (judge)', title: `judge-${q.id}`, handle: null });
  const r = spawnSync(bin, args, {
    cwd: project.root, input: prompt(project, q, options, view), encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...settingsEnv(), CC_ROLE: 'judge', CC_PROJECT: project.root, CC_SLICE: q.slice || '' },
  });
  if (r.error || r.status !== 0) return { defer: `judge call failed (${r.error?.code || `exit ${r.status}`}): ${(r.stderr || '').trim().slice(-160)}` };
  let out = null;
  try {
    // claude -p --output-format json: { is_error, result, structured_output } (verified on 2.1.287)
    const j = JSON.parse(r.stdout);
    if (j.is_error) return { defer: `the judge call ended in an error (${j.subtype || 'is_error'})` };
    out = j.structured_output && typeof j.structured_output === 'object' ? j.structured_output : lastJson(j.result);
  } catch {
    out = lastJson(r.stdout);
  }
  if (!out || typeof out.choice !== 'string') return { defer: 'the judge gave no JSON answer' };
  const reason = oneLine(out.reason).slice(0, 400);
  if (out.choice === 'defer') return { defer: `judge deferred: ${reason || 'no reason'}` };
  if (!options.includes(out.choice)) return { defer: `the judge chose "${out.choice}", which is not an allowed option` };
  const text = oneLine(out.text);
  const quote = oneLine(out.quote).slice(0, 300);
  if (NEEDS_TEXT.has(out.choice) && !text) return { defer: `the judge chose "${out.choice}" without the answer text` };
  if (quoteNeeded && !quoted(project, q.slice, quote)) return { defer: `the judge's quote is not a sentence (30+ characters) of the slice file, SCOPE.md or MILESTONES.md: "${quote.slice(0, 120)}"` };
  return { choice: out.choice, text, reason, ...(quote ? { quote } : {}) };
}
