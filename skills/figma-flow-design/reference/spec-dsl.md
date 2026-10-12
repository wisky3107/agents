# Flow spec DSL

A flow folder:

```
<flow>/
  flow.json            name, title, subtitle, fileKey, page, fonts, layout {W,H,GX,GY,bg}
  spec/_kit.mjs        palette, gradients, shared components (top bar, rows, nav, modal…)
  spec/01-entry.mjs    export default { screens: [...], links: [...] }   (2–3 screens per file)
  spec/02-play.mjs
  variants/v2.mjs      optional re-skin: export PREFIX, screen(s), link(l) [, title]
```

The worked example is `reference/example/` (Melody Tiles: 10 screens, 28 hotspots, v2 variant).

## Screen

`{ id, name, col, row, bg?, dim?: ['99','D9'], ch: [nodes] }` — frame `name` is the Figma
name (prefix with an order number: `02 Home`); `col`/`row` place it on the board
(`x = col·(W+GX)`, `y = row·(H+GY)`); `bg` is any fill; `dim` adds a top→bottom dark overlay
(hex alpha pair) over an image background so text stays readable.

## Nodes

| `t` | Fields | Notes |
|---|---|---|
| `rect`, `ellipse` | `x y w h f r st sw sh op rot arc` | `arc: [start, end, innerRatio]` radians, for rings / gauges |
| `text` | `v x y s ff fw c al w h ls lh sh op` | `w` = fixed width (wraps), `w`+`h` = box with vertical centring |
| `icon` | `i x y s c sh op` | `i` from `scripts/icons.mjs` |
| `frame` | `n x y w h f r st sw sh bb clip ch` | `ch` children; `clip` clips content |
| `btn` | frame fields + `v s ff fw c i is ic` | label `v`, icon `i`; both centred as a pair |

`n` names the node: every hotspot needs a stable kebab name (`btn-play-1`, `nav-shop`) —
links find nodes by it, and figma-game-clone reads the same names later.

Fills `f`: `'#RRGGBB[AA]'`, gradient `{ c: [...], a: deg, p?: [stops] }`, radial `{ rad: 1, c }`,
image `{ img: '<library name>', mode: 'FILL'|'FIT'|'STRETCH' }`, nine-slice image
`{ img, s9: [l, t, r, b] fractions, k? }` (frames / btns only; caps scale to the node height,
or `k`). Effects: `sh: [{ c, x, y, b, s }]` drop shadow / glow, `bb: radius` background blur.

## Links

`{ from, node?, to, label?, kind?, trig?, ms?, noArrow?, lt?, dx?, dy? }`

- `from`/`to` are screen ids; `node` is the hotspot name inside `from` (omit = whole frame).
- `kind`: `main` (cyan) · `branch` (pink) · `reward` (gold) · `back` (dashed grey).
- `trig: 'timeout'`, `ms` seconds → AFTER_TIMEOUT (splash → home).
- `noArrow: true` keeps the prototype reaction but draws no arrow (back / tab links that
  would clutter the board). One reaction per hotspot (the first link wins).
- Routing is automatic (adjacent → elbow; same row → over the top; other row → lanes between
  rows). Fix collisions with `lt` (label position 0–1 along its segment) and `dy` / `dx`
  (shift a lane).

## Variant

`variants/<name>.mjs` maps v1 screens and links to a re-skin placed `ROW_OFF` rows below:
`screen(s) → { ...s, id: 'v2-'+s.id, name: PREFIX+s.name, row: s.row+ROW_OFF, ch: mapped }`,
`link(l) → { ...l, from: 'v2-'+l.from, to: 'v2-'+l.to }`. Map nodes by their fill / name
(the example swaps gradient buttons for nine-slice kit images and icons for 3D icon images).
v1 is never touched; each variant gets its own arrows, header and prototype flow.
