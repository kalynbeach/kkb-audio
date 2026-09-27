import type { Metadata } from "next";
import LabClient from "./lab-client";
import "../../web/lab.css";
export const metadata: Metadata = { title: "Audio engine lab", description: "Inspect a compiled signal graph, rendered samples, timed events, and partition comparisons." };
export default function LabPage() { return <><LabClient /><noscript>The engine lab requires JavaScript and WebAssembly.</noscript></>; }
