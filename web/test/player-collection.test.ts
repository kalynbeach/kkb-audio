import { afterEach, expect, test } from "bun:test";
import { PlayerCollection, SESSION_LIMIT } from "../src/player-collection";
import { PlaybackOwner } from "../src/playback-owner";
import { FakePlayback, deferred } from "./playback-fixture";

const owners: PlaybackOwner[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
function setup(prepare = async (_file: File, _signal: AbortSignal) => new FakePlayback()) {
  const owner = new PlaybackOwner(prepare); owners.push(owner);
  return { owner, collection: new PlayerCollection(owner) };
}
const file = (name = "quiet.wav") => new File(["fixture"], name);

test("bounded admission in picker order retains distinct same-named File references without preparation", () => {
  let prepared = 0;
  const { collection } = setup(async () => { prepared++; return new FakePlayback(); });
  const same = [file(), file()];
  collection.add([same[0]!, file("bad.txt"), same[1]!, ...Array.from({ length: 100 }, (_, i) => file(`${i}.MP3`))]);
  const state = collection.getState();
  expect(state.entries).toHaveLength(SESSION_LIMIT);
  expect(state.entries[0]!.file).toBe(same[0]!);
  expect(state.entries[1]!.file).toBe(same[1]!);
  expect(state.entries[0]!.id).not.toBe(state.entries[1]!.id);
  expect(state.entries.every(entry => entry.duration === null && entry.error === null)).toBe(true);
  expect(state.notice).toContain("Added 100. 1 unsupported; 2 over");
  expect(state.active).toBeNull(); expect(prepared).toBe(0);
  collection.add([file("another.wav")]);
  expect(collection.getState().notice).toContain("Added 0. 0 unsupported; 1 over");
});

test("selection is independent; ordinary activation never autoplays; row play resumes, pauses and replays", async () => {
  const playback = new FakePlayback();
  const { owner, collection } = setup(async () => playback);
  collection.add([file(), file("other.mp3")]);
  const [a, b] = collection.getState().entries;
  collection.select(b!.id);
  await collection.activate(a!.id);
  expect(collection.getState().selected).toBe(b!.id);
  expect(owner.getState().phase).toBe("paused");
  expect(playback.calls).toEqual(["status"]);
  expect(collection.getState().entries[0]!.duration).toBe(10);
  expect(collection.getState().entries[1]!.duration).toBeNull();
  await collection.rowPlay(a!.id); expect(owner.getState().phase).toBe("playing");
  await owner.seek(3);
  await collection.rowPlay(a!.id); expect(owner.getState().phase).toBe("paused");
  await collection.rowPlay(a!.id); expect(playback.seeks).toEqual([144000]);
  await owner.seek(10); expect(owner.getState().phase).toBe("ended");
  await collection.rowPlay(a!.id); expect(playback.seeks).toEqual([144000, 480000, 0]);
  expect(collection.getState().selected).toBe(b!.id);
});

test("previous/next start at zero preserving intent and selection, bounded with no wrap or auto-advance", async () => {
  const prepared: FakePlayback[] = [];
  const { owner, collection } = setup(async () => { const p = new FakePlayback(); prepared.push(p); return p; });
  collection.add([file(), file("b.mp3"), file("c.wav")]);
  const [a, b, c] = collection.getState().entries;
  await collection.move(1); expect(prepared).toHaveLength(0);
  await collection.rowPlay(a!.id);
  await collection.move(-1); expect(prepared).toHaveLength(1);
  await collection.move(1); expect(collection.getState().active).toBe(b!.id);
  expect(owner.getState().phase).toBe("playing"); expect(owner.getState().snapshot!.sourcePosition).toBe(0);
  expect(prepared[0]!.closeCount).toBe(1);
  await owner.pause(); await collection.move(1);
  expect(collection.getState().active).toBe(c!.id); expect(owner.getState().phase).toBe("paused");
  await collection.move(1); expect(prepared).toHaveLength(3);
  await owner.seek(10); await owner.refresh(); expect(collection.getState().active).toBe(c!.id);
  await collection.move(-1); expect(owner.getState().phase).toBe("paused");
  expect(collection.getState().selected).toBe(a!.id);
});

test("inactive removal preserves active playback; active removal closes without successor; clear releases references and preserves gain", async () => {
  const playback = new FakePlayback(); const { owner, collection } = setup(async () => playback);
  collection.add([file(), file("b.wav"), file("c.wav")]);
  const [a, b, c] = collection.getState().entries;
  await collection.rowPlay(a!.id); owner.setMuted(true); owner.setVolume(0.42);
  collection.select(b!.id); await collection.removeSelected();
  expect(collection.getState().selected).toBe(c!.id);
  expect(owner.getState().phase).toBe("playing"); expect(playback.closeCount).toBe(0);
  collection.select(a!.id); await collection.removeSelected();
  expect(collection.getState().selected).toBe(c!.id); expect(collection.getState().active).toBeNull();
  expect(owner.getState().phase).toBe("empty"); expect(playback.closeCount).toBe(1);
  await collection.clear(); expect(collection.getState().entries).toEqual([]);
  expect(owner.getState().muted).toBe(true); expect(owner.getState().volume).toBe(0.42);
});

test.each(["close", "clear", "remove"])('%s cancels pending explicit autoplay and disposes a late result', async action => {
  const held = deferred<FakePlayback>(); let signal!: AbortSignal;
  const { owner, collection } = setup(async (_file, inputSignal) => { signal = inputSignal; return held.promise; });
  collection.add([file()]); const pending = collection.rowPlay(collection.getState().entries[0]!.id);
  await new Promise(resolve => setTimeout(resolve, 0));
  await (action === "remove" ? collection.removeSelected() : action === "clear" ? collection.clear() : collection.close());
  expect(signal.aborted).toBe(true);
  const late = new FakePlayback(); held.resolve(late); await pending;
  expect(late.closeCount).toBe(1); expect(late.calls).not.toContain("play");
  expect(owner.getState().phase).toBe("empty"); expect(collection.getState().active).toBeNull();
});

test("same-name replacement ignores obsolete completion and late rejection, then errors recover by retry", async () => {
  const held = deferred<FakePlayback>(); let count = 0;
  const { owner, collection } = setup(async () => { if (++count === 1) return held.promise; if (count === 3) throw new Error("Bad media"); return new FakePlayback(); });
  collection.add([file(), file()]); const [a, b] = collection.getState().entries;
  const pending = collection.rowPlay(a!.id); await new Promise(resolve => setTimeout(resolve, 0));
  await collection.activate(b!.id); held.reject(new Error("obsolete")); await pending;
  expect(collection.getState().active).toBe(b!.id); expect(owner.getState().phase).toBe("paused");
  expect(collection.getState().entries[0]!.duration).toBeNull();
  await collection.rowPlay(a!.id); expect(owner.getState().phase).toBe("error");
  expect(collection.getState().entries[0]!.error).toBe("Bad media");
  collection.select(b!.id); await collection.rowPlay(a!.id);
  expect(owner.getState().phase).toBe("playing"); expect(collection.getState().entries[0]!.error).toBeNull();
  expect(collection.getState().selected).toBe(b!.id);
});

test("rapid next during preparation preserves explicit playing intent, not the stale request", async () => {
  const held = deferred<FakePlayback>(); let count = 0;
  const { owner, collection } = setup(async () => ++count === 1 ? held.promise : new FakePlayback());
  collection.add([file(), file("next.wav")]); const [a, b] = collection.getState().entries;
  const pending = collection.rowPlay(a!.id); await new Promise(resolve => setTimeout(resolve, 0));
  await collection.move(1); expect(owner.getState().phase).toBe("playing");
  const late = new FakePlayback(); held.resolve(late); await pending;
  expect(collection.getState().active).toBe(b!.id); expect(late.closeCount).toBe(1); expect(late.calls).toEqual([]);
});
