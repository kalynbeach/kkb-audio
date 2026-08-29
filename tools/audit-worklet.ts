import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  throw new Error("usage: bun tools/audit-worklet.ts <worklet.js>");
}
const source = readFileSync(path, "utf8");
const forbidden = [
  "SharedArrayBuffer",
  "Atomics.",
  "new Worker",
  "AudioContext",
  "console.",
  "fetch(",
  "instantiateStreaming",
  "TextDecoder",
  "XMLHttpRequest",
  "WebSocket",
];
const found = forbidden.filter((pattern) => source.includes(pattern));
if (found.length !== 0) {
  throw new Error(`forbidden worklet glue found: ${found.join(", ")}`);
}

const registrations = source.match(/registerProcessor\(/g)?.length ?? 0;
if (registrations !== 1) {
  throw new Error(`expected one processor registration, found ${registrations}`);
}
if (!source.includes("initSync")) {
  throw new Error("worklet must synchronously instantiate Wasm");
}
if (!source.includes("memory.buffer")) {
  throw new Error("worklet must verify Wasm memory identity");
}

console.log(
  JSON.stringify({
    bytes: Buffer.byteLength(source),
    forbiddenPatterns: found,
    processorRegistrations: registrations,
    synchronousInstantiation: true,
  }),
);
