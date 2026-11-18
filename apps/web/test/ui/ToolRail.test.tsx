/**
 * The editors' tool rail (ui/ToolRail.tsx): tools and groups, the flyouts, the keyboard,
 * the view-only state, and the contract scripts rely on (every tool a button with its
 * title and a `.tl` label, flyouts included).
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../src/styles.css";
import { ToolRail, type RailItem } from "../../src/ui/ToolRail";

type T = "select" | "wire" | "label" | "glabel" | "hlabel" | "text" | "rect";
const ITEMS: RailItem<T>[] = [
  { id: "select", label: "Select", keys: "Esc", icon: "select" },
  "|",
  { id: "wire", label: "Wire", keys: "W", icon: "wire" },
  { group: "Labels", tools: [{ id: "label", label: "Label", keys: "L", icon: "label" }, { id: "glabel", label: "Global label", keys: "Ctrl+L", icon: "glabel" }, { id: "hlabel", label: "Hier. label", keys: "H", icon: "hlabel" }] },
  "|",
  { group: "Graphics", tools: [{ id: "text", label: "Text", keys: "T", icon: "text" }, { id: "rect", label: "Rectangle", icon: "drawRect", title: "Rectangle: drag its corners" }] },
];

/** As in the app: the rail on a canvas, with the editor's tool and edit mode. */
function Fixture({ initialEditing = true, onChoose, onEdit }: { initialEditing?: boolean; onChoose?: (t: T) => void; onEdit?: () => void }) {
  const [tool, setTool] = useState<T>("select");
  const [editing, setEditing] = useState(initialEditing);
  return (
    <main className="canvas" style={{ position: "relative", width: 900, height: 600 }}>
      <ToolRail<T>
        items={ITEMS}
        active={tool}
        editing={editing}
        onChoose={(t) => {
          setTool(t);
          onChoose?.(t);
        }}
        onEdit={() => {
          setEditing(true);
          onEdit?.();
        }}
        label="Schematic tools"
      />
      <p>
        Tool: {tool}, {editing ? "editing" : "viewing"}
      </p>
      <button>Elsewhere</button>
    </main>
  );
}

const rail = () => document.querySelector<HTMLElement>(".tool-rail")!;
const railButtons = () => [...rail().querySelectorAll<HTMLButtonElement>(":scope > .rail-item > .rail-tool")];
const group = (g: string) => document.querySelector<HTMLElement>(`.rail-group[data-group="${g}"]`)!;
const flyout = (g: string) => group(g).querySelector<HTMLElement>(".rail-flyout")!;
const box = (el: Element) => el.getBoundingClientRect();

describe("ToolRail", () => {
  it("is a vertical toolbar of icon buttons, one per tool or group, with rules between groups", async () => {
    const screen = await render(<Fixture />);
    await expect.element(screen.getByRole("toolbar", { name: "Schematic tools" })).toHaveAttribute("aria-orientation", "vertical");
    expect(railButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["Select", "Wire", "Label", "Text"]);
    expect(rail().querySelectorAll(".rail-sep")).toHaveLength(2);
    // Square buttons in one column.
    const xs = new Set(railButtons().map((b) => Math.round(box(b).left)));
    expect(xs.size).toBe(1);
    for (const b of railButtons()) expect([box(b).width, box(b).height]).toEqual([30, 30]);
    // Tooltips name the tool and its key.
    expect(railButtons()[1]!.title).toBe("Wire (W)");
  });

  it("keeps every tool in the page as a button with its title and label, flyouts included", async () => {
    await render(<Fixture />);
    const all = [...rail().querySelectorAll<HTMLButtonElement>("button[data-tool]")];
    for (const id of ["select", "wire", "label", "glabel", "hlabel", "text", "rect"]) expect(all.some((b) => b.dataset.tool === id), id).toBe(true);
    const glabel = all.find((b) => b.querySelector(".tl")?.textContent === "Global label")!;
    expect(glabel.title).toBe("Global label (Ctrl+L)");
    // A script's click on a hidden flyout's tool still chooses it.
    glabel.click();
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: glabel");
  });

  it("chooses a tool with a click and marks it pressed", async () => {
    const onChoose = vi.fn();
    const screen = await render(<Fixture onChoose={onChoose} />);
    await screen.getByRole("button", { name: "Wire" }).click();
    expect(onChoose).toHaveBeenCalledWith("wire");
    await expect.element(screen.getByRole("button", { name: "Wire" })).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "false");
    expect(getComputedStyle(railButtons()[1]!).backgroundColor).not.toBe(getComputedStyle(railButtons()[0]!).backgroundColor);
  });

  it("opens a group's flyout beside its button from the corner mark, and closes it on a choice", async () => {
    const screen = await render(<Fixture />);
    group("Labels").querySelector<HTMLElement>(".rail-open")!.click();
    await expect.element(screen.getByRole("menu", { name: "Labels" })).toBeVisible();
    const b = box(group("Labels").querySelector(".rail-tool")!);
    const f = box(flyout("Labels"));
    expect(f.left).toBeGreaterThan(b.right);
    expect(Math.abs(f.top - b.top)).toBeLessThan(10);
    expect(f.right).toBeLessThanOrEqual(window.innerWidth);
    await screen.getByRole("menuitemradio", { name: /Global label/ }).click();
    expect(flyout("Labels").hidden).toBe(true);
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: glabel");
  });

  it("shows the group's tool in use on its button, and remembers the last one chosen", async () => {
    const screen = await render(<Fixture />);
    group("Labels").querySelector<HTMLElement>(".rail-open")!.click();
    await screen.getByRole("menuitemradio", { name: /Hier\. label/ }).click();
    expect(railButtons()[2]!.getAttribute("aria-label")).toBe("Hier. label");
    expect(railButtons()[2]!.getAttribute("aria-pressed")).toBe("true");
    // Another tool: the group keeps showing the last one, and a click uses it again.
    await screen.getByRole("button", { name: "Wire" }).click();
    expect(railButtons()[2]!.getAttribute("aria-label")).toBe("Hier. label");
    expect(group("Labels").classList.contains("in-use")).toBe(false);
    await screen.getByRole("button", { name: "Hier. label" }).click();
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: hlabel");
  });

  it("opens a flyout with a right-click, and closes it on a click elsewhere", async () => {
    const screen = await render(<Fixture />);
    await screen.getByRole("button", { name: "Text" }).click({ button: "right" });
    await expect.element(screen.getByRole("menu", { name: "Graphics" })).toBeVisible();
    await screen.getByRole("button", { name: "Elsewhere" }).click();
    expect(flyout("Graphics").hidden).toBe(true);
  });

  it("works from the keyboard: Up and Down along the rail, ArrowRight into a flyout, Escape back", async () => {
    await render(<Fixture />);
    railButtons()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(railButtons()[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(railButtons()[2]);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(railButtons()[3]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(railButtons()[2]);
    await userEvent.keyboard("{ArrowRight}");
    expect(flyout("Labels").hidden).toBe(false);
    expect(flyout("Labels").contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toMatch(/Global label/);
    await userEvent.keyboard("{Escape}");
    expect(flyout("Labels").hidden).toBe(true);
    expect(document.activeElement).toBe(railButtons()[2]);
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: glabel");
  });

  it("ArrowLeft in a flyout goes back to its button", async () => {
    await render(<Fixture />);
    railButtons()[3]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowLeft}");
    expect(flyout("Graphics").hidden).toBe(true);
    expect(document.activeElement).toBe(railButtons()[3]);
  });
});

describe("ToolRail with an editor around it", () => {
  it("keeps its arrow keys to itself: the editor's window listener (nudging the selection) never sees them", async () => {
    const seen: string[] = [];
    const nudge = (e: KeyboardEvent) => e.key.startsWith("Arrow") && seen.push(e.key);
    window.addEventListener("keydown", nudge);
    try {
      await render(<Fixture />);
      railButtons()[0]!.focus();
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
      railButtons()[2]!.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(flyout("Labels").hidden).toBe(false);
      await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowRight}{ArrowLeft}");
      railButtons()[1]!.focus();
      await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", nudge);
    }
  });

  it("is one Tab stop, on the tool in use (a roving tabindex)", async () => {
    const screen = await render(<Fixture />);
    const stops = () => railButtons().filter((b) => b.tabIndex === 0);
    expect(stops()).toEqual([railButtons()[0]]);
    await screen.getByRole("button", { name: "Wire" }).click();
    expect(stops()).toEqual([railButtons()[1]]);
    // A tool in a group: the group's button.
    document.querySelector<HTMLButtonElement>('button[data-tool="hlabel"]')!.click();
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: hlabel");
    expect(stops()).toEqual([railButtons()[2]]);
    // Tab goes past the rail in one step.
    railButtons()[2]!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.closest(".tool-rail")).toBeNull();
  });

  it("lines a flyout's items up at the left, keys at the right", async () => {
    await render(<Fixture />);
    group("Graphics").querySelector<HTMLElement>(".rail-open")!.click();
    await vi.waitFor(() => expect(flyout("Graphics").hidden).toBe(false));
    const items = [...flyout("Graphics").querySelectorAll<HTMLButtonElement>("button")];
    const lefts = items.map((b) => Math.round(box(b.querySelector(".icon")!).left - box(b).left));
    expect(new Set(lefts).size, `icon offsets ${lefts.join(", ")}`).toBe(1);
    expect(lefts[0], `icon offsets ${lefts.join(", ")}`).toBeLessThan(12);
  });

  it("is clear of the board's properties panel, which shows beside it", async () => {
    await render(
      <main className="canvas" style={{ position: "relative", width: 900, height: 600 }}>
        <ToolRail<T> items={ITEMS} active="select" editing onChoose={() => {}} onEdit={() => {}} />
        <div className="board-props">Properties</div>
      </main>,
    );
    const r = box(rail());
    const p = box(document.querySelector(".board-props")!);
    expect(p.left).toBeGreaterThanOrEqual(r.right);
  });
});

describe("ToolRail while viewing", () => {
  it("says the design is view only, and dims the tools", async () => {
    const screen = await render(<Fixture initialEditing={false} />);
    await expect.element(screen.getByRole("button", { name: /View only/ })).toBeVisible();
    for (const b of railButtons()) {
      // (A button under the mouse, left there by an earlier test, shows at full strength on hover.)
      if (!b.matches(":hover")) expect(Number(getComputedStyle(b).opacity), b.getAttribute("aria-label")!).toBeLessThan(1);
      expect(b.getAttribute("aria-pressed")).toBe("false");
      expect(b.title).toMatch(/turns editing on \(E\)$/);
    }
  });

  it("turns editing on and picks the tool when one is clicked", async () => {
    const onEdit = vi.fn();
    const onChoose = vi.fn();
    const screen = await render(<Fixture initialEditing={false} onEdit={onEdit} onChoose={onChoose} />);
    await screen.getByRole("button", { name: "Wire" }).click();
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith("wire");
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: wire, editing");
    expect(rail().classList.contains("viewing")).toBe(false);
    expect(screen.getByRole("button", { name: /View only/ }).query()).toBeNull();
  });

  it("turns editing on from the View only label", async () => {
    const screen = await render(<Fixture initialEditing={false} />);
    await screen.getByRole("button", { name: /View only/ }).click();
    await expect.element(document.querySelector("p")!).toHaveTextContent("editing");
    // Still the select tool: nothing was picked for the user.
    await expect.element(document.querySelector("p")!).toHaveTextContent("Tool: select");
  });
});
