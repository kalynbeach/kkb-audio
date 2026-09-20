import assert from "node:assert/strict";
import { WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { FixedTransferPool } from "../web/src/pcm-worker-pool";
import { isAdmissionResultMessage, type PcmBlockMessage } from "../web/src/pcm-protocol";

const module = await WebAssembly.compile(await Bun.file("public/audio-runtime/kkb_audio_bg.wasm").arrayBuffer());
const exports = initSync({ module });
const maximumFrames = 1_024;
const slotFrames = 257;
const totalFrames = 1_000;

function admit(kernel: WorkletKernel, channels: 1 | 2, slot: number, epoch: bigint, start: number, frames = slotFrames, end = false): void {
  assert.equal(kernel.reserve_slot(slot), true);
  const left = new Float32Array(exports.memory.buffer, kernel.slot_left_ptr(slot), slotFrames);
  const right = channels === 2 ? new Float32Array(exports.memory.buffer, kernel.slot_right_ptr(slot), slotFrames) : undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = (start + frame + 1) / 4_096;
    if (right !== undefined) right[frame] = -left[frame]! * 0.25;
  }
  assert.equal(kernel.admit(slot, epoch, BigInt(start), frames, start === 0, end), 0);
  assert.equal(kernel.reserve_slot(slot), false, "queued or current slot cannot be reserved");
}

function render(kernel: WorkletKernel, channels: 1 | 2, partitions: number[]): Float32Array[] {
  const views = [new Float32Array(exports.memory.buffer, kernel.left_ptr(), maximumFrames)];
  if (channels === 2) views.push(new Float32Array(exports.memory.buffer, kernel.right_ptr(), maximumFrames));
  const output = views.map(() => new Float32Array(partitions.reduce((sum, count) => sum + count, 0)));
  let offset = 0;
  for (const frames of partitions) {
    assert.equal(kernel.render(frames), 0);
    for (let channel = 0; channel < channels; channel += 1) {
      for (let frame = 0; frame < frames; frame += 1) output[channel]![offset + frame] = views[channel]![frame]!;
    }
    offset += frames;
  }
  return output;
}

for (const sampleRate of [44_100, 48_000]) {
  for (const channels of [1, 2] as const) {
    const instances = Array.from({ length: 3 }, () => new WorkletKernel(channels, sampleRate, 3n, 1n, maximumFrames, slotFrames));
    try {
      for (const kernel of instances) {
        assert.equal(kernel.preparation_status(), 0);
        assert.equal(kernel.slot_count(), 4);
        for (let slot = 0; slot < 4; slot += 1) admit(kernel, channels, slot, 1n, slot * slotFrames);
      }
      const [whole, singles, partitioned] = instances as [WorkletKernel, WorkletKernel, WorkletKernel];
      const expected = render(whole, channels, [totalFrames]);
      assert.equal(singles.next_frame(), 0n);
      assert.deepEqual(render(singles, channels, Array.from({ length: totalFrames }, () => 1)), expected);
      assert.deepEqual(render(partitioned, channels, [0, 17, 240, 1, 256, 128, 358]), expected);
      for (let frame = 0; frame < totalFrames; frame += 1) {
        assert.equal(expected[0]![frame], (frame + 1) / 8_192, "compiled gain must scale the prepared input");
        if (channels === 2) assert.equal(expected[1]![frame], -(frame + 1) / 32_768);
      }
      for (const kernel of instances) assert.equal(kernel.next_frame(), 1_000n);

      // Invalidate the partial tail; obsolete/future admissions return ownership immediately.
      whole.set_epoch(2n);
      for (const epoch of [1n, 3n]) {
        assert.equal(whole.reserve_slot(0), true);
        assert.equal(whole.admit(0, epoch, 1028n, 2, false, false), 5);
        assert.equal(whole.slot_free(0), true);
      }
      admit(whole, channels, 2, 2n, 2_000, 2);
      const afterEpoch = render(whole, channels, [4]);
      assert.deepEqual(Array.from(afterEpoch[0]!), [2_001 / 8_192, 2_002 / 8_192, 0, 0]);
      assert.equal(whole.stale_count(), 1n);
      assert.equal(whole.invalid_count(), 0n);
      assert.equal(whole.starvation_count(), 1n);
      for (let slot = 0; slot < 4; slot += 1) { assert.equal(whole.reserve_slot(slot), true); whole.cancel_slot(slot); }
      assert.ok(render(whole, channels, [4]).every((plane) => plane.every((sample) => Object.is(sample, 0))));
      admit(whole, channels, 0, 2n, 2_002, 2, true);
      assert.equal(render(whole, channels, [2])[0]![0], 2_003 / 8_192);
      const buffer = exports.memory.buffer;
      const bytes = buffer.byteLength;
      const outputViews = [new Float32Array(buffer, whole.left_ptr(), maximumFrames)];
      if (channels === 2) outputViews.push(new Float32Array(buffer, whole.right_ptr(), maximumFrames));
      for (let iteration = 0; iteration < 10_000; iteration += 1) {
        // Recycle an admitted slot each time, exercising PCM consumption as well as the plan.
        whole.set_epoch(BigInt(iteration + 3));
        admit(whole, channels, 0, BigInt(iteration + 3), 0, 128, true);
        assert.equal(whole.render(128), 0);
      }
      assert.equal(exports.memory.buffer, buffer);
      assert.equal(buffer.byteLength, bytes);
      assert.equal(whole.starvation_count(), 2n, "EOS silence does not add starvation");
      const clock = whole.next_frame();
      assert.equal(whole.render(maximumFrames + 1), 2);
      assert.equal(whole.render(0), 0);
      assert.equal(whole.render(1), 3);
      assert.equal(whole.next_frame(), clock);
    } finally { for (const instance of instances) instance.free(); }
  }
}

// Exercise the built worklet, actual Wasm, and real transferable ownership together.
// Only the AudioWorklet host is mocked; no transport or renderer module is mocked.
type Message = { type: string; code?: number; snapshot?: { failureCode: number; starvationCount: number } };
class ControlPort {
  readonly messages: Message[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: Message): void { this.messages.push(message); }
}
class HostProcessor { readonly port = new ControlPort(); }
type Processor = HostProcessor & { process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean };
type Constructor = new (options: { processorOptions: Record<string, unknown> }) => Processor;
let registered: Constructor | undefined;
Object.defineProperties(globalThis, {
  AudioWorkletProcessor: { configurable: true, value: HostProcessor },
  sampleRate: { configurable: true, value: 48_000 },
  registerProcessor: { configurable: true, value: (name: string, constructor: Constructor) => {
    assert.equal(name, "kkb-prepared-kernel"); registered = constructor;
  } },
});
await import(new URL("../public/audio-runtime/worklet-processor.js", import.meta.url).href);
assert.ok(registered);
const config = { channelCount: 2, sampleRate: 48_000, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: 256 } as const;
const processor = new registered({ processorOptions: { ...config, maximumFrames, module } });
const channel = new MessageChannel();
processor.port.onmessage?.({ data: { type: "transport-port", port: channel.port2 } });
assert.equal(processor.port.messages[0]?.type, "ready");
const pool = new FixedTransferPool(config);
async function send(block: PcmBlockMessage): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("admission result timed out")), 1_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timeout);
      try {
        assert.ok(isAdmissionResultMessage(event.data, config));
        assert.equal(pool.acceptAdmissionResult(event.data), true);
        resolve(event.data.accepted);
      } catch (error) { reject(error); }
    };
    channel.port1.postMessage(block, [block.buffer]);
    assert.equal(block.buffer.byteLength, 0, "sending relinquishes transferable ownership");
  });
}
try {
  for (let slot = 0; slot < 4; slot += 1) assert.equal(await send(pool.takeNext()!), true);
  // The JS buffer has returned, but its Wasm slot remains queued. Retry must preserve its PCM.
  assert.equal(await send(pool.takeNext()!), false);
  let start = 0;
  for (const frames of [17, 257, 726]) {
    const left = new Float32Array(frames); const right = new Float32Array(frames);
    assert.equal(processor.process([], [[left, right]], {}), true);
    for (let frame = 0; frame < frames; frame += 1) {
      assert.equal(left[frame], (((start + frame) & 1_023) - 512) / 32_768);
      assert.equal(right[frame], -left[frame]!);
    }
    start += frames;
  }
  assert.equal(await send(pool.takeNext()!), true, "retired slot accepts the retained retry");
  const left = new Float32Array(280); const right = new Float32Array(280);
  processor.process([], [[left, right]], {});
  for (let frame = 0; frame < 280; frame += 1) assert.equal(left[frame], (((1_000 + frame) & 1_023) - 512) / 32_768);
  assert.equal(pool.snapshot().invalidRecycleCount, 0);
  processor.port.onmessage?.({ data: { type: "snapshot" } });
  assert.equal(processor.port.messages.at(-1)?.snapshot?.failureCode, 0);
  assert.equal(processor.port.messages.at(-1)?.snapshot?.starvationCount, 0);
} finally { channel.port1.close(); channel.port2.close(); }

console.log(JSON.stringify({
  sampleRates: [44_100, 48_000], channels: [1, 2], totalFrames, gain: 0.5,
  partitionEquality: "exact", partialEpochRejection: true, starvationAndRecovery: true,
  stableMemoryPcmRenderCallsPerConfiguration: 10_000,
  builtProcessorTransferAndRetry: true, nativeToWasmBitIdentityClaim: false,
}));
