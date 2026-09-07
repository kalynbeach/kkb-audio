import { createProofAssetHandler } from "./proof-assets.ts";

const port = Number(process.env.PORT ?? 4173);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createProofAssetHandler(),
});
console.log(`proof server listening on http://127.0.0.1:${port}`);
