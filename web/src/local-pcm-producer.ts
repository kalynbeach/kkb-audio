import { isAdmissionResultMessage, type PcmBlockMessage, type PcmStreamConfig } from "./pcm-protocol";

// Admission returns transfer ownership, never consumption credit. Only an off-process
// free-slot reply permits reuse. One read/admission at a time fixes source ordering.
export class LocalPcmProducer {
  readonly buffers: ArrayBuffer[];
  #slot = 0;
  #position = 0;
  #pending: PcmBlockMessage | undefined;
  #busy = false;
  #active = false;
  #ready = false;
  initialAdmittedBlocks = 0;
  #timer = false;
  #stalled = false;
  #pollPending = false;
  maxPollDelayMilliseconds = 0;
  #failed = false;
  #credits: boolean[];
  polls = 0;
  readFrames = 0;
  admittedFrames = 0;
  rejections = 0;
  constructor(
    readonly config: PcmStreamConfig,
    readonly totalFrames: number,
    readonly fill: (buffer: ArrayBuffer, start: number, frames: number) => Promise<void>,
    readonly post: (message: unknown, transfer?: Transferable[]) => void,
    readonly ready: () => void,
    readonly fail: (error: unknown) => void,
    readonly schedule: (callback: () => void, ms: number) => void = (callback, ms) => { setTimeout(callback, ms); },
  ) {
    this.buffers = Array.from({ length: config.slotCount }, () => new ArrayBuffer(config.channelCount * config.slotFrames * 4));
    this.#credits = Array.from({ length: config.slotCount }, () => true);
  }
  start(): void { void this.#pump(); }
  activate(): void { this.#active = true; this.#schedule(); }
  stall(value: boolean): void { this.#stalled = value; if (!value) this.#schedule(); }
  accept(value: unknown): void {
    if (this.#failed) return;
    if (isAdmissionResultMessage(value, this.config)) {
      if (!this.#busy || this.#pending?.slotId !== value.slotId) { this.#failure("unexpected admission"); return; }
      this.buffers[value.slotId] = value.buffer;
      this.#pending.buffer = value.buffer;
      this.#busy = false;
      if (value.accepted) {
        this.#position += this.#pending.validFrames;
        this.admittedFrames = this.#position;
        this.#pending = undefined;
        this.#slot = (this.#slot + 1) % this.config.slotCount;
        if (!this.#ready) this.initialAdmittedBlocks += 1;
      } else { this.rejections += 1; }
      if (!this.#ready && (this.initialAdmittedBlocks === this.config.slotCount || this.#position === this.totalFrames)) {
        this.#ready = true; this.ready();
      }
      if (value.accepted && (!this.#ready || this.#active) && this.#credits[this.#slot]) void this.#pump();
      else this.#schedule();
      return;
    }
    const message = value as { type?: string; free?: unknown } | null;
    if (message?.type === "supply" && Array.isArray(message.free) && message.free.length === this.config.slotCount && message.free.every(v => typeof v === "boolean")) {
      if (!this.#pollPending) { this.#failure("unsolicited supply reply"); return; }
      this.#pollPending = false;
      this.#credits = message.free;
      void this.#pump();
    } else this.#failure("invalid supply reply");
  }
  async #pump(): Promise<void> {
    if (this.#busy || this.#failed || this.#stalled || this.#position === this.totalFrames) return;
    if (!this.#credits[this.#slot]) { this.#schedule(); return; }
    this.#busy = true;
    this.#credits[this.#slot] = false;
    try {
      if (this.#pending === undefined) {
        const buffer = this.buffers[this.#slot]!;
        const frames = Math.min(this.config.slotFrames, this.totalFrames - this.#position);
        await this.fill(buffer, this.#position, frames);
        this.readFrames = this.#position + frames;
        this.#pending = { type: "pcm", slotId: this.#slot, epoch: this.config.epoch, sourceFrameStart: this.#position, validFrames: frames, discontinuity: this.#position === 0, endOfStream: this.#position + frames === this.totalFrames, buffer };
      }
      this.post(this.#pending, [this.#pending.buffer]);
    } catch (error) { this.#failure(error); }
  }
  #schedule(): void {
    if (this.#timer || this.#pollPending || !this.#active || this.#failed || this.#stalled || this.#position === this.totalFrames) return;
    this.#timer = true;
    const scheduledAt = performance.now();
    this.schedule(() => {
      this.#timer = false;
      if (!this.#active || this.#stalled || this.#failed || this.#busy) return;
      this.maxPollDelayMilliseconds = Math.max(this.maxPollDelayMilliseconds, performance.now() - scheduledAt);
      this.#pollPending = true;
      this.polls += 1;
      this.post({ type: "supply" });
    }, Math.max(1, Math.floor(this.config.slotFrames * 1000 / this.config.sampleRate / 2)));
  }
  #failure(error: unknown): void { this.#failed = true; this.fail(error); }
}
