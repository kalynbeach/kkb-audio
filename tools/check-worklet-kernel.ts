import { WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { RenderStatus } from "../web/src/render-adapter";

const wasmBytes = await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer();
const module = await WebAssembly.compile(wasmBytes);
initSync({ module });

const maximumFrames = 64;
const kernel = new WorkletKernel(1, 48_000, 440, 0.125, maximumFrames);
try {
  if (kernel.preparation_status() !== RenderStatus.Rendered) {
    throw new Error("worklet kernel preparation failed");
  }
  const capacityStatus = kernel.render(maximumFrames + 1);
  if (capacityStatus !== RenderStatus.CapacityExceeded) {
    throw new Error(`expected capacity status, got ${capacityStatus}`);
  }
  const zeroFrameStatus = kernel.render(0);
  if (zeroFrameStatus !== RenderStatus.Rendered) {
    throw new Error(`expected zero-frame render status, got ${zeroFrameStatus}`);
  }
  const terminalStatus = kernel.render(1);
  if (terminalStatus !== RenderStatus.Terminal) {
    throw new Error(`expected terminal status, got ${terminalStatus}`);
  }

  console.log(
    JSON.stringify({
      capacityStatus,
      maximumFrames,
      terminalStatus,
      zeroFrameStatus,
    }),
  );
} finally {
  kernel.free();
}
