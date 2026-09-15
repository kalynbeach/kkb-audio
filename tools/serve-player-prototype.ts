// Isolated #21 design surface: deliberately does not import any audio/proof asset handler.
import prototype from "../web/player-prototype.html";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4199),
  routes: {
    "/": prototype,
    "/player-prototype.html": prototype,
    "/prototype-assets/signal.jpg": () => new Response(Bun.file(new URL("../docs/2026-09-13-wave-player-design-assets/phosphor-signal.jpg", import.meta.url))),
  },
  fetch: () => new Response("Not found", { status: 404 }),
  development: { hmr: true, console: true },
});
console.log(`Wave Player prototype (no audio): ${server.url}`);
