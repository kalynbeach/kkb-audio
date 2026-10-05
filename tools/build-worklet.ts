import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const EXPECTED_RUST = "rustc 1.98.0";
const EXPECTED_BUN = "1.4.0";
const EXPECTED_BINDGEN = "wasm-bindgen 0.2.127";
const WASM_TARGET = "wasm32-unknown-unknown";
const generatedDirectory = "web/src/generated";
const outputDirectory = "public/audio-runtime";

assertVersion(["rustc", "--version"], EXPECTED_RUST);
assertVersion(["bun", "--version"], EXPECTED_BUN, true);
assertVersion(["wasm-bindgen", "--version"], EXPECTED_BINDGEN);

run(["cargo", "build", "--lib", "--release", "--target", WASM_TARGET]);
rmSync(generatedDirectory, { force: true, recursive: true });
rmSync(outputDirectory, { force: true, recursive: true });
mkdirSync(generatedDirectory, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });

const rawWasm = join("target", WASM_TARGET, "release", "kkb_audio.wasm");
run([
  "wasm-bindgen",
  rawWasm,
  "--target",
  "web",
  "--out-dir",
  generatedDirectory,
  "--out-name",
  "kkb_audio",
]);
removeWorkletUnsafeErrorFormatting(join(generatedDirectory, "kkb_audio.js"));

await build("web/src/worklet-processor.ts");
await build("web/src/pcm-worker.ts");
await build("web/src/waveform-worker.ts");
await build("web/src/plan-processor.ts");
await build("web/src/plan-worker.ts");
await build("web/src/lab-worker.ts");
copyFileSync(
  "node_modules/inter-ui/LICENSE.txt",
  join(outputDirectory, "Inter-LICENSE.txt"),
);
for (const name of ["DepartureMono-LICENSE.txt", "Phosphor-LICENSE.txt"]) {
  copyFileSync(join("web/assets/player-prototype", name), join(outputDirectory, name));
}
copyFileSync("THIRD_PARTY_NOTICES.md", join(outputDirectory, "THIRD_PARTY_NOTICES.md"));
copyFileSync("licenses/MPL-2.0.txt", join(outputDirectory, "MPL-2.0.txt"));
copyFileSync(
  join(generatedDirectory, "kkb_audio_bg.wasm"),
  join(outputDirectory, "kkb_audio_bg.wasm"),
);

function removeWorkletUnsafeErrorFormatting(path: string): void {
  const generated = readFileSync(path, "utf8");
  const throwWithString = "throw new Error(getStringFromWasm0(arg0, arg1));";
  const decoderInitialization =
    "let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });\ncachedTextDecoder.decode();";
  const deprecatedSyncWarning =
    "console.warn('using deprecated parameters for `initSync()`; pass a single object instead')";
  if (
    !generated.includes(throwWithString) ||
    !generated.includes(decoderInitialization) ||
    !generated.includes(deprecatedSyncWarning)
  ) {
    throw new Error(
      "wasm-bindgen worklet glue changed; audit the pinned output",
    );
  }
  // AudioWorkletGlobalScope does not expose TextDecoder consistently. Error
  // strings are not part of the callback contract, so traps use a fixed code
  // and the adapter's catch path produces silence without formatting.
  writeFileSync(
    path,
    generated
      .replace(throwWithString, "throw 42;")
      .replace(decoderInitialization, "let cachedTextDecoder;")
      .replace(deprecatedSyncWarning, "throw 42;"),
  );
}

async function build(entrypoint: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    minify: false,
    outdir: outputDirectory,
    sourcemap: "none",
    target: "browser",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

function assertVersion(
  command: string[],
  expected: string,
  exact = false,
): void {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
  const actual = result.stdout.toString().trim();
  const matches = exact ? actual === expected : actual.startsWith(expected);
  if (!matches) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
