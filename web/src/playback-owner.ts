import { emptyMediaLoop, mediaLoopRegion, type MediaLoopState, type MediaLoopRegion } from "./media-loop";
import type { OscilloscopeBuffers, OscilloscopeRead } from "./oscilloscope-tap";
import { prepareProof, type PreparedProof, type SeekResult } from "./prepared-playback";
import { prepareWaveform, type PrepareWaveform } from "./prepare-waveform";
import type { SourceWaveform } from "./source-waveform";
import { PreparationLifecycle } from "./preparation-lifecycle";
import type { RenderSnapshot } from "./render-adapter";

// Private consumer seam, not a published session or command API.
export type WavPlayback = Pick<PreparedProof,
  "close" | "play" | "pause" | "seek" | "status" | "setListeningGain" |
  "totalFrames" | "sourceRate" | "paused" | "ready"> &
  Partial<Pick<PreparedProof, "readOscilloscope" | "releaseOscilloscope" | "setLoop" | "anchorAndDiscard">>;
type LoopControl = { region: MediaLoopRegion; enabled: boolean; edit?: boolean };
type PrepareWav = (file: File, signal: AbortSignal) => Promise<WavPlayback>;
export type PlaybackState = {
  loop: MediaLoopState;
  phase: "empty" | "loading" | "paused" | "playing" | "seeking" | "ended" | "error";
  fileName: string;
  totalFrames: number;
  sourceRate: number;
  outputRate: number;
  snapshot: RenderSnapshot | null;
  seekResult: SeekResult | null;
  busy: boolean;
  error: string | null;
  volume: number;
  muted: boolean;
  waveform: SourceWaveform | null;
  waveformPhase: "empty" | "pending" | "complete" | "failed";
};

/** Clamp seconds to the closed media interval, then round to the nearest source
 * frame (half frames round upward). Zero and exact duration map to exact endpoints. */
export function sourceFrameAtSeconds(seconds: number, sourceRate: number, totalFrames: number): number {
  if (!Number.isFinite(seconds)) throw new Error("Seek time must be finite");
  return Math.round(Math.min(totalFrames, Math.max(0, seconds * sourceRate)));
}

const emptyState: PlaybackState = {
  phase: "empty", fileName: "", totalFrames: 0, sourceRate: 0, outputRate: 0,
  snapshot: null, seekResult: null, busy: false, error: null, volume: 0.15, muted: false,
  waveform: null, waveformPhase: "empty", loop: emptyMediaLoop,
};

export class PlaybackOwner {
  #state = emptyState;
  #listeners = new Set<() => void>();
  #lifecycle = new PreparationLifecycle<WavPlayback>();
  #generation = 0;
  #visualRevision = 0;
  #poll: Promise<void> | undefined;
  #command: Promise<void> | undefined;
  #pendingControl: { action: string; revision: number; run: () => Promise<void> } | undefined;
  #requestRevision = 0;
  #loopIntent: LoopControl | undefined;
  #controlRevision = 0;
  #commandPreparing = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  #analysis: AbortController | undefined;

  constructor(private readonly prepare: PrepareWav = (file, signal) =>
    prepareProof({ file, signal, channelCount: 2, maximumFrames: 1024 }),
    private readonly analyse: PrepareWaveform = prepareWaveform) {}

  getState = (): PlaybackState => this.#state;
  getOscilloscopeRevision = (): number => this.#visualRevision;
  readOscilloscope = (revision: number, buffers: OscilloscopeBuffers): OscilloscopeRead => {
    if (revision !== this.#visualRevision || this.#state.phase !== "playing" || this.#state.busy) return "warming";
    try { return this.#lifecycle.active?.readOscilloscope?.(buffers) ?? "unavailable"; }
    catch { this.releaseOscilloscope(); return "unavailable"; }
  };
  releaseOscilloscope = (): void => {
    try { this.#lifecycle.active?.releaseOscilloscope?.(); } catch { /* visual-only cleanup */ }
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #publish(patch: Partial<PlaybackState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  async load(file: File): Promise<void> {
    const generation = ++this.#generation;
    ++this.#visualRevision;
    this.#analysis?.abort();
    this.#analysis = undefined;
    this.#stopPolling();
    const previous = this.#lifecycle;
    // A cancelled preparation may still be unwinding. Its existing lifecycle owns
    // disposal of late results; it must not block a replacement's preparation.
    const lifecycle = this.#lifecycle = new PreparationLifecycle<WavPlayback>();
    this.#poll = undefined;
    this.#command = undefined;
    this.#pendingControl = undefined;
    this.#loopIntent = undefined;
    this.#commandPreparing = false;
    this.#publish({ ...emptyState, volume: this.#state.volume, muted: this.#state.muted,
      phase: "loading", fileName: file.name, busy: true });
    try {
      await previous.closeActive();
      if (generation !== this.#generation) return;
      const playback = await lifecycle.tryReplace(signal => this.prepare(file, signal))!;
      if (generation !== this.#generation) return;
      playback.setListeningGain(this.#state.muted ? 0 : this.#state.volume);
      const snapshot = await playback.status();
      if (generation !== this.#generation) return;
      this.#publish({ totalFrames: playback.totalFrames!, sourceRate: playback.sourceRate!,
        outputRate: playback.ready.sampleRate, busy: false });
      let loop = emptyMediaLoop;
      if (playback.setLoop) {
        try { loop = { ...emptyMediaLoop, supported: true, region: mediaLoopRegion(0, playback.totalFrames!, playback.sourceRate!, playback.ready.sampleRate, playback.totalFrames!) }; }
        catch (error) { loop = { ...emptyMediaLoop, error: String(error) }; }
      }
      this.#publish({ loop });
      this.#accept(snapshot, playback);
      this.#timer = setInterval(() => { void this.refresh(); }, 100);
      const analysis = this.#analysis = new AbortController();
      this.#publish({ waveformPhase: "pending" });
      void Promise.resolve().then(() => this.analyse(file, playback.totalFrames!, playback.sourceRate!, analysis.signal)).then(waveform => {
        if (generation === this.#generation && !analysis.signal.aborted) this.#publish({ waveform, waveformPhase: "complete" });
      }).catch(() => {
        if (generation === this.#generation && !analysis.signal.aborted) this.#publish({ waveform: null, waveformPhase: "failed" });
      });
    } catch (error) { await this.#fail(error, generation); }
  }

  async close(): Promise<void> {
    ++this.#generation;
    ++this.#visualRevision;
    this.#analysis?.abort();
    this.#analysis = undefined;
    this.#stopPolling();
    this.#poll = undefined;
    this.#command = undefined;
    this.#pendingControl = undefined;
    this.#loopIntent = undefined;
    this.#commandPreparing = false;
    this.#publish({ ...emptyState, volume: this.#state.volume, muted: this.#state.muted });
    await this.#lifecycle.closeActive();
  }

  /** One in-flight poll, never overlapping a playback command's own snapshots. */
  refresh(): Promise<void> {
    if (this.#command) return this.#command;
    if (this.#poll) return this.#poll;
    const playback = this.#lifecycle.active;
    if (!playback || this.#state.busy || this.#state.phase === "error") return Promise.resolve();
    const generation = this.#generation;
    const poll = playback.status().then(async snapshot => {
      if (generation !== this.#generation) return;
      // EOS is terminal, not a still-playing seek origin. Replay is explicit.
      if (snapshot.ended && !playback.paused) snapshot = await playback.pause();
      if (generation === this.#generation) {
        if (this.#state.busy && this.#state.phase === "seeking") this.#publish({ snapshot });
        else this.#accept(snapshot, playback);
      }
    }).catch(error => this.#fail(error, generation)).finally(() => {
      if (this.#poll === poll) this.#poll = undefined;
    });
    this.#poll = poll;
    return poll;
  }

  play(): Promise<void> { return this.#control("play"); }
  pause(): Promise<void> { return this.#control("pause"); }
  seek(seconds: number): Promise<void> {
    return this.#control("seek", sourceFrameAtSeconds(seconds, this.#state.sourceRate, this.#state.totalFrames));
  }

  setLoopEnabled(enabled: boolean): Promise<void> {
    const region = this.#state.loop.region;
    if (!region || !this.#state.loop.supported) return Promise.resolve();
    return this.#control("loop", undefined, { region, enabled });
  }
  setLoopRegion(a: number, b: number): Promise<void> {
    try {
      const region = mediaLoopRegion(a,b,this.#state.sourceRate,this.#state.outputRate,this.#state.totalFrames);
      if (!this.#state.loop.supported) return Promise.resolve();
      const enabled = this.#loopIntent?.enabled ?? this.#state.loop.enabled;
      this.#publish({ loop: { ...this.#state.loop, region, error: null } });
      if (!enabled) return Promise.resolve();
      // An enable still waiting for a poll has not established an active interval.
      return this.#control("loop", undefined, { region, enabled, edit: this.#loopIntent ? this.#loopIntent.edit ?? false : true });
    } catch (error) { this.#publish({ loop: { ...this.#state.loop, error: error instanceof Error ? error.message : String(error) } }); return Promise.resolve(); }
  }
  // Only one acknowledged user operation at a time; controls show busy rather
  // than accumulating commands. Close/replacement always bypass this wait.
  #control(action: "play" | "pause" | "seek" | "loop", target?: number, loop?: LoopControl, queuedRevision?: number): Promise<void> {
    const requestRevision = queuedRevision ?? ++this.#requestRevision;
    if (requestRevision !== this.#requestRevision) return Promise.resolve();
    if (queuedRevision === undefined) {
      if (loop) this.#loopIntent = loop;
      // Seek cancels a waiting enable; other controls can replace a queued one.
      else if (action === "seek" || this.#pendingControl?.action === "loop") this.#loopIntent = undefined;
    }
    const superseding = this.#commandPreparing && (action === "loop" || action === "seek");
    if (this.#command && !superseding) {
      this.#pendingControl = { action, revision: requestRevision, run: () => this.#control(action, target, loop, requestRevision) };
      return this.#command;
    }
    if (superseding) this.#pendingControl = undefined;
    const revision = ++this.#controlRevision;
    const playback = this.#lifecycle.active;
    if (!playback || (this.#state.busy && !superseding) || this.#state.phase === "error") return Promise.resolve();
    const generation = this.#generation;
    const poll = this.#poll;
    if (action === "seek" || action === "loop" || (action === "play" && this.#state.snapshot?.ended)) {
      ++this.#visualRevision;
      this.releaseOscilloscope();
    }
    this.#publish({ busy: true, ...(action === "seek" ? { phase: "seeking" } : {}) });
    const command = (async () => {
      await poll;
      if (generation !== this.#generation || revision !== this.#controlRevision || this.#state.phase === "error") return;
      const pending = this.#pendingControl;
      if (pending && pending.revision > requestRevision && (pending.action === "loop" || pending.action === "seek")) return;
      if (action === "loop" && loop) {
        loop = { ...loop, region: this.#state.loop.region! };
        this.#loopIntent = undefined;
        this.#publish({ loop: { ...this.#state.loop, region: loop.region, enabled: loop.enabled, phase: loop.enabled ? "Preparing" : "Disabled", error: null } });
        this.#commandPreparing = true;
        const seekResult = await playback.setLoop!(loop.region.a, loop.region.b, loop.enabled, loop.edit ?? false);
        if (generation !== this.#generation || revision !== this.#controlRevision) return;
        this.#commandPreparing = false;
        this.#publish({ seekResult, loop: { ...this.#state.loop, enabled: seekResult.loopEnabled ?? loop.enabled } });
      }
      if (action === "seek" || (action === "play" && this.#state.snapshot?.ended)) {
        const region = this.#state.loop.region;
        if (region && action === "seek" && (target! < region.a || target! >= region.b)) this.#publish({ loop: { ...this.#state.loop, enabled: false, phase: "Disabled" } });
        this.#publish({ phase: "seeking" });
        this.#commandPreparing = true;
        const seekResult = await playback.seek(action === "seek" ? target! : 0);
        if (generation !== this.#generation || revision !== this.#controlRevision) return;
        this.#commandPreparing = false;
        this.#publish({ seekResult });
      }
      let snapshot = action === "play" ? await playback.play()
        : action === "pause" ? await playback.pause() : await playback.status();
      if (generation !== this.#generation || revision !== this.#controlRevision) return;
      if (snapshot.ended && !playback.paused) snapshot = await playback.pause();
      if (generation === this.#generation && revision === this.#controlRevision) this.#accept(snapshot, playback);
    })().catch(error => revision === this.#controlRevision ? this.#fail(error, generation) : undefined).finally(() => {
      if (this.#command === command) {
        this.#command = undefined;
        this.#commandPreparing = false;
        this.#publish({ busy: false });
        const pending = this.#pendingControl;
        this.#pendingControl = undefined;
        if (generation === this.#generation) void pending?.run();
      }
    });
    this.#command = command;
    return command;
  }

  #accept(snapshot: RenderSnapshot, playback: WavPlayback): void {
    if (this.#state.snapshot && snapshot.epoch < this.#state.snapshot.epoch) return;
    if ((snapshot.loopUnderruns ?? 0) > (this.#state.snapshot?.loopUnderruns ?? 0)) {
      ++this.#visualRevision;
      this.releaseOscilloscope();
    }
    const loop = this.#state.loop;
    this.#publish({ snapshot, loop: { ...loop, phase: !loop.enabled ? "Disabled" : snapshot.loopRecovering ? "Failed" : !snapshot.ready ? "Preparing" : playback.paused ? "Armed" : "Active", error: snapshot.loopRecovering ? "LoopUnderrun — re-priming loop start" : loop.error?.startsWith("LoopUnderrun") ? null : loop.error }, phase: snapshot.loopRecovering ? playback.paused ? "paused" : "playing" : !snapshot.ready ? "seeking" : snapshot.ended ? "ended"
      : playback.paused ? "paused" : "playing" });
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.#publish({ volume: Math.min(1, Math.max(0, volume)) });
    this.#applyVolume();
  }
  setMuted(muted: boolean): void {
    this.#publish({ muted });
    this.#applyVolume();
  }
  #applyVolume(): void {
    if (this.#state.phase === "error") return;
    try { this.#lifecycle.active?.setListeningGain(this.#state.muted ? 0 : this.#state.volume); }
    catch (error) { void this.#fail(error, this.#generation); }
  }

  async #fail(error: unknown, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    ++this.#visualRevision;
    this.releaseOscilloscope();
    this.#stopPolling();
    this.#analysis?.abort();
    this.#publish({ phase: "error", busy: false, loop: { ...this.#state.loop, phase: this.#state.loop.enabled ? "Failed" : "Disabled", error: this.#state.loop.enabled ? "Source failure — retry this track from the library" : this.#state.loop.error }, waveform: null, waveformPhase: "empty", error: error instanceof Error ? error.message : String(error) });
    await this.#lifecycle.closeActive();
  }
  #stopPolling(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
