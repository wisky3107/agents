// v1 spec → v2: same screens and flow, UI chrome swapped for the agy raster kit (agy/web/*.png).
// v2 frames are named "v2 · <name>" and sit ROW_OFF rows below v1, so v1 is never touched.
import { C, G } from '../spec/_kit.mjs';

export const PREFIX = 'v2 · ';
const ROW_OFF = 3;
const key = (f) => JSON.stringify(f);
const BTN = new Map([
  [key(G.cta), 'btn-cyan'], [key(G.hot), 'btn-pink'], [key(G.green), 'btn-green'], [key(G.gold), 'btn-gold'],
  ...['#FFFFFF1F', '#FFFFFF1A', '#FFFFFF14', '#FFFFFF26', '#00000059', '#00000040', '#0D0B1A59'].map((c) => [key(c), 'btn-glass']),
]);
const ICON = new Set(['diamond', 'bolt', 'star', 'crown', 'gift', 'gear', 'home', 'cart', 'trophy']);
const CARD_FILLS = new Set([key('#1A1240B3'), key(C.glass)]);
const MUTED = new Set([C.muted, '#FFFFFF33', '#FFFFFF66']);

function node(o) {
  const n = { ...o };
  if (n.t === 'btn' && n.n === 'ribbon') {
    Object.assign(n, { f: { img: 'ribbon', s9: [0.2, 0, 0.2, 0] }, sh: [], x: n.x - 40, w: n.w + 80, h: n.h + 20 });
  } else if (n.t === 'btn' && BTN.has(key(n.f)) && n.w / n.h >= 1.6) {
    n.f = { img: BTN.get(key(n.f)), s9: [0.22, 0, 0.22, 0] };
    delete n.st; n.sh = [];
  } else if ((n.t === 'frame') && /-card$/.test(n.n || '') && n.f?.c) {
    n.f = { img: 'panel', s9: [0.2, 0.2, 0.2, 0.2], k: 0.75 };
    delete n.st;
  } else if (n.t === 'frame' && CARD_FILLS.has(key(n.f)) && n.w >= 400) {
    n.f = { img: 'card', s9: [0.12, 0.3, 0.12, 0.3] };
    delete n.st;
  } else if (n.t === 'rect' && /^tile-(a|next)$/.test(n.n || '')) {
    Object.assign(n, { f: { img: 'tile-black', mode: 'STRETCH' }, sh: [], r: 0 }); delete n.st;
  } else if (n.t === 'rect' && n.n === 'tile-long') {
    Object.assign(n, { f: { img: 'tile-long', mode: 'STRETCH' }, sh: [], r: 0 }); delete n.st;
  } else if (n.t === 'rect' && n.n === 'hold-trail') {
    return null;
  } else if (n.t === 'icon' && ICON.has(n.i)) {
    const muted = MUTED.has(n.c);
    const img = n.i === 'star' && muted ? 'ic-star-empty' : 'ic-' + n.i;
    const s = Math.round(n.s * (n.i === 'star' ? 1 : 1.2)), d = (s - n.s) / 2;
    const op = n.i === 'star' ? n.op : n.c === C.muted ? 0.7 : muted ? 0.3 : n.op;
    return { t: 'rect', n: n.n || 'icon-' + n.i, x: n.x - d, y: n.y - d, w: s, h: s, f: { img, mode: 'FIT' }, op, rot: n.rot };
  }
  if (n.ch) n.ch = n.ch.map(node).filter(Boolean);
  return n;
}

export const screen = (s) => ({ ...s, id: 'v2-' + s.id, name: PREFIX + s.name, row: s.row + ROW_OFF, ch: s.ch.map(node).filter(Boolean) });
export const link = (l) => ({ ...l, from: 'v2-' + l.from, to: 'v2-' + l.to });
