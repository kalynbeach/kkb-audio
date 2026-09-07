import { compile_plan_proof, initSync } from "./generated/kkb_audio.js";

// This worker compiles once. It has no audio transport or render-loop duties.
self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    if (typeof event.data !== "object" || event.data === null) throw new Error("invalid compilation request");
    const request = event.data as { module?: unknown; sampleRate?: unknown; channelCount?: unknown };
    if (!(request.module instanceof WebAssembly.Module) || typeof request.sampleRate !== "number" ||
      (request.channelCount !== 1 && request.channelCount !== 2)) throw new Error("invalid compilation options");
    initSync({ module: request.module });
    const description = compile_plan_proof(request.sampleRate, request.channelCount);
    if (description.length === 0) throw new Error("fixture compilation failed");
    self.postMessage({ type: "compiled", description }, { transfer: [description.buffer] });
  } catch {
    self.postMessage({ type: "compile-failed" });
  }
};
