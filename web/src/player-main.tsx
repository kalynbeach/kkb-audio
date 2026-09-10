import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlayerApp } from "./player-app";

const container = document.getElementById("root");
if (!container) throw new Error("Missing player root");
const root: Root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(container))
  : createRoot(container);
root.render(<StrictMode><PlayerApp /></StrictMode>);
