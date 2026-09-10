import type { WavPlayback } from "../src/playback-owner";
import type { RenderSnapshot } from "../src/render-adapter";
import type { SeekResult } from "../src/prepared-playback";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class FakePlayback implements WavPlayback {
  totalFrames = 480_000;
  sourceRate = 48_000;
  paused = true;
  ready = { type: "ready" as const, memoryBytes: 16_777_216, memoryPages: 256,
    maximumFrames: 1024, sampleRate: 48000, slotCount: 4 };
  snapshot: RenderSnapshot = {
    epoch: 1, presentationTime: null, ready: true, sourcePosition: 0, pcmPosition: 0,
    renderFrame: 0, ended: false, failureCode: 0, invalidBlockCount: 0, lastFrameCount: 128,
    memoryBytes: 16_777_216, processCount: 0, slotCount: 4, staleBlockCount: 0, starvationCount: 0,
  };
  calls: string[] = [];
  gains: number[] = [];
  seeks: number[] = [];
  closeCount = 0;
  pendingStatus: ReturnType<typeof deferred<RenderSnapshot>> | undefined;
  pendingSeek: ReturnType<typeof deferred<void>> | undefined;
  requesting = false;
  overlaps = 0;
  async status() {
    this.calls.push("status");
    if (this.requesting) this.overlaps++;
    this.requesting = true;
    try { return this.pendingStatus ? await this.pendingStatus.promise : { ...this.snapshot }; }
    finally { this.requesting = false; }
  }
  async play() { this.calls.push("play"); this.paused = false; return this.status(); }
  async pause() { this.calls.push("pause"); this.paused = true; return this.status(); }
  async seek(target: number): Promise<SeekResult> {
    this.calls.push("seek");
    this.seeks.push(target);
    await this.pendingSeek?.promise;
    this.snapshot = { ...this.snapshot, epoch: this.snapshot.epoch + 1,
      sourcePosition: target, pcmPosition: target, ended: target === this.totalFrames };
    return { epoch: this.snapshot.epoch, requestedFrame: target, pcmFrame: target,
      actualMediaFrame: target, result: "Exact" };
  }
  setListeningGain(value: number) { this.gains.push(value); }
  async close() { this.closeCount++; }
}
