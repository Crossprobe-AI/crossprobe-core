/** The inspector's tab bar (ui/OverflowTabs.tsx): what fits, the "⋯" menu, the selected tab and the keyboard. */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../src/styles.css";
import { OverflowTabs, type TabItem } from "../../src/ui/OverflowTabs";

type Id = "parts" | "nets" | "issues" | "review" | "datasheet";
const ITEMS: TabItem<Id>[] = [
  { id: "parts", label: <>Parts <span className="count">12</span></>, menuLabel: "Parts", title: "Components" },
  { id: "nets", label: <>Nets <span className="count">40</span></>, menuLabel: "Nets", title: "Nets" },
  { id: "issues", label: <>Issues <span className="count">3</span></>, menuLabel: "Issues", title: "Issues", attention: true },
  { id: "review", label: "Review", menuLabel: "Review", title: "Review" },
  { id: "datasheet", label: <>Datasheet with a long label</>, menuLabel: "Datasheet", title: "Datasheet" },
];

/** As in the inspector: an <aside class="inspector"> of a given width, the tabs at the top. */
function Fixture({ width, initial = "parts", onSelect }: { width: number; initial?: Id; onSelect?: (id: Id) => void }) {
  const [tab, setTab] = useState<Id>(initial);
  return (
    <>
      <aside className="inspector" style={{ width }}>
        <OverflowTabs<Id>
          items={ITEMS}
          active={tab}
          onSelect={(id) => {
            setTab(id);
            onSelect?.(id);
          }}
        />
        <p>Showing {tab}</p>
      </aside>
      <button>Elsewhere</button>
    </>
  );
}

const bar = () => document.querySelector<HTMLElement>(".tabs")!;
const shownTabs = () => [...bar().querySelectorAll<HTMLButtonElement>(":scope > [role=tab]")];
const shownIds = () => shownTabs().map((b) => b.title);
const moreButton = () => bar().querySelector<HTMLButtonElement>(".tabs-more > button.more");
/** Nothing in the bar is cut off or pushed past its edge. */
function expectNoOverflow() {
  const box = bar().getBoundingClientRect();
  for (const el of [...shownTabs(), moreButton()].filter(Boolean) as HTMLElement[]) {
    const r = el.getBoundingClientRect();
    expect(r.right, `${el.title || el.textContent} ends at ${r.right}, the bar at ${box.right}`).toBeLessThanOrEqual(box.right + 0.5);
  }
  expect(bar().scrollWidth).toBeLessThanOrEqual(bar().clientWidth);
}

describe("OverflowTabs", () => {
  it("shows every tab, and no ⋯, when they fit", async () => {
    await render(<Fixture width={900} />);
    await vi.waitFor(() => expect(shownTabs()).toHaveLength(5));
    expect(moreButton()).toBeNull();
    expectNoOverflow();
  });

  it("puts the tabs that don't fit under ⋯, from the end", async () => {
    await render(<Fixture width={280} />);
    await vi.waitFor(() => expect(moreButton()).not.toBeNull());
    expect(shownIds()[0]).toBe("Components");
    expect(shownTabs().length).toBeLessThan(5);
    expectNoOverflow();
  });

  it("never lets a tab or the ⋯ button stick out of the bar, at any width", async () => {
    const screen = await render(<Fixture width={600} />);
    for (let w = 140; w <= 640; w += 20) {
      await screen.rerender(<Fixture width={w} />);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      expectNoOverflow();
    }
  });

  it("keeps the selected tab visible, even when it is long, without overflowing", async () => {
    await render(<Fixture width={300} initial="datasheet" />);
    await vi.waitFor(() => expect(shownIds()).toContain("Datasheet"));
    expect(shownTabs().find((b) => b.title === "Datasheet")!.getAttribute("aria-selected")).toBe("true");
    expectNoOverflow();
  });

  it("chooses a hidden tab from the ⋯ menu, closes the menu and shows the tab", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Fixture width={280} onSelect={onSelect} />);
    await vi.waitFor(() => expect(moreButton()).not.toBeNull());
    await screen.getByRole("button", { name: /more tabs/ }).click();
    expect(moreButton()!.getAttribute("aria-expanded")).toBe("true");
    await screen.getByRole("menuitem", { name: "Review" }).click();
    expect(onSelect).toHaveBeenCalledWith("review");
    await expect.element(screen.getByText("Showing review")).toBeVisible();
    expect(document.querySelector(".tabs-menu")).toBeNull();
    await vi.waitFor(() => expect(shownIds()).toContain("Review"));
    // The keyboard carries on from the chosen tab, not from the page.
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.title).toBe("Review"));
    expectNoOverflow();
  });

  it("closes the ⋯ menu on a click elsewhere", async () => {
    const screen = await render(<Fixture width={280} />);
    await vi.waitFor(() => expect(moreButton()).not.toBeNull());
    await screen.getByRole("button", { name: /more tabs/ }).click();
    await screen.getByRole("button", { name: "Elsewhere" }).click();
    expect(document.querySelector(".tabs-menu")).toBeNull();
  });

  it("opens the ⋯ menu from the keyboard with the focus on its first item; Escape closes it and gives the focus back", async () => {
    await render(<Fixture width={280} />);
    await vi.waitFor(() => expect(moreButton()).not.toBeNull());
    moreButton()!.focus();
    await userEvent.keyboard("{Enter}");
    const items = [...document.querySelectorAll<HTMLElement>(".tabs-menu [role=menuitem]")];
    expect(items.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1] ?? items[0]);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".tabs-menu")).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("marks ⋯ when a hidden tab needs attention", async () => {
    await render(<Fixture width={200} />);
    await vi.waitFor(() => expect(moreButton()).not.toBeNull());
    expect(shownIds()).not.toContain("Issues");
    expect(moreButton()!.classList.contains("attention")).toBe(true);
  });

  it("moves between tabs with the arrow keys, as a tab list does", async () => {
    const screen = await render(<Fixture width={900} />);
    await vi.waitFor(() => expect(shownTabs()).toHaveLength(5));
    shownTabs()[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByText("Showing nets")).toBeVisible();
    expect(document.activeElement).toBe(shownTabs()[1]);
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(screen.getByText("Showing parts")).toBeVisible();
    // Only the selected tab is in the Tab order; the arrows move within the bar.
    expect(shownTabs().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });
});
