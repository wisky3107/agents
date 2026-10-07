'use strict';
// SVG kit for the director console: icons, one shared tooltip, the level map (a project's slices as
// a path of hex nodes), the workflow node graph, and stacked verdict columns. Text always goes in as
// text nodes, never as markup.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  // 24x24 stroke icons
  const ICONS = {
    map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z', 'M9 4v14', 'M15 6v14'],
    flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
    globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M3 12h18', 'M12 3c3 3.5 3 14.5 0 18', 'M12 3c-3 3.5-3 14.5 0 18'],
    chip: ['M7 7h10v10H7z', 'M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3'],
    flask: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3'],
    book: ['M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z', 'M5 18a2 2 0 0 1 2-2h11'],
    chart: ['M4 20V10M10 20V4M16 20v-7M3 20h18'],
    list: ['M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'],
    search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4'],
    check: ['M5 12l4 4 10-10'],
    x: ['M6 6l12 12M18 6 6 18'],
    play: ['M8 5v14l11-7z'],
    pause: ['M8 5v14M16 5v14'],
    stop: ['M6 6h12v12H6z'],
    lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
    alert: ['M12 3 2 21h20z', 'M12 10v5M12 18h.01'],
    bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
    terminal: ['M4 5h16v14H4z', 'M7 10l3 2-3 2M12 15h5'],
    refresh: ['M20 11a8 8 0 1 0-2 5.3', 'M20 4v7h-7'],
    moon: ['M20 14a8 8 0 1 1-10-10a7 7 0 0 0 10 10z'],
    user: ['M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
    merge: ['M6 4v16', 'M6 9c6 0 12 2 12 8', 'M18 17v3'],
    archive: ['M3 5h18v4H3z', 'M5 9v10h14V9', 'M10 13h4'],
    pack: ['M12 3 3 7.5v9L12 21l9-4.5v-9z', 'M3 7.5 12 12l9-4.5', 'M12 12v9'],
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z'],
    layers: ['M12 3 2 8l10 5 10-5z', 'M2 13l10 5 10-5'],
    harvest: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
    star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
    doc: ['M6 3h9l4 4v14H6z', 'M14 3v5h5'],
    chev: ['M9 6l6 6-6 6'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
    hand: ['M7 11V5a1.5 1.5 0 0 1 3 0v5', 'M10 10V4a1.5 1.5 0 0 1 3 0v6', 'M13 10V5a1.5 1.5 0 0 1 3 0v6', 'M16 11V8a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-3-5a1.5 1.5 0 0 1 2.5-1.6L7 14'],
  };
  /** An inline icon for HTML. */
  function icon(name, size = 16) {
    return s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      (ICONS[name] ?? ICONS.doc).map((d) => s('path', { d })));
  }
  /** An icon placed inside a graph, centred on (x, y). */
  function iconAt(name, x, y, size = 16, cls = '') {
    const k = size / 24;
    return s('g', { transform: `translate(${x - size / 2} ${y - size / 2}) scale(${k})`, class: `icon ${cls}` }, (ICONS[name] ?? ICONS.doc).map((d) => s('path', { d })));
  }

  // one tooltip for every chart; it repeats what a label or the table view also shows
  let tipEl = null;
  function tipOn(el, text) {
    const show = (e) => {
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.append(tipEl); }
      tipEl.textContent = typeof text === 'function' ? text() : text;
      tipEl.style.display = 'block';
      const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
      const y = Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
      tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', () => { if (tipEl) tipEl.style.display = 'none'; });
    return el;
  }
  const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; };

  // ------------------------------------------------------------------ level map
  const LEVEL = {
    merged: ['good', 'check', 'đã merge'], shipped: ['good', 'star', 'đã ship'], done: ['good', 'check', 'xong'],
    in_progress: ['live', 'play', 'đang làm'], running: ['live', 'play', 'đang làm'],
    blocked: ['bad', 'x', 'bị chặn'], failed: ['bad', 'x', 'lỗi'],
  };
  const levelState = (status) => LEVEL[status] ?? ['idle', 'lock', status === 'planned' ? 'chưa làm' : status || 'chưa làm'];
  const hexPath = (cx, cy, r) => Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k - 90);
    return `${k ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join('') + 'Z';

  /**
   * A project's slices as a level path. levels: [{slice, status, file}], meta: slice → {phase, cited, rounds}.
   * size 's' is the compact strip used on world cards.
   */
  function levelMap(levels, { meta = {}, onPick, size = 'm', selected } = {}) {
    const small = size === 's';
    const gap = small ? 34 : 92, r = small ? 10 : 22, amp = small ? 0 : 16;
    const pad = r + (small ? 6 : 26), h = small ? 34 : 128, mid = small ? 17 : 52;
    const w = Math.max(pad * 2 + (levels.length - 1) * gap, small ? 120 : 320);
    const pts = levels.map((_, i) => [pad + i * gap, mid + (small ? 0 : i % 2 ? amp : -amp)]);
    const root = s('svg', { class: 'graph', width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `Bản đồ ${levels.length} slice` });
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const next = levelState(levels[i + 1].status)[0];
      const cls = next === 'good' ? 'done' : next === 'live' ? 'on' : 'todo';
      root.append(s('path', { class: `edge ${cls}`, d: `M${x1} ${y1}C${x1 + gap / 2} ${y1} ${x2 - gap / 2} ${y2} ${x2} ${y2}`, 'stroke-width': small ? 1.5 : 2 }));
    }
    levels.forEach((lv, i) => {
      const [x, y] = pts[i];
      const [state, ic, label] = levelState(lv.status);
      const m = meta[lv.slice] ?? {};
      const g = s('g', { class: `node lvl ${state}${selected === lv.slice ? ' sel' : ''}`, tabindex: onPick ? 0 : null, role: onPick ? 'button' : null, 'aria-label': `${lv.slice} ${label}` });
      const off = small ? 2 : 3; // hard offset shadow, sticker style
      g.append(s('path', { class: 'hex-shadow', d: hexPath(x + off, y + off, r) }));
      g.append(s('path', { class: 'hex', d: hexPath(x, y, r) }));
      g.append(iconAt(ic, x, y, small ? 11 : 18, 'lvl-icon'));
      if (!small) {
        g.append(s('text', { x, y: y + r + 17, 'text-anchor': 'middle', class: 't-hud', 'font-size': 12, 'font-weight': 600 }, lv.slice));
        if (m.phase) g.append(s('text', { x, y: y + r + 31, 'text-anchor': 'middle', class: 't-muted', 'font-size': 10.5 }, m.phase));
        if (m.cited) {
          g.append(s('circle', { cx: x + r - 2, cy: y - r + 4, r: 8, class: 'cite-dot' }));
          g.append(s('text', { x: x + r - 2, y: y - r + 7.5, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, class: 'cite-num' }, m.cited));
        }
      }
      const tip = [`${lv.slice} · ${label}`, lv.file, m.phase ? `memory: ${m.phase}` : null, m.cited ? `trích dẫn memory: ${m.cited}` : null, m.rounds ?? null].filter(Boolean).join('\n');
      tipOn(g, tip);
      if (onPick) {
        g.addEventListener('click', () => { hideTip(); onPick(lv); });
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(lv); } });
      }
      root.append(g);
    });
    return root;
  }

  // ------------------------------------------------------------------ workflow graph
  /** nodes: [{id, x, y, title, sub, count, state, icon, onPick}], edges: [{from, to, state}] */
  function flowGraph(nodes, edges, { width = 1000, height = 360 } = {}) {
    const W = 186, H = 66;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    // fills its panel on wide screens and keeps a readable minimum (the wrapper scrolls) on phones
    const root = s('svg', { class: 'graph fluid', viewBox: `0 0 ${width} ${height}`, style: `min-width:${Math.round(width * 0.82)}px;max-width:${Math.round(width * 1.35)}px`, role: 'img', 'aria-label': 'Sơ đồ luồng workflow và memory' });
    const mid = 'arrow-' + Math.random().toString(36).slice(2, 8);
    root.append(s('defs', {}, s('marker', { id: mid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--line-2)' }))));
    for (const e of edges) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) continue;
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      let d;
      if (e.back) { // loop back under the row
        const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y + H;
        const dip = Math.max(y1, y2) + 46;
        d = `M${x1} ${y1}C${x1} ${dip} ${x2} ${dip} ${x2} ${y2 + 4}`;
      } else if (horiz) {
        const dir = b.x > a.x ? 1 : -1;
        const x1 = a.x + (dir > 0 ? W : 0), y1 = a.y + H / 2, x2 = b.x + (dir > 0 ? 0 : W), y2 = b.y + H / 2;
        const c = Math.max(30, Math.abs(x2 - x1) / 2);
        d = `M${x1} ${y1}C${x1 + dir * c} ${y1} ${x2 - dir * c} ${y2} ${x2 - dir * 4} ${y2}`;
      } else {
        const dir = b.y > a.y ? 1 : -1;
        const x1 = a.x + W / 2, y1 = a.y + (dir > 0 ? H : 0), x2 = b.x + W / 2, y2 = b.y + (dir > 0 ? 0 : H);
        const c = Math.max(24, Math.abs(y2 - y1) / 2);
        d = `M${x1} ${y1}C${x1} ${y1 + dir * c} ${x2} ${y2 - dir * c} ${x2} ${y2 - dir * 4}`;
      }
      const path = s('path', { class: `edge ${e.state ?? ''}`, d, 'marker-end': `url(#${mid})` });
      root.append(path);
      if (e.label) { // beside a vertical edge, above a horizontal one: never on the line
        const vertical = !e.back && !horiz;
        const lx = (a.x + b.x) / 2 + W / 2 + (vertical ? 10 : 0);
        const ly = e.back ? Math.max(a.y, b.y) + H + 38 : vertical ? (a.y + b.y) / 2 + H / 2 + 4 : (a.y + b.y) / 2 + H / 2 - 8;
        root.append(s('text', { x: lx, y: ly, 'text-anchor': vertical ? 'start' : 'middle', 'font-size': 10.5, class: 't-muted' }, e.label));
      }
    }
    for (const n of nodes) {
      const g = s('g', { class: `node ${n.state ?? ''}`, tabindex: 0, role: 'button', 'aria-label': `${n.title}: ${n.sub ?? ''}` });
      g.append(s('rect', { class: 'node-shadow', x: n.x + 4, y: n.y + 4, width: W, height: H, rx: 10 }));
      g.append(s('rect', { class: 'node-box', x: n.x, y: n.y, width: W, height: H, rx: 10 }));
      g.append(s('circle', { cx: n.x + 26, cy: n.y + H / 2, r: 15, class: 'node-ic-bg' }));
      g.append(iconAt(n.icon, n.x + 26, n.y + H / 2, 16, 'node-ic'));
      g.append(s('text', { x: n.x + 50, y: n.y + 29, 'font-size': 15, 'font-weight': 700 }, n.title));
      g.append(s('text', { x: n.x + 50, y: n.y + 47, 'font-size': 11.5, 'font-weight': 500, class: 't-muted' }, n.sub ?? ''));
      if (n.count != null) {
        const label = String(n.count), bw = 12 + label.length * 7;
        g.append(s('rect', { x: n.x + W - bw - 8, y: n.y - 9, width: bw, height: 19, rx: 9.5, class: `count ${n.countTone ?? ''}` }));
        g.append(s('text', { x: n.x + W - bw / 2 - 8, y: n.y + 4.5, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, class: `count-t ${n.countTone ?? ''}` }, label));
      }
      if (n.tip) tipOn(g, n.tip);
      if (n.onPick) {
        g.addEventListener('click', () => { hideTip(); n.onPick(); });
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); n.onPick(); } });
      }
      root.append(g);
    }
    return root;
  }

  // ------------------------------------------------------------------ verdict columns
  /** rows: [{slice, phase, verdicts: {name: n}, unjudged}], order: verdict names, label: name → text. */
  function verdictColumns(rows, { order, label, onPick }) {
    const band = 52, bw = 20, top = 30, plotH = 150, bottom = 30, left = 10;
    const max = Math.max(4, ...rows.map((r) => order.reduce((n, k) => n + (r.verdicts[k] ?? 0), 0)));
    const width = Math.max(left * 2 + rows.length * band, 320), height = top + plotH + bottom;
    const y0 = top + plotH, k = plotH / max;
    const root = s('svg', { class: 'graph', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Verdict theo slice' });
    // phase bands (consecutive slices with the same phase)
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].phase === rows[i].phase) j++;
      const x = left + i * band + 3, w = (j - i + 1) * band - 6;
      root.append(s('rect', { class: 'band', x, y: 4, width: w, height: height - 8, rx: 10 }));
      root.append(s('text', { x: x + 8, y: 19, 'font-size': 10.5, class: 't-muted t-hud' }, (rows[i].phase ?? '—').toUpperCase()));
      i = j + 1;
    }
    root.append(s('line', { class: 'axis', x1: left, x2: width - left, y1: y0 + 0.5, y2: y0 + 0.5 }));
    rows.forEach((r, idx) => {
      const cx = left + idx * band + band / 2, x = cx - bw / 2;
      const segs = order.map((name) => [name, r.verdicts[name] ?? 0]).filter(([, v]) => v > 0);
      const total = segs.reduce((n, [, v]) => n + v, 0);
      let y = y0;
      segs.forEach(([name, v], si) => {
        const hpx = v * k, isTop = si === segs.length - 1;
        const yTop = y - hpx, hh = Math.max(hpx - 2, 1); // 2px surface gap above each segment
        const shape = isTop
          ? s('path', { class: 'vseg', d: `M${x} ${y}V${yTop + 4}Q${x} ${yTop} ${x + 4} ${yTop}H${x + bw - 4}Q${x + bw} ${yTop} ${x + bw} ${yTop + 4}V${y}Z`, fill: `var(--v-${name})` })
          : s('rect', { class: 'vseg', x, y: yTop + 2, width: bw, height: hh, fill: `var(--v-${name})` });
        tipOn(shape, `${r.slice} · ${label[name]}: ${v}`);
        root.append(shape);
        y = yTop;
      });
      if (total) root.append(s('text', { x: cx, y: y - 6, 'text-anchor': 'middle', 'font-size': 11, class: 't-muted' }, total));
      else if (r.unjudged) {
        const t = s('text', { x: cx, y: y0 - 8, 'text-anchor': 'middle', 'font-size': 11, class: 't-muted' }, `${r.unjudged}?`);
        tipOn(t, `${r.slice}: ${r.unjudged} item chưa judge`);
        root.append(t);
      }
      const lab = s('text', { x: cx, y: y0 + 19, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600, class: 't-hud', style: onPick ? 'cursor:pointer' : null }, r.slice);
      if (onPick) lab.addEventListener('click', () => onPick(r));
      root.append(lab);
    });
    return root;
  }

  window.G = { s, icon, iconAt, tipOn, hideTip, levelMap, flowGraph, verdictColumns, levelState };
})();
