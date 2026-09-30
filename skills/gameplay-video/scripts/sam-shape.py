"""SAM 2 shape pass: the full outline of the object a video-probe track followed, on every frame of its window.

Run by `video-probe.mjs shape <track-dir>` with the Python env that `video-probe.mjs sam-setup` makes; writes
<track-dir>/shape.{json,md,jpg}. The track stays the source of position and timing. The mask adds what a fixed NCC
template cannot see: squash and stretch by hop phase, the arc of the object's feet (the template locks onto the top of
a stretched object, which inflates its arc), the object's full length along a move, and when an exit is fully under.

The prompt is the track's --box on its first frame, or --pos / --neg points (fractions of the cropped frame) for an
object drawn in layers (a shell over a core), where a box segments both and the mask stays on the core.
Frame rules, against the rest size (up to 3 frames before the object moves): under 10 % of the rest area it is gone for the rest
of the window (a mask that comes back is debris); outside 0.7-1.5x the rest area something covers it (a popup, a
selection outline) and the frame is left out; during an exit, frames shorter than the rest length are clipped.
"""
import argparse, atexit, itertools, json, os, re, shutil, subprocess, sys, tempfile, time, warnings
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
warnings.filterwarnings('ignore', category=UserWarning)  # sam2's optional CUDA hole filling
import numpy as np, torch
from PIL import Image, ImageDraw
from sam2.build_sam import build_sam2_video_predictor

CK = os.path.expanduser('~/.cache/gameplay-video/sam2')
CFG = {'tiny': 't', 'small': 's', 'base_plus': 'b+'}
GONE, OCC_LO, OCC_HI, CLIP = 0.1, 0.7, 1.5, 0.95
COLOR = {'ok': 'white', 'occluded': (255, 160, 0), 'clipped': (0, 220, 255), 'gone': (255, 60, 60)}
r2 = lambda x: None if x is None else round(float(x), 2)
r3 = lambda x: None if x is None else round(float(x), 3)
med = lambda v: float(np.median(v)) if len(v) else None
def die(m): print(f'video-probe shape: {m}', file=sys.stderr); sys.exit(1)
def log(m): print(f'video-probe shape: {m}', file=sys.stderr, flush=True)

ap = argparse.ArgumentParser()
ap.add_argument('dir'); ap.add_argument('--pos'); ap.add_argument('--neg')
ap.add_argument('--model', default='tiny', choices=list(CFG)); ap.add_argument('--device', default='cpu')
a = ap.parse_args()
T = json.load(open(os.path.join(a.dir, 'track.json')))
if 'error' in T: die(f"track.json holds an error ({T['error']}): fix the track first")
if 'mode' not in T: die('track.json predates shape (no mode / crop): rerun track')
mode, (w0, w1), crop = T['mode'], T['window'], T.get('crop')

# Frames at native rate with their real times (showinfo after select; -copyts keeps the source clock). Repeated frames
# of a screen recording are dropped, as track drops them.
tmp = tempfile.mkdtemp(prefix='video-probe-shape-'); atexit.register(shutil.rmtree, tmp, True)
t0 = time.time()
vf = f"select='gte(t,{w0 - 0.001})*lte(t,{w1 + 0.001})'" + (f",crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}" if crop else '') + ',showinfo'
p = subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', '-ss', str(max(0, w0 - 1)), '-copyts', '-i', T['video'], '-an', '-vf', vf,
                    '-fps_mode', 'passthrough', '-q:v', '2', os.path.join(tmp, '%05d.jpg')], capture_output=True, text=True)
names, stamps = sorted(os.listdir(tmp)), [float(m) for m in re.findall(r'pts_time:([\d.]+)', p.stderr)]
if p.returncode or not names or len(names) != len(stamps): die(f'frame extraction failed: {p.stderr[-300:]}')
times, prev = [], None
for nm, t in zip(names, stamps):  # sam2 wants 0-based names; ffmpeg numbers from 1
    g = np.asarray(Image.open(os.path.join(tmp, nm)).convert('L').reduce(4), np.float32)
    if prev is not None and np.abs(g - prev).mean() < 0.5: os.remove(os.path.join(tmp, nm)); continue
    os.rename(os.path.join(tmp, nm), os.path.join(tmp, f'{len(times):05d}.jpg')); times.append(t); prev = g
n, frame = len(times), lambda i: os.path.join(tmp, f'{i:05d}.jpg')
W, H = Image.open(frame(0)).size
fps = 1 / med(np.diff(times)) if n > 1 else 30
t_extract = time.time() - t0
log(f'{n} frames at {fps:.0f} fps; about {n * 1.5 / 60:.1f} min and {n * 0.013 + 1:.1f} GB of memory on CPU')

pts = [(q, 1) for q in (a.pos or '').split(';') if q] + [(q, 0) for q in (a.neg or '').split(';') if q]
kw = {} if a.pos else {'box': np.array([T['box'][0] * W, T['box'][1] * H, T['box'][2] * W, T['box'][3] * H], np.float32)}
if pts: kw.update(points=np.array([[float(v) * (W, H)[k] for k, v in enumerate(q.split(','))] for q, _ in pts], np.float32),
                  labels=np.array([l for _, l in pts], np.int32))
device = a.device if a.device != 'mps' or torch.backends.mps.is_available() else 'cpu'
t0 = time.time()
pred = build_sam2_video_predictor(f'configs/sam2.1/sam2.1_hiera_{CFG[a.model]}.yaml', f'{CK}/sam2.1_hiera_{a.model}.pt', device=device)
t_load, t0 = time.time() - t0, time.time()
masks = [None] * n
with torch.inference_mode():
    st = pred.init_state(video_path=tmp, offload_video_to_cpu=True)
    pred.add_new_points_or_box(st, frame_idx=0, obj_id=1, **kw)
    for fi, _, logits in pred.propagate_in_video(st): masks[fi] = (logits[0, 0] > 0).cpu().numpy()
t_prop = time.time() - t0

def main_parts(m):
    """The mask without stray bits: its 8-connected pieces of at least a quarter of the largest piece. A stray strip
    along a same-colored gate would otherwise set the box edge."""
    runs, parent, prev = [], [], []
    def root(k):
        while parent[k] != k: parent[k] = parent[parent[k]]; k = parent[k]
        return k
    for y in np.flatnonzero(m.any(1)):
        e = np.flatnonzero(np.diff(np.r_[0, m[y].astype(np.int8), 0])); cur = []
        for x0, x1 in zip(e[::2], e[1::2]):
            k = len(runs); runs.append((y, x0, x1)); parent.append(k); cur.append(k)
            for j in prev:
                if runs[j][0] == y - 1 and runs[j][1] <= x1 and runs[j][2] >= x0: parent[root(k)] = root(j)
        prev = cur
    size = {}
    for k, (y, x0, x1) in enumerate(runs): size[root(k)] = size.get(root(k), 0) + x1 - x0
    out = np.zeros_like(m)
    for k, (y, x0, x1) in enumerate(runs):
        if 4 * size[root(k)] >= max(size.values()): out[y, x0:x1] = True
    return out
masks = [main_parts(m) for m in masks]

# Per frame: the mask's box, centroid and feet (bottom center), and the track sample at the same time (camera offset
# and zoom in hop mode). Scales are the box against the rest box, over the camera zoom.
TS = T['samples']; tt = np.array([s['t'] for s in TS])
def sample(t): k = int(np.abs(tt - t).argmin()); return TS[k] if abs(tt[k] - t) <= 0.6 / fps else None
F = []
for t, m in zip(times, masks):
    ys, xs = np.nonzero(m); s = sample(t) or {}
    f = {'i': len(F), 't': t, 'area': len(xs), 'cam': s.get('cam'), 'cs': s.get('cam_scale') or 1, 'pos': s.get('pos')}
    if len(xs) >= 5:
        f.update(bbox=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())], c=[float(xs.mean()), float(ys.mean())])
        f.update(w=f['bbox'][2] - f['bbox'][0] + 1, h=f['bbox'][3] - f['bbox'][1] + 1, feet=[f['c'][0], f['bbox'][3] + 0.5])
    F.append(f)
if 'bbox' not in F[0]: die('the prompt gave no mask on the first frame: check the track box, or prompt with --pos points')
# Rest: up to 3 frames before the object starts moving (the first move, or one hop before the first landing). A window
# that starts with the object already moving has only its first frame, which may be blurred or clipped.
if mode == 'hop':
    lands, hd = T['detail']['clock'].get('landings') or [], T['spec']['hop'].get('duration_s')
    go = lands[0] - hd if lands and hd else None
else: go = (T.get('moves') or [{}])[0].get('start_s')
R = [f for f in F if 'bbox' in f and (go is None and f['i'] < 3 or go is not None and f['t'] <= go + 1e-6)][-3:]
moving_at_start = not R; R = R or [F[0]]
if mode == 'hop':
    # A hopping object drifts in size on screen (camera zoom, and perspective as it moves away), which the track's board
    # zoom does not follow. Its size baseline is the slow trend of the mask area, fitted robustly through the hops;
    # squash and stretch are the fast changes around it.
    a0 = med([f['area'] for f in R]); q = np.array([(f['t'], np.sqrt(f['area'] / a0)) for f in F if 'bbox' in f and 0.5 <= f['area'] / a0 <= 1.5])
    keep = np.ones(len(q), bool)
    for _ in range(3):
        co = np.polyfit(q[keep, 0], q[keep, 1], 2 if w1 - w0 > 2 else 1); res = np.abs(q[:, 1] - np.polyval(co, q[:, 0]))
        keep = res <= 3 * 1.4826 * np.median(res[keep]) + 1e-3
    for f in F: f['cs'] = float(np.polyval(co, f['t']))
rw, rh, ra = (med([f[k] / f['cs'] ** e for f in R]) for k, e in (('w', 1), ('h', 1), ('area', 2)))
spread = max(max(abs(f['w'] / f['cs'] / rw - 1), abs(f['h'] / f['cs'] / rh - 1)) for f in R)
floor = max(0.05, 2 * spread)
warn = (f'the rest frames disagree by {spread * 100:.0f} % (the mask may hold only part of the object on some): check the first tiles '
        'of shape.jpg, then prompt with --pos / --neg points or start the track where the object is clear') if spread > 0.1 else None
gone_at = None
for f in F:
    f['area_rel'] = f['area'] / (ra * f['cs'] ** 2)
    if 'bbox' in f: f['sx'], f['sy'] = f['w'] / (rw * f['cs']), f['h'] / (rh * f['cs'])
    if gone_at is None and f['area_rel'] < GONE: gone_at = f['t']
    f['status'] = 'gone' if gone_at is not None else 'ok'

def settle_status():
    for f in F:
        if gone_at is not None and f['t'] >= gone_at - 1e-6: f['status'] = 'gone'
        elif f['status'] == 'ok' and not OCC_LO <= f['area_rel'] <= OCC_HI: f['status'] = 'occluded'

keys, marks, series, out = [], [], [], {}
if mode == 'hop':
    settle_status()
    clock, hops = T['detail']['clock'], T['detail']['hops']
    ok = [f for f in F if f['status'] == 'ok']
    def near(t, tol): f = min(ok, key=lambda f: abs(f['t'] - t), default=None); return f if f and abs(f['t'] - t) <= tol else None
    bxy = {'feet': lambda f: np.add(f['feet'], f['cam']), 'center': lambda f: np.add(f['c'], f['cam']), 'ncc': lambda f: np.array(sample(f['t'])['board'])}
    per, bins, hbin = [], [[] for _ in range(10)], [[] for _ in range(10)]
    for hp in hops:
        h0, h1 = hp['t0'], hp['t1']; dur = h1 - h0
        air = [f for f in ok if h0 < f['t'] < h1 and f['cam'] is not None]
        row = {'k': hp['k'], 't0': h0, 't1': h1, 'track_ratio': hp['ratio']}
        for key, get in bxy.items():  # height above the line between the two landing points, over its length
            e0, e1 = near(h0, 1 / fps), near(h1, 1 / fps)
            if not (e0 and e1 and e0['cam'] is not None and e1['cam'] is not None and air): continue
            p0, p1 = get(e0), get(e1); tile = np.linalg.norm(p1 - p0)
            if tile < 1: continue
            hs = [((p0 + (f['t'] - h0) / dur * (p1 - p0))[1] - get(f)[1]) / tile for f in air]
            j = int(np.argmax(hs)); row[f'arc_{key}'] = [r3(hs[j]), r2((air[j]['t'] - h0) / dur)]
            if key == 'feet':
                for f, hv in zip(air, hs): hbin[min(9, int((f['t'] - h0) / dur * 10))].append(hv)
        inair = [f for f in ok if h0 < f['t'] < h1]
        for f in inair: bins[min(9, int((f['t'] - h0) / dur * 10))].append((f['sx'], f['sy']))
        if inair:
            f = max(inair, key=lambda f: f['sy'] / f['sx']); row['stretch'] = [r2(f['sx']), r2(f['sy']), r2((f['t'] - h0) / dur)]; keys.append(f['i'])
        td = [f for f in ok if abs(f['t'] - h1) <= 1.5 / fps]
        if td:
            f = min(td, key=lambda f: f['sy'] / f['sx']); row['touchdown'] = [r2(f['sx']), r2(f['sy']), r3(f['t'] - h1)]; keys.append(f['i'])
        per.append(row)
    pick = lambda k, j, rows=per: r3(med([r[k][j] for r in rows if k in r]))
    # A landing squash can last one frame, so a hop sampled off it shows none: report it only when most hops show it.
    ntd = sum('touchdown' in r for r in per); sq = [r for r in per if 'touchdown' in r and r['touchdown'][1] / r['touchdown'][0] < 1 - floor]
    if 2 * len(sq) < ntd: sq = []
    last = clock['landings'][-1] if clock.get('landings') else None
    # Back to rest: two frames in a row inside the floor, before anything covers the object.
    run = list(itertools.takewhile(lambda f: f['status'] == 'ok', (f for f in F if last is not None and f['t'] > last)))
    still = lambda f: abs(f['sx'] - 1) < floor and abs(f['sy'] - 1) < floor
    calm = next((f for f, g in zip(run, run[1:]) if still(f) and still(g)), None)
    phase = [{'u': r2((k + 0.5) / 10), 'sx': r2(med([v[0] for v in b])), 'sy': r2(med([v[1] for v in b])), 'feet_h': r3(med(hbin[k])), 'n': len(b)} for k, b in enumerate(bins) if b]
    deform = max([abs(q[c] - 1) for q in phase for c in ('sx', 'sy')] + [abs(pick(k, j, rows) - 1) for k, rows in (('stretch', per), ('touchdown', sq)) for j in (0, 1) if pick(k, j, rows) is not None], default=0)
    out['hop'] = {'hops': per, 'stretch': {'sx': pick('stretch', 0), 'sy': pick('stretch', 1), 'u': pick('stretch', 2)},
                  'touchdown': {'sx': pick('touchdown', 0, sq), 'sy': pick('touchdown', 1, sq), 'dt_s': pick('touchdown', 2, sq),
                                'hops': sum('touchdown' in r and r['touchdown'][1] / r['touchdown'][0] < 1 - floor for r in per), 'of': ntd},
                  'deforms': deform >= floor, 'phase': phase, 'settle_s': r3(calm['t'] - last) if calm else None,
                  'arc': {k: r3(pick(f'arc_{k}', 0)) for k in bxy} | {'feet_peak_u': r2(pick('arc_feet', 1)), 'track_fit': T['spec']['hop'].get('arc_tile_ratio')}}
    marks = [(t, (140, 140, 140)) for t in clock.get('landings', [])]
    series = [((0, 200, 255), [(f['t'], f['sx']) for f in ok]), ((255, 0, 255), [(f['t'], f['sy']) for f in ok])]
else:
    def proj(i, v):
        ys, xs = np.nonzero(masks[i]); pa, pc = xs * v[0] + ys * v[1], xs * -v[1] + ys * v[0]
        return float(pa.min()), float(pa.max()), float(pa.max() - pa.min() + 1), float(pc.max() - pc.min() + 1)
    out['moves'], ms, absorbed = [], T.get('moves') or [], {}
    for mi, m in enumerate(ms):
        if m['k'] in absorbed:
            out['moves'].append({'k': m['k'], 'end': m['end'], 'dir': m.get('dir'), 'part_of_exit': absorbed[m['k']]}); continue
        v = np.array(m['vec'], float); v /= np.linalg.norm(v)
        # An exit ends in a vanish, or the object never shows at full size again after the move: the tracker then
        # splits the slide under into more moves (turns), which belong to this exit.
        after = [f for f in F if mi + 1 < len(ms) and f['t'] >= ms[mi + 1]['start_s']]
        exit_ = m['end'] == 'vanish' or 'occlusion' in m or bool(after) and all(f['area_rel'] < OCC_LO for f in after)
        tb = w1 if exit_ or mi + 1 == len(ms) else ms[mi + 1]['start_s']
        ta = max(m['start_s'] - 1.5 / fps, (ms[mi - 1].get('stop_s') or ms[mi - 1].get('last_seen_s') or 0) if mi else 0)  # not the blur of the move before
        Lr, Wr = (med([proj(f['i'], v)[k] for f in R]) for k in (2, 3))
        rows = [(F[i]['t'], *proj(i, v), F[i]['area_rel'], i) for i in range(n) if ta - 1e-6 <= F[i]['t'] <= tb + 0.5 / fps and 'bbox' in F[i] and F[i]['status'] != 'gone']
        for t, tr, ld, al, ac, ar, i in rows: F[i].update(move=m['k'], along=al / Lr, across=ac / Wr)
        mv = {'k': m['k'], 'end': m['end'], 'dir': m.get('dir'), 'length_px': r2(Lr), 'width_px': r2(Wr), 'track_length_px': m.get('length_px')}
        if T.get('cell_px'): mv.update(length_cells=r2(Lr / T['cell_px']), width_cells=r2(Wr / T['cell_px']))
        contact = None
        if exit_ and len(rows) >= 3:
            # The lead edge stops at the edge the object slides under while the trail keeps going: that pinned lead is
            # the edge E. Contact: the lead reaches E. Fully under: the trail reaches E, followed while it keeps
            # its speed (a trail that stalls or jumps is a leftover strip or debris), then extrapolated. A pinned lead
            # moves less than a quarter of the trail step (a mask edge on a same-colored gate wobbles a few px). Only the
            # first pin counts: after it a knocked-back gate moves the edge, and once the object is under, the mask can
            # land on debris pinned at the frame edge. A block resting against the edge is in contact when its move starts.
            pin = [rows[j][2] for j in range(1, len(rows)) if abs(rows[j][2] - rows[j - 1][2]) < max(1.5, 0.25 * (rows[j][1] - rows[j - 1][1])) and rows[j][1] - rows[j - 1][1] > 1.5]
            if pin:
                E = pin[0]; j0 = next(j for j in range(len(rows)) if rows[j][2] >= E - 1.5)
                contact = rows[j0][0] if j0 == 0 or rows[j0 - 1][2] >= rows[j0][2] else rows[j0 - 1][0] + (E - rows[j0 - 1][2]) / (rows[j0][2] - rows[j0 - 1][2]) * (rows[j0][0] - rows[j0 - 1][0])
                contact = max(contact, m['start_s'])
                vel = lambda j, c: (rows[j][c] - rows[j - 1][c]) / (rows[j][0] - rows[j - 1][0])
                acc = [vel(j, 2) for j in range(1, j0 + 1) if vel(j, 2) > 0][-3:]
                # In contact from the first frame (slid under from rest): the first trail steps set the speed.
                seed = med([x for x in (vel(j, 1) for j in range(j0 + 1, min(len(rows), j0 + 4))) if x > 0])
                last = j0
                for j in range(j0 + 1, len(rows)):
                    vj, ref = vel(j, 1), med(acc) if acc else seed
                    if rows[j][5] < GONE or (ref and not 0.5 * ref <= vj <= 3 * ref) or (not ref and vj <= 0): break
                    acc.append(vj); last = j
                ref, rem = med(acc) if acc else seed, max(0.0, E - rows[last][1])
                under = rows[last][0] + rem / ref if ref else None
                if last + 1 < len(rows): gone_at = min(rows[last + 1][0], gone_at if gone_at is not None else np.inf)
                for t, tr, ld, al, ac, ar, i in rows[j0:last + 1]:
                    # A mask that jumps past the edge has spilled onto what the object slides under; a gate knocked back
                    # moves the edge only a little.
                    if ld > E + max(3, 0.15 * Lr): F[i]['status'] = 'occluded'
                    elif al < CLIP * Lr: F[i]['status'] = 'clipped'
                occ = m.get('occlusion') or {}
                mv['exit'] = {'edge_px': r2(E), 'contact_s': r3(contact), 'under_seen_s': r3(rows[last][0]), 'left_at_last': r2(rem / Lr),
                              'under_s': r3(under), 'contact_to_under_s': r3(under - contact) if under else None, 'trail_px_s': r2(ref),
                              'track': {k: occ.get(k) for k in ('contact_s', 'contact_model_s', 'under_s', 'contact_to_under_s')}}
                absorbed.update({q['k']: m['k'] for q in ms[mi + 1:]})  # once under, the track follows leftovers
                keys += [rows[j0][6], rows[last][6]]
                marks += [(contact, (255, 220, 0))] + ([(under, (255, 60, 60))] if under else [])
        moving = [r for r in rows if (contact is None or r[0] < contact) and OCC_LO <= r[5] <= OCC_HI]
        if moving:
            al, ac = [r[3] / Lr for r in moving], [r[4] / Wr for r in moving]
            mv['moving'] = {'along': [r2(med(al)), r2(max(al))], 'across': [r2(med(ac)), r2(min(ac))], 'deforms': max(abs(max(al) - 1), abs(min(ac) - 1)) >= floor}
        out['moves'].append(mv)
        if rows: keys.append(rows[0][6])
    settle_status()
    series = [('white', [(f['t'], f['along']) for f in F if 'along' in f and f['status'] in ('ok', 'clipped')]), ((255, 0, 255), [(f['t'], f['area_rel']) for f in F if f['status'] != 'gone'])]

# Sheet: up to 24 tiles around the object (key frames first), mask tinted magenta, box green, feet yellow; a plot below.
side = int(min(W, H, max(rw, rh) * max(f['cs'] for f in F) * 2.4 + 24))
key = sorted(set(keys))[:16]; rest = [i for i in range(n) if i not in key]
sel = sorted(set(key + ([rest[int(k)] for k in np.linspace(0, len(rest) - 1, min(len(rest), 24 - len(key))).round()] if rest else [])))
TW, LH, PH, cols = 160, 14, 200, 6
sheet = Image.new('RGB', (cols * TW, -(-len(sel) // cols) * (TW + LH) + PH), 'black'); d = ImageDraw.Draw(sheet)
cen = F[0]['c']
centers = []
for f in F: cen = [(f['bbox'][0] + f['bbox'][2]) / 2, (f['bbox'][1] + f['bbox'][3]) / 2] if 'bbox' in f and f['status'] != 'gone' else f['pos'] or cen; centers.append(cen)
for j, i in enumerate(sel):
    f, (cx, cy) = F[i], centers[i]
    x0, y0 = int(np.clip(cx - side / 2, 0, W - side)), int(np.clip(cy - side / 2, 0, H - side))
    im, mk = np.array(Image.open(frame(i)).convert('RGB'))[y0:y0 + side, x0:x0 + side], masks[i][y0:y0 + side, x0:x0 + side]
    im[mk] = (0.5 * im[mk] + np.array([127, 0, 127])).astype(np.uint8)
    tile = Image.fromarray(im).resize((TW, TW)); td, k = ImageDraw.Draw(tile), TW / side
    if 'bbox' in f and f['status'] != 'gone':
        b = f['bbox']; td.rectangle(((b[0] - x0) * k, (b[1] - y0) * k, (b[2] + 1 - x0) * k, (b[3] + 1 - y0) * k), outline=(0, 255, 0))
        fx, fy = (f['feet'][0] - x0) * k, (f['feet'][1] - y0) * k; td.ellipse((fx - 2, fy - 2, fx + 2, fy + 2), fill='yellow')
    X0, Y0 = (j % cols) * TW, (j // cols) * (TW + LH)
    sheet.paste(tile, (X0, Y0)); d.text((X0 + 2, Y0 + TW), f"{f['t']:.3f} {f['status']}", fill=COLOR[f['status']])
py0 = -(-len(sel) // cols) * (TW + LH)
vals = [v for _, s in series for _, v in s] + [1]
lo, hi = min(min(vals), 1 - 2 * floor) - 0.05, max(max(vals), 1 + 2 * floor) + 0.05
X = lambda t: 8 + (t - w0) / (w1 - w0) * (cols * TW - 16); Y = lambda v: py0 + PH - 10 - (v - lo) / (hi - lo) * (PH - 30)
for v, c in ((1, (120, 120, 120)), (1 - floor, (60, 60, 60)), (1 + floor, (60, 60, 60))): d.line((X(w0), Y(v), X(w1), Y(v)), fill=c)
for t, c in marks: d.line((X(t), py0 + 16, X(t), py0 + PH - 6), fill=c)
for c, s in series:
    for (ta, va), (tb, vb) in zip(s, s[1:]):
        if tb - ta < 2.5 / fps: d.line((X(ta), Y(va), X(tb), Y(vb)), fill=c)
    for t, v in s: d.ellipse((X(t) - 1.5, Y(v) - 1.5, X(t) + 1.5, Y(v) + 1.5), fill=c)
legend = ('scale x (cyan) and y (magenta) against rest; grey lines: 1 and the noise floor; vertical: landings' if mode == 'hop'
          else 'length along the move (white) and area (magenta) against rest; vertical: edge contact (yellow), fully under (red)')
d.text((8, py0 + 2), f'{w0:.2f}-{w1:.2f} s; {legend}', fill='white')
sheet.save(os.path.join(a.dir, 'shape.jpg'), quality=85)

count = {s: sum(f['status'] == s for f in F) for s in COLOR}
summary = {'model': a.model, 'device': device, 'prompt': {'pos': a.pos, 'neg': a.neg} if a.pos else {'box': T['box'], **({'neg': a.neg} if a.neg else {})},
           'frames': n, 'fps': r2(fps), 'status': count, 'seconds': {'extract': r2(t_extract), 'load': r2(t_load), 'propagate': r2(t_prop), 'per_frame': r3(t_prop / n)},
           **({'warning': warn} if warn else {}), 'rest': {'w_px': r2(rw), 'h_px': r2(rh), 'area_px': r2(ra), 'frames_s': [r3(f['t']) for f in R], 'moving_at_start': moving_at_start}, 'floor': r3(floor), **out}
if mode == 'hop': summary['size_trend'] = [r3(F[0]['cs']), r3(F[-1]['cs'])]
frames_out = [{'t': r3(f['t']), 'status': f['status'], 'area': r3(f['area_rel']), **({'bbox': f['bbox'], 'c': [r2(v) for v in f['c']], 'feet': [r2(v) for v in f['feet']],
               'sx': r3(f['sx']), 'sy': r3(f['sy'])} if 'bbox' in f else {}), **({'move': f['move'], 'along': r3(f['along']), 'across': r3(f['across'])} if 'move' in f else {})} for f in F]
json.dump({'track': os.path.abspath(a.dir), 'video': T['video'], 'mode': mode, 'window': T['window'], 'crop': crop, 'summary': summary, 'samples': frames_out},
          open(os.path.join(a.dir, 'shape.json'), 'w'), indent=1)

pc = lambda x: f'{(x - 1) * 100:+.0f} %' if x is not None else '-'
md = [f"# Shape - {os.path.basename(T['video'])} {w0:.2f}-{w1:.2f} s", '',
      f"SAM 2 {a.model} mask of the tracked object on {n} frames ({fps:.0f} fps, {t_prop / n:.1f} s per frame on {device}); prompt: "
      + (f'points +{a.pos}' + (f' -{a.neg}' if a.neg else '') if a.pos else f"the track box {T['box']}" + (f', minus points {a.neg}' if a.neg else '')) + '.',
      (f"Rest size: {rw:.0f} x {rh:.0f} px, area {ra:.0f} px, from the first frame, where the object already moves (start the track --at a few frames before it moves for a clean rest). "
       if moving_at_start else f"Rest size ({len(R)} frame{'s' if len(R) > 1 else ''} to {R[-1]['t']:.3f} s, before the object moves): {rw:.0f} x {rh:.0f} px, area {ra:.0f} px. ")
      + f"Noise floor +-{floor * 100:.0f} %: smaller changes are not measured. "
      f"Frames: {count['ok']} ok, {count['occluded']} occluded (area outside {OCC_LO}-{OCC_HI}x rest as something covers the object, or a mask spilling past an exit edge; left out), "
      f"{count['clipped']} clipped, {count['gone']} gone (under {GONE:.0%} of rest, or past a full exit; any later mask is debris).", '']
if warn: md += [f'WARNING: {warn}.', '']
if mode == 'hop':
    h = out['hop']; s, tdn, arc = h['stretch'], h['touchdown'], h['arc']
    td_hops = f"{tdn['hops']} of {tdn['of']} hops; per hop y/x at the landing {' '.join(str(r['touchdown'][1]) + '/' + str(r['touchdown'][0]) for r in h['hops'] if 'touchdown' in r)}"
    td_text = (f"x {pc(tdn['sx'])}, y {pc(tdn['sy'])}, {tdn['dt_s']} s from the landing (median of the {td_hops})" if tdn['sx'] is not None
               else f"none on most hops: flatter than the floor on {td_hops}")
    md += [f"Scales are the mask box against rest, x across the screen and y up it, over the slow trend of the object's size on screen ({F[0]['cs']:.2f} to {F[-1]['cs']:.2f} of rest across the window: camera zoom and perspective). "
           'The trend runs through the hops, so a scale held for the whole window is not measured. Arc heights are over the tile length on screen, per hop peak, median of the hops.', '',
           '| measure | value |', '|---|---|',
           f"| stretch in the air | x {pc(s['sx'])}, y {pc(s['sy'])} at u {s['u']} (median of {len(h['hops'])} hops; per hop y/x peak {' '.join(str(r['stretch'][1]) + '/' + str(r['stretch'][0]) for r in h['hops'] if 'stretch' in r)}) |",
           f"| touchdown squash | {td_text} |",
           f"| back to rest after the last landing | {str(h['settle_s']) + ' s' if h['settle_s'] is not None else 'not measured (covered, or past the window)'} |",
           f"| arc of the feet (mask bottom) | {arc['feet']} at u {arc['feet_peak_u']} (per hop {' '.join(str(r['arc_feet'][0]) for r in h['hops'] if 'arc_feet' in r)}) |",
           f"| arc of the mask center | {arc['center']} |",
           f"| arc of the NCC template, same method / track fit | {arc['ncc']} / {arc['track_fit']} (the template rides the top of a stretched object: an upper bound) |", '',
           '## Scale by hop phase', '', '| u | ' + ' | '.join(str(q['u']) for q in h['phase']) + ' |', '|---|' + '---|' * len(h['phase']),
           '| x | ' + ' | '.join(str(q['sx']) for q in h['phase']) + ' |', '| y | ' + ' | '.join(str(q['sy']) for q in h['phase']) + ' |',
           '| feet height / tile | ' + ' | '.join(str(q['feet_h']) for q in h['phase']) + ' |', '| frames | ' + ' | '.join(str(q['n']) for q in h['phase']) + ' |', '',
           '## Cocos Creator 3.x sketch', '', '```ts']
    if h['deforms']:
        tx, ty = tdn['sx'] or 1, tdn['sy'] or 1  # 1 when most hops land without a squash
        kx = [[0, tx, ty]] + [[q['u'], q['sx'], q['sy']] for q in h['phase']] + [[1, tx, ty]]
        md += ['// Scale keys [u, x, y] by hop phase (0 takeoff, 1 landing; both ends are the touchdown squash of a chained hop, a hop from rest starts at 1).',
               '// Screen x / y: on a 3D token put y on the up axis and x on both ground axes.',
               f"const SCALE_KEYS = {json.dumps(kx)};",
               'export function scaleAt(u: number, out: Vec3) {',
               '  let k = 1;', '  while (k < SCALE_KEYS.length - 1 && SCALE_KEYS[k][0] < u) k++;',
               '  const [u0, x0, y0] = SCALE_KEYS[k - 1], [u1, x1, y1] = SCALE_KEYS[k], f = Math.min(1, Math.max(0, (u - u0) / (u1 - u0)));',
               '  return out.set(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, x0 + (x1 - x0) * f);', '}',
               f"// In track.md's hop() onUpdate: token.setScale(scaleAt(o.u, s)); after the last hop tween the scale back to 1 in {h['settle_s'] or 0.1} s."]
    else: md.append(f'// No squash or stretch above the +-{floor * 100:.0f} % floor: keep the scale at 1.')
    md += [f"// ARC = {arc['feet']} from the feet (track.md's ARC comes from the NCC template: {arc['track_fit']}).", '```']
else:
    u = 'cells' if T.get('cell_px') else 'px'
    L = lambda mv, k: f"{mv[k + '_cells']} cells ({mv[k + '_px']:.0f} px)" if u == 'cells' else f"{mv[k + '_px']:.0f} px"
    md += ['Lengths are the mask extent along the move and across it, at rest; while moving, as a share of rest (median, extreme).', '',
           '| move | end | dir | length x width at rest | NCC length | while moving: along / across | edge contact | fully under | contact to under | track (NCC) contact / under |',
           '|---|---|---|---|---|---|---|---|---|---|']
    for mv in out['moves']:
        if 'part_of_exit' in mv:
            md.append(f"| {mv['k']} | {mv['end']} | {mv['dir']} | part of move {mv['part_of_exit']}'s exit: the track split the slide under into more moves |" + ' - |' * 6); continue
        e, mo = mv.get('exit'), mv.get('moving')
        mvd = f"{mo['along'][0]} (max {mo['along'][1]}) / {mo['across'][0]} (min {mo['across'][1]})" + ('' if mo['deforms'] else ', within noise') if mo else '-'
        ex = ([f"{e['contact_s']} s", f"{e['under_s']} s (seen to {e['under_seen_s']} s, {e['left_at_last'] * 100:.0f} % left)", f"{e['contact_to_under_s']} s",
               ' / '.join('-' if e['track'][k] is None else str(e['track'][k]) for k in ('contact_s', 'under_s'))] if e else ['-', '-', '-', '-'])
        md.append(f"| {mv['k']} | {mv['end']} | {mv['dir']} | {L(mv, 'length')} x {L(mv, 'width')} | {mv['track_length_px']} px | {mvd} | " + ' | '.join(ex) + ' |')
    md += ['', '- Edge contact: the lead edge reaches the edge the object slides under (the lead stops there while the trail keeps going). Fully under: the trail edge reaches it, followed while it keeps its speed, the rest extrapolated at that speed.',
           '- NCC length is the lit part of the track template; a template that holds only the rim is shorter than the object.',
           "- A gate's knock-back comes from track.md, not from a mask (a mask moved 3.5 px where the gate moved 10)."]
md += ['', '## shape.jpg', '', f"- Top: {len(sel)} tiles around the object, row-major, time and status under each; mask magenta, its box green, feet yellow. Key frames first: "
       + ('each hop\'s peak stretch and touchdown.' if mode == 'hop' else 'each move\'s start, edge contact and last frame with the trail moving.'),
       f'- Bottom: {legend}.']
open(os.path.join(a.dir, 'shape.md'), 'w').write('\n'.join(md) + '\n')
