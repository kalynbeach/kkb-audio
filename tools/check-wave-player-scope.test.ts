import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { observePlaybackScope } from "../web/src/wave-player-scope";
import { PlaybackOwner } from "../web/src/playback-owner";
import { FakePlayback, deferred } from "../web/test/playback-fixture";
import type { PlaybackScope } from "../web/src/wave-scope/playback-scope";
import type { OscilloscopeBuffers, OscilloscopeRead } from "../web/src/oscilloscope-tap";

GlobalRegistrator.register({ url: "http://localhost/wave-player.html" });
let callbacks = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let motion = new EventTarget() as MediaQueryList;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  callbacks = new Map(); nextFrame = 0;
  globalThis.requestAnimationFrame = callback => { callbacks.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = handle => { callbacks.delete(handle); };
  motion = new EventTarget() as MediaQueryList;
  Object.defineProperty(motion, "matches", { configurable: true, value: false });
  globalThis.matchMedia = () => motion;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { for (const cleanup of cleanups.reverse()) cleanup(); cleanups = []; });
afterAll(() => GlobalRegistrator.unregister());
const step = (time: number) => {
  const pending = [...callbacks.values()]; callbacks.clear();
  for (const callback of pending) callback(time);
};
class VisualPlayback extends FakePlayback {
  reads = 0;
  releases = 0;
  result: OscilloscopeRead = 2;
  readOscilloscope = (buffers: OscilloscopeBuffers): OscilloscopeRead => {
    this.reads++; buffers[0].fill(0.25); buffers[1].fill(-0.5); return this.result;
  };
  releaseOscilloscope = () => { this.releases++; };
}
async function setup() {
  const playback = new VisualPlayback();
  const owner = new PlaybackOwner(async () => playback, async () => { throw Error("No fixture waveform"); });
  await owner.load(new File([], "study.wav")); await owner.play();
  cleanups.push(() => { void owner.close(); });
  const canvas = document.createElement("canvas");
  const counts = { draw: 0, clear: 0, destroy: 0, present: 0 };
  const renderer: PlaybackScope = {
    draw(left, right, channels) {
      expect(channels).toBe(2); expect(left[0]).toBe(0.25); expect(right[0]).toBe(-0.5); counts.draw++;
    },
    resize() {}, present() { counts.present++; }, clear() { counts.clear++; }, destroy() { counts.destroy++; },
  };
  let label = "";
  const report = (status: { label: string }) => { label = status.label; };
  return { owner, playback, canvas, renderer, counts, report, label: () => label };
}

test("real owner phase/revision changes freeze, clear and resume only fresh observations", async () => {
  const fixture = await setup(); const { owner, playback, canvas, renderer, counts, report } = fixture;
  const dispose = observePlaybackScope(canvas, owner, false, report, async () => renderer); cleanups.push(dispose.dispose);
  await Promise.resolve(); step(0); step(10); step(40);
  expect(counts.draw).toBe(2); expect(canvas.hidden).toBe(false);
  await owner.pause(); step(80); expect(counts.draw).toBe(2); expect(fixture.label()).toContain("last observed");
  const frozenReads = playback.reads;
  dispose.repaint(); expect(counts.present).toBe(1); expect(playback.reads).toBe(frozenReads);
  await owner.seek(2); expect(canvas.hidden).toBe(true); expect(fixture.label()).toContain("Play to observe");
  const reads = playback.reads; step(200); expect(playback.reads).toBe(reads);
  await owner.play(); step(240); expect(counts.draw).toBe(3);
  await owner.seek(10); expect(fixture.label()).toContain("Ended"); expect(canvas.hidden).toBe(true);
});

test("hidden and reduced motion stop reads; visibility resumes without starting audio", async () => {
  const fixture = await setup(); const { owner, playback, canvas, renderer, counts, report } = fixture;
  cleanups.push(observePlaybackScope(canvas, owner, false, report, async () => renderer).dispose);
  await Promise.resolve(); step(0); const reads = playback.reads;
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange")); step(100);
  expect(playback.reads).toBe(reads); expect(playback.releases).toBeGreaterThan(0); expect(canvas.hidden).toBe(true);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(motion, "matches", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange")); step(200);
  expect(fixture.label()).toContain("Reduced motion"); expect(playback.reads).toBe(reads);
  const clears = counts.clear;
  await owner.refresh(); await owner.refresh(); step(250);
  expect(counts.clear).toBe(clears); expect(playback.reads).toBe(reads);
  Object.defineProperty(motion, "matches", { configurable: true, value: false }); motion.dispatchEvent(new Event("change"));
  step(300); expect(playback.reads).toBe(reads + 1); expect(playback.calls.filter(call => call === "play")).toHaveLength(1);
});

test("visual pause stops reads and resumes on the same renderer", async () => {
  const fixture = await setup(); const { owner, playback, canvas, renderer, counts, report } = fixture;
  let creates = 0;
  const view = observePlaybackScope(canvas, owner, false, report, async () => { creates++; return renderer; });
  cleanups.push(view.dispose);
  await Promise.resolve(); step(0); const reads = playback.reads;
  view.setPaused(true); step(100);
  expect(playback.reads).toBe(reads); expect(canvas.hidden).toBe(true); expect(fixture.label()).toContain("Visual paused");
  view.setPaused(false); step(200);
  expect(playback.reads).toBe(reads + 1); expect(creates).toBe(1); expect(counts.destroy).toBe(0);
});

test("warming observations respect the same 30 Hz read bound", async () => {
  const { owner, playback, canvas, renderer, counts, report } = await setup();
  playback.result = "warming";
  cleanups.push(observePlaybackScope(canvas, owner, false, report, async () => renderer).dispose);
  await Promise.resolve(); step(0); step(10); step(20); step(30);
  expect(playback.reads).toBe(1); expect(counts.draw).toBe(0);
  step(40); expect(playback.reads).toBe(2);
  playback.result = 2;
  step(60); expect(counts.draw).toBe(0);
  step(80); expect(playback.reads).toBe(3); expect(counts.draw).toBe(1);
});

test("late GPU initialization is destroyed after unmount without reading playback", async () => {
  const { owner, playback, canvas, renderer, counts, report } = await setup();
  const pending = deferred<PlaybackScope>();
  let signal: AbortSignal | undefined;
  const dispose = observePlaybackScope(canvas, owner, false, report, (_canvas, _failure, cancellation) => {
    signal = cancellation; return pending.promise;
  });
  dispose.dispose(); pending.resolve(renderer); await Promise.resolve(); step(100);
  expect(signal?.aborted).toBe(true);
  expect(counts.destroy).toBe(1); expect(playback.reads).toBe(0); expect(callbacks.size).toBe(0);
});

test.each(["setup", "read", "draw", "device"])("%s failure remains visual-only", async kind => {
  const fixture = await setup(); const { owner, playback, canvas, renderer, report } = fixture;
  let failure: ((error: unknown) => void) | undefined;
  if (kind === "read") playback.result = "unavailable";
  if (kind === "draw") renderer.draw = () => { throw Error("GPU draw failed"); };
  cleanups.push(observePlaybackScope(canvas, owner, false, report, async (_canvas, onFailure) => {
    failure = onFailure;
    if (kind === "setup") throw Error("No WebGPU");
    return renderer;
  }).dispose);
  await Promise.resolve(); step(0);
  if (kind === "device") failure?.(Error("Device lost"));
  await owner.refresh();
  expect(fixture.label()).toContain("Visual unavailable"); expect(canvas.hidden).toBe(true);
  expect(owner.getState().phase).toBe("playing"); expect(playback.closeCount).toBe(0); expect(callbacks.size).toBe(0);
});

test("repeated mounts dispose each visual without closing or multiplying playback", async () => {
  const { owner, playback, canvas, renderer, counts, report } = await setup();
  for (let i = 0; i < 5; i++) {
    const dispose = observePlaybackScope(canvas, owner, false, report, async () => renderer);
    await Promise.resolve(); step(i * 100); dispose.dispose();
    expect(callbacks.size).toBe(0);
  }
  expect(counts.destroy).toBe(5); expect(playback.closeCount).toBe(0); expect(owner.getState().phase).toBe("playing");
});
