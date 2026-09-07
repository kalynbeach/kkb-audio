import lab from "../web/lab.html";
import { createProofAssetHandler } from "./proof-assets.ts";

const port = Number(process.env.PORT ?? 4197);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: { "/": lab, "/lab.html": lab },
  fetch: createProofAssetHandler(),
  development: { hmr: true, console: true },
});
console.log(`audio lab development server: http://127.0.0.1:${port}/lab.html`);
