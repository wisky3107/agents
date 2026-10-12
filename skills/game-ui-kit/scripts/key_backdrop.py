# Key a flat backdrop out of a generated UI asset, trim it, cap its size. Pillow only.
#   python3 -I key_backdrop.py --key magenta|green|none --max 768 <in.png> <out.png>
# Removes backdrop pixels connected to the image border (flood fill from edge points), plus
# near-pure backdrop pixels inside enclosed holes. Artwork that merely resembles the key colour
# (pink #FF4FD8 vs magenta, mint vs green) survives because it is neither border-connected
# nor pure. A 2 px erode + 1 px blur removes the fringe. `--key none` only trims and resizes.
# Defringe (default on): semi-transparent edge pixels take the colour of the opaque pixels next
# to them, so a halo left by the generator's own backdrop (yellow / green fringes) disappears;
# `--erode N` additionally shaves N px off the alpha edge for stubborn halos.
# Prints one JSON line: {"w","h","alpha","transparentPx","cornersTransparent","transparentPct",
# "faceOpaquePct"} — faceOpaquePct = share of fully opaque pixels in the centre box
# (x 25–75 %, y 30–70 %), the face of chrome rows.
import argparse
import json
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath

ap = argparse.ArgumentParser()
ap.add_argument('--key', default='magenta', choices=['magenta', 'green', 'none'])
ap.add_argument('--max', type=int, default=768)
ap.add_argument('--erode', type=int, default=0)
ap.add_argument('--no-defringe', action='store_true')
ap.add_argument('--flatten-face', action='store_true')
ap.add_argument('--pad', type=int, default=0)
ap.add_argument('src')
ap.add_argument('dst')
a = ap.parse_args()

src = Image.open(a.src)
if a.key == 'none':
    img = src.convert('RGBA')
    alpha = img.getchannel('A')
else:
    rgb = src.convert('RGB')
    r, g, b = rgb.split()
    if a.key == 'magenta':
        d = ImageChops.subtract(ImageChops.darker(r, b), g)          # min(R,B) - G
        low = g
    else:
        d = ImageChops.subtract(g, ImageChops.lighter(r, b))          # G - max(R,B)
        low = ImageChops.lighter(r, b)
    mask = d.point(lambda v: 255 if v > 110 else 0)
    w, h = mask.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)):
        if mask.getpixel(xy) == 255:
            ImageDraw.floodfill(mask, xy, 128)
    pure = ImageChops.multiply(d.point(lambda v: 255 if v > 190 else 0), low.point(lambda v: 255 if v < 50 else 0))
    bg = ImageChops.lighter(mask.point(lambda v: 255 if v == 128 else 0), pure).filter(ImageFilter.MaxFilter(5))
    alpha = ImageChops.invert(bg).filter(ImageFilter.GaussianBlur(1))
    img = rgb.convert('RGBA')
    img.putalpha(alpha)

def defringe(img, erode):
    a = img.getchannel('A')
    if erode:
        a = a.filter(ImageFilter.MinFilter(2 * erode + 1))
    solid = a.point(lambda v: 255 if v >= 250 else 0)
    edge = a.point(lambda v: 255 if 0 < v < 250 else 0)
    if edge.getbbox() and solid.getbbox():
        mb = solid.filter(ImageFilter.BoxBlur(3))
        chans = []
        for c in img.convert('RGB').split():
            pb = ImageChops.multiply(c, solid).filter(ImageFilter.BoxBlur(3))
            bled = ImageMath.lambda_eval(lambda e: e['convert'](e['p'] * 255 / (e['m'] + 1), 'L'), p=pb, m=mb)
            chans.append(Image.composite(bled, c, ImageChops.multiply(edge, mb.point(lambda v: 255 if v > 8 else 0))))
        img = Image.merge('RGBA', (*chans, a))
    else:
        img.putalpha(a)
    return img

if not a.no_defringe or a.erode:
    img = defringe(img, a.erode)
    alpha = img.getchannel('A')

# Chrome face flatten (S18): pixels inside the outline that the generator left semi-transparent
# become opaque, coloured by the opaque pixels around them; the outside (transparent region
# connected to the border) is untouched, so the silhouette and anti-aliased rim stay as made.
def flatten_face(img):
    a = img.getchannel('A')
    out = a.point(lambda v: 255 if v < 8 else 0)
    w, h = out.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if out.getpixel(xy) == 255:
            ImageDraw.floodfill(out, xy, 128)
    outside = out.point(lambda v: 255 if v == 128 else 0).filter(ImageFilter.MaxFilter(3))
    inside = ImageChops.invert(outside)
    solid = a.point(lambda v: 255 if v >= 250 else 0)
    chans = []
    for c in img.convert('RGB').split():
        bled = None
        for rad in (96, 32, 12):                            # coarse first, finer bleeds win where they reach
            mb = solid.filter(ImageFilter.BoxBlur(rad))
            pb = ImageChops.multiply(c, solid).filter(ImageFilter.BoxBlur(rad))
            layer = ImageMath.lambda_eval(lambda e: e['convert'](e['p'] * 255 / (e['m'] + 1), 'L'), p=pb, m=mb)
            bled = layer if bled is None else Image.composite(layer, bled, mb.point(lambda v: 255 if v > 24 else 0))
        chans.append(Image.composite(c, bled, a))          # keep generated colour where it was opaque
    flat = Image.merge('RGB', chans)
    na = ImageChops.lighter(a, inside)
    res = Image.merge('RGBA', (*flat.split(), na))
    return res

if a.flatten_face:
    img = flatten_face(img)
    alpha = img.getchannel('A')

# Subject touching the generated canvas edge = probably cropped by the generator (S20 loading
# hero). Measured before the trim, on the keyed alpha: share of border pixels that are visible.
_a = alpha.point(lambda v: 255 if v > 24 else 0)
_w, _h = _a.size
_border = [_a.crop(b) for b in ((0, 0, _w, 1), (0, _h - 1, _w, _h), (0, 0, 1, _h), (_w - 1, 0, _w, _h))]
edge_touch = round(100 * sum(b.histogram()[255] for b in _border) / (2 * (_w + _h)), 2)

bbox = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
if bbox:
    img = img.crop(bbox)
img.thumbnail((a.max, a.max), Image.LANCZOS)
if a.pad:
    padded = Image.new('RGBA', (img.width + 2 * a.pad, img.height + 2 * a.pad), (0, 0, 0, 0))
    padded.alpha_composite(img.convert('RGBA'), (a.pad, a.pad))
    img = padded
img.save(a.dst, optimize=True)
A = img.getchannel('A')
hist = A.histogram()
corners = sum(A.getpixel(xy) < 8 for xy in ((0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)))
fx0, fy0, fx1, fy1 = img.width // 4, int(img.height * 0.3), max(img.width // 4 + 1, img.width * 3 // 4), max(int(img.height * 0.3) + 1, int(img.height * 0.7))
fh = A.crop((fx0, fy0, fx1, fy1)).histogram()
print(json.dumps({'w': img.width, 'h': img.height, 'alpha': hist[255] != img.width * img.height,
                  'transparentPx': sum(hist[:8]), 'cornersTransparent': corners,
                  'transparentPct': round(100 * sum(hist[:8]) / (img.width * img.height), 2),
                  'edgeTouchPct': edge_touch, 'faceOpaquePct': round(100 * sum(fh[250:]) / max(1, (fx1 - fx0) * (fy1 - fy0)), 1)}))
