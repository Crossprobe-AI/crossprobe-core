/**
 * The point editor's geometry (KiCad's PCB_POINT_EDITOR): handles, dragging
 * them, adding and removing corners.
 */
import { describe, expect, it } from "vitest";
import { addCorner, dragHandle, handleAt, handles, removeCorner, type EditShape } from "../src/render/point-edit";

const r = (pts: Array<{ x: number; y: number }>) => pts.map((p) => [Math.round(p.x * 1e6) / 1e6 + 0, Math.round(p.y * 1e6) / 1e6 + 0]);
// An octagon-ish zone: a 10 × 10 square with its top-left corner cut at 45°.
const zone: EditShape = { kind: "zone", uuid: "z", points: [{ x: 2, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 2 }] };

describe("polygons", () => {
  it("have a handle on each corner and each edge's middle", () => {
    expect(handles(zone).length).toBe(10);
    expect(handleAt(zone, { x: 6, y: 0.1 }, 0.5)).toMatchObject({ type: "edge", index: 0 });
    expect(handleAt(zone, { x: 10.1, y: 0 }, 0.5)).toMatchObject({ type: "corner", index: 1 });
  });
  it("move a corner on its own", () => {
    expect(r(dragHandle(zone, { type: "corner", index: 2, at: { x: 10, y: 10 } }, { x: 12, y: 11 }))).toEqual([[2, 0], [10, 0], [12, 11], [0, 10], [0, 2]]);
  });
  it("move an edge across itself, its corners sliding along the neighbours (KiCad's converging mode)", () => {
    // The top edge 1 mm up (the cursor's sideways part ignored): its left corner runs on along
    // the 45° cut (y = 2 - x), its right one up the right side.
    expect(r(dragHandle(zone, { type: "edge", index: 0, at: { x: 6, y: 0 } }, { x: 7.3, y: -1 }))).toEqual([[3, -1], [10, -1], [10, 10], [0, 10], [0, 2]]);
    // Down: the cut shortens.
    expect(r(dragHandle(zone, { type: "edge", index: 0, at: { x: 6, y: 0 } }, { x: 6, y: 1 }))).toEqual([[1, 1], [10, 1], [10, 10], [0, 10], [0, 2]]);
    // Never past where the neighbours meet: a triangle's edge stops at its apex.
    const tri: EditShape = { kind: "poly", uuid: "t", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 2 }] };
    expect(r(dragHandle(tri, { type: "edge", index: 0, at: { x: 2, y: 0 } }, { x: 2, y: 5 }))).toEqual([[2, 2], [2, 2], [2, 2]]);
  });
  it("add a corner on the nearest edge, at the nearest point (the middle if that is a corner)", () => {
    expect(r(addCorner(zone.points, { x: 11, y: 4 }))).toEqual([[2, 0], [10, 0], [10, 4], [10, 10], [0, 10], [0, 2]]);
    expect(r(addCorner(zone.points, { x: 11, y: -1 }))).toEqual([[2, 0], [6, 0], [10, 0], [10, 10], [0, 10], [0, 2]]);
  });
  it("remove a corner while three are left", () => {
    expect(r(removeCorner(zone.points, 0)!)).toEqual([[10, 0], [10, 10], [0, 10], [0, 2]]);
    expect(removeCorner(zone.points.slice(0, 3), 0)).toBeUndefined();
  });
});

describe("other shapes", () => {
  it("rectangle: a corner keeps the opposite one; an edge moves its side only", () => {
    const rect: EditShape = { kind: "rect", uuid: "r", points: [{ x: 0, y: 0 }, { x: 4, y: 2 }] };
    expect(r(dragHandle(rect, { type: "corner", index: 2, at: { x: 4, y: 2 } }, { x: 5, y: 3 }))).toEqual([[0, 0], [5, 3]]);
    expect(r(dragHandle(rect, { type: "corner", index: 1, at: { x: 4, y: 0 } }, { x: 5, y: -1 }))).toEqual([[0, 2], [5, -1]]);
    expect(r(dragHandle(rect, { type: "edge", index: 1, at: { x: 4, y: 1 } }, { x: 6, y: 1.5 }))).toEqual([[0, 0], [6, 2]]);
    expect(r(dragHandle(rect, { type: "edge", index: 0, at: { x: 2, y: 0 } }, { x: 2, y: -1 }))).toEqual([[0, -1], [4, 2]]);
  });
  it("circle: the centre moves it, the rim sets the radius", () => {
    const c: EditShape = { kind: "circle", uuid: "c", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    expect(r(dragHandle(c, { type: "corner", index: 0, at: { x: 0, y: 0 } }, { x: 2, y: 2 }))).toEqual([[2, 2], [3, 2]]);
    expect(r(dragHandle(c, { type: "corner", index: 1, at: { x: 1, y: 0 } }, { x: 0, y: 3 }))).toEqual([[0, 0], [0, 3]]);
  });
});
