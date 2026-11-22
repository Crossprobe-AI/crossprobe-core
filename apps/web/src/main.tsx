import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootExtensions } from "./extensions";
import { installErrorListeners } from "./errors";
import { keepChangesNow } from "./persist";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

// Errors nothing caught go to the extensions' onError (errors.ts), from here on.
installErrorListeners();
// A tab that is hidden may be closed next: store the unsaved changes now, not after the
// writer's short delay (persist.ts).
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void keepChangesNow());
addEventListener("pagehide", () => void keepChangesNow());
// Extensions' start-up (e.g. finishing a sign-in redirect) before the app reads the URL.
await bootExtensions();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The last resort: a message and Reload, not an empty page. */}
    <ErrorBoundary where="app" look="page">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
