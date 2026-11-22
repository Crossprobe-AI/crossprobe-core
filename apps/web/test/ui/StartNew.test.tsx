/**
 * The start screen's new-project card with the "start-new" slot (App.tsx, styles.css): empty, it
 * is as before; with an extension's content at the top, the new-project part below is compact
 * (a smaller heading, no description, the form right under it).
 */
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../../src/styles.css";
import { Fill, Slot, SlotProvider } from "../../src/extensions/slots";

/** The card as App.tsx renders it, with or without an extension filling the slot. */
function Card({ filled }: { filled: boolean }) {
  return (
    <SlotProvider>
      <div className="start-cards" style={{ width: 960 }}>
        <section className="pane start-card">
          <div className="start-new-before">
            <Slot name="start-new" />
          </div>
          <h2 className="start-new-title">Start a new project</h2>
          <p className="muted start-new-desc">An empty schematic and a two-layer board with KiCad's default rules.</p>
          <form className="new-project">
            <input aria-label="Project name" />
            <button className="primary">Create</button>
          </form>
        </section>
      </div>
      {filled && (
        <Fill slot="start-new">
          <div className="recent">
            <h2>Recent projects</h2>
          </div>
        </Fill>
      )}
    </SlotProvider>
  );
}

const q = (s: string) => document.querySelector<HTMLElement>(s)!;

describe("the new-project card's start-new slot", () => {
  it("empty: takes no room, and the card is as before", async () => {
    await render(<Card filled={false} />);
    expect(getComputedStyle(q(".start-new-before")).display).toBe("none");
    expect(getComputedStyle(q(".start-new-desc")).display).not.toBe("none");
    expect(getComputedStyle(q(".start-new-title")).fontSize).toBe("17px");
  });

  it("filled: shows the extension's content first, then a compact new-project part", async () => {
    const screen = await render(<Card filled />);
    await expect.element(screen.getByRole("heading", { name: "Recent projects" })).toBeVisible();
    const recent = q(".recent").getBoundingClientRect();
    const title = q(".start-new-title").getBoundingClientRect();
    expect(recent.bottom).toBeLessThanOrEqual(title.top);
    expect(getComputedStyle(q(".start-new-desc")).display).toBe("none");
    expect(parseFloat(getComputedStyle(q(".start-new-title")).fontSize)).toBeLessThan(17);
    // The form follows the heading, not pushed to the card's foot.
    expect(q(".new-project").getBoundingClientRect().top - title.bottom).toBeLessThan(24);
  });
});
