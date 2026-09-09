import {
  isAdmissionResultMessage,
  type PcmBlockMessage,
  type PcmStreamConfig,
} from "./pcm-protocol";

const FREE = 0;
const IN_FLIGHT = 1;
const RETRY = 2;

type PendingBlock = Omit<PcmBlockMessage, "buffer">;

// Deterministic ownership/fault-injection fixture. Live workers use LocalPcmProducer.
export class FixedTransferPool {
  readonly #buffers: ArrayBuffer[];
  readonly #config: PcmStreamConfig;
  readonly #pending: Array<PendingBlock | undefined>;
  readonly #states: Uint8Array;
  #nextSlot = 0;
  #sourceFrame = 0;
  #exhaustionCount = 0;
  #invalidRecycleCount = 0;
  #exhausted = false;

  constructor(config: PcmStreamConfig) {
    this.#config = config;
    this.#states = new Uint8Array(config.slotCount);
    this.#pending = Array.from({ length: config.slotCount });
    this.#buffers = Array.from(
      { length: config.slotCount },
      () =>
        new ArrayBuffer(
          config.channelCount *
            config.slotFrames *
            Float32Array.BYTES_PER_ELEMENT,
        ),
    );
  }

  takeNext(): PcmBlockMessage | undefined {
    const retry = this.#takeWithState(RETRY);
    if (retry !== undefined) return retry;
    return this.#takeWithState(FREE);
  }

  acceptAdmissionResult(value: unknown): boolean {
    if (!isAdmissionResultMessage(value, this.#config)) {
      this.#invalidRecycleCount = saturatingIncrement(this.#invalidRecycleCount);
      return false;
    }
    if (this.#states[value.slotId] !== IN_FLIGHT) {
      this.#invalidRecycleCount = saturatingIncrement(this.#invalidRecycleCount);
      return false;
    }
    this.#buffers[value.slotId] = value.buffer;
    if (value.accepted) {
      this.#pending[value.slotId] = undefined;
      this.#states[value.slotId] = FREE;
    } else {
      this.#states[value.slotId] = RETRY;
    }
    this.#exhausted = false;
    return true;
  }

  snapshot(): { exhaustionCount: number; invalidRecycleCount: number } {
    return {
      exhaustionCount: this.#exhaustionCount,
      invalidRecycleCount: this.#invalidRecycleCount,
    };
  }

  #takeWithState(state: number): PcmBlockMessage | undefined {
    for (let offset = 0; offset < this.#config.slotCount; offset += 1) {
      const slotId = (this.#nextSlot + offset) % this.#config.slotCount;
      if (this.#states[slotId] !== state) continue;
      const buffer = this.#buffers[slotId];
      if (buffer === undefined || buffer.byteLength === 0) continue;
      let pending = this.#pending[slotId];
      if (pending === undefined) {
        fillDeterministic(buffer, this.#config, this.#sourceFrame);
        pending = {
          type: "pcm",
          slotId,
          epoch: this.#config.epoch,
          sourceFrameStart: this.#sourceFrame,
          validFrames: this.#config.slotFrames,
          discontinuity: this.#sourceFrame === 0,
          endOfStream: false,
        };
        this.#pending[slotId] = pending;
        this.#sourceFrame += this.#config.slotFrames;
      }
      this.#states[slotId] = IN_FLIGHT;
      this.#nextSlot = (slotId + 1) % this.#config.slotCount;
      this.#exhausted = false;
      return { ...pending, buffer };
    }
    if (state === FREE && !this.#exhausted) {
      this.#exhaustionCount = saturatingIncrement(this.#exhaustionCount);
      this.#exhausted = true;
    }
    return undefined;
  }
}

export function fillDeterministic(
  buffer: ArrayBuffer,
  config: PcmStreamConfig,
  sourceFrameStart: number,
): void {
  const samples = new Float32Array(buffer);
  for (let channel = 0; channel < config.channelCount; channel += 1) {
    const planeStart = channel * config.slotFrames;
    for (let frame = 0; frame < config.slotFrames; frame += 1) {
      const base = (((sourceFrameStart + frame) & 1_023) - 512) / 16_384;
      samples[planeStart + frame] = channel === 0 ? base : -base;
    }
  }
}

function saturatingIncrement(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}
