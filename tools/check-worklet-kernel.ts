import { WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { RenderStatus } from "../web/src/render-adapter";

const wasmBytes = await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer();
const module = await WebAssembly.compile(wasmBytes);
const exports = initSync({ module });
const maximumFrames = 64;
const slotFrames = 4;
const kernel = new WorkletKernel(1, 48_000, 3n, 1n, maximumFrames, slotFrames);
try {
  if (kernel.preparation_status() !== RenderStatus.Rendered || kernel.slot_count() !== 4) {
    throw new Error("worklet PCM kernel preparation failed");
  }
  for (let slotId = 0; slotId < 2; slotId += 1) {
    if (!kernel.reserve_slot(slotId)) throw new Error("slot reservation failed");
    const destination = new Float32Array(exports.memory.buffer, kernel.slot_left_ptr(slotId), slotFrames);
    for (let frame = 0; frame < slotFrames; frame += 1) {
      destination[frame] = (((slotId * slotFrames + frame) & 1_023) - 512) / 16_384;
    }
    if (kernel.admit(slotId, 1n, BigInt(slotId * slotFrames), slotFrames, slotId === 0, false) !== RenderStatus.Rendered) {
      throw new Error("slot admission failed");
    }
    if (kernel.reserve_slot(slotId)) throw new Error("duplicate ownership transition accepted");
  }

  const output = new Float32Array(8);
  let outputOffset = 0;
  for (const frames of [3, 5]) {
    if (kernel.render(frames) !== RenderStatus.Rendered) throw new Error("partition render failed");
    output.set(new Float32Array(exports.memory.buffer, kernel.left_ptr(), frames), outputOffset);
    outputOffset += frames;
  }
  for (let frame = 0; frame < output.length; frame += 1) {
    const expected = ((frame & 1_023) - 512) / 16_384;
    if (output[frame] !== expected) throw new Error(`PCM mismatch at ${frame}`);
  }

  if (!kernel.reserve_slot(2)) throw new Error("stale slot reservation failed");
  new Float32Array(exports.memory.buffer, kernel.slot_left_ptr(2), slotFrames).fill(1);
  kernel.admit(2, 0n, 8n, slotFrames, false, false);
  if (kernel.render(1) !== RenderStatus.Rendered) throw new Error("stale render failed");
  const staleOutput = new Float32Array(exports.memory.buffer, kernel.left_ptr(), 1);
  if (!Object.is(staleOutput[0], 0) || kernel.stale_count() !== 1n || kernel.starvation_count() !== 1n) {
    throw new Error("stale rejection/starvation counters failed");
  }

  const terminalKernel = new WorkletKernel(1, 48_000, 3n, 1n, maximumFrames, slotFrames);
  try {
    const capacityStatus = terminalKernel.render(maximumFrames + 1);
    const zeroFrameStatus = terminalKernel.render(0);
    const terminalStatus = terminalKernel.render(1);
    if (capacityStatus !== RenderStatus.CapacityExceeded || zeroFrameStatus !== RenderStatus.Rendered || terminalStatus !== RenderStatus.Terminal) {
      throw new Error("terminal capacity contract failed");
    }
  } finally {
    terminalKernel.free();
  }

  console.log(JSON.stringify({ maximumFrames, partitions: [3, 5], slotCount: kernel.slot_count(), staleCount: Number(kernel.stale_count()), starvationCount: Number(kernel.starvation_count()) }));
} finally {
  kernel.free();
}
