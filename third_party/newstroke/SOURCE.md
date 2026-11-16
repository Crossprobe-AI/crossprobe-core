# Newstroke font (CC0)

KiCad's stroke font, by Vladimir Uryvaev. Taken from the author's release,
<http://vovanium.ru/sledy/newstroke/en> (`newstroke-font.tgz`), which is
licensed CC0 1.0 (public domain); see `README.txt`. Only the glyph sources are
kept here: `font.lib` and `symbol.lib` (glyphs as KiCad library symbols) and
`charlist.txt` (the Unicode map). KiCad's own copy of the font is not used.

`scripts/build-newstroke.mjs` turns them into
`packages/kicad-model/src/newstroke-data.ts`.
