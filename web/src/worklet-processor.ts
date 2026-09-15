import { WorkletKernel, initSync } from "./generated/kkb_audio.js";
import { isPcmBlockMessage, type PcmStreamConfig } from "./pcm-protocol";
import { PreparedPlanarAdapter, fillSilence, type RenderSnapshot, type WorkletMemory } from "./render-adapter";

const ProcessorFailure = {
  InvalidOptions: 40,
  InjectedPreparation: 41,
  Instantiation: 42,
  InvalidTransportMessage: 43,
} as const;
const MAXIMUM_PROOF_FRAMES = 1_024;
const WASM_PAGE_BYTES = 65_536;

type ProcessorOptions = PcmStreamConfig & {
  injectPreparationFailure?: boolean;
  maximumFrames: number;
  module: WebAssembly.Module;
};
type ProcessorConstructorOptions = { processorOptions?: ProcessorOptions };
type MessageEventLike = { data: unknown };
type WorkletPort = { onmessage: ((event: MessageEventLike) => void) | null; postMessage(message: unknown): void };

declare const sampleRate: number;
declare const AudioWorkletProcessor: { new (): { readonly port: WorkletPort } };
declare function registerProcessor(name: string, processorCtor: new (options: ProcessorConstructorOptions) => {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}): void;

class KkbPreparedKernelProcessor extends AudioWorkletProcessor {
  #adapter: PreparedPlanarAdapter | undefined;
  #failureCode = 0;
  #initializationSent = false;

  constructor(options: ProcessorConstructorOptions) {
    super();
    this.port.onmessage = (event) => {
      if (typeof event.data === "object" && event.data !== null && "type" in event.data && event.data.type === "snapshot") {
        this.port.postMessage({ type: "snapshot", snapshot: this.#snapshot() });
      }
    };
    try {
      const processorOptions = options.processorOptions;
      if (!isProcessorOptions(processorOptions)) { this.#failInitialization(ProcessorFailure.InvalidOptions); return; }
      if (processorOptions.injectPreparationFailure === true) { this.#failInitialization(ProcessorFailure.InjectedPreparation); return; }
      const exports = initSync({ module: processorOptions.module }) as { memory: WorkletMemory };
      const kernel = new WorkletKernel(
        processorOptions.channelCount,
        processorOptions.sampleRate,
        BigInt(processorOptions.sourceId),
        BigInt(processorOptions.epoch),
        processorOptions.maximumFrames,
        processorOptions.slotFrames,
      );
      if (processorOptions.sourceRate !== undefined && processorOptions.sourceFrames !== undefined) {
        kernel.set_media_timeline(processorOptions.sourceRate, BigInt(processorOptions.sourceFrames));
      }
      const preparationStatus = kernel.preparation_status();
      if (preparationStatus !== 0) { this.#failInitialization(preparationStatus); return; }
      const adapter = new PreparedPlanarAdapter(processorOptions.channelCount, kernel, exports.memory, processorOptions.slotFrames);
      this.#adapter = adapter;
      this.port.onmessage = (event) => {
        if (
          typeof event.data === "object" && event.data !== null &&
          "type" in event.data && event.data.type === "transport-port" &&
          "port" in event.data && event.data.port instanceof MessagePort
        ) {
          const transportPort = event.data.port;
          transportPort.onmessage = (transportEvent: MessageEvent<unknown>) => {
            const control = transportEvent.data as { type?: string; epoch?: number; target?: number; recovery?: boolean; disabled?: boolean; a?: number; b?: number; left?: number; right?: number; loopChange?: { a: number; b: number; enabled: boolean; edit: boolean } } | null;
            if (control?.type === "loop-head") {
              try {
                if (!Number.isSafeInteger(control.epoch) || BigInt(control.epoch!) !== kernel.epoch()) throw new Error("stale loop head");
                if (!control.recovery) {
                  if (!control.disabled && (!Number.isSafeInteger(control.a) || !Number.isSafeInteger(control.b) || !Number.isFinite(control.left) || !Number.isFinite(control.right))) throw new Error("invalid loop head");
                  kernel.configure_loop(BigInt(control.a ?? 0), BigInt(control.b ?? 0), control.left ?? 0, control.right ?? 0, !control.disabled);
                }
              } catch { this.#failRuntime(ProcessorFailure.InvalidTransportMessage); }
              return;
            }
            if (control?.type === "begin-seek" || control?.type === "finish-seek") {
              try {
                if (!Number.isSafeInteger(control.epoch) || !Number.isSafeInteger(control.target) || control.epoch! < 0 || control.target! < 0) throw new Error("invalid seek");
                const change=control.loopChange;
                if(change&&(!Number.isSafeInteger(change.a)||!Number.isSafeInteger(change.b)||typeof change.enabled!=="boolean"||typeof change.edit!=="boolean"))throw new Error("invalid loop change");
                const pcmFrame = control.type === "begin-seek"
                  ? change ? Number(kernel.begin_loop_change(BigInt(control.epoch!),BigInt(change.a),BigInt(change.b),change.enabled,change.edit)) : control.recovery ? Number(kernel.begin_loop_recovery(BigInt(control.epoch!))) : Number(kernel.begin_seek(BigInt(control.epoch!), BigInt(control.target!)))
                  : Number(kernel.pcm_position());
                if (control.type === "finish-seek" && !kernel.finish_seek(BigInt(control.epoch!))) throw new Error("stale seek");
                transportPort.postMessage({ type: "seek-transition", epoch: control.epoch, pcmFrame, loopEnabled: change ? kernel.loop_change_enabled() : undefined,
                  pauseRequired: !!change && kernel.loop_change_enabled() && kernel.loop_change_ended() });
              } catch { this.#failRuntime(ProcessorFailure.InvalidTransportMessage); }
              return;
            }
            if (control?.type === "supply") {
              transportPort.postMessage({ type: "supply", loopUnderruns: Number(kernel.loop_underruns()), free: [kernel.slot_free(0), kernel.slot_free(1), kernel.slot_free(2), kernel.slot_free(3)] });
              return;
            }
            if (!isPcmBlockMessage(transportEvent.data, processorOptions)) {
              this.#failRuntime(ProcessorFailure.InvalidTransportMessage);
              transportPort.onmessage = null;
              transportPort.close();
              return;
            }
            const accepted = adapter.acceptBlock(transportEvent.data);
            transportPort.postMessage(
              {
                type: "admission-result",
                slotId: transportEvent.data.slotId,
                accepted,
                buffer: transportEvent.data.buffer,
              },
              [transportEvent.data.buffer],
            );
          };
          transportPort.start();
          const memoryBytes = exports.memory.buffer.byteLength;
          this.#postInitialization({
            type: "ready", memoryBytes, memoryPages: memoryBytes / WASM_PAGE_BYTES,
            maximumFrames: kernel.maximum_frames(), sampleRate, slotCount: kernel.slot_count(),
          });
          return;
        }
        if (typeof event.data === "object" && event.data !== null && "type" in event.data && event.data.type === "snapshot") {
          this.port.postMessage({ type: "snapshot", snapshot: this.#snapshot() });
        }
      };
    } catch (error) {
      const code = typeof error === "number" && Number.isSafeInteger(error) ? error : ProcessorFailure.Instantiation;
      this.#failInitialization(code);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const adapter = this.#adapter;
    if (adapter === undefined || this.#failureCode !== 0) { fillSilence(outputs); return true; }
    return adapter.process(outputs);
  }

  #failInitialization(code: number): void {
    this.#failureCode = code; this.#adapter = undefined; this.#postInitialization({ type: "failed", code });
  }
  #failRuntime(code: number): void {
    if (this.#failureCode !== 0) return;
    this.#failureCode = code;
    this.port.postMessage({ type: "runtime-failed", code });
  }
  #postInitialization(message: unknown): void {
    if (this.#initializationSent) { this.#failureCode = ProcessorFailure.Instantiation; return; }
    this.#initializationSent = true; this.port.postMessage(message);
  }
  #snapshot(): RenderSnapshot {
    const adapter = this.#adapter;
    if (adapter !== undefined) {
      const snapshot = adapter.snapshot();
      return this.#failureCode === 0
        ? snapshot
        : { ...snapshot, failureCode: this.#failureCode };
    }
    return { epoch: 0, presentationTime: null, ready: false, pcmPosition: 0, sourcePosition: 0, renderFrame: 0, ended: false, failureCode: this.#failureCode, invalidBlockCount: 0, lastFrameCount: 0, memoryBytes: 0, processCount: 0, slotCount: 0, staleBlockCount: 0, starvationCount: 0 };
  }
}

function isProcessorOptions(value: unknown): value is ProcessorOptions {
  if (typeof value !== "object" || value === null) return false;
  const options = value as Partial<ProcessorOptions>;
  return (
    (options.channelCount === 1 || options.channelCount === 2) &&
    Number.isSafeInteger(options.epoch) && (options.epoch ?? -1) >= 0 &&
    Number.isSafeInteger(options.sourceId) && (options.sourceId ?? -1) >= 0 &&
    options.sampleRate === sampleRate &&
    Number.isSafeInteger(options.slotCount) && options.slotCount === 4 &&
    Number.isSafeInteger(options.slotFrames) && (options.slotFrames ?? 0) > 0 &&
    Number.isSafeInteger(options.maximumFrames) && (options.maximumFrames ?? 0) > 0 &&
    (options.maximumFrames ?? 0) <= MAXIMUM_PROOF_FRAMES &&
    ((options.sourceRate === undefined && options.sourceFrames === undefined) ||
      (Number.isSafeInteger(options.sourceRate) && (options.sourceRate ?? 0) > 0 &&
       Number.isSafeInteger(options.sourceFrames) && (options.sourceFrames ?? 0) > 0)) &&
    options.module instanceof WebAssembly.Module
  );
}

registerProcessor("kkb-prepared-kernel", KkbPreparedKernelProcessor);
