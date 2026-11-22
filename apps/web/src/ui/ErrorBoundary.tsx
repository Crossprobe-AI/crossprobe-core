/**
 * Keeps an error in one part of the app to that part. Since React 18 an error thrown while
 * rendering unmounts the whole root, which would leave an empty page; a boundary shows a
 * short message in place of what failed instead, and reports the error (errors.ts).
 *
 * Three looks, by what failed:
 * - "page": the whole editor, the last resort around <App />: a message and Reload.
 * - "panel": a part of the screen (an inspector tab, the 3D view): a message in its place,
 *   with Try again and Reload.
 * - "notice": something without a place of its own (an extension, the dialogs): a small
 *   notice in the corner, with Try again (or what `resetLabel` says) and Reload.
 *
 * Try again renders the part again (after `onReset`, e.g. closing the dialogs that failed).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../errors";

export interface ErrorBoundaryProps {
  /** Where this boundary is, in reports ("inspector", "extension:<id>", …). */
  where: string;
  look?: "page" | "panel" | "notice";
  /** What failed, in the message ("This panel", "The 3D view", …). */
  what?: string;
  /** A panel that is hidden (another tab is shown) shows nothing, failed or not. */
  hidden?: boolean;
  /** Before rendering again, e.g. close what failed. */
  onReset?(): void;
  resetLabel?: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(error, { where: this.props.where, componentStack: info.componentStack ?? undefined });
  }

  private reset = () => {
    this.props.onReset?.();
    this.setState({ failed: false });
  };

  render() {
    const { look = "panel", what, hidden, resetLabel = "Try again", children } = this.props;
    if (!this.state.failed) return children;
    if (hidden) return null;
    const reload = (
      <button className={look === "page" ? "primary" : undefined} onClick={() => location.reload()}>
        Reload
      </button>
    );
    if (look === "page")
      return (
        <main className="error-page" role="alert">
          <h1>Something went wrong</h1>
          <p className="muted">The editor stopped working. Your unsaved changes are kept in this browser: reload the page to carry on.</p>
          {reload}
        </main>
      );
    return (
      <div className={look === "notice" ? "error-fallback error-notice" : "error-fallback"} role="alert">
        <p>{what ?? (look === "notice" ? "A part of the app" : "This panel")} stopped working.</p>
        <div className="error-fallback-actions">
          <button onClick={this.reset}>{resetLabel}</button>
          {reload}
        </div>
      </div>
    );
  }
}
