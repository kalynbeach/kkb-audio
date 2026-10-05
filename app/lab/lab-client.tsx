"use client";
import dynamic from "next/dynamic";
const Lab = dynamic(() => import("../../web/src/lab-app").then(module => module.LabApp), { ssr: false, loading: () => <p className="route-loading" role="status">Loading audio engine lab…</p> });
export default function LabClient() { return <Lab />; }
