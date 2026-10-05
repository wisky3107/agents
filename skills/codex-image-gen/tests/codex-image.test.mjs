import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALPHA_CONTRACT,
  alphaStats,
  buildPrompt,
  check,
  nextFreePath,
  parseCodexConfig,
  pinnedModel,
  planJobs,
  pngInfo,
  resolveEndpoint,
  retryable,
  runJobs,
} from '../scripts/codex-image.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/codex-image.mjs', import.meta.url));
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGB / RGBA PNG; row y uses filter y % 5 so the decoder meets every filter type. */
function encodePng(w, h, pixel, { alpha = true } = {}) {
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) pixel(x, y).slice(0, bpp).forEach((v, k) => (cur[x * bpp + k] = v));
    const f = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i + 1] = (cur[i] - p) & 255;
    }
    rows.push(out);
    prev = cur;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
// Left 4 columns transparent, the rest a gradient with varied alpha.
const cutout = (seed = 0) => encodePng(13, 11, (x, y) => [(x * 37 + seed) & 255, (y * 53) & 255, (x * y + seed) & 255, x < 4 ? 0 : 128 + ((x + y) % 2) * 127]);
const opaque = (seed = 0) => encodePng(9, 7, (x, y) => [250, (x + seed) & 255, 251], { alpha: false });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-'));

test('pngInfo and alphaStats decode every filter type', () => {
  const png = cutout();
  assert.deepEqual(pngInfo(png), { width: 13, height: 11, bitDepth: 8, colorType: 6, mode: 'RGBA', interlace: 0 });
  assert.deepEqual(alphaStats(png), { transparent: 44, visible: 99, total: 143 });
  assert.deepEqual(alphaStats(opaque()), { transparent: 0, visible: 63, total: 63 });
  assert.equal(pngInfo(Buffer.from('not a png at all, really not one')), null);
  assert.equal(alphaStats(Buffer.from('GIF89a')), null);
});

test('nextFreePath never reuses a file on disk or a path taken in this run', () => {
  const dir = tmp();
  const a = path.join(dir, 'a.png');
  assert.equal(nextFreePath(a), a);
  fs.writeFileSync(a, 'x');
  assert.equal(nextFreePath(a), path.join(dir, 'a-2.png'));
  assert.equal(nextFreePath(a, new Set([path.join(dir, 'a-2.png')])), path.join(dir, 'a-3.png'));
});

test('endpoint: env wins, then the omniroute table of the Codex config', () => {
  const toml = [
    'model_provider = "omniroute"',
    '[model_providers.other]',
    'base_url = "http://wrong"',
    '[model_providers.omniroute]',
    'name = "Omniroute"',
    'base_url = "http://localhost:20128/v1"',
    'experimental_bearer_token = "sk-cfg"',
    '[profiles.x]',
    'base_url = "http://also-wrong"',
  ].join('\n');
  assert.deepEqual(parseCodexConfig(toml), { baseUrl: 'http://localhost:20128/v1', key: 'sk-cfg' });
  const file = path.join(tmp(), 'config.toml');
  fs.writeFileSync(file, toml);
  assert.deepEqual(resolveEndpoint({}, file), { base: 'http://localhost:20128', key: 'sk-cfg', keySource: 'codex-config' });
  assert.deepEqual(resolveEndpoint({ OMNIROUTE_BASE_URL: 'http://h:1/v1/', OMNIROUTE_API_KEY: 'sk-env' }, file), { base: 'http://h:1', key: 'sk-env', keySource: 'env' });
  assert.deepEqual(resolveEndpoint({}, path.join(tmp(), 'missing.toml')), { base: 'http://localhost:20128', key: '', keySource: 'none' });
});

test('retryable: transient errors and declined tool calls only', () => {
  assert.equal(retryable(502, 'Codex completed without producing an image_generation_call — the model may have declined the tool'), true);
  assert.equal(retryable(0, 'fetch failed'), true);
  assert.equal(retryable(429, ''), true);
  assert.equal(retryable(503, ''), true);
  assert.equal(retryable(400, 'Our servers are currently overloaded'), true);
  assert.equal(retryable(400, 'Prompt is required'), false);
  assert.equal(retryable(401, 'credentials missing'), false);
});

test('buildPrompt adds the alpha contract once and the art bible as a prefix', () => {
  assert.equal(buildPrompt('a coin', { alpha: true }), `a coin ${ALPHA_CONTRACT}`);
  assert.equal(buildPrompt('a coin on a transparent background', { alpha: true }), 'a coin on a transparent background');
  assert.equal(buildPrompt(' a coin ', { prefix: 'flat toy plastic\n' }), 'PROJECT ART BIBLE:\nflat toy plastic\n\na coin');
});

test('planJobs reports every problem up front and assigns unique destinations', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'front.png'), 'x');
  const { jobs, problems } = planJobs(
    [
      { out: 'front', prompt: 'front view' },
      { out: 'side.png', prompt: 'side view', ref: 'front.png' },
      { out: 'side.png', prompt: 'dup' },
      { out: 'x.png', prompt: '' },
      { out: 'y.png', prompt: 'y', ref: ['missing.png'] },
      { out: 'c1.png', prompt: 'c1', ref: 'c2.png' },
      { out: 'c2.png', prompt: 'c2', ref: 'c1.png' },
    ],
    { cwd: dir },
  );
  assert.equal(jobs[0].out, path.join(dir, 'front.png'));
  assert.equal(jobs[0].dest, path.join(dir, 'front-2.png'));
  assert.deepEqual(jobs[1].deps, [0]);
  assert.deepEqual(problems, [
    'job 4: prompt is required',
    `job 3: out ${path.join(dir, 'side.png')} repeats job 2`,
    `job 5: ref not found: ${path.join(dir, 'missing.png')}`,
    'ref cycle: job 6 → job 7 → job 6',
  ]);
  assert.deepEqual(planJobs([]).problems, ['no jobs']);
  assert.equal(planJobs([{ out: 'front.png', prompt: 'p' }], { cwd: dir, overwrite: true }).jobs[0].dest, path.join(dir, 'front.png'));
});

/** OmniRoute stand-in: prompts steer the reply; every request is recorded. */
async function mockOmniRoute() {
  const requests = [];
  const served = new Map();
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(parts);
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { data: [{ id: 'codex/gpt-5.6-terra-image' }, { id: 'codex/gpt-5.6-terra' }, { id: 'agy/gemini-3.1-flash-image' }] });
      }
      const edit = req.url === '/v1/images/edits';
      const text = raw.toString('latin1');
      const prompt = edit ? /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] || '' : JSON.parse(raw).prompt;
      const record = { url: req.url, prompt, auth: req.headers.authorization, imageFields: (text.match(/name="image(\[\])?"/g) || []).length, raw };
      requests.push(record);
      const nth = requests.filter((r) => r.prompt === prompt).length;
      if (prompt.includes('bad')) return send(400, { error: { message: 'invalid prompt' } });
      if (prompt.includes('flaky') && nth === 1) return send(502, { error: { message: 'Codex completed without producing an image_generation_call — the model may have declined the tool' } });
      let png;
      if (prompt.includes('sprite')) png = prompt.includes('previous result had no transparent') ? cutout(7) : opaque(7);
      else if (prompt.includes('matte')) png = opaque(9);
      else png = cutout(requests.length);
      served.set(prompt, png);
      send(200, { created: 1, data: [{ b64_json: png.toString('base64'), revised_prompt: `revised: ${prompt.slice(0, 20)}` }] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, served, close: () => new Promise((r) => server.close(r)) };
}

test('runJobs: retries, ref edits from a job in the same run, alpha regeneration, failures stay local', async () => {
  const mock = await mockOmniRoute();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'front.png'), 'old front');
  try {
    const { jobs, problems } = planJobs(
      [
        { out: 'side.png', prompt: 'side view from the front', ref: 'front.png' },
        { out: 'front.png', prompt: 'front view' },
        { out: 'flaky.png', prompt: 'flaky prop' },
        { out: 'bad.png', prompt: 'bad prop' },
        { out: 'after-bad.png', prompt: 'edit of bad', ref: 'bad.png' },
        { out: 'coin.png', prompt: 'sprite coin', alpha: true },
        { out: 'gem.png', prompt: 'matte gem', alpha: true },
      ],
      { cwd: dir },
    );
    assert.deepEqual(problems, []);
    const results = await runJobs(jobs, { base: mock.base, key: 'sk-test', backoffMs: 0, concurrency: 2 });
    const by = Object.fromEntries(results.map((r) => [path.basename(r.out), r]));

    assert.equal(by['front.png'].ok, true);
    assert.equal(by['front.png'].path, path.join(dir, 'front-2.png'));
    assert.equal(fs.readFileSync(path.join(dir, 'front.png'), 'utf8'), 'old front');

    const sideReq = mock.requests.find((r) => r.prompt === 'side view from the front');
    assert.equal(sideReq.url, '/v1/images/edits');
    assert.equal(sideReq.imageFields, 1);
    assert.ok(sideReq.raw.includes(fs.readFileSync(path.join(dir, 'front-2.png'))), 'edit carries the front made in this run');
    assert.equal(by['side.png'].ok, true);
    assert.equal(by['side.png'].revisedPrompt, 'revised: side view from the f');

    assert.equal(by['flaky.png'].ok, true);
    assert.equal(by['flaky.png'].calls, 2);
    assert.equal(by['bad.png'].ok, false);
    assert.equal(by['bad.png'].calls, 1);
    assert.match(by['bad.png'].error, /^HTTP400 invalid prompt/);
    assert.equal(by['after-bad.png'].ok, false);
    assert.equal(by['after-bad.png'].error, `ref job failed: ${path.join(dir, 'bad.png')}`);
    assert.equal(mock.requests.filter((r) => r.prompt === 'edit of bad').length, 0);

    assert.equal(by['coin.png'].ok, true);
    assert.equal(by['coin.png'].calls, 2);
    assert.equal(by['coin.png'].mode, 'RGBA');
    assert.equal(by['coin.png'].transparentPct, 30.8);
    assert.ok(mock.requests.filter((r) => r.prompt.startsWith('sprite coin')).every((r) => r.prompt.includes(ALPHA_CONTRACT)));

    assert.equal(by['gem.png'].ok, false);
    assert.equal(by['gem.png'].rejected, path.join(dir, 'gem.alpha-fail.png'));
    assert.ok(fs.existsSync(by['gem.png'].rejected));
    assert.ok(!fs.existsSync(path.join(dir, 'gem.png')));
    assert.ok(mock.requests.every((r) => r.auth === 'Bearer sk-test'));
  } finally {
    await mock.close();
  }
});

test('runJobs sends several refs as image[]', async () => {
  const mock = await mockOmniRoute();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.png'), cutout(1));
  fs.writeFileSync(path.join(dir, 'b.png'), cutout(2));
  try {
    const { jobs } = planJobs([{ out: 'ab.png', prompt: 'combine', ref: ['a.png', 'b.png'] }], { cwd: dir });
    const [r] = await runJobs(jobs, { base: mock.base, key: 'k', backoffMs: 0 });
    assert.equal(r.ok, true);
    assert.equal((mock.requests[0].raw.toString('latin1').match(/name="image\[\]"/g) || []).length, 2);
  } finally {
    await mock.close();
  }
});

test('check lists Codex image models; pinnedModel reads the tool echo', async () => {
  const mock = await mockOmniRoute();
  try {
    const r = await check({ base: mock.base, key: 'k', keySource: 'env' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, ['codex/gpt-5.6-terra-image']);
    assert.match((await check({ base: mock.base, key: '', keySource: 'none' })).error, /no OmniRoute key/);
  } finally {
    await mock.close();
  }
  const down = await check({ base: 'http://127.0.0.1:9', key: 'k', keySource: 'env' });
  assert.equal(down.ok, false);
  assert.match(down.error, /OmniRoute unreachable/);
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"tools":[{"type":"image_generation","model":"gpt-image-2.5-sunburst"}]}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"tools":[{"type":"image_generation","model":"gpt-image-2-codex","size":"auto"}]}}',
  ].join('\n');
  assert.equal(pinnedModel(sse), 'gpt-image-2-codex');
  assert.equal(pinnedModel('data: {"type":"response.failed"}'), null);
});

const run = (args, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

test('CLI exit codes: 0 ok, 2 unavailable, 64 usage / invalid jobs', async () => {
  const mock = await mockOmniRoute();
  const dir = tmp();
  try {
    const env = { OMNIROUTE_BASE_URL: mock.base, OMNIROUTE_API_KEY: 'k' };
    const out = path.join(dir, 'one.png');
    const ok = await run(['gen', '--prompt', 'a red brick', '--out', out, '--json'], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, 1);
    assert.ok(pngInfo(fs.readFileSync(out)));

    const jobsFile = path.join(dir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify({ jobs: [{ out: path.join(dir, 'z.png'), prompt: 'z', ref: path.join(dir, 'nope.png') }] }));
    const invalid = await run(['gen', '--jobs', jobsFile], env);
    assert.equal(invalid.code, 64);
    assert.match(invalid.stderr, /ref not found/);

    assert.equal((await run(['gen', '--out', out], env)).code, 64);
    assert.equal((await run(['check'], { OMNIROUTE_BASE_URL: 'http://127.0.0.1:9', OMNIROUTE_API_KEY: 'k' })).code, 2);
    assert.equal((await run(['check'], env)).code, 0);
  } finally {
    await mock.close();
  }
});
