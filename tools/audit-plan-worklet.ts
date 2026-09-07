import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: bun tools/audit-plan-worklet.ts <plan-processor.js>");
const source = readFileSync(path, "utf8");
const forbidden = [
  "SharedArrayBuffer", "Atomics.", "new Worker", "AudioContext", "console.", "fetch(",
  "instantiateStreaming", "TextDecoder", "XMLHttpRequest", "WebSocket", "compile_plan_proof",
  "MessageChannel", "new WorkletKernel", "acceptBlock",
];
const found = forbidden.filter((pattern) => source.includes(pattern));
if (found.length !== 0) throw new Error(`forbidden plan worklet glue: ${found.join(", ")}`);
const registrations = source.match(/registerProcessor\(/g)?.length ?? 0;
if (registrations !== 1 || !source.includes("initSync") || !source.includes("memory.buffer")) {
  throw new Error("plan worklet registration, synchronous preparation, or memory check missing");
}
const callbackBodies = [
  ["processor.process", "process(_inputs, outputs"],
  ["WorkletPlan.render", "render(frame_count)"],
  ["PreparedPlanAdapter.process", "process(outputs)"],
  ["PreparedPlanAdapter.#fail", "#fail(outputs, code)"],
  ["planSilence", "function planSilence(outputs)"],
] as const;
const callbackForbidden = [
  "new ", "Float32Array", "Array.from", ".map(", ".filter(", ".reduce(", "postMessage",
  "Promise", "setTimeout", "setInterval", "queueMicrotask", "take_observation", "observation_", "next_frame",
];
const findings: string[] = [];
for (const [name, marker] of callbackBodies) {
  const body = extractBody(marker, name === "WorkletPlan.render" ? source.indexOf("class WorkletPlan") : 0);
  for (const pattern of callbackForbidden) if (body.includes(pattern)) findings.push(`${name}:${pattern}`);
  if (/=\s*\[/.test(body) || /=\s*\{/.test(body) || /return\s*\[/.test(body)) findings.push(`${name}:collection literal`);
}
if (findings.length !== 0) throw new Error(`callback-local construction or observation: ${findings.join(", ")}`);
console.log(JSON.stringify({
  bytes: Buffer.byteLength(source), forbiddenPatterns: found, processorRegistrations: registrations,
  synchronousInstantiation: true, auditedCallbackBodies: callbackBodies.map(([name]) => name),
  callbackForbiddenPatterns: findings,
}));

function extractBody(marker: string, after: number): string {
  if (after < 0) throw new Error(`could not locate callback owner: ${marker}`);
  const start = source.indexOf(marker, after);
  if (start < 0) throw new Error(`could not locate callback body: ${marker}`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(opening, index + 1);
  }
  throw new Error(`unterminated callback body: ${marker}`);
}
