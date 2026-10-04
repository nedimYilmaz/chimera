import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import { App } from "./App";
import { bootstrapAppStore } from "./state/store";
import "./overlays"; // system-overlay card registrations (module-eval side effects)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

bootstrapAppStore();
