HatWeather Display ExtraBold (weight 800)

Modified from the bundled Manrope 4.505 variable font, originally by
The Manrope Project Authors (https://github.com/googlefonts/manrope).
The original copyright and SIL Open Font License records are preserved
inside hat-weather-display.woff2. Distributed under SIL OFL 1.1;
the complete license accompanies this file in OFL-manrope.txt.

Modification: fixed wght=800, decomposed retained composite glyphs,
removed contour overlaps/self-intersections with fontTools/skia-pathops,
removed hinting and variable metadata, renamed the family, and encoded
the subset as WOFF2. The Cyrillic a retains its U+0430 mapping.

Coverage: U+0020 SPACE, U+0430 a, U+0433 ghe, U+0434 de, U+043E o,
U+043F pe (the Cyrillic letters used in "pogoda"). No other characters
are supported. Intended for the outlined title only.

The source manrope-variable.ttf is unchanged. All glyph advances,
bearings, bounding boxes and vertical metrics match its 800 instance.
The a has two contours after removing its three backtracking lines;
the small difference in its filled outline (0.0282% area XOR) is from
integer rounding of new intersection points. Other retained letters
have identical filled outlines.

Built with fontTools 4.67.0, skia-pathops 0.9.2 and Brotli 1.2.1.

Rebuild from the project root:
  python -m pip install --index-url https://pypi.org/simple --only-binary=:all: --target .local-work/font-tools fonttools==4.67.0 skia-pathops==0.9.2 brotli==1.2.1
  python tools/build-display-font.py

The Python dependency packages stay local and are not website runtime assets.
