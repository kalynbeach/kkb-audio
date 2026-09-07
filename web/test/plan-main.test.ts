import { describe, expect, test } from "bun:test";
import type { PlanSnapshot } from "../src/plan-adapter";

class FakeNode {
  connect<T>(node: T): T { return node; }
}
class FakeAnalyser extends FakeNode {
  static signal = 0;
  readonly fftSize = 2_048;
  getFloatTimeDomainData(samples: Float32Array): void { samples[0] = FakeAnalyser.signal; }
}
class FakeContext {
  readonly destination = new FakeNode();
  readonly sampleRate = 48_000;
  state: AudioContextState = "suspended";
  suspendCount = 0;
  closeCount = 0;
  async resume(): Promise<void> { this.state = "running"; }
  async suspend(): Promise<void> { this.suspendCount += 1; this.state = "suspended"; }
  async close(): Promise<void> { this.closeCount += 1; this.state = "closed"; }
}
class FakeWorklet extends FakeNode {
  disconnectCount = 0;
  onprocessorerror: (() => void) | null = null;
  snapshot: PlanSnapshot = {
    failureCode: 4, processCount: 1, lastFrameCount: 128, memoryBytes: 16_777_216,
    nextFrame: "0", observation: null,
  };
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_message: unknown) => { this.port.onmessage?.({ data: { type: "snapshot", snapshot: this.snapshot } }); },
  };
  disconnect(): void { this.disconnectCount += 1; }
}

Object.defineProperties(globalThis, {
  document: { configurable: true, value: { querySelector: () => null } },
  window: { configurable: true, value: {} },
});
const { PreparedPlanProof } = await import("../src/plan-main");

function fixture(signal: number) {
  FakeAnalyser.signal = signal;
  Object.defineProperties(globalThis, {
    AnalyserNode: { configurable: true, value: FakeAnalyser },
    GainNode: { configurable: true, value: FakeNode },
  });
  const context = new FakeContext();
  const node = new FakeWorklet();
  const proof = new PreparedPlanProof(context as unknown as AudioContext, node as unknown as AudioWorkletNode, {
    type: "ready", maximumFrames: 1_024, memoryBytes: 16_777_216, sampleRate: 48_000, channelCount: 2,
  });
  return { context, node, proof };
}

describe("compiled plan activation", () => {
  test("rejects silent analyser output and suspends the failed proof", async () => {
    const { context, node, proof } = fixture(0);
    await expect(proof.activate()).rejects.toThrow("plan analyser observed no signal");
    expect(context.state).toBe("suspended");
    expect(context.suspendCount).toBe(1);
    expect(node.disconnectCount).toBe(1);
    await proof.close();
    expect(context.closeCount).toBe(1);
  });

  test("rejects a terminal render snapshot and suspends the failed proof", async () => {
    const { context, node, proof } = fixture(0.5);
    await expect(proof.activate()).rejects.toThrow("plan render failed: 4");
    expect(context.state).toBe("suspended");
    expect(context.suspendCount).toBe(1);
    expect(node.disconnectCount).toBe(1);
    await proof.close();
    expect(context.closeCount).toBe(1);
  });
});
