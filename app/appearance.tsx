"use client";
import { useEffect, useSyncExternalStore } from "react";
export type Appearance = "system" | "light" | "dark";
let appearance: Appearance = "system";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function setMode(value: Appearance) { appearance = value; for (const listener of listeners) listener(); }
const systemSubscribe = (listener: () => void) => { const query = matchMedia("(prefers-color-scheme: dark)"); query.addEventListener("change", listener); return () => query.removeEventListener("change", listener); };
export function useAppearance() {
  const mode = useSyncExternalStore(subscribe, () => appearance, () => "system" as const);
  const systemDark = useSyncExternalStore(systemSubscribe, () => matchMedia("(prefers-color-scheme: dark)").matches, () => false);
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  return { mode, dark, setMode };
}
export function AppearanceControl() {
  const {mode, setMode} = useAppearance();
  return <label className="appearance-control">Appearance<select aria-label="Appearance" value={mode} onChange={event => {const value = event.target.value; if(value === "system" || value === "light" || value === "dark") setMode(value);}}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}
