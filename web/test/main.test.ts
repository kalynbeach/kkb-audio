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

class ProofControl {
  disabled = false;
  checked = false;
  files: File[] = [];
  textContent = "";
  readonly listeners = new Map<string, () => void | Promise<void>>();
  addEventListener(type: string, listener: () => void | Promise<void>): void { this.listeners.set(type, listener); }
  async click(): Promise<void> { if (!this.disabled) await this.listeners.get("click")?.(); }
}
const controls = new Map(["prepare", "activate", "failure", "close", "result", "wav-file", "wav-stall", "wav-load", "wav-play", "wav-pause", "wav-status"].map(id => [`#${id}`, new ProofControl()]));
const proofDocument = { querySelector: (selector: string) => controls.get(selector) ?? null };

Object.defineProperties(globalThis, {
  AnalyserNode: { configurable: true, value: FakeAnalyserNode },
  ChannelSplitterNode: {
    configurable: true,
    value: FakeChannelSplitterNode,
  },
  document: {
    configurable: true,
    value: proofDocument,
  },
  GainNode: { configurable: true, value: FakeGainNode },
});

const { PreparedProof, prepareProof } = await import("../src/main");

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

class StartupContext extends FakeContext {
  static latest: StartupContext;
  readonly audioWorklet = { addModule: async (_url: string) => {} };

  constructor() {
    super();
    StartupContext.latest = this;
  }
}

class StartupWorkletNode extends FakeAudioNode {
  static latest: StartupWorkletNode;
  readonly channelCount = 2;
  disconnectCount = 0;

  constructor() {
    super();
    StartupWorkletNode.latest = this;
  }
  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        "type" in message && message.type === "snapshot"
      ) {
        this.send({
          type: "snapshot",
          snapshot: {
          epoch: 1, presentationTime: null, ready: true, sourcePosition: 0, pcmPosition: 0, renderFrame: 0, ended: false,
            failureCode: 0,
            invalidBlockCount: 0,
            lastFrameCount: 128,
            memoryBytes: 16_777_216,
            processCount: 1,
            slotCount: 4,
            staleBlockCount: 0,
            starvationCount: 0,
          },
        });
      }
    },
    start: () => {},
  };

  addEventListener(_type: string, _listener: () => void): void {}
  disconnect(): void { this.disconnectCount += 1; }
  send(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

let resolveStartupWorker: ((worker: StartupWorker) => void) | undefined;

class StartupWorker {
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  terminationCount = 0;

  constructor() {
    resolveStartupWorker?.(this);
  }

  postMessage(_message: unknown): void {}
  terminate(): void { this.terminationCount += 1; }

  sendReady(initialAdmittedBlocks = 4): void {
    this.onmessage?.({
      data: {
        type: "worker-ready",
        slotCount: 4,
        initialAdmittedBlocks,
        invalidRecycleCount: 0,
      },
    } as MessageEvent<unknown>);
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

function preparedProof(totalFrames?: number): {
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
    0,
    totalFrames,
    totalFrames === undefined ? undefined : 44100,
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

  test("routes a worklet transport failure through runtime cleanup with its code", async () => {
    const { context, proof, worker } = preparedProof();

    proof.acceptRuntimeMessage({ type: "runtime-failed", code: 43 });
    await expect(proof.activate()).rejects.toMatchObject({ code: 43 });
    expect(worker.terminationCount).toBe(1);
    expect(context.suspendCount).toBe(1);

    await proof.close();
    expect(worker.terminationCount).toBe(1);
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
          epoch: 1, presentationTime: null, ready: true, sourcePosition: 0, pcmPosition: 0, renderFrame: 0, ended: false,
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

  test("preserves a worklet runtime failure while worker readiness is pending", async () => {
    await withStartupProof(async ({ preparation, worker, node, context }) => {
      node.send(ready);
      node.send({ type: "runtime-failed", code: 43 });
      worker.sendReady();

      await expect(preparation).rejects.toMatchObject({ code: 43 });
      expect(worker.terminationCount).toBe(1);
      expect(context.closeCount).toBe(1);
    });
  });

  test.each(["worker-failed", "error"] as const)(
    "preserves %s after worker readiness while worklet readiness is pending",
    async (failure) => {
      await withStartupProof(async ({ preparation, worker, node, context }) => {
        worker.sendReady();
        await nextTask();
        if (failure === "worker-failed") {
          worker.onmessage?.({ data: { type: "worker-failed", code: 50 } } as MessageEvent<unknown>);
        } else {
          worker.onerror?.();
        }
        node.send(ready);

        await expect(preparation).rejects.toMatchObject({
          code: failure === "worker-failed" ? 50 : InitializationFailure.InvalidMessage,
        });
        expect(worker.terminationCount).toBe(1);
        expect(context.closeCount).toBe(1);
      });
    },
  );

  test.each(["prepared", "active"])(
    "routes worker errors through runtime cleanup when %s",
    async (state) => {
      await withStartupProof(async ({ preparation, worker, node, context }) => {
        worker.sendReady();
        node.send(ready);
        const proof = await preparation;
        if (state === "active") await proof.activate();

        worker.onerror?.();

        expect(context.state).toBe("suspended");
        expect(context.suspendCount).toBe(1);
        expect(node.disconnectCount).toBe(1);
        expect(worker.terminationCount).toBe(1);
        await expect(proof.activate()).rejects.toMatchObject({
          code: InitializationFailure.InvalidMessage,
        });
        await proof.close();
        expect(worker.terminationCount).toBe(1);
        expect(context.closeCount).toBe(1);
      });
    },
  );
});

async function withStartupProof(run: (fixture: {
  preparation: Promise<InstanceType<typeof PreparedProof>>;
  worker: StartupWorker;
  node: StartupWorkletNode;
  context: StartupContext;
}) => Promise<void>): Promise<void> {
  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  const originalFetch = globalThis.fetch;
  const originalMessageChannel = globalThis.MessageChannel;
  const originalWorker = globalThis.Worker;
  class StartupMessageChannel {
    readonly port1 = {};
    readonly port2 = {};
  }
  Object.defineProperties(globalThis, {
    AudioContext: { configurable: true, value: StartupContext },
    AudioWorkletNode: { configurable: true, value: StartupWorkletNode },
    fetch: {
      configurable: true,
      value: async () => new Response(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      ),
    },
    MessageChannel: { configurable: true, value: StartupMessageChannel },
    Worker: { configurable: true, value: StartupWorker },
  });

  const startupWorkerCreated = new Promise<StartupWorker>((resolve) => {
    resolveStartupWorker = resolve;
  });
  const preparation = prepareProof({ channelCount: 2, maximumFrames: 1_024, timeoutMilliseconds: 1_000 });
  try {
    const worker = await startupWorkerCreated;
    await run({ preparation, worker, node: StartupWorkletNode.latest, context: StartupContext.latest });
  } finally {
    const proof = await preparation.catch(() => undefined);
    await proof?.close();
    resolveStartupWorker = undefined;
    Object.defineProperties(globalThis, {
      AudioContext: { configurable: true, value: originalAudioContext },
      AudioWorkletNode: { configurable: true, value: originalAudioWorkletNode },
      fetch: { configurable: true, value: originalFetch },
      MessageChannel: { configurable: true, value: originalMessageChannel },
      Worker: { configurable: true, value: originalWorker },
    });
  }
}


test("local WAV controls suspend at acknowledgment, retain the instance, and never rewind consumed EOS", async () => {
  const { context, node, proof, worker } = preparedProof(17);
  let position = 0;
  let ended = false;
  node.port.postMessage = () => proof.acceptRuntimeMessage({ type: "snapshot", snapshot: {
    epoch: 1, presentationTime: null, ready: true, sourcePosition: position, pcmPosition: position, renderFrame: position, ended, failureCode: 0, invalidBlockCount: 0,
    lastFrameCount: 1, memoryBytes: 16777216, processCount: position, slotCount: 4, staleBlockCount: 0, starvationCount: 0,
  } });
  await proof.play(); expect(context.state).toBe("running");
  position = 3;
  expect((await proof.pause()).sourcePosition).toBe(3); expect(context.state).toBe("suspended");
  expect((await proof.status()).sourcePosition).toBe(3);
  await proof.play(); expect(context.state).toBe("running");
  position = 17; ended = true;
  await proof.pause(); const activations = worker.messages.filter(m => (m as { type: string }).type === "activate").length;
  expect((await proof.play()).ended).toBe(true); expect(context.state).toBe("suspended");
  expect(worker.messages.filter(m => (m as { type: string }).type === "activate")).toHaveLength(activations);
  await proof.close(); expect(worker.terminationCount).toBe(1); expect(context.closeCount).toBe(1);
  await expect(proof.play()).rejects.toMatchObject({ code: InitializationFailure.ContextState });
});


test("WAV seeks reject stale completion/observations, preserve pause and cancel on close", async () => {
  const { proof, context, worker } = preparedProof(10003);
  expect(() => proof.seek(-1)).toThrow();
  expect(() => proof.seek(10004)).toThrow();
  expect(() => proof.seek(0.5)).toThrow();
  const first = proof.seek(7001).catch(error => error.message);
  const second = proof.seek(1176);
  expect(await first).toBe("Seek superseded");
  expect(worker.messages.filter(message => (message as { type: string }).type === "seek")).toHaveLength(1);
  proof.acceptWorkerMessage({ type: "seek-accepted", epoch: 2 });
  expect(worker.messages.filter(message => (message as { type: string }).type === "seek")).toHaveLength(2);
  proof.acceptWorkerMessage({ type: "seek-complete", epoch: 2, requestedFrame: 7001, pcmFrame: 7621 });
  proof.acceptWorkerMessage({ type: "producer-status", epoch: 2 });
  expect(proof.producerObservation).toBeUndefined();
  proof.acceptWorkerMessage({ type: "seek-complete", epoch: 3, requestedFrame: 1176, pcmFrame: 1280 });
  expect(await second).toEqual({ epoch: 3, requestedFrame: 1176, pcmFrame: 1280, actualMediaFrame: 1176, result: "AnchorAndDiscard" });
  expect(context.state).toBe("suspended");
  const pending = proof.seek(0).catch(error => error.message);
  await proof.close();
  expect(await pending).toBe("Playback closed");
  proof.acceptWorkerMessage({ type: "seek-complete", epoch: 4, requestedFrame: 0, pcmFrame: 0 });
  expect(context.state).toBe("closed"); expect(worker.terminationCount).toBe(1);
});

test("a delayed prior-epoch snapshot requests a fresh reply rather than timing out playback", async () => {
  const { proof, node } = preparedProof(10003);
  const status = proof.status();
  const seek = proof.seek(17);
  proof.acceptWorkerMessage({ type: "seek-complete", epoch: 2, requestedFrame: 17, pcmFrame: 19 });
  await seek;
  const snapshot = { epoch: 1, presentationTime: null, ready: true, sourcePosition: 0, pcmPosition: 0, renderFrame: 128, ended: false, failureCode: 0, invalidBlockCount: 0, lastFrameCount: 128, memoryBytes: 16777216, processCount: 1, slotCount: 4, staleBlockCount: 0, starvationCount: 0 };
  let replacements = 0;
  node.port.postMessage = () => { replacements++; proof.acceptRuntimeMessage({ type: "snapshot", snapshot: { ...snapshot, epoch: 2, sourcePosition: 17, pcmPosition: 19 } }); };
  proof.acceptRuntimeMessage({ type: "snapshot", snapshot });
  expect((await status).epoch).toBe(2); expect(replacements).toBe(1);
  await proof.close();
});

test("proof-page Status disables conflicting controls but keeps Close available", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: proofDocument });
  const control = (id: string) => controls.get(`#${id}`)!;
  await withStartupProof(async ({ preparation, worker, node }) => {
    worker.sendReady(); node.send(ready); await preparation;
    control("wav-file").files = [new File([], "fixture.wav")];
    async function loadFromPage() {
      const created = new Promise<StartupWorker>(resolve => { resolveStartupWorker = resolve; });
      const loading = control("wav-load").click();
      expect(control("wav-load").disabled).toBe(true);
      expect(control("close").disabled).toBe(false);
      expect(control("wav-play").disabled).toBe(true);
      const wavWorker = await created;
      wavWorker.onmessage?.({ data: { type: "metadata", channelCount: 2, totalFrames: 1024 } } as MessageEvent<unknown>);
      await nextTask();
      const wavNode = StartupWorkletNode.latest;
      // This finite 1024-frame fixture now fits in one prepared transport slot.
      wavWorker.sendReady(1); wavNode.send(ready);
      await loading;
      expect(control("wav-play").disabled).toBe(false);
      expect(control("close").disabled).toBe(false);
      return { wavWorker, wavNode, context: StartupContext.latest };
    }
    const first = await loadFromPage();
    await control("wav-play").click();
    expect(first.context.state).toBe("running");
    const sendSnapshot = first.wavNode.port.postMessage;
    let deferred: unknown;
    first.wavNode.port.postMessage = message => { deferred = message; };
    const status = control("wav-status").click();
    // Disabled synchronously, before the exclusive action's first microtask runs.
    for (const id of ["wav-play", "wav-pause", "wav-status", "wav-load", "prepare", "failure"]) expect(control(id).disabled).toBe(true);
    expect(control("close").disabled).toBe(false);
    expect(control("wav-stall").disabled).toBe(false);
    await control("wav-pause").click();
    await control("wav-load").click();
    expect(first.context.state).toBe("running");
    expect(first.context.closeCount).toBe(0);
    expect(first.wavWorker.terminationCount).toBe(0);
    await nextTask();
    expect(deferred).toEqual({ type: "snapshot" });
    first.wavNode.port.postMessage = sendSnapshot;
    sendSnapshot(deferred);
    await status;
    expect(control("wav-pause").disabled).toBe(false);
    await control("wav-pause").click();
    expect(first.context.state).toBe("suspended");
    expect(first.context.suspendCount).toBe(1);

    const second = await loadFromPage();
    expect(first.context.closeCount).toBe(1);
    expect(first.wavWorker.terminationCount).toBe(1);
    const closing = control("close").click();
    expect(control("wav-load").disabled).toBe(true);
    expect(control("wav-play").disabled).toBe(true);
    await closing;
    expect(second.context.closeCount).toBe(1);
    expect(second.wavWorker.terminationCount).toBe(1);
    expect(control("wav-load").disabled).toBe(false);
    expect(control("wav-play").disabled).toBe(true);
    expect(control("wav-pause").disabled).toBe(true);
  });
});
