/** Requirements: file parsing and the rule checks, on a small generated project. */
import { describe, expect, it } from "vitest";
import { parseRequirements, serializeRequirements, validRequirement, checkRequirement, type Requirement } from "../src/requirements/requirements";
import type { ProjectView } from "../src/render/types";

const project = {
  components: [
    { reference: "U1", value: "AP9999", libId: "Regulator:AP9999", description: "LDO", dnp: false },
    { reference: "J1", value: "USB_C", libId: "Connector:USB_C", description: "", dnp: false },
    { reference: "R1", value: "10k", libId: "Device:R", description: "", dnp: true },
  ],
  nets: [
    { name: "+5V", aliases: [], nodes: [{ reference: "J1", pin: "1" }, { reference: "U1", pin: "1" }] },
    { name: "/D+", aliases: [], nodes: [{ reference: "J1", pin: "2" }] },
  ],
  board: {
    copperLayers: ["F.Cu", "B.Cu"],
    outline: [{ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 50 }, { x: 0, y: 50 }] }],
    tracks: [{ net: "+5V", width: 0.5 }, { net: "+5V", width: 0.25 }],
  },
} as unknown as ProjectView;

const run = (r: object) => checkRequirement(project, { id: "r", title: "t", ...r } as Requirement);

describe("requirements", () => {
  it("drops malformed entries and duplicates, never throws", () => {
    const text = JSON.stringify({ version: 1, requirements: [{ id: "a", title: "A", kind: "net_present", net: "+5V" }, { id: "a", title: "dup", kind: "net_present", net: "x" }, { id: "b", title: "B", kind: "board_size" }, { id: "c", title: "C", kind: "nope" }, 7] });
    expect(parseRequirements(text).map((r) => r.id)).toEqual(["a"]);
    expect(parseRequirements("not json")).toEqual([]);
    expect(parseRequirements(undefined)).toEqual([]);
    expect(validRequirement({ id: "x", title: "y", kind: "min_track_width", net: "+5V", minWidthMm: -1 })).toBeUndefined();
  });
  it("round-trips through the file", () => {
    const r = validRequirement({ id: "a", title: "A", kind: "board_layers", maxLayers: 4 })!;
    expect(parseRequirements(serializeRequirements([r]))).toEqual([r]);
  });
  it("board size, either way round", () => {
    expect(run({ kind: "board_size", maxWidthMm: 50, maxHeightMm: 40 }).status).toBe("pass");
    expect(run({ kind: "board_size", maxWidthMm: 30, maxHeightMm: 60 }).status).toBe("fail");
    expect(checkRequirement({ ...project, board: undefined } as ProjectView, { id: "r", title: "t", kind: "board_size", maxWidthMm: 1 }).status).toBe("unknown");
  });
  it("layers, nets, connectors, parts", () => {
    expect(run({ kind: "board_layers", layers: 4 }).status).toBe("fail");
    expect(run({ kind: "board_layers", maxLayers: 2 }).status).toBe("pass");
    expect(run({ kind: "net_present", net: "+5V" }).status).toBe("pass");
    expect(run({ kind: "net_present", net: "+3V3" }).status).toBe("fail");
    expect(run({ kind: "connector_nets", reference: "j1", nets: ["+5V", "D+"] }).status).toBe("pass");
    expect(run({ kind: "connector_nets", reference: "J1", nets: ["D-"] }).status).toBe("fail");
    expect(run({ kind: "part_count", match: "regulator", min: 1, max: 1 }).status).toBe("pass");
    expect(run({ kind: "part_count", match: "/^10k$/", min: 1 }).status).toBe("fail"); // DNP parts don't count
    expect(run({ kind: "part_count", match: "/(/", min: 1 }).status).toBe("unknown");
  });
  it("part count: a substring of the reference, value, footprint, symbol or description, a /regex/, or a prefix", () => {
    const parts = [
      { reference: "D1", value: "Green", footprint: "LED_SMD:LED_0603_1608Metric", libId: "Device:LED", description: "Light emitting diode", dnp: false },
      { reference: "D12", value: "Red", footprint: "LED_SMD:LED_0603_1608Metric", libId: "Device:LED", description: "Light emitting diode", dnp: false },
      { reference: "DS1", value: "Display", footprint: "Display:LCD", libId: "Display:LCD-016N002L", description: "LCD module", dnp: false },
      { reference: "C1", value: "100n", footprint: "Capacitor_SMD:C_0402_1005Metric", libId: "Device:C", description: "Unpolarized capacitor", dnp: false },
      { reference: "C2", value: "10u", footprint: "Capacitor_SMD:C_0805_2012Metric", libId: "Device:C", description: "Unpolarized capacitor", dnp: true },
    ];
    const count = (r: { match?: string; prefix?: string }) => {
      const res = checkRequirement({ ...project, components: parts } as unknown as ProjectView, { id: "r", title: "t", kind: "part_count", ...r, min: 0 });
      return res.references ?? [];
    };
    expect(count({ match: "led_0603" })).toEqual(["D1", "D12"]); // footprint, case-insensitive
    expect(count({ match: "Device:C" })).toEqual(["C1"]); // symbol; the DNP part doesn't count
    expect(count({ match: "green" })).toEqual(["D1"]); // value
    expect(count({ match: "D12" })).toEqual(["D12"]); // reference
    expect(count({ match: "(" })).toEqual([]); // a plain substring, not a pattern
    expect(count({ prefix: "D" })).toEqual(["D1", "D12"]); // not DS1, not C1 through its description
    expect(count({ prefix: "ds" })).toEqual(["DS1"]);
    expect(count({ prefix: "D", match: "red" })).toEqual(["D12"]);
    expect(count({ match: "/^capacitor_smd:c_0402/" })).toEqual(["C1"]); // a regular expression, on each field, case-insensitive
    expect(count({ match: "/^d1$/" })).toEqual(["D1"]); // anchored to one field, not the fields run together
    expect(validRequirement({ id: "x", title: "y", kind: "part_count", prefix: "U", max: 2 })).toMatchObject({ prefix: "U", max: 2 });
    expect(validRequirement({ id: "x", title: "y", kind: "part_count", min: 1 })).toBeUndefined(); // neither match nor prefix
  });
  it("power budget and track width", () => {
    expect(run({ kind: "power_budget", net: "+5V", supplyMa: 500, loads: [{ reference: "U1", maxMa: 300 }] }).status).toBe("pass");
    expect(run({ kind: "power_budget", net: "+5V", supplyMa: 200, loads: [{ reference: "U1", maxMa: 300 }] }).status).toBe("fail");
    expect(run({ kind: "power_budget", net: "+5V", supplyMa: 500, loads: [{ reference: "R1", maxMa: 1 }] }).status).toBe("fail");
    expect(run({ kind: "min_track_width", net: "+5V", minWidthMm: 0.3 }).status).toBe("fail");
    expect(run({ kind: "min_track_width", net: "+5V", minWidthMm: 0.2 }).status).toBe("pass");
    expect(run({ kind: "min_track_width", net: "/D+", minWidthMm: 0.2 }).status).toBe("unknown");
  });
});

import { requirementFromForm } from "../src/requirements/requirements";
describe("requirement editor", () => {
  it("builds requirements from text inputs", () => {
    expect(requirementFromForm("power_budget", "a", "5V", { net: "+5V", supplyMa: "500", loads: "U1:300, J1:20" })).toMatchObject({ kind: "power_budget", supplyMa: 500, loads: [{ reference: "U1", maxMa: 300 }, { reference: "J1", maxMa: 20 }] });
    expect(requirementFromForm("connector_nets", "a", "t", { reference: "J1", nets: "D+, D-" })).toMatchObject({ nets: ["D+", "D-"] });
    expect(requirementFromForm("board_size", "a", "t", {})).toBeUndefined();
    expect(requirementFromForm("board_size", "a", "t", { maxWidthMm: "abc" })).toBeUndefined();
    expect(requirementFromForm("power_budget", "a", "t", { net: "+5V", supplyMa: "5", loads: "U1" })).toBeUndefined();
  });
});
