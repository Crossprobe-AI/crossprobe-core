/**
 * The extensions this build includes (see api.ts), and helpers for the app.
 */
import { extensions } from "@crossprobe/extensions";
import type { Assistant, Extension, InspectorTab } from "./api";

export type * from "./api";
export { Fill, Slot, SlotProvider } from "./slots";

export const installed: readonly Extension[] = extensions;

/** The inspector tabs extensions add, in order. */
export const extensionTabs: InspectorTab[] = installed.flatMap((e) => e.inspectorTabs ?? []);

/** The assistant, when an extension provides one. */
export const assistant: Assistant | undefined = installed.find((e) => e.assistant)?.assistant;

/** Run every extension's boot step (before the app first renders). */
export async function bootExtensions(): Promise<void> {
  for (const e of installed) await e.boot?.();
}

/** Fetch a datasheet link: through an extension when one offers it, else directly (only sites that allow it). */
export function fetchDatasheet(url: string): Promise<Response> {
  const via = installed.find((e) => e.fetchDatasheet);
  return via ? via.fetchDatasheet!(url) : fetch(url);
}
