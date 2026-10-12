// Shared palette + components for the Melody Tiles screens (1080×1920).
export const C = {
  cyan: '#3FE0FF', pink: '#FF4FD8', gold: '#FFC83D', green: '#3DDC97', red: '#FF5470', violet: '#8B5CFF',
  ink: '#0D0B1A', text: '#FFFFFF', muted: '#B9B3D9', glass: '#FFFFFF14', glassLine: '#FFFFFF26', panel: '#221A47',
};
export const G = {
  cta: { c: ['#3FE0FF', '#4F7BFF'], a: 0 },
  hot: { c: ['#FF4FD8', '#8B5CFF'], a: 0 },
  gold: { c: ['#FFE07A', '#FFB020'], a: 90 },
  green: { c: ['#5BF0B0', '#1FBF7A'], a: 90 },
  dim: { c: ['#120B2B', '#0A0A1F'], a: 90 },
};
export const glow = (c, b = 40) => ({ c: c + '99', b, y: 0 });
export const drop = { c: '#00000066', y: 10, b: 24 };

export const T = (v, x, y, s = 40, o = {}) => ({ t: 'text', v, x, y, s, ...o });
export const H = (v, x, y, s = 64, o = {}) => ({ t: 'text', v, x, y, s, ff: 'Fredoka', fw: 'Bold', ...o });
export const R = (x, y, w, h, f, r = 0, o = {}) => ({ t: 'rect', x, y, w, h, f, r, ...o });
export const E = (x, y, w, f, o = {}) => ({ t: 'ellipse', x, y, w, h: o.h || w, f, ...o });
export const I = (i, x, y, s = 64, c = '#FFFFFF', o = {}) => ({ t: 'icon', i, x, y, s, c, ...o });
export const F = (n, x, y, w, h, ch = [], o = {}) => ({ t: 'frame', n, x, y, w, h, ch, ...o });
export const P = (n, x, y, w, h, img, o = {}) => ({ t: 'rect', n, x, y, w, h, f: { img, mode: o.mode || 'FILL' }, r: o.r || 0, ...o });
export const BG = { menu: { img: 'bg-menu' }, play: { img: 'bg-gameplay' }, splash: { img: 'splash-keyart' } };
export const B = (n, x, y, w, h, o = {}) => ({ t: 'btn', n, x, y, w, h, r: Math.min(h / 2, o.r ?? h / 2), f: G.cta, sh: [drop], ...o });

// Pill showing a currency amount with a "+" bubble.
export const currency = (n, x, icon, color, amount, w = 290) =>
  F(n, x, 70, w, 84, [
    I(icon, 14, 12, 60, color, { sh: [glow(color, 20)] }),
    T(amount, 88, 18, 38, { fw: 'Bold' }),
    B(n + '-plus', w - 70, 14, 56, 56, { i: 'plus', is: 30, f: G.green, sh: [] }),
  ], { f: '#00000059', r: 42, st: C.glassLine, sw: 3 });

// Avatar + level, currencies, gift button.
export const topBar = (o = {}) => [
  F('profile', 40, 60, 104, 104, [
    E(0, 0, 104, { c: ['#FF9AE8', '#8B5CFF'], a: 45 }, { st: '#FFFFFF', sw: 5 }),
    I('user', 22, 18, 60, '#FFFFFF'),
    B('lvl', 58, 70, 54, 40, { v: '12', s: 26, f: G.gold, c: C.ink, sh: [] }),
  ]),
  currency('pill-diamond', 168, 'diamond', C.cyan, o.diamond || '1,250'),
  currency('pill-energy', 482, 'bolt', C.gold, o.energy || '5/5', 240),
  ...(o.noGift ? [] : [B('btn-gift', 936, 66, 104, 96, { i: 'gift', is: 60, f: G.hot, r: 30, sh: [glow(C.pink, 30)],
    ch: [E(78, -6, 30, C.red, { st: '#FFFFFF', sw: 4 })] })]),
];

export const stars = (x, y, n, s = 40, of = 3) =>
  Array.from({ length: of }, (_, i) => I('star', x + i * (s + 6), y, s, i < n ? C.gold : '#FFFFFF33', i < n ? { sh: [glow(C.gold, 12)] } : {}));

// Song card in the list. state: 'play' | 'lock' | 'ad'
export const songRow = (i, y, title, artist, nStars, state = 'play', tint = G.hot, best = '') =>
  F('row-' + i, 40, y, 1000, 176, [
    typeof tint === 'string' ? P('thumb', 20, 20, 136, 136, tint, { r: 28, st: '#FFFFFF33', sw: 2 })
      : F('thumb', 20, 20, 136, 136, [I('music', 32, 32, 72, '#FFFFFF')], { f: tint, r: 28 }),
    H(title, 184, 26, 44, { fw: 'SemiBold' }),
    T(artist, 184, 82, 30, { c: C.muted, fw: 'Regular' }),
    ...stars(184, 124, nStars, 34),
    ...(best ? [T(best, 320, 124, 28, { c: C.muted, fw: 'Medium' })] : []),
    state === 'play'
      ? B('btn-play-' + i, 790, 48, 186, 80, { i: 'play', v: 'PLAY', s: 34, is: 34, f: G.cta, c: C.ink, ic: C.ink })
      : state === 'ad'
        ? B('btn-ad-' + i, 790, 48, 186, 80, { i: 'video', v: 'FREE', s: 34, is: 36, f: G.green, c: C.ink, ic: C.ink })
        : B('btn-unlock-' + i, 790, 48, 186, 80, { i: 'diamond', v: '200', s: 34, is: 34, f: '#FFFFFF1F', c: '#FFFFFF', ic: C.cyan, st: C.cyan, sw: 3, sh: [] }),
  ], { f: '#1A1240B3', r: 40, st: C.glassLine, sw: 2, bb: 30 });

// Bottom navigation; `active` is the tab key.
export const bottomNav = (active) => {
  const tabs = [['home', 'home', 'Home'], ['rank', 'trophy', 'Ranking'], ['shop', 'cart', 'Shop'], ['settings', 'gear', 'Settings']];
  return F('bottom-nav', 0, 1720, 1080, 200, tabs.map(([k, ic, lbl], i) => {
    const on = k === active, x = 15 + i * 262;
    return F('nav-' + k, x, 20, 262, 150, [
      ...(on ? [R(41, 0, 180, 120, G.hot, 40, { sh: [glow(C.pink, 30)] })] : []),
      I(ic, 99, 16, 64, on ? '#FFFFFF' : C.muted),
      T(lbl, 0, 86, 30, { w: 262, al: 'CENTER', c: on ? '#FFFFFF' : C.muted, fw: on ? 'Bold' : 'Medium' }),
    ]);
  }), { f: '#0B0820CC', st: C.glassLine, sw: 2, bb: 40 });
};

// Dimmed full-screen backdrop for overlays.
export const scrim = (op = 0.72) => R(0, 0, 1080, 1920, '#05030F', 0, { op });

// Ghost gameplay behind overlays (lanes + a few tiles).
export const ghostLanes = () => [
  ...[1, 2, 3].map((k) => R(k * 270 - 1, 0, 2, 1920, '#FFFFFF1A')),
  R(0, 380, 270, 420, '#0D0B1A'), R(540, 120, 270, 420, '#0D0B1A'), R(270, 900, 270, 420, '#0D0B1A'), R(810, 1240, 270, 420, '#0D0B1A'),
];

// Centered modal card.
export const modal = (n, y, h, ch, o = {}) => F(n, 90, y, 900, h, ch, { f: { c: ['#3A1F86F2', '#1B1446F2'], a: 90 }, bb: 40, r: 56, st: '#FFFFFF33', sw: 3, sh: [{ c: '#000000AA', y: 30, b: 80 }], ...o });
export const ribbon = (v, y, f = G.hot) => B('ribbon', 190, y, 700, 120, { v, s: 60, f, r: 30, ls: 2, sh: [glow(C.pink, 40)] });
