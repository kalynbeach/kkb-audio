import { describe, expect, test } from "bun:test";
import {
  InitializationFailure,
  InitializationGate,
  type ReadyMessage,
} from "../src/protocol";

class FakeAudioNode {
  connect<T>(destination: T): T {
    return destination;
  }
}

class FakeAnalyserNode extends FakeAudioNode {
  readonly fftSize: number;

  constructor(_context: AudioContext, options: AnalyserOptions) {
    super();
    this.fftSize = options.fftSize ?? 2_048;
  }

  getFloatTimeDomainData(samples: Float32Array): void {
    samples[0] = 0.5;
  }
}

class FakeGainNode extends FakeAudioNode {}

Object.defineProperties(globalThis, {
  AnalyserNode: { configurable: true, value: FakeAnalyserNode },
  document: {
    configurable: true,
    value: { querySelector: () => null },
  },
  GainNode: { configurable: true, value: FakeGainNode },
});

const { PreparedProof } = await import("../src/main");

class FakeContext {
  readonly destination = new FakeAudioNode();
  readonly sampleRate = 48_000;
  state: AudioContextState = "suspended";

  async resume(): Promise<void> {
    this.state = "running";
  }

  async suspend(): Promise<void> {
    this.state = "suspended";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

class FakeWorkletNode extends FakeAudioNode {
  readonly channelCount = 2;
  readonly port = {
    postMessage: (_message: unknown) => {},
  };

  disconnect(): void {}
}

const ready: ReadyMessage = {
  type: "ready",
  memoryBytes: 16_777_216,
  memoryPages: 256,
  maximumFrames: 1_024,
  sampleRate: 48_000,
};

function preparedProof(): {
  context: FakeContext;
  node: FakeWorkletNode;
  proof: InstanceType<typeof PreparedProof>;
} {
  const context = new FakeContext();
  const node = new FakeWorkletNode();
  const gate = new InitializationGate();
  gate.accept(ready);
  const proof = new PreparedProof(
    context as unknown as AudioContext,
    node as unknown as AudioWorkletNode,
    gate,
    ready,
  );
  return { context, node, proof };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PreparedProof activation", () => {
  test("rejects when the proof closes during the observation delay", async () => {
    const { proof } = preparedProof();
    const activation = proof.activate();
    await nextTask();
    await proof.close();

    await expect(activation).rejects.toMatchObject({
      code: InitializationFailure.ContextState,
    });
  });

  test("rejects a runtime failure raised during the snapshot request", async () => {
    const { node, proof } = preparedProof();
    node.port.postMessage = () => {
      proof.failRuntime(InitializationFailure.ProcessorError);
    };

    await expect(proof.activate()).rejects.toMatchObject({
      code: InitializationFailure.ProcessorError,
    });
    await proof.close();
  });
});
