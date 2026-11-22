/**
 * Slots and fills: the app leaves named places in its layout (a `<Slot>`), and
 * an extension's Root renders into them (a `<Fill>`), with its own state, as if
 * its elements were written there. A slot takes no room of its own
 * (display: contents), so a fill lays out like the app's own children.
 *
 * Slots: "toolbar" (the editor's buttons in the top bar), "topbar" (the right
 * end of the top bar), "open" (the project menu's Open items), "sync" (its
 * Keep in sync items), "start-open" (the start screen's Open buttons), and "start"
 * (cards of their own on the start screen, after Open and before the examples; give
 * each the classes `pane start-card`).
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SlotName = "toolbar" | "topbar" | "open" | "sync" | "start-open" | "start";

interface Slots {
  targets: Partial<Record<SlotName, HTMLElement>>;
  register(name: SlotName, el: HTMLElement | null): void;
}

const SlotContext = createContext<Slots>({ targets: {}, register: () => undefined });

export function SlotProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<Slots["targets"]>({});
  const register = useCallback((name: SlotName, el: HTMLElement | null) => {
    setTargets((t) => (t[name] === (el ?? undefined) ? t : { ...t, [name]: el ?? undefined }));
  }, []);
  return <SlotContext.Provider value={{ targets, register }}>{children}</SlotContext.Provider>;
}

/** A place an extension can render into. */
export function Slot({ name }: { name: SlotName }) {
  const { register } = useContext(SlotContext);
  // A stable ref: called when the slot mounts and unmounts, not on every render.
  const ref = useCallback((el: HTMLElement | null) => register(name, el), [name, register]);
  return <span style={{ display: "contents" }} ref={ref} />;
}

/** Render children into a slot (nothing while the slot is not on screen). */
export function Fill({ slot, children }: { slot: SlotName; children: ReactNode }) {
  const target = useContext(SlotContext).targets[slot];
  return target ? createPortal(children, target) : null;
}
