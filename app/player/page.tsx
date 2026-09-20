import type { Metadata } from "next";
import PlayerClient from "./player-client";
import "../../web/wave-player.css";
export const metadata: Metadata = { title: "Wave Player", description: "Play local WAV and MP3 files with source waveforms, A/B loops, and a live signal view." };
export default function PlayerPage() { return <div className="player-route"><PlayerClient /><noscript>Wave Player requires JavaScript to open local audio.</noscript></div>; }
