import assert from "node:assert/strict";
import { WorkletPlan, compile_plan_proof, initSync } from "../web/src/generated/kkb_audio.js";

const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const exports = initSync({ module });
const totalFrames = 1_000;
let maximumReferenceError = 0;

// Absolute sample positions form the oracle independently of the renderer's evolving phase/state.
function reference(frame: number, sampleRate: number): number {
  const gainA = Math.fround(frame < 17 ? 0.25 : frame < 400 ? 0.5 : 0.3);
  const gainB = Math.fround(frame <= 31 ? 0.125 : frame >= 257 ? 0.375 : 0.125 + 0.25 * (frame - 31) / 226);
  const a = Math.fround(Math.fround(Math.sin(2 * Math.PI * 997 * frame / sampleRate)) * gainA);
  const b = Math.fround(Math.fround(Math.sin(2 * Math.PI * 1_499 * frame / sampleRate)) * gainB);
  return Math.fround(a + b);
}

function render(plan: WorkletPlan, partitions: readonly number[], channels: 1 | 2): Float32Array {
  const output = new Float32Array(partitions.reduce((total, frames) => total + frames, 0));
  const left = new Float32Array(exports.memory.buffer, plan.left_ptr(), plan.maximum_frames());
  const right = channels === 2 ? new Float32Array(exports.memory.buffer, plan.right_ptr(), plan.maximum_frames()) : undefined;
  let offset = 0;
  for (const frames of partitions) {
    assert.equal(plan.render(frames), 0);
    for (let frame = 0; frame < frames; frame += 1) {
      output[offset + frame] = left[frame]!;
      if (right !== undefined) assert.equal(right[frame], left[frame]);
    }
    offset += frames;
  }
  return output;
}

function assertObservation(plan: WorkletPlan, samples: Float32Array, start: number, end: number): void {
  assert.equal(plan.take_observation(), true);
  assert.equal(plan.observation_start(), BigInt(start));
  assert.equal(plan.observation_end(), BigInt(end));
  assert.equal(plan.observation_location(), 60);
  let peak = 0;
  let squares = 0;
  for (let frame = start; frame < end; frame += 1) {
    const sample = samples[frame]!;
    peak = Math.max(peak, Math.abs(sample));
    squares += sample * sample;
  }
  assert.equal(plan.observation_peak(), peak);
  assert.ok(Math.abs(plan.observation_rms() - Math.sqrt(squares / (end - start))) <= 1e-12);
  assert.equal(plan.take_observation(), false);
}

for (const sampleRate of [44_100, 48_000]) {
  for (const channels of [1, 2] as const) {
    const description = compile_plan_proof(sampleRate, channels);
    assert.ok(description.length > 0);
    const original = description.slice();
    const whole = new WorkletPlan(description, sampleRate, channels);
    const partitioned = new WorkletPlan(description, sampleRate, channels);
    const singles = new WorkletPlan(description, sampleRate, channels);
    try {
      assert.equal(whole.preparation_status(), 0);
      assert.equal(partitioned.preparation_status(), 0);
      assert.equal(singles.preparation_status(), 0);
      const buffer = exports.memory.buffer;
      const memoryBytes = buffer.byteLength;
      const output = render(whole, [totalFrames], channels);
      assert.equal(partitioned.next_frame(), 0n);
      assert.equal(singles.next_frame(), 0n);
      for (let frame = 0; frame < totalFrames; frame += 1) {
        const error = Math.abs(output[frame]! - reference(frame, sampleRate));
        maximumReferenceError = Math.max(maximumReferenceError, error);
        assert.ok(error <= 1e-6, `analytic mix mismatch at ${frame}, ${sampleRate} Hz: ${error}`);
      }
      // Boundaries immediately around sets and inclusive ramp endpoints are deliberately uneven.
      const irregular = [0, 16, 1, 1, 13, 1, 225, 1, 1, 140, 1, 1, 599];
      assert.deepEqual(render(partitioned, irregular, channels), output);
      assert.deepEqual(render(singles, Array.from({ length: totalFrames }, () => 1), channels), output);
      assert.equal(whole.next_frame(), 1_000n);
      assert.equal(partitioned.next_frame(), 1_000n);
      assert.equal(singles.next_frame(), 1_000n);
      assertObservation(whole, output, 896, 960);
      assert.equal(whole.observation_sequence(), 15n);
      assert.equal(whole.observation_dropped(), 14n);
      assertObservation(partitioned, output, 896, 960);
      assert.equal(partitioned.observation_dropped(), 14n);
      const extended = new Float32Array(1_024);
      extended.set(output);
      extended.set(render(whole, [24], channels), 1_000);
      assertObservation(whole, extended, 960, 1_024);
      assert.equal(whole.observation_sequence(), 16n);
      assert.equal(whole.observation_dropped(), 14n);
      assert.equal(partitioned.next_frame(), 1_000n);
      for (let iteration = 0; iteration < 10_000; iteration += 1) assert.equal(whole.render(128), 0);
      assert.equal(exports.memory.buffer, buffer);
      assert.equal(exports.memory.buffer.byteLength, memoryBytes);
      assert.deepEqual(description, original);
    } finally { whole.free(); partitioned.free(); singles.free(); }

    const invalid = description.slice();
    invalid[0] = 0xffff_ffff;
    const rejected = new WorkletPlan(invalid, sampleRate, channels);
    const wrongRate = new WorkletPlan(description, sampleRate + 1, channels);
    const wrongLayout = new WorkletPlan(description, sampleRate, channels === 1 ? 2 : 1);
    const terminal = new WorkletPlan(description, sampleRate, channels);
    try {
      assert.notEqual(rejected.preparation_status(), 0);
      assert.notEqual(wrongRate.preparation_status(), 0);
      assert.notEqual(wrongLayout.preparation_status(), 0);
      assert.equal(terminal.render(1_025), 2);
      assert.equal(terminal.next_frame(), 0n);
      assert.equal(terminal.render(0), 0);
      assert.equal(terminal.render(1), 3);
      assert.equal(terminal.next_frame(), 0n);
    } finally { rejected.free(); wrongRate.free(); wrongLayout.free(); terminal.free(); }
  }
}
assert.equal(compile_plan_proof(0, 1).length, 0);
assert.equal(compile_plan_proof(48_000, 3).length, 0);

// Mock only the browser host. Import the built processor so its Wasm binding,
// description validation, and render adapter execute together without module mocks.
type Message = { type: string; code?: number; snapshot?: { failureCode: number; observation: unknown } };
class FakePort {
  readonly messages: Message[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: Message): void { this.messages.push(message); }
}
class FakeProcessor { readonly port = new FakePort(); }
type Processor = FakeProcessor & { process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean };
type ProcessorConstructor = new (options: { processorOptions: Record<string, unknown> }) => Processor;
let registered: ProcessorConstructor | undefined;
Object.defineProperties(globalThis, {
  AudioWorkletProcessor: { configurable: true, value: FakeProcessor },
  sampleRate: { configurable: true, value: 48_000 },
  registerProcessor: { configurable: true, value: (name: string, constructor: ProcessorConstructor) => {
    assert.equal(name, "kkb-compiled-plan");
    registered = constructor;
  } },
});
await import(new URL("../web/dist/plan-processor.js", import.meta.url).href);
assert.ok(registered !== undefined);
const ProcessorClass = registered as ProcessorConstructor;
const validDescription = compile_plan_proof(48_000, 2);
const validProcessor = new ProcessorClass({ processorOptions: { module, description: validDescription, sampleRate: 48_000, channelCount: 2 } });
assert.equal(validProcessor.port.messages.length, 1);
assert.equal(validProcessor.port.messages[0]?.type, "ready");
const validOutput = [[new Float32Array(128), new Float32Array(128)]];
assert.equal(validProcessor.process([], validOutput, {}), true);
assert.ok(validOutput[0]![0]!.some((sample) => sample !== 0));
assert.deepEqual(validOutput[0]![0], validOutput[0]![1]);
assert.equal(validProcessor.port.messages.length, 1, "process must not publish observations");
validProcessor.port.onmessage?.({ data: { type: "snapshot" } });
assert.equal(validProcessor.port.messages[1]?.snapshot?.failureCode, 0);
assert.ok(validProcessor.port.messages[1]?.snapshot?.observation !== null);
const invalidDescription = validDescription.slice();
invalidDescription[0] = 0xffff_ffff;
for (const [description, channelCount, expectedFailure] of [
  [invalidDescription, 2, 60],
  [validDescription, 3, 40],
] as const) {
  const processor = new ProcessorClass({ processorOptions: { module, description, sampleRate: 48_000, channelCount } });
  assert.deepEqual(processor.port.messages, [{ type: "failed", code: expectedFailure }]);
  const outputs = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
  assert.equal(processor.process([], outputs, {}), true);
  assert.ok(outputs.every((channels) => channels.every((channel) => channel.every((sample) => Object.is(sample, 0)))));
  assert.equal(processor.port.messages.length, 1);
}

console.log(JSON.stringify({
  sampleRates: [44_100, 48_000], channels: [1, 2], totalFrames, maximumReferenceError,
  partitionEquality: "exact", observationWindowFrames: 64,
  stableMemoryRenderCallsPerConfiguration: 10_000,
  invalidDescriptionRejected: true, capacityFailureTerminal: true,
  builtProcessorHandshakeAndFailureSilence: true,
}));
