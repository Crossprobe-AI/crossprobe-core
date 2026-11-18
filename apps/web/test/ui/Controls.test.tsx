/**
 * The app's controls at their defaults (styles.css): plain buttons and fields, their
 * heights side by side, text without figure-wide punctuation, the copy field, the
 * badge, and the floating panels that lay out their fields in rows (nothing sticks out).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { parseBoard } from "@crossprobe/kicad-model";
import "../../src/styles.css";
import { CopyField } from "../../src/ui/CopyField";
import { BoardReannotate } from "../../src/ui/BoardReannotate";
import { Annotate } from "../../src/ui/Annotate";
import { FindReplace } from "../../src/ui/FindReplace";
import type { ProjectView, SheetView } from "../../src/render/types";
import boardText from "../../../../blocks/library/crossprobe.kicad_blocks/rp2040-minimal.kicad_block/rp2040-minimal.kicad_pcb?raw";

const box = (el: Element) => el.getBoundingClientRect();
const centre = (el: Element) => (box(el).top + box(el).bottom) / 2;
/** The browser's own look for a control: a 2px outset bevel, or its #767676 / black field border. */
const browserDefault = (el: Element) => {
  const cs = getComputedStyle(el);
  return cs.borderTopStyle === "outset" || cs.borderTopStyle === "inset" || cs.borderTopColor === "rgb(118, 118, 118)" || cs.borderTopColor === "rgb(0, 0, 0)" || cs.backgroundColor === "rgb(239, 239, 239)";
};
/** Nothing inside `panel` is wider than it, or scrolls it sideways. */
function expectContained(panel: HTMLElement) {
  const p = box(panel);
  expect(panel.scrollWidth, `${panel.className} scrolls sideways`).toBeLessThanOrEqual(panel.clientWidth);
  for (const el of panel.querySelectorAll("*")) {
    const r = box(el);
    if (!r.width) continue;
    expect(r.right, `${el.tagName.toLowerCase()}.${el.className} ends at ${r.right}, the panel at ${p.right}`).toBeLessThanOrEqual(p.right + 0.5);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("plain controls", () => {
  it("a button and a field without styles of their own still get the app's look, and line up", async () => {
    await render(
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", padding: 8 }}>
        <input aria-label="Name" />
        <select aria-label="Kind">
          <option>One</option>
        </select>
        <button>Plain</button>
        <button className="primary">Primary</button>
        <button disabled>Disabled</button>
      </div>,
    );
    const [input, select] = [document.querySelector("input")!, document.querySelector("select")!];
    const buttons = [...document.querySelectorAll("button")];
    for (const el of [input, select, ...buttons]) {
      expect(browserDefault(el), `${el.tagName} ${el.textContent} has the browser's look`).toBe(false);
      expect(box(el).height, `${el.tagName} ${el.textContent} height`).toBeCloseTo(box(input).height, 0);
    }
    expect(Number(getComputedStyle(buttons[2]!).opacity)).toBeLessThan(1);
    expect(getComputedStyle(buttons[2]!).cursor).toBe("default");
  });

  it("component styles win over the defaults (menus, tabs, icon buttons keep their own look)", async () => {
    await render(
      <>
        <button className="icon-btn">x</button>
        <div className="menu-items" style={{ position: "static" }}>
          <button>Item</button>
        </div>
      </>,
    );
    for (const b of document.querySelectorAll("button")) expect(getComputedStyle(b).borderTopWidth, b.className || b.textContent!).toBe("0px");
  });

  it("in a floating panel, every control is the same compact height", async () => {
    await render(
      <div className="update-pcb" style={{ position: "static" }}>
        <div className="update-actions">
          <input aria-label="Find" />
          <select aria-label="In">
            <option>All</option>
          </select>
          <button>Close</button>
          <button className="primary">Apply</button>
        </div>
      </div>,
    );
    const els = [...document.querySelectorAll(".update-pcb input, .update-pcb select, .update-pcb button")];
    const h = box(els[0]!).height;
    expect(h).toBeLessThan(30);
    for (const el of els) expect(box(el).height, `${el.tagName} ${el.textContent}`).toBeCloseTo(h, 0);
  });

  it("text has proportional punctuation: '.' ',' ':' are not figure-wide", async () => {
    await render(
      <p>
        <span id="dots">a.b,c:d</span> <span id="plain">abcd</span>
      </p>,
    );
    expect(getComputedStyle(document.body).fontVariantNumeric).toBe("normal");
    // Three punctuation marks add little to four letters; figure-wide ones would add about three digits' width.
    const added = box(document.getElementById("dots")!).width - box(document.getElementById("plain")!).width;
    expect(added).toBeLessThan(12);
  });

  it("a badge stands out from the text around it", async () => {
    await render(
      <p>
        Plan <span className="badge">Connect</span>
      </p>,
    );
    const cs = getComputedStyle(document.querySelector(".badge")!);
    expect(cs.backgroundColor).not.toBe(getComputedStyle(document.body).backgroundColor);
    expect(cs.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Number(cs.fontWeight)).toBeGreaterThanOrEqual(600);
  });
});

describe("CopyField", () => {
  const ADDRESS = "https://app.example.com/__mcp";

  it("shows the value whole, in the monospace face, with Copy centred beside it at the same height", async () => {
    await render(
      <div className="modal github" style={{ position: "static", width: 520 }}>
        <CopyField label="MCP server address" value={ADDRESS} />
      </div>,
    );
    const input = document.querySelector<HTMLInputElement>(".copy-field input")!;
    const button = document.querySelector<HTMLButtonElement>(".copy-field button")!;
    expect(input.value).toBe(ADDRESS);
    expect(getComputedStyle(input).fontFamily).toMatch(/IBM Plex Mono/);
    expect(getComputedStyle(input).fontVariantNumeric).toBe("normal");
    expect(Math.abs(centre(input) - centre(button))).toBeLessThanOrEqual(0.5);
    expect(box(button).height).toBeCloseTo(box(input).height, 0);
    expect(browserDefault(button)).toBe(false);
    // The whole address fits without scrolling in a dialog this wide.
    expect(input.scrollWidth).toBeLessThanOrEqual(input.clientWidth);
    expectContained(document.querySelector(".modal")!);
  });

  it("is labelled, so the field and the button can be found by their label", async () => {
    const screen = await render(<CopyField label="Token" value="abc" />);
    await expect.element(screen.getByLabelText("Token", { exact: true })).toHaveValue("abc");
    await expect.element(screen.getByRole("button", { name: "Copy Token" })).toBeVisible();
  });

  it("selects the whole value on focus", async () => {
    const screen = await render(<CopyField label="Token" value="secret-token" />);
    await screen.getByLabelText("Token", { exact: true }).click();
    const input = document.querySelector<HTMLInputElement>(".copy-field input")!;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "secret-token".length]);
  });

  it("copies the value, says so, then goes back to Copy", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(<CopyField label="Address" value={ADDRESS} />);
    await screen.getByRole("button", { name: "Copy Address" }).click();
    expect(write).toHaveBeenCalledWith(ADDRESS);
    await expect.element(screen.getByRole("button", { name: "Copy Address" })).toHaveTextContent("Copied");
    await expect.element(screen.getByRole("status")).toHaveTextContent("Copied");
    await vi.waitFor(() => expect(document.querySelector(".copy-field button")!.textContent).toBe("Copy"), { timeout: 3000 });
  });

  it("says when the browser refuses the clipboard", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const screen = await render(<CopyField label="Address" value={ADDRESS} />);
    await screen.getByRole("button", { name: "Copy Address" }).click();
    await expect.element(screen.getByRole("button", { name: "Copy Address" })).toHaveTextContent("Copy failed");
  });

  it("keeps a long value on one line inside a narrow dialog, without pushing Copy out", async () => {
    await render(
      <div className="modal github" style={{ position: "static", width: 300 }}>
        <CopyField label="Command" value={`claude mcp add --transport http example ${ADDRESS} --header "Authorization: Bearer ${"x".repeat(40)}"`} />
      </div>,
    );
    expectContained(document.querySelector(".modal")!);
    const input = document.querySelector<HTMLInputElement>(".copy-field input")!;
    expect(box(input).height).toBeLessThan(40);
  });
});

describe("floating panels with rows of fields", () => {
  const sheet = { path: "/", file: "a.kicad_sch", name: "a", children: [] } as unknown as SheetView;
  const board = parseBoard(boardText);
  const project = { board, boardFile: "board.kicad_pcb", sheets: [sheet], components: [], nets: [] } as unknown as ProjectView;
  /** Placed as in the app: absolute, at the right of a canvas. */
  const Canvas = ({ children }: { children: React.ReactNode }) => <div style={{ position: "relative", width: 1000, height: 800 }}>{children}</div>;
  const none = () => {};

  it("Renumber the board by position fits its panel", async () => {
    await render(
      <Canvas>
        <BoardReannotate project={project} onEdit={none} onClose={none} onDone={none} />
      </Canvas>,
    );
    const panel = document.querySelector<HTMLElement>(".board-reannotate")!;
    expectContained(panel);
    for (const f of panel.querySelectorAll("input:not([type=checkbox]), select")) expect(browserDefault(f), f.outerHTML.slice(0, 60)).toBe(false);
  });

  it("Annotate schematic fits its panel", async () => {
    await render(
      <Canvas>
        <Annotate sheet={sheet} onEdit={none} onClose={none} />
      </Canvas>,
    );
    expectContained(document.querySelector<HTMLElement>(".annotate-panel")!);
  });

  it("Find fits its panel", async () => {
    await render(
      <Canvas>
        <FindReplace project={project} files={async () => ({})} editing onEdit={none} onShow={none} onClose={none} />
      </Canvas>,
    );
    expectContained(document.querySelector<HTMLElement>(".find-panel")!);
  });
});
