export type PlanMemory = { readonly buffer: ArrayBuffer };

export interface WorkletPlanBinding {
  maximum_frames(): number;
  left_ptr(): number;
  right_ptr(): number;
  render(frameCount: number): number;
  next_frame(): bigint;
  take_observation(): boolean;
  observation_start(): bigint;
  observation_end(): bigint;
  observation_sequence(): bigint;
  observation_dropped(): bigint;
  observation_peak(): number;
  observation_rms(): number;
  observation_location(): number;
}

export type PlanObservation = {
  startFrame: string;
  endFrame: string;
  sequence: string;
  dropped: string;
  peak: number;
  rms: number;
  location: number;
};

export type PlanSnapshot = {
  failureCode: number;
  lastFrameCount: number;
  memoryBytes: number;
  processCount: number;
  nextFrame: string;
  observation: PlanObservation | null;
};

export const PlanHostFailure = {
  InvalidOutput: 10,
  MemoryChanged: 11,
  Exception: 12,
} as const;

/** Retains all Wasm views before activation; snapshots drain one bounded summary off callback. */
export class PreparedPlanAdapter {
  readonly #plan: WorkletPlanBinding;
  readonly #memory: PlanMemory;
  readonly #buffer: ArrayBuffer;
  readonly #memoryBytes: number;
  readonly #channelCount: 1 | 2;
  readonly #maximumFrames: number;
  readonly #left: Float32Array;
  readonly #right: Float32Array | undefined;
  #failureCode = 0;
  #lastFrameCount = 0;
  #processCount = 0;

  constructor(channelCount: 1 | 2, plan: WorkletPlanBinding, memory: PlanMemory) {
    this.#channelCount = channelCount;
    this.#plan = plan;
    this.#memory = memory;
    this.#buffer = memory.buffer;
    this.#memoryBytes = memory.buffer.byteLength;
    this.#maximumFrames = plan.maximum_frames();
    this.#left = new Float32Array(this.#buffer, plan.left_ptr(), this.#maximumFrames);
    this.#right = channelCount === 2
      ? new Float32Array(this.#buffer, plan.right_ptr(), this.#maximumFrames)
      : undefined;
  }

  process(outputs: Float32Array[][]): boolean {
    try {
      this.#processCount += 1;
      if (this.#failureCode !== 0) { planSilence(outputs); return true; }
      if (this.#memory.buffer !== this.#buffer || this.#memory.buffer.byteLength !== this.#memoryBytes) {
        return this.#fail(outputs, PlanHostFailure.MemoryChanged);
      }
      if (outputs.length !== 1) return this.#fail(outputs, PlanHostFailure.InvalidOutput);
      const channels = outputs[0];
      if (channels === undefined || channels.length !== this.#channelCount) {
        return this.#fail(outputs, PlanHostFailure.InvalidOutput);
      }
      const left = channels[0];
      if (left === undefined) return this.#fail(outputs, PlanHostFailure.InvalidOutput);
      const frames = left.length;
      if (frames > this.#maximumFrames) return this.#fail(outputs, 2);
      if (this.#channelCount === 2 && channels[1]?.length !== frames) {
        return this.#fail(outputs, PlanHostFailure.InvalidOutput);
      }
      const status = this.#plan.render(frames);
      if (status !== 0) return this.#fail(outputs, status);
      for (let frame = 0; frame < frames; frame += 1) left[frame] = this.#left[frame] ?? 0;
      if (this.#channelCount === 2) {
        const right = channels[1];
        const source = this.#right;
        if (right === undefined || source === undefined) return this.#fail(outputs, PlanHostFailure.InvalidOutput);
        for (let frame = 0; frame < frames; frame += 1) right[frame] = source[frame] ?? 0;
      }
      this.#lastFrameCount = frames;
      return true;
    } catch { return this.#fail(outputs, PlanHostFailure.Exception); }
  }

  snapshot(): PlanSnapshot {
    const plan = this.#plan;
    const observation = plan.take_observation()
      ? {
          startFrame: String(plan.observation_start()),
          endFrame: String(plan.observation_end()),
          sequence: String(plan.observation_sequence()),
          dropped: String(plan.observation_dropped()),
          peak: plan.observation_peak(),
          rms: plan.observation_rms(),
          location: plan.observation_location(),
        }
      : null;
    return {
      failureCode: this.#failureCode,
      lastFrameCount: this.#lastFrameCount,
      memoryBytes: this.#memoryBytes,
      processCount: this.#processCount,
      nextFrame: String(plan.next_frame()),
      observation,
    };
  }

  #fail(outputs: Float32Array[][], code: number): true {
    this.#failureCode = code;
    planSilence(outputs);
    return true;
  }
}

export function planSilence(outputs: Float32Array[][]): void {
  for (let output = 0; output < outputs.length; output += 1) {
    const channels = outputs[output];
    if (channels === undefined) continue;
    for (let channel = 0; channel < channels.length; channel += 1) channels[channel]?.fill(0);
  }
}
