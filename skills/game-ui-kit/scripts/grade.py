# Hero grade post-step: move the mean colour of a masked band to a target, then re-measure.
#   python3 -I grade.py --target '#B8E2F7' --band 0,0.35 [--hue 170,240] [--min-sat 0.08] [--tol 12] <in.png> <out.png>
# band = vertical range as fractions of the height; the mask keeps opaque pixels in the band
# whose hue sits in --hue (degrees; omit = every hue) and saturation ≥ --min-sat, so a title or
# character over the sky stays untouched. Per-channel gain moves the masked mean onto the
# target; only the band's top/bottom edge is feathered, so no seam shows and the subject stays crisp.
# S20: ChatGPT ignored the hex in the prompt twice (sky R 159 vs 184 ±12); this fixed it.
# Prints one JSON line: {"before":[r,g,b],"after":[r,g,b],"target":[r,g,b],"masked":px,"pass":bool}.
import argparse
import json
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

ap = argparse.ArgumentParser()
ap.add_argument('--target', required=True)
ap.add_argument('--band', default='0,1')
ap.add_argument('--hue', default='')
ap.add_argument('--min-sat', type=float, default=0.0)
ap.add_argument('--tol', type=int, default=12)
ap.add_argument('src')
ap.add_argument('dst')
a = ap.parse_args()

im = Image.open(a.src).convert('RGBA')
W, H = im.size
y0, y1 = (round(float(v) * H) for v in a.band.split(','))
rgb = im.convert('RGB')
hh, ss, _ = rgb.convert('HSV').split()
band = Image.new('L', (W, H), 0)
ImageDraw.Draw(band).rectangle((0, y0, W, max(y0, y1 - 1)), fill=255)
sel = im.getchannel('A').point(lambda v: 255 if v >= 250 else 0)       # which pixels are sky / background
if a.hue:
    lo, hi = (int(v) * 255 // 360 for v in a.hue.split(','))
    sel = ImageChops.multiply(sel, hh.point(lambda v: 255 if lo <= v <= hi else 0))
if a.min_sat:
    sel = ImageChops.multiply(sel, ss.point(lambda v: 255 if v >= a.min_sat * 255 else 0))
mask = ImageChops.multiply(band, sel)                                    # measured pixels
masked = mask.histogram()[255]
if not masked:
    raise SystemExit('grade: mask is empty (check --band / --hue)')
c = a.target.lstrip('#')
target = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
before = [round(v) for v in ImageStat.Stat(rgb, mask).mean]
gains = [t / max(b, 1) for t, b in zip(target, before)]
graded = Image.merge('RGB', [ch.point(lambda v, g=g: min(255, round(v * g))) for ch, g in zip(rgb.split(), gains)])
weight = ImageChops.multiply(band.filter(ImageFilter.GaussianBlur(max(2, H * 0.02))), sel)   # soft band edge, hard subject edge
out = Image.composite(graded, rgb, weight)
out.putalpha(im.getchannel('A'))
out.save(a.dst, optimize=True)
after = [round(v) for v in ImageStat.Stat(out.convert('RGB'), mask).mean]
print(json.dumps({'before': before, 'after': after, 'target': target, 'masked': masked,
                  'pass': all(abs(x - t) <= a.tol for x, t in zip(after, target))}))
