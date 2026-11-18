/**
 * The workspace's side panels (ui/SidePanel.tsx): collapsing with the button at the
 * middle of the inner edge, resizing by dragging or with the keyboard, the limits, the
 * canvas's minimum width, the inspector widened for a tab, and what is kept between visits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { CANVAS_MIN, clampWidth, layoutColumns, PANEL_LIMITS, panelWidths, readLayout, SidePanel, SNAP_SHUT, usePanelLayout, type Side } from "../../src/ui/SidePanel";

const KEY = "crossprobe.panels";
const W = 1280;

/** The workspace as App.tsx lays it out: sheets on the left, the canvas, the inspector on the right. */
function Workspace({ wide = false }: { wide?: boolean }) {
  const panels = usePanelLayout(wide ? 600 : 0);
  const panel = (side: Side, label: string, body: React.ReactNode) => (
    <SidePanel side={side} label={label} state={panels.layout[side]} onChange={(p) => panels.set(side, p)} onToggle={() => panels.toggle(side)} otherWidth={panels.widths[side === "left" ? "right" : "left"]}>
      {body}
    </SidePanel>
  );
  return (
    <div className="app" style={{ height: 600 }}>
      <div className={`workspace ${panels.className}`} ref={panels.ref} style={panels.style}>
        {panel(
          "left",
          "Sheets",
          <aside className="sidebar">
            <button>In the sheets</button>
          </aside>,
        )}
        <main className="canvas">
          <button>On the canvas</button>
        </main>
        {panel(
          "right",
          "Inspector",
          <aside className="inspector">
            <button>In the inspector</button>
          </aside>,
        )}
      </div>
    </div>
  );
}

const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const cell = (side: Side) => q(`.side-panel.${side}`);
const toggle = (side: Side) => q<HTMLButtonElement>(`.side-panel.${side} .side-panel-toggle`);
const edge = (side: Side) => q(`.side-panel.${side} .side-panel-edge`);
const canvas = () => q("main.canvas");
const width = (el: Element) => el.getBoundingClientRect().width;
const frames = (n = 2) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
/** Wait for the open/shut animation to end. */
const settled = () => new Promise((r) => setTimeout(r, 400));
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

/** Drag `side`'s edge by dx pixels, as a mouse does: down, a few moves, up. */
async function drag(side: Side, dx: number) {
  const el = edge(side);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = (clientX: number) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX, clientY: y });
  el.dispatchEvent(new PointerEvent("pointerdown", opts(x)));
  await frames(1);
  for (let i = 1; i <= 4; i++) el.dispatchEvent(new PointerEvent("pointermove", opts(x + (dx * i) / 4)));
  await frames(1);
  const during = cell(side).classList.contains("dragging");
  el.dispatchEvent(new PointerEvent("pointerup", opts(x + dx)));
  await frames();
  return { during };
}

beforeEach(async () => {
  localStorage.removeItem(KEY);
  await page.viewport(W, 800);
});
afterEach(() => vi.restoreAllMocks());

describe("layout", () => {
  it("opens at the default widths, with the canvas taking the rest", async () => {
    await render(<Workspace />);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default);
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default);
    expect(width(canvas())).toBe(W - PANEL_LIMITS.left.default - PANEL_LIMITS.right.default);
  });

  it("puts each toggle at the middle of its panel's inner edge, mirrored", async () => {
    await render(<Workspace />);
    for (const side of ["left", "right"] as const) {
      const p = cell(side).getBoundingClientRect();
      const t = toggle(side).getBoundingClientRect();
      const inner = side === "left" ? p.right : p.left;
      expect(Math.abs((t.left + t.right) / 2 - inner), `${side} toggle sits on the edge`).toBeLessThanOrEqual(1);
      expect(Math.abs((t.top + t.bottom) / 2 - (p.top + p.bottom) / 2), `${side} toggle at the middle`).toBeLessThanOrEqual(1);
      // A small upright tab, with the app's square-ish corners.
      expect(t.height).toBeGreaterThan(t.width * 1.5);
      expect(getComputedStyle(toggle(side)).borderTopLeftRadius).toBe("3px");
    }
    // The chevron points the way the panel shuts: left on the left panel, right on the right.
    expect(getComputedStyle(q(".side-panel.left .side-panel-toggle .icon")).transform).not.toBe("none");
    expect(getComputedStyle(q(".side-panel.right .side-panel-toggle .icon")).transform).toBe("none");
  });

  it("names the toggles and the edges for what they do", async () => {
    const screen = await render(<Workspace />);
    await expect.element(screen.getByRole("button", { name: "Hide sheets" })).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByRole("button", { name: "Hide inspector" })).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByRole("separator", { name: "Resize sheets" })).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.left.default));
    await expect.element(screen.getByRole("separator", { name: "Resize inspector" })).toHaveAttribute("aria-orientation", "vertical");
  });
});

describe("collapsing", () => {
  it("shuts the left panel with its button, gives the canvas the room, and opens it again at the same width", async () => {
    const screen = await render(<Workspace />);
    await drag("left", 70);
    expect(width(cell("left"))).toBe(300);
    await screen.getByRole("button", { name: "Hide sheets" }).click();
    await settled();
    expect(width(cell("left"))).toBe(0);
    expect(width(canvas())).toBe(W - PANEL_LIMITS.right.default);
    await expect.element(screen.getByRole("button", { name: "Show sheets" })).toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "Show sheets" }).click();
    await settled();
    expect(width(cell("left"))).toBe(300);
  });

  it("shuts the right panel the same way, mirrored", async () => {
    const screen = await render(<Workspace />);
    await screen.getByRole("button", { name: "Hide inspector" }).click();
    await settled();
    expect(width(cell("right"))).toBe(0);
    expect(canvas().getBoundingClientRect().right).toBe(W);
    await screen.getByRole("button", { name: "Show inspector" }).click();
    await settled();
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default);
  });

  it("animates: the column passes through the widths between, and the content slides rather than squeezes", async () => {
    await render(<Workspace />);
    const inner = q(".side-panel.left .side-panel-body");
    toggle("left").click();
    const seen: number[] = [];
    const contentWidths: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 300) {
      await frames(1);
      seen.push(width(cell("left")));
      contentWidths.push(width(inner));
    }
    expect(seen.some((w) => w > 5 && w < PANEL_LIMITS.left.default - 5), `widths seen: ${seen.map(Math.round).join(", ")}`).toBe(true);
    expect(seen.at(-1)).toBe(0);
    // The content kept its width all the way, so it slid out of view behind the canvas.
    expect(new Set(contentWidths.map(Math.round))).toEqual(new Set([PANEL_LIMITS.left.default]));
  });

  it("keeps the toggle of a shut panel on the canvas, fully in view, to bring it back", async () => {
    await render(<Workspace />);
    toggle("left").click();
    toggle("right").click();
    await settled();
    const l = toggle("left").getBoundingClientRect();
    const r = toggle("right").getBoundingClientRect();
    expect(l.left).toBeGreaterThanOrEqual(2);
    expect(r.right).toBeLessThanOrEqual(W - 2);
    // Still at the middle, and the one thing at that point (nothing covers it).
    for (const t of [l, r]) {
      const hit = document.elementFromPoint((t.left + t.right) / 2, (t.top + t.bottom) / 2);
      expect(hit?.closest(".side-panel-toggle")).not.toBeNull();
    }
    // The chevrons have turned: the left one now points right, the right one left.
    expect(getComputedStyle(q(".side-panel.left .side-panel-toggle .icon")).transform).toBe("none");
    expect(getComputedStyle(q(".side-panel.right .side-panel-toggle .icon")).transform).not.toBe("none");
  });

  it("takes a shut panel's content out of the Tab order and out of the accessibility tree", async () => {
    await render(<Workspace />);
    toggle("left").click();
    await settled();
    const body = q(".side-panel.left .side-panel-body");
    expect(body.inert).toBe(true);
    toggle("left").focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.textContent).toBe("On the canvas");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(toggle("left"));
  });

  it("works from the keyboard: Space and Enter on the toggle, Enter on the edge", async () => {
    await render(<Workspace />);
    toggle("right").focus();
    await userEvent.keyboard(" ");
    expect(toggle("right").getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard("{Enter}");
    expect(toggle("right").getAttribute("aria-expanded")).toBe("true");
    edge("left").focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle("left").getAttribute("aria-expanded")).toBe("false");
    // The focus stays where it was, on the edge, which is still there to open it again.
    expect(document.activeElement).toBe(edge("left"));
    await userEvent.keyboard("{Enter}");
    expect(toggle("left").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("resizing", () => {
  it("widens and narrows the left panel by dragging its edge, and drops the animation while dragging", async () => {
    await render(<Workspace />);
    const { during } = await drag("left", 100);
    expect(during).toBe(true);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default + 100);
    expect(cell("left").classList.contains("dragging")).toBe(false);
    await drag("left", -50);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default + 50);
  });

  it("mirrors it on the right: dragging the edge left widens the inspector", async () => {
    await render(<Workspace />);
    await drag("right", -100);
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default + 100);
    await drag("right", 40);
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default + 60);
  });

  it("stops at the narrowest and the widest width", async () => {
    await render(<Workspace />);
    await drag("left", -(PANEL_LIMITS.left.default - PANEL_LIMITS.left.min) - 30);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.min);
    await drag("left", 1000);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.max);
  });

  it("never squeezes the canvas below its minimum", async () => {
    await render(<Workspace />);
    await drag("right", -2000);
    expect(width(canvas())).toBeGreaterThanOrEqual(CANVAS_MIN);
    await drag("left", 2000);
    expect(width(canvas())).toBeGreaterThanOrEqual(CANVAS_MIN);
  });

  it("shuts a panel dragged well past its narrowest, and opens it by dragging back out", async () => {
    await render(<Workspace />);
    await drag("left", -(PANEL_LIMITS.left.default - PANEL_LIMITS.left.min) - SNAP_SHUT - 20);
    await settled();
    expect(toggle("left").getAttribute("aria-expanded")).toBe("false");
    expect(width(cell("left"))).toBe(0);
    await drag("left", 250);
    await settled();
    expect(toggle("left").getAttribute("aria-expanded")).toBe("true");
    expect(width(cell("left"))).toBe(250);
  });

  it("resizes from the keyboard: arrows by 10, Shift by 50, Home and End to the limits", async () => {
    const screen = await render(<Workspace />);
    const sep = screen.getByRole("separator", { name: "Resize inspector" });
    edge("right").focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(sep).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.right.default + 10));
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await expect.element(sep).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.right.default + 60));
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(sep).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.right.default + 50));
    await userEvent.keyboard("{Home}");
    await expect.element(sep).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.right.min));
    await userEvent.keyboard("{End}");
    // As wide as it may be: its widest, or what leaves the canvas its minimum.
    await settled();
    expect(width(canvas())).toBeGreaterThanOrEqual(CANVAS_MIN);
    expect(width(cell("right"))).toBe(Math.min(PANEL_LIMITS.right.max, W - PANEL_LIMITS.left.default - CANVAS_MIN));
  });

  it("puts the default width back on a double-click on the edge", async () => {
    await render(<Workspace />);
    await drag("left", 120);
    edge("left").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await frames();
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default);
  });

  it("shows the edge's line while it is hovered", async () => {
    const screen = await render(<Workspace />);
    // Above the toggle, which sits on the middle of the edge.
    await screen.getByRole("separator", { name: "Resize sheets" }).hover({ position: { x: 4, y: 40 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(Number(getComputedStyle(edge("left"), "::after").opacity)).toBe(1);
    expect(getComputedStyle(edge("left")).cursor).toBe("col-resize");
  });
});

describe("room", () => {
  it("in a narrow window, the panels give way so the canvas keeps its minimum", async () => {
    await page.viewport(800, 800);
    await render(<Workspace />);
    await frames();
    expect(width(canvas())).toBeGreaterThanOrEqual(CANVAS_MIN - 1);
    expect(width(cell("left"))).toBeGreaterThanOrEqual(PANEL_LIMITS.left.min);
    expect(width(cell("right"))).toBeGreaterThanOrEqual(PANEL_LIMITS.right.min);
    // Back in a wide window, they are their own widths again.
    await page.viewport(W, 800);
    await settled();
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default);
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default);
  });

  it("widens the inspector for a tab that needs room (the datasheet), as far as the canvas allows", async () => {
    const screen = await render(<Workspace wide />);
    await frames();
    expect(width(cell("right"))).toBe(600);
    await page.viewport(1000, 800);
    await settled();
    expect(width(canvas())).toBeGreaterThanOrEqual(CANVAS_MIN - 1);
    expect(width(cell("right"))).toBeGreaterThanOrEqual(PANEL_LIMITS.right.default);
    // Shut, it gives all of it to the canvas.
    await screen.getByRole("button", { name: "Hide inspector" }).click();
    await settled();
    expect(width(cell("right"))).toBe(0);
  });
});

describe("what is kept", () => {
  it("keeps the widths and which panels are shut between visits", async () => {
    const first = await render(<Workspace />);
    await drag("right", -80);
    toggle("left").click();
    await frames();
    expect(stored()).toEqual({ left: { width: PANEL_LIMITS.left.default, collapsed: true }, right: { width: PANEL_LIMITS.right.default + 80, collapsed: false } });
    await first.unmount();
    await render(<Workspace />);
    await settled();
    expect(width(cell("left"))).toBe(0);
    expect(width(cell("right"))).toBe(PANEL_LIMITS.right.default + 80);
  });

  it("starts from the defaults when what is kept doesn't read, and clamps widths out of range", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readLayout()).toEqual({ left: { width: 230, collapsed: false }, right: { width: 340, collapsed: false } });
    localStorage.setItem(KEY, JSON.stringify({ left: { width: 5, collapsed: "yes" }, right: { width: 99999 } }));
    expect(readLayout()).toEqual({ left: { width: PANEL_LIMITS.left.min, collapsed: false }, right: { width: PANEL_LIMITS.right.max, collapsed: false } });
    localStorage.setItem(KEY, JSON.stringify({ left: { width: "wide" }, right: null }));
    expect(readLayout()).toEqual({ left: { width: 230, collapsed: false }, right: { width: 340, collapsed: false } });
  });

  it("still works when the browser keeps nothing (storage off)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const screen = await render(<Workspace />);
    expect(width(cell("left"))).toBe(PANEL_LIMITS.left.default);
    await screen.getByRole("button", { name: "Hide sheets" }).click();
    await settled();
    expect(width(cell("left"))).toBe(0);
  });
});

describe("the layout's numbers", () => {
  it("clampWidth keeps a width within the panel's limits and the room given", () => {
    expect(clampWidth("left", 10)).toBe(PANEL_LIMITS.left.min);
    expect(clampWidth("left", 10000)).toBe(PANEL_LIMITS.left.max);
    expect(clampWidth("right", 500, 400)).toBe(400);
    expect(clampWidth("right", 300.4)).toBe(300);
  });

  it("panelWidths gives a shut panel nothing and leaves the canvas its minimum", () => {
    const open = { left: { width: 230, collapsed: false }, right: { width: 340, collapsed: false } };
    expect(panelWidths(open, 1280)).toEqual({ left: 230, right: 340 });
    expect(panelWidths({ ...open, left: { width: 230, collapsed: true } }, 1280)).toEqual({ left: 0, right: 340 });
    // Not measured yet: their own widths.
    expect(panelWidths(open, 0)).toEqual({ left: 230, right: 340 });
    // 800 wide: 230 + 340 + 320 is 90 too many; the inspector gives 80 (down to 260), the left panel 10.
    expect(panelWidths(open, 800)).toEqual({ left: 220, right: 260 });
  });

  it("panelWidths gives way in order: the tab's widening, the inspector, then the left panel", () => {
    const open = { left: { width: 300, collapsed: false }, right: { width: 340, collapsed: false } };
    // Widened to 600 in 1400: 300 + 600 + 320 = 1220, it fits.
    expect(panelWidths(open, 1400, 600)).toEqual({ left: 300, right: 600 });
    // In 1100 the widening gives 120 back.
    expect(panelWidths(open, 1100, 600)).toEqual({ left: 300, right: 480 });
    // In 800: the widening all goes, then the inspector to 260, then the left panel 20.
    expect(panelWidths(open, 800, 600)).toEqual({ left: 220, right: 260 });
    // Too narrow for both at their narrowest: they stop there (the canvas takes what is left).
    expect(panelWidths(open, 500)).toEqual({ left: PANEL_LIMITS.left.min, right: PANEL_LIMITS.right.min });
    expect(layoutColumns({ left: 230, right: 0 })).toBe("230px minmax(0, 1fr) 0px");
  });
});
