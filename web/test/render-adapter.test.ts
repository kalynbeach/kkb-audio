import { describe, expect, test } from "bun:test";
import {
  HostFailure,
  PreparedPlanarAdapter,
  RenderStatus,
  type WorkletKernelBinding,
  type WorkletMemory,
} from "../src/render-adapter";

class FakeKernel implements WorkletKernelBinding {
  readonly #memory: MutableMemory;
  readonly #maximumFrames: number;
  readonly #rightPointer: number;
  calls = 0;
  nextStatus: number = RenderStatus.Rendered;
  readonly #reserved = [false, false, false, false];

  constructor(memory: MutableMemory, maximumFrames: number, rightPointer = 4_096) {
    this.#memory = memory;
    this.#maximumFrames = maximumFrames;
    this.#rightPointer = rightPointer;
  }

  admit(_slotId: number, _epoch: bigint, _sourceFrameStart: bigint, _validFrames: number, _discontinuity: boolean, _endOfStream: boolean): number {
    return RenderStatus.Rendered;
  }

  cancel_slot(slotId: number): void { this.#reserved[slotId] = false; }
  invalid_count(): bigint { return 0n; }
  reserve_slot(slotId: number): boolean {
    if (this.#reserved[slotId] !== false) return false;
    this.#reserved[slotId] = true;
    return true;
  }
  slot_count(): number { return 4; }
  slot_left_ptr(slotId: number): number { return 8_192 + slotId * this.#maximumFrames * 4; }
  slot_right_ptr(slotId: number): number { return 16_384 + slotId * this.#maximumFrames * 4; }
  stale_count(): bigint { return 0n; }
  starvation_count(): bigint { return 0n; }

  render(frameCount: number): number {
    this.calls += 1;
    if (this.nextStatus !== RenderStatus.Rendered) {
      return this.nextStatus;
    }
    const left = new Float32Array(this.#memory.buffer, 0, this.#maximumFrames);
    const right = new Float32Array(
      this.#memory.buffer,
      this.#rightPointer,
      this.#maximumFrames,
    );
    for (let frame = 0; frame < frameCount; frame += 1) {
      left[frame] = frame + 0.25;
      right[frame] = -(frame + 0.25);
    }
    return RenderStatus.Rendered;
  }

  left_ptr(): number {
    return 0;
  }

  right_ptr(): number {
    return this.#rightPointer;
  }

  maximum_frames(): number {
    return this.#maximumFrames;
  }
}

class MutableMemory implements WorkletMemory {
  buffer: ArrayBuffer;

  constructor(bytes = 32_768) {
    this.buffer = new ArrayBuffer(bytes);
  }
}

function expectPositiveZero(samples: Float32Array): void {
  expect(Array.from(samples).every((sample) => Object.is(sample, 0))).toBe(true);
}

describe("PreparedPlanarAdapter", () => {
  test("maps mono Wasm storage using actual non-128 output lengths", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 257);
    const adapter = new PreparedPlanarAdapter(1, kernel, memory);

    const seventeen = new Float32Array(17).fill(Number.NaN);
    expect(adapter.process([[seventeen]])).toBe(true);
    expect(seventeen[0]).toBe(0.25);
    expect(seventeen[16]).toBe(16.25);

    const twoHundredFiftySeven = new Float32Array(257).fill(Number.NaN);
    expect(adapter.process([[twoHundredFiftySeven]])).toBe(true);
    expect(twoHundredFiftySeven[256]).toBe(256.25);
    expect(adapter.snapshot()).toEqual({
      failureCode: 0,
      invalidBlockCount: 0,
      lastFrameCount: 257,
      memoryBytes: 32_768,
      processCount: 2,
      slotCount: 4,
      staleBlockCount: 0,
      starvationCount: 0,
    });
  });

  test("maps stereo into distinct host channels", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 257);
    const adapter = new PreparedPlanarAdapter(2, kernel, memory);
    const left = new Float32Array(96).fill(Number.NaN);
    const right = new Float32Array(96).fill(Number.NaN);

    adapter.process([[left, right]]);

    expect(left.buffer).not.toBe(right.buffer);
    expect(left[95]).toBe(95.25);
    expect(right[95]).toBe(-95.25);
  });

  test("unequal stereo arrays cause permanent positive-zero silence", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 257);
    const adapter = new PreparedPlanarAdapter(2, kernel, memory);
    const left = new Float32Array(17).fill(1);
    const right = new Float32Array(16).fill(1);

    adapter.process([[left, right]]);

    expectPositiveZero(left);
    expectPositiveZero(right);
    expect(adapter.snapshot().failureCode).toBe(HostFailure.InvalidOutput);
    expect(kernel.calls).toBe(0);

    const laterLeft = new Float32Array(17).fill(1);
    const laterRight = new Float32Array(17).fill(1);
    adapter.process([[laterLeft, laterRight]]);
    expectPositiveZero(laterLeft);
    expectPositiveZero(laterRight);
    expect(kernel.calls).toBe(0);
  });

  test("capacity excess becomes permanent silence without calling Wasm", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 64);
    const adapter = new PreparedPlanarAdapter(1, kernel, memory);
    const output = new Float32Array(65).fill(1);

    adapter.process([[output]]);

    expectPositiveZero(output);
    expect(adapter.snapshot().failureCode).toBe(RenderStatus.CapacityExceeded);
    expect(kernel.calls).toBe(0);
  });

  test("memory buffer identity change becomes permanent silence", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 64);
    const adapter = new PreparedPlanarAdapter(1, kernel, memory);
    memory.buffer = new ArrayBuffer(16_384);
    const output = new Float32Array(17).fill(1);

    adapter.process([[output]]);

    expectPositiveZero(output);
    expect(adapter.snapshot().failureCode).toBe(HostFailure.MemoryChanged);
    expect(kernel.calls).toBe(0);
  });

  test("maps every non-rendered Wasm status to an unambiguous failure", () => {
    const cases = [
      [RenderStatus.InvalidLayout, HostFailure.WasmInvalidLayout],
      [RenderStatus.CapacityExceeded, HostFailure.WasmCapacityExceeded],
      [RenderStatus.Terminal, HostFailure.WasmTerminal],
      [RenderStatus.ClockOverflow, HostFailure.WasmClockOverflow],
      [RenderStatus.InvalidInput, HostFailure.WasmInvalidInput],
      [99, HostFailure.WasmUnknownStatus],
    ] as const;

    for (const [status, expectedFailure] of cases) {
      const memory = new MutableMemory();
      const kernel = new FakeKernel(memory, 64);
      kernel.nextStatus = status;
      const adapter = new PreparedPlanarAdapter(1, kernel, memory);
      const output = new Float32Array(17).fill(1);

      adapter.process([[output]]);

      expectPositiveZero(output);
      expect(adapter.snapshot().failureCode).toBe(expectedFailure);
      expect(expectedFailure).not.toBe(HostFailure.Exception);
    }
  });

  test("thrown exceptions use their own failure code and produce silence", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 64);
    kernel.render = () => {
      throw new Error("injected");
    };
    const adapter = new PreparedPlanarAdapter(1, kernel, memory);
    const output = new Float32Array(17).fill(1);

    expect(() => adapter.process([[output]])).not.toThrow();

    expectPositiveZero(output);
    expect(adapter.snapshot().failureCode).toBe(HostFailure.Exception);
  });
});
