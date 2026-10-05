// A separate temporary build and loopback server; never writes public/audio-runtime.
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir, cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { wavFixture } from "./local-wav-fixture";

if (Bun.version !== "1.4.0") throw new Error("Use PATH=\"$PWD/node_modules/.bin:$PATH\" bun run measure:media");
const destination = resolve(Bun.argv[2] ?? "local-media-measurements.json");
const realPaths = Bun.argv.slice(3);
if (realPaths.length !== 0 && (realPaths.length !== 3 || realPaths[0] !== "--render")) {
  throw new Error("Optional rendering run requires --render PATH.wav PATH.mp3");
}
const rendering = realPaths.length > 0;
if (await Bun.file(destination).exists()) throw new Error(`Refusing to replace ${destination}`);
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "kkb-media-measure-"));
const run = (command: string[], cwd = temporary) => {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
};
// Reuse the production build including its worklet glue audit in an isolated copy.
for (const name of [".cargo", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "THIRD_PARTY_NOTICES.md", "licenses", "src", "web", "tools"]) {
  cpSync(join(root, name), join(temporary, name), {
    recursive: true,
    filter: path => path !== join(root, "public/audio-runtime") && path !== join(root, "web/src/generated"),
  });
}
symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
symlinkSync(join(root, "target"), join(temporary, "target"), "dir");
console.log(`Building measurement copy in ${temporary}`);
run([process.execPath, "tools/build-worklet.ts"]);
run([process.execPath, "tools/check-wasm-memory.ts", "public/audio-runtime/kkb_audio_bg.wasm"]);
const dist = join(temporary, "public/audio-runtime");
const build = await Bun.build({ entrypoints: [join(temporary, "tools/measure-local-media/browser.ts"), join(temporary, "tools/measure-local-media/worker-probe.ts")], outdir: dist, target: "browser" });
if (!build.success) throw new Error(build.logs.join("\n"));
const probe = await Bun.file(join(dist, "worker-probe.js")).text();
for (const name of ["pcm-worker.js", "waveform-worker.js"]) {
  const path = join(dist, name);
  await Bun.write(path, `(() => {\n${probe}\n})();\n${await Bun.file(path).text()}`);
}
const fixturesDirectory = join(temporary, "fixtures");
mkdirSync(fixturesDirectory);
const fixtures: { name: string; seconds: number | null; rate: number | null; channels: 1 | 2 | null; bits: number | null; bytes: number; sha256: string; rendering?: boolean }[] = [];
const generated = [
  ["wav", 10, 44100, 1, 16], ["wav", 180, 48000, 2, 24],
  ["cbr", 10, 44100, 1, 16], ["vbr", 10, 48000, 2, 16],
  ["cbr", 180, 48000, 2, 16], ["vbr", 180, 44100, 2, 16],
] as const;
for (const [format, seconds, rate, channels, bits] of rendering ? [] : generated) {
  const name = `${format}-${seconds}s-${rate}-${channels}.${format === "wav" ? "wav" : "mp3"}`;
  const source = join(fixturesDirectory, "source.wav");
  await Bun.write(source, wavFixture(bits, channels, rate, seconds * rate, true));
  const path = join(fixturesDirectory, name);
  if (format === "wav") cpSync(source, path);
  else run(["lame", "--silent", ...(format === "cbr" ? ["-b", "128"] : ["-V", "2"]), source, path]);
  const bytes = await Bun.file(path).arrayBuffer();
  fixtures.push({ name, seconds, rate, channels, bits: format === "wav" ? bits : null, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}
if (rendering) for (const [index, extension] of ["wav", "mp3"].entries()) {
  const file = Bun.file(realPaths[index + 1]!);
  if (!realPaths[index + 1]!.toLowerCase().endsWith(`.${extension}`) || file.size > 128 * 1024 * 1024) {
    throw new Error("Use one WAV then one MP3, each at most 128 MiB");
  }
  const bytes = await file.arrayBuffer();
  // Reports and loopback URLs use aliases, never private library paths or titles.
  const name = `real-${index + 1}.${extension}`;
  await Bun.write(join(fixturesDirectory, name), bytes);
  fixtures.push({ name, seconds: null, rate: null, channels: null, bits: null, bytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), rendering: true });
}
const provenance = { baseCommit: run(["git", "rev-parse", "HEAD"], root), sourceDiff: run(["git", "diff", "--", "src", "web"], root),
  bun: Bun.version, rust: run(["rustc", "--version"]), lame: run(["lame", "--version"]).split("\n")[0],
  os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, fixtures,
  wasmSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(join(dist, "kkb_audio_bg.wasm")).arrayBuffer()).digest("hex") };
const assets = new Set(["browser.js", "pcm-worker.js", "waveform-worker.js", "worklet-processor.js", "kkb_audio_bg.wasm"]);
let received = false;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1_000_000,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/result" && request.method === "POST") {
      if (received || request.headers.get("origin") !== server.url.origin) return new Response("Rejected", { status: 403 });
      received = true;
      const measurement: unknown = await request.json();
      await Bun.write(destination, JSON.stringify({ provenance, measurement }, null, 2) + "\n");
      const succeeded = typeof measurement === "object" && measurement !== null && "error" in measurement && measurement.error === null;
      console.log(`Saved ${destination}`);
      setTimeout(() => { server.stop(true); process.exit(succeeded ? 0 : 1); }, 1000);
      return new Response("Saved");
    }
    if (path === "/") return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Local media measurements</title><h1>Local media measurements</h1><p>${rendering ? "Two real files with muted rendering" : "Six generated files with paused audio"}, three repetitions each. This run takes a few minutes.</p><button>Run measurements</button><pre>Ready</pre><script type="module" src="/browser.js"></script></html>`, { headers: { "Content-Type": "text/html" } });
    if (path === "/fixtures.json") return Response.json(fixtures);
    const fixture = fixtures.find(item => path === `/fixtures/${item.name}`);
    if (fixture) return new Response(Bun.file(join(fixturesDirectory, fixture.name)));
    const asset = path.startsWith("/audio-runtime/") ? path.slice("/audio-runtime/".length) : path.slice(1);
    if (assets.has(asset)) return new Response(Bun.file(join(dist, asset)), { headers: { "Cache-Control": "no-store" } });
    return new Response("Not found", { status: 404 });
  },
});
const stop = () => { server.stop(true); process.exit(1); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setTimeout(stop, 10 * 60 * 1000);
console.log(`Open ${server.url} and click Run measurements. Server stops after saving, or after ten minutes. Temporary files: ${temporary}`);
