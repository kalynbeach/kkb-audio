import type { Metadata } from "next";
import Link from "next/link";
import PcmControls from "./controls";
export const metadata: Metadata = { title: "PCM transport proof" };
export default function PcmPage() { return <main className="developer-page"><Link className="text-link" href="/developer">Developer proofs</Link><h1>PCM transport</h1><p className="developer-intro">The node stays disconnected and the context stays suspended until preparation reports ready. Leaving this page closes the proof.</p><PcmControls /></main>; }
