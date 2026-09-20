import type { Metadata } from "next";
import Link from "next/link";
import PlanControls from "./controls";
export const metadata: Metadata = { title: "Compiled-plan proof" };
export default function PlanPage() { return <main className="developer-page"><Link className="text-link" href="/developer">Developer proofs</Link><h1>Compiled plan</h1><p className="developer-intro">Two oscillators, separate gains, mixing, sample-timed gain automation, and bounded output observation. Preparation compiles in a worker and validates in the worklet.</p><p className="developer-intro">Activation measures muted output. Leaving this page closes the proof.</p><PlanControls /></main>; }
