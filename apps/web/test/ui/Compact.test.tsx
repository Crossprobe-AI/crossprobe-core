/**
 * The editor on a phone (ui/Compact.tsx, the viewer): the views as tabs at the bottom, a tapped
 * part's sheet, the sheet picker, and in the shared viewport (ui/viewport.ts) the touch gestures:
 * two fingers pinch to zoom, a double tap fits, and lifting the fingers after a pinch is no tap.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import "../../src/styles.css";
import { CompactPartSheet, CompactSheetPicker, CompactTabs, type CompactMode } from "../../src/ui/Compact";
import { Icon } from "../../src/ui/icons";
import type { ComponentInfo } from "../../src/render/types";
import { useViewport } from "../../src/ui/viewport";

afterEach(async () => {
  await cleanup();
});

const part = (over: Partial<ComponentInfo> = {}): ComponentInfo =>
  ({
    reference: "U1",
    value: "RP2040",
    footprint: "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    datasheet: "https://example.com/rp2040.pdf",
    description: "A microcontroller",
    libId: "MCU_RaspberryPi:RP2040",
    sheets: ["/"],
    dnp: false,
    onBoard: true,
    ...over,
  }) as ComponentInfo;

describe("CompactTabs", () => {
  it("switches the view, and without a board offers only the schematic", async () => {
    function Tabs({ hasBoard }: { hasBoard: boolean }) {
      const [mode, setMode] = useState<CompactMode>("schematic");
      return <CompactTabs mode={mode} hasSchematic hasBoard={hasBoard} onMode={setMode} />;
    }
    const screen = await render(<Tabs hasBoard />);
    await screen.getByRole("button", { name: "Board" }).click();
    expect(screen.getByRole("button", { name: "Board" }).element().getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Schematic" }).element().getAttribute("aria-current")).toBeNull();
    await cleanup();

    const noBoard = await render(<Tabs hasBoard={false} />);
    expect((noBoard.getByRole("button", { name: "Board" }).element() as HTMLButtonElement).disabled).toBe(true);
    expect((noBoard.getByRole("button", { name: "3D" }).element() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CompactPartSheet", () => {
  it("shows what the part is, its datasheet, and the way to the other view", async () => {
    const onOther = vi.fn();
    const onClose = vi.fn();
    const screen = await render(<CompactPartSheet part={part()} sheetName={() => "Root"} other="board" onOther={onOther} onClose={onClose} />);
    const sheet = screen.getByRole("dialog", { name: "U1 RP2040" }).element();
    expect(sheet.textContent).toContain("U1 · RP2040");
    expect(sheet.textContent).toContain("A microcontroller");
    // The footprint without its library, which only takes room on a phone.
    expect(sheet.textContent).toContain("QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm");
    expect(sheet.textContent).not.toContain("Package_DFN_QFN:");
    expect(screen.getByRole("link", { name: "Datasheet ↗" }).element().getAttribute("href")).toBe("https://example.com/rp2040.pdf");
    await screen.getByRole("button", { name: "Show on board" }).click();
    expect(onOther).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves out a datasheet that is no link, and the other view when there is none", async () => {
    const screen = await render(<CompactPartSheet part={part({ datasheet: "~", dnp: true })} sheetName={() => "Root"} onOther={() => {}} onClose={() => {}} />);
    expect(document.querySelector(".compact-part a")).toBeNull();
    expect(document.querySelector(".compact-part-actions")).toBeNull();
    expect(screen.getByRole("dialog").element().textContent).toContain("No (DNP)");
  });
});

describe("CompactSheetPicker", () => {
  it("is a picker with more than one sheet, and the sheet's name with one", async () => {
    const onOpen = vi.fn();
    const sheets = [
      { path: "/", namePath: "/" },
      { path: "/a/", namePath: "/Power" },
    ];
    const screen = await render(<CompactSheetPicker sheets={sheets} current="/" onOpen={onOpen} />);
    await screen.getByRole("combobox", { name: "Sheet" }).selectOptions("/Power");
    expect(onOpen).toHaveBeenCalledWith("/a/");
    await cleanup();
    await render(<CompactSheetPicker sheets={sheets.slice(0, 1)} current="/" onOpen={onOpen} />);
    expect(document.querySelector(".compact-sheet")!.textContent).toBe("Root sheet");
    expect(document.querySelector(".compact-sheet select")).toBeNull();
  });
});

describe("the view's round buttons", () => {
  it("have their icon in the middle (the label is hidden)", async () => {
    await render(
      <div className="app compact">
        <div className="viewport" style={{ width: 400, height: 400 }}>
          <div className="view-tools">
            <button title="Fit">
              <Icon name="fit" /> Fit
            </button>
          </div>
        </div>
      </div>,
    );
    const b = document.querySelector(".view-tools button")!.getBoundingClientRect();
    const i = document.querySelector(".view-tools button svg")!.getBoundingClientRect();
    expect([b.width, b.height]).toEqual([44, 44]);
    expect(i.x + i.width / 2).toBeCloseTo(b.x + b.width / 2, 1);
    expect(i.y + i.height / 2).toBeCloseTo(b.y + b.height / 2, 1);
  });
});

describe("touch in the viewport", () => {
  /** A 400 × 400 view of a 100 × 100 mm box, as the schematic and board views use it. */
  let vp: ReturnType<typeof useViewport>;
  function View({ onTap }: { onTap?: () => void }) {
    vp = useViewport({ x: 0, y: 0, w: 100, h: 100 });
    return (
      <div
        ref={vp.ref}
        className="viewport"
        style={{ width: 400, height: 400 }}
        onPointerDown={vp.handlers.onPointerDown}
        onPointerMove={vp.handlers.onPointerMove}
        onPointerUp={() => {
          if (!vp.wasDrag()) onTap?.();
          vp.handlers.onPointerUp();
        }}
      />
    );
  }
  const touch = (type: string, id: number, x: number, y: number) => {
    const el = document.querySelector(".viewport")!;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0 }));
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("zooms with two fingers around their midpoint, and the lift after it is no tap", async () => {
    const onTap = vi.fn();
    await render(<View onTap={onTap} />);
    await settle();
    const fitted = vp.view.scale;
    touch("pointerdown", 1, 150, 200);
    touch("pointerdown", 2, 250, 200);
    // The fingers move apart to twice the distance, about the same midpoint.
    touch("pointermove", 1, 100, 200);
    touch("pointermove", 2, 300, 200);
    await settle();
    expect(vp.view.scale / fitted).toBeCloseTo(2, 5);
    // The point under the midpoint stays there.
    const mid = vp.toContent(200, 200);
    expect(mid.x).toBeCloseTo(50, 3);
    expect(mid.y).toBeCloseTo(50, 3);
    touch("pointerup", 1, 100, 200);
    touch("pointerup", 2, 300, 200);
    await settle();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("fits again on a double tap", async () => {
    await render(<View />);
    await settle();
    const fitted = vp.view.scale;
    touch("pointerdown", 1, 150, 200);
    touch("pointerdown", 2, 250, 200);
    touch("pointermove", 1, 50, 200);
    touch("pointermove", 2, 350, 200);
    touch("pointerup", 1, 50, 200);
    touch("pointerup", 2, 350, 200);
    await settle();
    expect(vp.view.scale).toBeGreaterThan(fitted * 2);
    for (let i = 0; i < 2; i++) {
      touch("pointerdown", 1, 120, 120);
      touch("pointerup", 1, 120, 120);
    }
    await settle();
    expect(vp.view.scale).toBeCloseTo(fitted, 5);
  });
});
