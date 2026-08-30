export const RenderStatus = {
  Rendered: 0,
  InvalidLayout: 1,
  CapacityExceeded: 2,
  Terminal: 3,
  ClockOverflow: 4,
} as const;

export const HostFailure = {
  InvalidOutput: 30,
  MemoryChanged: 31,
  Exception: 33,
  WasmInvalidLayout: 34,
  WasmCapacityExceeded: 35,
  WasmTerminal: 36,
  WasmClockOverflow: 37,
  WasmUnknownStatus: 38,
} as const;

export interface WorkletKernelBinding {
  render(frameCount: number): number;
  left_ptr(): number;
  right_ptr(): number;
  maximum_frames(): number;
}

export interface WorkletMemory {
  readonly buffer: ArrayBuffer;
}

export type RenderSnapshot = {
  failureCode: number;
  lastFrameCount: number;
  memoryBytes: number;
  processCount: number;
};

export class PreparedPlanarAdapter {
  readonly #channelCount: number;
  readonly #kernel: WorkletKernelBinding;
  readonly #memory: WorkletMemory;
  readonly #memoryBuffer: ArrayBuffer;
  readonly #memoryBytes: number;
  readonly #maximumFrames: number;
  readonly #left: Float32Array;
  readonly #right: Float32Array | undefined;
  #failureCode = 0;
  #lastFrameCount = 0;
  #processCount = 0;

  constructor(
    channelCount: number,
    kernel: WorkletKernelBinding,
    memory: WorkletMemory,
  ) {
    if (channelCount !== 1 && channelCount !== 2) {
      throw HostFailure.InvalidOutput;
    }
    if (!(memory.buffer instanceof ArrayBuffer)) {
      throw HostFailure.MemoryChanged;
    }

    this.#channelCount = channelCount;
    this.#kernel = kernel;
    this.#memory = memory;
    this.#memoryBuffer = memory.buffer;
    this.#memoryBytes = memory.buffer.byteLength;
    this.#maximumFrames = kernel.maximum_frames();
    this.#left = new Float32Array(
      this.#memoryBuffer,
      kernel.left_ptr(),
      this.#maximumFrames,
    );
    this.#right =
      channelCount === 2
        ? new Float32Array(
            this.#memoryBuffer,
            kernel.right_ptr(),
            this.#maximumFrames,
          )
        : undefined;
  }

  process(outputs: Float32Array[][]): boolean {
    try {
      this.#processCount += 1;
      if (this.#failureCode !== 0) {
        fillSilence(outputs);
        return true;
      }
      if (
        this.#memory.buffer !== this.#memoryBuffer ||
        this.#memory.buffer.byteLength !== this.#memoryBytes
      ) {
        return this.#fail(outputs, HostFailure.MemoryChanged);
      }
      if (outputs.length !== 1) {
        return this.#fail(outputs, HostFailure.InvalidOutput);
      }

      const channels = outputs[0];
      if (channels === undefined || channels.length !== this.#channelCount) {
        return this.#fail(outputs, HostFailure.InvalidOutput);
      }
      const leftOutput = channels[0];
      if (leftOutput === undefined) {
        return this.#fail(outputs, HostFailure.InvalidOutput);
      }
      const frameCount = leftOutput.length;
      if (frameCount > this.#maximumFrames) {
        return this.#fail(outputs, RenderStatus.CapacityExceeded);
      }
      if (
        this.#channelCount === 2 &&
        (channels[1] === undefined || channels[1].length !== frameCount)
      ) {
        return this.#fail(outputs, HostFailure.InvalidOutput);
      }

      const status = this.#kernel.render(frameCount);
      if (status !== RenderStatus.Rendered) {
        return this.#fail(outputs, wasmRenderFailure(status));
      }

      for (let frame = 0; frame < frameCount; frame += 1) {
        leftOutput[frame] = this.#left[frame];
      }
      if (this.#channelCount === 2) {
        const rightOutput = channels[1];
        const right = this.#right;
        if (rightOutput === undefined || right === undefined) {
          return this.#fail(outputs, HostFailure.InvalidOutput);
        }
        for (let frame = 0; frame < frameCount; frame += 1) {
          rightOutput[frame] = right[frame];
        }
      }
      this.#lastFrameCount = frameCount;
      return true;
    } catch {
      return this.#fail(outputs, HostFailure.Exception);
    }
  }

  snapshot(): RenderSnapshot {
    return {
      failureCode: this.#failureCode,
      lastFrameCount: this.#lastFrameCount,
      memoryBytes: this.#memoryBytes,
      processCount: this.#processCount,
    };
  }

  #fail(outputs: Float32Array[][], code: number): true {
    this.#failureCode = code;
    fillSilence(outputs);
    return true;
  }
}

function wasmRenderFailure(status: number): number {
  switch (status) {
    case RenderStatus.InvalidLayout:
      return HostFailure.WasmInvalidLayout;
    case RenderStatus.CapacityExceeded:
      return HostFailure.WasmCapacityExceeded;
    case RenderStatus.Terminal:
      return HostFailure.WasmTerminal;
    case RenderStatus.ClockOverflow:
      return HostFailure.WasmClockOverflow;
    default:
      return HostFailure.WasmUnknownStatus;
  }
}

export function fillSilence(outputs: Float32Array[][]): void {
  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const channels = outputs[outputIndex];
    if (channels === undefined) {
      continue;
    }
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      channels[channelIndex]?.fill(0);
    }
  }
}
