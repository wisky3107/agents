import { BG, P, B, C, E, F, G, H, I, R, T, bottomNav, currency, glow, modal, ribbon, scrim } from './_kit.mjs';

const header = (title, o = {}) => [
  ...(o.back ? [B('btn-back', 40, 60, 100, 100, { i: 'back', is: 52, f: '#FFFFFF1A', st: C.glassLine, sw: 2, sh: [] })] : []),
  H(title, o.back ? 170 : 48, 72, 72),
  ...(o.gems ? [{ ...currency('pill-diamond', 750, 'diamond', C.cyan, '1,250'), y: 68 }] : []),
];
const toggle = (n, x, y, on) => F(n, x, y, 128, 68, [E(on ? 66 : 6, 6, 56, '#FFFFFF', { sh: [{ c: '#00000055', y: 3, b: 8 }] })],
  { f: on ? G.green : '#FFFFFF26', r: 34 });
const slider = (n, x, y, w, v) => F(n, x, y, w, 56, [
  R(0, 22, w, 12, '#FFFFFF26', 6), R(0, 22, w * v, 12, G.hot, 6), E(w * v - 28, 0, 56, '#FFFFFF', { sh: [glow(C.pink, 20)] }),
]);
const card = (n, y, h, ch) => F(n, 40, y, 1000, h, ch, { f: '#1A1240B3', r: 40, st: C.glassLine, sw: 2, bb: 30 });
const label = (v, y) => T(v, 64, y, 28, { c: C.muted, fw: 'Bold', ls: 10 });
const rowItem = (n, ic, v, y, right) => F(n, 30, y, 940, 110, [
  F('ico', 0, 15, 80, 80, [I(ic, 18, 18, 44, '#FFFFFF')], { f: '#FFFFFF14', r: 24 }),
  T(v, 110, 30, 40, { fw: 'Medium' }),
  ...right,
]);
const chevron = (txt) => [...(txt ? [T(txt, 560, 32, 36, { w: 300, al: 'RIGHT', c: C.muted })] : []), I('chev', 880, 35, 40, C.muted)];

const settings = {
  id: 'settings', name: '10 Settings', col: 0, row: 1, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    ...header('Settings'),
    label('AUDIO', 210),
    card('audio', 260, 260, [
      rowItem('music', 'music', 'Music', 20, [slider('music-vol', 520, 27, 400, 0.8)]),
      rowItem('sfx', 'volume', 'Tap sounds', 130, [slider('sfx-vol', 520, 27, 400, 0.55)]),
    ]),
    label('GAMEPLAY', 570),
    card('gameplay', 620, 370, [
      rowItem('vibe', 'vibrate', 'Vibration', 20, [toggle('t-vibe', 812, 21, true)]),
      rowItem('hints', 'hand', 'Tap hints', 130, [toggle('t-hints', 812, 21, false)]),
      rowItem('speed', 'bolt', 'Note speed', 240, [F('speed', 470, 15, 470, 80, [
        B('sp-1', 6, 6, 148, 68, { v: '1x', s: 32, f: '#00000000', c: C.muted, sh: [] }),
        B('sp-2', 160, 6, 148, 68, { v: '1.5x', s: 32, f: '#FFFFFF', c: C.ink, sh: [] }),
        B('sp-3', 314, 6, 148, 68, { v: '2x', s: 32, f: '#00000000', c: C.muted, sh: [] }),
      ], { f: '#00000059', r: 40 })]),
    ]),
    label('GENERAL', 1040),
    card('general', 1090, 480, [
      rowItem('lang', 'globe', 'Language', 20, chevron('English')),
      rowItem('restore', 'refresh', 'Restore purchases', 130, chevron()),
      rowItem('privacy', 'lock', 'Privacy policy', 240, chevron()),
      rowItem('support', 'user', 'Help & support', 350, chevron()),
    ]),
    T('Melody Tiles v1.0.0 · ID 48213977', 0, 1620, 30, { w: 1080, al: 'CENTER', c: '#FFFFFF66' }),
    bottomNav('settings'),
  ],
};

const pack = (i, x, y, amount, price, gems, tag) => F('pack-' + i, x, y, 480, 400, [
  E(90, 10, 300, { rad: 1, c: ['#3FE0FF55', '#3FE0FF00'] }),
  P('gems-art', (480 - [0, 150, 190, 230][Math.min(gems, 5) > 3 ? 3 : Math.min(gems, 3) > 1 ? 2 : 1]) / 2, [0, 50, 20, 0][gems > 3 ? 3 : gems > 1 ? 2 : 1], [0, 150, 190, 230][gems > 3 ? 3 : gems > 1 ? 2 : 1], [0, 150, 190, 230][gems > 3 ? 3 : gems > 1 ? 2 : 1], 'gem-pile'),
  H(amount, 0, 210, 60, { w: 480, al: 'CENTER' }),
  B('buy-' + i, 60, 300, 360, 80, { v: price, s: 38, f: G.green, c: C.ink }),
  ...(tag ? [B('tag', 300, 16, 160, 56, { v: tag, s: 26, f: G.hot, sh: [] })] : []),
], { f: '#1A1240B3', r: 40, st: C.glassLine, sw: 2, bb: 30, clip: true });

const shop = {
  id: 'shop', name: '08 Shop', col: 1, row: 1, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    ...header('Shop', { gems: true }),
    F('shop-tabs', 40, 200, 1000, 96, [
      B('st-gems', 0, 8, 320, 80, { v: 'Diamonds', s: 34, f: '#FFFFFF', c: C.ink, sh: [] }),
      B('st-songs', 340, 8, 320, 80, { v: 'Song packs', s: 34, f: '#FFFFFF14', c: C.muted, st: C.glassLine, sw: 2, sh: [] }),
      B('st-vip', 680, 8, 320, 80, { i: 'crown', v: 'VIP', s: 34, is: 38, f: '#FFFFFF14', c: C.muted, ic: C.gold, st: C.glassLine, sw: 2, sh: [] }),
    ]),
    F('vip-banner', 40, 330, 1000, 340, [
      E(620, -160, 600, { rad: 1, c: ['#FFFFFF66', '#FFFFFF00'] }),
      P('crown-art', 710, 30, 290, 290, 'crown'),
      H('VIP Pass', 48, 40, 80, { c: C.ink }),
      T('Unlimited energy · No ads · All songs', 48, 140, 34, { c: '#2B1A00', fw: 'SemiBold' }),
      B('btn-vip', 48, 220, 440, 90, { v: 'Try 3 days free', s: 38, f: C.ink, c: '#FFFFFF', sh: [] }),
    ], { f: { c: ['#FFE07A', '#FFB020', '#FF7A2F'], a: 20 }, r: 48, clip: true, sh: [glow(C.gold, 40)] }),
    pack(1, 40, 710, '80', '$0.99', 1),
    pack(2, 560, 710, '500', '$4.99', 3, 'POPULAR'),
    pack(3, 40, 1140, '1,200', '$9.99', 5, 'BEST'),
    F('free-pack', 560, 1140, 480, 400, [
      I('video', 160, 60, 160, C.green, { sh: [glow(C.green, 30)] }),
      H('+20 free', 0, 210, 60, { w: 480, al: 'CENTER' }),
      B('btn-free', 60, 300, 360, 80, { i: 'video', v: 'Watch', s: 38, is: 40, f: G.cta, c: C.ink, ic: C.ink }),
    ], { f: C.glass, r: 40, st: C.green, sw: 3 }),
    bottomNav('shop'),
  ],
};

const day = (d, x, y, w, h, state, amount) => F('day-' + d, x, y, w, h, d === 7 ? [
  P('chest-art', 70, 10, 200, 200, 'chest'),
  T('Day 7', 290, 50, 32, { fw: 'Bold', c: C.muted }),
  H(amount, 290, 96, 44),
  B('tag-big', 600, 74, 150, 64, { v: '+500', s: 32, f: G.hot, sh: [] }),
] : [
  T('Day ' + d, 0, 16, 30, { w, al: 'CENTER', fw: 'Bold', c: state === 'today' ? C.ink : C.muted }),
  I('diamond', (w - 84) / 2, 64, 84, C.cyan, { op: state === 'claimed' ? 0.35 : 1, sh: state === 'today' ? [glow(C.cyan, 20)] : [] }),
  T(amount, 0, h - 64, 34, { w, al: 'CENTER', fw: 'Bold', c: state === 'today' ? C.ink : '#FFFFFF' }),
  ...(state === 'claimed' ? [F('done', w / 2 - 38, 70, 76, 76, [I('check', 14, 14, 48, '#FFFFFF')], { f: G.green, r: 38 })] : []),
], {
  f: state === 'today' ? G.gold : state === 'claimed' ? '#FFFFFF0D' : '#FFFFFF1A', r: 32,
  st: state === 'today' ? '#FFFFFF' : C.glassLine, sw: state === 'today' ? 5 : 2, sh: state === 'today' ? [glow(C.gold, 40)] : [],
});

const daily = {
  id: 'daily', name: '09 Daily Reward', col: 2, row: 1, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    R(40, 60, 1000, 400, C.glass, 56), R(40, 500, 1000, 1000, C.glass, 40, { op: 0.5 }),
    scrim(0.75),
    modal('daily-card', 300, 1340, [
      H('Day 4 streak!', 0, 140, 56, { w: 900, al: 'CENTER', c: C.gold }),
      T('Come back every day for bigger rewards', 0, 220, 34, { w: 900, al: 'CENTER', c: C.muted }),
      ...[1, 2, 3, 4, 5, 6].map((d) => day(d, 60 + ((d - 1) % 3) * 266, 300 + Math.floor((d - 1) / 3) * 290, 246, 270,
        d < 4 ? 'claimed' : d === 4 ? 'today' : 'locked', ['+20', '+30', '+40', '+50', '+60', '+80'][d - 1])),
      day(7, 60, 890, 780, 220, 'locked', 'Mystery chest'),
      B('btn-claim', 120, 1150, 420, 130, { v: 'CLAIM', s: 52, f: G.cta, c: C.ink, sh: [glow(C.cyan, 40)] }),
      B('btn-claim-x2', 560, 1150, 220, 130, { i: 'video', v: 'x2', s: 48, is: 48, f: G.green, c: C.ink, ic: C.ink }),
    ]),
    ribbon('DAILY REWARD', 240),
    B('btn-close', 920, 230, 100, 100, { i: 'close', is: 44, f: '#FFFFFF26', st: C.glassLine, sw: 2, sh: [] }),
  ],
};

export default {
  screens: [shop, daily, settings],
  links: [
    { from: 'daily', node: 'btn-claim', to: 'home', kind: 'reward', label: 'Claim +50' },
    { from: 'daily', node: 'btn-close', to: 'home', noArrow: true },
    { from: 'shop', node: 'nav-home', to: 'home', kind: 'back', label: 'Home tab', noArrow: true },
    { from: 'settings', node: 'nav-home', to: 'home', kind: 'back', label: 'Home tab', noArrow: true },
    { from: 'settings', node: 'nav-shop', to: 'shop', noArrow: true },
    { from: 'shop', node: 'nav-settings', to: 'settings', noArrow: true },
  ],
};
