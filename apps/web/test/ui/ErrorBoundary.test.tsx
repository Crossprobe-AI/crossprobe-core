/**
 * Errors kept to the part that failed (ui/ErrorBoundary.tsx) and passed on to extensions
 * (errors.ts): the fallbacks, the rest of the app staying usable, Try again, one report per
 * error with where it happened, and browser noise left out.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import "../../src/styles.css";
import { addErrorListener, installErrorListeners, isBenignError, MAX_REPORTS, reportError, resetReportedErrors, type ErrorContext } from "../../src/errors";
import { Fill, Slot, SlotProvider } from "../../src/extensions/slots";
import { CopyField } from "../../src/ui/CopyField";
import { ErrorBoundary } from "../../src/ui/ErrorBoundary";

function Thrower({ message = "panel broke" }: { message?: string }): never {
  throw new Error(message);
}

let reports: Array<{ error: unknown; context: ErrorContext }>;
let stop: () => void;
beforeEach(() => {
  resetReportedErrors();
  reports = [];
  stop = addErrorListener((error, context) => reports.push({ error, context }));
  // React logs each caught error; the tests look at what the boundary does instead.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  stop();
  vi.restoreAllMocks();
  await cleanup();
});

describe("ErrorBoundary", () => {
  it("shows a message in place of a failed inspector tab, and the rest stays usable", async () => {
    const clicked = vi.fn();
    const screen = await render(
      <aside className="inspector" style={{ width: 360 }}>
        <ErrorBoundary where="inspector-tab:parts-search" what="This tab">
          <Thrower />
        </ErrorBoundary>
        <button onClick={clicked}>Nets</button>
      </aside>,
    );
    await expect.element(screen.getByRole("alert")).toHaveTextContent("This tab stopped working.");
    await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    await screen.getByRole("button", { name: "Nets" }).click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("keeps a failing Fill to its extension: a notice in the corner, the slot's other content stays", async () => {
    function Extension() {
      return (
        <Fill slot="topbar">
          <Thrower message="fill broke" />
        </Fill>
      );
    }
    const screen = await render(
      <SlotProvider>
        <header className="topbar">
          <button>Open project</button>
          <Slot name="topbar" />
        </header>
        <ErrorBoundary where="extension:cloud" look="notice">
          <Extension />
        </ErrorBoundary>
      </SlotProvider>,
    );
    await expect.element(screen.getByRole("alert")).toHaveTextContent("A part of the app stopped working.");
    expect(getComputedStyle(document.querySelector(".error-notice")!).position).toBe("fixed");
    await expect.element(screen.getByRole("button", { name: "Open project" })).toBeVisible();
    expect(reports.map((r) => r.context.where)).toEqual(["extension:cloud"]);
  });

  it("reports the error once, with where it was caught and React's component stack", async () => {
    await render(
      <ErrorBoundary where="3d" what="The 3D view">
        <Thrower message="no WebGL" />
      </ErrorBoundary>,
    );
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect((reports[0]!.error as Error).message).toBe("no WebGL");
    expect(reports[0]!.context.where).toBe("3d");
    expect(reports[0]!.context.componentStack).toMatch(/Thrower/);
  });

  it("renders the part again on Try again, after onReset", async () => {
    function Flaky() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary where="dialogs" look="notice" what="A dialog" resetLabel="Close it" onReset={() => setBroken(false)}>
          {broken ? <Thrower message="dialog broke" /> : <p>Back to normal</p>}
        </ErrorBoundary>
      );
    }
    const screen = await render(<Flaky />);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("A dialog stopped working.");
    await screen.getByRole("button", { name: "Close it" }).click();
    await expect.element(screen.getByText("Back to normal")).toBeVisible();
    expect(document.querySelector(".error-fallback")).toBeNull();
  });

  it("shows nothing for a failed tab that is hidden behind another", async () => {
    await render(
      <ErrorBoundary where="inspector-tab:x" hidden>
        <Thrower />
      </ErrorBoundary>,
    );
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(document.querySelector(".error-fallback")).toBeNull();
  });

  it("the page look, as the last resort: a heading, what is kept, and Reload", async () => {
    const screen = await render(
      <ErrorBoundary where="app" look="page">
        <Thrower />
      </ErrorBoundary>,
    );
    await expect.element(screen.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await expect.element(screen.getByText(/unsaved changes are kept/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(screen.container.querySelector("button[class=primary]")).toBeTruthy();
  });
});

describe("error reports", () => {
  it("leave out the browser's noise", () => {
    expect(isBenignError(new Error("ResizeObserver loop completed with undelivered notifications."))).toBe(true);
    expect(isBenignError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isBenignError(new DOMException("The user aborted a request.", "AbortError"))).toBe(true);
    expect(isBenignError("Script error.")).toBe(true);
    expect(isBenignError(new Error("Cannot read properties of undefined"))).toBe(false);
    reportError(new Error("ResizeObserver loop completed with undelivered notifications."), { where: "window" });
    expect(reports).toEqual([]);
  });

  it("pass each error on once per page, and at most MAX_REPORTS in all", () => {
    const e = new Error("same");
    reportError(e, { where: "window" });
    reportError(e, { where: "promise" });
    expect(reports).toHaveLength(1);
    for (let i = 0; i < MAX_REPORTS + 5; i++) reportError(new Error(`error ${i}`), { where: "window" });
    expect(reports).toHaveLength(MAX_REPORTS);
  });

  it("come from window's error and unhandledrejection events", async () => {
    const target = new EventTarget() as unknown as Window;
    const uninstall = installErrorListeners(target);
    const thrown = new Error("outside React");
    target.dispatchEvent(new ErrorEvent("error", { error: thrown, message: thrown.message }));
    const reason = new Error("nobody caught me");
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }) as PromiseRejectionEvent);
    uninstall();
    expect(reports.map((r) => [r.error, r.context.where])).toEqual([
      [thrown, "window"],
      [reason, "promise"],
    ]);
  });

  it("a listener that throws doesn't stop the others", () => {
    const after = vi.fn();
    const a = addErrorListener(() => {
      throw new Error("listener broke");
    });
    const b = addErrorListener(after);
    reportError(new Error("x"), { where: "window" });
    a();
    b();
    expect(after).toHaveBeenCalledOnce();
  });
});

describe("CopyField, multiline, and ResizeObserver", () => {
  it("raises no ResizeObserver loop error when its width changes", async () => {
    const seen: string[] = [];
    const onError = (e: ErrorEvent) => seen.push(e.message);
    window.addEventListener("error", onError);
    const value = Array.from({ length: 8 }, (_, i) => `"line ${i}": "${"x".repeat(60)}"`).join("\n");
    await render(
      <div className="modal github" style={{ position: "static", width: 520 }}>
        <CopyField label="Config" value={value} multiline maxRows={40} />
      </div>,
    );
    const box = document.querySelector<HTMLElement>(".modal")!;
    for (const w of [300, 460, 340, 520]) {
      box.style.width = `${w}px`;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    window.removeEventListener("error", onError);
    expect(seen.filter((m) => /ResizeObserver/.test(m))).toEqual([]);
    const area = document.querySelector<HTMLTextAreaElement>(".copy-field textarea")!;
    expect(area.scrollHeight).toBeLessThanOrEqual(area.clientHeight + 1);
  });
});
