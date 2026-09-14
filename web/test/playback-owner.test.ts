import { afterEach, expect, test } from "bun:test";
import { PlaybackOwner, sourceFrameAtSeconds } from "../src/playback-owner";
import { FakePlayback, deferred } from "./playback-fixture";

const owners: PlaybackOwner[] = [];
const file = new File([], "first.wav");
function setup(prepare = async () => new FakePlayback()) {
  const owner = new PlaybackOwner(prepare);
  owners.push(owner);
  return owner;
}
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("one clamp and nearest-source-frame rule includes both endpoints and half frames", () => {
  expect(sourceFrameAtSeconds(-1, 44100, 10003)).toBe(0);
  expect(sourceFrameAtSeconds(0, 44100, 10003)).toBe(0);
  expect(sourceFrameAtSeconds(0.5 / 44100, 44100, 10003)).toBe(1);
  expect(sourceFrameAtSeconds(10003 / 44100, 44100, 10003)).toBe(10003);
  expect(sourceFrameAtSeconds(100, 44100, 10003)).toBe(10003);
  expect(() => sourceFrameAtSeconds(NaN, 44100, 10003)).toThrow();
});

test("load stays paused; periodic updates use consumed cursor, never render clock or read-ahead", async () => {
  const playback = new FakePlayback();
  const owner = setup(async () => playback);
  await owner.load(file);
  expect(owner.getState().phase).toBe("paused");
  expect(playback.calls).toEqual(["status"]);
  expect(playback.gains).toEqual([0.15]);
  await owner.play();
  playback.snapshot = { ...playback.snapshot, sourcePosition: 123, pcmPosition: 134, renderFrame: 5000 };
  await new Promise(resolve => setTimeout(resolve, 130));
  expect(owner.getState().snapshot?.sourcePosition).toBe(123);
  playback.snapshot = { ...playback.snapshot, renderFrame: 9000, starvationCount: 30 };
  await owner.refresh();
  expect(owner.getState().snapshot?.sourcePosition).toBe(123);
  expect(owner.getState().snapshot?.renderFrame).toBe(9000);
  await owner.pause();
  expect(owner.getState().phase).toBe("paused");
  await new Promise(resolve => setTimeout(resolve, 130));
  expect(owner.getState().snapshot?.sourcePosition).toBe(123);
  await owner.play();
  expect(owner.getState().phase).toBe("playing");
});

test.each(["play", "pause", "seek"] as const)("polls coalesce and %s waits without overlapping snapshots", async action => {
  const playback = new FakePlayback();
  const owner = setup(async () => playback);
  await owner.load(file);
  const held = playback.pendingStatus = deferred();
  const first = owner.refresh();
  expect(owner.refresh()).toBe(first);
  const command = action === "seek" ? owner.seek(2) : owner[action]();
  expect(owner.refresh()).toBe(command);
  await tick();
  expect(playback.calls).toEqual(["status", "status"]);
  playback.pendingStatus = undefined;
  held.resolve({ ...playback.snapshot });
  await command;
  expect(playback.overlaps).toBe(0);
  expect(playback.calls).toContain(action);
  expect(owner.getState().busy).toBe(false);
});

test.each([true, false])("seek waits for readiness and preserves paused=%s; replay seeks zero then plays", async paused => {
  const playback = new FakePlayback();
  const owner = setup(async () => playback);
  await owner.load(file);
  if (!paused) await owner.play();
  const held = playback.pendingSeek = deferred();
  const seek = owner.seek(3);
  await tick();
  expect(owner.getState().phase).toBe("seeking");
  expect(owner.getState().snapshot?.sourcePosition).toBe(0);
  expect(owner.getState().busy).toBe(true);
  held.resolve();
  await seek;
  expect(owner.getState().phase).toBe(paused ? "paused" : "playing");
  expect(owner.getState().snapshot?.sourcePosition).toBe(144000);
  await owner.seek(10);
  expect(owner.getState().phase).toBe("ended");
  playback.calls = [];
  await owner.play();
  expect(playback.seeks).toEqual([144000, 480000, 0]);
  expect(playback.calls).toEqual(["seek", "play", "status"]);
  expect(owner.getState().phase).toBe("playing");
  expect(owner.getState().snapshot?.sourcePosition).toBe(0);
});

test("volume and mute retain level and position without lifecycle or command work", async () => {
  const playback = new FakePlayback();
  const owner = setup(async () => playback);
  await owner.load(file);
  await owner.seek(2);
  playback.calls = [];
  owner.setVolume(0.4);
  owner.setMuted(true);
  owner.setVolume(0.3);
  owner.setMuted(false);
  expect(playback.gains).toEqual([0.15, 0.4, 0, 0, 0.3]);
  expect(playback.calls).toEqual([]);
  expect(playback.closeCount).toBe(0);
  expect(owner.getState().snapshot?.sourcePosition).toBe(96000);
  expect(owner.getState().volume).toBe(0.3);
});

test.each(["close", "replace"] as const)("late preparation after %s is cancelled and disposed without reviving UI", async action => {
  const old = new FakePlayback();
  const next = new FakePlayback();
  const held = deferred<FakePlayback>();
  let signal!: AbortSignal;
  let count = 0;
  const owner = new PlaybackOwner(async (_file, abort) => {
    if (count++ === 0) { signal = abort; return held.promise; }
    return next;
  });
  owners.push(owner);
  const loading = owner.load(file);
  await tick();
  if (action === "close") await owner.close();
  else await owner.load(new File([], "next.wav"));
  expect(signal.aborted).toBe(true);
  held.resolve(old);
  await loading;
  expect(old.closeCount).toBe(1);
  expect(owner.getState().phase).toBe(action === "close" ? "empty" : "paused");
  expect(owner.getState().fileName).toBe(action === "close" ? "" : "next.wav");
  expect(old.calls).toEqual([]);
});

test.each([
  ["status", "replace"], ["seek", "replace"], ["status", "close"], ["seek", "close"],
] as const)("late %s completion after %s cannot restore old cursor/state", async (operation, transition) => {
  const old = new FakePlayback();
  const next = new FakePlayback();
  let count = 0;
  const owner = setup(async () => count++ === 0 ? old : next);
  await owner.load(file);
  const status = old.pendingStatus = deferred();
  const seek = old.pendingSeek = deferred();
  const pending = operation === "status" ? owner.refresh() : owner.seek(8);
  await tick();
  if (transition === "replace") await owner.load(new File([], "next.wav"));
  else await owner.close();
  seek.resolve();
  status.resolve({ ...old.snapshot, sourcePosition: 999 });
  await pending;
  expect(owner.getState().fileName).toBe(transition === "replace" ? "next.wav" : "");
  expect(owner.getState().snapshot?.sourcePosition).toBe(transition === "replace" ? 0 : undefined);
  expect(owner.getState().phase).toBe(transition === "replace" ? "paused" : "empty");
  expect(old.closeCount).toBe(1);
});

test("malformed/unsupported preparation and runtime failures recover on a new load", async () => {
  const playback = new FakePlayback();
  let attempts = 0;
  const owner = setup(async () => {
    if (attempts++ === 0) throw new Error("Unsupported or malformed WAV");
    return playback;
  });
  await owner.load(file);
  expect(owner.getState().phase).toBe("error");
  expect(owner.getState().error).toContain("malformed");
  await owner.load(file);
  expect(owner.getState().phase).toBe("paused");
  const held = playback.pendingStatus = deferred();
  const status = owner.refresh();
  held.reject(new Error("Worklet failed"));
  await status;
  expect(owner.getState().phase).toBe("error");
  expect(playback.closeCount).toBe(1);
  playback.pendingStatus = undefined;
  await owner.load(file);
  expect(owner.getState().error).toBeNull();
});

test("consumed EOS acknowledges suspension; seeking away stays paused until explicit Play", async () => {
  const playback = new FakePlayback();
  const owner = setup(async () => playback);
  await owner.load(file);
  await owner.play();
  playback.snapshot = { ...playback.snapshot, ended: true, sourcePosition: playback.totalFrames };
  await owner.refresh();
  expect(owner.getState().phase).toBe("ended");
  expect(playback.paused).toBe(true);
  await owner.seek(3);
  expect(owner.getState().phase).toBe("paused");
  expect(playback.paused).toBe(true);
  await owner.play();
  await owner.seek(10);
  expect(owner.getState().phase).toBe("ended");
  expect(playback.paused).toBe(true);
  await owner.seek(0);
  expect(owner.getState().phase).toBe("paused");
  expect(playback.paused).toBe(true);
});

test("oscilloscope revisions reject old consumers across held seek, replacement, close and visual-only failure", async () => {
  let reads = 0; let releases = 0;
  const playback = Object.assign(new FakePlayback(), {
    readOscilloscope: () => { reads++; return 2 as const; },
    releaseOscilloscope: () => { releases++; },
  });
  const owner = setup(async () => playback);
  const buffers = [new Float32Array(2048), new Float32Array(2048)] as const;
  await owner.load(file); const first = owner.getOscilloscopeRevision();
  expect(owner.readOscilloscope(first, buffers)).toBe("warming"); expect(reads).toBe(0);
  await owner.play(); expect(owner.readOscilloscope(first, buffers)).toBe(2);
  playback.pendingSeek = deferred(); const seek = owner.seek(3); await tick();
  expect(owner.getOscilloscopeRevision()).not.toBe(first);
  expect(owner.readOscilloscope(first, buffers)).toBe("warming"); expect(reads).toBe(1);
  playback.pendingSeek.resolve(); await seek;
  expect(owner.readOscilloscope(first, buffers)).toBe("warming");
  const second = owner.getOscilloscopeRevision(); expect(owner.readOscilloscope(second, buffers)).toBe(2);
  await owner.load(new File([], "first.wav")); await owner.play();
  expect(owner.readOscilloscope(second, buffers)).toBe("warming");
  playback.readOscilloscope = () => { throw new Error("visual only"); };
  expect(owner.readOscilloscope(owner.getOscilloscopeRevision(), buffers)).toBe("unavailable");
  expect(owner.getState().phase).toBe("playing"); expect(owner.getState().error).toBeNull();
  expect(releases).toBeGreaterThan(0);
  await owner.close(); expect(owner.readOscilloscope(owner.getOscilloscopeRevision(), buffers)).toBe("warming");
});
