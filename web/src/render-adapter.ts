import type { PcmBlockMessage } from "./pcm-protocol";

export const RenderStatus = {
  Rendered: 0,
  InvalidLayout: 1,
  CapacityExceeded: 2,
  Terminal: 3,
  ClockOverflow: 4,
  InvalidInput: 6,
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
  WasmInvalidInput: 39,
} as const;

export interface WorkletKernelBinding {
  admit(slotId: number, epoch: bigint, sourceFrameStart: bigint, validFrames: number, discontinuity: boolean, endOfStream: boolean): number;
  cancel_slot(slotId: number): void;
  invalid_count(): bigint;
  render(frameCount: number): number;
  reserve_slot(slotId: number): boolean;
  left_ptr(): number;
  right_ptr(): number;
  maximum_frames(): number;
  slot_count(): number;
  slot_left_ptr(slotId: number): number;
  slot_right_ptr(slotId: number): number;
  stale_count(): bigint;
  starvation_count(): bigint;
}

export interface WorkletMemory { readonly buffer: ArrayBuffer; }

export type RenderSnapshot = {
  failureCode: number;
  invalidBlockCount: number;
  lastFrameCount: number;
  memoryBytes: number;
  processCount: number;
  slotCount: number;
  staleBlockCount: number;
  starvationCount: number;
};

export class PreparedPlanarAdapter {
  readonly #channelCount: number;
  readonly #kernel: WorkletKernelBinding;
  readonly #memory: WorkletMemory;
  readonly #memoryBuffer: ArrayBuffer;
  readonly #memoryBytes: number;
  readonly #maximumFrames: number;
  readonly #slotFrames: number;
  readonly #left: Float32Array;
  readonly #right: Float32Array | undefined;
  readonly #slotLeft: Float32Array[];
  readonly #slotRight: Float32Array[];
  #failureCode = 0;
  #lastFrameCount = 0;
  #processCount = 0;

  constructor(channelCount: number, kernel: WorkletKernelBinding, memory: WorkletMemory, slotFrames?: number) {
    if (channelCount !== 1 && channelCount !== 2) throw HostFailure.InvalidOutput;
    if (!(memory.buffer instanceof ArrayBuffer)) throw HostFailure.MemoryChanged;
    this.#channelCount = channelCount;
    this.#kernel = kernel;
    this.#memory = memory;
    this.#memoryBuffer = memory.buffer;
    this.#memoryBytes = memory.buffer.byteLength;
    this.#maximumFrames = kernel.maximum_frames();
    this.#slotFrames = slotFrames ?? this.#maximumFrames;
    this.#left = new Float32Array(this.#memoryBuffer, kernel.left_ptr(), this.#maximumFrames);
    this.#right = channelCount === 2
      ? new Float32Array(this.#memoryBuffer, kernel.right_ptr(), this.#maximumFrames)
      : undefined;
    this.#slotLeft = [];
    this.#slotRight = [];
    for (let slotId = 0; slotId < kernel.slot_count(); slotId += 1) {
      if (!kernel.reserve_slot(slotId)) throw HostFailure.Exception;
      const leftPointer = kernel.slot_left_ptr(slotId);
      const rightPointer = kernel.slot_right_ptr(slotId);
      kernel.cancel_slot(slotId);
      this.#slotLeft.push(new Float32Array(this.#memoryBuffer, leftPointer, this.#slotFrames));
      if (channelCount === 2) {
        this.#slotRight.push(new Float32Array(this.#memoryBuffer, rightPointer, this.#slotFrames));
      }
    }
  }

  acceptBlock(message: PcmBlockMessage): boolean {
    if (this.#failureCode !== 0 || this.#memory.buffer !== this.#memoryBuffer) return false;
    if (!this.#kernel.reserve_slot(message.slotId)) return false;
    try {
      const source = new Float32Array(message.buffer);
      const left = this.#slotLeft[message.slotId];
      if (left === undefined) { this.#kernel.cancel_slot(message.slotId); return false; }
      for (let frame = 0; frame < message.validFrames; frame += 1) left[frame] = source[frame] ?? 0;
      if (this.#channelCount === 2) {
        const right = this.#slotRight[message.slotId];
        if (right === undefined) { this.#kernel.cancel_slot(message.slotId); return false; }
        for (let frame = 0; frame < message.validFrames; frame += 1) {
          right[frame] = source[this.#slotFrames + frame] ?? 0;
        }
      }
      const status = this.#kernel.admit(
        message.slotId,
        BigInt(message.epoch),
        BigInt(message.sourceFrameStart),
        message.validFrames,
        message.discontinuity,
        message.endOfStream,
      );
      if (status !== RenderStatus.Rendered) this.#kernel.cancel_slot(message.slotId);
      return status === RenderStatus.Rendered;
    } catch {
      this.#kernel.cancel_slot(message.slotId);
      return false;
    }
  }

  process(outputs: Float32Array[][]): boolean {
    try {
      this.#processCount += 1;
      if (this.#failureCode !== 0) { fillSilence(outputs); return true; }
      if (this.#memory.buffer !== this.#memoryBuffer || this.#memory.buffer.byteLength !== this.#memoryBytes) {
        return this.#fail(outputs, HostFailure.MemoryChanged);
      }
      if (outputs.length !== 1) return this.#fail(outputs, HostFailure.InvalidOutput);
      const channels = outputs[0];
      if (channels === undefined || channels.length !== this.#channelCount) return this.#fail(outputs, HostFailure.InvalidOutput);
      const leftOutput = channels[0];
      if (leftOutput === undefined) return this.#fail(outputs, HostFailure.InvalidOutput);
      const frameCount = leftOutput.length;
      if (frameCount > this.#maximumFrames) return this.#fail(outputs, RenderStatus.CapacityExceeded);
      if (this.#channelCount === 2 && (channels[1] === undefined || channels[1].length !== frameCount)) {
        return this.#fail(outputs, HostFailure.InvalidOutput);
      }
      const status = this.#kernel.render(frameCount);
      if (status !== RenderStatus.Rendered) return this.#fail(outputs, wasmRenderFailure(status));
      for (let frame = 0; frame < frameCount; frame += 1) leftOutput[frame] = this.#left[frame] ?? 0;
      if (this.#channelCount === 2) {
        const rightOutput = channels[1]; const right = this.#right;
        if (rightOutput === undefined || right === undefined) return this.#fail(outputs, HostFailure.InvalidOutput);
        for (let frame = 0; frame < frameCount; frame += 1) rightOutput[frame] = right[frame] ?? 0;
      }
      this.#lastFrameCount = frameCount;
      return true;
    } catch { return this.#fail(outputs, HostFailure.Exception); }
  }

  snapshot(): RenderSnapshot {
    return {
      failureCode: this.#failureCode,
      invalidBlockCount: Number(this.#kernel.invalid_count()),
      lastFrameCount: this.#lastFrameCount,
      memoryBytes: this.#memoryBytes,
      processCount: this.#processCount,
      slotCount: this.#kernel.slot_count(),
      staleBlockCount: Number(this.#kernel.stale_count()),
      starvationCount: Number(this.#kernel.starvation_count()),
    };
  }

  #fail(outputs: Float32Array[][], code: number): true {
    this.#failureCode = code; fillSilence(outputs); return true;
  }
}

function wasmRenderFailure(status: number): number {
  switch (status) {
    case RenderStatus.InvalidLayout: return HostFailure.WasmInvalidLayout;
    case RenderStatus.CapacityExceeded: return HostFailure.WasmCapacityExceeded;
    case RenderStatus.Terminal: return HostFailure.WasmTerminal;
    case RenderStatus.ClockOverflow: return HostFailure.WasmClockOverflow;
    case RenderStatus.InvalidInput: return HostFailure.WasmInvalidInput;
    default: return HostFailure.WasmUnknownStatus;
  }
}

export function fillSilence(outputs: Float32Array[][]): void {
  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const channels = outputs[outputIndex]; if (channels === undefined) continue;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) channels[channelIndex]?.fill(0);
  }
}
