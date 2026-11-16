/** Compatibility rules on a small generated project. */
import { describe, expect, it } from "vitest";
import { checkCompatibility, parseOhms, partRails } from "../src/compat/compat";
import type { ProjectView } from "../src/render/types";

const node = (reference: string, pin: string, pinName: string, pinType: string) => ({ reference, pin, pinName, pinType });
const comp = (reference: string, value = "") => ({ reference, value, dnp: false });

function project(over: { nets: ProjectView["nets"]; components?: unknown[] }) {
  return { evidence: [], components: over.components ?? [comp("U1"), comp("U2"), comp("R1", "4.7k"), comp("R2", "4k7")], nets: over.nets } as unknown as ProjectView;
}
const net = (name: string, nodes: ReturnType<typeof node>[]) => ({ name, aliases: [], sheets: [], nodes });

const rails = [
  net("+5V", [node("U1", "1", "VCC", "power_in")]),
  net("+3V3", [node("U2", "1", "VDD", "power_in"), node("R1", "2", "~", "passive"), node("R2", "2", "~", "passive")]),
];

describe("compatibility", () => {
  it("parses resistor values", () => {
    expect(parseOhms("4.7k")).toBe(4700);
    expect(parseOhms("4k7")).toBe(4700);
    expect(parseOhms("470")).toBe(470);
    expect(parseOhms("2M2")).toBe(2.2e6);
    expect(parseOhms("10K 1%")).toBe(10000);
    expect(parseOhms("RES")).toBeUndefined();
  });
  it("finds each part's single rail", () => {
    const p = project({ nets: [...rails, net("+1V8", [node("U1", "9", "VIO", "power_in")])] });
    expect(partRails(p).get("U2")).toBe(3.3);
    expect(partRails(p).has("U1")).toBe(false); // on 5 V and 1.8 V: ambiguous, left out
  });
  it("flags a higher-rail output into a lower-rail input, and the reverse threshold case", () => {
    const p = project({ nets: [...rails, net("/TX", [node("U1", "2", "TX", "output"), node("U2", "2", "RX", "input")]), net("/RX", [node("U2", "3", "TX", "output"), node("U1", "3", "RX", "input")])] });
    const f = checkCompatibility(p);
    expect(f.map((x) => x.title)).toEqual(expect.arrayContaining([expect.stringContaining("U1 (5 V) drives U2 (3.3 V) on /TX"), expect.stringContaining("U2 (3.3 V) may not reach")]));
    expect(f).toHaveLength(2);
  });
  it("is quiet for the same rail", () => {
    const p = project({ nets: [net("+3V3", [node("U1", "1", "VDD", "power_in"), node("U2", "1", "VDD", "power_in")]), net("/A", [node("U1", "2", "A", "output"), node("U2", "2", "A", "input")])] });
    expect(checkCompatibility(p)).toEqual([]);
  });
  it("I2C pull-ups: missing, present, too strong, above a device's supply", () => {
    const bus = (extra: ReturnType<typeof node>[] = []) => net("/SDA", [node("U1", "5", "SDA", "bidirectional"), node("U2", "5", "SDA", "bidirectional"), ...extra]);
    expect(checkCompatibility(project({ nets: [...rails, bus()] })).map((x) => x.title)).toEqual([expect.stringContaining("no I2C pull-up")]);
    const ok = project({ nets: [net("+3V3", [node("U1", "1", "VDD", "power_in"), node("U2", "1", "VDD", "power_in"), node("R1", "2", "~", "passive")]), bus([node("R1", "1", "~", "passive")])] });
    expect(checkCompatibility(ok)).toEqual([]);
    const strong = project({ nets: [net("+3V3", [node("U1", "1", "VDD", "power_in"), node("U2", "1", "VDD", "power_in"), node("R1", "2", "~", "passive")]), bus([node("R1", "1", "~", "passive")])], components: [comp("U1"), comp("U2"), comp("R1", "680")] });
    expect(checkCompatibility(strong)[0]!.title).toContain("680");
    const high = project({ nets: [net("+3V3", [node("U1", "1", "VDD", "power_in"), node("U2", "1", "VDD", "power_in")]), net("+5V", [node("R1", "2", "~", "passive")]), bus([node("R1", "1", "~", "passive")])] });
    expect(checkCompatibility(high)[0]!.title).toContain("above the supply of U1, U2");
  });
});

describe("datasheet-backed (pinned evidence)", () => {
  const ev = (reference: string, heading: string, quote: string) => ({ id: reference + heading, target: { reference }, pinnedAt: "", evidence: { doc: { id: "d", title: "AP9999 datasheet", source: "" }, page: 6, box: { x: 0, y: 0, w: 1, h: 1 }, quote, heading } });
  const base = [...rails, net("/TX", [node("U1", "2", "TX", "output"), node("U2", "2", "RX", "input")])];
  it("reads rows only under rating headings", async () => {
    const { pinnedLimits } = await import("../src/compat/compat");
    const p = { ...project({ nets: base }), evidence: [ev("U2", "6 Absolute Maximum Ratings", "VIN Input voltage -0.3 6.5 V\nTJ Junction temperature -40 150 C"), ev("U2", "Features", "VIN Input voltage 1 2 V")] } as unknown as ProjectView;
    expect(pinnedLimits(p)).toMatchObject([{ reference: "U2", names: ["vin", "in"], section: "abs-max", max: 6.5, min: -0.3, page: 6 }]);
  });
  it("turns a rail crossing into an error, or a note, using the pinned rating", () => {
    const row = (max: string) => ({ ...project({ nets: base }), evidence: [ev("U2", "Absolute Maximum Ratings", `RX Input voltage -0.3 ${max} V`)] }) as unknown as ProjectView;
    const bad = checkCompatibility(row("3.6"));
    expect(bad[0]).toMatchObject({ severity: "error", source: { page: 6 } });
    const ok = checkCompatibility(row("6.5"));
    expect(ok[0]).toMatchObject({ severity: "info" });
  });
  it("checks a supply against pinned ratings", () => {
    const p = { ...project({ nets: rails }), evidence: [ev("U2", "Absolute Maximum Ratings", "VDD Supply voltage -0.3 3.0 V"), ev("U1", "Recommended Operating Conditions", "VCC Supply voltage 2.7 3.6 V")] } as unknown as ProjectView;
    const f = checkCompatibility(p).filter((x) => x.category === "supply-range");
    expect(f.map((x) => [x.severity, x.references[0]])).toEqual([["error", "U2"], ["warning", "U1"]]);
  });
});
