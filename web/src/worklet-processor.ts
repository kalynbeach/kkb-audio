import { WorkletKernel, initSync } from "./generated/kkb_audio.js";
import {
  PreparedPlanarAdapter,
  fillSilence,
  type RenderSnapshot,
  type WorkletMemory,
} from "./render-adapter";

const ProcessorFailure = {
  InvalidOptions: 40,
  InjectedPreparation: 41,
  Instantiation: 42,
} as const;

const MAXIMUM_PROOF_FRAMES = 1_024;
const WASM_PAGE_BYTES = 65_536;

type ProcessorOptions = {
  channelCount: number;
  frequency: number;
  gain: number;
  injectPreparationFailure?: boolean;
  maximumFrames: number;
  module: WebAssembly.Module;
};

type ProcessorConstructorOptions = {
  processorOptions?: ProcessorOptions;
};

type MessageEventLike = {
  data: unknown;
};

type WorkletPort = {
  onmessage: ((event: MessageEventLike) => void) | null;
  postMessage(message: unknown): void;
};

declare const sampleRate: number;
declare const AudioWorkletProcessor: {
  new (): {
    readonly port: WorkletPort;
  };
};
declare function registerProcessor(
  name: string,
  processorCtor: new (options: ProcessorConstructorOptions) => {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  },
): void;

class KkbPreparedKernelProcessor extends AudioWorkletProcessor {
  #adapter: PreparedPlanarAdapter | undefined;
  #failureCode = 0;
  #initializationSent = false;

  constructor(options: ProcessorConstructorOptions) {
    super();
    this.port.onmessage = (event) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "snapshot"
      ) {
        this.port.postMessage({
          type: "snapshot",
          snapshot: this.#snapshot(),
        });
      }
    };

    try {
      const processorOptions = options.processorOptions;
      if (!isProcessorOptions(processorOptions)) {
        this.#failInitialization(ProcessorFailure.InvalidOptions);
        return;
      }
      if (processorOptions.injectPreparationFailure === true) {
        this.#failInitialization(ProcessorFailure.InjectedPreparation);
        return;
      }

      const exports = initSync({ module: processorOptions.module }) as {
        memory: WorkletMemory;
      };
      const kernel = new WorkletKernel(
        processorOptions.channelCount,
        sampleRate,
        processorOptions.frequency,
        processorOptions.gain,
        processorOptions.maximumFrames,
      );
      const preparationStatus = kernel.preparation_status();
      if (preparationStatus !== 0) {
        this.#failInitialization(preparationStatus);
        return;
      }
      this.#adapter = new PreparedPlanarAdapter(
        processorOptions.channelCount,
        kernel,
        exports.memory,
      );
      const memoryBytes = exports.memory.buffer.byteLength;
      this.#postInitialization({
        type: "ready",
        memoryBytes,
        memoryPages: memoryBytes / WASM_PAGE_BYTES,
        maximumFrames: kernel.maximum_frames(),
        sampleRate,
      });
    } catch (error) {
      const code =
        typeof error === "number" && Number.isSafeInteger(error)
          ? error
          : ProcessorFailure.Instantiation;
      this.#failInitialization(code);
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const adapter = this.#adapter;
    if (adapter === undefined || this.#failureCode !== 0) {
      fillSilence(outputs);
      return true;
    }
    return adapter.process(outputs);
  }

  #failInitialization(code: number): void {
    this.#failureCode = code;
    this.#adapter = undefined;
    this.#postInitialization({ type: "failed", code });
  }

  #postInitialization(message: unknown): void {
    if (this.#initializationSent) {
      this.#failureCode = ProcessorFailure.Instantiation;
      return;
    }
    this.#initializationSent = true;
    this.port.postMessage(message);
  }

  #snapshot(): RenderSnapshot {
    const adapter = this.#adapter;
    if (adapter !== undefined) {
      return adapter.snapshot();
    }
    return {
      failureCode: this.#failureCode,
      lastFrameCount: 0,
      memoryBytes: 0,
      processCount: 0,
    };
  }
}

function isProcessorOptions(value: unknown): value is ProcessorOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const options = value as Partial<ProcessorOptions>;
  return (
    (options.channelCount === 1 || options.channelCount === 2) &&
    typeof options.frequency === "number" &&
    Number.isFinite(options.frequency) &&
    typeof options.gain === "number" &&
    Number.isFinite(options.gain) &&
    Number.isSafeInteger(options.maximumFrames) &&
    (options.maximumFrames ?? 0) > 0 &&
    (options.maximumFrames ?? 0) <= MAXIMUM_PROOF_FRAMES &&
    options.module instanceof WebAssembly.Module
  );
}

registerProcessor("kkb-prepared-kernel", KkbPreparedKernelProcessor);
