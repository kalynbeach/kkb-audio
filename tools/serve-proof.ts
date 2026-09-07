import { readFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 4173);
const root = "web/dist";
const files: Record<string, { path: string; type: string }> = {
  "/lab.html": { path: "lab.html", type: "text/html; charset=utf-8" },
  "/lab.css": { path: "lab.css", type: "text/css; charset=utf-8" },
  "/lab-main.js": { path: "lab-main.js", type: "text/javascript; charset=utf-8" },
  "/lab-worker.js": { path: "lab-worker.js", type: "text/javascript; charset=utf-8" },
  "/GeistVF.woff": { path: "GeistVF.woff", type: "font/woff" },
  "/Geist-LICENSE.txt": { path: "Geist-LICENSE.txt", type: "text/plain; charset=utf-8" },
  "/": { path: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { path: "index.html", type: "text/html; charset=utf-8" },
  "/main.js": { path: "main.js", type: "text/javascript; charset=utf-8" },
  "/plan.html": { path: "plan.html", type: "text/html; charset=utf-8" },
  "/plan-main.js": { path: "plan-main.js", type: "text/javascript; charset=utf-8" },
  "/plan-worker.js": { path: "plan-worker.js", type: "text/javascript; charset=utf-8" },
  "/plan-processor.js": { path: "plan-processor.js", type: "text/javascript; charset=utf-8" },
  "/pcm-worker.js": {
    path: "pcm-worker.js",
    type: "text/javascript; charset=utf-8",
  },
  "/worklet-processor.js": {
    path: "worklet-processor.js",
    type: "text/javascript; charset=utf-8",
  },
  "/kkb_audio_bg.wasm": { path: "kkb_audio_bg.wasm", type: "application/wasm" },
};

Bun.serve({
  fetch(request) {
    const entry = files[new URL(request.url).pathname];
    if (entry === undefined) {
      return new Response("not found", { status: 404 });
    }
    return readFile(join(root, entry.path)).then(
      (body) =>
        new Response(body, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": entry.type,
          },
        }),
      () => new Response("build output missing", { status: 500 }),
    );
  },
  port,
});

console.log(`proof server listening on http://127.0.0.1:${port}`);
