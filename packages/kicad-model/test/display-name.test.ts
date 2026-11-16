import { describe, expect, it } from "vitest";
import { displayName, escapeNetName } from "../src/index.js";

describe("displayName", () => {
  it("undoes the file escapes in a net name", () => {
    expect(displayName("unconnected-(U6-GP5{slash}OSC1-Pad2)")).toBe("unconnected-(U6-GP5/OSC1-Pad2)");
    expect(displayName("/sheet/A{slash}{slash}B{colon}1")).toBe("/sheet/A//B:1");
    expect(displayName(escapeNetName("VPP/MCLR"))).toBe("VPP/MCLR");
  });
  it("leaves markup, variables and unknown braces alone", () => {
    expect(displayName("~{reset}")).toBe("~{reset}");
    expect(displayName("${slash}")).toBe("${slash}");
    expect(displayName("D{0..7}")).toBe("D{0..7}");
    expect(displayName("{other}")).toBe("{other}");
  });
});
