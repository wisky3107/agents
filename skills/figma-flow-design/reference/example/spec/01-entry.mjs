import { BG, B, C, E, F, G, H, I, R, T, bottomNav, glow, songRow, stars, topBar } from './_kit.mjs';

// Logo: four tilted piano tiles + note.
const logo = (x, y) => F('logo', x, y, 520, 520, [
  E(40, 40, 440, { rad: 1, c: ['#FF4FD866', '#FF4FD800'] }),
  ...[0, 1, 2, 3].map((k) => R(70 + k * 98, 110 + (k % 2) * 60, 86, 300, k === 1 ? G.cta : { c: ['#1A1233', '#000000'], a: 90 }, 18,
    { st: k === 1 ? '#FFFFFF' : '#FFFFFF55', sw: 3, sh: [glow(k === 1 ? C.cyan : C.pink, 30)] })),
  I('note', 300, 40, 150, C.gold, { sh: [glow(C.gold, 30)] }),
]);

const splash = {
  id: 'splash', name: '01 Splash', col: 0, row: 0, bg: BG.splash,
  ch: [
    R(0, 900, 1080, 1020, { c: ['#0A082000', '#0A0820E6'], a: 90 }),
    H('Melody Tiles', 0, 1060, 150, { w: 1080, al: 'CENTER', sh: [glow(C.pink, 40)] }),
    T('Tap the beat. Feel the music.', 0, 1240, 44, { w: 1080, al: 'CENTER', c: C.muted, fw: 'Medium' }),
    R(190, 1600, 700, 28, '#FFFFFF1F', 14),
    R(190, 1600, 476, 28, G.cta, 14, { n: 'loading-fill', sh: [glow(C.cyan, 20)] }),
    T('Loading songs… 68%', 0, 1650, 34, { w: 1080, al: 'CENTER', c: C.muted }),
    T('Tip: hold long tiles until they end for bonus points', 0, 1790, 30, { w: 1080, al: 'CENTER', c: '#FFFFFF80', fw: 'Regular' }),
  ],
};

const home = {
  id: 'home', name: '02 Home', col: 1, row: 0, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    ...topBar(),
    F('featured', 40, 200, 1000, 480, [
      R(0, 0, 1000, 480, { c: ['#1A0B3FF2', '#1A0B3F99', '#1A0B3F00'], p: [0, 0.5, 0.8], a: 0 }),
      B('tag-hot', 48, 48, 230, 64, { i: 'fire', v: 'FEATURED', s: 28, is: 32, f: '#00000040', sh: [] }),
      H('Canon in D', 48, 140, 88, { sh: [drop2()] }),
      T('Pachelbel · Piano remix', 48, 250, 36, { c: '#FFFFFFCC', fw: 'Medium' }),
      ...stars(48, 320, 0, 52),
      T('128 BPM · Normal', 48, 392, 32, { c: '#FFFFFFB3' }),
      B('btn-featured-play', 740, 180, 200, 200, { i: 'play', is: 100, f: '#FFFFFF', ic: C.pink, sh: [glow('#FFFFFF', 40)] }),
    ], { f: { img: 'cover-canon' }, r: 56, clip: true, st: '#FFFFFF40', sw: 3, sh: [glow(C.pink, 50)] }),
    F('tabs', 40, 720, 1000, 96, [
      B('tab-all', 0, 8, 260, 80, { v: 'All Songs', s: 34, f: '#FFFFFF', c: C.ink, sh: [] }),
      ...['Hot', 'New', 'Classic'].map((v, i) => B('tab-' + v.toLowerCase(), 290 + i * 236, 8, 210, 80, { v, s: 34, f: '#FFFFFF14', c: C.muted, sh: [], st: C.glassLine, sw: 2 })),
    ]),
    songRow(1, 850, 'Für Elise', 'Beethoven', 3, 'play', 'cover-fur-elise', 'Best 312'),
    songRow(2, 1050, 'Moonlight Sonata', 'Beethoven', 2, 'play', 'cover-moonlight', 'Best 205'),
    songRow(3, 1250, 'Turkish March', 'Mozart', 0, 'ad', 'cover-turkish'),
    songRow(4, 1450, 'Clair de Lune', 'Debussy', 0, 'lock', 'cover-clair'),
    R(0, 1600, 1080, 120, { c: ['#0A1B4500', '#0A1B45'], a: 90 }),
    bottomNav('home'),
  ],
};
function drop2() { return { c: '#00000055', y: 6, b: 16 }; }

export default {
  screens: [splash, home],
  links: [
    { from: 'splash', to: 'home', trig: 'timeout', ms: 2, label: 'auto 2s' },
    { from: 'home', node: 'btn-play-1', to: 'preview', label: 'Play song' },
    { from: 'home', node: 'btn-featured-play', to: 'preview', noArrow: true },
    { from: 'home', node: 'btn-gift', to: 'daily', kind: 'reward', label: 'Gift' },
    { from: 'home', node: 'nav-shop', to: 'shop', kind: 'branch', label: 'Shop tab' },
    { from: 'home', node: 'pill-diamond-plus', to: 'shop', noArrow: true },
    { from: 'home', node: 'btn-unlock-4', to: 'shop', noArrow: true },
    { from: 'home', node: 'nav-settings', to: 'settings', kind: 'branch', label: 'Settings tab' },
  ],
};
