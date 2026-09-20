"use client";
import dynamic from "next/dynamic";
const Catalog = dynamic(() => import("../../web/src/catalog-app").then(module => module.CatalogApp), { ssr: false, loading: () => <p className="route-loading" role="status">Loading WaveCatalog…</p> });
export default function CatalogClient() { return <Catalog />; }
