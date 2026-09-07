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
if (!source.includes('type: "admission-result"') || !source.includes("transportPort.postMessage")) {
  throw new Error("worklet must return direct transferable ownership with an admission result outside process()");
}

const callbackBodies = [
  ["processor.process", "process(_inputs, outputs"],
  ["WorkletKernel.render", "render(frame_count)"],
  ["PreparedPlanarAdapter.process", "process(outputs)"],
  ["PreparedPlanarAdapter.#fail", "#fail(outputs, code)"],
  ["wasmRenderFailure", "function wasmRenderFailure(status)"],
  ["fillSilence", "function fillSilence(outputs)"],
] as const;
const callbackForbidden = [
  "new ", "Float32Array", "Array.from", ".map(", ".filter(", ".reduce(",
  "postMessage", "Promise", "setTimeout", "setInterval", "queueMicrotask",
];
const callbackFindings: string[] = [];
for (const [name, marker] of callbackBodies) {
  const body = extractBody(source, marker);
  for (const pattern of callbackForbidden) {
    if (body.includes(pattern)) callbackFindings.push(`${name}:${pattern}`);
  }
  if (/=\s*\[/.test(body) || /=\s*\{/.test(body) || /return\s*\[/.test(body)) {
    callbackFindings.push(`${name}:collection literal`);
  }
}
if (callbackFindings.length !== 0) {
  throw new Error(`callback-local construction found: ${callbackFindings.join(", ")}`);
}

console.log(
  JSON.stringify({
    bytes: Buffer.byteLength(source),
    forbiddenPatterns: found,
    processorRegistrations: registrations,
    synchronousInstantiation: true,
    auditedCallbackBodies: callbackBodies.map(([name]) => name),
    callbackForbiddenPatterns: callbackFindings,
  }),
);

function extractBody(builtSource: string, marker: string): string {
  const start = builtSource.indexOf(marker);
  if (start < 0) throw new Error(`could not locate callback-reachable body: ${marker}`);
  const openingBrace = builtSource.indexOf("{", start);
  if (openingBrace < 0) throw new Error(`could not locate opening brace: ${marker}`);
  let depth = 0;
  for (let index = openingBrace; index < builtSource.length; index += 1) {
    if (builtSource[index] === "{") depth += 1;
    if (builtSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return builtSource.slice(openingBrace, index + 1);
    }
  }
  throw new Error(`unterminated callback-reachable body: ${marker}`);
}
