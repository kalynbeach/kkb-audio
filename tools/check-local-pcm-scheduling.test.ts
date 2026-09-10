import { expect, test } from "bun:test";
import { LocalWav, PreparedRateConverter, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { LocalPcmProducer } from "../web/src/local-pcm-producer";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import { LOCAL_PCM_SLOT_FRAMES, type PcmBlockMessage } from "../web/src/pcm-protocol";
import { wavFixture } from "./local-wav-fixture";

const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

type ScheduleCase = {
  sourceRate: number;
  outputRate: number;
  slotFrames: number;
  timerDelay: number;
};

// Virtual host time advances independently of worker timers, asynchronous reads,
// supply request/reply and PCM admission/ownership return. The older synchronous
// transport harness cannot exercise this latency chain. Delays are controlled
// probes, NOT a captured browser trace or a browser deadline guarantee.
async function replay(config: ScheduleCase) {
  let time = 0, sequence = 0, active = false, delayed = false;
  const tasks: Array<{ due: number; sequence: number; callback: () => void }> = [];
  const enqueue = (callback: () => void, delay: number) => tasks.push({ due: time + delay, sequence: sequence++, callback });
  const step = async () => {
    tasks.sort((a, b) => a.due - b.due || a.sequence - b.sequence);
    const task = tasks.shift();
    if (!task || task.due > 2000) throw new Error("virtual supply did not reach EOS");
    time = task.due; task.callback(); await flush();
  };
  const total = Math.floor(config.sourceRate / 2);
  const bytes = wavFixture(16, 2, config.sourceRate, total);
  const wav = new LocalWav(BigInt(bytes.length));
  while (wav.length()) { const offset = Number(wav.offset()); wav.accept(bytes.subarray(offset, offset + wav.length())); }
  const converter = new PreparedRateConverter(config.sourceRate, config.outputRate, 2, BigInt(total));
  const kernel = new WorkletKernel(2, config.outputRate, 3n, 1n, 1024, config.slotFrames);
  kernel.set_media_timeline(config.sourceRate, BigInt(total));
  const adapter = new PreparedPlanarAdapter(2, kernel, memory, config.slotFrames);
  const initialMemory = memory.buffer;
  const supplied: number[][] = [[], []];
  const starvations: Array<{ time: number; queuedFrames: number; preparedAhead: number; missingFrames: number }> = [];
  let ready = false, maxReadBytes = 0, outstandingReads = 0, maxOutstandingReads = 0;
  let maximumTimers = 0, pendingTimers = 0;
  const producer = new LocalPcmProducer({ channelCount: 2, sampleRate: config.outputRate, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: config.slotFrames }, Number(converter.total_pcm_frames()),
    async (buffer, _start, frames) => {
      const output = new Float32Array(buffer);
      let written = 0;
      while (written < frames) {
        // Retain conservative 256-frame reads in this queue-headroom probe when
        // experimenting with transport capacity. This is not a product limit.
        const needed = Math.min(converter.input_frames_needed(), 256);
        if (needed > 0) {
          const offset = Number(wav.data_offset()) + Number(converter.source_frames_read()) * wav.block_align();
          maxReadBytes = Math.max(maxReadBytes, needed * wav.block_align());
          outstandingReads++; maxOutstandingReads = Math.max(maxOutstandingReads, outstandingReads);
          await new Promise<void>(resolve => enqueue(resolve, active ? 0.1 : 0));
          outstandingReads--;
          converter.push(wav.decode(bytes.subarray(offset, offset + needed * wav.block_align())));
        }
        const copied = Math.min(converter.available_frames(), frames - written);
        for (let channel = 0; channel < 2; channel++) output.set(new Float32Array(memory.buffer, converter.output_ptr(channel), copied), channel * config.slotFrames + written);
        converter.consume(copied); written += copied;
      }
    }, message => {
      if ((message as { type: string }).type === "supply") {
        enqueue(() => {
          const free = [0, 1, 2, 3].map(slot => kernel.slot_free(slot));
          enqueue(() => producer.accept({ type: "supply", free }), 1);
        }, 1);
      } else {
        const block = message as PcmBlockMessage;
        const received = structuredClone(block, { transfer: [block.buffer] });
        expect(block.buffer.byteLength).toBe(0);
        enqueue(() => {
          const accepted = adapter.acceptBlock(received);
          if (accepted) {
            const samples = new Float32Array(received.buffer);
            for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < received.validFrames; frame++) supplied[channel]!.push(samples[channel * config.slotFrames + frame]!);
          }
          const reply = structuredClone({ type: "admission-result", accepted, slotId: received.slotId, buffer: received.buffer }, { transfer: [received.buffer] });
          expect(received.buffer.byteLength).toBe(0);
          enqueue(() => producer.accept(reply), active ? 1 : 0);
        }, active ? 1 : 0);
      }
    }, () => { ready = true; }, error => { throw error; }, (callback, ms) => {
      pendingTimers++; maximumTimers = Math.max(maximumTimers, pendingTimers);
      let delay = ms;
      if (!delayed && time >= 100) { delayed = true; delay = Math.max(ms, config.timerDelay); }
      enqueue(() => { pendingTimers--; callback(); }, delay);
    });
  const output = [new Float32Array(128), new Float32Array(128)];
  const render = () => {
    const start = Number(kernel.pcm_position());
    const previousStarvation = kernel.starvation_count();
    adapter.process([output]);
    const consumed = Number(kernel.pcm_position()) - start;
    // The prepared proof graph applies its existing fixed 0.5 gain.
    for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < 128; frame++) {
      if (output[channel]![frame] !== (frame < consumed ? Math.fround(supplied[channel]![start + frame]! * 0.5) : 0)) throw new Error(`PCM lost, duplicated or reordered at ${start + frame}: channel=${channel}, actual=${output[channel]![frame]}, expected=${supplied[channel]![start + frame]}, consumed=${consumed}, snapshot=${JSON.stringify(adapter.snapshot())}`);
    }
    if (kernel.starvation_count() !== previousStarvation) starvations.push({ time, queuedFrames: supplied[0]!.length - Number(kernel.pcm_position()), preparedAhead: producer.preparedPcmFrames - Number(kernel.pcm_position()), missingFrames: 128 - consumed });
    if (!kernel.ended()) enqueue(render, 128000 / config.outputRate);
  };
  try {
    producer.start(); await flush();
    while (!ready) await step();
    expect(producer.initialAdmittedBlocks).toBe(4);
    active = true; producer.activate(); enqueue(render, 128000 / config.outputRate);
    while (!kernel.ended() || producer.admittedPcmFrames !== Number(converter.total_pcm_frames())) await step();
    expect(producer.rejections).toBe(0);
    expect(maxOutstandingReads).toBe(1); expect(maximumTimers).toBe(1);
    expect(producer.buffers).toHaveLength(4); expect(maxReadBytes).toBeLessThanOrEqual(1024);
    expect(memory.buffer).toBe(initialMemory);
    expect(kernel.source_position()).toBe(BigInt(total));
    expect(kernel.pcm_position()).toBe(converter.total_pcm_frames());
    const snapshot = adapter.snapshot();
    expect(snapshot.failureCode).toBe(0); expect(snapshot.invalidBlockCount).toBe(0); expect(snapshot.staleBlockCount).toBe(0);
    return { ...config, ...snapshot, maxReadBytes, maximumTimers, starvations, delayed };
  } finally { kernel.free(); converter.free(); wav.free(); }
}

for (const [sourceRate, outputRate] of [[44100, 48000], [48000, 44100], [48000, 48000]] as const) {
  test(`LocalPcmProducer asynchronous supply ${sourceRate} → ${outputRate}: selected capacity survives a delayed poll`, async () => {
    const baseline = await replay({ sourceRate, outputRate, slotFrames: 256, timerDelay: 2 });
    expect(baseline.starvationCount).toBe(0);
    const undersized = await replay({ sourceRate, outputRate, slotFrames: 256, timerDelay: 21 });
    expect(undersized.delayed).toBe(true);
    expect(undersized.starvationCount).toBeGreaterThan(0);
    expect(undersized.starvations.every(gap => gap.queuedFrames === 0 && gap.missingFrames === 128)).toBe(true);
    const selected = await replay({ sourceRate, outputRate, slotFrames: LOCAL_PCM_SLOT_FRAMES, timerDelay: 21 });
    expect(selected.delayed).toBe(true);
    expect(selected.starvationCount).toBe(0);
  });
}

test("source WAV worker keeps reads bounded independently of selected transport capacity", async () => {
  const originalSelf = globalThis.self;
  const reads: number[] = [];
  class TrackedFile extends File {
    override slice(start?: number, end?: number, type?: string): Blob {
      reads.push((end ?? this.size) - (start ?? 0)); return super.slice(start, end, type);
    }
  }
  const messages: Array<{ type: string; detail?: string; initialAdmittedBlocks?: number }> = [];
  const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (message: typeof messages[number]) => messages.push(message) };
  const channel = new MessageChannel();
  const kernel = new WorkletKernel(2, 48000, 3n, 1n, 1024, LOCAL_PCM_SLOT_FRAMES);
  const adapter = new PreparedPlanarAdapter(2, kernel, memory, LOCAL_PCM_SLOT_FRAMES);
  try {
    Object.defineProperty(globalThis, "self", { configurable: true, value: host });
    await import("../web/src/pcm-worker");
    await host.onmessage!({ data: { type: "inspect", file: new TrackedFile([wavFixture(24, 2, 44100, 5003)], "bounded.wav"), module, sampleRate: 48000 } });
    expect(messages[0]?.type).toBe("metadata");
    channel.port2.onmessage = event => {
      const block = event.data as PcmBlockMessage;
      const accepted = adapter.acceptBlock(block);
      expect(accepted).toBe(true);
      channel.port2.postMessage({ type: "admission-result", accepted, slotId: block.slotId, buffer: block.buffer }, [block.buffer]);
    };
    await host.onmessage!({ data: { type: "initialize", config: { channelCount: 2, sampleRate: 48000, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: LOCAL_PCM_SLOT_FRAMES }, port: channel.port1 } });
    const deadline = performance.now() + 1000;
    while (!messages.some(message => message.type === "worker-ready")) {
      if (performance.now() > deadline || messages.some(message => message.type === "worker-failed")) throw new Error(JSON.stringify(messages));
      await Bun.sleep(1);
    }
    expect(messages.at(-1)?.initialAdmittedBlocks).toBe(4);
    expect(Math.max(...reads)).toBeLessThanOrEqual(6144);
    // Four conversion chunks prefill these slots: at most two reads per chunk,
    // rather than five serial reads with the old 256-frame window.
    expect(reads.filter(length => length > 16).length).toBeLessThanOrEqual(8);
    expect(kernel.pcm_position()).toBe(0n);
  } finally {
    channel.port1.close(); channel.port2.close(); kernel.free();
    Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
  }
});
