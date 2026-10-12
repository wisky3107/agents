# Fit a kit image to an exact pixel size. Pillow only.
#   python3 -I fit.py --mode stretch|contain|cover --size WxH <in.png> <out.png>
# stretch: resize to WxH (nine-slice chrome: the caps are rescaled with borderPx afterwards)
# contain: scale to fit inside WxH, centre on a transparent canvas (icons, pieces)
# cover:   scale to fill WxH, centre-crop (opaque art, backgrounds)
import argparse
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--mode', choices=['stretch', 'contain', 'cover'], required=True)
ap.add_argument('--size', required=True)
ap.add_argument('src')
ap.add_argument('dst')
a = ap.parse_args()
W, H = (int(v) for v in a.size.lower().split('x'))
im = Image.open(a.src).convert('RGBA')
if a.mode == 'stretch':
    out = im.resize((W, H), Image.LANCZOS)
elif a.mode == 'contain':
    k = min(W / im.width, H / im.height)
    sm = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.alpha_composite(sm, ((W - sm.width) // 2, (H - sm.height) // 2))
else:
    k = max(W / im.width, H / im.height)
    sm = im.resize((max(W, round(im.width * k)), max(H, round(im.height * k))), Image.LANCZOS)
    x, y = (sm.width - W) // 2, (sm.height - H) // 2
    out = sm.crop((x, y, x + W, y + H))
if a.mode == 'cover' and out.getchannel('A').getextrema()[0] == 255:
    out = out.convert('RGB')
out.save(a.dst, optimize=True)
