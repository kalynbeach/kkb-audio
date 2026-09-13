import { describe, expect, test } from "bun:test";
import { initialSession, sessionReducer as reduce } from "../src/player-prototype-state";

describe("#21 silent interaction study", () => {
  test("row selection leaves paused or playing state, position and loop untouched", () => {
    for (const state of [initialSession(), reduce(initialSession(), { type: "play" })]) {
      const selected = reduce(state, { type: "select", id: "map" });
      expect(selected).toEqual({ ...state, selected: "map" });
    }
  });

  test("row play starts the requested track from paused or playing without changing selection", () => {
    for (const state of [initialSession(), reduce(initialSession(), { type: "play" })]) {
      const playing = reduce(state, { type: "activate", id: "map", playing: true });
      expect([playing.loaded, playing.selected, playing.phase, playing.position]).toEqual(["map", "glass", "playing", 0]);
      expect(playing.loop).toEqual({ a: 0, b: 527, enabled: false, phase: "ready" });
    }
  });

  test("enabling outside a region moves to A without starting playback", () => {
    const region = reduce(initialSession(), { type: "region", a: 120, b: 180 });
    const enabled = reduce(region, { type: "loop", enabled: true });
    expect([enabled.position, enabled.phase, enabled.loop.enabled]).toEqual([120, "paused", true]);
    expect(reduce(reduce(enabled, { type: "play" }), { type: "loop", enabled: false }).phase).toBe("playing");
  });

  test("seeking or editing outside an active loop disables it but retains the region", () => {
    const enabled = reduce(reduce(initialSession(), { type: "region", a: 48, b: 96 }), { type: "loop", enabled: true });
    const sought = reduce(enabled, { type: "seek", position: 200 });
    expect(sought.loop).toEqual({ a: 48, b: 96, enabled: false, phase: "ready" });
    expect(sought.phase).toBe("paused");
    const edited = reduce(enabled, { type: "region", a: 100, b: 120 });
    expect([edited.position, edited.loop.enabled]).toEqual([84, false]);
  });

  test("one-second prototype interval bounds and whole-track reset remain valid", () => {
    const bounded = reduce(initialSession(), { type: "region", a: 900, b: -10 });
    expect([bounded.loop.a, bounded.loop.b]).toEqual([271, 272]);
    const reset = reduce(bounded, { type: "region", a: 0, b: 272 });
    expect([reset.loop.a, reset.loop.b]).toEqual([0, 272]);
  });

  test("ready loop wraps, preparation does not masquerade as effective looping, replay starts at zero", () => {
    let state = reduce(initialSession(), { type: "region", a: 48, b: 96 });
    state = reduce(state, { type: "loop", enabled: true });
    state = reduce(state, { type: "seek", position: 95.9 });
    state = reduce(state, { type: "play" });
    expect(reduce(state, { type: "tick" }).position).toBe(48);
    expect(reduce(reduce(state, { type: "loop-phase", phase: "preparing" }), { type: "tick" }).position).toBe(96.15);
    const ended = reduce(state, { type: "seek", position: 272 });
    expect(ended.phase).toBe("ended");
    expect(reduce(ended, { type: "play" }).position).toBe(0);
  });

  test("current-track play resumes; pause retains position; ended row play restarts", () => {
    const state = reduce(initialSession(), { type: "region", a: 48, b: 96 });
    const playing = reduce(state, { type: "activate", id: "tide", playing: true });
    expect([playing.phase, playing.position, playing.loop]).toEqual(["playing", 84, state.loop]);
    const paused = reduce(playing, { type: "play" });
    expect([paused.phase, paused.position]).toEqual(["paused", 84]);
    const replay = reduce(reduce(paused, { type: "seek", position: 272 }), { type: "activate", id: "tide", playing: true });
    expect([replay.phase, replay.position]).toEqual(["playing", 0]);
  });

  test("error/loading simulation can recover without an automatic play", () => {
    const failed = reduce(initialSession(), { type: "activate", id: "night", playing: true });
    expect(failed.phase).toBe("error");
    expect(reduce(failed, { type: "play" }).phase).toBe("error");
    const loading = reduce(failed, { type: "scenario", phase: "loading" });
    const recovered = reduce(loading, { type: "scenario", phase: "paused" });
    expect(recovered.tracks.find(track => track.id === "night")?.failed).toBe(false);
    expect(recovered.phase).toBe("paused");
    const empty = reduce(recovered, { type: "scenario", phase: "empty" });
    expect([empty.loaded, reduce(empty, { type: "play" }).phase]).toEqual([null, "empty"]);
  });
});
