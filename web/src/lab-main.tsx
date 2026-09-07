import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LabApp } from "./lab-app.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("Missing lab root");
// Reuse the React root across Bun development updates.
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(
  <StrictMode>
    <LabApp />
  </StrictMode>,
);
