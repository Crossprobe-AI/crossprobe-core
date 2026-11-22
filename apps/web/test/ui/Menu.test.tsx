/** The top bar's dropdown (ui/Menu.tsx): opening, the ways it closes, focus, and its items. */
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../src/styles.css";
import { Fill, Slot, SlotProvider } from "../../src/extensions/slots";
import { Menu } from "../../src/ui/Menu";

const details = (label: string) => document.querySelector<HTMLDetailsElement>(`summary[aria-label="${label}"]`)!.parentElement as HTMLDetailsElement;

function Fixture({ onOpen, onA = () => {}, onB = () => {} }: { onOpen?: () => void; onA?: () => void; onB?: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: 8 }}>
      <input aria-label="Elsewhere" />
      <Menu label="File" summary="File" onOpen={onOpen}>
        <span className="menu-label">Open</span>
        <button onClick={onA}>Alpha</button>
        <button onClick={onB} disabled>
          <span>Beta</span>
        </button>
        <a href="#here">A link</a>
      </Menu>
      <Menu label="Other" summary="Other">
        <button>Gamma</button>
      </Menu>
      <button>After</button>
    </div>
  );
}

describe("Menu", () => {
  it("opens on a click on its button and calls onOpen", async () => {
    const onOpen = vi.fn();
    const screen = await render(<Fixture onOpen={onOpen} />);
    await screen.getByLabelText("File").click();
    expect(details("File").open).toBe(true);
    await expect.element(screen.getByRole("button", { name: "Alpha" })).toBeVisible();
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  it("closes again on a second click on its button", async () => {
    const screen = await render(<Fixture />);
    await screen.getByLabelText("File").click();
    await screen.getByLabelText("File").click();
    expect(details("File").open).toBe(false);
  });

  it("closes when an item is chosen, and runs the item", async () => {
    const onA = vi.fn();
    const screen = await render(<Fixture onA={onA} />);
    await screen.getByLabelText("File").click();
    await screen.getByRole("button", { name: "Alpha" }).click();
    expect(onA).toHaveBeenCalledOnce();
    expect(details("File").open).toBe(false);
  });

  it("closes when an item an extension filled in is chosen, and runs it", async () => {
    // An extension's items reach the menu through a portal (Fill into a Slot), as in the project menu.
    const store = vi.fn();
    function Extension() {
      return (
        <Fill slot="sync">
          <button onClick={store}>Store in your account…</button>
        </Fill>
      );
    }
    const screen = await render(
      <SlotProvider>
        <Menu summary="Project" label="Project">
          <button>Download</button>
          <Slot name="sync" />
        </Menu>
        <Extension />
      </SlotProvider>,
    );
    await screen.getByLabelText("Project").click();
    expect(details("Project").open).toBe(true);
    await screen.getByRole("button", { name: "Store in your account…" }).click();
    expect(store).toHaveBeenCalledOnce();
    expect(details("Project").open).toBe(false);
  });

  it("stays open on a click on a label or on a disabled item, which does nothing", async () => {
    const onB = vi.fn();
    const screen = await render(<Fixture onB={onB} />);
    await screen.getByLabelText("File").click();
    await screen.getByText("Open", { exact: true }).click();
    expect(details("File").open).toBe(true);
    await screen.getByText("Beta").click({ force: true });
    expect(onB).not.toHaveBeenCalled();
    expect(details("File").open).toBe(true);
  });

  it("closes on a click elsewhere", async () => {
    const screen = await render(<Fixture />);
    await screen.getByLabelText("File").click();
    await screen.getByLabelText("Elsewhere").click();
    expect(details("File").open).toBe(false);
  });

  it("closes on Escape and gives the focus back to its button", async () => {
    const screen = await render(<Fixture />);
    await screen.getByLabelText("File").click();
    await userEvent.keyboard("{Escape}");
    expect(details("File").open).toBe(false);
    expect(document.activeElement).toBe(details("File").querySelector("summary"));
  });

  it("leaves other menus closed: one menu is open at a time, with the mouse and with the keyboard", async () => {
    const screen = await render(<Fixture />);
    await screen.getByLabelText("File").click();
    await screen.getByLabelText("Other").click();
    expect(details("File").open).toBe(false);
    expect(details("Other").open).toBe(true);

    // Keyboard: open File with Enter, Tab across to Other and open it with Enter.
    await screen.getByLabelText("Other").click();
    (details("File").querySelector("summary") as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(details("File").open).toBe(true);
    (details("Other").querySelector("summary") as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(details("Other").open).toBe(true);
    expect(details("File").open).toBe(false);
  });

  it("closes when the focus leaves it with Tab", async () => {
    const screen = await render(<Fixture />);
    (details("Other").querySelector("summary") as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(details("Other").open).toBe(true);
    await userEvent.keyboard("{Tab}"); // to Gamma, inside
    expect(document.activeElement?.textContent).toBe("Gamma");
    expect(details("Other").open).toBe(true);
    await userEvent.keyboard("{Tab}"); // out of the menu
    expect(document.activeElement?.textContent).toBe("After");
    expect(details("Other").open).toBe(false);
  });

  it("shows disabled items as not clickable", async () => {
    const screen = await render(<Fixture />);
    await screen.getByLabelText("File").click();
    const beta = screen.getByRole("button", { name: "Beta" }).element();
    expect(getComputedStyle(beta).cursor).not.toBe("pointer");
  });

  it("gives the focus back to its button on Escape from an item", async () => {
    await render(<Fixture />);
    (details("Other").querySelector("summary") as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.textContent).toBe("Gamma");
    await userEvent.keyboard("{Escape}");
    expect(details("Other").open).toBe(false);
    expect(document.activeElement).toBe(details("Other").querySelector("summary"));
  });
});
