/**
 * Board placement of a design spec's parts: edge connectors end up next to
 * what they connect to, whichever of them happens to be placed first.
 */
import { describe, expect, it } from "vitest";
import { footprintPoint, placeParts, type PlaceItem } from "../src/design-spec.js";

const AREA = { x: 0, y: 0, w: 60, h: 45 };

/** A 5-way terminal block on the left edge (B+ and KEY on its last two pins) and a 2-way connector on the bottom edge that carries them on. */
function board(j1Rotate: number): PlaceItem[] {
  return [
    // A long, thin connector: smaller in area than J2, so J2 is placed before it.
    { reference: "J1", extent: { x: -12.5, y: -2, w: 25, h: 4 }, pads: ["A", "B", "C", "B+", "KEY"].map((net, i) => ({ x: -10 + 5 * i, y: 0, net })), edge: "left", rotate: j1Rotate },
    { reference: "J2", extent: { x: -6, y: -5, w: 12, h: 10 }, pads: [{ x: -2.5, y: 0, net: "B+" }, { x: 2.5, y: 0, net: "KEY" }], edge: "bottom" },
    // Something fixed in the middle of the bottom edge, where a connector with nothing to be near would go.
    { reference: "U2", extent: { x: -4, y: -4, w: 8, h: 8 }, pads: [{ x: 0, y: 0, net: "GND" }], at: { x: 27, y: 36 } },
  ];
}

describe("placeParts", () => {
  it.each([90, 270])("puts an edge connector beside the pins it connects to, though it is placed first (J1 at %i°)", (rotate) => {
    const items = board(rotate);
    const { placed, unplaced } = placeParts(items, AREA);
    expect(unplaced).toEqual([]);
    // Left of the fixed part, towards J1: not on the far side of it, where the middle of the edge pulled it before.
    expect(placed.J2!.at.x).toBeLessThan(20);
    // Turning J1 round swaps the end its B+ and KEY pins are at, and J1 slides along its edge to keep them near J2.
    const pad = (ref: string, net: string) => {
      const it = items.find((i) => i.reference === ref)!;
      return footprintPoint(it.pads.find((p) => p.net === net)!, placed[ref]!.at, placed[ref]!.rotate);
    };
    const run = (net: string) => Math.abs(pad("J1", net).x - pad("J2", net).x) + Math.abs(pad("J1", net).y - pad("J2", net).y);
    expect(run("B+") + run("KEY")).toBeLessThan(60);
  });

  it("finds the one narrow space beside the pins an edge connector connects to", () => {
    // J1 is pinned on the left edge and U2 in the bottom middle. Between them is room for J2 with 0.2 mm to spare,
    // at a position off the 1 mm grid the other parts are tried on. KEY also goes to a header pin across the board.
    const items: PlaceItem[] = [
      { reference: "J1", extent: { x: -5.4, y: -13, w: 10.8, h: 26 }, pads: ["A", "B", "C", "B+", "KEY"].map((net, i) => ({ x: 0, y: -10 + 5 * i, net })), at: { x: 6.4, y: 24 } },
      { reference: "J2", extent: { x: -6, y: -5, w: 12, h: 10 }, pads: [{ x: -2.5, y: 0, net: "B+" }, { x: 2.5, y: 0, net: "KEY" }], edge: "bottom", rotate: 0 },
      { reference: "U2", extent: { x: -3, y: -4, w: 6, h: 8 }, pads: [{ x: 0, y: 0, net: "GND" }], at: { x: 28, y: 36 } },
      { reference: "J4", extent: { x: -1.5, y: -9, w: 3, h: 18 }, pads: ["KEY", "D1", "D2", "D3"].map((net, i) => ({ x: 0, y: -7.5 + 5 * i, net })), at: { x: 40, y: 15 } },
    ];
    const { placed, unplaced } = placeParts(items, AREA, { gap: 1.5 });
    expect(unplaced).toEqual([]);
    expect(placed.J2!.at.x).toBeGreaterThan(18.2);
    expect(placed.J2!.at.x).toBeLessThan(18.6);
  });

  it("puts a part beside one pad of another when near names it (\"U1:1\")", () => {
    // A module with its supply pin in one corner and its ground pin in the other: the capacitor's ground pad
    // pulls it to the wrong corner, as a near that names only the part allows.
    const module: PlaceItem = {
      reference: "U1",
      extent: { x: -9, y: -10, w: 18, h: 20 },
      pads: [{ x: -9, y: -9, net: "+3V3", number: "1" }, { x: -9, y: 9, net: "GND", number: "9" }, { x: 9, y: 9, net: "IO", number: "10" }],
      at: { x: 30, y: 20 },
      rotate: 0,
      group: "MCU",
    };
    const ldo: PlaceItem = { reference: "U2", extent: { x: -2, y: -2, w: 4, h: 4 }, pads: [{ x: 0, y: -1, net: "+3V3", number: "5" }, { x: -1, y: 1, net: "VIN", number: "1" }, { x: 1, y: 1, net: "EN", number: "3" }], at: { x: 30, y: 38 }, rotate: 0 };
    const cap = (near: string): PlaceItem => ({ reference: "C1", extent: { x: -1.5, y: -0.8, w: 3, h: 1.6 }, pads: [{ x: -0.8, y: 0, net: "+3V3", number: "1" }, { x: 0.8, y: 0, net: "GND", number: "2" }], group: "MCU", near });
    const pin1 = { x: 30 - 9, y: 20 - 9 };
    const fromPin1 = (near: string) => {
      const items = [module, ldo, cap(near)];
      const { placed, unplaced } = placeParts(items, AREA);
      expect(unplaced).toEqual([]);
      const q = footprintPoint(cap(near).pads[0]!, placed.C1!.at, placed.C1!.rotate);
      return Math.abs(q.x - pin1.x) + Math.abs(q.y - pin1.y);
    };
    expect(fromPin1("U1:1")).toBeLessThan(3);
    // Only beside the module: the ground pin's pull wins, and the capacitor ends up a module's length away.
    expect(fromPin1("U1")).toBeGreaterThan(10);
  });

  it("keeps parts apart by their bodies; a reference text may lie over another body, not over its pads or text", () => {
    // Two 10 mm parts in a 25 mm strip: they fit side by side only if U1's label, sticking out 2 mm on
    // its right, may lie over U2's body. It must still miss U2's pads (at U2's far end) and its label.
    const body = { x: -5, y: -3, w: 10, h: 6 };
    const part = (reference: string, more: Partial<PlaceItem>): PlaceItem => ({
      reference,
      body,
      label: { x: 5, y: -0.5, w: 2, h: 1 },
      extent: { x: -5, y: -3, w: 12, h: 6 },
      pads: [{ x: 4, y: 0, net: "N" }],
      textKeepOff: [{ x: 3.5, y: -0.5, w: 1, h: 1 }],
      rotate: 0,
      ...more,
    });
    const area = { x: 0, y: 0, w: 25, h: 8 };
    const { placed, unplaced } = placeParts([part("U1", { at: { x: 6, y: 4 } }), part("U2", { pads: [{ x: 4, y: 0, net: "N" }] })], area, { margin: 0.5, gap: 0.5 });
    expect(unplaced).toEqual([]);
    expect(placed.U2!.at.x).toBeGreaterThanOrEqual(16.5); // U1's body ends at 11, U2's starts 0.5 mm on
    // A pad at U2's near end would be under U1's label: then there is no room.
    expect(placeParts([part("U1", { at: { x: 6, y: 4 } }), part("U2", { textKeepOff: [{ x: -5, y: -0.5, w: 1, h: 1 }] })], area, { margin: 0.5, gap: 0.5 }).unplaced).toEqual(["U2"]);
    // Without a separate label, the whole boxes collide and U2 has no room.
    const plain = (it: PlaceItem): PlaceItem => ({ ...it, label: undefined, textKeepOff: undefined });
    expect(placeParts([plain(part("U1", { at: { x: 6, y: 4 } })), plain(part("U2", {}))], area, { margin: 0.5, gap: 0.5 }).unplaced).toEqual(["U2"]);
  });

  it("follows what the spec asks for: along an edge, beside a part, out of a keep-out", () => {
    const part = (reference: string, more: Partial<PlaceItem>): PlaceItem => ({ reference, extent: { x: -3, y: -2, w: 6, h: 4 }, pads: [{ x: -2, y: 0, net: `${reference}a` }, { x: 2, y: 0, net: "BUS" }], ...more });
    const items = [
      part("J1", { edge: "bottom", align: "start", rotate: 0 }),
      part("J2", { edge: "bottom", align: "end", rotate: 0 }),
      part("J3", { edge: "left", align: "center", rotate: 0 }),
      // R1 shares no net with U9, and is still put beside it.
      part("U9", { at: { x: 45, y: 8 } }),
      { reference: "R1", extent: { x: -1, y: -0.5, w: 2, h: 1 }, pads: [{ x: 0, y: 0, net: "BUS" }], near: "U9" },
      // The middle of the board is kept clear of parts, where C1 would otherwise go.
      { reference: "C1", extent: { x: -1, y: -0.5, w: 2, h: 1 }, pads: [{ x: 0, y: 0, net: "BUS" }] },
    ];
    const keepout = { x: 10, y: 10, w: 30, h: 25 };
    const { placed, unplaced } = placeParts(items, AREA, { keepouts: [keepout] });
    expect(unplaced).toEqual([]);
    expect(placed.J1!.at.x).toBe(4); // box against the left margin
    expect(placed.J2!.at.x).toBe(56);
    expect(placed.J3!.at.y).toBeCloseTo(22.5, 0);
    expect(Math.abs(placed.R1!.at.x - 45) + Math.abs(placed.R1!.at.y - 8)).toBeLessThan(6);
    for (const ref of ["R1", "C1"]) {
      const at = placed[ref]!.at;
      expect(at.x > keepout.x - 1 && at.x < keepout.x + keepout.w + 1 && at.y > keepout.y - 0.5 && at.y < keepout.y + keepout.h + 0.5, ref).toBe(false);
    }
  });

  it("lays a row of pins along its edge and turns a connector's opening outwards", () => {
    const items: PlaceItem[] = [
      // A pin header: its reference text at one end makes the box lopsided, which must not turn it across the board.
      { reference: "J5", extent: { x: -1.5, y: -3.5, w: 3, h: 22 }, body: { x: -1.5, y: -1.5, w: 3, h: 20 }, pads: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 0, y: 2.5 * i, net: `N${i}` })), edge: "top" },
      // A terminal block whose wires go in on its +Y side, with pads nearer that side.
      { reference: "J1", extent: { x: -3, y: -7, w: 26, h: 12 }, body: { x: -3, y: -5.5, w: 26, h: 10.5 }, pads: [0, 1, 2, 3, 4].map((i) => ({ x: 5 * i, y: 0, net: `M${i}` })), edge: "left", opening: { x: 0, y: 1 } },
    ];
    const { placed } = placeParts(items, AREA);
    expect(placed.J5!.rotate % 180).toBe(90);
    // +Y of the footprint points left (out of the board) at 270°.
    expect(footprintPoint({ x: 0, y: 1 }, { x: 0, y: 0 }, placed.J1!.rotate).x).toBeCloseTo(-1);
  });
});
