import { PreparationLifecycle } from "./preparation-lifecycle";
import {
  InitializationFailure,
  InitializationGate,
  type ReadyMessage,
} from "./protocol";
import type { RenderSnapshot } from "./render-adapter";

type ProofOptions = {
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
  workerInitialExhaustionCount: number;
  snapshot: RenderSnapshot;
};

export class InitializationError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`AudioWorklet initialization failed with code ${code}`);
    this.code = code;
  }
}

export class PreparedProof {
  readonly #context: AudioContext;
  readonly #gate: InitializationGate;
  readonly #node: AudioWorkletNode;
  readonly #ready: ReadyMessage;
  readonly #worker: Worker | undefined;
  readonly #workerInitialExhaustionCount: number;
  #activated = false;
  #closed = false;
  #workerTerminated = false;
  #runtimeFailure = 0;
  #snapshotResolve: ((snapshot: RenderSnapshot) => void) | undefined;
  #snapshotReject: ((code: number) => void) | undefined;

  constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    gate: InitializationGate,
    ready: ReadyMessage,
    worker?: Worker,
    workerInitialExhaustionCount = 0,
  ) {
    this.#context = context;
    this.#node = node;
    this.#gate = gate;
    this.#ready = ready;
    this.#worker = worker;
    this.#workerInitialExhaustionCount = workerInitialExhaustionCount;
  }

  get ready(): ReadyMessage {
    return this.#ready;
  }

  acceptRuntimeMessage(value: unknown): void {
    if (isSnapshotMessage(value)) {
      this.#snapshotResolve?.(value.snapshot);
      return;
    }
    const result = this.#gate.accept(value);
    if (result.type === "failed") {
      this.failRuntime(result.code);
    }
  }

  acceptWorkerMessage(value: unknown): void {
    const code = workerFailureCode(value);
    if (code !== undefined) this.failRuntime(code);
  }

  failRuntime(code: number): void {
    if (this.#runtimeFailure === 0) {
      this.#runtimeFailure = code;
    }
    this.#snapshotReject?.(this.#runtimeFailure);
    this.#node.disconnect();
    this.#terminateWorker();
    if (!this.#closed) {
      void this.#context.suspend();
    }
  }

  async activate(): Promise<BrowserProofResult> {
    this.#throwIfUnavailable();
    if (this.#activated || this.#gate.result.type !== "ready") {
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
      workerInitialExhaustionCount: this.#workerInitialExhaustionCount,
      snapshot,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#snapshotReject?.(InitializationFailure.ContextState);
    this.#node.disconnect();
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
  const context = new AudioContext();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  const wasmUrl = options.wasmUrl ?? "./kkb_audio_bg.wasm";
  const workerUrl = options.workerUrl ?? "./pcm-worker.js";
  const workletUrl = options.workletUrl ?? "./worklet-processor.js";
  let worker: Worker | undefined;
  let prepared: PreparedProof | undefined;

  try {
    if (context.state !== "suspended") await context.suspend();
    const wasmResponse = await fetch(wasmUrl, { cache: "no-store" });
    if (!wasmResponse.ok) throw new InitializationError(InitializationFailure.InvalidMessage);
    const module = await WebAssembly.compile(await wasmResponse.arrayBuffer());
    await context.audioWorklet.addModule(workletUrl);

    const config = {
      channelCount: options.channelCount,
      epoch: 1,
      sampleRate: context.sampleRate,
      slotCount: 4,
      slotFrames: 256,
      sourceId: 3,
    } as const;
    const channel = new MessageChannel();
    worker = new Worker(workerUrl, { type: "module" });
    const workerReady = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new InitializationError(InitializationFailure.Timeout)), timeoutMilliseconds);
      worker!.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; slotCount?: unknown; exhaustionCount?: unknown; invalidRecycleCount?: unknown } | null;
        if (
          message?.type === "worker-ready" && message.slotCount === config.slotCount &&
          message.exhaustionCount === 1 && message.invalidRecycleCount === 0
        ) {
          clearTimeout(timeout); resolve(message.exhaustionCount);
        } else if (message?.type === "worker-failed") {
          clearTimeout(timeout);
          if (prepared === undefined) {
            reject(new InitializationError(InitializationFailure.InvalidMessage));
          } else {
            prepared.acceptWorkerMessage(event.data);
          }
        }
      };
      worker!.onerror = () => { clearTimeout(timeout); reject(new InitializationError(InitializationFailure.InvalidMessage)); };
    });
    worker.postMessage({ type: "initialize", config, port: channel.port1 }, [channel.port1]);

    const gate = new InitializationGate();
    const node = new AudioWorkletNode(context, "kkb-prepared-kernel", {
      channelCount: options.channelCount,
      channelCountMode: "explicit",
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [options.channelCount],
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

    const [ready, workerInitialExhaustionCount] = await Promise.all([workletReady, workerReady]);
    if (context.state !== "suspended" || gate.result.type !== "ready") {
      throw new InitializationError(InitializationFailure.ContextState);
    }
    prepared = new PreparedProof(context, node, gate, ready, worker, workerInitialExhaustionCount);
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

const prepareButton = document.querySelector<HTMLButtonElement>("#prepare");
const activateButton = document.querySelector<HTMLButtonElement>("#activate");
const failureButton = document.querySelector<HTMLButtonElement>("#failure");
const closeButton = document.querySelector<HTMLButtonElement>("#close");
const output = document.querySelector<HTMLElement>("#result");
const proofLifecycle = new PreparationLifecycle<PreparedProof>();

prepareButton?.addEventListener("click", async () => {
  const preparation = proofLifecycle.tryReplace(() =>
    prepareProof({
      channelCount: 2,
      maximumFrames: 1_024,
    }),
  );
  if (preparation === undefined) {
    return;
  }

  setPreparationControlsDisabled(true);
  if (activateButton !== null) {
    activateButton.disabled = true;
  }
  outputText("preparing");
  try {
    const prepared = await preparation;
    outputText(JSON.stringify({ state: "ready", ...prepared.ready }, null, 2));
    if (activateButton !== null) {
      activateButton.disabled = false;
    }
  } catch (error) {
    outputText(errorText(error));
  } finally {
    setPreparationControlsDisabled(false);
  }
});

activateButton?.addEventListener("click", async () => {
  try {
    const result = await proofLifecycle.active?.activate();
    outputText(JSON.stringify({ state: "active", ...result }, null, 2));
  } catch (error) {
    outputText(errorText(error));
  }
});

failureButton?.addEventListener("click", async () => {
  const preparation = proofLifecycle.tryExclusive(async () => {
    const unexpectedProof = await prepareProof({
      channelCount: 1,
      injectPreparationFailure: true,
      maximumFrames: 1_024,
    });
    await unexpectedProof.close();
  });
  if (preparation === undefined) {
    return;
  }

  setPreparationControlsDisabled(true);
  try {
    await preparation;
    outputText("unexpected-ready");
  } catch (error) {
    outputText(
      JSON.stringify({ state: "failed", error: errorText(error) }, null, 2),
    );
  } finally {
    setPreparationControlsDisabled(false);
  }
});

closeButton?.addEventListener("click", async () => {
  await proofLifecycle.closeActive();
  if (activateButton !== null) {
    activateButton.disabled = true;
  }
  outputText("closed");
});

function setPreparationControlsDisabled(disabled: boolean): void {
  if (prepareButton !== null) {
    prepareButton.disabled = disabled;
  }
  if (failureButton !== null) {
    failureButton.disabled = disabled;
  }
  if (closeButton !== null) {
    closeButton.disabled = disabled;
  }
}

function outputText(text: string): void {
  if (output !== null) {
    output.textContent = text;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
