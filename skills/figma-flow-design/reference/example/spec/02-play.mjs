import { BG, B, C, E, F, G, H, I, R, T, drop, ghostLanes, glow, modal, scrim, stars } from './_kit.mjs';

const vinyl = (x, y, d) => F('album', x, y, d, d, [
  E(0, 0, d, { c: ['#1A1233', '#000000'], a: 45 }, { sh: [glow(C.pink, 60)] }),
  ...[0.86, 0.72, 0.58].map((k) => E((d * (1 - k)) / 2, (d * (1 - k)) / 2, d * k, null, { st: '#FFFFFF1A', sw: 3 })),
  E(d * 0.25, d * 0.25, d * 0.5, { img: 'cover-fur-elise' }, { st: '#FFFFFF', sw: 6 }),
]);

const preview = {
  id: 'preview', name: '03 Song Preview', col: 2, row: 0, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    E(140, 80, 800, { rad: 1, c: ['#FF4FD840', '#FF4FD800'] }),
    B('btn-back', 40, 60, 100, 100, { i: 'back', is: 52, f: '#FFFFFF1A', st: C.glassLine, sw: 2, sh: [] }),
    B('btn-share', 940, 60, 100, 100, { i: 'share', is: 48, f: '#FFFFFF1A', st: C.glassLine, sw: 2, sh: [] }),
    vinyl(260, 200, 560),
    H('Für Elise', 0, 820, 96, { w: 1080, al: 'CENTER' }),
    T('Beethoven · Piano', 0, 940, 40, { w: 1080, al: 'CENTER', c: C.muted, fw: 'Medium' }),
    F('progress', 240, 1020, 600, 90, stars(0, 10, 3, 70, 3).concat([
      I('crown', 228, 6, 76, '#FFFFFF33'), I('crown', 314, 6, 76, '#FFFFFF33'), I('crown', 400, 6, 76, '#FFFFFF33'),
    ]).map((n, i) => ({ ...n, x: i * 100 + 10 }))),
    T('Best 312 · 3★ cleared — reach the crowns in Hard', 0, 1130, 32, { w: 1080, al: 'CENTER', c: '#FFFFFFB3' }),
    F('difficulty', 120, 1220, 840, 110, [
      B('diff-easy', 10, 10, 260, 90, { v: 'Easy', s: 36, f: '#00000000', c: C.muted, sh: [] }),
      B('diff-normal', 290, 10, 260, 90, { v: 'Normal', s: 36, f: '#FFFFFF', c: C.ink, sh: [] }),
      B('diff-hard', 570, 10, 260, 90, { v: 'Hard', s: 36, f: '#00000000', c: C.muted, sh: [] }),
    ], { f: '#00000059', r: 55, st: C.glassLine, sw: 2 }),
    F('leaders', 120, 1370, 840, 190, [
      T('FRIENDS', 30, 20, 26, { c: C.muted, fw: 'Bold', ls: 8 }),
      ...[['Lan', '1,024', C.gold], ['Minh', '880', '#D9D9E6'], ['You', '312', '#E0904A']].map(([nm, sc, mc], i) => F('leader-' + i, 30 + i * 270, 64, 250, 100, [
        E(0, 10, 80, { c: ['#FF9AE8', '#4F7BFF'], a: 45 }, { st: mc, sw: 5 }),
        T(nm, 96, 12, 32, { fw: 'Bold' }), T(sc, 96, 54, 28, { c: C.muted }),
      ])),
    ], { f: '#1A1240B3', r: 36, st: C.glassLine, sw: 2, bb: 30 }),
    B('btn-start', 140, 1620, 800, 160, { i: 'play', v: 'PLAY', s: 64, is: 64, f: G.cta, c: C.ink, ic: C.ink, sh: [glow(C.cyan, 50)],
      ch: [B('cost', 610, 40, 150, 80, { i: 'bolt', v: '1', s: 36, is: 40, f: '#0D0B1A59', c: '#FFFFFF', ic: C.gold, sh: [] })] }),
  ],
};

// Gameplay: lanes, tiles, HUD.
const tile = (n, lane, y, h = 420, o = {}) => R(lane * 270 + 4, y, 262, h, o.f || { c: ['#1C1830', '#050409'], a: 90 }, 10, { n, st: '#FFFFFF33', sh: [{ c: '#00000080', y: 12, b: 30 }], sw: 2, ...o });
const gameplay = {
  id: 'gameplay', name: '04 Gameplay', col: 3, row: 0,
  bg: BG.play,
  ch: [
    R(0, 0, 1080, 1920, '#00000000', 0, { n: 'lane-empty' }),
    ...[1, 2, 3].map((k) => R(k * 270 - 1, 0, 2, 1920, '#FFFFFF26')),
    tile('tile-a', 1, -260),
    { ...tile('tile-long', 2, 180, 760, { f: { c: ['#1C1830', '#050409'], a: 90 } }) },
    R(2 * 270 + 4, 600, 262, 340, { c: ['#3FE0FF00', '#3FE0FF'], a: 90 }, 10, { n: 'hold-trail', sh: [glow(C.cyan, 40)] }),
    E(2 * 270 + 85, 860, 100, '#FFFFFF', { n: 'hold-dot', sh: [glow(C.cyan, 40)] }),
    tile('tile-hit', 0, 760, 420, { f: '#FFFFFF1F', st: '#FFFFFF33' }),
    E(-40, 820, 350, { rad: 1, c: ['#3FE0FF80', '#3FE0FF00'] }, { n: 'hit-ripple' }),
    tile('tile-next', 3, 1180),
    R(0, 1440, 1080, 6, { c: ['#FF4FD800', '#FF4FD8', '#FF4FD800'], a: 0 }, 0, { n: 'judge-line', op: 0.6 }),
    // HUD
    R(0, 0, 1080, 260, { c: ['#0A0A1FCC', '#0A0A1F00'], a: 90 }),
    B('btn-pause', 40, 50, 96, 96, { i: 'pause', is: 44, f: '#FFFFFF26', st: C.glassLine, sw: 2, sh: [] }),
    F('song-progress', 170, 82, 870, 34, [
      R(0, 6, 870, 22, '#FFFFFF26', 11), R(0, 6, 540, 22, G.gold, 11, { sh: [glow(C.gold, 16)] }),
      I('star', 270, -6, 46, C.gold), I('star', 560, -6, 46, '#FFFFFF66'), I('star', 830, -6, 46, '#FFFFFF66'),
    ]),
    H('286', 0, 170, 150, { w: 1080, al: 'CENTER', sh: [glow(C.pink, 30)] }),
    H('PERFECT', 0, 560, 84, { w: 1080, al: 'CENTER', c: C.cyan, sh: [glow(C.cyan, 30)], ls: 4 }),
    B('combo', 400, 670, 280, 76, { i: 'fire', v: 'x24', s: 44, is: 44, f: G.hot, sh: [glow(C.pink, 30)] }),
  ],
};

const pause = {
  id: 'pause', name: '05 Pause', col: 3, row: 1,
  bg: gameplay.bg,
  ch: [
    ...ghostLanes(), scrim(),
    modal('pause-card', 470, 980, [
      I('pause', 380, 60, 140, C.cyan, { sh: [glow(C.cyan, 40)] }),
      H('Paused', 0, 220, 96, { w: 900, al: 'CENTER' }),
      T('Für Elise · Normal · 286 pts', 0, 340, 36, { w: 900, al: 'CENTER', c: C.muted }),
      B('btn-resume', 120, 440, 660, 130, { i: 'play', v: 'RESUME', s: 52, is: 52, f: G.cta, c: C.ink, ic: C.ink, sh: [glow(C.cyan, 40)] }),
      B('btn-restart', 120, 600, 320, 116, { i: 'refresh', v: 'Restart', s: 40, is: 42, f: '#FFFFFF1F', st: C.glassLine, sw: 2, sh: [] }),
      B('btn-home', 460, 600, 320, 116, { i: 'home', v: 'Home', s: 40, is: 42, f: '#FFFFFF1F', st: C.glassLine, sw: 2, sh: [] }),
      F('toggles', 120, 770, 660, 140, [
        B('t-music', 0, 20, 200, 100, { i: 'music', is: 50, f: G.hot, sh: [], r: 30 }),
        B('t-sfx', 230, 20, 200, 100, { i: 'volume', is: 50, f: G.hot, sh: [], r: 30 }),
        B('t-vibe', 460, 20, 200, 100, { i: 'vibrate', is: 50, f: '#FFFFFF1F', st: C.glassLine, sw: 2, sh: [], r: 30 }),
      ]),
    ]),
  ],
};
void drop;

export default {
  screens: [preview, gameplay, pause],
  links: [
    { from: 'preview', node: 'btn-start', to: 'gameplay', label: 'Play (−1 energy)' },
    { from: 'preview', node: 'btn-back', to: 'home', kind: 'back', label: 'Back', noArrow: true },
    { from: 'gameplay', node: 'tile-next', to: 'result', label: 'Song complete' },
    { from: 'gameplay', node: 'btn-pause', to: 'pause', kind: 'branch', label: 'Pause' },
    { from: 'gameplay', node: 'lane-empty', to: 'revive', kind: 'branch', label: 'Miss / wrong tap', lt: 0.45, dy: -60 },
    { from: 'pause', node: 'btn-resume', to: 'gameplay', kind: 'back', label: 'Resume' },
    { from: 'pause', node: 'btn-restart', to: 'gameplay', noArrow: true },
    { from: 'pause', node: 'btn-home', to: 'home', kind: 'back', label: 'Quit to Home', noArrow: true },
  ],
};
