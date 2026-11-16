/**
 * Logos and images on the board, as KiCad's Image Converter makes them: a
 * black-and-white bitmap traced into filled polygons (holes joined to their
 * outlines, as KiCad's polygons can't have holes) in a board-only footprint.
 */
import ClipperLib from "clipper-lib";
import type { Point } from "./geometry.js";
import { fracture } from "./zone-fill.js";

const S = 1e5; // clipper scale (as zone-fill)

/**
 * The inked pixels (`ink[y * w + x]` true) as polygons in mm, `pixel` mm per
 * pixel, centred on the image's middle. Each row's runs of ink are unioned
 * into exact pixel outlines.
 */
export function bitmapToPolygons(ink: ArrayLike<number | boolean>, w: number, h: number, pixel: number): Point[][] {
  const rects: ClipperLib.Paths = [];
  const X = (x: number) => Math.round((x - w / 2) * pixel * S);
  const Y = (y: number) => Math.round((y - h / 2) * pixel * S);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!ink[y * w + x]) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < w && ink[y * w + x]) x++;
      rects.push([{ X: X(x0), Y: Y(y) }, { X: X(x), Y: Y(y) }, { X: X(x), Y: Y(y + 1) }, { X: X(x0), Y: Y(y + 1) }]);
    }
  }
  if (!rects.length) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(rects, ClipperLib.PolyType.ptSubject, true);
  const merged: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  // Drop the in-line vertices pixel edges leave behind.
  const clean = ClipperLib.Clipper.CleanPolygons(merged, 1);
  return fracture(clean);
}

/** A board-only footprint (.kicad_mod text) holding `polygons` (mm, around 0,0) filled on `layer`. */
export function logoFootprint(polygons: Point[][], o: { name: string; layer: string }): string {
  const r = (v: number) => Number(v.toFixed(4));
  const polys = polygons
    .map((poly) => `  (fp_poly (pts ${poly.map((p) => `(xy ${r(p.x)} ${r(p.y)})`).join(" ")}) (stroke (width 0) (type solid)) (fill yes) (layer "${o.layer}"))`)
    .join("\n");
  return `(footprint "${o.name}"
  (layer "F.Cu")
  (attr board_only exclude_from_pos_files exclude_from_bom)
  (property "Reference" "G***" (at 0 0 0) (layer "${o.layer}") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "${o.name}" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
${polys}
)
`;
}
