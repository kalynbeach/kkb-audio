import { describe, expect, test } from "bun:test";
import { PlanHostFailure, PreparedPlanAdapter, type WorkletPlanBinding } from "../src/plan-adapter";

class FakePlan implements WorkletPlanBinding {
  readonly left: Float32Array;
  readonly right: Float32Array;
  clock = 0n;
  calls = 0;
  status = 0;
  observationReads = 0;
  pending = true;

  constructor(memory: { buffer: ArrayBuffer }) {
    this.left = new Float32Array(memory.buffer, 0, 64);
    this.right = new Float32Array(memory.buffer, 256, 64);
  }

  maximum_frames(): number { return 64; }
  left_ptr(): number { return 0; }
  right_ptr(): number { return 256; }
  next_frame(): bigint { return this.clock; }
  render(frames: number): number {
    this.calls += 1;
    if (this.status !== 0) return this.status;
    for (let frame = 0; frame < frames; frame += 1) {
      this.left[frame] = Number(this.clock) + frame + 0.25;
      this.right[frame] = this.left[frame]!;
    }
    this.clock += BigInt(frames);
    return 0;
  }
  take_observation(): boolean {
    this.observationReads += 1;
    const available = this.pending;
    this.pending = false;
    return available;
  }
  observation_start(): bigint { return 64n; }
  observation_end(): bigint { return 128n; }
  observation_sequence(): bigint { return 2n; }
  observation_dropped(): bigint { return 1n; }
  observation_peak(): number { return 0.5; }
  observation_rms(): number { return 0.25; }
  observation_location(): number { return 60; }
}

function fixture(channels: 1 | 2 = 1) {
  const memory = { buffer: new ArrayBuffer(512) };
  const plan = new FakePlan(memory);
  return { memory, plan, adapter: new PreparedPlanAdapter(channels, plan, memory) };
}

describe("compiled plan host adapter", () => {
  test("copies prepared mono and stereo views at actual variable frame counts", () => {
    for (const channels of [1, 2] as const) {
      const { plan, adapter } = fixture(channels);
      for (const frames of [0, 17, 64]) {
        const output = Array.from({ length: channels }, () => new Float32Array(frames).fill(Number.NaN));
        const start = Number(plan.clock);
        expect(adapter.process([output])).toBe(true);
        for (const channel of output) {
          for (let frame = 0; frame < frames; frame += 1) expect(channel[frame]).toBe(start + frame + 0.25);
        }
      }
      expect(plan.clock).toBe(81n);
      expect(adapter.snapshot()).toMatchObject({ failureCode: 0, lastFrameCount: 64, processCount: 3, nextFrame: "81" });
    }
  });

  test("reads and drains one observation only when the host asks for a snapshot", () => {
    const { plan, adapter } = fixture();
    const output = [[new Float32Array(64)]];
    adapter.process(output);
    adapter.process(output);
    expect(plan.observationReads).toBe(0);
    expect(adapter.snapshot().observation).toEqual({
      startFrame: "64", endFrame: "128", sequence: "2", dropped: "1", peak: 0.5, rms: 0.25, location: 60,
    });
    expect(adapter.snapshot().observation).toBeNull();
    expect(plan.observationReads).toBe(2);
  });

  test("capacity, malformed layout, and detached memory become permanent silence before Wasm", () => {
    for (const scenario of ["capacity", "layout", "memory"] as const) {
      const { plan, adapter, memory } = fixture(2);
      const expectedCode = scenario === "capacity" ? 2 : scenario === "layout" ? PlanHostFailure.InvalidOutput : PlanHostFailure.MemoryChanged;
      if (scenario === "memory") memory.buffer = new ArrayBuffer(512);
      const left = new Float32Array(scenario === "capacity" ? 65 : 17).fill(1);
      const right = new Float32Array(scenario === "layout" ? 16 : left.length).fill(1);
      adapter.process([[left, right]]);
      expect(left.every((sample) => Object.is(sample, 0))).toBe(true);
      expect(right.every((sample) => Object.is(sample, 0))).toBe(true);
      expect(adapter.snapshot().failureCode).toBe(expectedCode);
      const later = new Float32Array(17).fill(1);
      adapter.process([[later, new Float32Array(17).fill(1)]]);
      expect(later.every((sample) => Object.is(sample, 0))).toBe(true);
      expect(plan.calls).toBe(0);
    }
  });

  test("all failed Wasm statuses and exceptions silence output without retrying", () => {
    for (const status of [1, 2, 3, 4, 99, "throw"] as const) {
      const { plan, adapter } = fixture();
      if (status === "throw") plan.render = () => { plan.calls += 1; throw new Error("injected"); };
      else plan.status = status;
      const output = new Float32Array(17).fill(1);
      adapter.process([[output]]);
      expect(output.every((sample) => Object.is(sample, 0))).toBe(true);
      expect(adapter.snapshot().failureCode).toBe(status === "throw" ? PlanHostFailure.Exception : status);
      adapter.process([[output.fill(1)]]);
      expect(output.every((sample) => Object.is(sample, 0))).toBe(true);
      expect(plan.calls).toBe(1);
    }
  });
});
