import type { Metadata } from "next";
import CatalogClient from "./catalog-client";
import "../../web/wave-player.css";
import "./catalog.css";
export const metadata: Metadata = { title: "WaveCatalog", description: "Arrange local audio with stable identities and portable manifests." };
export default function CatalogPage() { return <><CatalogClient /><noscript>WaveCatalog requires JavaScript to read local files and verify their bytes.</noscript></>; }
