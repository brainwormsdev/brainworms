"""Rasterise printable ASCII into a 16-row bitmap font (one 16-bit mask per column).
Used by server and browser so the light pattern shown to the worm's eyes is identical everywhere.
Font: Poppins Bold (SIL Open Font License)."""
from PIL import Image, ImageDraw, ImageFont
import json, sys
FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'
H = 16
font = ImageFont.truetype(FONT, 17)
asc, desc = font.getmetrics()
glyphs = {}
for code in range(32, 127):
    ch = chr(code)
    w = max(1, int(round(font.getlength(ch))))
    img = Image.new('L', (w + 4, 40), 0)
    d = ImageDraw.Draw(img)
    d.text((2, 0), ch, fill=255, font=font)
    # crop vertically to a fixed 16-row band anchored on the baseline
    top = asc - 14
    band = img.crop((0, top, w + 4, top + H))
    px = band.load()
    cols = []
    for x in range(band.width):
        m = 0
        for y in range(H):
            if px[x, y] >= 110: m |= (1 << y)
        cols.append(m)
    # trim empty columns at both ends (keep spaces as blank advance)
    if ch == ' ':
        cols = [0] * 5
    else:
        while cols and cols[0] == 0: cols.pop(0)
        while cols and cols[-1] == 0: cols.pop()
    glyphs[ch] = cols
glyphs['█'] = [0xFFFF] * 9   # full block: solid light
out = 'export const GLYPH_HEIGHT = 16;\n// Printable ASCII rasterised from Poppins Bold (SIL OFL) by scripts/build-data/make_glyphs.py.\n// Each glyph is a list of columns; bit y set = lit pixel at row y (0 = top).\nexport const GLYPHS = ' + json.dumps(glyphs, separators=(',', ':')) + ';\n'
open('shared/glyphs.js', 'w').write(out)
print(len(glyphs), 'glyphs', len(out), 'bytes')
# preview
def show(s):
    cols = []
    for c in s: cols += glyphs.get(c, glyphs['?']) + [0]
    for y in range(H): print(''.join('#' if (m >> y) & 1 else '.' for m in cols))
show('gm wagmi')
