import { expect, test } from "bun:test";
import { MAX_WAVEFORM_BINS, WaveformAccumulator, waveformPath } from "../src/source-waveform";
import { PlaybackOwner } from "../src/playback-owner";
import { FakePlayback, deferred } from "./playback-fixture";
import type { SourceWaveform } from "../src/source-waveform";

function summary(frames = 1) {
  const accumulator = new WaveformAccumulator(frames, 48000);
  accumulator.push(new Float32Array(frames), 1);
  return accumulator.finish();
}
test("source-waveform silence, short tracks, channel extrema and partial source bins", () => {
  expect(Array.from(summary(3).extrema)).toEqual([0, 0, 0, 0, 0, 0]);
  const a = new WaveformAccumulator(8193, 48000);
  expect(a.framesPerBin).toBe(3);
  for (let offset = 0; offset < 8193; offset += 1024) {
    const n = Math.min(1024, 8193 - offset), pcm = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { pcm[i] = 0.5; pcm[n + i] = -0.5; }
    if (offset === 0) { pcm[1] = 1; pcm[n + 2] = -1; }
    a.push(pcm, 2);
  }
  const result = a.finish();
  expect(Array.from(result.extrema.slice(0, 4))).toEqual([-1, 1, -0.5, 0.5]);
  expect(Array.from(result.extrema.slice(-2))).toEqual([-0.5, 0.5]);
  const partial = new WaveformAccumulator(8194, 48000);
  for (let offset = 0; offset < 8194; offset += 1024) partial.push(new Float32Array(Math.min(1024, 8194 - offset)).fill(offset === 8192 ? 0.25 : 0), 1);
  expect(Array.from(partial.finish().extrema.slice(-2))).toEqual([0.25, 0.25]);
});
test("source-waveform bounds, invalid chunks and complete-only publication", () => {
  const a = new WaveformAccumulator(0xffffffff, 48000);
  expect(a.extrema.byteLength).toBeLessThanOrEqual(MAX_WAVEFORM_BINS * 8);
  expect(() => a.finish()).toThrow("Incomplete");
  expect(() => a.push(new Float32Array(2049), 2)).toThrow();
  expect(() => a.push(new Float32Array([NaN]), 1)).toThrow();
  expect(() => new WaveformAccumulator(0, 48000)).toThrow();
});
test("source-waveform display reduction preserves every impulse, including boundary and partial bins", () => {
  for (const bin of [0, 1, 24, 25, 26, 4094, 4095]) {
    const extrema = new Float32Array(8192);
    extrema[bin * 2] = -1; extrema[bin * 2 + 1] = 0.5;
    const path = waveformPath({ totalFrames: 8191, sourceRate: 48000, framesPerBin: 2, extrema });
    expect(path.split("M").length - 1).toBe(160);
    expect(path).toContain(",11.50v25.50");
  }
});
test("waveform lifecycle is independent of play, seek, volume; failures never fail playback", async () => {
  const playback = new FakePlayback(), job = deferred<SourceWaveform>();
  let calls = 0;
  const owner = new PlaybackOwner(async () => playback, async () => { calls++; return job.promise; });
  await owner.load(new File([], "same.wav"));
  expect(owner.getState().waveformPhase).toBe("pending");
  await owner.play(); await owner.pause(); await owner.seek(2); owner.setVolume(0.3); owner.setMuted(true);
  expect(calls).toBe(1);
  expect(owner.getState().phase).toBe("paused");
  job.reject(new Error("analysis failed"));
  await Bun.sleep(0);
  expect(owner.getState().waveformPhase).toBe("failed");
  expect(owner.getState().error).toBeNull();
  await owner.play(); expect(owner.getState().phase).toBe("playing");
  await owner.close();
});
test.each([false, true])("waveform same-name replacement and close reject late jobs (rejection=%s)", async reject => {
  const jobs: ReturnType<typeof deferred<SourceWaveform>>[] = [], signals: AbortSignal[] = [];
  const owner = new PlaybackOwner(async () => new FakePlayback(), async (_file, _frames, _rate, signal) => {
    const job = deferred<SourceWaveform>(); jobs.push(job); signals.push(signal); return job.promise;
  });
  await owner.load(new File(["a"], "same.wav"));
  const replacement = owner.load(new File(["b"], "same.wav"));
  expect(signals[0]!.aborted).toBe(true); await replacement;
  if (reject) jobs[0]!.reject(new Error("late")); else jobs[0]!.resolve(summary());
  await Bun.sleep(0); expect(owner.getState().waveformPhase).toBe("pending");
  const complete = summary(); jobs[1]!.resolve(complete); await Bun.sleep(0);
  expect(owner.getState().waveform).toBe(complete);
  await owner.seek(1); owner.setMuted(true);
  expect(owner.getState().waveform).toBe(complete); expect(jobs.length).toBe(2);
  await owner.load(new File(["c"], "same.wav"));
  await owner.close(); expect(signals[2]!.aborted).toBe(true);
  if (reject) jobs[2]!.reject(new Error("late close")); else jobs[2]!.resolve(summary());
  await Bun.sleep(0); expect(owner.getState().waveform).toBeNull(); expect(owner.getState().phase).toBe("empty");
});
