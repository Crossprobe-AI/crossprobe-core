/**
 * The placer keeps parts apart by their courtyards, not by the box round each: a module whose
 * antenna end is wider than its body (a T-shaped courtyard) leaves room beside its pins, under the
 * antenna, for the capacitor that serves them.
 */
import { describe, expect, it } from "vitest";
import { courtyardBoxes, footprintPoint, parseBoard, placeParts, type PlaceItem } from "../src/index.js";

const footprint = (crtyd: string) => parseBoard(`(kicad_pcb (version 20260206) (footprint "T:M" (layer "F.Cu") ${crtyd}))`).footprints[0]!;
const line = (a: number[], b: number[]) => `(fp_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))`;
// ESP32-C3-WROOM-02's courtyard: the antenna end 28.5 mm wide, the body below it 19.5 mm.
const tee = [[-14.25, -18.35], [14.25, -18.35], [14.25, -6.85], [9.75, -6.85], [9.75, 7.15], [-9.75, 7.15], [-9.75, -6.85], [-14.25, -6.85]];
const teeLines = tee.map((p, k) => line(p, tee[(k + 1) % tee.length]!)).join(" ");

describe("courtyardBoxes", () => {
  it("cuts a straight-sided courtyard into rectangles, and leaves a rectangle, a circle or several outlines as their box", () => {
    expect(courtyardBoxes(footprint(teeLines))).toEqual([
      { x: -14.25, y: -18.35, w: 4.5, h: 11.5 },
      { x: -9.75, y: -18.35, w: 19.5, h: 25.5 },
      { x: 9.75, y: -18.35, w: 4.5, h: 11.5 },
    ]);
    // Two connectors' courtyards, as on a Compute Module: the module above them is in neither, so
    // the box round both stands for it.
    const two = `(fp_rect (start -2.35 -32.9) (end 1.43 -10.1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd")) (fp_rect (start 31.57 -32.9) (end 35.35 -10.1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))`;
    expect(courtyardBoxes(footprint(two))).toBeUndefined();
    expect(courtyardBoxes(footprint(`(fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))`))).toBeUndefined();
    expect(courtyardBoxes(footprint(`(fp_circle (center 0 0) (end 1 0) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))`))).toBeUndefined();
    expect(courtyardBoxes(footprint(""))).toBeUndefined();
  });
});

describe("placing beside a module with a T-shaped courtyard", () => {
  // Pin 1 (3V3) high on the body's left side, just below the antenna end.
  const module = (courtyard?: PlaceItem["courtyard"]): PlaceItem => ({
    reference: "U1",
    extent: { x: -14.25, y: -18.35, w: 28.5, h: 25.5 },
    courtyard,
    pads: [{ x: -8.75, y: -5.5, net: "3V3", number: "1" }, { x: 8.75, y: 5.5, net: "GND", number: "2" }],
    at: { x: 20, y: 24 },
    rotate: 0,
  });
  const cap: PlaceItem = { reference: "C1", extent: { x: -1.5, y: -0.75, w: 3, h: 1.5 }, pads: [{ x: -0.8, y: 0, net: "3V3" }, { x: 0.8, y: 0, net: "GND" }], near: "U1:1" };
  const fromPin = (it: PlaceItem) => {
    const { placed } = placeParts([it, cap], { x: 0, y: 0, w: 40, h: 40 }, { gap: 0.5 });
    const c = placed.C1!;
    const pin = { x: 20 - 8.75, y: 24 - 5.5 };
    return Math.min(...cap.pads.filter((p) => p.net === "3V3").map((p) => { const q = footprintPoint(p, c.at, c.rotate); return Math.hypot(q.x - pin.x, q.y - pin.y); }));
  };

  it("puts the capacitor right beside the pin, under the antenna end", () => {
    // By the box round the whole module, the capacitor can come no closer than its edge, 5.5 mm out.
    expect(fromPin(module())).toBeGreaterThan(5);
    expect(fromPin(module(courtyardBoxes(footprint(teeLines))))).toBeLessThan(3);
  });
});
