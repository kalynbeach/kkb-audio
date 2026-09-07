import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Only serve files emitted into the build directory, including Bun's hashed lab assets. */
export function createProofAssetHandler() {
  const root = "web/dist";
  const files = new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => file.name),
  );
  return (request: Request) => {
    const pathname = new URL(request.url).pathname;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!files.has(name)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(root, name)), {
      headers: { "Cache-Control": "no-store" },
    });
  };
}
