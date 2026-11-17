/**
 * Custom rules and nets in several classes. KiCad's rule engine treats A.NetClass == 'X' (and !=,
 * and hasNetclass) as matching any class a combined one is made of ("DDR4_CMD,Default"), with
 * wildcards, as well as the combined name itself.
 */
import { describe, expect, it } from "vitest";
import { evalExpr, parseExpr, type RuleItem } from "../src/index.js";

const item = (netClass: string): RuleItem => ({ type: "Track", netName: "/A", netClass, layers: new Set(["F.Cu"]), intersectsArea: () => false });
const test = (cond: string, netClass: string) => !!evalExpr(parseExpr(cond), item(netClass));

describe("NetClass in rule conditions", () => {
  it("matches a class a combined one is made of", () => {
    expect(test("A.NetClass == 'DDR4_CMD'", "DDR4_CMD,Default")).toBe(true);
    expect(test("A.NetClass == 'ddr4_cmd'", "DDR4_CMD,Default")).toBe(true);
    expect(test("A.NetClass == 'DDR4_*'", "Slow,DDR4_CMD")).toBe(true);
    expect(test("A.NetClass == 'DDR4_CMD,Default'", "DDR4_CMD,Default")).toBe(true);
    expect(test("A.NetClass == 'DDR4_BYTE0'", "DDR4_CMD,Default")).toBe(false);
    expect(test("A.NetClass != 'DDR4_CMD'", "DDR4_CMD,Default")).toBe(false);
    expect(test("A.NetClass != 'DDR4_BYTE0'", "DDR4_CMD,Default")).toBe(true);
    expect(test("A.hasNetclass('Default')", "DDR4_CMD,Default")).toBe(true);
    expect(test("A.hasNetclass('DDR4_BYTE0')", "DDR4_CMD,Default")).toBe(false);
    // A single class still compares as before.
    expect(test("A.NetClass == 'DDR4_CMD'", "DDR4_CMD")).toBe(true);
  });
});
