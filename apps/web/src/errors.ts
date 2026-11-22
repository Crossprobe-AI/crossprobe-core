/**
 * Errors the app didn't handle: from the error boundaries (ui/ErrorBoundary.tsx) and from
 * `window`'s `error` and `unhandledrejection` events. They go to the listeners added here,
 * which are the extensions' `onError` hooks (extensions/index.ts); the editor itself reports
 * nowhere.
 *
 * Before a listener hears of an error:
 * - benign noise is dropped: the browser's ResizeObserver loop messages, a request that was
 *   cancelled (`AbortError`), and a cross-origin "Script error." that carries nothing;
 * - each error (its message and stack) is passed on once per page, and at most MAX_REPORTS
 *   in all, so a loop that keeps failing doesn't flood anyone.
 */

export interface ErrorContext {
  /** Where it was caught: a boundary's name ("inspector", "extension:<id>", …), or "window" / "promise". */
  where: string;
  /** React's component stack, from a boundary. */
  componentStack?: string;
}

export type ErrorListener = (error: unknown, context: ErrorContext) => void;

/** The most errors passed on in one page. */
export const MAX_REPORTS = 20;

const listeners = new Set<ErrorListener>();
const seen = new Set<string>();

/** Hear of the app's unhandled errors; returns a function that stops it. */
export function addErrorListener(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const message = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? error));
const stack = (error: unknown) => (error instanceof Error ? (error.stack ?? "") : "");

/** Noise browsers raise that says nothing about the app. */
export function isBenignError(error: unknown): boolean {
  const text = message(error);
  if (/^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(text)) return true;
  if ((error as { name?: unknown })?.name === "AbortError") return true;
  // A script from another origin: the browser hides everything but this.
  if (text === "Script error." && !stack(error)) return true;
  return false;
}

/** Pass an unhandled error on to the listeners (once per page, benign noise left out). */
export function reportError(error: unknown, context: ErrorContext): void {
  if (isBenignError(error)) return;
  const key = `${message(error)}\n${stack(error)}`;
  if (seen.has(key) || seen.size >= MAX_REPORTS) return;
  seen.add(key);
  for (const listener of listeners) {
    try {
      listener(error, context);
    } catch {
      // A listener that fails is not reported again: that could loop.
    }
  }
}

/** Report what `window` sees: errors thrown outside React, and promises nobody caught. */
export function installErrorListeners(target: Window = window): () => void {
  const onError = (e: ErrorEvent) => reportError(e.error ?? e.message, { where: "window" });
  const onRejection = (e: PromiseRejectionEvent) => reportError(e.reason, { where: "promise" });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** For tests: forget what was passed on, so the same error is reported again. */
export function resetReportedErrors(): void {
  seen.clear();
}
