import { isAdmissionResultMessage, type PcmBlockMessage, type PcmStreamConfig } from "./pcm-protocol";

// Admission returns transfer ownership, never consumption credit. Only an off-process
// free-slot reply permits reuse. All producer coordinates are output-rate PCM frames. One read/admission at a time fixes source ordering.
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
  #quiescing = false;
  #idle: (() => void) | undefined;
  #start = 0;
  #credits: boolean[];
  polls = 0;
  preparedPcmFrames = 0;
  admittedPcmFrames = 0;
  rejections = 0;
  constructor(
    readonly config: PcmStreamConfig,
    readonly totalPcmFrames: number,
    readonly fill: (buffer: ArrayBuffer, start: number, frames: number) => Promise<void>,
    readonly post: (message: unknown, transfer?: Transferable[]) => void,
    readonly ready: () => void,
    readonly fail: (error: unknown) => void,
    readonly schedule: (callback: () => void, ms: number) => void = (callback, ms) => { setTimeout(callback, ms); },
  ) {
    this.buffers = Array.from({ length: config.slotCount }, () => new ArrayBuffer(config.channelCount * config.slotFrames * 4));
    this.#credits = Array.from({ length: config.slotCount }, () => true);
  }
  start(): void {
    if (this.#position === this.totalPcmFrames) { this.#ready = true; this.ready(); }
    else void this.#pump();
  }
  // One caller owns the reset loop. Drain transfer ownership before reusing storage/converter.
  quiesce(): Promise<void> {
    this.#quiescing = true;
    if (!this.#busy && !this.#pollPending) return Promise.resolve();
    return new Promise(resolve => { this.#idle = resolve; });
  }
  reset(epoch: number, pcmFrame: number): void {
    this.config.epoch = epoch;
    this.#position = pcmFrame;
    this.#start = pcmFrame;
    this.#slot = 0;
    this.#pending = undefined;
    this.#quiescing = false;
    this.#ready = false;
    this.initialAdmittedBlocks = 0;
    this.preparedPcmFrames = pcmFrame;
    this.admittedPcmFrames = pcmFrame;
    this.#credits.fill(true);
    this.start();
  }
  #becameIdle(): void {
    if (this.#busy || this.#pollPending) return;
    this.#idle?.(); this.#idle = undefined;
  }
  activate(): void { this.#active = true; this.#schedule(); }
  stall(value: boolean): void { this.#stalled = value; if (!value) this.#schedule(); }
  accept(value: unknown): void {
    if (this.#failed) return;
    if (isAdmissionResultMessage(value, this.config)) {
      if (!this.#busy || this.#pending?.slotId !== value.slotId) { this.#failure("unexpected admission"); return; }
      this.buffers[value.slotId] = value.buffer;
      this.#pending.buffer = value.buffer;
      this.#busy = false;
      if (this.#quiescing) { this.#pending = undefined; this.#becameIdle(); return; }
      if (value.accepted) {
        this.#position += this.#pending.validFrames;
        this.admittedPcmFrames = this.#position;
        this.#pending = undefined;
        this.#slot = (this.#slot + 1) % this.config.slotCount;
        if (!this.#ready) this.initialAdmittedBlocks += 1;
      } else { this.rejections += 1; }
      if (!this.#ready && (this.initialAdmittedBlocks === this.config.slotCount || this.#position === this.totalPcmFrames)) {
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
      if (this.#quiescing) { this.#becameIdle(); return; }
      this.#credits = message.free;
      void this.#pump();
    } else this.#failure("invalid supply reply");
  }
  async #pump(): Promise<void> {
    if (this.#busy || this.#failed || this.#quiescing || this.#stalled || this.#position === this.totalPcmFrames) return;
    if (!this.#credits[this.#slot]) { this.#schedule(); return; }
    this.#busy = true;
    this.#credits[this.#slot] = false;
    try {
      if (this.#pending === undefined) {
        const buffer = this.buffers[this.#slot]!;
        const frames = Math.min(this.config.slotFrames, this.totalPcmFrames - this.#position);
        await this.fill(buffer, this.#position, frames);
        if (this.#quiescing) { this.#busy = false; this.#becameIdle(); return; }
        this.preparedPcmFrames = this.#position + frames;
        this.#pending = { type: "pcm", slotId: this.#slot, epoch: this.config.epoch, pcmFrameStart: this.#position, validFrames: frames, discontinuity: this.#position === this.#start, endOfStream: this.#position + frames === this.totalPcmFrames, buffer };
      }
      this.post(this.#pending, [this.#pending.buffer]);
    } catch (error) { this.#failure(error); }
  }
  #schedule(): void {
    if (this.#timer || this.#pollPending || (!this.#active && this.#ready) || this.#quiescing || this.#failed || this.#stalled || this.#position === this.totalPcmFrames) return;
    this.#timer = true;
    const scheduledAt = performance.now();
    this.schedule(() => {
      this.#timer = false;
      if ((!this.#active && this.#ready) || this.#quiescing || this.#stalled || this.#failed || this.#busy) return;
      this.maxPollDelayMilliseconds = Math.max(this.maxPollDelayMilliseconds, performance.now() - scheduledAt);
      this.#pollPending = true;
      this.polls += 1;
      this.post({ type: "supply" });
    }, Math.max(1, Math.floor(this.config.slotFrames * 1000 / this.config.sampleRate / 2)));
  }
  #failure(error: unknown): void { this.#failed = true; this.#busy = false; this.#becameIdle(); this.fail(error); }
}
