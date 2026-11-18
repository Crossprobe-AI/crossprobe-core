/** Buttons in the top bar, through the project control (ui/ProjectMenu.tsx): Save, the menu and its items, keyboard and focus. */
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../src/styles.css";
import { ProjectMenu, type ProjectMenuProps } from "../../src/ui/ProjectMenu";

function props(over: Partial<ProjectMenuProps> = {}, count = 2, run = vi.fn()): ProjectMenuProps {
  return {
    open: true,
    save: { kind: "save", count, title: "Save the changed files", label: "Save to the folder", run },
    where: [],
    onOpenFolder: vi.fn(),
    onDownload: vi.fn(),
    ...over,
  };
}
const inTopbar = (p: ProjectMenuProps) => (
  <header className="topbar">
    <span className="spacer" />
    <ProjectMenu {...p} />
    <button>After</button>
  </header>
);
const saveButton = () => document.querySelector<HTMLButtonElement>(".project-control > button.save")!;
const menu = () => document.querySelector<HTMLDetailsElement>("details.project-menu")!;

describe("ProjectMenu", () => {
  it("Save shows how many files it saves and runs on a click", async () => {
    const run = vi.fn();
    await render(inTopbar(props({}, 3, run)));
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().classList.contains("dirty")).toBe(true);
    expect(saveButton().querySelector(".count")?.textContent).toBe("3");
    saveButton().click();
    expect(run).toHaveBeenCalledOnce();
  });

  it("Save is disabled, looks it, and does nothing with nothing to save", async () => {
    const run = vi.fn();
    const screen = await render(inTopbar(props({}, 0, run)));
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().querySelector(".count")).toBeNull();
    expect(getComputedStyle(saveButton()).cursor).toBe("default");
    expect(Number(getComputedStyle(saveButton()).opacity)).toBeLessThan(1);
    await screen.getByTitle("Save the changed files").first().click({ force: true });
    expect(run).not.toHaveBeenCalled();
    // In the menu too.
    await screen.getByLabelText("Project").click();
    const item = screen.getByRole("button", { name: /Save to the folder/ });
    await expect.element(item).toBeDisabled();
    expect(getComputedStyle(item.element()).cursor).toBe("default");
  });

  it("works from the keyboard: Enter and Space press Save, Enter opens the menu, an item runs and closes it", async () => {
    const run = vi.fn();
    const p = props({}, 1, run);
    await render(inTopbar(p));
    saveButton().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(run).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(menu().querySelector("summary"));
    await userEvent.keyboard("{Enter}");
    expect(menu().open).toBe(true);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.textContent).toMatch(/Open a folder/);
    await userEvent.keyboard("{Enter}");
    expect(p.onOpenFolder).toHaveBeenCalledOnce();
    expect(menu().open).toBe(false);
  });

  it("shows a focus ring on Save and on the menu's button when reached with Tab", async () => {
    await render(
      <>
        <button>Before</button>
        {inTopbar(props())}
      </>,
    );
    document.querySelector<HTMLButtonElement>("button")!.focus();
    for (const el of [saveButton(), menu().querySelector("summary")!]) {
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(el);
      const cs = getComputedStyle(el);
      expect(cs.outlineStyle, `${el.textContent}: outline`).not.toBe("none");
      expect(parseFloat(cs.outlineWidth)).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the menu's items inside the window when the control is at the right edge", async () => {
    const screen = await render(inTopbar(props()));
    await screen.getByLabelText("Project").click();
    const box = menu().querySelector(".menu-items")!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("with no project open, offers only opening, as the one primary button", async () => {
    const screen = await render(inTopbar(props({ open: false })));
    expect(saveButton()).toBeNull();
    await expect.element(screen.getByLabelText("Project")).toHaveTextContent("Open project");
    await screen.getByLabelText("Project").click();
    await expect.element(screen.getByRole("button", { name: /Open a folder/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Download the project/ }).query()).toBeNull();
  });
});
