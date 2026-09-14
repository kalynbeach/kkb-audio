import { expect, test } from "bun:test";
import { mediaLoopRegion } from "../src/media-loop";
import { PlaybackOwner } from "../src/playback-owner";
import { FakeMediaLoopPlayback } from "./media-loop-fixture";
import { deferred } from "./playback-fixture";
const analyse=async()=>{throw Error("No fixture waveform");};
test("WAV loop bounds preserve requested and realized grid; reject too-short without rounding expansion",()=>{
  expect(mediaLoopRegion(7001,17004,44100,48000,19007)).toEqual({a:7001,b:17004,pcmA:7621,pcmB:18508,period:10887,fade:240});
  expect(mediaLoopRegion(7001,17004,48000,44100,19007).pcmA).toBe(6433);
  expect(()=>mediaLoopRegion(0,7,48000,48000,10)).toThrow();
  expect(mediaLoopRegion(0,8,48000,48000,10).fade).toBe(2);
  expect(()=>mediaLoopRegion(0,8,399,399,10)).toThrow();
});
test("PlaybackOwner loop edits are inert disabled, preserve paused enable intent, reject invalid region, and use private loop control",async()=>{
  const p=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>p,analyse);
  try{
    await owner.load(new File([],"loop.wav"));expect(owner.getState().loop.enabled).toBe(false);
    await owner.setLoopRegion(48000,96000);expect(p.loopCalls.length).toBe(0);
    await owner.setLoopEnabled(true);expect(p.paused).toBe(true);expect(p.seeks).toEqual([]);expect(owner.getState().snapshot?.pcmPosition).toBe(48000);expect(owner.getState().loop.phase).toBe("Armed");
    const accepted=owner.getState().loop.region;await owner.setLoopRegion(48000,48001);expect(owner.getState().loop.region).toBe(accepted);expect(p.loopCalls.length).toBe(1);
    await owner.setLoopRegion(144000,192000);expect(owner.getState().loop.enabled).toBe(false);expect(p.snapshot.pcmPosition).toBe(48000);expect(p.loopCalls.at(-1)?.edit).toBe(true);
    await owner.play();await owner.setLoopEnabled(true);expect(p.paused).toBe(false);expect(owner.getState().loop.phase).toBe("Active");
  }finally{await owner.close();}
});
test("PlaybackOwner retains only executing and latest loop change; replacement cannot apply queued region",async()=>{
  const p=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>p,analyse);
  try{
    await owner.load(new File([],"loop.wav"));const held=p.pendingLoop=deferred<void>();const first=owner.setLoopEnabled(true);await Bun.sleep(1);
    for(let i=1;i<=20;i++)void owner.setLoopRegion(i*1000,480000);
    expect(p.loopCalls.length).toBe(1);p.pendingLoop=undefined;held.resolve();await first;await Bun.sleep(1);
    expect(p.loopCalls.length).toBe(2);expect(p.loopCalls[1]?.a).toBe(20000);
    const second=p.pendingLoop=deferred<void>();const pending=owner.setLoopEnabled(true);await Bun.sleep(1);void owner.setLoopRegion(30000,470000);await owner.close();second.resolve();await pending;await Bun.sleep(1);expect(owner.getState().phase).toBe("empty");expect(p.loopCalls.length).toBe(3);
  }finally{await owner.close();}
});
test.each(["seek cancels waiting enable", "pause replaces queued enable"] as const)("%s retires intent before disabled editing", async scenario => {
  const playback = new FakeMediaLoopPlayback();
  const owner = new PlaybackOwner(async () => playback, analyse);
  try {
    await owner.load(new File([], "loop.wav"));
    const held = playback.pendingStatus = deferred();
    const poll = owner.refresh();
    const first = scenario === "pause replaces queued enable" ? owner.play() : Promise.resolve();
    const enable = owner.setLoopEnabled(true);
    const last = scenario === "pause replaces queued enable" ? owner.pause() : owner.seek(2.5);
    playback.pendingStatus = undefined;
    held.resolve(playback.snapshot);
    await poll; await first; await enable; await last;
    const deadline = performance.now() + 1000;
    while (owner.getState().busy) {
      if (performance.now() > deadline) throw Error("Control remained busy");
      await Bun.sleep(1);
    }
    expect(owner.getState().loop.enabled).toBe(false);
    expect(playback.loopCalls).toHaveLength(0);
    const pcm = playback.snapshot.pcmPosition;
    await owner.setLoopRegion(48000, 96000);
    expect(owner.getState().loop.enabled).toBe(false);
    expect(playback.loopCalls).toHaveLength(0);
    expect(playback.snapshot.pcmPosition).toBe(pcm);
  } finally { await owner.close(); }
});

test("MP3 shares loop controls and replacement reset; terminal source failure is distinct from LoopUnderrun",async()=>{
  const p=new FakeMediaLoopPlayback();p.anchorAndDiscard=true;const owner=new PlaybackOwner(async()=>p,analyse);
  try{await owner.load(new File([],"fixture.mp3"));expect(owner.getState().loop.supported).toBe(true);await owner.setLoopEnabled(true);expect(p.loopCalls).toHaveLength(1);expect(p.paused).toBe(true);
    p.anchorAndDiscard=false;await owner.load(new File([],"fixture.wav"));expect(owner.getState().loop.enabled).toBe(false);expect(owner.getState().loop.region?.a).toBe(0);await owner.setLoopEnabled(true);
    const revision=owner.getOscilloscopeRevision();p.snapshot={...p.snapshot,loopUnderruns:1,loopRecovering:true,ready:false};await owner.refresh();expect(owner.getState().loop.phase).toBe("Failed");expect(owner.getOscilloscopeRevision()).toBeGreaterThan(revision);
    p.snapshot={...p.snapshot,loopRecovering:false,ready:true};await owner.refresh();expect(owner.getState().loop.phase).toBe("Armed");expect(owner.getState().loop.error).toBeNull();
    p.pendingStatus=deferred();const poll=owner.refresh();p.pendingStatus.reject(Error("media read failed"));await poll;expect(owner.getState().phase).toBe("error");expect(owner.getState().loop.phase).toBe("Failed");expect(owner.getState().loop.error).toContain("retry this track");
  }finally{await owner.close();}
});

test("PlaybackOwner newest edit survives enable waiting for a held poll",async()=>{
  const p=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>p,analyse);
  try{
    await owner.load(new File([],"loop.wav"));
    const held=p.pendingStatus=deferred();const poll=owner.refresh();const enable=owner.setLoopEnabled(true);
    void owner.setLoopRegion(48000,96000);
    expect(owner.getState().loop.region?.a).toBe(48000);
    p.pendingStatus=undefined;held.resolve(p.snapshot);await poll;await enable;await Bun.sleep(1);
    expect(owner.getState().loop.region?.a).toBe(48000);expect(owner.getState().loop.region?.b).toBe(96000);
    expect(p.loopCalls.at(-1)).toMatchObject({a:48000,b:96000,enabled:true,edit:false});
    expect(owner.getState().loop.enabled).toBe(true);expect(p.paused).toBe(true);
  }finally{await owner.close();}
});
test("PlaybackOwner held-poll queue cannot revive R2 after preparing R3 supersedes",async()=>{
  const p=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>p,analyse);
  try{
    await owner.load(new File([],"loop.wav"));await owner.setLoopEnabled(true);
    const heldPoll=p.pendingStatus=deferred();const poll=owner.refresh();
    const first=owner.setLoopRegion(1000,400000);void owner.setLoopRegion(2000,400000);
    const heldHead=p.pendingLoop=deferred<void>();p.pendingStatus=undefined;heldPoll.resolve(p.snapshot);
    await poll;await Bun.sleep(1);const before=p.loopCalls.length;
    const newest=owner.setLoopRegion(3000,400000);p.pendingLoop=undefined;heldHead.resolve();
    await first;await newest;await Bun.sleep(1);
    expect(owner.getState().loop.region?.a).toBe(3000);expect(p.loopCalls.at(-1)?.a).toBe(3000);
    expect(p.loopCalls.length).toBe(before+1);
  }finally{await owner.close();}
});
