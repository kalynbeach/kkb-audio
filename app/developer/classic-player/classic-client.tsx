"use client";
import dynamic from "next/dynamic";
const Classic = dynamic(() => import("../../../web/src/player-app").then(module => module.PlayerApp), { ssr: false, loading: () => <p className="route-loading" role="status">Loading classic player…</p> });
export default function ClassicClient() { return <Classic />; }
