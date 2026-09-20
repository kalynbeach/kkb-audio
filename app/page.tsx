import Link from "next/link";
import { ArrowUpRight, ArrowRight, Play, AudioLines } from "lucide-react";

export default function Overview() {
  return <main className="overview">
    <div className="overview-intro"><h1>Listen.<br />{" "}Look closer.</h1><p>A local audio player and a working view inside the engine that powers it.</p></div>
    <Link href="/player" className="player-entry">
      <div className="entry-copy"><h2>Wave Player</h2><p>Open your WAV and MP3 files. Explore the signal, seek through a track, and set an A/B loop.</p><span className="entry-action">Open player <ArrowRight size={19} aria-hidden="true" /></span></div>
      <div className="entry-instrument" aria-hidden="true"><AudioLines size={100} strokeWidth={0.8}/><div><span>Local files</span><Play size={24}/><span>WAV / MP3</span></div></div>
    </Link>
    <div className="overview-lower">
      <Link href="/lab" className="route-entry"><h2>Audio engine lab <ArrowUpRight aria-hidden="true" /></h2><p>Trace a signal through the graph. Inspect rendered samples and compare execution across block sizes.</p><span>Explore the lab <ArrowRight size={18} aria-hidden="true" /></span></Link>
      <Link href="/developer" className="route-entry"><h2>Developer proofs <ArrowUpRight aria-hidden="true" /></h2><p>Exercise worklet preparation, PCM transport, and compiled plans with explicit diagnostic controls.</p><span>Open developer tools <ArrowRight size={18} aria-hidden="true" /></span></Link>
    </div>
    <p className="overview-note">An experimental Rust/Wasm audio project by Kalyn Beach. Files stay in this browser session. Leaving the player stops playback.</p>
  </main>;
}
