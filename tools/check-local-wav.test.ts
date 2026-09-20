import { expect, test } from "bun:test";
import { LocalWav, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import { LocalPcmProducer } from "../web/src/local-pcm-producer";
import { wavFixture, expectedWavSample } from "./local-wav-fixture";
import type { PcmBlockMessage } from "../web/src/pcm-protocol";

const module = await WebAssembly.compile(await Bun.file("public/audio-runtime/kkb_audio_bg.wasm").arrayBuffer());
const exports = initSync({ module });
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
function parse(bytes: Uint8Array): LocalWav {
  const wav = new LocalWav(BigInt(bytes.length));
  try {
    while (wav.length()) {
      expect(wav.length()).toBeLessThanOrEqual(16);
      const start = Number(wav.offset()); wav.accept(bytes.subarray(start, start + wav.length()));
    }
    return wav;
  } catch (error) { wav.free(); throw error; }
}

test("actual Wasm shared decoder rejects malformed chunk bounds and unsupported WAV", () => {
  const good = wavFixture(24, 2, 48000, 5);
  for (let length = 0; length < good.length; length++) expect(() => parse(good.subarray(0, length))).toThrow();
  for (const [offset, value] of [[0, 0], [20, 3], [20, 254], [22, 3], [24, 0], [28, 1], [32, 1], [34, 32], [40, 255]] as const) {
    const bad = good.slice(); bad[offset] = value; expect(() => parse(bad)).toThrow();
  }
  expect(() => parse(wavFixture(16, 1, 48000, 0))).toThrow();
});

test("actual decoder → bounded producer → compiled Wasm: finite tails, irregular partitions, channel identity and EOS", async () => {
  for (const bits of [16, 24] as const) for (const channels of [1, 2] as const) for (const rate of [44100, 48000]) for (const total of [1, 17, 256, 257, 1024, 1025]) {
    const bytes = wavFixture(bits, channels, rate, total);
    const wav = parse(bytes);
    const kernel = new WorkletKernel(channels, rate, 3n, 1n, 1024, 256);
    const adapter = new PreparedPlanarAdapter(channels, kernel, exports.memory, 256);
    const memory = exports.memory.buffer;
    let prepared = false;
    const scheduled: Array<() => void> = [];
    const config = { channelCount: channels, sampleRate: rate, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: 256 };
    const producer = new LocalPcmProducer(config, total,
      async (buffer, start, frames) => {
        const offset = Number(wav.data_offset()) + start * wav.block_align();
        const decoded = wav.decode(bytes.subarray(offset, offset + frames * wav.block_align()));
        for (let channel = 0; channel < channels; channel++) new Float32Array(buffer).set(decoded.subarray(channel * frames, (channel + 1) * frames), channel * 256);
      }, message => {
        if ((message as { type: string }).type === "supply") producer.accept({ type: "supply", free: [0, 1, 2, 3].map(slot => kernel.slot_free(slot)) });
        else {
          const block = message as PcmBlockMessage;
          // Use real structured-clone transfer in both directions, not shared JS buffers.
          const received = structuredClone(block, { transfer: [block.buffer] });
          expect(block.buffer.byteLength).toBe(0);
          const accepted = adapter.acceptBlock(received);
          const reply = structuredClone({ type: "admission-result", accepted, slotId: received.slotId, buffer: received.buffer }, { transfer: [received.buffer] });
          producer.accept(reply);
        }
      }, () => { prepared = true; }, error => { throw error; }, callback => scheduled.push(callback));
    try {
      producer.start(); await flush(); expect(prepared).toBe(true); expect(kernel.source_position()).toBe(0n); expect(kernel.ended()).toBe(false);
      producer.activate();
      let position = 0;
      let index = 0;
      while (position < total) {
        scheduled.shift()?.(); await flush();
        const frames = [1, 17, 239, 3, 128][index++ % 5]!;
        const consumed = Math.min(frames, total - position);
        const output = Array.from({ length: channels }, () => new Float32Array(frames));
        adapter.process([output]);
        for (let channel = 0; channel < channels; channel++) for (let frame = 0; frame < frames; frame++) expect(output[channel]![frame]).toBe(frame < consumed ? expectedWavSample(bits, position + frame, channel) : 0);
        position += consumed;
        expect(Number(kernel.source_position())).toBe(position);
        expect(kernel.ended()).toBe(position === total);
      }
      const silence = Array.from({ length: channels }, () => new Float32Array(17).fill(1)); adapter.process([silence]);
      expect(silence.every(plane => plane.every(sample => sample === 0))).toBe(true);
      expect(kernel.source_position()).toBe(BigInt(total)); expect(kernel.starvation_count()).toBe(0n);
      expect(exports.memory.buffer).toBe(memory); expect(memory.byteLength).toBe(16777216);
    } finally { kernel.free(); wav.free(); }
  }
});

test("48 kHz ten-second simulated host outlasts prefill: bounded credit pacing, starvation recovery and pause preservation", async () => {
  const total = 480000;
  const bytes = wavFixture(24, 2, 48000, total);
  const wav = parse(bytes);
  const kernel = new WorkletKernel(2, 48000, 3n, 1n, 1024, 256);
  const adapter = new PreparedPlanarAdapter(2, kernel, exports.memory, 256);
  let time = 0;
  let timer: { due: number; callback: () => void } | undefined;
  let maxTimers = 0;
  let prepared = false;
  const producer = new LocalPcmProducer({ channelCount: 2, sampleRate: 48000, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: 256 }, total,
    async (buffer, start, frames) => {
      const offset = Number(wav.data_offset()) + start * 6;
      const samples = wav.decode(bytes.subarray(offset, offset + frames * 6));
      const output = new Float32Array(buffer);
      output.set(samples.subarray(0, frames)); output.set(samples.subarray(frames), 256);
    }, message => {
      if ((message as { type: string }).type === "supply") producer.accept({ type: "supply", free: [0, 1, 2, 3].map(slot => kernel.slot_free(slot)) });
      else { const block = message as PcmBlockMessage; producer.accept({ type: "admission-result", slotId: block.slotId, buffer: block.buffer, accepted: adapter.acceptBlock(block) }); }
    }, () => { prepared = true; }, error => { throw error; }, (callback, ms) => {
      if (timer) throw new Error("more than one pending timer"); timer = { due: time + ms, callback }; maxTimers = Math.max(maxTimers, 1);
    });
  const left = new Float32Array(128), right = new Float32Array(128);
  let callbacks = 0;
  let naturalStarvation = 0;
  let deliberatelyStalled = false;
  let pauseChecked = false;
  try {
    producer.start(); await flush(); expect(prepared).toBe(true); producer.activate();
    while (!kernel.ended()) {
      const nextCallback = time + 128000 / 48000;
      while (timer && timer.due <= nextCallback) { const task = timer; timer = undefined; time = task.due; task.callback(); await flush(); }
      time = nextCallback;
      if (!pauseChecked && kernel.source_position() >= 3000n) {
        // Host suspension: render is not invoked; worker may poll but cannot consume or overwrite slots.
        const position = kernel.source_position(), render = kernel.next_frame();
        for (let i = 0; i < 100; i++) if (timer) { const task = timer; timer = undefined; time = task.due; task.callback(); await flush(); }
        expect(kernel.source_position()).toBe(position); expect(kernel.next_frame()).toBe(render); pauseChecked = true;
      }
      if (callbacks === 100) { producer.stall(true); deliberatelyStalled = true; }
      if (callbacks === 150) producer.stall(false);
      const start = Number(kernel.source_position()); const oldStarvation = kernel.starvation_count();
      adapter.process([[left, right]]);
      const consumed = Number(kernel.source_position()) - start;
      for (let frame = 0; frame < consumed; frame++) {
        if (left[frame] !== expectedWavSample(24, start + frame, 0) || right[frame] !== expectedWavSample(24, start + frame, 1)) throw new Error(`lost, duplicated or reordered sample ${start + frame}`);
      }
      for (let frame = consumed; frame < 128; frame++) if (left[frame] !== 0 || right[frame] !== 0) throw new Error("nonzero starvation/EOS padding");
      if (kernel.starvation_count() !== oldStarvation && !(callbacks >= 100 && callbacks <= 150)) naturalStarvation++;
      if (++callbacks > 5000) throw new Error("pacing failed to reach EOS");
    }
    expect(deliberatelyStalled && pauseChecked).toBe(true); expect(naturalStarvation).toBe(0); expect(kernel.starvation_count() > 0n).toBe(true);
    expect(producer.rejections).toBe(0); expect(producer.admittedPcmFrames).toBe(total); expect(producer.buffers).toHaveLength(4); expect(maxTimers).toBe(1);
    console.log(JSON.stringify({ simulatedRate: 48000, totalFrames: total, callbacks, naturalStarvation, injectedStarvationCallbacks: Number(kernel.starvation_count()), supplyPolls: producer.polls, rejectedBlocks: producer.rejections, maximumPendingTimers: maxTimers, browserDeadlineClaim: false }));
  } finally { kernel.free(); wav.free(); }
});

test("built browser worker reads bounded File slices, rejects unsupported conversion and admits a short tail before ready", async () => {
  const reads: number[] = [];
  class TrackedFile extends File {
    override slice(start?: number, end?: number, contentType?: string): Blob {
      reads.push((end ?? this.size) - (start ?? 0));
      return super.slice(start, end, contentType);
    }
  }
  for (const mismatch of [false, true]) {
    const messages: Array<{ type: string; detail?: string; initialAdmittedBlocks?: number }> = [];
    const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (message: typeof messages[number]) => messages.push(message) };
    Object.defineProperty(globalThis, "self", { configurable: true, value: host });
    await import(`data:text/javascript;base64,${Buffer.from((await Bun.file("public/audio-runtime/pcm-worker.js").text()) + `\n// case ${mismatch}`).toString("base64")}`);
    await host.onmessage!({ data: { type: "inspect", file: new TrackedFile([wavFixture(24, 2, 48000, 257)], "short.wav"), module, sampleRate: mismatch ? 32000 : 48000 } });
    if (mismatch) { expect(messages[0]?.type).toBe("worker-failed"); expect(messages[0]?.detail).toContain("71"); continue; }
    expect(messages[0]?.type).toBe("metadata");
    const kernel = new WorkletKernel(2, 48000, 3n, 1n, 1024, 256);
    const adapter = new PreparedPlanarAdapter(2, kernel, exports.memory, 256);
    const channel = new MessageChannel();
    let admitted = 0;
    channel.port2.onmessage = event => {
      const block = event.data as PcmBlockMessage;
      const accepted = adapter.acceptBlock(block); admitted++;
      expect(accepted).toBe(true);
      expect(messages.some(message => message.type === "worker-ready")).toBe(false);
      channel.port2.postMessage({ type: "admission-result", slotId: block.slotId, buffer: block.buffer, accepted }, [block.buffer]);
    };
    try {
      await host.onmessage!({ data: { type: "initialize", config: { channelCount: 2, sampleRate: 48000, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: 256 }, port: channel.port1 } });
      const deadline = performance.now() + 1000;
      while (!messages.some(message => message.type === "worker-ready")) {
        if (performance.now() > deadline) throw new Error("short worker prefill timed out");
        await Bun.sleep(1);
      }
      expect(admitted).toBe(2); expect(messages.at(-1)?.initialAdmittedBlocks).toBe(2);
      const left = new Float32Array(257), right = new Float32Array(257); adapter.process([[left, right]]);
      for (let frame = 0; frame < 257; frame++) { expect(left[frame]).toBe(expectedWavSample(24, frame, 0)); expect(right[frame]).toBe(expectedWavSample(24, frame, 1)); }
      expect(kernel.ended()).toBe(true); expect(kernel.source_position()).toBe(257n);
    } finally { channel.port1.close(); channel.port2.close(); kernel.free(); }
  }
  expect(Math.max(...reads)).toBe(257 * 6);
  expect(reads.filter(length => length > 16)).toEqual([257 * 6]);
});
