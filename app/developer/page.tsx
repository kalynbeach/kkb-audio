import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
export const metadata: Metadata = { title: "Developer proofs", description: "Explicit diagnostic pages for PCM transport, compiled plans, and the historical player design study." };
export default function DeveloperPage() { return <main className="developer-page"><h1>Developer proofs</h1><p className="developer-intro">Inspect preparation and failure paths directly. These pages expose engine diagnostics. For listening, use Wave Player.</p><div className="developer-list">
<Link className="route-entry" href="/developer/pcm"><h2>PCM transport <ArrowUpRight aria-hidden="true" /></h2><p>Prepare a bounded worklet stream, inject failures, or load a local WAV and exercise seek and starvation.</p></Link>
<Link className="route-entry" href="/developer/plan"><h2>Compiled plan <ArrowUpRight aria-hidden="true" /></h2><p>Compile an oscillator graph in a worker, activate a muted output observation, and reject an invalid plan.</p></Link>
<Link className="route-entry" href="/developer/classic-player"><h2>Classic player <ArrowUpRight aria-hidden="true" /></h2><p>The original Canvas2D time-domain scope with the same local file transport and library.</p></Link>
<Link className="route-entry" href="/developer/player-study"><h2>Player design study <ArrowUpRight aria-hidden="true" /></h2><p>The retained interaction prototype uses simulated tracks and time. It does not play audio.</p></Link>
</div></main>; }
