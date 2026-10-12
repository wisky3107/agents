# Deterministic recolour fallback: a passing chrome image → a sibling in another colour.
#   python3 -I recolour.py --color '#FFB020' <from.png> <out.png>
# Keeps shape, rim, highlights, shading and alpha exactly; moves hue to the target and scales
# saturation / brightness so the opaque pixels' mean matches the target colour. Used when a
# generator keeps failing one variant of a set (S18: codex amber/mint buttons with
# alpha-eroded faces) — the result is a recorded deviation, not a generation.
import argparse
import colorsys
from PIL import Image, ImageStat

ap = argparse.ArgumentParser()
ap.add_argument('--color', required=True)
ap.add_argument('src')
ap.add_argument('dst')
a = ap.parse_args()

im = Image.open(a.src).convert('RGBA')
alpha = im.getchannel('A')
h, s, v = im.convert('RGB').convert('HSV').split()
solid = alpha.point(lambda x: 255 if x >= 250 else 0)
ms, mv = ImageStat.Stat(s, solid).mean[0], ImageStat.Stat(v, solid).mean[0]
c = a.color.lstrip('#')
th, ts, tv = colorsys.rgb_to_hsv(*(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)))
ks, kv = (ts * 255) / max(ms, 1), (tv * 255) / max(mv, 1)
h = h.point(lambda _: round(th * 255))
s = s.point(lambda x: min(255, round(x * ks)))
v = v.point(lambda x: min(255, round(x * kv)))
out = Image.merge('HSV', (h, s, v)).convert('RGB')
out.putalpha(alpha)
out.save(a.dst, optimize=True)
print(f'recoloured {a.src} → {a.dst} ({a.color}; sat ×{ks:.2f}, val ×{kv:.2f})')
