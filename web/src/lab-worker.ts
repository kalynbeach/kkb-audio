import init from "./generated/kkb_audio.js";
import { TOTAL_FRAMES, type LabRequest, type LabResult } from "./lab-model.ts";

import { renderLab } from "./lab-render.ts";

const ready = init({
  module_or_path: new URL("./kkb_audio_bg.wasm", import.meta.url),
});

self.onmessage = async (message: MessageEvent<LabRequest>) => {
  const { request, config, compare } = message.data;
  try {
    await ready;
    const start = performance.now();
    const data = renderLab(config, config.partition);
    let comparison: number | null = null;
    if (compare) {
      const reference = renderLab(config, config.partition === 128 ? 257 : 128);
      comparison = 0;
      for (let slot = 0; slot < data.traces.length; slot++)
        for (let i = 0; i < TOTAL_FRAMES; i++) {
          comparison = Math.max(
            comparison,
            Math.abs(data.traces[slot][i] - reference.traces[slot][i]),
          );
        }
    }
    const result: LabResult = {
      request,
      ...data,
      partition: config.partition,
      renderMs: performance.now() - start,
      comparison,
    };
    self.postMessage(
      { type: "rendered", result },
      { transfer: data.traces.map((trace) => trace.buffer) },
    );
  } catch (error) {
    self.postMessage({
      type: "failed",
      request,
      message:
        error instanceof Error
          ? error.message
          : "The engine rejected these settings. Reset the experiment to try again.",
    });
  }
};
