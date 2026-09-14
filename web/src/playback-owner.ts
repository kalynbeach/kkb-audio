import { prepareProof, type PreparedProof, type SeekResult } from "./prepared-playback";
import { prepareWaveform, type PrepareWaveform } from "./prepare-waveform";
import type { SourceWaveform } from "./source-waveform";
import { PreparationLifecycle } from "./preparation-lifecycle";
import type { RenderSnapshot } from "./render-adapter";

// Private consumer seam, not a published session or command API.
export type WavPlayback = Pick<PreparedProof,
  "close" | "play" | "pause" | "seek" | "status" | "setListeningGain" |
  "totalFrames" | "sourceRate" | "paused" | "ready">;
type PrepareWav = (file: File, signal: AbortSignal) => Promise<WavPlayback>;
export type PlaybackState = {
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
  waveform: null, waveformPhase: "empty",
};

export class PlaybackOwner {
  #state = emptyState;
  #listeners = new Set<() => void>();
  #lifecycle = new PreparationLifecycle<WavPlayback>();
  #generation = 0;
  #poll: Promise<void> | undefined;
  #command: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  #analysis: AbortController | undefined;

  constructor(private readonly prepare: PrepareWav = (file, signal) =>
    prepareProof({ file, signal, channelCount: 2, maximumFrames: 1024 }),
    private readonly analyse: PrepareWaveform = prepareWaveform) {}

  getState = (): PlaybackState => this.#state;
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
    this.#analysis?.abort();
    this.#analysis = undefined;
    this.#stopPolling();
    const previous = this.#lifecycle;
    // A cancelled preparation may still be unwinding. Its existing lifecycle owns
    // disposal of late results; it must not block a replacement's preparation.
    const lifecycle = this.#lifecycle = new PreparationLifecycle<WavPlayback>();
    this.#poll = undefined;
    this.#command = undefined;
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
    this.#analysis?.abort();
    this.#analysis = undefined;
    this.#stopPolling();
    this.#poll = undefined;
    this.#command = undefined;
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

  // Only one acknowledged user operation at a time; controls show busy rather
  // than accumulating commands. Close/replacement always bypass this wait.
  #control(action: "play" | "pause" | "seek", target?: number): Promise<void> {
    if (this.#command) return this.#command;
    const playback = this.#lifecycle.active;
    if (!playback || this.#state.busy || this.#state.phase === "error") return Promise.resolve();
    const generation = this.#generation;
    const poll = this.#poll;
    this.#publish({ busy: true, ...(action === "seek" ? { phase: "seeking" } : {}) });
    const command = (async () => {
      await poll;
      if (generation !== this.#generation || this.#state.phase === "error") return;
      if (action === "seek" || (action === "play" && this.#state.snapshot?.ended)) {
        this.#publish({ phase: "seeking" });
        const seekResult = await playback.seek(action === "seek" ? target! : 0);
        if (generation !== this.#generation) return;
        this.#publish({ seekResult });
      }
      let snapshot = action === "play" ? await playback.play()
        : action === "pause" ? await playback.pause() : await playback.status();
      if (generation !== this.#generation) return;
      if (snapshot.ended && !playback.paused) snapshot = await playback.pause();
      if (generation === this.#generation) this.#accept(snapshot, playback);
    })().catch(error => this.#fail(error, generation)).finally(() => {
      if (this.#command === command) {
        this.#command = undefined;
        this.#publish({ busy: false });
      }
    });
    this.#command = command;
    return command;
  }

  #accept(snapshot: RenderSnapshot, playback: WavPlayback): void {
    if (this.#state.snapshot && snapshot.epoch < this.#state.snapshot.epoch) return;
    this.#publish({ snapshot, phase: !snapshot.ready ? "seeking" : snapshot.ended ? "ended"
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
    this.#stopPolling();
    this.#analysis?.abort();
    this.#publish({ phase: "error", busy: false, waveform: null, waveformPhase: "empty", error: error instanceof Error ? error.message : String(error) });
    await this.#lifecycle.closeActive();
  }
  #stopPolling(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
