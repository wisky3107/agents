import { BG, P, B, C, E, F, G, H, I, R, T, ghostLanes, glow, modal, ribbon, scrim } from './_kit.mjs';

const PLAY_BG = BG.play;

const revive = {
  id: 'revive', name: '06 Revive', col: 4, row: 1,
  bg: PLAY_BG,
  ch: [
    ...ghostLanes(),
    R(270, 1600, 270, 320, '#FF5470', 10, { n: 'missed-tile', sh: [glow(C.red, 50)] }),
    scrim(0.7),
    modal('revive-card', 360, 1200, [
      H('Continue?', 0, 70, 96, { w: 900, al: 'CENTER' }),
      T('You missed a tile at 74% — keep the run alive!', 80, 190, 36, { w: 740, al: 'CENTER', c: C.muted }),
      F('countdown', 300, 300, 300, 300, [
        E(0, 0, 300, '#FFFFFF1F', { arc: [0, 6.2832, 0.85] }),
        E(0, 0, 300, C.pink, { n: 'ring', arc: [-1.5708, 3.1416, 0.85], sh: [glow(C.pink, 30)] }),
        H('5', 0, 60, 160, { w: 300, al: 'CENTER' }),
      ]),
      T('Score 412 · 2★ so far', 0, 640, 38, { w: 900, al: 'CENTER', fw: 'Bold', c: C.gold }),
      B('btn-revive-gem', 120, 730, 660, 136, { i: 'diamond', v: 'REVIVE · 50', s: 48, is: 52, f: G.cta, c: C.ink, ic: C.ink, sh: [glow(C.cyan, 40)] }),
      B('btn-revive-ad', 120, 896, 660, 120, { i: 'video', v: 'Watch ad to revive', s: 40, is: 48, f: G.green, c: C.ink, ic: C.ink }),
      B('btn-no-thanks', 250, 1050, 400, 90, { v: 'No thanks', s: 38, f: '#00000000', c: C.muted, sh: [], fw: 'SemiBold' }),
    ]),
  ],
};

const statRow = (k, label, value, y, col) => F('stat-' + k, 0, y, 820, 72, [
  E(0, 22, 28, col, { sh: [glow(col, 12)] }),
  T(label, 52, 12, 38, { c: C.muted, fw: 'Medium' }),
  T(value, 520, 12, 40, { w: 300, al: 'RIGHT', fw: 'Bold' }),
]);

const result = {
  id: 'result', name: '07 Result', col: 4, row: 0, bg: BG.menu, dim: ['99', 'D9'],
  ch: [
    E(-100, 0, 1280, { rad: 1, c: ['#FFC83D40', '#FFC83D00'] }),
    ...Array.from({ length: 14 }, (_, i) => R(80 + ((i * 137) % 920), 90 + ((i * 263) % 640), 18, 34,
      [C.pink, C.cyan, C.gold, C.green][i % 4], 4, { rot: (i * 47) % 180, op: 0.85 })),
    ribbon('SONG COMPLETE', 110),
    H('Für Elise', 0, 260, 64, { w: 1080, al: 'CENTER' }),
    F('result-stars', 190, 360, 700, 260, [
      I('star', 0, 70, 190, C.gold, { rot: 12, sh: [glow(C.gold, 40)] }),
      I('star', 230, 0, 240, C.gold, { sh: [glow(C.gold, 50)] }),
      I('star', 500, 70, 190, '#FFFFFF33', { rot: -12 }),
    ]),
    P('trophy', 790, 600, 240, 240, 'trophy', { rot: -8 }),
    H('586', 0, 650, 200, { w: 1080, al: 'CENTER', sh: [glow(C.pink, 40)] }),
    B('tag-best', 380, 890, 320, 72, { i: 'trophy', v: 'NEW BEST', s: 32, is: 38, f: G.gold, c: C.ink, ic: C.ink, sh: [glow(C.gold, 30)] }),
    F('stats', 90, 1000, 900, 330, [
      statRow('perfect', 'Perfect', '182', 30, C.cyan),
      statRow('great', 'Great', '40', 102, C.green),
      statRow('cool', 'Cool', '9', 174, C.violet),
      statRow('combo', 'Max combo', 'x96', 246, C.pink),
    ].map((n) => ({ ...n, x: 40 })), { f: '#1A1240B3', r: 40, st: C.glassLine, sw: 2, bb: 30 }),
    F('rewards', 90, 1360, 900, 120, [
      B('rw-gem', 0, 0, 280, 110, { i: 'diamond', v: '+30', s: 44, is: 52, f: '#00000059', ic: C.cyan, st: C.glassLine, sw: 2, sh: [] }),
      B('rw-xp', 300, 0, 280, 110, { i: 'star', v: '+120 XP', s: 40, is: 48, f: '#00000059', ic: C.gold, st: C.glassLine, sw: 2, sh: [] }),
      B('btn-double', 600, 0, 300, 110, { i: 'video', v: 'x2', s: 48, is: 52, f: G.green, c: C.ink, ic: C.ink }),
    ]),
    B('btn-home', 90, 1560, 160, 150, { i: 'home', is: 64, f: '#FFFFFF1F', st: C.glassLine, sw: 2, sh: [], r: 44 }),
    B('btn-replay', 280, 1560, 160, 150, { i: 'refresh', is: 64, f: '#FFFFFF1F', st: C.glassLine, sw: 2, sh: [], r: 44 }),
    B('btn-next', 470, 1560, 520, 150, { i: 'next', v: 'NEXT SONG', s: 48, is: 52, f: G.cta, c: C.ink, ic: C.ink, sh: [glow(C.cyan, 40)] }),
  ],
};

export default {
  screens: [revive, result],
  links: [
    { from: 'revive', node: 'btn-revive-gem', to: 'gameplay', kind: 'back', label: 'Revive (−50 gems / ad)', lt: 0.2, dy: 110 },
    { from: 'revive', node: 'btn-revive-ad', to: 'gameplay', noArrow: true },
    { from: 'revive', node: 'btn-no-thanks', to: 'result', label: 'No thanks / timeout' },
    { from: 'result', node: 'btn-next', to: 'preview', label: 'Next song' },
    { from: 'result', node: 'btn-replay', to: 'gameplay', noArrow: true },
    { from: 'result', node: 'btn-home', to: 'home', kind: 'back', label: 'Home', noArrow: true },
  ],
};
