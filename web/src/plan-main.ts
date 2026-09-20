import { PreparationLifecycle } from "./preparation-lifecycle";
import type { PlanSnapshot } from "./plan-adapter";

type PlanOptions = { channelCount?: 1 | 2; invalidVersion?: boolean; signal?: AbortSignal };
type PlanReady = { type: "ready"; maximumFrames: number; memoryBytes: number; sampleRate: number; channelCount: number };
type PlanMessage = PlanReady | { type: "failed"; code: number } | { type: "snapshot"; snapshot: PlanSnapshot };

export class PlanPreparationError extends Error {
  constructor(readonly code: number) { super(`plan preparation failed: ${code}`); }
}

export class PreparedPlanProof {
  readonly ready: PlanReady;
  readonly #context: AudioContext;
  readonly #node: AudioWorkletNode;
  #closed = false;
  #activated = false;
  #failure: Error | undefined;
  #pending: { resolve: (snapshot: PlanSnapshot) => void; reject: (error: Error) => void } | undefined;

  constructor(context: AudioContext, node: AudioWorkletNode, ready: PlanReady) {
    this.#context = context;
    this.#node = node;
    this.ready = ready;
    node.port.onmessage = (event: MessageEvent<PlanMessage>) => {
      if (event.data.type === "snapshot") this.#pending?.resolve(event.data.snapshot);
      if (event.data.type === "failed") this.#fail(new Error(`plan failed: ${event.data.code}`));
    };
    node.onprocessorerror = () => this.#fail(new Error("plan processor error"));
  }

  async activate() {
    if (this.#closed || this.#activated || this.#failure !== undefined) throw new Error("plan unavailable");
    this.#activated = true;
    try {
      const analyser = new AnalyserNode(this.#context, { fftSize: 2_048 });
      const mute = new GainNode(this.#context, { gain: 0 });
      this.#node.connect(analyser).connect(mute).connect(this.#context.destination);
      await this.#context.resume();
      if (this.#context.state !== "running") throw new Error("audio context did not start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (this.#failure !== undefined) throw this.#failure;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const analyserObservedSignal = samples.some((sample) => sample !== 0);
      if (!analyserObservedSignal) throw new Error("plan analyser observed no signal");
      const snapshot = await this.snapshot();
      if (snapshot.failureCode !== 0 || snapshot.processCount === 0 || snapshot.observation === null) {
        throw new Error(`plan render failed: ${snapshot.failureCode}`);
      }
      const context = this.#context as AudioContext & { readonly renderQuantumSize?: number };
      return {
        analyserObservedSignal,
        userAgent: navigator.userAgent,
        contextSampleRate: context.sampleRate,
        contextRenderQuantumSize: context.renderQuantumSize ?? null,
        compiler: "worker",
        initialization: this.ready,
        snapshot,
      };
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      throw this.#failure;
    }
  }

  snapshot(): Promise<PlanSnapshot> {
    if (this.#closed || this.#pending !== undefined || this.#failure !== undefined) {
      return Promise.reject(this.#failure ?? new Error("plan unavailable"));
    }
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timeout); this.#pending = undefined; };
      const timeout = setTimeout(() => {
        finish();
        const error = new Error("plan snapshot timed out");
        this.#fail(error);
        reject(error);
      }, 1_000);
      this.#pending = {
        resolve: (snapshot) => { finish(); resolve(snapshot); },
        reject: (error) => { finish(); reject(error); },
      };
      this.#node.port.postMessage({ type: "snapshot" });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending?.reject(new Error("plan closed"));
    this.#node.disconnect();
    await this.#context.close();
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#pending?.reject(this.#failure);
    this.#node.disconnect();
    if (!this.#closed) void this.#context.suspend();
  }
}

export async function preparePlanProof(options: PlanOptions = {}): Promise<PreparedPlanProof> {
  const context = new AudioContext();
  let worker: Worker | undefined;
  const abort = () => { worker?.terminate(); if (context.state !== "closed") void context.close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    if (context.state !== "suspended") await context.suspend();
    const response = await fetch("/audio-runtime/kkb_audio_bg.wasm", { cache: "no-store", signal: options.signal });
    if (!response.ok) throw new Error("plan Wasm fetch failed");
    const module = await WebAssembly.compile(await response.arrayBuffer());
    options.signal?.throwIfAborted();
    const channelCount = options.channelCount ?? 2;
    worker = new Worker("/audio-runtime/plan-worker.js", { type: "module" });
    const compiler = worker;
    const description = await new Promise<Uint32Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("plan compilation timed out")), 5_000);
      compiler.onerror = () => { clearTimeout(timeout); reject(new Error("plan compiler error")); };
      compiler.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timeout);
        const message = event.data as { type?: unknown; description?: unknown } | null;
        if (message?.type === "compiled" && message.description instanceof Uint32Array && message.description.length > 0) {
          resolve(message.description);
        } else reject(new Error("plan compilation failed"));
      };
      compiler.postMessage({ module, sampleRate: context.sampleRate, channelCount });
    });
    options.signal?.throwIfAborted();
    worker.terminate();
    worker = undefined;
    if (options.invalidVersion) description[0] = 0xffff_ffff;
    await context.audioWorklet.addModule("/audio-runtime/plan-processor.js");
    options.signal?.throwIfAborted();
    const node = new AudioWorkletNode(context, "kkb-compiled-plan", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      channelCount,
      channelCountMode: "explicit",
      outputChannelCount: [channelCount],
      processorOptions: { module, description, sampleRate: context.sampleRate, channelCount },
    });
    const ready = await new Promise<PlanReady>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("plan preparation timed out")), 5_000);
      node.onprocessorerror = () => { clearTimeout(timeout); reject(new Error("plan processor error")); };
      node.port.onmessage = (event: MessageEvent<PlanMessage>) => {
        clearTimeout(timeout);
        const message = event.data;
        if (message.type === "ready") resolve(message);
        else reject(message.type === "failed" ? new PlanPreparationError(message.code) : new Error("unexpected plan preparation message"));
      };
    });
    options.signal?.throwIfAborted();
    if (context.state !== "suspended") throw new Error("plan activated before ready");
    return new PreparedPlanProof(context, node, ready);
  } catch (error) {
    worker?.terminate();
    if (context.state !== "closed") await context.close();
    throw error;
  } finally { options.signal?.removeEventListener("abort", abort); }
}

export async function runPlanProof(options: PlanOptions = {}) {
  const proof = await preparePlanProof(options);
  try { return await proof.activate(); }
  finally { await proof.close(); }
}

declare global {
  interface Window { planProof: { prepare: typeof preparePlanProof; run: typeof runPlanProof } }
}
export function mountPlanProof(root: Pick<Document, "querySelector">) {
  const events = new AbortController();
  const listen = (target: HTMLElement | null, event: string, handler: () => void) => target?.addEventListener(event, handler, { signal: events.signal });
  window.planProof = { prepare: preparePlanProof, run: runPlanProof };

  const lifecycle = new PreparationLifecycle<PreparedPlanProof>();
  const prepare = root.querySelector<HTMLButtonElement>("#prepare");
  const activate = root.querySelector<HTMLButtonElement>("#activate");
  const invalid = root.querySelector<HTMLButtonElement>("#invalid");
  const close = root.querySelector<HTMLButtonElement>("#close");
  const output = root.querySelector<HTMLElement>("#result");
  function show(value: unknown): void { if (output !== null && !events.signal.aborted) output.textContent = JSON.stringify(value, null, 2); }
  function busy(disabled: boolean): void {
    if (events.signal.aborted) return;
    for (const button of [prepare, invalid, close]) if (button !== null) button.disabled = disabled;
  }

  listen(prepare, "click", async () => {
    const preparation = lifecycle.tryReplace(signal => preparePlanProof({ signal }));
    if (preparation === undefined) return;
    busy(true);
    if (activate !== null) activate.disabled = true;
    show({ state: "preparing" });
    try {
      const proof = await preparation;
      show({ state: "ready", ...proof.ready });
      if (activate !== null) activate.disabled = false;
    } catch (error) { show({ state: "failed", error: String(error) }); }
    finally { busy(false); }
  });
  listen(activate, "click", async () => {
    if (activate) activate.disabled = true;
    busy(true);
    try { show({ state: "active", ...await lifecycle.active?.activate() }); }
    catch (error) { show({ state: "failed", error: String(error) }); }
    finally { busy(false); }
  });
  listen(invalid, "click", async () => {
    const operation = lifecycle.tryExclusive(async () => {
      const proof = await preparePlanProof({ invalidVersion: true, signal: events.signal });
      await proof.close();
    });
    if (operation === undefined) return;
    busy(true);
    try { await operation; show({ state: "failed", error: "invalid version was accepted" }); }
    catch (error) {
      show({ state: error instanceof PlanPreparationError && error.code === 60 ? "rejected" : "failed", error: String(error) });
    }
    finally { busy(false); }
  });
  listen(close, "click", async () => {
    await lifecycle.closeActive();
    if (activate !== null) activate.disabled = true;
    show({ state: "closed" });
  });

  if (activate) activate.disabled = true;
  busy(false);
  show({ state: "idle" });
  return () => { events.abort(); void lifecycle.closeActive(); };
}
