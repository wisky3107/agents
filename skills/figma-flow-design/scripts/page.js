// Runs inside the Figma tab (orca eval). render.mjs replaces the A line with {mode, screens, links, icons, L, page, fonts, library}.
(async () => {
const A = __ARGS__;
const L = A.L;
if (A.page) {
  let p = figma.root.children.find((n) => n.name === A.page);
  if (!p) { p = figma.createPage(); p.name = A.page; }
  if (figma.currentPage !== p) await figma.setCurrentPageAsync(p);
}
const pg = figma.currentPage;
await pg.loadAsync();
for (const [family, style] of A.fonts) { try { await figma.loadFontAsync({ family, style }); } catch {} }

const hex = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
};
// Images by name from every "Image library…" frame on the page (this flow's uploads, game-ui-kit figma-kit boards).
const LIBN = pg.children.filter((n) => /^Image library/.test(n.name) && 'children' in n).flatMap((f) => f.children);
const LIB = Object.fromEntries(LIBN.map((n) => [n.name, n.fills[0]?.imageHash]));
const LIBSZ = Object.fromEntries(LIBN.map((n) => [n.name, [n.width, n.height]]));
const paint = (f) => {
  if (!f) return [];
  if (f.img) {
    if (!LIB[f.img]) throw new Error('image not uploaded: ' + f.img);
    if (f.s9) return [];
    if (f.mode === 'STRETCH') return [{ type: 'IMAGE', imageHash: LIB[f.img], scaleMode: 'CROP', imageTransform: [[1, 0, 0], [0, 1, 0]], opacity: f.op ?? 1 }];
    return [{ type: 'IMAGE', imageHash: LIB[f.img], scaleMode: f.mode || 'FILL', opacity: f.op ?? 1 }];
  }
  if (typeof f === 'string') { const c = hex(f); return [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }]; }
  const gradientStops = f.c.map((h, i) => ({ position: f.p ? f.p[i] : i / (f.c.length - 1), color: hex(h) }));
  if (f.rad) return [{ type: 'GRADIENT_RADIAL', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops }];
  const t = ((f.a ?? 90) * Math.PI) / 180, co = Math.cos(t), si = Math.sin(t);
  return [{ type: 'GRADIENT_LINEAR', gradientTransform: [[co, si, 0.5 - 0.5 * co - 0.5 * si], [-si, co, 0.5 + 0.5 * si - 0.5 * co]], gradientStops }];
};
const fx = (o) => [].concat(o.sh || []).map((s) => ({ type: 'DROP_SHADOW', color: hex(s.c || '#00000066'),
  offset: { x: s.x || 0, y: s.y || 0 }, radius: s.b ?? 20, spread: s.s || 0, visible: true, blendMode: 'NORMAL' }))
  .concat(o.bb ? [{ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: o.bb, visible: true }] : []);
const box = (node, o) => {
  node.name = o.n || o.t;
  node.x = o.x || 0; node.y = o.y || 0;
  if (o.w) node.resize(o.w, o.h || o.w);
  node.fills = paint(o.f);
  if (o.r != null && 'cornerRadius' in node) node.cornerRadius = o.r;
  if (o.st) { node.strokes = paint(o.st); node.strokeWeight = o.sw || 3; node.strokeAlign = 'INSIDE'; }
  node.effects = fx(o);
  if (o.op != null) node.opacity = o.op;
  if (o.rot) node.rotation = o.rot;
  if (o.arc) node.arcData = { startingAngle: o.arc[0], endingAngle: o.arc[1], innerRadius: o.arc[2] ?? 0 };
  return node;
};
const text = (o) => {
  const t = figma.createText();
  t.fontName = { family: o.ff || 'Poppins', style: o.fw || 'SemiBold' };
  t.characters = String(o.v);
  t.fontSize = o.s || 40;
  t.fills = paint(o.c || '#FFFFFF');
  if (o.ls) t.letterSpacing = { unit: 'PERCENT', value: o.ls };
  if (o.lh) t.lineHeight = { unit: 'PERCENT', value: o.lh };
  t.textAlignHorizontal = o.al || 'LEFT';
  if (o.w && o.h) { t.textAutoResize = 'NONE'; t.resize(o.w, o.h); t.textAlignVertical = 'CENTER'; }
  else if (o.w) { t.textAutoResize = 'HEIGHT'; t.resize(o.w, t.height); }
  else t.textAutoResize = 'WIDTH_AND_HEIGHT';
  t.name = o.n || String(o.v).slice(0, 24);
  t.x = o.x || 0; t.y = o.y || 0;
  t.effects = fx(o);
  if (o.op != null) t.opacity = o.op;
  return t;
};
const icon = (o) => {
  const s = o.s || 64, c = o.c || '#FFFFFF';
  const parts = A.icons[o.i];
  if (!parts) throw new Error('unknown icon ' + o.i);
  const body = parts.map((p) => p.s
    ? `<path d="${p.d}" fill="none" stroke="${c}" stroke-width="${p.s}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${p.d}" fill="${c}" fill-rule="evenodd"/>`).join('');
  const n = figma.createNodeFromSvg(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">${body}</svg>`);
  n.name = o.n || 'icon-' + o.i; n.x = o.x || 0; n.y = o.y || 0;
  n.effects = fx(o);
  if (o.op != null) n.opacity = o.op;
  return n;
};
const build = (o) => {
  switch (o.t) {
    case 'rect': return box(figma.createRectangle(), o);
    case 'ellipse': return box(figma.createEllipse(), o);
    case 'text': return text(o);
    case 'icon': return icon(o);
    case 'frame': case 'btn': {
      const fr = box(figma.createFrame(), o);
      fr.clipsContent = !!o.clip;
      if (o.f?.s9) for (const r of slices(o.f, o.w, o.h)) fr.appendChild(r);
      if (o.t === 'btn') {
        const s = o.s || 44, gap = 16;
        if (o.i && o.v != null) {
          const isz = o.is || Math.round(s * 1.2);
          const tt = text({ v: o.v, s, ff: o.ff || 'Fredoka', fw: o.fw || 'Bold', c: o.c, ls: o.ls });
          const tw = isz + gap + tt.width;
          const ic = icon({ i: o.i, s: isz, c: o.ic || o.c, x: (o.w - tw) / 2, y: (o.h - isz) / 2 });
          tt.x = ic.x + isz + gap; tt.y = (o.h - tt.height) / 2;
          fr.appendChild(ic); fr.appendChild(tt);
        } else if (o.i) {
          const isz = o.is || Math.round(Math.min(o.w, o.h) * 0.5);
          fr.appendChild(icon({ i: o.i, s: isz, c: o.ic || o.c, x: (o.w - isz) / 2, y: (o.h - isz) / 2 }));
        } else if (o.v != null) {
          fr.appendChild(text({ v: o.v, s, ff: o.ff || 'Fredoka', fw: o.fw || 'Bold', c: o.c, ls: o.ls, al: 'CENTER', x: 0, y: 0, w: o.w, h: o.h }));
        }
      }
      for (const ch of o.ch || []) fr.appendChild(build(ch));
      return fr;
    }
    default: throw new Error('unknown node type ' + o.t);
  }
};
// Nine-slice: f = { img, s9: [l, t, r, b] as fractions of the image }, caps scaled by k.
const slices = (f, w, h) => {
  const [iw, ih] = LIBSZ[f.img];
  const [cl, ct, cr, cb] = f.s9;
  const k = f.k ?? (ct === 0 && cb === 0 ? h / ih : Math.min(w / iw, h / ih));
  const xs = [0, cl * iw * k, w - cr * iw * k, w], ys = [0, ct * ih * k, h - cb * ih * k, h];
  const us = [0, cl, 1 - cr, 1], vs = [0, ct, 1 - cb, 1];
  const out = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const cw = xs[i + 1] - xs[i], ch = ys[j + 1] - ys[j];
    if (cw < 0.5 || ch < 0.5) continue;
    const r = figma.createRectangle(); r.name = 'slice'; r.x = xs[i]; r.y = ys[j]; r.resize(cw, ch);
    r.fills = [{ type: 'IMAGE', imageHash: LIB[f.img], scaleMode: 'CROP', opacity: f.op ?? 1,
      imageTransform: [[us[i + 1] - us[i], 0, us[i]], [0, vs[j + 1] - vs[j], vs[j]]] }];
    out.push(r);
  }
  return out;
};
const top = (name) => pg.children.find((n) => n.name === name);

if (A.mode === 'upload') {
  let lib = top(A.library);
  if (!lib) { lib = figma.createFrame(); lib.name = A.library; lib.x = -4000; lib.y = 0; lib.resize(400, 400); lib.fills = []; lib.visible = false; }
  const img = figma.createImage(figma.base64Decode(A.b64));
  const { width, height } = await img.getSizeAsync();
  lib.findOne((n) => n.name === A.name)?.remove();
  const r = figma.createRectangle(); r.name = A.name; r.resize(width, height); r.y = lib.children.length * 10;
  r.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
  lib.appendChild(r);
  return A.name + ' ' + width + 'x' + height;
}

if (A.mode === 'screens') {
  const made = [];
  for (const s of A.screens) {
    top(s.name)?.remove();
    const fr = box(figma.createFrame(), { n: s.name, x: s.col * (L.W + L.GX), y: s.row * (L.H + L.GY), w: L.W, h: L.H, f: s.bg || L.bg });
    fr.clipsContent = true;
    if (s.dim) fr.appendChild(build({ t: 'rect', n: 'bg-dim', w: L.W, h: L.H, f: { c: ['#0A0820' + s.dim[0], '#0A0820' + s.dim[1]], a: 90 } }));
    for (const ch of s.ch || []) fr.appendChild(build(ch));
    made.push(s.name + ' ' + fr.findAll(() => true).length);
  }
  return JSON.stringify(made);
}

if (A.mode === 'links') {
  pg.backgrounds = paint('#0F0B1E');
  const SUF = A.suffix || '';
  top('Flow arrows' + SUF)?.remove();
  top('Board header' + SUF)?.remove();
  const frames = Object.fromEntries(A.screens.map((s) => [s.id, top(s.name)]));
  const missing = [];
  const bySrc = new Map();
  for (const l of A.links) {
    const a = frames[l.from], b = frames[l.to];
    if (!a || !b) { missing.push(l.from + '->' + l.to); continue; }
    const hot = l.node ? a.findOne((n) => n.name === l.node) : a;
    if (!hot) { missing.push(l.from + ':' + l.node); continue; }
    if (!bySrc.has(hot.id)) bySrc.set(hot.id, { hot, rx: [] });
    const trigger = l.trig === 'timeout' ? { type: 'AFTER_TIMEOUT', timeout: l.ms || 1.5 } : { type: 'ON_CLICK' };
    bySrc.get(hot.id).rx.push({ trigger, actions: [{ type: 'NODE', destinationId: b.id, navigation: 'NAVIGATE',
      transition: { type: 'DISSOLVE', duration: 0.3, easing: { type: 'EASE_OUT' } }, preserveScrollPosition: false }] });
    l._a = a; l._b = b; l._hot = hot;
  }
  for (const { hot, rx } of bySrc.values()) await hot.setReactionsAsync(rx.slice(0, 1));
  const startId = frames[A.screens[0].id].id, keep = [];
  for (const f of pg.flowStartingPoints) {
    if (f.name === A.flowName || f.nodeId === startId || keep.some((k) => k.nodeId === f.nodeId)) continue;
    if (await figma.getNodeByIdAsync(f.nodeId)) keep.push(f);
  }
  pg.flowStartingPoints = [...keep, { nodeId: startId, name: A.flowName || 'Melody Tiles flow' }];

  // arrows
  const out = [];
  const lane = {};
  const nextLane = (k) => (lane[k] = (lane[k] ?? -1) + 1);
  const inCount = {};
  const COL = { main: '#3FE0FF', branch: '#FF4FD8', back: '#9A93C9', reward: '#FFC83D' };
  for (const l of A.links.filter((l) => l._a && !l.noArrow)) {
    const a = l._a, b = l._b, h = l._hot.absoluteBoundingBox;
    const hx = Math.min(Math.max(h.x + h.width / 2, a.x + 80), a.x + L.W - 80);
    const hy = Math.min(Math.max(h.y + h.height / 2, a.y + 80), a.y + L.H - 80);
    const ib = (inCount[b.id] = (inCount[b.id] ?? -1) + 1);
    const sameRow = Math.abs(a.y - b.y) < 1, adj = sameRow && b.x > a.x && b.x - a.x <= L.W + L.GX + 1;
    let pts;
    if (adj) {
      const mx = a.x + L.W + L.GX / 2 + (l.dx || 0);
      const ey = b.y + 360 + ib * 170;
      pts = [[a.x + L.W, hy], [mx, hy], [mx, ey], [b.x, ey]];
    } else if (sameRow) {
      const k = nextLane('top' + a.y);
      const ty = a.y - 140 - k * 90;
      const ex = b.x + L.W / 2 + 120 + ib * 110;
      pts = [[hx, a.y], [hx, ty], [ex, ty], [ex, b.y]];
    } else if (b.y > a.y) {
      const k = nextLane('down' + a.y);
      const my = a.y + L.H + 140 + k * 90 + (l.dy || 0);
      const ex = b.x + L.W / 2 - 160 + ib * 110;
      pts = [[hx, a.y + L.H], [hx, my], [ex, my], [ex, b.y]];
    } else {
      const k = nextLane('up' + b.y);
      const my = b.y + L.H + L.GY - 140 - k * 90 + (l.dy || 0);
      const ex = b.x + L.W / 2 + 160 + ib * 110;
      pts = [[hx, a.y], [hx, my], [ex, my], [ex, b.y + L.H]];
    }
    pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    const col = COL[l.kind || 'main'];
    const v = figma.createVector();
    await v.setVectorNetworkAsync({
      vertices: pts.map((p, i) => ({ x: p[0], y: p[1], strokeCap: i === pts.length - 1 ? 'ARROW_EQUILATERAL' : 'NONE', cornerRadius: 40 })),
      segments: pts.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
    });
    v.strokes = paint(col); v.strokeWeight = 10; v.strokeJoin = 'ROUND';
    if (l.kind === 'back') v.dashPattern = [28, 22];
    v.name = `arrow ${l.from} → ${l.to}`;
    out.push(v);
    const dot = box(figma.createEllipse(), { n: 'start', x: pts[0][0] - 16, y: pts[0][1] - 16, w: 32, f: col });
    out.push(dot);
    if (l.label) {
      const seg = pts.length >= 3 ? [pts[1], pts[2]] : [pts[0], pts[1]];
      const t = text({ v: l.label, s: 34, ff: 'Poppins', fw: 'SemiBold', c: '#FFFFFF' });
      const pill = box(figma.createRectangle(), { n: 'label-bg', w: t.width + 48, h: t.height + 20, f: '#1A1233', r: 30, st: col, sw: 4 });
      const lt = l.lt ?? 0.5;
      pill.x = seg[0][0] + (seg[1][0] - seg[0][0]) * lt - pill.width / 2; pill.y = seg[0][1] + (seg[1][1] - seg[0][1]) * lt - pill.height / 2;
      t.x = pill.x + 24; t.y = pill.y + 10;
      pg.appendChild(t);
      out.push(pill, t);
    }
  }
  const g = figma.group(out, pg); g.name = 'Flow arrows' + SUF;
  const hdr = [];
  const minY = Math.min(...Object.values(frames).filter(Boolean).map((f) => f.y));
  hdr.push(text({ v: A.title, s: 120, ff: 'Fredoka', fw: 'Bold', x: 0, y: minY - 900 }));
  hdr.push(text({ v: A.subtitle, s: 48, ff: 'Poppins', fw: 'Regular', c: '#B9B3D9', x: 0, y: minY - 740 }));
  let lx = 0;
  for (const [k, lbl] of [['main', 'Main loop'], ['branch', 'Branch / overlay'], ['reward', 'Reward'], ['back', 'Back / close']]) {
    hdr.push(box(figma.createRectangle(), { n: 'swatch', x: lx, y: minY - 620, w: 80, h: 14, f: COL[k], r: 7 }));
    const t = text({ v: lbl, s: 40, ff: 'Poppins', fw: 'Medium', c: '#FFFFFF', x: lx + 100, y: minY - 650 });
    hdr.push(t); lx += 100 + t.width + 90;
  }
  const hg = figma.group(hdr, pg); hg.name = 'Board header' + SUF;
  return JSON.stringify({ reactions: bySrc.size, arrows: out.filter((n) => n.type === 'VECTOR').length, missing });
}

if (A.mode === 'shot') {
  const n = top(A.name);
  if (!n) throw new Error('no node ' + A.name);
  const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: A.scale || 0.4 } });
  return figma.base64Encode(bytes);
}

if (A.mode === 'view') {
  figma.viewport.scrollAndZoomIntoView(pg.children.filter((n) => n.visible));
  return 'ok';
}

if (A.mode === 'board') {
  const kids = pg.children.filter((n) => n.visible && (!A.names || A.names.includes(n.name)));
  const x0 = Math.min(...kids.map((n) => n.absoluteBoundingBox.x)), y0 = Math.min(...kids.map((n) => n.absoluteBoundingBox.y));
  const x1 = Math.max(...kids.map((n) => n.absoluteBoundingBox.x + n.absoluteBoundingBox.width)), y1 = Math.max(...kids.map((n) => n.absoluteBoundingBox.y + n.absoluteBoundingBox.height));
  const tmp = figma.createFrame(); tmp.name = 'tmp-board'; tmp.x = x0 - 200; tmp.y = y0 - 200; tmp.resize(x1 - x0 + 400, y1 - y0 + 400); tmp.fills = paint('#0F0B1E');
  pg.insertChild(0, tmp);
  for (const n of kids) { const ax = n.x, ay = n.y; tmp.appendChild(n); n.x = ax - tmp.x; n.y = ay - tmp.y; }
  const bytes = await tmp.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: A.width || 2400 } });
  for (const n of [...tmp.children]) { const x = n.x + tmp.x, y = n.y + tmp.y; pg.appendChild(n); n.x = x; n.y = y; }
  tmp.remove();
  return figma.base64Encode(bytes);
}
})()
