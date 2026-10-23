"""Build the OFL-licensed static HatWeather Display 800 outline subset.

From the project root, using the bundled Python:
  python tools/build-display-font.py
Dependencies are intentionally confined to .local-work/font-tools:
  python -m pip install --index-url https://pypi.org/simple --only-binary=:all: \
    --target .local-work/font-tools fonttools==4.67.0 skia-pathops==0.9.2 brotli==1.2.1
"""
from array import array
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".local-work/font-tools"))

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.ttLib.tables._g_l_y_f import Glyph
from fontTools.ttLib.tables.ttProgram import Program
from fontTools.varLib.instancer import instantiateVariableFont

SOURCE = ROOT / "assets/fonts/manrope-variable.ttf"
OUTPUT = ROOT / "assets/fonts/hat-weather-display.woff2"
UNICODES = {0x20, 0x430, 0x433, 0x434, 0x43E, 0x43F}
source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()

font = TTFont(SOURCE, recalcTimestamp=False)
instantiateVariableFont(font, {"wght": 800}, inplace=True)

# A single-component alias (Cyrillic a -> a) is skipped by removeOverlaps.
# Flatten only the retained glyphs first, preserving their original coordinates.
glyf = font["glyf"]
for cp in sorted(UNICODES):
    name = font.getBestCmap()[cp]
    glyph = glyf[name]
    if glyph.isComposite():
        coords, endpoints, flags = glyph.getCoordinates(glyf)
        simple = Glyph()
        simple.numberOfContours = len(endpoints)
        simple.coordinates = coords.copy()
        simple.endPtsOfContours = list(endpoints)
        simple.flags = array("B", flags)
        simple.program = Program()
        simple.program.fromBytecode(b"")
        simple.recalcBounds(glyf)
        glyf[name] = simple

options = subset.Options()
options.hinting = False
options.glyph_names = True
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16, 17]
options.name_languages = ["*"]
options.name_legacy = True
options.notdef_glyph = True
options.notdef_outline = False
options.recommended_glyphs = False
options.recalc_timestamp = False
options.layout_features = []
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=UNICODES)
subsetter.subset(font)

# This resolves self-intersections/backtracking as well as contour overlaps.
# Fail on geometry errors rather than silently retaining a broken outline.
removeOverlaps(font, removeHinting=True, ignoreErrors=False)

for tag in ("fvar", "gvar", "avar", "HVAR", "MVAR", "STAT"):
    if tag in font:
        del font[tag]

names = {
    1: "HatWeather Display",
    2: "ExtraBold",
    3: "1.000;HWTH;HatWeatherDisplay-ExtraBold",
    4: "HatWeather Display ExtraBold",
    5: "Version 1.000; based on Manrope 4.505",
    6: "HatWeatherDisplay-ExtraBold",
    10: "Modified from Manrope 4.505: static weight 800, Cyrillic display subset, composite outlines decomposed and overlaps removed with fontTools/skia-pathops. Licensed under SIL OFL 1.1.",
    16: "HatWeather Display",
    17: "ExtraBold",
}
# Preserve original authors, copyright and OFL license records (IDs 0/13/14).
font["name"].names = [n for n in font["name"].names if n.nameID not in names]
for name_id, value in names.items():
    font["name"].setName(value, name_id, 3, 1, 0x409)
    font["name"].setName(value, name_id, 1, 0, 0)

font["OS/2"].usWeightClass = 800
font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~((1 << 0) | (1 << 6))) | (1 << 5)
font["head"].macStyle = (font["head"].macStyle & ~(1 << 1)) | 1
font.flavor = "woff2"
font.save(OUTPUT)

assert source_hash == hashlib.sha256(SOURCE.read_bytes()).hexdigest(), "Source changed"
print(f"Built {OUTPUT.name}: {OUTPUT.stat().st_size} bytes")
print(f"Source SHA256 unchanged: {source_hash}")
