"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppearanceControl } from "../web/src/appearance";

const links = [["/", "Overview"], ["/player", "Wave Player"], ["/lab", "Lab"], ["/developer", "Developer"]] as const;
export function Navigation() {
  const path = usePathname();
  return <header className="site-header">
    <Link href="/" className="site-wordmark" aria-label="KKB Audio home">KKB<span>Audio</span></Link>
    <nav aria-label="Main navigation">{links.map(([href, label]) => <Link key={href} href={href} aria-current={(href === "/" ? path === "/" : path.startsWith(href)) ? "page" : undefined}>{label}</Link>)}</nav>
    <AppearanceControl />
  </header>;
}
