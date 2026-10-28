"""Render subtitle cues to transparent PNG overlays (one per cue):
    python core/edit/burn_subs.py cues.json W H out_prefix
cues.json = [{"t0":…, "t1":…, "text":…}] (assembled.mjs writes it). Writes out_prefix.<k>.png
for every cue, sized WxH with the text centred near the bottom, dark outline + soft shadow
so it reads on any background. Used by assemble.mjs --burn because the ffmpeg builds we
target may lack libass/drawtext; the overlay filter alone composites them.
"""
import sys, os, json
from PIL import Image, ImageDraw, ImageFont

cues = json.load(open(sys.argv[1], encoding='utf-8'))
W, H, prefix = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
FONTS = [   # Thai-capable first (ตัวหนังสือไทยต้องเรนเดอร์ได้), then generic fallbacks
    '/System/Library/Fonts/Thonburi.ttc',                  # macOS Thai system font
    '/System/Library/Fonts/SukhumvitSet.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',     # Linux
    '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf',
]
font_path = next((f for f in FONTS if os.path.exists(f)), None)
size = max(20, round(H * 0.040))
font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
meas = ImageDraw.Draw(Image.new('RGBA', (8, 8)))

def wrap(text, max_w):
    """Wrap by words (falls back to per-character for spaceless scripts such as Thai)."""
    lines, cur = [], ''
    def width(s):
        b = meas.textbbox((0, 0), s, font=font); return b[2] - b[0]
    if width(text) <= max_w: return [text]
    for w in text.split(' '):
        if not cur: cur = w
        elif width(cur + ' ' + w) <= max_w: cur += ' ' + w
        else: lines.append(cur); cur = w
        while width(cur) > max_w and len(cur) > 1:   # token wider than the box: hard-split
            cut = len(cur)
            while cut > 1 and width(cur[:cut]) > max_w: cut -= 1
            lines.append(cur[:cut]); cur = cur[cut:]
    if cur: lines.append(cur)
    return lines

for k, c in enumerate(cues):
    max_w = int(W * 0.72)
    lines = wrap(c['text'], max_w)
    lh = int(size * 1.45)
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    total_h = lh * len(lines)
    y = H - int(H * 0.085) - total_h
    for line in lines:
        b = d.textbbox((0, 0), line, font=font); tw = b[2] - b[0]
        x = (W - tw) // 2
        for dx, dy in [(-3, 0), (3, 0), (0, -3), (0, 3), (2, 2), (-2, 2), (2, -2), (-2, -2)]:   # dark rim
            d.text((x + dx, y + dy), line, font=font, fill=(10, 10, 10, 220))
        d.text((x, y), line, font=font, fill=(255, 251, 240, 255))                              # warm white fill
        y += lh
    img.save(f'{prefix}.{k}.png')
print(len(cues))
