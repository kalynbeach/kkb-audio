import {
  isAdmissionResultMessage,
  type PcmBlockMessage,
  type PcmStreamConfig,
} from "./pcm-protocol";

const FREE = 0;
const IN_FLIGHT = 1;
const RETRY = 2;

export const PCM_WORKER_FAILURE_CODE = 50;
export const PROOF_REJECTION_RETRY_LIMIT = 64;

type PendingBlock = Omit<PcmBlockMessage, "buffer">;
type Schedule = (callback: () => void, delayMilliseconds: number) => void;

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

export class FixedPcmProducer {
  readonly #config: PcmStreamConfig;
  readonly #pool: FixedTransferPool;
  readonly #postBlock: (block: PcmBlockMessage) => void;
  readonly #postFailure: (code: number) => void;
  readonly #schedule: Schedule;
  readonly #pacingDelayMilliseconds: number;
  #activated = false;
  #scheduled = false;
  #failed = false;
  #consecutiveRejections = 0;

  constructor(
    config: PcmStreamConfig,
    postBlock: (block: PcmBlockMessage) => void,
    postFailure: (code: number) => void,
    schedule: Schedule = (callback, delayMilliseconds) => {
      setTimeout(callback, delayMilliseconds);
    },
  ) {
    this.#config = config;
    this.#pool = new FixedTransferPool(config);
    this.#postBlock = postBlock;
    this.#postFailure = postFailure;
    this.#schedule = schedule;
    this.#pacingDelayMilliseconds = Math.max(
      1,
      Math.ceil((config.slotFrames * 1_000) / config.sampleRate),
    );
  }

  prefill(slotCount: number): void {
    for (let count = 0; count < slotCount; count += 1) {
      const block = this.#pool.takeNext();
      if (block === undefined) break;
      this.#postBlock(block);
    }
    this.#pool.takeNext();
  }

  activate(): void {
    if (this.#activated) return;
    this.#activated = true;
    this.#schedulePump();
  }

  acceptAdmissionResult(value: unknown): boolean {
    if (this.#failed) return false;
    const valid = this.#pool.acceptAdmissionResult(value);
    if (!valid) {
      this.#fail();
      return false;
    }

    if (isAdmissionResultMessage(value, this.#config) && value.accepted) {
      this.#consecutiveRejections = 0;
    } else {
      this.#consecutiveRejections += 1;
      if (this.#consecutiveRejections >= PROOF_REJECTION_RETRY_LIMIT) {
        this.#fail();
        return true;
      }
    }
    if (this.#activated && !this.#failed) this.#schedulePump();
    return true;
  }

  snapshot(): { exhaustionCount: number; invalidRecycleCount: number } {
    return this.#pool.snapshot();
  }

  #schedulePump(): void {
    if (this.#scheduled || this.#failed) return;
    this.#scheduled = true;
    this.#schedule(() => {
      this.#scheduled = false;
      if (!this.#activated || this.#failed) return;
      const block = this.#pool.takeNext();
      if (block !== undefined) this.#postBlock(block);
    }, this.#pacingDelayMilliseconds);
  }

  #fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#postFailure(PCM_WORKER_FAILURE_CODE);
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
