#!/usr/bin/env node
/**
 * Find and measure the moments in a gameplay video from decoded signals, not from a model's guess.
 *
 *   node video-probe.mjs fetch    <url> --out <dir> [--height 720] [--name <stem>]
 *   node video-probe.mjs signals  <video> --out <dir> [--fps 15] [--grid 4x8] [--k 6]
 *   node video-probe.mjs strips   <video> --out <dir> [--ids 3,7 | --top 40]
 *   node video-probe.mjs zoom     <video> --at <sec> --dur <sec> --out <file.jpg> [--fps <n>] [--region x0,y0,x1,y1]
 *   node video-probe.mjs overview <video> --out <dir> [--step 5]
 *   node video-probe.mjs track    <video> --at <sec> --box x0,y0,x1,y1 --out <dir> [--dur 3] [--band 0.15,0.72]
 *                                 [--mode auto|hop|move] [--cell <px>] [--react x0,y0,x1,y1]
 *   every command but fetch: [--crop auto | x,y,w,h]  (signals saves the crop; strips reuses it)
 *
 * fetch: a video URL (YouTube, TikTok, a store page, a direct .mp4 link) to <dir>/<id>.mp4 through yt-dlp, capped at
 *   --height, with url / title / duration in <dir>/<id>.source.json. An existing file is reused.
 * signals: one decode at --fps into a small gray frame split into a grid. A frame is active when a cell,
 *   the whole frame, or the brightness moves well above its ±6 s baseline; active frames merge into
 *   candidates. Audio onsets (high-passed energy jumps) attach to the candidate they fall in.
 *   Writes <dir>/signals.json and <dir>/candidates.{json,md}.
 * strips: per candidate, a tile strip (<= 40 frames, row-major, times in the sidecar) plus a
 *   native-fps motion span measured inside the candidate's region: <dir>/strips/cNNN.{jpg,json}.
 * zoom / overview: the same strip for any window, and 15x5 contact sheets every --step seconds.
 * track: follows one object (--box, screen fractions on the frame at --at) by NCC and removes the camera pan
 *   (block matching in the --band rows, outside the object) to get its board path. Hops are cut on a landing
 *   clock (motion, audio onsets, or a regular grid through them) and fitted jointly: ground easing, arc
 *   height and shape, landing squash, camera follow lag. With fewer than three landings (or --mode move) the path is
 *   cut into moves at stops instead: start / stop times, speed (px/s, cells/s with --cell), easing, or the smooth tail
 *   of a move that ends out of sight. An object sliding under something is followed by its trailing part (clipped),
 *   and once nothing of it is left it is gone for the rest of the window, never swapped for a look-alike. --react
 *   follows a second box (a gate, a bumper) for its knock-back. Writes <dir>/track.{json,md,jpg}.
 * --crop auto finds the sharp area of a phone recording pillarboxed in a landscape frame (blurred or black bars);
 *   boxes and regions are then fractions of the cropped frame.
 * Needs ffmpeg + ffprobe on PATH (fetch also yt-dlp); no npm dependencies.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const W = 64, TILE_W = 120, MAX_TILES = 40, GAP_S = 0.3, BASE_WIN_S = 6, FLOOR = 4;
const die = m => { console.error(`video-probe: ${m}`); process.exit(1); };
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) o._.push(argv[i]);
    else { const k = argv[i].slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return o;
}
function probe(video) {
  if (!fs.existsSync(video)) die(`missing video: ${video}`);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:format=duration', '-of', 'json', video], { encoding: 'utf8' });
  if (r.status !== 0) die(`ffprobe failed: ${r.stderr || r.error}`);
  const j = JSON.parse(r.stdout), v = j.streams.find(s => s.codec_type === 'video');
  if (!v) die('no video stream');
  const [n, d] = v.avg_frame_rate.split('/').map(Number);
  return { width: v.width, height: v.height, fps: d ? n / d : n, duration: Number(j.format.duration), audio: j.streams.some(s => s.codec_type === 'audio') };
}
// A phone recording pillarboxed in a landscape frame has bars that are a blurred (or black) copy of the game. Over a
// few frames spread through the video, the sharp core is the longest run of columns with high vertical-gradient
// energy (flat margins of the game can fall outside it); the phone's edge is then the outermost thin line (a column
// where most rows step sharply, not its neighbours two away) within 30 % of the core's width beyond it. Rows the same way
// inside those columns.
async function detectCrop(video, info) {
  const { width: w, height: h } = info, frames = [];
  for (let j = 0; j < 8; j++) await rawFrames(['-ss', String(r3(info.duration * (j + 0.5) / 8)), '-i', video, '-frames:v', '1', '-an', '-vf', 'format=gray', '-f', 'rawvideo', '-'], w * h, f => frames.push(Buffer.from(f)));
  const axis = (e, line) => {
    const n = e.length, s = Float64Array.from(e, (_, i) => { let a = 0, c = 0; for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) { a += e[k]; c++; } return a / c; });
    const lo = quantile(s, 0.05), hi = quantile(s, 0.95), thr = lo + 0.3 * (hi - lo), gap = Math.round(0.02 * n);
    let run = [0, n];
    for (let i = 0, best = -1; i < n; i++) {
      if (s[i] <= thr) continue;
      let j = i;
      for (let k = i, miss = 0; k < n && miss <= gap; k++) if (s[k] > thr) { j = k; miss = 0; } else miss++;
      if (j - i > best) { best = j - i; run = [i, j + 1]; }
      i = j;
    }
    const inside = median(Array.from(s.slice(run[0], run[1]))), outside = median([...s.slice(0, run[0]), ...s.slice(run[1])]), contrast = inside / Math.max(1e-6, outside);
    // Bars are flat next to the game: a busy full-frame video with a quiet status strip is not cropped.
    if (n - (run[1] - run[0]) < 0.05 * n || contrast < 4) return { run: [0, n], contrast: null };
    const isLine = x => x >= 2 && x < n - 2 && line[x] >= 0.4 && line[x] >= 3 * Math.max(line[x - 2], line[x + 2]), reach = Math.round(0.3 * (run[1] - run[0]));
    let [a, b] = run;
    for (let x = Math.max(2, a - reach); x < a; x++) if (isLine(x)) { a = x + 1; break; }
    for (let x = Math.min(n - 3, b + reach); x >= b; x--) if (isLine(x)) { b = x + 1; break; }
    return { run: [a, b], core: run, contrast: r2(contrast) };
  };
  // Per column: vertical-gradient energy, and the share of rows with a sharp horizontal step to the next column.
  const col = new Float64Array(w), colLine = new Float64Array(w);
  for (const f of frames) for (let y = 0; y + 1 < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    col[x] += Math.abs(f[p + w] - f[p]);
    if (x + 1 < w && Math.abs(f[p + 1] - f[p]) > 6) colLine[x] += 1 / (h * frames.length);
  }
  const X = axis(col, colLine), [x0, x1] = X.run, row = new Float64Array(h), rowLine = new Float64Array(h);
  for (const f of frames) for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) {
    const p = y * w + x;
    if (x + 1 < x1) row[y] += Math.abs(f[p + 1] - f[p]);
    if (y + 1 < h && Math.abs(f[p + w] - f[p]) > 6) rowLine[y] += 1 / ((x1 - x0) * frames.length);
  }
  const Y = axis(row, rowLine), [y0, y1] = Y.run;
  if (!X.contrast && !Y.contrast) return null;
  const cx = x0 + (x0 & 1), cy = y0 + (y0 & 1);
  return { x: cx, y: cy, w: (x1 - cx) & ~1, h: (y1 - cy) & ~1, auto: true, contrast: [X.contrast, Y.contrast] };
}
// probe() plus the crop: every later size is the cropped one, and vf() puts the crop first in each filter chain.
async function setup(video, o, saved = null) {
  const info = probe(video);
  let c = saved;
  if (o.crop === 'auto' || o.crop === true) c = await detectCrop(video, info);
  else if (typeof o.crop === 'string') {
    const [x, y, cw, ch] = o.crop.split(',').map(Number);
    if (!(cw > 0 && ch > 0 && x >= 0 && y >= 0 && x + cw <= info.width && y + ch <= info.height)) die(`bad --crop ${o.crop} (x,y,w,h in source pixels)`);
    c = { x, y, w: cw, h: ch };
  }
  return c ? { ...info, width: c.w, height: c.h, source: [info.width, info.height], crop: c } : info;
}
const vf = (info, chain) => info.crop ? `crop=${info.crop.w}:${info.crop.h}:${info.crop.x}:${info.crop.y},${chain}` : chain;
function ffmpeg(a, onChunk) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', onChunk || (() => {}));
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(Error(`ffmpeg exited ${code}: ${err.slice(-400)}`)));
  });
}
// onFrame gets one reused buffer; copy it to keep it.
async function rawFrames(a, size, onFrame) {
  const frame = Buffer.alloc(size);
  let have = 0, n = 0;
  await ffmpeg(a, c => {
    for (let o = 0; o < c.length;) {
      const k = Math.min(size - have, c.length - o);
      c.copy(frame, have, o, o + k); have += k; o += k;
      if (have === size) { onFrame(frame, n++); have = 0; }
    }
  });
  return n;
}
function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort(), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(a, q) {
  const s = Float64Array.from(a).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
}
// Median per second, then the median of those over ±win seconds: ambient motion without the bursts.
function baseline(series, per, win) {
  const b = [];
  for (let i = 0; i < series.length; i += per) b.push(median(series.slice(i, i + per)));
  const s = b.map((_, k) => median(b.slice(Math.max(0, k - win), k + win + 1)));
  return i => s[Math.min(s.length - 1, Math.floor(i / per))];
}
function robustThreshold(x, k) {
  const m = median(x), mad = median(Array.from(x, v => Math.abs(v - m)));
  return m + k * 1.4826 * mad;
}
function gridFor(o, h) {
  const g = typeof o.grid === 'string' ? o.grid : h >= W ? '4x8' : '8x4';
  const [cols, rows] = g.split('x').map(Number);
  if (!(cols > 0 && rows > 0)) die(`bad --grid ${g}`);
  return { cols, rows };
}
function regionName(box) {
  const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (x1 - x0 > 0.7 && y1 - y0 > 0.7) return 'full';
  return `${cy < 0.33 ? 'top' : cy > 0.67 ? 'bottom' : 'middle'}-${cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'center'}`;
}

async function audioOnsets(video) {
  const SR = 22050, HOP = 256, WIN = 512, HIST = Math.round(0.4 * SR / HOP), NEAR = Math.round(0.05 * SR / HOP);
  const chunks = [];
  await ffmpeg(['-i', video, '-vn', '-ac', '1', '-ar', String(SR), '-af', 'highpass=f=1200', '-f', 's16le', '-'], c => chunks.push(c));
  const pcm = Buffer.concat(chunks), x = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
  const e = [];
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    let a = 0;
    for (let k = 0; k < WIN; k++) a += x[s + k] * x[s + k];
    e.push(10 * Math.log10(a / WIN + 1));
  }
  const quiet = Float64Array.from(e).sort()[Math.floor(e.length * 0.3)] || 0;
  const rise = e.map((v, t) => t < HIST ? 0 : v - median(e.slice(t - HIST, t)));
  const out = [];
  for (let t = HIST; t < e.length; t++) {
    if (rise[t] < 10 || e[t] <= quiet) continue;
    let peak = true;
    for (let k = Math.max(0, t - NEAR); k <= Math.min(e.length - 1, t + NEAR) && peak; k++) if (rise[k] > rise[t]) peak = false;
    if (peak) out.push({ t: r3((t * HOP + WIN / 2) / SR), db: r2(e[t]), rise: r2(rise[t]) });
  }
  return out;
}

async function signals(video, o) {
  const info = await setup(video, o), F = Number(o.fps || 15), K = Number(o.k || 6), floor = Number(o.floor || FLOOR);
  const H = Math.max(8, Math.round(W * info.height / info.width)), { cols, rows } = gridFor(o, H), C = cols * rows;
  const cellOf = new Uint16Array(W * H), cellN = new Float64Array(C);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = Math.min(rows - 1, Math.floor(y * rows / H)) * cols + Math.min(cols - 1, Math.floor(x * cols / W));
    cellOf[y * W + x] = c; cellN[c]++;
  }
  const luma = [], gd = [], cd = [];
  let prev = null;
  await rawFrames(['-i', video, '-an', '-vf', vf(info, `fps=${F},scale=${W}:${H}:flags=area,format=gray`), '-f', 'rawvideo', '-'], W * H, f => {
    let s = 0, d = 0;
    const cs = new Float64Array(C);
    for (let p = 0; p < f.length; p++) {
      s += f[p];
      if (prev) { const a = Math.abs(f[p] - prev[p]); d += a; cs[cellOf[p]] += a; }
    }
    luma.push(s / f.length); gd.push(prev ? d / f.length : 0);
    cd.push(Float32Array.from(cs, (v, c) => v / cellN[c]));
    prev = Buffer.from(f);
  });
  const N = luma.length, half = Math.round(F / 2), gap = Math.round(GAP_S * F);
  if (N < F * 2) die('video too short to analyse');
  // Scores are in units of the series' own local spread, so a busy cell must move more to count.
  const zScore = series => {
    const base = baseline(series, F, BASE_WIN_S), spread = baseline(Array.from(series, (v, i) => Math.abs(v - base(i))), F, BASE_WIN_S);
    return Array.from(series, (v, i) => (v - base(i)) / Math.max(floor, spread(i)));
  };
  const cz = Array.from({ length: C }, (_, c) => zScore(cd.map(r => r[c])));
  const excess = cd.map((_, i) => Float32Array.from(cz, s => s[i]));
  const local = excess.map(r => Math.max(...r)), glob = zScore(gd);
  const step = luma.map((v, i) => v - luma[Math.max(0, i - half)]);
  const T = { local: K, global: K, brightness: 20 };
  const active = i => local[i] > T.local || glob[i] > T.global || Math.abs(step[i]) > T.brightness;
  const onsets = info.audio ? await audioOnsets(video) : [];

  const spans = [];
  for (let i = 1; i < N; i++) {
    if (!active(i)) continue;
    const last = spans[spans.length - 1];
    if (last && i - last[1] <= gap) last[1] = i; else spans.push([i, i]);
  }
  const lumaAt = (a, b) => median(luma.slice(Math.max(0, a), Math.max(0, Math.min(N, b))));
  const candidates = spans.map(([a, b], n) => {
    let peak = a;
    for (let i = a; i <= b; i++) if (local[i] + glob[i] > local[peak] + glob[peak]) peak = i;
    const hot = [];
    for (let c = 0; c < C; c++) { let m = 0; for (let i = a; i <= b; i++) m = Math.max(m, excess[i][c]); if (m > T.local / 2) hot.push(c); }
    const cells = hot.length ? hot : [...excess[peak].keys()].filter(c => excess[peak][c] > 0);
    const xs = cells.map(c => c % cols), ys = cells.map(c => Math.floor(c / cols));
    const box = cells.length ? [Math.min(...xs) / cols, Math.min(...ys) / rows, (Math.max(...xs) + 1) / cols, (Math.max(...ys) + 1) / rows].map(r3) : [0, 0, 1, 1];
    const t0 = (a - 1) / F, t1 = b / F, before = lumaAt(a - half, a), after = lumaAt(b + 1, b + 1 + half);
    const segLuma = luma.slice(a, b + 1), kind = [];
    for (let i = a; i <= b; i++) if (gd[i] > 25 && gd[i] > 3 * Math.max(gd[i - 1] || 0, gd[i + 1] || 0)) { kind.push('cut'); break; }
    if (after - before < -T.brightness) kind.push('dim');
    if (after - before > T.brightness) kind.push('brighten');
    if (Math.max(...segLuma) > 200 && Math.max(...segLuma) - before > 40) kind.push('whiteout');
    kind.push(cells.length / C <= 0.25 ? 'local' : cells.length / C >= 0.6 ? 'wide' : 'regional');
    const sfx = onsets.filter(x => x.t >= t0 - 0.15 && x.t <= t1 + 0.1);
    if (sfx.length) kind.push('sfx');
    const score = r2(local[peak] / T.local + Math.max(0, glob[peak]) / T.global + Math.abs(after - before) / T.brightness + Math.min(3, sfx.length) * 0.5);
    return { id: n + 1, t0: r2(t0), t1: r2(t1), dur_ms: Math.round((t1 - t0) * 1000), peak_t: r2(peak / F), score, kind,
      region: { box, name: regionName(box), area: r2(cells.length / C) },
      luma: { before: Math.round(before), after: Math.round(after), min: Math.round(Math.min(...segLuma)), max: Math.round(Math.max(...segLuma)) }, sfx };
  });

  fs.mkdirSync(o.out, { recursive: true });
  const meta = { video: path.resolve(video), ...info, analysis: { fps: F, width: W, height: H, grid: `${cols}x${rows}`, k: K, thresholds: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, r2(v)])) } };
  fs.writeFileSync(path.join(o.out, 'signals.json'), JSON.stringify({ meta, curves: { t0: 0, dt: r3(1 / F), luma: luma.map(r2), global: glob.map(r2), local: local.map(r2), brightness_step: step.map(r2) }, onsets }) + '\n');
  fs.writeFileSync(path.join(o.out, 'candidates.json'), JSON.stringify({ meta, candidates }, null, 1) + '\n');
  const covered = candidates.reduce((s, c) => s + c.t1 - c.t0, 0);
  fs.writeFileSync(path.join(o.out, 'candidates.md'), [
    `# Candidates — ${path.basename(video)}`, '',
    `${candidates.length} candidates covering ${covered.toFixed(0)} s of ${info.duration.toFixed(0)} s. ${onsets.length} audio onsets.`,
    `Times are measured from decoded frames at ${F} fps (±${Math.round(1000 / F)} ms); region is the fraction box [x0,y0,x1,y1] of the screen.`, '',
    '| id | t0–t1 (s) | ms | peak | score | kind | region | luma before→after | sfx |', '|---|---|---|---|---|---|---|---|---|',
    ...candidates.map(c => `| ${c.id} | ${c.t0}–${c.t1} | ${c.dur_ms} | ${c.peak_t} | ${c.score} | ${c.kind.join(' ')} | ${c.region.name} ${c.region.box.join(',')} | ${c.luma.before}→${c.luma.after} | ${c.sfx.map(x => x.t).join(' ')} |`),
  ].join('\n') + '\n');
  return { ok: true, out: o.out, crop: info.crop || null, candidates: candidates.length, covered_s: Math.round(covered), onsets: onsets.length, thresholds: meta.analysis.thresholds };
}

// Region motion at native fps; the span is the burst around the peak, with a ±2 s context as baseline.
async function measure(video, info, a, b, box) {
  const fps = Math.round(info.fps * 1000) / 1000, H = Math.max(8, Math.round(W * info.height / info.width)), ctx0 = Math.max(0, a - 2);
  const [x0, y0, x1, y1] = box, cw = Math.max(2, Math.round((x1 - x0) * W)), ch = Math.max(2, Math.round((y1 - y0) * H));
  const cx = Math.min(W - cw, Math.round(x0 * W)), cy = Math.min(H - ch, Math.round(y0 * H));
  const d = [];
  let prev = null;
  await rawFrames(['-ss', String(ctx0), '-i', video, '-t', String(b + 2 - ctx0), '-an', '-vf', vf(info, `fps=${fps},scale=${W}:${H}:flags=area,crop=${cw}:${ch}:${cx}:${cy},format=gray`), '-f', 'rawvideo', '-'], cw * ch, f => {
    let s = 0;
    if (prev) for (let p = 0; p < f.length; p++) s += Math.abs(f[p] - prev[p]);
    d.push(prev ? s / f.length : 0);
    prev = Buffer.from(f);
  });
  const t = i => ctx0 + i / fps, inWin = [...d.keys()].filter(i => t(i) >= a && t(i) <= b);
  if (!inWin.length) return null;
  const base = median(d), peak = inWin.reduce((p, i) => d[i] > d[p] ? i : p, inWin[0]), thr = base + Math.max(2, 0.25 * (d[peak] - base));
  let s = peak, e = peak;
  for (let i = peak - 1, miss = 0; i >= 0 && miss <= 2; i--) if (d[i] > thr) { s = i; miss = 0; } else miss++;
  for (let i = peak + 1, miss = 0; i < d.length && miss <= 2; i++) if (d[i] > thr) { e = i; miss = 0; } else miss++;
  return { fps, base: r2(base), peak: r2(d[peak]), threshold: r2(thr), peak_t: r3(t(peak)), start_t: r3(t(s - 1)), end_t: r3(t(e)), duration_ms: Math.round((e - s + 1) / fps * 1000),
    clipped: t(s - 1) <= a || t(e) >= b, curve: inWin.map(i => [r3(t(i)), r2(d[i])]) };
}
async function stripImage(video, info, a, b, file, cols = 10, fpsWanted) {
  const fps = r3(Math.min(fpsWanted || info.fps, info.fps, MAX_TILES / (b - a))), n = Math.max(1, Math.round((b - a) * fps)), rows = Math.ceil(n / cols);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg(['-y', '-ss', String(a), '-i', video, '-t', String(b - a), '-an', '-vf', vf(info, `fps=${fps},scale=${TILE_W}:-2,pad=iw+4:ih+4:2:2:red,tile=${cols}x${rows}:nb_frames=${n}`), '-frames:v', '1', '-q:v', '3', file]);
  return { file, fps, cols, rows, tiles: Array.from({ length: n }, (_, k) => r3(a + k / fps)) };
}
async function strips(video, o) {
  const { meta, candidates } = JSON.parse(fs.readFileSync(path.join(o.out, 'candidates.json'), 'utf8')), info = await setup(video, o, meta.crop);
  const ids = typeof o.ids === 'string' ? new Set(o.ids.split(',').map(Number)) : null;
  const picked = ids ? candidates.filter(c => ids.has(c.id)) : [...candidates].sort((x, y) => y.score - x.score).slice(0, Number(o.top || 40)).sort((x, y) => x.id - y.id);
  const rows = [];
  for (const c of picked) {
    const a = Math.max(0, c.t0 - 0.4), b = Math.min(info.duration, c.t1 + 0.4), name = `c${String(c.id).padStart(3, '0')}`;
    const img = await stripImage(video, info, a, b, path.join(o.out, 'strips', `${name}.jpg`));
    const m = await measure(video, info, a, b, c.region.box);
    fs.writeFileSync(path.join(o.out, 'strips', `${name}.json`), JSON.stringify({ candidate: c, strip: img, motion: m }, null, 1) + '\n');
    rows.push(`| ${c.id} | ${c.t0}–${c.t1} | ${c.kind.join(' ')} | ${c.region.name} | ${m ? `${m.start_t}–${m.end_t} (${m.duration_ms} ms${m.clipped ? ', clipped' : ''})` : '–'} | ${img.fps} fps, tile k = ${r3(a)} + k/${img.fps} | strips/${name}.jpg |`);
  }
  fs.writeFileSync(path.join(o.out, 'strips.md'), ['# Strips', '', 'Tiles are row-major. Motion span is measured at native fps inside the candidate region.', '',
    '| id | candidate (s) | kind | region | motion span (s) | tile times | image |', '|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n');
  return { ok: true, strips: picked.length, index: path.join(o.out, 'strips.md') };
}
async function zoom(video, o) {
  const info = await setup(video, o), a = Number(o.at), dur = Number(o.dur || 1.5);
  if (!Number.isFinite(a) || typeof o.out !== 'string') die('zoom needs --at <sec> --out <file.jpg>');
  const b = Math.min(info.duration, a + dur), img = await stripImage(video, info, a, b, o.out, Number(o.cols || 10), o.fps && Number(o.fps));
  const box = typeof o.region === 'string' ? o.region.split(',').map(Number) : [0, 0, 1, 1];
  const motion = await measure(video, info, a, b, box);
  fs.writeFileSync(o.out.replace(/\.jpg$/i, '') + '.json', JSON.stringify({ strip: img, region: box, motion }, null, 1) + '\n');
  return { ok: true, crop: info.crop || null, ...img, tiles: img.tiles.length, motion: motion && { start_t: motion.start_t, end_t: motion.end_t, duration_ms: motion.duration_ms, clipped: motion.clipped } };
}
async function fetchUrl(url, o) {
  if (!/^https?:\/\//i.test(url)) die(`fetch needs an http(s) URL: ${url}`);
  const h = Number(o.height || 720), yt = (...a) => spawnSync('yt-dlp', ['--no-warnings', '--no-playlist', ...a, url], { encoding: 'utf8' });
  const last = r => (r.stderr || '').trim().split('\n').pop();
  const meta = yt('--skip-download', '--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(webpage_url)s');
  if (meta.error) die('fetch needs yt-dlp on PATH (brew install yt-dlp)');
  if (meta.status !== 0) die(`yt-dlp failed: ${last(meta)}`);
  const [id, title, duration, uploader, page] = meta.stdout.trim().split('\n')[0].split('\t');
  const name = String(typeof o.name === 'string' ? o.name : id).replace(/[^\w.-]+/g, '_'), file = path.join(o.out, `${name}.mp4`);
  fs.mkdirSync(o.out, { recursive: true });
  // YouTube answers 403 now and then; a second try usually passes.
  for (let k = 0; k < 3 && !fs.existsSync(file); k++) {
    const r = yt('-q', '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-o', file);
    if (r.status !== 0 && k === 2) die(`yt-dlp download failed: ${last(r)}`);
  }
  const info = probe(file), na = v => (v && v !== 'NA' ? v : null);
  const source = { url, page_url: na(page), id: na(id), title: na(title), uploader: na(uploader), duration_s: r2(Number(duration) || info.duration),
    width: info.width, height: info.height, fps: r3(info.fps), audio: info.audio, fetched_at: new Date().toISOString() };
  fs.writeFileSync(path.join(o.out, `${name}.source.json`), JSON.stringify(source, null, 1) + '\n');
  return { ok: true, video: file, ...source };
}
async function overview(video, o) {
  const info = await setup(video, o), step = Number(o.step || 5), per = 75;
  fs.mkdirSync(o.out, { recursive: true });
  await ffmpeg(['-y', '-i', video, '-an', '-vf', vf(info, `fps=1/${step},scale=96:-2,pad=iw+4:ih+4:2:2:red,tile=15x5`), '-q:v', '3', path.join(o.out, 'overview_%02d.jpg')]);
  const sheets = Math.ceil(info.duration / step / per);
  fs.writeFileSync(path.join(o.out, 'overview.md'), ['# Overview', '', `Sheet k (1-based), tile j (row-major, 0-based): t = ((k-1)*${per} + j) * ${step} s.`, '',
    ...Array.from({ length: sheets }, (_, k) => `- overview_${String(k + 1).padStart(2, '0')}.jpg: ${k * per * step}–${Math.min(info.duration, (k + 1) * per * step).toFixed(0)} s`)].join('\n') + '\n');
  return { ok: true, crop: info.crop || null, sheets, index: path.join(o.out, 'overview.md') };
}

const EASE = {
  linear: u => u, quadIn: u => u * u, quadOut: u => u * (2 - u), quadInOut: u => u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) ** 2,
  cubicIn: u => u ** 3, cubicOut: u => 1 - (1 - u) ** 3, cubicInOut: u => u < 0.5 ? 4 * u ** 3 : 1 - 4 * (1 - u) ** 3,
  sineIn: u => 1 - Math.cos(u * Math.PI / 2), sineOut: u => Math.sin(u * Math.PI / 2), sineInOut: u => (1 - Math.cos(u * Math.PI)) / 2,
};
// Arc shapes: a sine, or two half-parabolas meeting at peak phase p (a quadOut rise + quadIn fall; p 0.5 is 4u(1-u)).
const ARCS = { sine: u => Math.sin(Math.PI * u) };
for (let k = 0; k <= 24; k++) { const p = 0.2 + k * 0.025; ARCS[`parabola@${r3(p)}`] = u => u < p ? 1 - ((p - u) / p) ** 2 : 1 - ((u - p) / (1 - p)) ** 2; }
// A parabola over the eased ground progress (height as a function of distance, the usual tween code) peaks early in
// time under an ease-out.
const arcsFor = E => ({ ...ARCS, eased: u => 4 * E(u) * (1 - E(u)) });

function frameTimes(video, a, b, fps, n) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-read_intervals', `${a}%${b}`, '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const t = (r.stdout || '').split('\n').filter(Boolean).map(Number).filter(x => x >= a - 1e-4 && x < b - 1e-4);
  if (t.length === n) return { clock: 'pts', t };
  const j0 = Math.ceil(a * fps - 1e-6);
  return { clock: 'cfr', t: Array.from({ length: n }, (_, k) => (j0 + k) / fps) };
}
function down(g, w, h, k) {
  const W2 = Math.floor(w / k), H2 = Math.floor(h / k), d = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    let s = 0;
    for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) s += g[(y * k + v) * w + x * k + u];
    d[y * W2 + x] = s / (k * k);
  }
  return { d, w: W2, h: H2 };
}
function bilinear(g, w, h, x, y) {
  x = Math.min(w - 1.001, Math.max(0, x)); y = Math.min(h - 1.001, Math.max(0, y));
  const i = x | 0, j = y | 0, fx = x - i, fy = y - j, p = j * w + i;
  return (g[p] * (1 - fx) + g[p + 1] * fx) * (1 - fy) + (g[p + w] * (1 - fx) + g[p + w + 1] * fx) * fy;
}
// Template of the object scaled by (sx, sy) and turned by rot about its center (cx, cy), zero-mean for NCC.
// With a mask (same size as g, 0..1) only the pixels it covers are kept, listed in pu/pv.
function template(g, w, h, cx, cy, tw, th, sx, sy, rot = 0, mask = null) {
  const W2 = Math.max(4, Math.round(tw * sx)), H2 = Math.max(4, Math.round(th * sy)), cs = Math.cos(rot), sn = Math.sin(rot), zs = [], pu = [], pv = [];
  for (let v = 0; v < H2; v++) for (let u = 0; u < W2; u++) {
    const ou = (u + 0.5 - W2 / 2) / sx, ov = (v + 0.5 - H2 / 2) / sy, X = cx + cs * ou - sn * ov - 0.5, Y = cy + sn * ou + cs * ov - 0.5;
    if (mask && bilinear(mask, w, h, X, Y) < 0.5) continue;
    zs.push(bilinear(g, w, h, X, Y)); pu.push(u); pv.push(v);
  }
  const z = Float32Array.from(zs), m = z.reduce((s, q) => s + q, 0) / z.length;
  let n2 = 0;
  for (let k = 0; k < z.length; k++) { z[k] -= m; n2 += z[k] * z[k]; }
  return { w: W2, h: H2, sx, sy, z, n2, pu: mask ? Int16Array.from(pu) : null, pv: mask ? Int16Array.from(pv) : null };
}
function ncc(g, w, h, t, x, y) {
  if (x < 0 || y < 0 || x + t.w > w || y + t.h > h) return -1;
  let s = 0, s2 = 0, st = 0;
  if (t.pu) for (let k = 0; k < t.z.length; k++) { const f = g[(y + t.pv[k]) * w + x + t.pu[k]]; s += f; s2 += f * f; st += f * t.z[k]; }
  else for (let v = 0; v < t.h; v++) {
    const r = (y + v) * w + x, q = v * t.w;
    for (let u = 0; u < t.w; u++) { const f = g[r + u]; s += f; s2 += f * f; st += f * t.z[q + u]; }
  }
  const vr = s2 - s * s / t.z.length;
  return vr > 1e-6 ? st / Math.sqrt(vr * t.n2) : 0;
}
// Sub-sample offset of the extremum of three equally spaced values, in [-0.5, 0.5].
const vertex = (m, c, p) => { const d = m + p - 2 * c; return d ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0; };

// Content shift between two frames outside `boxes`: global SAD at 1/4 scale, then 32 px blocks refined at full
// res. A tilted board under a panning perspective camera moves more near the bottom, so the blocks get an
// affine fit (two refits dropping outliers) and at(p) is the shift at screen point p.
function camShift(A, B, qa, qb, w, h, band, boxes) {
  const hit = (x0, y0, x1, y1) => boxes.some(r => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
  const R4 = 10, keep = [];
  for (let y = Math.ceil(band[0] * qa.h) + R4; y < Math.floor(band[1] * qa.h) - R4; y++) for (let x = R4; x < qa.w - R4; x++) if (!hit(x * 4, y * 4, x * 4 + 4, y * 4 + 4)) keep.push(y * qa.w + x);
  let c = [0, 0], cb = Infinity;
  for (let dy = -R4; dy <= R4; dy++) for (let dx = -R4; dx <= R4; dx++) {
    let s = 0;
    const off = dy * qa.w + dx;
    for (const p of keep) s += Math.abs(qb.d[p + off] - qa.d[p]);
    if (s < cb) { cb = s; c = [dx * 4, dy * 4]; }
  }
  const BS = 32, R = 5, n = 2 * R + 1, ds = [];
  for (let by = Math.ceil(band[0] * h); by + BS <= band[1] * h; by += BS) for (let bx = 0; bx + BS <= w; bx += BS) {
    if (hit(bx, by, bx + BS, by + BS)) continue;
    let m = 0, m2 = 0;
    for (let v = 0; v < BS; v++) for (let u = 0; u < BS; u++) { const f = A[(by + v) * w + bx + u]; m += f; m2 += f * f; }
    if (m2 / (BS * BS) - (m / (BS * BS)) ** 2 < 36) continue;
    const sad = new Float64Array(n * n).fill(Infinity);
    let bi = -1;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const X = bx + c[0] + dx, Y = by + c[1] + dy;
      if (X < 0 || Y < 0 || X + BS > w || Y + BS > h) continue;
      let s = 0;
      for (let v = 0; v < BS; v++) { const ra = (by + v) * w + bx, rb = (Y + v) * w + X; for (let u = 0; u < BS; u++) s += Math.abs(B[rb + u] - A[ra + u]); }
      const j = (dy + R) * n + dx + R;
      sad[j] = s; if (bi < 0 || s < sad[bi]) bi = j;
    }
    const jx = bi % n, jy = Math.floor(bi / n);
    if (bi < 0 || jx === 0 || jy === 0 || jx === n - 1 || jy === n - 1 || !Number.isFinite(sad[bi - n] + sad[bi + n] + sad[bi - 1] + sad[bi + 1])) continue;
    ds.push([c[0] + jx - R + vertex(sad[bi - 1], sad[bi], sad[bi + 1]), c[1] + jy - R + vertex(sad[bi - n], sad[bi], sad[bi + n]), bx + BS / 2, by + BS / 2]);
  }
  if (ds.length < 8) return { blocks: ds.length, inliers: 0, spread: 0, jac: [[0, 0], [0, 0]], at: () => c };
  const mdx = median(ds.map(d => d[0])), mdy = median(ds.map(d => d[1])), xc = w / 2, yc = h / 2;
  let inl = ds.filter(d => Math.abs(d[0] - mdx) < 4 && Math.abs(d[1] - mdy) < 4), ax = [mdx, 0, 0], ay = [mdy, 0, 0];
  const lin = (q, d) => q[0] + q[1] * (d[2] - xc) / w + q[2] * (d[3] - yc) / h;
  for (let pass = 0; pass < 3 && inl.length >= 8; pass++) {
    const rows = k => inl.map(d => [Float64Array.of(1, (d[2] - xc) / w, (d[3] - yc) / h), d[k]]);
    ax = Array.from(leastSquares(rows(0), 3)); ay = Array.from(leastSquares(rows(1), 3));
    inl = ds.filter(d => Math.abs(d[0] - lin(ax, d)) < 1.2 && Math.abs(d[1] - lin(ay, d)) < 1.2);
  }
  // spread: how far the shift at the band's top and bottom rows differ, in px. jac: d(shift)/d(x, y).
  return { blocks: ds.length, inliers: inl.length, spread: Math.hypot(ax[2], ay[2]) * (band[1] - band[0]), jac: [[ax[1] / w, ax[2] / h], [ay[1] / w, ay[2] / h]], at: p => [lin(ax, [0, 0, ...p]), lin(ay, [0, 0, ...p])] };
}
function leastSquares(rows, n) {
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const [c, r] of rows) for (let i = 0; i < n; i++) { if (!c[i]) continue; for (let j = 0; j < n; j++) A[i][j] += c[i] * c[j]; A[i][n] += c[i] * r; }
  for (let i = 0; i < n; i++) A[i][i] += 1e-6;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; if (f) for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = A[i][n]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  return x;
}
// All hops at once: the ground runs Q[k-1] -> Q[k] by E(u), the object sits H[k]·A(u) above it; linear in Q and H.
function fitHops(S, L, E, A) {
  const n = L.length - 1, rx = [], ry = [], pts = [];
  for (const s of S) {
    if (s.t < L[0] || s.t > L[n]) continue;
    let k = 1;
    while (k < n && s.t > L[k]) k++;
    const u = (s.t - L[k - 1]) / (L[k] - L[k - 1]), e = E(u), a = A(u), cx = new Float64Array(n + 1), cy = new Float64Array(2 * n + 1);
    cx[k - 1] = 1 - e; cx[k] = e; cy[k - 1] = 1 - e; cy[k] = e; cy[n + k] = -a;
    rx.push([cx, s.bx]); ry.push([cy, s.by]); pts.push({ s, k, u });
  }
  if (pts.length < 2 * n + 2) return { rms: Infinity };
  const qx = leastSquares(rx, n + 1), qy = leastSquares(ry, 2 * n + 1);
  let se = 0;
  for (let j = 0; j < pts.length; j++) {
    se += (rx[j][0].reduce((s, c, i) => s + c * qx[i], 0) - rx[j][1]) ** 2 + (ry[j][0].reduce((s, c, i) => s + c * qy[i], 0) - ry[j][1]) ** 2;
  }
  return { rms: Math.sqrt(se / (2 * pts.length)), Q: Array.from({ length: n + 1 }, (_, k) => [qx[k], qy[k]]), H: Array.from(qy.slice(n + 1)), pts };
}
// Camera follow models against the measured camera path: exponential lerp (tau), critically damped spring
// (SmoothDamp smoothTime), pure delay. Each gets a free constant framing offset.
function followFit(ts, cm, target) {
  const dt = 0.002, N = Math.ceil((ts[ts.length - 1] - ts[0]) / dt) + 1, T = Array.from({ length: N }, (_, k) => target(ts[0] + k * dt));
  const at = ts.map(t => Math.min(N - 1, Math.round((t - ts[0]) / dt)));
  const score = sim => {
    const off = [0, 1].map(ax => { let num = 0, den = 0; sim.c.forEach((c, i) => { num += sim.g[i] * (c[ax] - cm[i][ax]); den += sim.g[i] ** 2; }); return den > 1e-9 ? num / den : 0; });
    const fitted = sim.c.map((c, i) => [c[0] - off[0] * sim.g[i], c[1] - off[1] * sim.g[i]]);
    const se = fitted.reduce((s, c, i) => s + (c[0] - cm[i][0]) ** 2 + (c[1] - cm[i][1]) ** 2, 0);
    return { rms: Math.sqrt(se / (2 * ts.length)), offset: off, fitted };
  };
  const run = (model, p, c0 = cm[0]) => {
    const c = [...c0], v = [0, 0], g = [0, 0], out = [], w0 = 2 / p;
    for (let k = 0, j = 0; k < N && j < ts.length; k++) {
      while (j < ts.length && at[j] === k) { out.push({ c: [...c], g: g[0] }); j++; }
      if (model === 'lerp') { const f = 1 - Math.exp(-dt / p); for (const ax of [0, 1]) c[ax] += (T[k][ax] - c[ax]) * f; g[0] += (1 - g[0]) * f; }
      else {
        for (const ax of [0, 1]) { v[ax] += (w0 * w0 * (T[k][ax] - c[ax]) - 2 * w0 * v[ax]) * dt; c[ax] += v[ax] * dt; }
        g[1] += (w0 * w0 * (1 - g[0]) - 2 * w0 * g[1]) * dt; g[0] += g[1] * dt;
      }
    }
    return { c: out.map(q => q.c), g: out.map(q => q.g) };
  };
  // The same filters with a 2×2 gain: the camera may cover only part of the target's motion, or skew it (framing
  // that drifts, clamped to the board). Least squares per axis on the filtered target (started at rest) and a constant.
  const gained = sim => {
    const X = [0, 1].map(ax => sim.c.map(c => c[ax] - T[0][ax]));
    const rows = [0, 1].map(ax => {
      const f = [X[0], X[1], X[0].map(() => 1)], A = f.map(q => f.map(r => q.reduce((s, x, i) => s + x * r[i], 0))), y = f.map(q => q.reduce((s, x, i) => s + x * cm[i][ax], 0));
      for (let i = 0; i < 3; i++) for (let k = i + 1; k < 3; k++) { const r = A[k][i] / A[i][i]; for (let j = i; j < 3; j++) A[k][j] -= r * A[i][j]; y[k] -= r * y[i]; }
      const m = [0, 0, 0]; for (let i = 2; i >= 0; i--) m[i] = (y[i] - A[i].slice(i + 1).reduce((s, x, j) => s + x * m[i + 1 + j], 0)) / A[i][i];
      return m;
    });
    const fitted = sim.c.map((_, i) => rows.map(m => m[0] * X[0][i] + m[1] * X[1][i] + m[2]));
    const se = fitted.reduce((s, c, i) => s + (c[0] - cm[i][0]) ** 2 + (c[1] - cm[i][1]) ** 2, 0);
    return { rms: Math.sqrt(se / (2 * ts.length)), offset: [cm[0][0] - T[0][0], cm[0][1] - T[0][1]], fitted, gain: rows.map(m => m.slice(0, 2)) };
  };
  const best = {}, keep = (m, p, s) => { if (!best[m] || s.rms < best[m].rms) best[m] = { p, ...s }; };
  for (let k = 0; k < 40; k++) {
    const p = 0.02 * 100 ** (k / 39);
    for (const m of ['lerp', 'spring']) { keep(m, p, score(run(m, p))); keep(`${m}+gain`, p, gained(run(m, p, T[0]))); }
  }
  for (let k = 0; k <= 80; k++) keep('delay', k / 100, score({ c: ts.map(t => T[Math.max(0, Math.min(N - 1, Math.round((t - k / 100 - ts[0]) / dt)))]), g: ts.map(() => 1) }));
  return best;
}
function canvas(W, H) {
  const d = new Uint8Array(W * H * 3).fill(24), cv = { W, H, d, clip: [0, 0, W, H] };
  const px = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= cv.clip[0] && y >= cv.clip[1] && x < cv.clip[2] && y < cv.clip[3]) d.set(c, (y * W + x) * 3); };
  const line = (x0, y0, x1, y1, c) => { const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1; for (let k = 0; k <= n; k++) px(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, c); };
  const dot = (x, y, c, r = 1) => { for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) px(x + u, y + v, c); };
  const frame = (x, y, w, h, c) => { line(x, y, x + w, y, c); line(x, y + h, x + w, y + h, c); line(x, y, x, y + h, c); line(x + w, y, x + w, y + h, c); };
  return Object.assign(cv, { px, line, dot, frame });
}
// Moves that are not hops also try an overshoot and a snap; colours of the verification sheets by frame status.
const MOVE_EASE = { ...EASE, backOut: u => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2, expoOut: u => u >= 1 ? 1 : 1 - 2 ** (-10 * u) };
const RED = [240, 60, 60], GREEN = [60, 220, 90], BLUE = [90, 160, 255], GREY = [110, 110, 110], YEL = [240, 210, 60], ORANGE = [255, 150, 40];
const BOX_COLOR = { ok: GREEN, clipped: ORANGE, lost: RED, gone: GREY }, DOT_COLOR = { ok: BLUE, clipped: ORANGE, lost: RED, gone: GREY };
const dirOf = q => [Math.cos(q * Math.PI / 8), Math.sin(q * Math.PI / 8)];
const dir8 = d => ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'][((Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 4)) % 8) + 8) % 8];
// Template pixels projected on direction d from the template's center, and their extent.
function spanAlong(tp, d) {
  const along = new Float32Array(tp.z.length);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < along.length; k++) {
    const u = tp.pu ? tp.pu[k] : k % tp.w, v = tp.pv ? tp.pv[k] : Math.floor(k / tp.w);
    along[k] = (u + 0.5 - tp.w / 2) * d[0] + (v + 0.5 - tp.h / 2) * d[1];
    lo = Math.min(lo, along[k]); hi = Math.max(hi, along[k]);
  }
  return { along, lo, hi };
}
// A straight eased move P0 -> P1 over pts ({t, p}): start and end on a quarter-frame grid around the times it was seen
// to leave (tA) and arrive (tB); an ease-in starts well before the object visibly leaves, an ease-out ends well after it
// visibly arrives. Ranked by the rms distance in px.
function fitEase(pts, P0, P1, tA, tB, dq, eases) {
  const D = [P1[0] - P0[0], P1[1] - P0[1]], out = [];
  for (const [ease, E] of Object.entries(eases)) {
    let best = { ease, rms: Infinity };
    for (let i = -16; i <= 4; i++) for (let j = -4; j <= 16; j++) {
      const t0 = tA + i * dq, t1 = tB + j * dq;
      if (t1 - t0 < 2 * dq) continue;
      let se = 0;
      for (const q of pts) { const e = E(Math.max(0, Math.min(1, (q.t - t0) / (t1 - t0)))); se += (P0[0] + D[0] * e - q.p[0]) ** 2 + (P0[1] + D[1] * e - q.p[1]) ** 2; }
      if (se < best.rms) best = { ease, t0, t1, rms: se };
    }
    out.push({ ...best, rms: Math.sqrt(best.rms / Math.max(1, pts.length)) });
  }
  return out.sort((x, y) => x.rms - y.rms);
}
// Verification crops: up to 32 frames spread over the window, 128 px around the object, 8 a row over the top half of a
// 1024 px sheet. draw(cv, sample, dx, dy, k) marks one, clipped to its tile (sheet = source + (dx, dy)).
async function cropSheet(win, info, all, draw) {
  const { width: w, height: h } = info, C = 128, n = Math.min(32, all.length);
  const sel = [...new Set(Array.from({ length: n }, (_, k) => Math.round(k * (all.length - 1) / (n - 1))))];
  const pick = new Map(sel.map(k => [all[k].i, k])), crops = new Map();
  await rawFrames([...win, '-vf', vf(info, 'format=rgb24'), '-f', 'rawvideo', '-'], w * h * 3, (f, i) => {
    if (!pick.has(i)) return;
    const s = all[pick.get(i)], cx = Math.round(s.pos[0] - C / 2), cy = Math.round(s.pos[1] - C / 2), px = new Uint8Array(C * C * 3);
    for (let v = 0; v < C; v++) for (let u = 0; u < C; u++) { const x = cx + u, y = cy + v; if (x >= 0 && y >= 0 && x < w && y < h) px.set(f.subarray((y * w + x) * 3, (y * w + x) * 3 + 3), (v * C + u) * 3); }
    crops.set(pick.get(i), { px, cx, cy });
  });
  const cv = canvas(1024, 1024);
  sel.forEach((k, j) => {
    const c = crops.get(k), ox = (j % 8) * C, oy = Math.floor(j / 8) * C;
    if (!c) return;
    for (let v = 0; v < C; v++) cv.d.set(c.px.subarray(v * C * 3, (v + 1) * C * 3), ((oy + v) * 1024 + ox) * 3);
    cv.clip = [ox, oy, ox + C, oy + C];
    draw(cv, all[k], ox - c.cx, oy - c.cy, k);
    cv.clip = [0, 0, cv.W, cv.H];
  });
  return { cv, sel };
}
async function saveSheet(cv, file) {
  const raw = file.replace(/\.jpg$/, '.rgb');
  fs.writeFileSync(raw, cv.d);
  await ffmpeg(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${cv.W}x${cv.H}`, '-i', raw, '-q:v', '3', file]);
  fs.unlinkSync(raw);
}
// A second box (--react: a gate, a bumper) found in every frame near where the camera puts it: its offset from that spot
// and its size (sx, sy) against the first frame. Whole-rect NCC; iso size at half res, then sx / sy and ±2 px at full res.
function reactTrack(frames, uniq, times, G, box, w, h) {
  if (box.length !== 4 || box.some(x => !(x >= 0 && x <= 1)) || box[2] <= box[0] || box[3] <= box[1]) die('--react needs x0,y0,x1,y1 (fractions of the frame)');
  const [x0, y0, x1, y1] = [box[0] * w, box[1] * h, box[2] * w, box[3] * h].map(Math.round), rw = x1 - x0, rh = y1 - y0, c0 = [x0 + rw / 2, y0 + rh / 2];
  const g0 = frames[uniq[0]], q0 = down(g0, w, h, 2), ISO = [0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2], DS = [-0.04, -0.02, 0, 0.02, 0.04], full = new Map();
  const coarse = ISO.map(sc => template(q0.d, q0.w, q0.h, c0[0] / 2, c0[1] / 2, rw / 2, rh / 2, sc, sc));
  const fullT = (sx, sy) => { const key = `${r3(sx)}|${r3(sy)}`; if (!full.has(key)) full.set(key, template(g0, w, h, c0[0], c0[1], rw, rh, sx, sy)); return full.get(key); };
  return uniq.map((i, k) => {
    const g = frames[i], hf = down(g, w, h, 2), e = [c0[0] + G[k][0], c0[1] + G[k][1]];
    let c = { v: -2 }, m = { v: -2 };
    coarse.forEach((tp, j) => {
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
        const x = Math.round(e[0] / 2 - tp.w / 2) + dx, y = Math.round(e[1] / 2 - tp.h / 2) + dy, v = ncc(hf.d, hf.w, hf.h, tp, x, y);
        if (v > c.v) c = { v, sc: ISO[j], p: [(x + tp.w / 2) * 2, (y + tp.h / 2) * 2] };
      }
    });
    for (const ax of DS) for (const ay of DS) {
      const tp = fullT(c.sc + ax, c.sc + ay), X = Math.round(c.p[0] - tp.w / 2), Y = Math.round(c.p[1] - tp.h / 2);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = ncc(g, w, h, tp, X + dx, Y + dy); if (v > m.v) m = { v, tp, x: X + dx, y: Y + dy, sx: c.sc + ax, sy: c.sc + ay }; }
    }
    const at = (dx, dy) => ncc(g, w, h, m.tp, m.x + dx, m.y + dy), p = [m.x + vertex(at(-1, 0), m.v, at(1, 0)) + m.tp.w / 2, m.y + vertex(at(0, -1), m.v, at(0, 1)) + m.tp.h / 2];
    return { t: times[i], d: [p[0] - e[0], p[1] - e[1]], sx: m.sx, sy: m.sy, ncc: m.v, rect: [m.x, m.y, m.tp.w, m.tp.h] };
  });
}
// Knock-back of the --react box: rest is its median offset before quietUntil; the peak is its largest excursion after,
// along whose direction the onset and return are read (level: 10 % of the peak, at least twice the rest noise). The
// way out and the way back are each fitted as an eased move.
function reactSummary(rs0, quietUntil, dq) {
  // Frames where the box is covered (particles, a flash, the object passing over it) match under 0.7 and are left out.
  const rs = rs0.filter(r => r.ncc >= 0.7), hid = rs0.filter(r => r.ncc < 0.7).map(r => r.t);
  const hidden = hid.length ? { frames: hid.length, from_s: r3(hid[0]), to_s: r3(hid[hid.length - 1]) } : null;
  if (rs.length < 5) return { moved: false, hidden, noise_px: null, peak_px: null };
  // Rest: the frames before the event, or when the window starts too close to it, those plus its last 30 % (the box has
  // settled by then in a window a few times the knock long). Noise comes from frame-to-frame steps over the whole window
  // (robust: the knock is a few steps of many), so it does not need a quiet stretch at the start.
  const pre = rs.filter(r => r.t < quietUntil), rest = pre.length >= 3 ? pre : [...pre, ...rs.slice(-Math.max(3, Math.round(0.3 * rs.length)))];
  const r0 = [median(rest.map(r => r.d[0])), median(rest.map(r => r.d[1]))], s0 = [median(rest.map(r => r.sx)), median(rest.map(r => r.sy))];
  const disp = rs.map(r => [r.d[0] - r0[0], r.d[1] - r0[1]]), mag = disp.map(d => Math.hypot(...d));
  const noise = 1.4826 * median(rs.slice(1).map((r, k) => Math.hypot(r.d[0] - rs[k].d[0], r.d[1] - rs[k].d[1]))) / Math.SQRT2, late = rs.map((_, k) => k).filter(k => rs[k].t >= quietUntil);
  const kp = (late.length ? late : rs.map((_, k) => k)).reduce((p, k) => mag[k] > mag[p] ? k : p), pk = mag[kp];
  const scale = rs.map(r => [r.sx - s0[0], r.sy - s0[1]]), ks = (late.length ? late : rs.map((_, k) => k)).reduce((p, k) => Math.max(...scale[k].map(Math.abs)) > Math.max(...scale[p].map(Math.abs)) ? k : p);
  const base = { hidden, rest_offset_px: r0.map(r2), noise_px: r2(noise), peak_px: r2(pk), ncc_min: r3(Math.min(...rs.map(r => r.ncc))),
    scale_peak: Math.max(...scale[ks].map(Math.abs)) > 0.02 ? { t: r3(rs[ks].t), sx: r3(rs[ks].sx / s0[0]), sy: r3(rs[ks].sy / s0[1]) } : null };
  if (pk < Math.max(1, 4 * noise)) return { moved: false, ...base };
  const axis = [disp[kp][0] / pk, disp[kp][1] / pk], al = disp.map(d => d[0] * axis[0] + d[1] * axis[1]), lv = Math.max(2 * noise, 0.1 * pk);
  const at = (k, level) => rs[k - 1].t + (rs[k].t - rs[k - 1].t) * (level - al[k - 1]) / (al[k] - al[k - 1]);
  let ko = kp; while (ko > 0 && al[ko - 1] > lv) ko--;
  let kr = kp; while (kr + 1 < rs.length && al[kr + 1] > lv) kr++;
  let k9 = kp; while (k9 > ko && al[k9 - 1] >= 0.9 * pk) k9--;
  let kb = kp; while (kb + 1 < rs.length && al[kb + 1] >= 0.9 * pk) kb++;
  const onset = ko ? at(ko, lv) : rs[0].t, full = k9 > ko ? at(k9, 0.9 * pk) : rs[k9].t, ret = kr + 1 < rs.length ? at(kr + 1, lv) : null, leave = kb + 1 < rs.length ? at(kb + 1, 0.9 * pk) : null;
  const after = al.slice(kr + 1), under = after.length ? Math.min(...after) : 0;
  let settle = null;
  for (let k = kr + 1; k < rs.length; k++) if (al.slice(k).every(x => Math.abs(x) <= lv)) { settle = rs[k].t; break; }
  const P = [axis[0] * pk, axis[1] * pk], pts = (k0, k1) => rs.slice(Math.max(0, k0), k1 + 1).map((r, j) => ({ t: r.t, p: disp[Math.max(0, k0) + j] }));
  const out = fitEase(pts(ko - 3, kp), [0, 0], P, onset, full, dq, EASE), back = ret !== null ? fitEase(pts(kp, Math.min(rs.length - 1, kr + 4)), P, [0, 0], leave ?? rs[kp].t, ret, dq, MOVE_EASE) : null;
  return { moved: true, ...base, axis: dir8(axis), axis_vec: axis.map(r3), onset_s: r3(onset), peak_s: r3(rs[kp].t), return_s: ret === null ? null : r3(ret), settle_s: settle === null ? null : r3(settle),
    overshoot_px: under < -lv ? r2(-under) : 0,
    out: { duration_s: r3(out[0].t1 - out[0].t0), start_s: r3(out[0].t0), ease: out[0].ease, ease_rank: out.slice(0, 4).map(q => [q.ease, r2(q.rms)]) },
    back: back && { duration_s: r3(back[0].t1 - back[0].t0), start_s: r3(back[0].t0), ease: back[0].ease, ease_rank: back.slice(0, 4).map(q => [q.ease, r2(q.rms)]) },
    model: { P, out: out[0], back: back && back[0] } };
}

// Moves (slides, drags, pushes: whatever is not a hop) are runs of intervals where the object's board speed is over
// VMIN, with at most two slow intervals inside. A move that ends at rest is fitted as an eased tween between the two rest
// positions. One that ends out of sight (gone), lost or at the window's end gets a quadratic tail instead (speed and
// acceleration up to the last frame it was seen); if it was clipped on the way out, the clipped frames place the
// occluder's edge, and the tail says when the object touched it and when it was fully under it.
async function moveTrack(c) {
  const { video, o, info, a, b, win, all, S, VMIN, L, lenAlong, react, decoded, maskInfo } = c, dq = 1 / (4 * info.fps), cell = Number(o.cell) > 0 ? Number(o.cell) : null;
  const onsets = info.audio ? (await audioOnsets(video)).filter(x => x.t >= a && x.t <= b).map(x => r3(x.t)) : [];
  const B = s => [s.bx, s.by], dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), med2 = q => [median(q.map(s => s.bx)), median(q.map(s => s.by))];
  const units = (v, Lm = L) => ({ px_s: r2(v), ...(cell ? { cells_s: r2(v / cell) } : {}), lengths_s: r2(v / Lm) });
  // First time f rises past lv along q (samples in either time order), between the two samples around it.
  const cross = (q, f, lv) => { for (let k = 0; k < q.length; k++) if (f(q[k]) > lv) { if (!k) return q[0].t; const x = f(q[k - 1]), y = f(q[k]); return q[k - 1].t + (q[k].t - q[k - 1].t) * (lv - x) / (y - x); } return null; };
  // The root of c2·τ² + c1·τ + c0 (τ from the last frame seen) where the object moves forward.
  const ahead = (c0, c1, c2) => {
    if (Math.abs(c2) < 1e-9) return Math.abs(c1) > 1e-9 && c1 > 0 ? -c0 / c1 : null;
    const D = c1 * c1 - 4 * c2 * c0;
    if (D < 0) return null;
    return [(-c1 - Math.sqrt(D)) / (2 * c2), (-c1 + Math.sqrt(D)) / (2 * c2)].filter(r => c1 + 2 * c2 * r > 0).sort((x, y) => Math.abs(x) - Math.abs(y))[0] ?? null;
  };
  const sp = S.slice(1).map((s, j) => dist(B(s), B(S[j])) / (s.t - S[j].t)), runs = [], moves = [];
  sp.forEach((v, j) => { if (v <= VMIN) return; const r = runs[runs.length - 1]; if (r && j - r[1] <= 3) r[1] = j; else runs.push([j, j]); });
  // A run that turns sharply (over 60° between two fast steps: dragged right, then dropped into a gate below) is two
  // moves; the first ends at the turn, the second starts there.
  const ang = j => Math.atan2(S[j + 1].by - S[j].by, S[j + 1].bx - S[j].bx), turn = j => { const d = Math.abs(ang(j + 1) - ang(j)); return Math.min(d, 2 * Math.PI - d); };
  const pieces = runs.flatMap(([j0, j1]) => {
    const cuts = [];
    for (let j = j0; j < j1; j++) {
      if (!(sp[j] > 2 * VMIN && sp[j + 1] > 2 * VMIN && turn(j) > Math.PI / 3)) continue;
      if (cuts.length && cuts[cuts.length - 1] === j - 1) { if (turn(j) > turn(j - 1)) cuts[cuts.length - 1] = j; } else cuts.push(j);
    }
    const ends = [j0 - 1, ...cuts, j1];
    return ends.slice(1).map((e, n) => ({ j0: ends[n] + 1, j1: e, tin: n > 0, tout: n < cuts.length }));
  });
  pieces.forEach(({ j0, j1, tin, tout }, n) => {
    const pe = tin ? j0 : n ? pieces[n - 1].j1 + 1 : 0, ns = tout ? j1 + 1 : n + 1 < pieces.length ? pieces[n + 1].j0 : S.length - 1;
    const before = S.slice(pe, j0 + 1), after = S.slice(j1 + 1, ns + 1), seg = S.slice(pe, ns + 1);
    const P0 = before.length >= 2 ? med2(before) : B(S[j0]);
    if (dist(B(S[j1 + 1]), P0) < 3 && Math.max(...sp.slice(j0, j1 + 1)) < 2 * VMIN) return;
    const next = all.find(x => x.t > S[S.length - 1].t);
    const end = tout ? 'turn' : n + 1 < pieces.length || after.length >= 3 ? 'stop' : !next ? 'window' : next.status === 'gone' ? 'vanish' : 'lost';
    const mv = { k: moves.length + 1, end, from_rest: before.length >= 2, from: P0.map(r2) }, peak = Math.max(...sp.slice(j0, j1 + 1));
    if (end === 'stop') {
      const P1 = after.length >= 2 ? med2(after) : B(after[0]), Dv = [P1[0] - P0[0], P1[1] - P0[1]], D = Math.hypot(...Dv), eps = Math.max(1.5, 0.03 * D), Lm = lenAlong([Dv[0] / (D || 1), Dv[1] / (D || 1)]);
      const tA = cross(seg, s => dist(B(s), P0), eps), tB = cross([...seg].reverse(), s => dist(B(s), P1), eps);
      const pts = seg.filter(s => s.t >= tA - 4 / info.fps && s.t <= tB + 4 / info.fps).map(s => ({ t: s.t, p: B(s) }));
      const rank = fitEase(pts, P0, P1, tA, tB, dq, MOVE_EASE), f = rank[0], E = MOVE_EASE[f.ease], dur = f.t1 - f.t0;
      let dmax = 0;
      for (let k = 0; k < 200; k++) dmax = Math.max(dmax, (E((k + 1) / 200) - E(k / 200)) * 200);
      moves.push(Object.assign(mv, { length_px: r2(Lm), peak_seen: units(peak, Lm), to: P1.map(r2), dir: dir8(Dv), vec: [r3(Dv[0] / D), r3(Dv[1] / D)], dist_px: r2(D), ...(cell ? { dist_cells: r2(D / cell) } : {}),
        start_s: r3(f.t0), stop_s: r3(f.t1), duration_s: r3(dur), seen_leaving_s: r3(tA), seen_arriving_s: r3(tB), ease: f.ease, ease_rank: rank.slice(0, 5).map(q => [q.ease, r2(q.rms)]),
        speed_avg: units(D / dur, Lm), speed_peak: units(dmax * D / dur, Lm), samples: pts.length, model: { kind: 'ease', P0, P1, t0: f.t0, t1: f.t1, ease: f.ease } }));
      return;
    }
    const last = tout ? S[j1 + 1] : S[S.length - 1], T = dist(B(last), P0), dv = T > 3 ? [(last.bx - P0[0]) / T, (last.by - P0[1]) / T] : [Math.cos(last.dir), Math.sin(last.dir)], Lm = lenAlong(dv);
    const al = s => (s.bx - P0[0]) * dv[0] + (s.by - P0[1]) * dv[1], tA = cross(seg, al, Math.max(1.5, 0.03 * T)) ?? seg[0].t, mov = seg.filter(s => s.t >= tA - 1e-6), tl = last.t;
    Object.assign(mv, { length_px: r2(Lm), peak_seen: units(peak, Lm), dir: dir8(dv), vec: dv.map(r3), travel_seen_px: r2(T), ...(cell ? { travel_seen_cells: r2(T / cell) } : {}), start_s: r3(tA), last_seen_s: r3(tl), speed_avg: units(T / Math.max(dq, tl - tA), Lm) });
    // Tail: the longest run of last frames a quadratic follows within 1.2 px (from four), and a line on the same frames.
    const fitN = (n2, deg) => {
      const q = mov.slice(-n2), co = Array.from(leastSquares(q.map(s => [Float64Array.from({ length: deg + 1 }, (_, e) => (s.t - tl) ** e), al(s)]), deg + 1));
      return { co, n: q.length, t_from: q[0].t, rms: Math.sqrt(q.reduce((e, s) => e + (co.reduce((y, cc, j) => y + cc * (s.t - tl) ** j, 0) - al(s)) ** 2, 0) / q.length) };
    };
    let tail = null;
    if (mov.length >= 4) {
      tail = fitN(4, 2);
      for (let n2 = 5; n2 <= mov.length; n2++) { const f2 = fitN(n2, 2); if (f2.rms > 1.2) break; tail = f2; }
      const [c0, c1, c2] = tail.co, lin = fitN(tail.n, 1), V = t => c1 + 2 * c2 * (t - tl);
      mv.tail = { from_s: r3(tail.t_from), to_s: r3(tl), samples: tail.n, rms_px: r2(tail.rms), speed_from: units(V(tail.t_from), Lm), speed_last: units(c1, Lm),
        accel_px_s2: r2(2 * c2), ...(cell ? { accel_cells_s2: r2(2 * c2 / cell) } : {}), linear_rms_px: r2(lin.rms), linear_speed: units(lin.co[1], Lm), constant_speed: lin.rms <= 1.2, covers_start: tail.t_from <= tA + 1.5 / info.fps };
      mv.model = { kind: 'tail', P0, dv, tl, co: tail.co, t_from: tail.t_from };
    }
    if (end === 'vanish') {
      const clip = mov.filter(s => s.status === 'clipped'), gone1 = all.find(x => x.t > tl && x.status === 'gone');
      const occ = mv.occlusion = { clipped_frames: clip.length, last_seen_s: r3(tl), first_missing_s: gone1 ? r3(gone1.t) : null };
      if (clip.length) {
        const edge = median(clip.map(s => al(s) - Lm / 2 + s.visible * Lm)), contact = cross(mov, s => al(s) + Lm / 2, edge);
        Object.assign(occ, { edge_along_px: r2(edge), edge_point: [P0[0] + dv[0] * edge, P0[1] + dv[1] * edge].map(r2), visible: clip.map(s => [r3(s.t), s.visible]), contact_s: contact === null ? null : r3(contact) });
        if (tail) {
          const [c0, c1, c2] = tail.co, cm = ahead(c0 + Lm / 2 - edge, c1, c2), cu = ahead(c0 - Lm / 2 - edge, c1, c2);
          Object.assign(occ, { contact_model_s: cm === null ? null : r3(tl + cm), under_s: cu === null ? null : r3(tl + cu) });
          if (cu !== null && contact !== null) Object.assign(occ, { contact_to_under_s: r3(tl + cu - contact), speed_at_contact: units(c1 + 2 * c2 * (contact - tl), Lm) });
          if (cu !== null) mv.model.t_to = tl + cu;
        }
      }
    }
    moves.push(mv);
  });

  // Reaction of the --react box, timed from the first exit's contact (or the first stop).
  const exit = moves.find(m => m.occlusion?.contact_s != null), stop = moves.find(m => m.end === 'stop');
  const ref = exit ? { event: `move ${exit.k} contact`, t: exit.occlusion.contact_s } : stop ? { event: `move ${stop.k} stop`, t: stop.stop_s } : null;
  const rsum = react && reactSummary(react, moves.length ? moves[0].start_s : a + 0.2 * (b - a), dq);
  if (rsum?.moved && ref) rsum.relative_to = { event: ref.event, onset_s: r3(rsum.onset_s - ref.t), out_start_s: r3(rsum.out.start_s - ref.t), peak_s: r3(rsum.peak_s - ref.t), return_s: rsum.return_s === null ? null : r3(rsum.return_s - ref.t), settle_s: rsum.settle_s === null ? null : r3(rsum.settle_s - ref.t) };

  // Verification sheet: crops on top; board x and y with the fitted moves, speed and visible share, the react offset.
  fs.mkdirSync(o.out, { recursive: true });
  const { cv, sel } = await cropSheet(win, info, all, (cv, s, dx, dy, k) => {
    if (react) { const r = react[k].rect; cv.frame(r[0] + dx, r[1] + dy, r[2], r[3], YEL); }
    cv.frame(s.rect[0] + dx, s.rect[1] + dy, s.rect[2], s.rect[3], BOX_COLOR[s.status]);
    cv.dot(s.pos[0] + dx, s.pos[1] + dy, RED, 2);
  });
  const X = t => 8 + (t - a) / (b - a) * 1008, band = (y0, lo, hi) => v => y0 + 120 - (v - lo) / (hi - lo || 1) * 112;
  const modelAt = (m, t) => {
    if (m.kind === 'ease') { const e = MOVE_EASE[m.ease](Math.max(0, Math.min(1, (t - m.t0) / (m.t1 - m.t0)))); return [m.P0[0] + (m.P1[0] - m.P0[0]) * e, m.P0[1] + (m.P1[1] - m.P0[1]) * e]; }
    const tau = t - m.tl, s = m.co[0] + m.co[1] * tau + m.co[2] * tau * tau; return [m.P0[0] + m.dv[0] * s, m.P0[1] + m.dv[1] * s];
  };
  const marks = (y0) => {
    for (const t of onsets) cv.line(X(t), y0 + 2, X(t), y0 + 10, YEL);
    for (const m of moves) {
      for (const t of [m.start_s, m.stop_s, m.last_seen_s]) if (t != null) cv.line(X(t), y0 + 4, X(t), y0 + 124, GREY);
      if (m.occlusion?.contact_s != null) cv.line(X(m.occlusion.contact_s), y0 + 4, X(m.occlusion.contact_s), y0 + 124, ORANGE);
      if (m.occlusion?.under_s != null) cv.line(X(m.occlusion.under_s), y0 + 4, X(m.occlusion.under_s), y0 + 124, RED);
    }
  };
  [0, 1].forEach(ax => {
    const vals = all.map(s => ax ? s.by : s.bx), y0 = 512 + ax * 128, Y = band(y0, Math.min(...vals) - 2, Math.max(...vals) + 2);
    marks(y0);
    for (const m of moves) {
      if (!m.model) continue;
      const t0 = m.model.kind === 'ease' ? m.model.t0 - 0.05 : m.model.t_from, t1 = m.model.kind === 'ease' ? m.model.t1 + 0.05 : m.model.t_to ?? m.model.tl;
      for (let j = 0; j < 100; j++) { const u = t0 + (t1 - t0) * j / 100, v = t0 + (t1 - t0) * (j + 1) / 100; cv.line(X(u), Y(modelAt(m.model, u)[ax]), X(v), Y(modelAt(m.model, v)[ax]), RED); }
    }
    all.forEach(s => cv.dot(X(s.t), Y(ax ? s.by : s.bx), DOT_COLOR[s.status]));
  });
  const vmax = Math.max(2 * VMIN, ...sp), Ys = band(768, 0, vmax), Yv = band(768, 0, 1);
  marks(768);
  cv.line(8, Ys(VMIN), 1016, Ys(VMIN), GREY);
  sp.forEach((v, j) => { if (j) cv.line(X((S[j - 1].t + S[j].t) / 2), Ys(sp[j - 1]), X((S[j].t + S[j + 1].t) / 2), Ys(v), BLUE); });
  all.forEach(s => cv.dot(X(s.t), Yv(s.visible), ORANGE, 1));
  if (rsum) {
    const al = react.map(r => (r.d[0] - (rsum.rest_offset_px?.[0] ?? 0)) * (rsum.axis_vec?.[0] ?? 1) + (r.d[1] - (rsum.rest_offset_px?.[1] ?? 0)) * (rsum.axis_vec?.[1] ?? 0)), Yr = band(896, Math.min(-2, ...al), Math.max(2, ...al));
    marks(896);
    cv.line(8, Yr(0), 1016, Yr(0), GREY);
    if (rsum.moved) for (const f of [rsum.model.out, rsum.model.back].filter(Boolean)) {
      const E = MOVE_EASE[f.ease], [p0, p1] = f === rsum.model.out ? [0, rsum.peak_px] : [rsum.peak_px, 0];
      for (let j = 0; j < 60; j++) { const u = j / 60, v = (j + 1) / 60; cv.line(X(f.t0 + (f.t1 - f.t0) * u), Yr(p0 + (p1 - p0) * E(u)), X(f.t0 + (f.t1 - f.t0) * v), Yr(p0 + (p1 - p0) * E(v)), RED); }
    }
    react.forEach((r, k) => cv.dot(X(r.t), Yr(al[k]), r.ncc < 0.7 ? GREY : BLUE));
  } else { const Yn = band(896, 0, 1); all.forEach(s => cv.dot(X(s.t), Yn(Math.max(0, s.ncc)), GREY)); }
  await saveSheet(cv, path.join(o.out, 'track.jpg'));

  const count = st => all.filter(s => s.status === st).length, clean = m => { const { model, ...rest } = m; return rest; };
  const whole = S.slice(1).filter(s => s.status === 'ok'), wholeNcc = whole.length >= 3 ? r3(median(whole.map(s => s.ncc))) : null;
  const lowNcc = (wholeNcc !== null && wholeNcc < 0.7) || all.filter(s => s.status === 'lost').length > 0.5 * all.length;
  const frames = { decoded, unique: all.length, ok: count('ok'), clipped: count('clipped'), lost: count('lost'), gone: count('gone'), ncc: [0, 0.1, 0.5].map(q => r3(quantile(S.map(s => s.ncc), q))), mask: maskInfo };
  const reactOut = rsum && (({ model, ...r }) => r)(rsum);
  const samples = all.map((s, k) => ({ t: r3(s.t), status: s.status, pos: s.pos.map(r2), board: [r2(s.bx), r2(s.by)], visible: s.visible, ncc: r3(s.ncc), jump: r2(s.jump), ...(react ? { react: { d: react[k].d.map(r2), sx: r3(react[k].sx), sy: r3(react[k].sy), ncc: r3(react[k].ncc) } } : {}) }));
  fs.writeFileSync(path.join(o.out, 'track.json'), JSON.stringify({ video: path.resolve(video), mode: 'move', window: [r3(a), r3(b)], crop: info.crop || null, box: c.box, react_box: react ? o.react : null, cell_px: cell, object_length_px: r2(L), ...(lowNcc ? { warning: 'object matches its first frame poorly: start --at a frame where it looks as it does while moving' } : {}), moves: moves.map(clean), react: reactOut, onsets, frames, samples, crops: sel.map(k => r3(all[k].t)) }, null, 1) + '\n');

  // Report and a Cocos sketch. Screen y points down, Cocos y up; lengths are in cells when --cell is given.
  const u = cell ? 'cells' : 'px', per = cell || 1, len = px => r2(px / per), vec3 = (v, s) => `new Vec3(${r2(v[0] * s)}, ${r2(-v[1] * s)}, 0)`;
  const row = m => m.end === 'stop'
    ? `| ${m.k} | stop | ${m.dir} | ${len(m.dist_px)} ${u} | ${m.start_s} → ${m.stop_s} (${m.duration_s} s) | avg ${m.speed_avg[cell ? 'cells_s' : 'px_s']}, peak ${m.speed_peak[cell ? 'cells_s' : 'px_s']} ${u}/s | ${m.ease_rank.map(([e, r]) => `${e} ${r}`).join(', ')} |`
    : `| ${m.k} | ${m.end} | ${m.dir} | ${m.end === 'turn' ? '' : '≥ '}${len(m.travel_seen_px)} ${u}${m.end === 'turn' ? '' : ' seen'} | ${m.start_s} → ${m.end === 'turn' ? 'turns at' : 'last seen'} ${m.last_seen_s}${m.occlusion?.under_s != null ? `, under ${m.occlusion.under_s}` : ''} | ${m.tail ? `${m.tail.speed_from[cell ? 'cells_s' : 'px_s']} → ${m.tail.speed_last[cell ? 'cells_s' : 'px_s']} ${u}/s, accel ${r2(m.tail.accel_px_s2 / per)} ${u}/s²` : '–'} | ${m.tail ? `quadratic tail rms ${m.tail.rms_px} px over ${m.tail.samples} frames; line ${m.tail.linear_rms_px}` : '–'} |`;
  const snip = ["import { Node, Vec3, tween } from 'cc';", '', cell ? `const CELL = 1; // world units per board cell (${cell} px in the video)` : 'const PX = 1; // world units per video pixel', ''];
  for (const m of moves) {
    if (m.end === 'stop') snip.push(`// Move ${m.k}: ${m.dir} ${len(m.dist_px)} ${u} in ${m.duration_s} s, ${m.ease} (runner-up ${m.ease_rank[1]?.[0] ?? '–'}).`,
      `export const move${m.k} = (n: Node) => tween(n).by(${m.duration_s}, { position: ${vec3(m.vec, len(m.dist_px))}.multiplyScalar(${cell ? 'CELL' : 'PX'}) }, { easing: '${m.ease}' });`, '');
    else if (m.tail) {
      const T0 = m.tail.from_s, T1 = m.occlusion?.under_s ?? m.last_seen_s, V = r2(m.tail.speed_from.px_s / per), A = r2(m.tail.accel_px_s2 / per), dur = r3(T1 - T0);
      snip.push(`// Move ${m.k} (${m.end}): ${m.dir} from ${T0} s at ${V} ${u}/s${m.tail.constant_speed ? ' (a constant speed fits too)' : ''}, accelerating ${A} ${u}/s²` + (m.occlusion?.under_s != null ? `; touches the edge at ${m.occlusion.contact_s} s, fully under it at ${m.occlusion.under_s} s.` : '.'),
        `export function move${m.k}(n: Node, onGone?: () => void) {`, `  const V = ${V}, A = ${A}, dir = ${vec3(m.vec, 1)}, from = n.position.clone(), p = new Vec3();`,
        `  return tween({ t: 0 }).to(${dur}, { t: ${dur} }, { onUpdate: (o: { t: number }) => {`, `    Vec3.scaleAndAdd(p, from, dir, (V * o.t + 0.5 * A * o.t * o.t) * ${cell ? 'CELL' : 'PX'});`, '    n.setPosition(p);', '  } }).call(() => onGone?.());', '}', '');
    }
  }
  if (rsum?.moved) {
    // The tween starts where the fitted ease does, which for an ease-in can be before the level crossing (the onset) and
    // even before the event; the game then has to start the knock that much earlier.
    const out = rsum.out, back = rsum.back, rel = rsum.relative_to?.out_start_s ?? null, delay = rel === null ? null : Math.max(0, rel);
    const hold = back ? back.start_s - (out.start_s + out.duration_s) : 0;
    snip.push(`// React box: pushed ${rsum.axis} ${len(rsum.peak_px)} ${u}${rel === null ? '' : rel >= 0 ? `, the fitted ease starts ${rel} s after the ${rsum.relative_to.event}` : `, the fitted ease starts ${r3(-rel)} s BEFORE the ${rsum.relative_to.event} (seen moving ${rsum.relative_to.onset_s} s after it): start it early or accept the lag`}; out ${out.duration_s} s ${out.ease}, back ${back ? `${back.duration_s} s ${back.ease}` : '(not back in the window)'}${rsum.overshoot_px ? `, overshoot ${len(rsum.overshoot_px)} ${u}` : ''}.`,
      `export const knock = (n: Node) => { const k = ${vec3(rsum.axis_vec, len(rsum.peak_px))}.multiplyScalar(${cell ? 'CELL' : 'PX'});`,
      `  return tween(n)${delay ? `.delay(${r3(delay)})` : ''}.by(${out.duration_s}, { position: k }, { easing: '${out.ease}' })${back && hold > 0.5 / info.fps ? `.delay(${r3(hold)})` : ''}${back ? `.by(${back.duration_s}, { position: k.clone().negate() }, { easing: '${back.ease}' })` : ''}; };`);
  }
  const R = rsum;
  fs.writeFileSync(path.join(o.out, 'track.md'), [
    `# Track (moves) — ${path.basename(video)} ${r2(a)}–${r2(b)} s`, '',
    `${decoded} frames, ${all.length} unique. Object found whole in ${frames.ok}, clipped in ${frames.clipped}, lost in ${frames.lost}, gone in ${frames.gone} (NCC min / p10 / median ${frames.ncc.join(' / ')}).`,
    `Positions are source pixels${info.crop ? ` of the crop ${info.crop.w}×${info.crop.h} at (${info.crop.x}, ${info.crop.y})` : ''} on the board as seen at ${r2(a)} s. Object length along each move: ${moves.map(m => `${m.k}: ${r2(m.length_px)} px${cell ? ` (${r2(m.length_px / cell)} cells of ${cell} px)` : ''}`).join(', ') || `${r2(L)} px`}.${lowNcc ? ` WARNING: the object matches its first frame poorly (median NCC of whole frames ${wholeNcc ?? 'n/a'}, lost in ${frames.lost} of ${all.length}); it may look different once it moves (a selection outline, a layer on top). Start --at a frame where it looks as it does while moving.` : ''} A move starts or stops where the fitted tween does (the object is seen leaving / arriving a little later / earlier).`, '',
    '| move | end | direction | distance | time (s) | speed | fit (rms px) |', '|---|---|---|---|---|---|---|', ...moves.map(row), '',
    ...moves.filter(m => m.occlusion).flatMap(m => [`Move ${m.k} goes out of sight: ${m.occlusion.clipped_frames} clipped frames (visible share ${(m.occlusion.visible || []).map(([t, v]) => `${t}: ${v}`).join(', ') || '–'}), last seen ${m.occlusion.last_seen_s} s, first missing ${m.occlusion.first_missing_s ?? '–'} s.`
      + (m.occlusion.edge_point ? ` Occluder edge at (${m.occlusion.edge_point.join(', ')}) px; leading edge touches it at ${m.occlusion.contact_s ?? '–'} s (tail model ${m.occlusion.contact_model_s ?? '–'}), whole object under it at ${m.occlusion.under_s ?? '–'} s${m.occlusion.contact_to_under_s != null ? ` (${m.occlusion.contact_to_under_s} s after contact, at ${cell ? m.occlusion.speed_at_contact.cells_s + ' cells/s' : m.occlusion.speed_at_contact.px_s + ' px/s'})` : ''}.` : ''), '']),
    R ? (R.moved ? `React box (${o.react}): rest offset ${R.rest_offset_px.join(', ')} px, noise ${R.noise_px} px; pushed ${R.axis} ${R.peak_px} px, onset ${R.onset_s} s, peak ${R.peak_s} s, back ${R.return_s ?? '–'} s, settled ${R.settle_s ?? '–'} s${R.relative_to ? ` (from the ${R.relative_to.event}: onset ${R.relative_to.onset_s}, peak ${R.relative_to.peak_s}, back ${R.relative_to.return_s ?? '–'} s)` : ''}; overshoot ${R.overshoot_px} px. Out ${R.out.duration_s} s (${R.out.ease_rank.map(([e, r]) => `${e} ${r}`).join(', ')}); back ${R.back ? `${R.back.duration_s} s (${R.back.ease_rank.map(([e, r]) => `${e} ${r}`).join(', ')})` : '–'}. Size ${R.scale_peak ? `peaks at ${R.scale_peak.sx} × ${R.scale_peak.sy} at ${R.scale_peak.t} s` : 'unchanged (< 2 %)'}.`
      : R.peak_px === null ? `React box (${o.react}): too few clear frames to measure.` : `React box (${o.react}): no knock-back above the noise (peak ${R.peak_px} px, noise ${R.noise_px} px).`)
      + (R.hidden ? ` Covered (NCC < 0.7, left out) in ${R.hidden.frames} frames, ${R.hidden.from_s}–${R.hidden.to_s} s: a knock inside that span is not measured.` : '') : '',
    onsets.length ? `Audio onsets in the window: ${onsets.join(', ')} s.` : '', '',
    '## Cocos Creator 3.x sketch', '', '```ts', ...snip, '```', '',
    '## track.jpg', '',
    `- Top 4 rows: ${sel.length} crops at t = ${sel.map(k => r2(all[k].t)).join(', ')}; box green = whole, orange = clipped (the whole object's box), red = lost, grey = gone; yellow = react box.`,
    '- Rows 5–6: board x, then y, over time (blue whole, orange clipped, grey gone) with the fitted moves (red); grey lines = move start / stop / last seen, orange = contact, red = fully under; yellow ticks = audio onsets.',
    `- Row 7: speed between frames (blue; grey line = ${r2(VMIN)} px/s move threshold) and the visible share (orange dots, 0–1).`,
    `- Row 8: ${react ? 'react box offset along its push (blue) with the fitted out / back (red)' : 'NCC per frame (grey, 0–1)'}.`,
  ].join('\n') + '\n');
  return { ok: true, out: o.out, mode: 'move', crop: info.crop || null, frames: { ...frames, mask: undefined }, moves: moves.map(clean), react: reactOut };
}

async function track(video, o) {
  const info = await setup(video, o), a = Number(o.at), b = Math.min(info.duration, a + Number(o.dur || 3)), { width: w, height: h } = info;
  const box = typeof o.box === 'string' ? o.box.split(',').map(Number) : [];
  if (!Number.isFinite(a) || box.length !== 4) die('track needs --at <sec> --box x0,y0,x1,y1 (fractions, the object on the frame at --at)');
  const band = (typeof o.band === 'string' ? o.band : '0.15,0.72').split(',').map(Number), win = ['-ss', String(a), '-i', video, '-t', String(b - a), '-an', '-fps_mode', 'passthrough'];
  const frames = [];
  await rawFrames([...win, '-vf', vf(info, 'format=gray'), '-f', 'rawvideo', '-'], w * h, f => frames.push(Buffer.from(f)));
  if (frames.length < 8) die('window too short');
  const { clock: frameClock, t: times } = frameTimes(video, a, b, info.fps, frames.length);
  // Screen recordings repeat frames; only the first copy has a real time.
  const uniq = [0];
  for (let i = 1; i < frames.length; i++) {
    let d = 0, n = 0;
    for (let p = 0; p < w * h; p += 7) { d += Math.abs(frames[i][p] - frames[i - 1][p]); n++; }
    if (d / n >= 0.5) uniq.push(i);
  }

  // Camera: content shift between consecutive unique frames. The object covers a few blocks, which the affine refit drops.
  const quarter = uniq.map(i => down(frames[i], w, h, 4)), pairs = [null];
  for (let k = 1; k < uniq.length; k++) pairs.push(camShift(frames[uniq[k - 1]], frames[uniq[k]], quarter[k - 1], quarter[k], w, h, band, []));

  // Object mask: follow the start box's board point with the camera (position, and the scale / shear the affine
  // shifts accumulate into J); once the object has left it, that spot is a clean plate of the board (frames from the
  // last two thirds of the window, aligned by the 25th percentile difference since the object may fill most of the
  // box, median of them). The object is what differs most from the plate (the top class of a three-way Otsu split; board
  // text and edges that moved a pixel fill the middle one), so a background change around it cannot move the match.
  const [bx0, by0, bx1, by1] = [box[0] * w, box[1] * h, box[2] * w, box[3] * h].map(Math.round), tw = bx1 - bx0, th = by1 - by0, pos0 = [bx0 + tw / 2, by0 + th / 2];
  const bp = [pos0], J = [[[1, 0], [0, 1]]], det = M2 => M2[0][0] * M2[1][1] - M2[0][1] * M2[1][0];
  for (let k = 1; k < uniq.length; k++) {
    const s = pairs[k].at(bp[k - 1]), D = pairs[k].jac, P = J[k - 1];
    bp.push([bp[k - 1][0] + s[0], bp[k - 1][1] + s[1]]);
    J.push([0, 1].map(r => [0, 1].map(c => P[r][c] + D[r][0] * P[0][c] + D[r][1] * P[1][c])));
  }
  const camScale = J.map(M2 => Math.sqrt(Math.abs(det(M2)))), camRot = J.map(M2 => Math.atan2(M2[1][0] - M2[0][1], M2[0][0] + M2[1][1]) * 180 / Math.PI);
  const B0 = new Float32Array(tw * th);
  for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) B0[v * tw + u] = frames[0][(by0 + v) * w + bx0 + u];
  const R8 = 8, inBand = p => p[0] - tw / 2 - R8 >= 0 && p[0] + tw / 2 + R8 <= w && p[1] - th / 2 - R8 >= band[0] * h && p[1] + th / 2 + R8 <= band[1] * h;
  const hist = new Uint32Array(256), sample = (g, k, dx, dy) => {
    const p = new Float32Array(tw * th), M2 = J[k];
    for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) { const ou = u + 0.5 - tw / 2, ov = v + 0.5 - th / 2; p[v * tw + u] = bilinear(g, w, h, bp[k][0] + dx + M2[0][0] * ou + M2[0][1] * ov - 0.5, bp[k][1] + dy + M2[1][0] * ou + M2[1][1] * ov - 0.5); }
    return p;
  }, lowDiff = p => {
    hist.fill(0);
    for (let q = 0; q < tw * th; q++) hist[Math.min(255, Math.abs(B0[q] - p[q]) | 0)]++;
    let c = 0, m = 0; while ((c += hist[m]) < tw * th / 4) m++; return m;
  }, otsu = vals => {
    const hs = new Float64Array(256); let sum = 0, wB = 0, sumB = 0, top = 0, thr = 0;
    for (const v of vals) { hs[Math.min(255, v | 0)]++; sum += Math.min(255, v | 0); }
    for (let i = 0; i < 256; i++) {
      wB += hs[i]; sumB += i * hs[i];
      const wF = vals.length - wB; if (!wB || !wF) continue;
      const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2; if (between > top) { top = between; thr = i + 0.5; }
    }
    return thr;
  };
  const aligned = uniq.map((i, k) => k).filter(k => times[uniq[k]] >= a + (b - a) / 3 && inBand(bp[k])).map(k => {
    let best = { m: Infinity };
    for (let dy = -R8; dy <= R8; dy++) for (let dx = -R8; dx <= R8; dx++) { const p = sample(frames[uniq[k]], k, dx, dy), m = lowDiff(p); if (m < best.m) best = { m, p }; }
    return best;
  }), plates = aligned.map(q => q.p);
  let M = null, maskInfo = { plates: plates.length, align_p25_diff: aligned.map(q => q.m) };
  if (plates.length >= 3) {
    const plate = new Float32Array(tw * th), diff = new Float32Array(tw * th);
    for (let p = 0; p < tw * th; p++) { plate[p] = median(plates.map(q => q[p])); diff[p] = Math.abs(B0[p] - plate[p]); }
    const t1 = otsu(diff), thr = Math.max(16, otsu(Array.from(diff).filter(d => d > t1)));
    const morph = (m, r, grow) => { const o = new Uint8Array(tw * th); for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) { let hit = !grow; for (let y = Math.max(0, v - r); y <= Math.min(th - 1, v + r); y++) for (let x = Math.max(0, u - r); x <= Math.min(tw - 1, u + r); x++) if (grow ? m[y * tw + x] : !m[y * tw + x]) hit = grow; o[v * tw + u] = hit ? 1 : 0; } return o; };
    const flood = (m, seeds, val) => { const lab = new Int32Array(tw * th).fill(-1), st = [...seeds]; seeds.forEach(p => lab[p] = 0); while (st.length) { const p = st.pop(), u = p % tw, v = (p - u) / tw; for (const [x, y] of [[u - 1, v], [u + 1, v], [u, v - 1], [u, v + 1]]) { const q = y * tw + x; if (x >= 0 && y >= 0 && x < tw && y < th && lab[q] < 0 && m[q] === val) { lab[q] = 0; st.push(q); } } } return lab; };
    let m = morph(morph(Uint8Array.from(diff, d => d > thr ? 1 : 0), 2, true), 2, false);
    // Largest blob, holes filled, one pixel of edge.
    let big = [], seen = new Uint8Array(tw * th);
    for (let p = 0; p < tw * th; p++) if (m[p] && !seen[p]) { const lab = flood(m, [p], 1), blob = []; lab.forEach((l, q) => { if (!l) { blob.push(q); seen[q] = 1; } }); if (blob.length > big.length) big = blob; }
    m = new Uint8Array(tw * th); big.forEach(p => m[p] = 1);
    const edge = []; for (let p = 0; p < tw * th; p++) { const u = p % tw, v = (p - u) / tw; if (!m[p] && (u === 0 || v === 0 || u === tw - 1 || v === th - 1)) edge.push(p); }
    const out = flood(m, edge, 0); for (let p = 0; p < tw * th; p++) if (out[p] < 0) m[p] = 1;
    m = morph(m, 1, true);
    const area = m.reduce((s, q) => s + q, 0) / (tw * th);
    maskInfo = { ...maskInfo, thr: r2(thr), area: r3(area) };
    if (area >= 0.05 && area <= 0.9) M = m;
    fs.mkdirSync(o.out, { recursive: true });
    const Z = 3, img = new Uint8Array(3 * tw * Z * th * Z);
    [B0, plate, m.map(q => q * 255)].forEach((src, j) => { for (let v = 0; v < th * Z; v++) for (let u = 0; u < tw * Z; u++) img[v * 3 * tw * Z + j * tw * Z + u] = Math.min(255, src[Math.floor(v / Z) * tw + Math.floor(u / Z)]); });
    const raw = path.join(o.out, 'mask.gray'); fs.writeFileSync(raw, img);
    await ffmpeg(['-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${3 * tw * Z}x${th * Z}`, '-i', raw, '-q:v', '3', path.join(o.out, 'mask.jpg')]); fs.unlinkSync(raw);
  }
  const mk = M && new Float32Array(w * h);
  if (M) for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) mk[(by0 + v) * w + bx0 + u] = M[v * tw + u];

  // Object: masked NCC. The camera shift plus the object's last board velocity predicts this frame's position; a
  // coarse search over tilt and size at half res (wider after misses) scores NCC minus a distance penalty, then tilt, size and aspect
  // (squash) are refined at full res. Below LOST, or a weak match (under 0.85 of the recent median, at most 0.75) that
  // jumps more than half the box from the prediction (a distractor while the object is covered), the frame keeps the
  // prediction and is left out of the fits. (Without the 0.75 cap a hop's takeoff, fast and blurred, reads as lost.)
  // A moving object that runs under something (a gate, the board edge) loses its leading part first. When the full
  // match weakens while it moves, the last full template cut down to its trailing 90 % … 30 % along the motion is
  // matched near the prediction; the largest part that fits nearly as well as the best one is the visible share
  // (clipped, the position is still the whole object's center). When no part is left after a clipped frame the
  // object is gone for the rest of the window: a later match, however good, is never taken for it.
  const LOST = Number(o.lost || 0.5), JUMP = 0.5 * Math.max(tw, th), DEG = Math.PI / 180, ROT = Array.from({ length: 11 }, (_, k) => (k - 5) * 6), SC = [0.8, 0.9, 1, 1.1], SF = [0.95, 1, 1.05], AS = [0.68, 0.76, 0.84, 0.92, 1, 1.08, 1.16, 1.24, 1.32];
  const VMIN = 1.5 * info.fps, LADDER = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  const h0 = down(frames[0], w, h, 2), mk2 = mk && down(mk, w, h, 2).d;
  const coarse = [-24, -12, 0, 12, 24].flatMap(r => SC.map(sc => ({ r, sc, t: template(h0.d, h0.w, h0.h, pos0[0] / 2, pos0[1] / 2, tw / 2, th / 2, sc, sc, r * DEG, mk2) })));
  const fine = new Map(ROT.flatMap(r => SC.map(sc => [`${r}|${sc}`, SF.flatMap(f => AS.map(as => template(frames[0], w, h, pos0[0], pos0[1], tw, th, sc * f, sc * f * as, r * DEG, mk)))])));
  const peakOf = (vals, grid) => { const k = vals.indexOf(Math.max(...vals)); return k === 0 || k === vals.length - 1 ? grid[k] : grid[k] + (grid[1] - grid[0]) * vertex(vals[k - 1], vals[k], vals[k + 1]); };
  const cuts = new WeakMap(), cutOf = (tp, q, f) => {
    let m = cuts.get(tp);
    if (!m) cuts.set(tp, m = new Map());
    if (!m.has(`${q}|${f}`)) {
      const p = spanAlong(tp, dirOf(q)), keep = [];
      for (let k = 0; k < p.along.length; k++) if (p.along[k] <= p.lo + f * (p.hi - p.lo)) keep.push(k);
      const z = Float32Array.from(keep, k => tp.z[k]), mean = z.reduce((s2, x) => s2 + x, 0) / Math.max(1, z.length);
      let n2 = 0;
      for (let k = 0; k < z.length; k++) { z[k] -= mean; n2 += z[k] * z[k]; }
      m.set(`${q}|${f}`, keep.length >= 24 && n2 > 1e-3 ? { w: tp.w, h: tp.h, z, n2, pu: Int16Array.from(keep, k => tp.pu ? tp.pu[k] : k % tp.w), pv: Int16Array.from(keep, k => tp.pv ? tp.pv[k] : Math.floor(k / tp.w)) } : null);
    }
    return m.get(`${q}|${f}`);
  };
  const searchAt = (g, tp, C, R) => {
    const x0 = Math.round(C[0] - tp.w / 2), y0 = Math.round(C[1] - tp.h / 2);
    let m = { v: -2, x: x0, y: y0 };
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const v = ncc(g, w, h, tp, x0 + dx, y0 + dy); if (v > m.v) m = { v, x: x0 + dx, y: y0 + dy }; }
    const at = (dx, dy) => ncc(g, w, h, tp, m.x + dx, m.y + dy);
    return { v: m.v, pos: [m.x + vertex(at(-1, 0), m.v, at(1, 0)) + tp.w / 2, m.y + vertex(at(0, -1), m.v, at(0, 1)) + tp.h / 2] };
  };
  // Hop rules (a hop's takeoff is fast and blurred, and never runs under anything) keep the 0.75 cap and skip the part
  // search; move rules drop the cap and add it. Auto mode tracks with hop rules first and retracks if it finds no hops.
  const G = [[0, 0]];
  const trackAll = rules => {
    const all = [], moving = rules === 'move';
    let gone = false, tpl = null;
    for (let k = 0; k < uniq.length; k++) {
      const i = uniq[k], g = frames[i], t = times[i];
      let pred = pos0, vel = [0, 0];
      if (k) {
        const prev = all[k - 1], s = pairs[k].at(prev.pos), good = all.filter(q => !q.lost).slice(-2);
        G[k] = [G[k - 1][0] + s[0], G[k - 1][1] + s[1]];
        const [p, q] = good.length === 2 ? good : [good[0] ?? prev, good[0] ?? prev];
        if (q !== p && !prev.lost) vel = [(q.bx - p.bx) / (q.t - p.t), (q.by - p.by) / (q.t - p.t)];
        pred = [G[k][0] + q.bx + vel[0] * (t - q.t), G[k][1] + q.by + vel[1] * (t - q.t)];
      }
      const base = { i, t, G: G[k], cam_scale: camScale[k], cam_rot: camRot[k], J: J[k] };
      if (gone) {
        all.push({ ...base, pos: pred, lost: true, status: 'gone', visible: 0, ncc: 0, jump: 0, rot: 0, bx: pred[0] - G[k][0], by: pred[1] - G[k][1], rect: [pred[0] - tw / 2, pred[1] - th / 2, tw, th].map(Math.round), scale: 1, aspect: 1 });
        continue;
      }
      const hf = down(g, w, h, 2);
      let miss = 0; while (miss < k && all[k - 1 - miss].lost) miss++;
      const RC = Math.min(96, 48 + 16 * miss);
      let c = { score: -9 };
      for (const { r, sc, t: tp } of coarse) for (let dy = -RC; dy <= RC; dy++) for (let dx = -RC; dx <= RC; dx++) {
        const x = Math.round(pred[0] / 2 - tp.w / 2) + dx, y = Math.round(pred[1] / 2 - tp.h / 2) + dy, v = ncc(hf.d, hf.w, hf.h, tp, x, y), score = v - 0.1 * (dx * dx + dy * dy) / (RC * RC);
        if (score > c.score) c = { score, v, r, sc, p: [(x + tp.w / 2) * 2, (y + tp.h / 2) * 2] };
      }
      const best = ROT.filter(r => Math.abs(r - c.r) <= 6).flatMap(r => fine.get(`${r}|${c.sc}`).map((tp, j) => {
        let m = { v: -2 };
        const x0 = Math.round(c.p[0] - tp.w / 2), y0 = Math.round(c.p[1] - tp.h / 2);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const v = ncc(g, w, h, tp, x0 + dx, y0 + dy); if (v > m.v) m = { v, x: x0 + dx, y: y0 + dy }; }
        return { r, f: Math.floor(j / AS.length), a: j % AS.length, t: tp, ...m };
      }));
      const top = best.reduce((p, q) => q.v > p.v ? q : p), at = (dx, dy) => ncc(g, w, h, top.t, top.x + dx, top.y + dy), mine = best.filter(q => q.r === top.r);
      const hit = [top.x + vertex(at(-1, 0), top.v, at(1, 0)) + top.t.w / 2, top.y + vertex(at(0, -1), top.v, at(0, 1)) + top.t.h / 2], jump = Math.hypot(hit[0] - pred[0], hit[1] - pred[1]);
      const m = median(all.filter(q => !q.lost).slice(-10).map(q => q.ncc));
      let lost = top.v < LOST || (top.v < (moving ? 0.85 * m : Math.min(0.75, 0.85 * m)) && jump > JUMP), pos = lost ? pred : hit, status = lost ? 'lost' : 'ok', visible = lost ? 0 : 1, ncc0 = top.v, rect = lost ? null : [top.x, top.y, top.t.w, top.t.h];
      if (moving && tpl && Math.hypot(...vel) > VMIN && (lost || top.v < 0.9 * m)) {
        // A part must beat a whole match that still counts by 0.05: a small template near the prediction also fits board
        // texture a little better than a blurred or tilted object does.
        const q = ((Math.round(Math.atan2(vel[1], vel[0]) / (Math.PI / 8)) % 16) + 16) % 16;
        const parts = LADDER.map(f => { const cp = cutOf(tpl, q, f); return cp && { f, ...searchAt(g, cp, pred, 10) }; }).filter(Boolean);
        const bt = parts.reduce((p, r) => r.v > p.v ? r : p, { v: -2 });
        if (bt.v >= Math.max(LOST, 0.85 * m, lost ? -1 : top.v + 0.05)) {
          const vis = parts.filter(r => r.v >= bt.v - 0.04 && Math.hypot(r.pos[0] - bt.pos[0], r.pos[1] - bt.pos[1]) <= 3).reduce((p, r) => r.f > p.f ? r : p);
          lost = false; status = 'clipped'; visible = vis.f; pos = vis.pos; ncc0 = vis.v; rect = [pos[0] - tpl.w / 2, pos[1] - tpl.h / 2, tpl.w, tpl.h].map(Math.round);
        } else if (k && all[k - 1].status === 'clipped') { gone = lost = true; status = 'gone'; visible = 0; pos = pred; rect = null; }
      }
      if (status === 'ok') tpl = top.t;
      all.push({ ...base, pos, lost, status, visible, ncc: ncc0, jump, rot: top.r, bx: pos[0] - G[k][0], by: pos[1] - G[k][1], dir: Math.atan2(vel[1], vel[0]),
        rect: rect || [pos[0] - tw / 2, pos[1] - th / 2, tw, th].map(Math.round),
        scale: c.sc * peakOf(SF.map((_, f) => Math.max(...mine.filter(q => q.f === f).map(q => q.v))), SF),
        aspect: peakOf(AS.map((_, a) => Math.max(...mine.filter(q => q.a === a).map(q => q.v))), AS) });
    }
    // An object that leaves sight in one step (no clipped frame): it was moving fast when last seen, and nothing is found
    // after, or only something far from there that barely moves (a look-alike). From that frame on it is gone.
    for (let k = 1; moving && k < all.length; k++) {
      if (!all[k].lost || all[k - 1].lost) continue;
      const [p, q] = all.slice(0, k).filter(s => !s.lost).slice(-2);
      if (!q || p === q) continue;
      const vp = Math.hypot(q.bx - p.bx, q.by - p.by) / (q.t - p.t), [r, s] = all.slice(k).filter(x => !x.lost);
      if (vp <= 2 * VMIN) continue;
      const far = r && Math.hypot(r.bx - q.bx, r.by - q.by) > JUMP, still = !s || Math.hypot(s.bx - r.bx, s.by - r.by) / (s.t - r.t) < 0.25 * vp;
      if (r && !(far && still)) continue;
      for (let j = k; j < all.length; j++) Object.assign(all[j], { lost: true, status: 'gone', visible: 0, bx: q.bx, by: q.by, pos: [all[j].G[0] + q.bx, all[j].G[1] + q.by] });
      break;
    }
    return all;
  };
  let all = trackAll(o.mode === 'move' ? 'move' : 'hop');
  // S: the frames where the object was found (whole or clipped); the camera path uses every frame.
  let S = all.filter(s => !s.lost);

  // Landings from motion: the lowest screen point (max board y) the object dropped into. A real hop drops a good share
  // of a typical hop's height; jitter under a popup or during a squash drops a few pixels.
  let land = [];
  for (let k = 1; k < S.length - 1; k++) {
    const near = S.filter(s => Math.abs(s.t - S[k].t) <= 0.1), drop = Math.max(0, ...near.filter(s => s.t < S[k].t).map(s => S[k].by - s.by));
    if (!near.every(s => s.by <= S[k].by) || drop <= 3) continue;
    const [p, q, r] = [S[k - 1], S[k], S[k + 1]], den = (p.t - q.t) * (p.t - r.t) * (q.t - r.t);
    const A2 = (r.t * (q.by - p.by) + q.t * (p.by - r.by) + p.t * (r.by - q.by)) / den, B2 = (r.t ** 2 * (p.by - q.by) + q.t ** 2 * (r.by - p.by) + p.t ** 2 * (q.by - r.by)) / den;
    land.push({ t: A2 < 0 ? Math.max(p.t, Math.min(r.t, -B2 / (2 * A2))) : q.t, drop });
  }
  const deep = quantile(land.map(x => x.drop), 0.75);
  land = land.filter(x => x.drop >= 0.35 * deep);
  // Two landings closer than 0.6 of the median gap are a landing and a wobble; the deeper drop is the landing.
  const gap0 = median(land.slice(1).map((x, k) => x.t - land[k].t));
  land = land.reduce((out, x) => { const q = out[out.length - 1]; if (q && x.t - q.t < 0.6 * gap0) { if (x.drop > q.drop) out[out.length - 1] = x; } else out.push(x); return out; }, []).map(x => x.t);
  // A hop rises between landings; a slide that ends lower on screen only drops. Auto mode keeps the hop fit for arcs.
  const byAt = t => { let k = 1; while (k < S.length - 1 && S[k].t < t) k++; const p = S[k - 1], q = S[k]; return p.by + (q.by - p.by) * Math.max(0, Math.min(1, (t - p.t) / (q.t - p.t || 1))); };
  const rise = land.slice(1).map((t, j) => Math.max(0, ...S.filter(s => s.t > land[j] && s.t < t).map(s => byAt(land[j]) + (byAt(t) - byAt(land[j])) * (s.t - land[j]) / (t - land[j]) - s.by)));
  const mode = o.mode === 'hop' || o.mode === 'move' ? o.mode : land.length >= 3 && median(rise) > 3 ? 'hop' : 'move';
  const react = typeof o.react === 'string' ? reactTrack(frames, uniq, times, G, o.react.split(',').map(Number), w, h) : null;
  if (mode === 'move') {
    if (o.mode !== 'move') { all = trackAll('move'); S = all.filter(s => !s.lost); }
    const tp = fine.get('0|1')[SF.indexOf(1) * AS.length + AS.indexOf(1)], mv = S.length >= 2 ? [S[S.length - 1].bx - S[0].bx, S[S.length - 1].by - S[0].by] : [1, 0], sp = spanAlong(tp, [mv[0] / (Math.hypot(...mv) || 1), mv[1] / (Math.hypot(...mv) || 1) || 0]);
    const lenAlong = d => { const q = spanAlong(tp, d); return q.hi - q.lo + 1; };
    return moveTrack({ video, o, info, a, b, win, all, S, VMIN, L: sp.hi - sp.lo + 1, lenAlong, react, decoded: frames.length, maskInfo, box });
  }
  if (land.length < 3) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, 'track.json'), JSON.stringify({ error: 'too few landings', mask: maskInfo, samples: all.map(s => ({ t: r3(s.t), pos: s.pos.map(r2), board: [r2(s.bx), r2(s.by)], ncc: r3(s.ncc), jump: r2(s.jump), lost: s.lost, scale: r3(s.scale), cam_scale: r3(s.cam_scale) })) }, null, 1) + '\n');
    die(`only ${land.length} landings found; check --box or widen --dur (samples in track.json)`);
  }
  // Hop clocks: motion landings, their audio onsets, and a regular grid through those onsets (audio lands on buffer ticks).
  const onsets = info.audio ? (await audioOnsets(video)).filter(x => x.t >= a - 1.5 && x.t <= b).map(x => x.t) : [];
  const heard = [...new Set(land.map(m => onsets.reduce((p, x) => Math.abs(x - m) < Math.abs(p - m) ? x : p, Infinity)).filter((x, j) => Math.abs(x - land[j]) < 0.15))].sort((x, y) => x - y);
  const clocks = { motion: land };
  if (heard.length >= 3) {
    const gap = median(heard.slice(1).map((t, k) => t - heard[k])), ks = heard.map(t => Math.round((t - heard[0]) / gap));
    const mk = ks.reduce((s, k) => s + k, 0) / ks.length, mt = heard.reduce((s, t) => s + t, 0) / heard.length;
    const per = ks.reduce((s, k, j) => s + (k - mk) * (heard[j] - mt), 0) / ks.reduce((s, k) => s + (k - mk) ** 2, 0);
    clocks.regular = Array.from({ length: ks[ks.length - 1] + 1 }, (_, k) => mt + (k - mk) * per);
    clocks.onsets = clocks.regular.map(t => { const x = onsets.reduce((p, y) => Math.abs(y - t) < Math.abs(p - t) ? y : p, Infinity); return Math.abs(x - t) < 0.4 * per ? x : t; });
  }
  // Audio onsets are exact to one buffer (~23 ms); motion landings carry the tracker's jitter (a squash or a popup
  // shifts the lowest point). The fit runs on the heard clocks when there are any, on motion otherwise.
  const byClock = {};
  for (const [cn, base] of Object.entries(clocks)) for (let j = -16; j <= 16; j++) {
    const L = base.map(t => t + j * 0.005);
    for (const [en, E] of Object.entries(EASE)) for (const [an, A] of Object.entries(arcsFor(E))) {
      const f = fitHops(S, L, E, A);
      if (!byClock[cn] || f.rms < byClock[cn].rms) byClock[cn] = { ...f, clock: cn, delta: j * 0.005, ease: en, arc: an, L };
    }
  }
  const fit = Object.entries(byClock).filter(([cn]) => !clocks.regular || cn !== 'motion').map(([, f]) => f).reduce((p, q) => q.rms < p.rms ? q : p);
  const L = fit.L, n = L.length - 1, E = EASE[fit.ease], A = arcsFor(E)[fit.arc];
  const rank = (keys, f) => keys.map(k => [k, r2(f(k).rms)]).sort((x, y) => x[1] - y[1]);
  const easeRank = rank(Object.keys(EASE), k => fitHops(S, L, EASE[k], fit.arc === 'eased' ? arcsFor(EASE[k]).eased : A)), arcRank = rank(Object.keys(arcsFor(E)), k => fitHops(S, L, E, arcsFor(E)[k]));
  const hops = fit.H.map((H, j) => { const D = [fit.Q[j + 1][0] - fit.Q[j][0], fit.Q[j + 1][1] - fit.Q[j][1]], len = Math.hypot(...D);
    return { k: j + 1, t0: r3(L[j]), t1: r3(L[j + 1]), d_px: D.map(r2), len_px: r2(len), height_px: r2(H), ratio: r3(H / len), slope: r3(Math.abs(D[1] / D[0])), samples: fit.pts.filter(p => p.k === j + 1).length }; });
  const hopDur = median(L.slice(1).map((t, k) => t - L[k])), ratio = median(hops.map(q => q.ratio)), sinT = Math.min(0.99, median(hops.map(q => q.slope)));
  // World height / tile length if the board is a 45° yaw orthographic view pitched so |dy/dx| = sin(pitch).
  const worldRatio = ratio * Math.sqrt(0.5 * (1 + sinT * sinT)) / Math.sqrt(1 - sinT * sinT);
  const folded = fit.pts.map(({ s, k, u }) => { const P = fit.Q[k - 1], D = [fit.Q[k][0] - P[0], fit.Q[k][1] - P[1]], sv = (s.bx - P[0]) / D[0];
    return { u: r3(u), s: r3(sv), h: r3(-((s.by - P[1]) - sv * D[1]) / Math.hypot(...D)), k }; });

  // Sequence timing: takeoff from motion, the dice / reward sounds are the unmatched onsets either side.
  const move = S.findIndex(s => Math.hypot(s.bx - S[0].bx, s.by - S[0].by) > 2);
  const takeoff = move > 0 ? (S[move - 1].t + S[move].t) / 2 : null, t0 = takeoff ?? L[0] - hopDur;
  const matched = t => clocks.onsets && clocks.onsets.slice(1).some(x => Math.abs(x - t) < 0.02);
  const dice = onsets.filter(t => t < t0 && !matched(t)).pop(), reward = onsets.find(t => t > L[n] + 0.02 && !matched(t));
  const phase = t => { if (t < L[0] || t > L[n]) return null; let k = 1; while (k < n && t > L[k]) k++; return (t - L[k - 1]) / (L[k] - L[k - 1]); };
  // Squash is read from the aspect (height / width scale), so the size drift of perspective and zoom cancels.
  const bin = f => { const q = S.filter(s => { const u = phase(s.t); return u !== null && f(u); }); return q.length ? { n: q.length, aspect: r3(median(q.map(s => s.aspect))), min_aspect: r3(Math.min(...q.map(s => s.aspect))), scale: r3(median(q.map(s => s.scale))) } : null; };
  const atLand = bin(u => u < 0.12 || u > 0.88), inAir = bin(u => u > 0.3 && u < 0.7);
  const squash = atLand && inAir ? atLand.aspect / inAir.aspect : 1, squashed = squash < 0.97;

  // Camera follow: target is the measured object path, or the fitted ground path (arc removed).
  const ts = all.map(s => s.t), cm = all.map(s => [-s.G[0], -s.G[1]]);
  const interp = (tt, vs, t) => { if (t <= tt[0]) return vs[0]; if (t >= tt[tt.length - 1]) return vs[vs.length - 1]; let k = 1; while (tt[k] < t) k++; const f = (t - tt[k - 1]) / (tt[k] - tt[k - 1]); return vs[k - 1].map((v, j) => v + (vs[k][j] - v) * f); };
  const start = [S[0].bx, S[0].by], ground = t => {
    if (t <= t0) return start;
    if (t < L[0]) { const e = E((t - t0) / (L[0] - t0)); return [start[0] + (fit.Q[0][0] - start[0]) * e, start[1] + (fit.Q[0][1] - start[1]) * e]; }
    if (t >= L[n]) return fit.Q[n];
    let k = 1; while (k < n && t > L[k]) k++;
    const e = E((t - L[k - 1]) / (L[k] - L[k - 1])), P = fit.Q[k - 1], Q = fit.Q[k];
    return [P[0] + (Q[0] - P[0]) * e, P[1] + (Q[1] - P[1]) * e];
  };
  const follow = { object: followFit(ts, cm, t => interp(S.map(s => s.t), S.map(s => [s.bx, s.by]), t)), ground: followFit(ts, cm, ground) };
  const camBest = Object.entries(follow).flatMap(([tg, ms]) => Object.entries(ms).map(([m, v]) => ({ target: tg, model: m, ...v }))).sort((x, y) => x.rms - y.rms)[0];
  const travel = Math.max(...cm.map(c => Math.hypot(c[0] - cm[0][0], c[1] - cm[0][1])));

  const spec = {
    hop: { duration_s: r3(hopDur), arc_tile_ratio: r2(ratio), ease: fit.ease, land_squash: squashed ? { scale_x: r2(1 / Math.sqrt(squash)), scale_y: r2(Math.sqrt(squash)) } : 'none (< 3 %)' },
    sequence: { dice_to_first_hop_s: dice !== undefined && takeoff !== null ? r2(takeoff - dice) : null, steps: L.filter(x => takeoff === null || x > takeoff + hopDur / 2).length, last_hop_to_reward_s: reward !== undefined ? r2(reward - L[n]) : null },
    camera: { mode: 'follow', lag_s: r2(camBest.p) },
  };
  const detail = {
    frames: { decoded: frames.length, unique: all.length, lost: all.length - S.length, clock: frameClock, ncc: [0, 0.1, 0.5].map(q => r3(quantile(all.map(s => s.ncc), q))), rot_deg: [r2(Math.min(...S.map(s => s.rot))), r2(Math.max(...S.map(s => s.rot)))],
      mask: maskInfo, cam_scale_end: r3(camScale[camScale.length - 1]),
      cam_inliers_min: Math.min(...pairs.slice(1).map(p => p.inliers)), cam_spread_px: [r2(median(pairs.slice(1).map(p => p.spread))), r2(Math.max(...pairs.slice(1).map(p => p.spread)))] },
    clock: { source: fit.clock, delta_s: r3(fit.delta), rms_px_by_clock: Object.fromEntries(Object.entries(byClock).map(([cn, f]) => [cn, r2(f.rms)])), landings: L.map(r3), motion_landings: land.map(r3), onsets: onsets.map(r3), takeoff_s: takeoff === null ? null : r3(takeoff), dice_onset: dice ?? null, reward_onset: reward ?? null },
    fit: { rms_px: r2(fit.rms), ease_rank: easeRank.slice(0, 4), arc: fit.arc, arc_rank: arcRank, arc_world_ratio_est: r2(worldRatio), board_slope: r3(sinT) },
    squash: { landing: atLand, air: inAir },
    camera: { model: camBest.model, target: camBest.target, param_s: r3(camBest.p), rms_px: r2(camBest.rms), travel_px: r2(travel),
      gain: camBest.gain ? camBest.gain.map(row => row.map(r2)) : null,
      by_model: Object.fromEntries(Object.entries(follow).map(([tg, ms]) => [tg, Object.fromEntries(Object.entries(ms).map(([m, v]) => [m, { param_s: r3(v.p), rms_px: r2(v.rms), ...(v.gain ? { gain: v.gain.map(row => row.map(r2)) } : {}) }]))])),
      lerp_per_frame_60fps: camBest.model.startsWith('lerp') ? r3(1 - Math.exp(-1 / (60 * camBest.p))) : null,
      zoom_end: [0, 1].map(c => r3(Math.hypot(J[J.length - 1][0][c], J[J.length - 1][1][c]))), roll_end_deg: r2(camRot[camRot.length - 1]),
      framing: { start: [r3(S[0].pos[0] / w), r3(S[0].pos[1] / h)], end: [r3(S[S.length - 1].pos[0] / w), r3(S[S.length - 1].pos[1] / h)] } },
    hops,
    react: react ? (({ model, ...r }) => r)(reactSummary(react, takeoff ?? a + 0.2 * (b - a), 1 / (4 * info.fps))) : null,
  };

  // Verification sheet: 32 crops with the matched box, the folded ease and arc, and the camera against the object.
  fs.mkdirSync(o.out, { recursive: true });
  const { cv, sel } = await cropSheet(win, info, all, (cv, s, dx, dy) => { cv.frame(s.rect[0] + dx, s.rect[1] + dy, s.rect[2], s.rect[3], BOX_COLOR[s.status]); cv.dot(s.pos[0] + dx, s.pos[1] + dy, RED, 2); });
  const plot = (x0, y0, pw, ph, yr) => ({ X: u => x0 + 16 + u * (pw - 32), Y: v => y0 + ph - 16 - (v - yr[0]) / (yr[1] - yr[0]) * (ph - 32) });
  const ps = plot(0, 512, 512, 256, [-0.2, 1.2]), hmax = Math.max(0.3, ...folded.map(q => q.h)) * 1.15, ph = plot(512, 512, 512, 256, [-0.1, hmax]);
  for (const [p, lo, hi] of [[ps, 0, 1], [ph, 0, 0]]) { cv.line(p.X(0), p.Y(lo), p.X(1), p.Y(lo), GREY); cv.line(p.X(0), p.Y(hi), p.X(1), p.Y(hi), GREY); cv.line(p.X(0), p.Y(lo), p.X(0), p.Y(p === ps ? 1 : hmax / 1.15), GREY); cv.line(p.X(1), p.Y(lo), p.X(1), p.Y(p === ps ? 1 : hmax / 1.15), GREY); }
  cv.line(ps.X(0), ps.Y(0), ps.X(1), ps.Y(1), GREY);
  for (let k = 0; k < 200; k++) { const u0 = k / 200, u1 = (k + 1) / 200; cv.line(ps.X(u0), ps.Y(E(u0)), ps.X(u1), ps.Y(E(u1)), RED); cv.line(ph.X(u0), ph.Y(ratio * A(u0)), ph.X(u1), ph.Y(ratio * A(u1)), RED); }
  for (const q of folded) { cv.dot(ps.X(q.u), ps.Y(q.s), BLUE); cv.dot(ph.X(q.u), ph.Y(q.h), BLUE); }
  const off = camBest.offset, series = [0, 1].map(ax => [...S.map(s => ax ? s.by : s.bx), ...cm.map(c => c[ax] - off[ax])]);
  [0, 1].forEach(ax => {
    const lo = Math.min(...series[ax]), hi = Math.max(...series[ax]) + 1e-6, y0 = 768 + ax * 128, X = t => 8 + (t - a) / (b - a) * 1008, Y = v => y0 + 120 - (v - lo) / (hi - lo) * 112;
    for (const t of L) cv.line(X(t), y0 + 4, X(t), y0 + 124, GREY);
    for (const t of onsets) cv.line(X(t), y0 + 2, X(t), y0 + 10, YEL);
    camBest.fitted.forEach((c, i) => { if (i) cv.line(X(ts[i - 1]), Y(camBest.fitted[i - 1][ax] - off[ax]), X(ts[i]), Y(c[ax] - off[ax]), GREEN); });
    all.forEach((s, i) => cv.dot(X(s.t), Y(cm[i][ax] - off[ax]), RED));
    S.forEach(s => cv.dot(X(s.t), Y(ax ? s.by : s.bx), BLUE));
  });
  await saveSheet(cv, path.join(o.out, 'track.jpg'));

  const samples = all.map(s => ({ t: r3(s.t), status: s.status, pos: s.pos.map(r2), board: [r2(s.bx), r2(s.by)], cam: s.G.map(v => r2(-v)), ncc: r3(s.ncc), jump: r2(s.jump), lost: s.lost, rot: s.rot, scale: r3(s.scale), cam_scale: r3(s.cam_scale), cam_rot: r2(s.cam_rot), cam_J: s.J.flat().map(r3), aspect: r3(s.aspect) }));
  fs.writeFileSync(path.join(o.out, 'track.json'), JSON.stringify({ video: path.resolve(video), window: [r3(a), r3(b)], box, spec, detail, folded, samples, crops: sel.map(k => r3(all[k].t)) }, null, 1) + '\n');
  const p = fit.arc.startsWith('parabola@') ? Number(fit.arc.split('@')[1]) : null;
  const arcExpr = fit.arc === 'eased' ? `4 * easing.${fit.ease}(u) * (1 - easing.${fit.ease}(u))` : p === null ? 'Math.sin(Math.PI * u)' : Math.abs(p - 0.5) < 1e-6 ? '4 * u * (1 - u)' : `u < ${p} ? 1 - ((${p} - u) / ${p}) ** 2 : 1 - ((u - ${p}) / ${r3(1 - p)}) ** 2`;
  const gx = camBest.gain && camBest.gain.map(row => row.map(r2)), goal = gx ? `[${gx[0][0]} * dx + ${gx[0][1]} * dy, ${gx[1][0]} * dx + ${gx[1][1]} * dy] + start` : 'target + offset';
  const camLine = (gx ? `(dx, dy) = target - target at the start (screen px on the board plane); ` : '') + (camBest.model.startsWith('lerp') ? `cam += (${goal} - cam) * (1 - Math.exp(-dt / ${r3(camBest.p)}))  // ${detail.camera.lerp_per_frame_60fps} per frame at 60 fps`
    : camBest.model.startsWith('spring') ? `critically damped spring toward ${goal}, smoothTime ${r3(camBest.p)} s (Unity SmoothDamp)` : `cam = target(t - ${r3(camBest.p)} s) + offset`);
  fs.writeFileSync(path.join(o.out, 'track.md'), [
    `# Track — ${path.basename(video)} ${r2(a)}–${r2(b)} s`, '',
    `${frames.length} frames, ${all.length} unique (repeats dropped). Object by NCC over tilt ${detail.frames.rot_deg.join('..')}° (min / p10 / median ${detail.frames.ncc.join(' / ')}; ${detail.frames.lost} lost, left out of the fits); camera by affine block matching (parallax spread median / max ${detail.frames.cam_spread_px.join(' / ')} px).`,
    `Positions are source pixels on the board plane as seen at ${r2(a)} s. Hops are fitted jointly on the ${fit.clock} clock shifted ${r3(fit.delta)} s (rms ${r2(fit.rms)} px).`, '',
    '```json', JSON.stringify(spec, null, 2), '```', '',
    '| measure | value |', '|---|---|',
    `| ease ranking (rms px) | ${easeRank.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
    `| arc | ${fit.arc}; ranking ${arcRank.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
    `| arc height / tile (screen) | ${r2(ratio)} (per hop ${hops.map(q => r2(q.ratio)).join(' ')}) |`,
    `| arc height / tile (world, est.) | ${r2(worldRatio)}, assuming a 45° yaw orthographic view with board slope ${r3(sinT)} |`,
    `| tile length (screen px) | ${hops.map(q => Math.round(q.len_px)).join(' ')} |`,
    `| aspect (h/w scale) landing vs air | ${atLand ? `${atLand.aspect} (n ${atLand.n}, min ${atLand.min_aspect})` : '–'} vs ${inAir ? `${inAir.aspect} (n ${inAir.n})` : '–'}; size ${atLand?.scale ?? '–'} vs ${inAir?.scale ?? '–'} |`,
    `| camera | ${camBest.model} on the ${camBest.target} path, ${r3(camBest.p)} s, rms ${r2(camBest.rms)} px over ${Math.round(travel)} px of travel${gx ? `; gain [[${gx[0].join(', ')}], [${gx[1].join(', ')}]] (1 on the diagonal = locked follow)` : ''} |`,
    `| camera zoom / roll at the end | x ${detail.camera.zoom_end[0]}, y ${detail.camera.zoom_end[1]} (unequal = pitch or perspective change); roll ${detail.camera.roll_end_deg}° |`,
    `| framing (object center, screen fraction) | start ${detail.camera.framing.start.join(', ')}; end ${detail.camera.framing.end.join(', ')} |`,
    ...(detail.react ? [`| react box (${o.react}) | ${detail.react.moved ? `pushed ${detail.react.axis} ${detail.react.peak_px} px, onset ${detail.react.onset_s} s, peak ${detail.react.peak_s} s, back ${detail.react.return_s ?? '–'} s; out ${detail.react.out.ease}, back ${detail.react.back?.ease ?? '–'}` : `no knock-back above ${detail.react.noise_px} px noise`} |`] : []), '',
    '## Cocos Creator 3.x sketch', '', '```ts',
    "import { Node, Vec3, easing, tween } from 'cc';", '',
    `const HOP_S = ${r3(hopDur)}, ARC = ${r2(worldRatio)}; // ARC: world height / tile length on a 3D board; use ${r2(ratio)} on a 2D iso board`,
    `const arc = (u: number) => ${arcExpr};`, '',
    'export function hop(token: Node, from: Vec3, to: Vec3) {',
    '  const h = Vec3.distance(from, to) * ARC, p = new Vec3();',
    '  return tween({ u: 0 }).to(HOP_S, { u: 1 }, { onUpdate: (o: { u: number }) => {',
    `    Vec3.lerp(p, from, to, easing.${fit.ease}(o.u));`,
    '    p.y += h * arc(o.u);',
    '    token.setPosition(p);',
    '  } });',
    '}',
    `// Sequence: first hop ${spec.sequence.dice_to_first_hop_s ?? '?'} s after the dice sound, one landing every ${r3(hopDur)} s, reward ${spec.sequence.last_hop_to_reward_s ?? '?'} s after the last landing.`,
    `// Camera (lateUpdate): ${camLine}`,
    squashed ? `// Landing squash: scale (${spec.hop.land_squash.scale_x}, ${spec.hop.land_squash.scale_y}) at touchdown (area kept; only the aspect is measured).` : '// No landing squash measured (< 3 %).',
    '```', '',
    '## track.jpg', '',
    `- Top 4 rows: ${sel.length} crops, row-major at t = ${sel.map(k => r2(all[k].t)).join(', ')}; green box = matched template (red = lost, predicted from the camera), red dot = center.`,
    '- Middle left: ground progress s against hop phase u (blue), fitted easing (red), linear (grey).',
    '- Middle right: height above the ground line / tile length against u (blue), fitted arc (red).',
    '- Bottom: board x (upper band) and y (lower band) over time: object (blue), camera + framing offset (red), follow model (green), landings (grey), audio onsets (yellow ticks).',
  ].join('\n') + '\n');
  return { ok: true, out: o.out, spec, frames: detail.frames, fit: detail.fit, camera: { model: camBest.model, target: camBest.target, param_s: r3(camBest.p), rms_px: r2(camBest.rms), travel_px: r2(travel) }, clock: { source: fit.clock, delta_s: r3(fit.delta), landings: L.length } };
}

const o = args(process.argv.slice(2)), [cmd, video] = o._;
const commands = { fetch: fetchUrl, signals, strips, zoom, overview, track };
if (!commands[cmd] || !video || o.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split("\n").slice(2, 12).map(l => l.replace(/^ \* ?/, '')).join('\n')); process.exit(commands[cmd] ? 0 : 1); }
if (cmd !== 'zoom' && typeof o.out !== 'string') die(`${cmd} needs --out <dir>`);
commands[cmd](video, o).then(r => console.log(JSON.stringify(r, null, 2)), e => die(e.stack || String(e)));
