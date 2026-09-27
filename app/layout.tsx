import type { Metadata } from "next";
import { Navigation } from "./navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "KKB Audio", template: "%s · KKB Audio" },
  description: "Play local audio and explore the Rust/Wasm audio engine.",
  other: { "direction-contract": "THESIS: a task directory for listening and inspecting the engine. OWN-WORLD: existing warm neutral square controls, Inter and TX-02. STORY: open local audio, then inspect the engine when needed. FIRST VIEWPORT: shared navigation, prominent Wave Player entry, separated lab and developer routes. FORM: established KKB world, task menu, surface seed 7275cbc3. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    {/* Appearance is not saved, so first paint follows the system scheme until the control hydrates. */}
    <head><script dangerouslySetInnerHTML={{ __html: `document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)` }} /></head>
    <body>
    <a href="#content" className="site-skip">Skip to content</a>
    <Navigation />
    <div id="content" tabIndex={-1}>{children}</div>
    <footer className="site-footer"><span>KKB Audio</span><span>Local audio stays on your device.</span><a href="https://github.com/kalynbeach/kkb-audio">Source &amp; documentation</a></footer>
  </body></html>;
}
