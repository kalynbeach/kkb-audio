import { expect, test } from "bun:test";
import { LocalMedia, initSync } from "../web/src/generated/kkb_audio.js";
import { wavFixture, expectedWavSample } from "./local-wav-fixture";
import type { SourceWaveform } from "../web/src/source-waveform";

const module = await WebAssembly.compile(await Bun.file("public/audio-runtime/kkb_audio_bg.wasm").arrayBuffer());
initSync({ module });
let identity = 0;
async function scan(bytes: Uint8Array<ArrayBuffer>, mp3: boolean) {
  const media = new LocalMedia(BigInt(bytes.length), mp3);
  while (media.length()) { const p = Number(media.offset()); media.accept(bytes.subarray(p, p + media.length())); }
  const totalFrames = Number(media.total_frames()), sourceRate = media.sample_rate(), channels = media.channels(); media.free();
  const original = globalThis.self;
  const reads: number[] = [];
  class MeasuredFile extends File {
    override slice(start = 0, end = this.size) { reads.push(end - start); return super.slice(start, end); }
  }
  let message: { type: string; summary: SourceWaveform; milliseconds: number; memoryBytes: number; detail?: string } | undefined;
  const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (value: typeof message) => { message = value; } };
  try {
    Object.defineProperty(globalThis, "self", { configurable: true, value: host });
    await import(`data:text/javascript;base64,${Buffer.from(await Bun.file("public/audio-runtime/waveform-worker.js").text() + `\n// scan ${identity++}`).toString("base64")}`);
    await host.onmessage!({ data: { module, file: new MeasuredFile([bytes], "same-name"), totalFrames, sourceRate } });
    expect(message?.type).toBe("waveform-complete");
    expect(Math.max(...reads)).toBeLessThanOrEqual(65536);
    expect(message!.summary.extrema.byteLength).toBeLessThanOrEqual(32768);
    expect(message!.summary.totalFrames).toBe(totalFrames);
    expect(message!.memoryBytes).toBe(16777216);
    return { summary: message!.summary, channels, milliseconds: message!.milliseconds };
  } finally { Object.defineProperty(globalThis, "self", { configurable: true, value: original }); }
}
function compare(summary: SourceWaveform, channels: number, sample: (frame: number, channel: number) => number, tolerance = 0) {
  // Independent direct source-time oracle; never calls the production accumulator/reducer.
  for (let bin = 0; bin < summary.extrema.length / 2; bin++) {
    let low = Infinity, high = -Infinity;
    for (let frame = bin * summary.framesPerBin; frame < Math.min(summary.totalFrames, (bin + 1) * summary.framesPerBin); frame++) {
      for (let channel = 0; channel < channels; channel++) { const value = sample(frame, channel); low = Math.min(low, value); high = Math.max(high, value); }
    }
    expect(Math.abs(summary.extrema[2 * bin]! - low)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(summary.extrema[2 * bin + 1]! - high)).toBeLessThanOrEqual(tolerance);
  }
}
test("source-waveform real Rust/Wasm worker: independent PCM16/24 mono/stereo, rates, short/partial bins", async () => {
  for (const bits of [16, 24] as const) for (const channels of [1, 2] as const) for (const rate of [44100, 48000]) for (const frames of [1, 17, 8194]) {
    const { summary } = await scan(wavFixture(bits, channels, rate, frames), false);
    expect(summary.totalFrames).toBe(frames); expect(summary.sourceRate).toBe(rate);
    compare(summary, channels, (f, c) => expectedWavSample(bits, f, c) * 2);
  }
}, 20000);
test("source-waveform real Rust/Wasm MP3 trim and bins match all independent FFmpeg references", async () => {
  for (const name of ["cbr-44100-1", "cbr-44100-2", "vbr-44100-1", "vbr-44100-2", "cbr-48000-1", "cbr-48000-2", "vbr-48000-1", "vbr-48000-2", "short", "crc", "vbri"]) {
    const bytes = new Uint8Array(await Bun.file(`tools/fixtures/mp3/${name}.mp3`).arrayBuffer());
    const reference = new Float32Array(await Bun.file(`tools/fixtures/mp3/${name}.f32`).arrayBuffer());
    const { summary, channels } = await scan(bytes, true);
    expect(summary.totalFrames * channels).toBe(reference.length);
    compare(summary, channels, (f, c) => reference[f * channels + c]!, 1e-5);
  }
}, 20000);

test("source-waveform Rust PCM silence and isolated opposite-phase impulses preserve unclipped source peaks", async () => {
  const frames = 8200;
  const bytes = wavFixture(16, 2, 48000, frames);
  bytes.fill(0, 44);
  const data = new DataView(bytes.buffer);
  const peaks = new Map([[0, 32767], [1, -32768], [1023, 16384], [4097, -8192], [8199, 24576]]);
  for (const [frame, sample] of peaks) {
    data.setInt16(44 + frame * 4, sample, true);
    data.setInt16(46 + frame * 4, Math.min(32767, -sample), true);
  }
  const { summary } = await scan(bytes, false);
  compare(summary, 2, (f, c) => (c === 0 ? peaks.get(f) ?? 0 : Math.min(32767, -(peaks.get(f) ?? 0))) / 32768);
  const silent = bytes.slice(); silent.fill(0, 44);
  expect(Array.from((await scan(silent, false)).summary.extrema).every(v => v === 0)).toBe(true);
});
