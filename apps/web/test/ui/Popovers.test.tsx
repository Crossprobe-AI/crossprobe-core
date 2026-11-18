/**
 * What floats over the canvas shares one base (styles.css, the --surface-*, --z-* and
 * --bar-* tokens): menus, flyouts, the canvas's panels and pickers look the same, open
 * from the toolbar at the same place, stack in a fixed order (a menu over a panel), and a
 * button whose menu or panel is open looks the same whichever it is.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { Menu } from "../../src/ui/Menu";
import { OverflowTabs } from "../../src/ui/OverflowTabs";
import { ToolRail } from "../../src/ui/ToolRail";

const box = (el: Element) => el.getBoundingClientRect();
const frame = (el: Element) => {
  const cs = getComputedStyle(el);
  return { radius: cs.borderTopLeftRadius, border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, shadow: cs.boxShadow, background: cs.backgroundColor };
};

/** The canvas as the editors lay it out: the toolbar with a panel button and the Tools menu, and the panel it opens. */
function Canvas() {
  const [find, setFind] = useState(false);
  return (
    <main className="canvas" style={{ position: "relative", width: 1000, height: 640 }}>
      <div className="edit-toolbar">
        <button className="on">Editing</button>
        <button aria-haspopup="dialog" aria-expanded={find} onClick={() => setFind((v) => !v)}>
          Find
        </button>
        <Menu className="tools-menu" label="Tools" summary="Tools">
          <button>Number new parts</button>
          <button>Page settings…</button>
        </Menu>
      </div>
      {find && (
        <div className="update-pcb find-panel">
          <div className="update-body">
            <label className="prop">
              <span>Find</span>
              <input aria-label="Find text" />
            </label>
          </div>
        </div>
      )}
    </main>
  );
}

describe("floating surfaces", () => {
  it("open the panel and the menu at the same place: under the toolbar, flush with its right edge", async () => {
    const screen = await render(<Canvas />);
    await screen.getByRole("button", { name: "Find" }).click();
    await screen.getByLabelText("Tools").click();
    const bar = box(document.querySelector(".edit-toolbar")!);
    const panel = box(document.querySelector(".find-panel")!);
    const menu = box(document.querySelector(".tools-menu .menu-items")!);
    expect(panel.top).toBe(menu.top);
    expect(panel.right).toBe(menu.right);
    expect(panel.right).toBe(bar.right);
    expect(panel.top - bar.bottom).toBe(4);
  });

  it("stack a menu over an open panel", async () => {
    const screen = await render(<Canvas />);
    await screen.getByRole("button", { name: "Find" }).click();
    await screen.getByLabelText("Tools").click();
    const item = screen.getByRole("button", { name: "Number new parts" }).element();
    const r = box(item);
    expect(document.elementFromPoint(r.left + 10, r.top + r.height / 2)?.closest(".menu-items")).not.toBeNull();
  });

  it("all have one frame: menus, the inspector's ⋯ menu, rail flyouts, panels, pickers", async () => {
    await render(
      <div style={{ position: "relative", width: 1000, height: 700 }}>
        <div className="menu-items" style={{ position: "static" }}>
          <button>Item</button>
        </div>
        <div className="tabs-menu" style={{ position: "static" }}>
          <button>Item</button>
        </div>
        <div className="rail-flyout" style={{ position: "static" }}>
          <button>Item</button>
        </div>
        <div className="update-pcb" style={{ position: "static" }}>Panel</div>
        <div className="board-props" style={{ position: "static" }}>Properties</div>
        <div className="part-picker" style={{ position: "static", transform: "none" }}>Picker</div>
      </div>,
    );
    const frames = [".menu-items", ".tabs-menu", ".rail-flyout", ".update-pcb", ".board-props", ".part-picker"].map((s) => ({ s, f: frame(document.querySelector(s)!) }));
    for (const { s, f } of frames) expect(f, s).toEqual(frames[0]!.f);
  });

  it("give the toolbars the same border and corners as what opens from them", async () => {
    await render(
      <main className="canvas" style={{ position: "relative", width: 900, height: 500 }}>
        <div className="edit-toolbar">
          <button>Edit</button>
        </div>
        <ToolRail items={[{ id: "select", label: "Select", icon: "select" }]} active="select" editing onChoose={() => {}} onEdit={() => {}} />
        <div className="menu-items" style={{ position: "static" }}>
          <button>Item</button>
        </div>
      </main>,
    );
    const menu = frame(document.querySelector(".menu-items")!);
    for (const s of [".edit-toolbar", ".tool-rail"]) {
      const f = frame(document.querySelector(s)!);
      expect([f.radius, f.border], s).toEqual([menu.radius, menu.border]);
    }
  });
});

describe("a toolbar menu's items", () => {
  it("keep their words on a narrow screen, where the toolbar's own buttons show only icons", async () => {
    await page.viewport(1200, 800);
    const screen = await render(
      <main className="canvas" style={{ position: "relative", width: 800, height: 500 }}>
        <div className="edit-toolbar">
          <button>
            <span className="tl">Find</span>
          </button>
          <Menu className="tools-menu" label="Tools" summary="Tools">
            <button>
              <span className="tl">Update PCB</span>
            </button>
          </Menu>
        </div>
      </main>,
    );
    expect(getComputedStyle(document.querySelector(".edit-toolbar > button .tl")!).display).toBe("none");
    await screen.getByLabelText("Tools").click();
    expect(box(document.querySelector(".menu-items .tl")!).width).toBeGreaterThan(0);
    await page.viewport(1280, 800);
  });
});

describe("a button whose menu or panel is open", () => {
  it("looks the same for a panel, a menu, the inspector's ⋯ and a rail flyout; a mode that is on looks different", async () => {
    const screen = await render(
      <>
        <Canvas />
        <aside className="inspector" style={{ width: 220 }}>
          <OverflowTabs
            items={["a", "b", "c", "d", "e"].map((id) => ({ id, label: `Tab ${id} with a long name`, menuLabel: id, title: id }))}
            active="a"
            onSelect={() => {}}
          />
        </aside>
        <ToolRail items={[{ group: "Labels", tools: [{ id: "label", label: "Label", icon: "label" }, { id: "glabel", label: "Global label", icon: "glabel" }] }]} active="select" editing onChoose={() => {}} onEdit={() => {}} />
      </>,
    );
    await screen.getByRole("button", { name: "Find" }).click();
    const findBg = getComputedStyle(screen.getByRole("button", { name: "Find" }).element()).backgroundColor;
    document.querySelector<HTMLElement>(".tools-menu summary")!.click();
    const toolsBg = getComputedStyle(document.querySelector(".tools-menu summary")!).backgroundColor;
    document.querySelector<HTMLButtonElement>(".tabs-more > button.more")!.click();
    await expect.element(screen.getByRole("menu")).toBeVisible();
    const moreBg = getComputedStyle(document.querySelector(".tabs-more > button.more")!).backgroundColor;
    document.querySelector<HTMLButtonElement>(".rail-group .rail-tool")!.focus();
    await userEvent.keyboard("{ArrowRight}");
    const groupBg = getComputedStyle(document.querySelector(".rail-group .rail-tool")!).backgroundColor;
    expect([toolsBg, moreBg, groupBg]).toEqual([findBg, findBg, findBg]);
    // Editing (a mode) is the dark fill, not the tint.
    expect(getComputedStyle(screen.getByRole("button", { name: "Editing" }).element()).backgroundColor).not.toBe(findBg);
  });
});

describe("a field's focus ring", () => {
  it("sits inside the field, so a panel that scrolls doesn't cut it off", async () => {
    const screen = await render(<Canvas />);
    await screen.getByRole("button", { name: "Find" }).click();
    const input = screen.getByLabelText("Find text");
    input.element().focus();
    await userEvent.keyboard("a");
    const cs = getComputedStyle(input.element());
    expect(cs.outlineStyle).toBe("solid");
    expect(parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth)).toBeLessThanOrEqual(parseFloat(cs.borderTopWidth) + 1);
  });
});
