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

class FakeChannelSplitterNode extends FakeAudioNode {}
class FakeGainNode extends FakeAudioNode {}

Object.defineProperties(globalThis, {
  AnalyserNode: { configurable: true, value: FakeAnalyserNode },
  ChannelSplitterNode: {
    configurable: true,
    value: FakeChannelSplitterNode,
  },
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
  closeCount = 0;
  suspendCount = 0;

  async resume(): Promise<void> {
    this.state = "running";
  }

  async suspend(): Promise<void> {
    this.suspendCount += 1;
    this.state = "suspended";
  }

  async close(): Promise<void> {
    this.closeCount += 1;
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

class FakeWorker {
  readonly messages: unknown[] = [];
  terminationCount = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminationCount += 1;
  }
}

const ready: ReadyMessage = {
  type: "ready",
  memoryBytes: 16_777_216,
  memoryPages: 256,
  maximumFrames: 1_024,
  sampleRate: 48_000,
  slotCount: 4,
};

function preparedProof(): {
  context: FakeContext;
  node: FakeWorkletNode;
  proof: InstanceType<typeof PreparedProof>;
  worker: FakeWorker;
} {
  const context = new FakeContext();
  const node = new FakeWorkletNode();
  const worker = new FakeWorker();
  const gate = new InitializationGate();
  gate.accept(ready);
  const proof = new PreparedProof(
    context as unknown as AudioContext,
    node as unknown as AudioWorkletNode,
    gate,
    ready,
    worker as unknown as Worker,
  );
  return { context, node, proof, worker };
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

  test("routes a post-preparation worker failure through runtime cleanup once", async () => {
    const { context, proof, worker } = preparedProof();

    proof.acceptWorkerMessage({ type: "worker-failed", code: 50 });
    await expect(proof.activate()).rejects.toMatchObject({ code: 50 });
    expect(worker.terminationCount).toBe(1);
    expect(context.suspendCount).toBe(1);

    await proof.close();
    await proof.close();
    expect(worker.terminationCount).toBe(1);
    expect(context.closeCount).toBe(1);
  });

  test("routes snapshot timeout through runtime cleanup before rejecting", async () => {
    const { context, proof, worker } = preparedProof();

    await expect(proof.activate()).rejects.toMatchObject({
      code: InitializationFailure.Timeout,
    });
    expect(worker.terminationCount).toBe(1);
    expect(context.suspendCount).toBe(1);

    await proof.close();
    await proof.close();
    expect(worker.terminationCount).toBe(1);
    expect(context.closeCount).toBe(1);
  });

  test("rejects a runtime failure raised during the snapshot request and terminates its worker once", async () => {
    const { node, proof, worker } = preparedProof();
    node.port.postMessage = () => {
      proof.failRuntime(InitializationFailure.ProcessorError);
    };

    await expect(proof.activate()).rejects.toMatchObject({
      code: InitializationFailure.ProcessorError,
    });
    expect(worker.terminationCount).toBe(1);
    await proof.close();
    expect(worker.terminationCount).toBe(1);
  });

  test("routes a terminal snapshot through runtime cleanup before rejecting", async () => {
    const { node, proof, worker } = preparedProof();
    node.port.postMessage = () => {
      proof.acceptRuntimeMessage({
        type: "snapshot",
        snapshot: {
          failureCode: 36,
          invalidBlockCount: 0,
          lastFrameCount: 128,
          memoryBytes: 16_777_216,
          processCount: 1,
          slotCount: 4,
          staleBlockCount: 0,
          starvationCount: 0,
        },
      });
    };

    await expect(proof.activate()).rejects.toMatchObject({ code: 36 });
    expect(worker.terminationCount).toBe(1);
    expect(worker.messages).toEqual([{ type: "activate" }]);
    await proof.close();
    expect(worker.terminationCount).toBe(1);
  });
});
