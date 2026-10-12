# UI kit catalog

Standard rows for a game UI kit. Pick the rows the brief's screens need; a typical casual game
kit is 15–25 rows. Every row goes into `kit.json` (schema in SKILL.md).

`slice` = nine-slice insets `[left, top, right, bottom]` as fractions of the trimmed image.
`post` turns them into pixel borders for Cocos (`spriteFrame` borders) and Figma.

## Chrome (stretchable)

| cat | name pattern | aspect | alpha | slice | subject hint |
|---|---|---|---|---|---|
| button | `btn-<variant>` (primary, secondary, positive, premium, glass…) | wide 3:1 | yes | `[0.22,0,0.22,0]` | empty pill / rounded button, no text, no icon |
| button-round | `btn-round-<variant>` | square 1:1 | yes | — | empty circular button |
| panel | `panel` / `panel-<variant>` | square 1:1 | yes | `[0.2,0.2,0.2,0.2]` | empty popup panel, plain centre, decorated border/corners |
| card | `card` / `card-<variant>` | wide 5:1 | yes | `[0.12,0.3,0.12,0.3]` | empty list card, plain inside |
| ribbon | `ribbon` | wide 5:1 | yes | `[0.2,0,0.2,0]` | empty title banner with folded tails |
| tab | `tab-on`, `tab-off` | wide 3:1 | yes | `[0.25,0,0.25,0]` | segmented-control tab, selected / unselected |
| bar | `bar-track`, `bar-fill` | wide 8:1 | yes | `[0.1,0,0.1,0]` | progress bar track and fill |
| toggle | `toggle-on`, `toggle-off` | wide 2:1 | yes | — | switch track with knob |
| badge | `badge-<color>` | square 1:1 | yes | — | small notification dot / count badge |

## Icons (fixed size)

| cat | name pattern | aspect | alpha | subject hint |
|---|---|---|---|---|
| icon | `ic-<thing>` | square 1:1 | yes | one object, no frame or background tile |

Common sets: currency (`ic-coin`, `ic-gem`, `ic-energy`), rating (`ic-star`, `ic-star-empty`,
`ic-crown`), nav (`ic-home`, `ic-shop`, `ic-settings`, `ic-rank`, `ic-profile`), actions
(`ic-play`, `ic-pause`, `ic-replay`, `ic-close`, `ic-back`, `ic-ad`), rewards (`ic-gift`,
`ic-chest`, `ic-trophy`). Keep one icon per row, never a sprite sheet.

## Game pieces and art

| cat | name pattern | aspect | alpha | notes |
|---|---|---|---|---|
| piece | `piece-<thing>` (tile, block, card face, token) | as the game needs | yes | the game's main tappable objects |
| art | `art-<thing>` (cover, thumbnail, illustration) | as used | no | depicts a scene; FILL-cropped |
| background | `bg-<screen>` | portrait 9:16 | no | low detail behind UI; hero rule applies when final |
| hero | `hero-<thing>` (logo, splash, key art, store image) | as used | logo yes | always `gpt-image-gen` unless overridden |

## Sizing art rows

State **aspect and minimum pixel size**, not only an area share. "Card art ≈ 25 % of the card"
was met in S18 by a 360×61 strip: the right area, smaller than the previous art. Write e.g.
"card art 25 % of the card area, aspect 4:3 to 16:9, at least 240 px tall".

Measured colour bands (sky zenith / horizon, panel top / bottom) need a **transition zone**
between them: two envelopes on adjacent rows force a steep ramp no generator draws (S20 zenith
above the title-band horizon). Leave ≥ 10 % of the height unmeasured between bands.

## Writing the subject

- Describe the object, its material and colours from the palette. One object per image.
- Chrome rows say **empty**: no text, no icon, plain centre, so the game can put its own label on top.
- State the aspect in words ("wide 3:1", "portrait 9:16"); the backends ignore pixel sizes.
- A variant set (btn-primary / btn-secondary / …) repeats the same subject sentence and changes
  only the colour words, so shape and rim stay identical across the set.
