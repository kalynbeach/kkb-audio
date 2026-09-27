// Installs the pinned prebuilt wasm-bindgen CLI for Vercel builds. Vercel runs
// the install and build commands as separate processes, so the binary goes in
// node_modules/.bin, which `bun run` puts on PATH for `build:worklet`. The
// version must match the assertion in tools/build-worklet.ts.
const VERSION = "0.2.127";
const TARGET = "x86_64-unknown-linux-musl";
const name = `wasm-bindgen-${VERSION}-${TARGET}`;
const baseUrl = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${VERSION}`;
const binDirectory = "node_modules/.bin";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `prebuilt ${TARGET} wasm-bindgen only runs on linux x64; install it with cargo locally`,
  );
}

const archive = await download(`${baseUrl}/${name}.tar.gz`);
const published = new TextDecoder()
  .decode(await download(`${baseUrl}/${name}.tar.gz.sha256sum`))
  .split(/\s+/)[0];
const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
if (actual !== published) {
  throw new Error(`${name}.tar.gz sha256 ${actual} does not match published ${published}`);
}

const extract = Bun.spawnSync(
  [
    "tar",
    "-xzf",
    "-",
    "-C",
    binDirectory,
    "--strip-components=1",
    `${name}/wasm-bindgen`,
  ],
  { stdin: archive, stderr: "inherit", stdout: "inherit" },
);
if (extract.exitCode !== 0) {
  process.exit(extract.exitCode);
}
console.log(`installed ${name} to ${binDirectory}`);

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export {};
