import { OscilloscopeTap, type OscilloscopeBuffers, type OscilloscopeRead } from "./oscilloscope-tap";
import { mediaLoopRegion } from "./media-loop";
import { LOCAL_PCM_SLOT_FRAMES } from "./pcm-protocol";
import {
  InitializationFailure,
  InitializationGate,
  runtimeFailureCode,
  type ReadyMessage,
} from "./protocol";
import type { RenderSnapshot } from "./render-adapter";

type ProofOptions = {
  signal?: AbortSignal;
  file?: File;
  channelCount: 1 | 2;
  injectPreparationFailure?: boolean;
  maximumFrames: number;
  timeoutMilliseconds?: number;
  wasmUrl?: string;
  workerUrl?: string;
  workletUrl?: string;
};

export type BrowserProofResult = {
  analyserObservedSignal: boolean;
  channelCount: number;
  contextRenderQuantumSize: number | null;
  contextSampleRate: number;
  initialization: ReadyMessage;
  workerInitialAdmittedBlocks: number;
  snapshot: RenderSnapshot;
};

export class InitializationError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`AudioWorklet initialization failed with code ${code}`);
    this.code = code;
  }
}

export type SeekResult = {
  loopEnabled?: boolean;
  epoch: number;
  requestedFrame: number;
  pcmFrame: number;
  actualMediaFrame: number;
  result: "Exact" | "AnchorAndDiscard" | "Adjusted";
};

export class PreparedProof {
  readonly #context: AudioContext;
  readonly #gate: InitializationGate;
  readonly #node: AudioWorkletNode;
  readonly #ready: ReadyMessage;
  readonly #worker: Worker | undefined;
  readonly #workerInitialAdmittedBlocks: number;
  readonly totalFrames: number | undefined;
  readonly sourceRate: number | undefined;
  readonly anchorAndDiscard: boolean;
  #listeningGain: GainNode | undefined;
  #oscilloscope: OscilloscopeTap | undefined;
  #oscilloscopeFailed = false;
  #visualReady = false;
  #activated = false;
  #closed = false;
  #workerTerminated = false;
  #runtimeFailure = 0;
  #epoch = 1;
  #observedEpoch = 1;
  #postedSeek: number | undefined;
  #queuedSeek: { epoch: number; target: number; loop?: { a: number; b: number }; recovery?: boolean; loopChange?: { a: number; b: number; enabled: boolean; edit: boolean } } | undefined;
  #loop: { a: number; b: number } | undefined;
  #seekResolve: ((result: SeekResult) => void) | undefined;
  #seekReject: ((error: Error) => void) | undefined;
  producerObservation: unknown;
  #snapshotResolve: ((snapshot: RenderSnapshot) => void) | undefined;
  #snapshotReject: ((code: number) => void) | undefined;

  constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    gate: InitializationGate,
    ready: ReadyMessage,
    worker?: Worker,
    workerInitialAdmittedBlocks = 0,
    totalFrames?: number,
    sourceRate?: number,
    anchorAndDiscard = false,
  ) {
    this.totalFrames = totalFrames;
    this.sourceRate = sourceRate;
    this.anchorAndDiscard = anchorAndDiscard;
    this.#context = context;
    this.#node = node;
    this.#gate = gate;
    this.#ready = ready;
    this.#worker = worker;
    this.#workerInitialAdmittedBlocks = workerInitialAdmittedBlocks;
  }

  get paused(): boolean { return this.#context.state === "suspended"; }

  get ready(): ReadyMessage {
    return this.#ready;
  }

  acceptRuntimeMessage(value: unknown): void {
    if (this.#closed) return;
    if (isSnapshotMessage(value)) {
      if (value.snapshot.epoch < this.#observedEpoch) {
        // Worker completion and snapshot replies use different ports. Replace the
        // obsolete reply without extending the original bounded request deadline.
        if (this.#snapshotResolve) this.#node.port.postMessage({ type: "snapshot" });
        return;
      }
      this.#observedEpoch = value.snapshot.epoch;
      this.#visualReady = value.snapshot.epoch === this.#epoch && value.snapshot.ready && !value.snapshot.ended;
      if (value.snapshot.failureCode !== 0) { this.failRuntime(value.snapshot.failureCode); return; }
      this.#snapshotResolve?.(value.snapshot);
      return;
    }
    const failureCode = runtimeFailureCode(value);
    if (failureCode !== undefined) {
      this.failRuntime(failureCode);
      return;
    }
    const result = this.#gate.accept(value);
    if (result.type === "failed") {
      this.failRuntime(result.code);
    }
  }

  acceptWorkerMessage(value: unknown): void {
    if (this.#closed || this.#runtimeFailure !== 0) return;
    const message = value as { type?: string; epoch?: number; requestedFrame?: number; pcmFrame?: number; result?: SeekResult["result"]; loopEnabled?: boolean } | null;
    if (message?.type === "loop-ended" && Number.isSafeInteger(message.epoch) && message.epoch! <= this.#epoch) {
      // Do not use status()/pause(): this acknowledgment must not overlap a poll.
      // An obsolete begin still needs its pause acknowledgment to release the
      // worker's single executing transition before the latest one can proceed.
      void this.#context.suspend().then(() => {
        if (!this.#closed && this.#runtimeFailure === 0) this.#worker?.postMessage({ type: "loop-paused", epoch: message.epoch });
      }).catch(() => { if (!this.#closed) this.failRuntime(InitializationFailure.ContextState); });
      return;
    }
    if (message?.type === "loop-underrun" && message.epoch === this.#epoch && this.#loop && !this.#seekResolve) {
      void this.#seek(this.#loop.a, true).catch(() => {});
      return;
    }
    if (message?.type === "seek-accepted" && message.epoch === this.#postedSeek) {
      this.#postedSeek = undefined;
      this.#dispatchSeek();
      return;
    }
    if (message?.type === "producer-status" && message.epoch === this.#epoch) this.producerObservation = value;
    if (message?.type === "seek-complete" && message.epoch === this.#epoch && Number.isSafeInteger(message.pcmFrame) && Number.isSafeInteger(message.requestedFrame) && (message.result === "Exact" || message.result === "AnchorAndDiscard" || message.result === "Adjusted")) {
      this.#observedEpoch = this.#epoch;
      const pcmFrame = message.pcmFrame!;
      const actualMediaFrame = Math.min(this.totalFrames!, Math.floor(pcmFrame * this.sourceRate! / this.#context.sampleRate));
      if (message.loopEnabled === false) this.#loop = undefined;
      this.#seekResolve?.({ epoch: this.#epoch, requestedFrame: message.requestedFrame!, pcmFrame, actualMediaFrame,
        result: message.result, loopEnabled: message.loopEnabled });
    }
    const code = workerFailureCode(value);
    if (code !== undefined) this.failRuntime(code);
  }

  failRuntime(code: number): void {
    this.releaseOscilloscope();
    if (this.#runtimeFailure === 0) {
      this.#runtimeFailure = code;
    }
    this.#snapshotReject?.(this.#runtimeFailure);
    this.#seekReject?.(new InitializationError(this.#runtimeFailure));
    this.#node.disconnect();
    this.#terminateWorker();
    if (!this.#closed) {
      void this.#context.suspend();
    }
  }

  async activate(): Promise<BrowserProofResult> {
    this.#throwIfUnavailable();
    if (this.totalFrames !== undefined || this.#activated || this.#gate.result.type !== "ready") {
      throw new InitializationError(InitializationFailure.ContextState);
    }
    this.#activated = true;

    const splitter = new ChannelSplitterNode(this.#context, {
      numberOfOutputs: this.#node.channelCount,
    });
    const analyser = new AnalyserNode(this.#context, { fftSize: 2_048 });
    const mute = new GainNode(this.#context, { gain: 0 });
    this.#node.connect(splitter);
    splitter.connect(analyser, 0);
    analyser.connect(mute).connect(this.#context.destination);
    await this.#context.resume();
    this.#throwIfUnavailable();
    if (this.#context.state !== "running") {
      throw new InitializationError(InitializationFailure.ContextState);
    }
    this.#worker?.postMessage({ type: "activate" });

    await delay(300);
    this.#throwIfUnavailable();
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let observedSignal = false;
    for (let index = 0; index < samples.length; index += 1) {
      if (samples[index] !== 0) {
        observedSignal = true;
        break;
      }
    }
    const snapshot = await this.#requestSnapshot();
    this.#throwIfUnavailable();
    if (snapshot.failureCode !== 0 || snapshot.processCount === 0) {
      this.failRuntime(
        snapshot.failureCode || InitializationFailure.ContextState,
      );
      this.#throwIfUnavailable();
    }

    const contextWithQuantum = this.#context as AudioContext & {
      readonly renderQuantumSize?: number;
    };
    return {
      analyserObservedSignal: observedSignal,
      channelCount: this.#node.channelCount,
      contextRenderQuantumSize: contextWithQuantum.renderQuantumSize ?? null,
      contextSampleRate: this.#context.sampleRate,
      initialization: this.#ready,
      workerInitialAdmittedBlocks: this.#workerInitialAdmittedBlocks,
      snapshot,
    };
  }

  /** Optional post-plan listening gain; the proof retains its original direct output. */
  setListeningGain(value: number): void {
    this.#throwIfUnavailable();
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid listening gain");
    if (!this.#listeningGain) {
      this.#listeningGain = new GainNode(this.#context, { gain: value });
      this.#listeningGain.connect(this.#context.destination);
      if (this.#activated && this.totalFrames !== undefined) {
        this.#node.disconnect(this.#context.destination);
        this.#node.connect(this.#listeningGain);
      }
    }
    this.#listeningGain.gain.value = value;
  }

  async play(): Promise<RenderSnapshot> {
    this.#throwIfUnavailable();
    if (this.totalFrames === undefined) throw new Error("Load local audio first");
    if (!this.#activated) { this.#node.connect(this.#listeningGain ?? this.#context.destination); this.#activated = true; }
    const snapshot = await this.status();
    if (!snapshot.ended || this.#seekResolve !== undefined) {
      this.#worker?.postMessage({ type: "activate" });
      const wasPaused = this.paused;
      await this.#context.resume();
      if (wasPaused) this.#oscilloscope?.restartWarmup();
      this.#throwIfUnavailable();
    }
    return this.status();
  }

  async pause(): Promise<RenderSnapshot> {
    this.#throwIfUnavailable();
    await this.#context.suspend();
    return this.status();
  }

  setLoop(a: number, b: number, enabled: boolean, edit = false): Promise<SeekResult> {
    this.#throwIfUnavailable();
    if (enabled && (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || a >= b || b > this.totalFrames!)) throw new Error("Loops require a supported media interval");
    if (enabled) mediaLoopRegion(a, b, this.sourceRate!, this.#context.sampleRate, this.totalFrames!);
    this.#loop = enabled ? { a, b } : undefined;
    return this.#seek(0, false, { a, b, enabled, edit });
  }
  seek(target: number): Promise<SeekResult> {
    if (this.#loop && (target < this.#loop.a || target >= this.#loop.b)) this.#loop = undefined;
    return this.#seek(target, false);
  }
  #seek(target: number, recovery: boolean, loopChange?: { a: number; b: number; enabled: boolean; edit: boolean }): Promise<SeekResult> {
    this.#throwIfUnavailable();
    if (this.totalFrames === undefined || !Number.isSafeInteger(target) || target < 0 || target > this.totalFrames || this.#epoch === Number.MAX_SAFE_INTEGER) throw new Error("Seek requires a source frame in [0, totalFrames]");
    this.releaseOscilloscope();
    this.#visualReady = false;
    this.#seekReject?.(new Error("Seek superseded"));
    this.#epoch += 1;
    this.producerObservation = undefined;
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timeout); this.#seekResolve = undefined; this.#seekReject = undefined; };
      const timeout = setTimeout(() => { this.#seekReject?.(new Error("Seek preparation timed out")); this.failRuntime(InitializationFailure.Timeout); }, this.anchorAndDiscard ? 35000 : 5000);
      this.#seekResolve = result => { clear(); resolve(result); };
      this.#seekReject = error => { clear(); reject(error); };
      this.#queuedSeek = { epoch: this.#epoch, target, loop: this.#loop, recovery, loopChange };
      this.#dispatchSeek();
    });
  }

  #dispatchSeek(): void {
    if (this.#postedSeek !== undefined || !this.#queuedSeek) return;
    const request = this.#queuedSeek;
    this.#queuedSeek = undefined;
    this.#postedSeek = request.epoch;
    this.#worker!.postMessage({ type: "seek", ...request });
  }

  async status(): Promise<RenderSnapshot> {
    this.#throwIfUnavailable();
    if (this.#snapshotResolve) throw new Error("Status request already pending");
    this.#worker?.postMessage({ type: "producer-status" });
    return this.#requestSnapshot();
  }

  stall(value: boolean): void { this.#throwIfUnavailable(); this.#worker?.postMessage({ type: "stall", value }); }

  readOscilloscope(buffers: OscilloscopeBuffers): OscilloscopeRead {
    if (this.#closed || this.#runtimeFailure || this.#oscilloscopeFailed || this.totalFrames === undefined) return "unavailable";
    if (!this.#visualReady || this.#seekResolve || this.paused) return "warming";
    try {
      this.#oscilloscope ??= new OscilloscopeTap(this.#context, this.#node, this.#node.channelCount as 1 | 2);
      const result = this.#oscilloscope.read(buffers);
      if (result === "unavailable") this.#oscilloscopeFailed = true;
      return result;
    } catch { this.#oscilloscopeFailed = true; this.releaseOscilloscope(); return "unavailable"; }
  }

  releaseOscilloscope(): void {
    this.#oscilloscope?.dispose();
    this.#oscilloscope = undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.releaseOscilloscope();
    this.#seekReject?.(new Error("Playback closed"));
    this.#snapshotReject?.(InitializationFailure.ContextState);
    this.#node.disconnect();
    this.#listeningGain?.disconnect();
    this.#terminateWorker();
    await this.#context.close();
  }

  #throwIfUnavailable(): void {
    if (this.#runtimeFailure !== 0 || this.#closed) {
      throw new InitializationError(
        this.#runtimeFailure || InitializationFailure.ContextState,
      );
    }
  }

  #terminateWorker(): void {
    if (this.#workerTerminated) return;
    this.#workerTerminated = true;
    this.#worker?.terminate();
  }

  #requestSnapshot(): Promise<RenderSnapshot> {
    return new Promise((resolve, reject) => {
      const clearPendingSnapshot = () => {
        clearTimeout(timeout);
        this.#snapshotResolve = undefined;
        this.#snapshotReject = undefined;
      };
      const timeout = setTimeout(() => {
        clearPendingSnapshot();
        this.failRuntime(InitializationFailure.Timeout);
        reject(new InitializationError(InitializationFailure.Timeout));
      }, 1_000);
      this.#snapshotResolve = (snapshot) => {
        clearPendingSnapshot();
        resolve(snapshot);
      };
      this.#snapshotReject = (code) => {
        clearPendingSnapshot();
        reject(new InitializationError(code));
      };
      this.#node.port.postMessage({ type: "snapshot" });
    });
  }
}

export async function prepareProof(options: ProofOptions): Promise<PreparedProof> {
  options.signal?.throwIfAborted();
  const context = new AudioContext();
  const wait = <T>(operation: Promise<T>): Promise<T> => {
    const signal = options.signal;
    if (!signal) return operation;
    let abort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Preparation cancelled"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    return Promise.race([operation, cancelled]).finally(() => signal.removeEventListener("abort", abort));
  };
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  const wasmUrl = options.wasmUrl ?? "./kkb_audio_bg.wasm";
  const workerUrl = options.workerUrl ?? "./pcm-worker.js";
  const workletUrl = options.workletUrl ?? "./worklet-processor.js";
  let worker: Worker | undefined;
  let prepared: PreparedProof | undefined;
  let startupRuntimeFailure: number | undefined;

  try {
    if (context.state !== "suspended") await wait(context.suspend());
    const wasmResponse = await wait(fetch(wasmUrl, { cache: "no-store", signal: options.signal }));
    if (!wasmResponse.ok) throw new InitializationError(InitializationFailure.InvalidMessage);
    const module = await wait(WebAssembly.compile(await wait(wasmResponse.arrayBuffer())));
    await wait(context.audioWorklet.addModule(workletUrl));

    worker = new Worker(workerUrl, { type: "module" });
    let totalFrames: number | undefined;
    let totalPcmFrames: number | undefined;
    let sourceRate: number | undefined;
    let anchorAndDiscard = false;
    let channelCount = options.channelCount;
    if (options.file) {
      const metadata = await wait(new Promise<{ channelCount: 1 | 2; totalFrames: number; totalPcmFrames: number; sampleRate: number; anchorAndDiscard: boolean }>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancelled); };
        const cancelled = () => { cleanup(); reject(new Error("Preparation cancelled")); };
        const timedOut = () => { cleanup(); reject(new Error("Media inspection timed out")); };
        let timeout = setTimeout(timedOut, timeoutMilliseconds);
        let inspectionBudgetReceived = false;
        options.signal?.addEventListener("abort", cancelled, { once: true });
        if (options.signal?.aborted) { cancelled(); return; }
        worker!.onerror = () => { cleanup(); reject(new Error("Media worker failed")); };
        worker!.onmessage = event => {
          clearTimeout(timeout);
          if (event.data?.type === "inspection-started" && event.data.timeoutMilliseconds === 35000 && !inspectionBudgetReceived) {
            inspectionBudgetReceived = true;
            timeout = setTimeout(timedOut, options.timeoutMilliseconds ?? event.data.timeoutMilliseconds);
            return;
          }
          cleanup();
          if (event.data?.type === "metadata") resolve(event.data);
          else reject(new Error(event.data?.detail ?? "Unsupported or malformed local audio"));
        };
        worker!.postMessage({ type: "inspect", file: options.file, module, sampleRate: context.sampleRate });
      }));
      channelCount = metadata.channelCount;
      totalFrames = metadata.totalFrames;
      totalPcmFrames = metadata.totalPcmFrames;
      sourceRate = metadata.sampleRate;
      anchorAndDiscard = metadata.anchorAndDiscard;
    }
    const config = {
      channelCount,
      epoch: 1,
      sampleRate: context.sampleRate,
      slotCount: 4,
      slotFrames: LOCAL_PCM_SLOT_FRAMES,
      sourceId: 3,
      sourceRate,
      sourceFrames: totalFrames,
    } as const;
    const channel = new MessageChannel();
    const workerReady = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new InitializationError(InitializationFailure.Timeout)), timeoutMilliseconds);
      const failWorker = (code: number) => {
        clearTimeout(timeout);
        if (prepared === undefined) {
          startupRuntimeFailure ??= code;
          reject(new InitializationError(code));
        } else {
          prepared.failRuntime(code);
        }
      };
      worker!.onmessage = (event: MessageEvent<unknown>) => {
        if (prepared !== undefined) { prepared.acceptWorkerMessage(event.data); return; }
        const message = event.data as { type?: unknown; slotCount?: unknown; initialAdmittedBlocks?: unknown } | null;
        if (
          message?.type === "worker-ready" && message.slotCount === config.slotCount &&
          message.initialAdmittedBlocks === Math.min(config.slotCount, Math.ceil((totalPcmFrames ?? totalFrames ?? Number.MAX_SAFE_INTEGER) / config.slotFrames))
        ) {
          clearTimeout(timeout); resolve(message.initialAdmittedBlocks as number);
        } else if (message?.type === "worker-failed") {
          failWorker(workerFailureCode(event.data) ?? InitializationFailure.InvalidMessage);
        }
      };
      worker!.onerror = () => failWorker(InitializationFailure.InvalidMessage);
    });
    worker.postMessage({ type: "initialize", config, port: channel.port1 }, [channel.port1]);

    const gate = new InitializationGate();
    const node = new AudioWorkletNode(context, "kkb-prepared-kernel", {
      channelCount,
      channelCountMode: "explicit",
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channelCount],
      processorOptions: {
        ...config,
        injectPreparationFailure: options.injectPreparationFailure,
        maximumFrames: options.maximumFrames,
        module,
      },
    });
    const workletReady = new Promise<ReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const result = gate.fail(InitializationFailure.Timeout);
        reject(new InitializationError(result.type === "failed" ? result.code : InitializationFailure.Timeout));
      }, timeoutMilliseconds);
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (prepared !== undefined) { prepared.acceptRuntimeMessage(event.data); return; }
        const failureCode = runtimeFailureCode(event.data);
        if (failureCode !== undefined) {
          startupRuntimeFailure ??= failureCode;
          clearTimeout(timeout);
          reject(new InitializationError(failureCode));
          return;
        }
        const result = gate.accept(event.data);
        if (result.type === "ready") { clearTimeout(timeout); resolve(result.message); }
        else if (result.type === "failed") { clearTimeout(timeout); reject(new InitializationError(result.code)); }
      };
      node.addEventListener("processorerror", () => {
        const result = gate.fail(InitializationFailure.ProcessorError); clearTimeout(timeout);
        if (prepared === undefined) reject(new InitializationError(result.type === "failed" ? result.code : InitializationFailure.ProcessorError));
        else prepared.failRuntime(InitializationFailure.ProcessorError);
      });
      node.port.start();
      node.port.postMessage({ type: "transport-port", port: channel.port2 }, [channel.port2]);
    });

    const [ready, workerInitialAdmittedBlocks] = await wait(Promise.all([workletReady, workerReady]));
    if (startupRuntimeFailure !== undefined) {
      throw new InitializationError(startupRuntimeFailure);
    }
    if (context.state !== "suspended" || gate.result.type !== "ready") {
      throw new InitializationError(InitializationFailure.ContextState);
    }
    prepared = new PreparedProof(context, node, gate, ready, worker, workerInitialAdmittedBlocks, totalFrames, sourceRate, anchorAndDiscard);
    return prepared;
  } catch (error) {
    worker?.terminate();
    await context.close();
    throw error;
  }
}

function workerFailureCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as { type?: unknown; code?: unknown };
  if (message.type !== "worker-failed") return undefined;
  return Number.isSafeInteger(message.code) && (message.code as number) >= 0
    ? (message.code as number)
    : InitializationFailure.InvalidMessage;
}

function isSnapshotMessage(
  value: unknown,
): value is { type: "snapshot"; snapshot: RenderSnapshot } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { type?: unknown; snapshot?: unknown };
  if (message.type !== "snapshot" || typeof message.snapshot !== "object" || message.snapshot === null) {
    return false;
  }
  const snapshot = message.snapshot as Partial<RenderSnapshot>;
  return (
    Number.isSafeInteger(snapshot.epoch) && snapshot.presentationTime === null && typeof snapshot.ready === "boolean" &&
    Number.isSafeInteger(snapshot.sourcePosition) &&
    Number.isSafeInteger(snapshot.pcmPosition) &&
    Number.isSafeInteger(snapshot.renderFrame) &&
    typeof snapshot.ended === "boolean" &&
    Number.isSafeInteger(snapshot.failureCode) &&
    Number.isSafeInteger(snapshot.invalidBlockCount) &&
    Number.isSafeInteger(snapshot.lastFrameCount) &&
    Number.isSafeInteger(snapshot.memoryBytes) &&
    Number.isSafeInteger(snapshot.processCount) &&
    Number.isSafeInteger(snapshot.slotCount) &&
    Number.isSafeInteger(snapshot.staleBlockCount) &&
    Number.isSafeInteger(snapshot.starvationCount)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
