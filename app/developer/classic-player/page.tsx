import type { Metadata } from "next";
import ClassicClient from "./classic-client";
import "../../../web/player.css";
export const metadata: Metadata = { title: "Classic player proof" };
export default function ClassicPage() { return <div className="player-route"><header className="study-banner"><h1>Classic player proof</h1><p>The original Canvas2D time-domain visual, using the same local playback engine.</p></header><ClassicClient /></div>; }
