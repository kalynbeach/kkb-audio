import { LabSession } from "./generated/kkb_audio.js";
import {
  decodeOperations,
  eventWords,
  TOTAL_FRAMES,
  type LabConfig,
} from "./lab-model.ts";

export function renderLab(config: LabConfig, partition: number) {
  if (!Number.isInteger(partition) || partition < 1 || partition > 1024)
    throw new Error("Invalid render partition");
  const session = new LabSession(
    Float64Array.from([
      config.frequencyA,
      config.frequencyB,
      config.gainA,
      config.gainB,
    ]),
    eventWords(config.events),
  );
  try {
    const operations = decodeOperations(session.description());
    const traces = operations.map(() => new Float32Array(TOTAL_FRAMES));
    let observation: number[] = [];
    for (let frame = 0; frame < TOTAL_FRAMES; frame += partition) {
      const size = Math.min(partition, TOTAL_FRAMES - frame);
      const block = session.render(size);
      if (block.length !== size * operations.length)
        throw new Error("Offline engine render failed");
      for (let slot = 0; slot < traces.length; slot++)
        traces[slot].set(block.subarray(slot * size, (slot + 1) * size), frame);
      const latest = session.observation();
      if (latest.length) observation = Array.from(latest);
    }
    return { operations, traces, observation };
  } finally {
    session.free();
  }
}
