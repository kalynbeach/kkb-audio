import { expect, test } from "bun:test";
import { PreparedRateConverter, PcmTimeline, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import { wavFixture } from "./local-wav-fixture";
import type { PcmBlockMessage } from "../web/src/pcm-protocol";

const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
function convert(sourceRate: number, outputRate: number, input: Float32Array[], partition: number[]): Float32Array[] {
  const converter = new PreparedRateConverter(sourceRate, outputRate, input.length, BigInt(input[0]!.length));
  const output = input.map(() => new Float32Array(Number(converter.total_pcm_frames())));
  let written = 0, turn = 0;
  const buffer = memory.buffer;
  try {
    while (written < output[0]!.length) {
      const needed = Math.min(converter.input_frames_needed(), partition[turn++ % partition.length]!);
      if (needed) {
        const start = Number(converter.source_frames_read());
        const planar = new Float32Array(needed * input.length);
        input.forEach((plane, channel) => planar.set(plane.subarray(start, start + needed), channel * needed));
        converter.push(planar);
      }
      const copied = Math.min(converter.available_frames(), partition[turn % partition.length]!);
      output.forEach((plane, channel) => plane.set(new Float32Array(memory.buffer, converter.output_ptr(channel), copied), written));
      converter.consume(copied); written += copied;
      expect(memory.buffer).toBe(buffer);
    }
    expect(converter.source_frames_read()).toBe(BigInt(input[0]!.length));
    converter.reset(); expect(converter.source_frames_read()).toBe(0n); expect(converter.available_frames()).toBe(0);
    return output;
  } finally { converter.free(); }
}

test("actual Wasm prepared conversion: finite lengths, partition equality, bypass and rational media cursor", () => {
  for (const [sourceRate, outputRate] of [[44100, 48000], [48000, 44100], [48000, 48000]]) {
    for (const total of [1, 17, 1176, 1280, 1281, 5003]) {
      const input = [Float32Array.from({ length: total }, (_, i) => Math.sin(i / 13) * 0.2), new Float32Array(total)];
      const output = convert(sourceRate!, outputRate!, input, [1024]);
      expect(output).toEqual(convert(sourceRate!, outputRate!, input, [1, 17, 256]));
      expect(output[0]!.length).toBe(Math.ceil(total * outputRate! / sourceRate!));
      if (sourceRate === outputRate) expect(output).toEqual(input);
      const timeline = new PcmTimeline(sourceRate!, outputRate!, BigInt(total));
      expect(timeline.source_position(0n)).toBe(0n);
      expect(timeline.source_position(timeline.total_pcm_frames())).toBe(BigInt(total));
      timeline.free();
    }
  }
  expect(() => new PreparedRateConverter(32000, 48000, 1, 10n)).toThrow();
});

test("actual Wasm conversion meets analytic passband and 23kHz rejection thresholds", () => {
  for (const [sourceRate, outputRate] of [[44100, 48000], [48000, 44100]] as const) {
    for (const frequency of [100, 1000, 10000, 18000]) {
      const input = [Float32Array.from({ length: sourceRate }, (_, i) => Math.sin(2 * Math.PI * frequency * i / sourceRate) * 0.5)];
      const output = convert(sourceRate, outputRate, input, [256])[0]!;
      let maximumError = 0, energy = 0, referenceEnergy = 0;
      for (let i = 2000; i < output.length - 2000; i++) {
        const reference = Math.sin(2 * Math.PI * frequency * i / outputRate) * 0.5;
        maximumError = Math.max(maximumError, Math.abs(output[i]! - reference));
        energy += output[i]! ** 2; referenceEnergy += reference ** 2;
      }
      expect(maximumError).toBeLessThanOrEqual(0.002);
      expect(Math.abs(10 * Math.log10(energy / referenceEnergy))).toBeLessThanOrEqual(0.1);
    }
  }
  const input = [Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 23000 * i / 48000) * 0.5)];
  const output = convert(48000, 44100, input, [256])[0]!.subarray(2000, 42100);
  const rms = Math.sqrt(output.reduce((sum, value) => sum + value ** 2, 0) / output.length);
  expect(20 * Math.log10(rms / (0.5 / Math.SQRT2))).toBeLessThanOrEqual(-70);
});

test("built WAV worker conversion reaches consumed EOS across pause and starvation with bounded reads", async () => {
  const originalSelf = globalThis.self;
  // Two directions and both layouts/encodings; short and long finite streams.
  for (const [sourceRate, outputRate, bits, channels, total] of [
    [44100, 48000, 16, 1, 1], [48000, 44100, 24, 2, 17],
    [44100, 48000, 24, 2, 10003], [48000, 44100, 16, 1, 10003],
  ] as const) {
    const reads: number[] = [];
    class TrackedFile extends File {
      override slice(start?: number, end?: number, type?: string): Blob { reads.push((end ?? this.size) - (start ?? 0)); return super.slice(start, end, type); }
    }
    const messages: Array<{ type: string; detail?: string; totalFrames?: number; totalPcmFrames?: number; initialAdmittedBlocks?: number }> = [];
    const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (message: typeof messages[number]) => messages.push(message) };
    Object.defineProperty(globalThis, "self", { configurable: true, value: host });
    await import(`data:text/javascript;base64,${Buffer.from((await Bun.file("web/dist/pcm-worker.js").text()) + `\n// conversion ${sourceRate} ${total}`).toString("base64")}`);
    const bytes = wavFixture(bits, channels, sourceRate, total);
    // Decode integer fixtures independently to compare the built producer against differently chunked conversion.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const input = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: total }, (_, frame) => {
      const offset = 44 + (frame * channels + channel) * (bits / 8);
      return bits === 16 ? view.getInt16(offset, true) / 32768 : ((view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16) / 8388608);
    }));
    const expected = convert(sourceRate, outputRate, input, [1, 17, 239]);
    await host.onmessage!({ data: { type: "inspect", file: new TrackedFile([bytes], "conversion.wav"), module, sampleRate: outputRate } });
    expect(messages[0]).toMatchObject({ type: "metadata", totalFrames: total, totalPcmFrames: expected[0]!.length });
    const kernel = new WorkletKernel(channels, outputRate, 3n, 1n, 1024, 256);
    kernel.set_media_timeline(sourceRate, BigInt(total));
    const adapter = new PreparedPlanarAdapter(channels, kernel, memory, 256);
    const channel = new MessageChannel();
    channel.port2.onmessage = event => {
      if (event.data.type === "supply") { channel.port2.postMessage({ type: "supply", free: [0, 1, 2, 3].map(slot => kernel.slot_free(slot)) }); return; }
      const block = event.data as PcmBlockMessage;
      const accepted = adapter.acceptBlock(block);
      expect(accepted).toBe(true);
      channel.port2.postMessage({ type: "admission-result", slotId: block.slotId, buffer: block.buffer, accepted }, [block.buffer]);
    };
    const deadline = performance.now() + 5000;
    try {
      await host.onmessage!({ data: { type: "initialize", config: { channelCount: channels, sampleRate: outputRate, sourceId: 3, epoch: 1, slotCount: 4, slotFrames: 256 }, port: channel.port1 } });
      while (!messages.some(message => message.type === "worker-ready")) { if (performance.now() > deadline) throw new Error(JSON.stringify(messages)); await Bun.sleep(1); }
      expect(kernel.source_position()).toBe(0n); expect(kernel.pcm_position()).toBe(0n);
      expect(messages.at(-1)?.initialAdmittedBlocks).toBe(Math.min(4, Math.ceil(expected[0]!.length / 256)));
      await host.onmessage!({ data: { type: "activate" } });
      await host.onmessage!({ data: { type: "stall", value: true } });
      let position = 0, turn = 0, recovered = false;
      while (!kernel.ended()) {
        if (performance.now() > deadline) throw new Error("converted playback timeout");
        const frames = [1, 17, 239, 128][turn++ % 4]!;
        const output = Array.from({ length: channels }, () => new Float32Array(frames));
        const render = kernel.next_frame();
        // Suspended host does not render; worker activity cannot consume PCM/history.
        await Bun.sleep(1);
        expect(kernel.next_frame()).toBe(render); expect(kernel.pcm_position()).toBe(BigInt(position));
        adapter.process([output]);
        const next = Number(kernel.pcm_position());
        for (let ch = 0; ch < channels; ch++) for (let frame = 0; frame < frames; frame++) {
          expect(output[ch]![frame]).toBe(frame < next - position ? Math.fround(expected[ch]![position + frame]! * 0.5) : 0);
        }
        expect(Number(kernel.source_position())).toBe(next === expected[0]!.length ? total : Math.floor(next * sourceRate / outputRate));
        if (next === position && !kernel.ended()) {
          expect(kernel.next_frame()).toBeGreaterThan(render);
          recovered = true; await host.onmessage!({ data: { type: "stall", value: false } });
        }
        position = next;
      }
      expect(position).toBe(expected[0]!.length); expect(kernel.source_position()).toBe(BigInt(total));
      if (total > 1024) expect(recovered).toBe(true);
      expect(Math.max(...reads)).toBeLessThanOrEqual(6144);
      expect(memory.buffer.byteLength).toBe(16777216);
      expect(messages.some(message => message.type === "worker-failed")).toBe(false);
    } finally {
      await host.onmessage!({ data: { type: "stall", value: true } });
      channel.port1.close(); channel.port2.close(); kernel.free();
      Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
    }
  }
});
