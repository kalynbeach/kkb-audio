"use client";
import dynamic from "next/dynamic";
const Player = dynamic(() => import("../../web/src/wave-player-app").then(module => module.WavePlayerApp), { ssr: false, loading: () => <p className="route-loading" role="status">Loading Wave Player…</p> });
export default function PlayerClient() { return <Player />; }
