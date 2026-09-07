import { WorkletPlan, initSync } from "./generated/kkb_audio.js";
import { PreparedPlanAdapter, planSilence } from "./plan-adapter";

type ProcessorOptions = {
  channelCount: 1 | 2;
  sampleRate: number;
  description: Uint32Array;
  module: WebAssembly.Module;
};
type ConstructorOptions = { processorOptions?: ProcessorOptions };
type WorkletPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};

declare const sampleRate: number;
declare const AudioWorkletProcessor: { new (): { readonly port: WorkletPort } };
declare function registerProcessor(name: string, constructor: new (options: ConstructorOptions) => {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}): void;

class KkbPlanProcessor extends AudioWorkletProcessor {
  #adapter: PreparedPlanAdapter | undefined;

  constructor(options: ConstructorOptions) {
    super();
    try {
      const configuration = options.processorOptions;
      if (!isOptions(configuration)) { this.port.postMessage({ type: "failed", code: 40 }); return; }
      const exports = initSync({ module: configuration.module });
      const plan = new WorkletPlan(configuration.description, sampleRate, configuration.channelCount);
      const status = plan.preparation_status();
      if (status !== 0) {
        plan.free();
        this.port.postMessage({ type: "failed", code: status });
        return;
      }
      const adapter = new PreparedPlanAdapter(configuration.channelCount, plan, exports.memory);
      this.#adapter = adapter;
      this.port.onmessage = (event) => {
        if (typeof event.data === "object" && event.data !== null && "type" in event.data && event.data.type === "snapshot") {
          this.port.postMessage({ type: "snapshot", snapshot: adapter.snapshot() });
        }
      };
      this.port.postMessage({
        type: "ready", maximumFrames: plan.maximum_frames(),
        memoryBytes: exports.memory.buffer.byteLength, sampleRate, channelCount: configuration.channelCount,
      });
    } catch {
      this.#adapter = undefined;
      this.port.postMessage({ type: "failed", code: 42 });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const adapter = this.#adapter;
    if (adapter === undefined) { planSilence(outputs); return true; }
    return adapter.process(outputs);
  }
}

function isOptions(value: unknown): value is ProcessorOptions {
  if (typeof value !== "object" || value === null) return false;
  const options = value as Partial<ProcessorOptions>;
  return (options.channelCount === 1 || options.channelCount === 2) && options.sampleRate === sampleRate &&
    options.module instanceof WebAssembly.Module && options.description instanceof Uint32Array &&
    options.description.length > 0 && options.description.length <= 4_096;
}

registerProcessor("kkb-compiled-plan", KkbPlanProcessor);
