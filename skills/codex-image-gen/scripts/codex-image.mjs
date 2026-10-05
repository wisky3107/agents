#!/usr/bin/env node
/**
 * codex-image.mjs — batch image generation and reference edits through Codex via OmniRoute
 *
 *   node codex-image.mjs check [--probe] [--json]
 *   node codex-image.mjs gen --prompt "<text>" --out <file.png> [--ref <png>]... [--alpha] [options]
 *   node codex-image.mjs gen --jobs <jobs.json> [options]
 *
 * options: --prefix-file <art-bible.txt> · --concurrency 6 · --attempts 3 · --overwrite
 *          · --model codex/gpt-5.6-terra-image · --report <report.json> · --json
 *
 * jobs.json: [{ "out": "a.png", "prompt": "...", "ref": ["front.png"], "alpha": true }]
 * (or { "jobs": [...] }). A ref that names another job's `out` waits for that job, so a side
 * view can be edited from a front made in the same run. Paths resolve from the current
 * directory. An existing file gets a -2, -3 … sibling unless --overwrite.
 *
 * The Codex backend pins its hosted image tool to gpt-image-2-codex (GPT Image 2 family) and
 * resets size / quality / background to auto: aspect ratio and transparency go in the prompt.
 * `check --probe` spends one generation to read the pinned model, so a move to GPT Image 2.5
 * shows up there. Endpoint: OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY, else the omniroute
 * provider in ~/.codex/config.toml, else http://localhost:20128.
 *
 * exit: 0 every job ok · 1 some job failed · 2 OmniRoute or its Codex image models unavailable
 *       · 64 usage / invalid jobs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MODEL = 'codex/gpt-5.6-terra-image';
const DEFAULT_BASE = 'http://localhost:20128';
// One Codex account serves one image at a time; OmniRoute holds six.
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 300000;
const BACKOFF_MS = 3000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const ALPHA_CONTRACT =
  'Output a PNG with a truly transparent alpha-channel background (RGBA): background pixels must have alpha 0; no solid color, scenery, gradient, glow field, checkerboard, matte, floor, backdrop, frame, or cast shadow outside the asset.';
const ALPHA_RETRY =
  'The previous result had no transparent pixels. The background MUST be fully transparent (alpha 0), not white, grey, black or a checkerboard pattern.';

export const EXIT = { ok: 0, failed: 1, unavailable: 2, usage: 64 };

/** base_url + bearer token of the [model_providers.omniroute] table in a Codex config.toml. */
export function parseCodexConfig(text) {
  const out = {};
  let inTable = false;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inTable = t === '[model_providers.omniroute]';
      continue;
    }
    if (!inTable) continue;
    const m = /^(base_url|experimental_bearer_token)\s*=\s*"([^"]*)"/.exec(t);
    if (m) out[m[1] === 'base_url' ? 'baseUrl' : 'key'] = m[2];
  }
  return out;
}

export function resolveEndpoint(env = process.env, configFile = path.join(os.homedir(), '.codex', 'config.toml')) {
  let cfg = {};
  try {
    cfg = parseCodexConfig(fs.readFileSync(configFile, 'utf8'));
  } catch {}
  const base = String(env.OMNIROUTE_BASE_URL || cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '').replace(/\/v1$/, '');
  const key = env.OMNIROUTE_API_KEY || cfg.key || '';
  const keySource = env.OMNIROUTE_API_KEY ? 'env' : cfg.key ? 'codex-config' : 'none';
  return { base, key, keySource };
}

/** Width, height and colour type from a PNG header, or null when the bytes are not a PNG. */
export function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const colorType = buf[25];
  const mode = { 0: 'L', 2: 'RGB', 3: 'P', 4: 'LA', 6: 'RGBA' }[colorType] || `type${colorType}`;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType, mode, interlace: buf[28] };
}

/**
 * Count fully transparent (alpha 0) and visible (alpha > 0) pixels of an 8-bit LA / RGBA PNG.
 * { transparent: 0, visible: total } for a PNG without an alpha channel; null when the format
 * is one this decoder does not read (16-bit, interlaced, palette + tRNS).
 */
export function alphaStats(buf) {
  const info = pngInfo(buf);
  if (!info) return null;
  const total = info.width * info.height;
  if (info.colorType === 0 || info.colorType === 2) return hasChunk(buf, 'tRNS') ? null : { transparent: 0, visible: total, total };
  if (![4, 6].includes(info.colorType) || info.bitDepth !== 8 || info.interlace !== 0) return null;
  const bpp = info.colorType === 6 ? 4 : 2;
  const stride = info.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(chunks(buf, 'IDAT')));
  let prev = Buffer.alloc(stride);
  let pos = 0;
  let transparent = 0;
  for (let y = 0; y < info.height; y++) {
    const filter = raw[pos++];
    const cur = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter} on row ${y}`);
      cur[x] = (cur[x] + p) & 255;
    }
    for (let x = bpp - 1; x < stride; x += bpp) if (cur[x] === 0) transparent++;
    prev = cur;
  }
  return { transparent, visible: total - transparent, total };
}

function* pngChunks(buf) {
  for (let off = 8; off + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    yield { type: buf.toString('latin1', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) };
    off += 12 + len;
  }
}
const chunks = (buf, type) => [...pngChunks(buf)].filter((c) => c.type === type).map((c) => c.data);
const hasChunk = (buf, type) => chunks(buf, type).length > 0;

/** Errors worth another call: network / timeout, 429, 5xx, and Codex declining the tool. */
export function retryable(status, message) {
  if (status === 0 || status === 429 || status >= 500) return true;
  return /declined|overloaded|image_generation_call|timed? ?out|rate.?limit/i.test(String(message || ''));
}

/** First path that is neither on disk nor already taken in this run: a.png, a-2.png, a-3.png … */
export function nextFreePath(file, taken = new Set()) {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? file : `${stem}-${n}${ext}`;
    if (!taken.has(candidate) && !fs.existsSync(candidate)) return candidate;
  }
}

export function buildPrompt(prompt, { alpha = false, prefix = '' } = {}) {
  let text = String(prompt).trim();
  if (alpha && !/transparent/i.test(text)) text = `${text} ${ALPHA_CONTRACT}`;
  return prefix ? `PROJECT ART BIBLE:\n${prefix.trim()}\n\n${text}` : text;
}

/**
 * Normalize raw jobs: absolute out (.png appended when missing) and refs, a final destination
 * per job (no silent overwrite), and every problem found up front — a ref that is neither a
 * file nor another job's out, a duplicate out, a ref cycle.
 */
export function planJobs(rawJobs, { cwd = process.cwd(), overwrite = false } = {}) {
  const problems = [];
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) return { jobs: [], problems: ['no jobs'] };
  const jobs = rawJobs.map((j, i) => {
    if (!j || typeof j.prompt !== 'string' || !j.prompt.trim()) problems.push(`job ${i + 1}: prompt is required`);
    if (!j || typeof j.out !== 'string' || !j.out.trim()) problems.push(`job ${i + 1}: out is required`);
    let out = path.resolve(cwd, String(j?.out || `job-${i + 1}`));
    if (!path.extname(out)) out += '.png';
    const refs = [].concat(j?.ref || j?.refs || []).map((r) => path.resolve(cwd, String(r)));
    return { index: i, out, prompt: String(j?.prompt || ''), refs, alpha: Boolean(j?.alpha) };
  });
  const byOut = new Map();
  for (const j of jobs) {
    if (byOut.has(j.out)) problems.push(`job ${j.index + 1}: out ${j.out} repeats job ${byOut.get(j.out) + 1}`);
    else byOut.set(j.out, j.index);
  }
  for (const j of jobs) {
    j.deps = j.refs.filter((r) => byOut.has(r) && byOut.get(r) !== j.index).map((r) => byOut.get(r));
    for (const r of j.refs) if (!byOut.has(r) && !fs.existsSync(r)) problems.push(`job ${j.index + 1}: ref not found: ${r}`);
  }
  const state = new Map();
  const visit = (i, trail) => {
    if (state.get(i) === 'done') return;
    if (state.get(i) === 'open') {
      problems.push(`ref cycle: ${[...trail, i].map((k) => `job ${k + 1}`).join(' → ')}`);
      return;
    }
    state.set(i, 'open');
    for (const d of jobs[i].deps) visit(d, [...trail, i]);
    state.set(i, 'done');
  };
  jobs.forEach((j) => visit(j.index, []));
  const taken = new Set();
  for (const j of jobs) {
    j.dest = overwrite ? j.out : nextFreePath(j.out, taken);
    taken.add(j.dest);
  }
  return { jobs, problems };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function callOnce({ base, key, model, prompt, refs, fetchImpl, timeoutMs }) {
  const headers = { Authorization: `Bearer ${key}` };
  let url;
  let body;
  if (refs.length) {
    url = `${base}/v1/images/edits`;
    body = new FormData();
    body.set('model', model);
    body.set('prompt', prompt);
    const field = refs.length === 1 ? 'image' : 'image[]';
    for (const r of refs) {
      const type = MIME[path.extname(r).toLowerCase()] || 'image/png';
      body.append(field, new Blob([fs.readFileSync(r)], { type }), path.basename(r));
    }
  } else {
    url = `${base}/v1/images/generations`;
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model, prompt, n: 1 });
  }
  let status = 0;
  let text = '';
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = String(e?.message || e);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const item = json?.data?.[0];
  if (status === 200 && item?.b64_json) return { ok: true, bytes: Buffer.from(item.b64_json, 'base64'), revisedPrompt: item.revised_prompt || null };
  const message = String(json?.error?.message || text || `HTTP ${status}`).replace(/\s+/g, ' ').slice(0, 300);
  return { ok: false, status, message };
}

/** One image, retried on transient errors: { ok, bytes, revisedPrompt, calls } or { ok: false, error, calls }. */
async function generate(prompt, refs, opts) {
  let last = null;
  let calls = 0;
  while (calls < opts.attempts) {
    calls++;
    const r = await callOnce({ ...opts, prompt, refs });
    if (r.ok && pngInfo(r.bytes)) return { ...r, calls };
    last = r.ok ? { status: 200, message: 'response is not a PNG' } : r;
    opts.log?.(`  ${path.basename(opts.label)} try${calls} HTTP${last.status} ${last.message.slice(0, 120)}`);
    if (!retryable(last.status, last.message) || calls === opts.attempts) break;
    await opts.sleep(opts.backoffMs * calls);
  }
  return { ok: false, error: `HTTP${last.status} ${last.message}`, calls };
}

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

async function runOne(job, refs, opts) {
  const started = Date.now();
  const result = { out: job.out, path: job.dest, ok: false, refs, alpha: job.alpha, calls: 0 };
  const finish = (extra) => Object.assign(result, extra, { seconds: Math.round((Date.now() - started) / 1000) });
  let prompt = buildPrompt(job.prompt, { alpha: job.alpha, prefix: opts.prefix });
  const rounds = job.alpha ? 2 : 1;
  for (let round = 1; round <= rounds; round++) {
    const got = await generate(prompt, refs, { ...opts, label: job.dest });
    result.calls += got.calls;
    if (!got.ok) return finish({ error: got.error });
    const info = pngInfo(got.bytes);
    Object.assign(result, { width: info.width, height: info.height, mode: info.mode, revisedPrompt: got.revisedPrompt });
    if (!job.alpha) {
      writeFile(job.dest, got.bytes);
      return finish({ ok: true });
    }
    const stats = alphaStats(got.bytes);
    if (stats) result.transparentPct = Math.round((1000 * stats.transparent) / stats.total) / 10;
    if (stats && stats.transparent > 0 && stats.visible > 0) {
      writeFile(job.dest, got.bytes);
      return finish({ ok: true });
    }
    if (round === rounds) {
      const rejected = job.dest.replace(/\.png$/i, '') + '.alpha-fail.png';
      writeFile(rejected, got.bytes);
      return finish({ rejected, error: stats ? `alpha: ${info.mode}, no transparent pixels after a regeneration` : `alpha: cannot read ${info.mode} ${info.bitDepth}-bit PNG` });
    }
    prompt = `${prompt} ${ALPHA_RETRY}`;
  }
  return finish({ error: 'unreachable' });
}

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Run planned jobs; a job whose ref is another job's out starts after it, with that job's file. */
export async function runJobs(jobs, opts) {
  const o = {
    model: DEFAULT_MODEL,
    attempts: DEFAULT_ATTEMPTS,
    concurrency: DEFAULT_CONCURRENCY,
    backoffMs: BACKOFF_MS,
    timeoutMs: CALL_TIMEOUT_MS,
    prefix: '',
    fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: null,
    ...opts,
  };
  const limit = limiter(Math.max(1, o.concurrency));
  const settled = new Map();
  const promiseOf = (i) => {
    if (!settled.has(i)) settled.set(i, start(jobs[i]));
    return settled.get(i);
  };
  const resolveRefs = async (job) => {
    const refs = [];
    for (const r of job.refs) {
      const dep = jobs.find((j) => j.out === r && j.index !== job.index);
      if (!dep) {
        refs.push(r);
        continue;
      }
      const res = await promiseOf(dep.index);
      if (!res.ok) return { failedRef: r };
      refs.push(res.path);
    }
    return { refs };
  };
  const start = async (job) => {
    const { refs, failedRef } = await resolveRefs(job);
    const res = failedRef
      ? { out: job.out, path: job.dest, ok: false, refs: job.refs, alpha: job.alpha, calls: 0, seconds: 0, error: `ref job failed: ${failedRef}` }
      : await limit(() => runOne(job, refs, o));
    o.log?.(res.ok ? `ok   ${res.path} ${res.width}x${res.height} ${res.mode} ${res.seconds}s calls=${res.calls}` : `FAIL ${res.path} — ${res.error}`);
    return res;
  };
  return Promise.all(jobs.map((j) => promiseOf(j.index)));
}

/** Codex image models OmniRoute serves, and (probe) the image model the Codex backend pins. */
export async function check({ base, key, keySource, probe = false, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch }) {
  const result = { ok: false, base, keySource, models: [], pinned: null };
  if (!key) return { ...result, error: 'no OmniRoute key (OMNIROUTE_API_KEY or ~/.codex/config.toml omniroute provider)' };
  try {
    const res = await fetchImpl(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    if (res.status !== 200) return { ...result, error: `GET /v1/models HTTP${res.status} ${json?.error?.message || ''}`.trim() };
    result.models = (json.data || []).map((m) => m.id).filter((id) => /^codex\/.*-image$/.test(id));
  } catch (e) {
    return { ...result, error: `OmniRoute unreachable at ${base}: ${e?.message || e}` };
  }
  if (!result.models.length) return { ...result, error: 'OmniRoute lists no codex/*-image model (Codex provider disconnected?)' };
  result.ok = true;
  if (!probe) return result;
  const textModel = model.replace(/-image$/, '');
  try {
    const res = await fetchImpl(`${base}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: textModel,
        instructions: 'Call image_generation exactly once.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'a small red toy brick on white' }] }],
        tools: [{ type: 'image_generation' }],
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    result.pinned = pinnedModel(await res.text());
    if (!result.pinned) result.probeError = `no image_generation tool echo in the /v1/responses stream (HTTP${res.status})`;
  } catch (e) {
    result.probeError = String(e?.message || e);
  }
  return result;
}

/** The image model echoed in a Responses stream's response.completed tools list. */
export function pinnedModel(sse) {
  for (const line of String(sse).split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev;
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (ev?.type !== 'response.completed') continue;
    const tool = (ev.response?.tools || []).find((t) => t.type === 'image_generation');
    if (tool?.model) return tool.model;
  }
  return null;
}

const USAGE = `usage:
  codex-image.mjs check [--probe] [--json]
  codex-image.mjs gen --prompt "<text>" --out <file.png> [--ref <png>]... [--alpha] [options]
  codex-image.mjs gen --jobs <jobs.json> [options]
options: --prefix-file <txt> --concurrency ${DEFAULT_CONCURRENCY} --attempts ${DEFAULT_ATTEMPTS} --model ${DEFAULT_MODEL} --overwrite --report <json> --json`;

export function parseArgs(argv) {
  const out = { cmd: argv[0], refs: [], alpha: false, overwrite: false, json: false, probe: false, concurrency: DEFAULT_CONCURRENCY, attempts: DEFAULT_ATTEMPTS, model: DEFAULT_MODEL };
  const num = (v, name) => {
    const n = Number.parseInt(v, 10);
    if (!(n > 0)) throw new Error(`${name} needs a positive number`);
    return n;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--json') out.json = true;
    else if (a === '--probe') out.probe = true;
    else if (a === '--alpha') out.alpha = true;
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--prompt') out.prompt = val();
    else if (a === '--out') out.out = val();
    else if (a === '--ref') out.refs.push(val());
    else if (a === '--jobs') out.jobs = val();
    else if (a === '--prefix-file') out.prefixFile = val();
    else if (a === '--report') out.report = val();
    else if (a === '--model') out.model = val();
    else if (a === '--concurrency') out.concurrency = num(val(), a);
    else if (a === '--attempts') out.attempts = num(val(), a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['check', 'gen'].includes(out.cmd)) throw new Error('first argument must be check or gen');
  if (out.cmd === 'gen' && !out.jobs && !(out.prompt && out.out)) throw new Error('gen needs --jobs, or --prompt and --out');
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`codex-image: ${e.message}\n${USAGE}`);
    return EXIT.usage;
  }
  const endpoint = resolveEndpoint();
  const log = args.json ? (s) => console.error(s) : (s) => console.log(s);
  if (args.cmd === 'check') {
    const r = await check({ ...endpoint, probe: args.probe, model: args.model });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(r.ok ? `ok   OmniRoute ${r.base} (key: ${r.keySource}) · ${r.models.join(', ')}` : `FAIL ${r.error}`);
      if (args.probe) console.log(r.pinned ? `     pinned image model: ${r.pinned}` : `     probe: ${r.probeError}`);
    }
    return r.ok ? EXIT.ok : EXIT.unavailable;
  }
  let raw;
  try {
    raw = args.jobs ? JSON.parse(fs.readFileSync(args.jobs, 'utf8')) : [{ prompt: args.prompt, out: args.out, ref: args.refs, alpha: args.alpha }];
  } catch (e) {
    console.error(`codex-image: cannot read jobs: ${e.message}`);
    return EXIT.usage;
  }
  const { jobs, problems } = planJobs(Array.isArray(raw) ? raw : raw?.jobs, { overwrite: args.overwrite });
  if (problems.length) {
    console.error(`codex-image: invalid jobs\n- ${problems.join('\n- ')}`);
    return EXIT.usage;
  }
  const avail = await check(endpoint);
  if (!avail.ok) {
    console.error(`codex-image: ${avail.error}`);
    return EXIT.unavailable;
  }
  const prefix = args.prefixFile ? fs.readFileSync(args.prefixFile, 'utf8') : '';
  log(`codex-image: ${jobs.length} job(s) · ${args.model} · concurrency ${Math.min(args.concurrency, jobs.length)}`);
  const results = await runJobs(jobs, { ...endpoint, model: args.model, attempts: args.attempts, concurrency: args.concurrency, prefix, log });
  const failed = results.filter((r) => !r.ok).length;
  const report = { model: args.model, ok: results.length - failed, failed, results };
  if (args.report) writeFile(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else log(`codex-image: ${report.ok} ok, ${failed} failed${args.report ? ` · report ${path.resolve(args.report)}` : ''}`);
  return failed ? EXIT.failed : EXIT.ok;
}

// run as a script — also through a symlinked skills dir (import.meta.url is the resolved path)
const self = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (self) process.exitCode = await main(process.argv.slice(2));
