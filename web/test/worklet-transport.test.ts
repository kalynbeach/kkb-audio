import { describe, expect, mock, test } from "bun:test";

const memory = { buffer: new ArrayBuffer(16_777_216) };

class FakeWorkletKernel {
  constructor(
    _channelCount: number,
    _sampleRate: number,
    _sourceId: bigint,
    _epoch: bigint,
    _maximumFrames: number,
    _slotFrames: number,
  ) {}

  source_position(): bigint { return 0n; }
  next_frame(): bigint { return 0n; }
  ended(): boolean { return false; }
  slot_free(): boolean { return true; }
  preparation_status(): number { return 0; }
  maximum_frames(): number { return 1_024; }
  slot_count(): number { return 4; }
  reserve_slot(_slotId: number): boolean { return true; }
  cancel_slot(_slotId: number): void {}
  slot_left_ptr(slotId: number): number { return 8_192 + slotId * 2_048; }
  slot_right_ptr(slotId: number): number { return 9_216 + slotId * 2_048; }
  left_ptr(): number { return 0; }
  right_ptr(): number { return 4_096; }
  admit(): number { return 0; }
  render(): number { return 0; }
  invalid_count(): bigint { return 0n; }
  stale_count(): bigint { return 0n; }
  starvation_count(): bigint { return 0n; }
}

mock.module("../src/generated/kkb_audio.js", () => ({
  initSync: () => ({ memory }),
  WorkletKernel: FakeWorkletKernel,
}));

type ControlMessage = { type?: unknown; code?: unknown; snapshot?: unknown };

class FakeControlPort {
  readonly messages: ControlMessage[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  #resolveFailure: ((message: ControlMessage) => void) | undefined;
  readonly runtimeFailure = new Promise<ControlMessage>((resolve) => {
    this.#resolveFailure = resolve;
  });

  postMessage(message: ControlMessage): void {
    this.messages.push(message);
    if (message.type === "runtime-failed") this.#resolveFailure?.(message);
  }
}

class FakeAudioWorkletProcessor {
  readonly port = new FakeControlPort();
}

type Processor = FakeAudioWorkletProcessor & {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
};

type ProcessorConstructor = new (options: {
  processorOptions: Record<string, unknown>;
}) => Processor;

let ProcessorClass: ProcessorConstructor | undefined;
Object.defineProperties(globalThis, {
  AudioWorkletProcessor: {
    configurable: true,
    value: FakeAudioWorkletProcessor,
  },
  registerProcessor: {
    configurable: true,
    value: (_name: string, constructor: ProcessorConstructor) => {
      ProcessorClass = constructor;
    },
  },
  sampleRate: { configurable: true, value: 48_000 },
});

await import("../src/worklet-processor");

const config = {
  channelCount: 2,
  epoch: 1,
  maximumFrames: 1_024,
  sampleRate: 48_000,
  slotCount: 4,
  slotFrames: 256,
  sourceId: 3,
};

const emptyModule = new WebAssembly.Module(
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
);

describe("AudioWorklet PCM transport", () => {
  test("terminally fails a malformed transferred block instead of stranding its slot", async () => {
    if (ProcessorClass === undefined) throw new Error("processor was not registered");
    const processor = new ProcessorClass({
      processorOptions: { ...config, module: emptyModule },
    });
    const channel = new MessageChannel();
    processor.port.onmessage?.({
      data: { type: "transport-port", port: channel.port2 },
    });

    const buffer = new ArrayBuffer(2 * 256 * Float32Array.BYTES_PER_ELEMENT);
    channel.port1.postMessage(
      {
        type: "pcm",
        slotId: 0,
        epoch: 1,
        sourceFrameStart: 0,
        validFrames: 0,
        discontinuity: true,
        endOfStream: false,
        buffer,
      },
      [buffer],
    );
    expect(buffer.byteLength).toBe(0);

    await expect(processor.port.runtimeFailure).resolves.toEqual({
      type: "runtime-failed",
      code: 43,
    });
    expect(channel.port2.onmessage).toBeNull();
    expect(
      processor.port.messages.filter((message) => message.type === "runtime-failed"),
    ).toHaveLength(1);

    const left = new Float32Array(128).fill(1);
    const right = new Float32Array(128).fill(1);
    expect(processor.process([], [[left, right]], {})).toBe(true);
    expect(left.every((sample) => Object.is(sample, 0))).toBe(true);
    expect(right.every((sample) => Object.is(sample, 0))).toBe(true);

    processor.port.onmessage?.({ data: { type: "snapshot" } });
    expect(processor.port.messages.at(-1)).toMatchObject({
      type: "snapshot",
      snapshot: { failureCode: 43 },
    });
    channel.port1.close();
  });
});
