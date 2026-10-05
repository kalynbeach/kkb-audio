import type { Metadata } from "next";
import StudyClient from "./study-client";
import "../../../web/player-prototype.css";
export const metadata: Metadata = { title: "Player design study" };
export default function StudyPage() { return <><header className="study-banner"><h1>Player design study</h1><p>Historical interaction prototype. Tracks and time are simulated. No audio plays here.</p></header><StudyClient /></>; }
