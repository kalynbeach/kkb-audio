"use client";
import dynamic from "next/dynamic";
const Study = dynamic(() => import("../../../web/src/player-prototype").then(module => module.PlayerPrototype), { ssr: false, loading: () => <p className="route-loading" role="status">Loading simulated player study…</p> });
export default function StudyClient() { return <Study />; }
