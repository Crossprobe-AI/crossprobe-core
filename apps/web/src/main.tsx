import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootExtensions } from "./extensions";
import "./styles.css";

// Extensions' start-up (e.g. finishing a sign-in redirect) before the app reads the URL.
await bootExtensions();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
