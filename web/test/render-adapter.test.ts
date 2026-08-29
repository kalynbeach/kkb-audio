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

  constructor(memory: MutableMemory, maximumFrames: number, rightPointer = 4_096) {
    this.#memory = memory;
    this.#maximumFrames = maximumFrames;
    this.#rightPointer = rightPointer;
  }

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

  constructor(bytes = 16_384) {
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
      lastFrameCount: 257,
      memoryBytes: 16_384,
      processCount: 2,
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

  test("non-rendered Wasm status and thrown exceptions produce silence", () => {
    const memory = new MutableMemory();
    const kernel = new FakeKernel(memory, 64);
    kernel.nextStatus = RenderStatus.Terminal;
    const adapter = new PreparedPlanarAdapter(1, kernel, memory);
    const terminalOutput = new Float32Array(17).fill(1);
    adapter.process([[terminalOutput]]);
    expectPositiveZero(terminalOutput);
    expect(adapter.snapshot().failureCode).toBe(
      HostFailure.WasmRender + RenderStatus.Terminal,
    );

    const throwingMemory = new MutableMemory();
    const throwingKernel = new FakeKernel(throwingMemory, 64);
    throwingKernel.render = () => {
      throw new Error("injected");
    };
    const throwingAdapter = new PreparedPlanarAdapter(
      1,
      throwingKernel,
      throwingMemory,
    );
    const thrownOutput = new Float32Array(17).fill(1);
    expect(() => throwingAdapter.process([[thrownOutput]])).not.toThrow();
    expectPositiveZero(thrownOutput);
    expect(throwingAdapter.snapshot().failureCode).toBe(HostFailure.Exception);
  });
});
