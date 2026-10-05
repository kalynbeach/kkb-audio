import { expect, test } from "bun:test";
import { prepareProof } from "../src/prepared-playback";
import { InitializationFailure } from "../src/protocol";

for (const failure of ["worklet construction", "worker transfer", "worklet transfer", "worker error", "abort"] as const) {
  test(`preparation releases readiness timers after ${failure}`, async () => {
    const original = Object.getOwnPropertyDescriptors(globalThis);
    const setTimeoutBefore = globalThis.setTimeout;
    const clearTimeoutBefore = globalThis.clearTimeout;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const controller = new AbortController();
    let closed = 0;
    let terminated = 0;
    class Context {
      readonly state = "suspended";
      readonly sampleRate = 48000;
      readonly audioWorklet = { addModule: async () => {} };
      async close() { closed++; }
    }
    class Worker {
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      postMessage() {
        if (failure === "worker transfer") throw new Error(failure);
        if (failure === "worker error") queueMicrotask(() => this.onerror?.());
        if (failure === "abort") queueMicrotask(() => controller.abort());
      }
      terminate() { terminated++; }
    }
    class WorkletNode {
      constructor() {
        if (failure === "worklet construction") throw new Error(failure);
      }
      readonly port = {
        onmessage: null,
        start() {},
        postMessage() {
          if (failure === "worklet transfer") throw new Error(failure);
        },
      };
      addEventListener() {}
    }
    class Channel {
      readonly port1 = {};
      readonly port2 = {};
    }
    const globals = {
      AudioContext: Context,
      AudioWorkletNode: WorkletNode,
      Worker,
      MessageChannel: Channel,
      fetch: async () => new Response(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
      setTimeout: (callback: () => void, milliseconds: number) => {
        const timer = setTimeoutBefore(() => { timers.delete(timer); callback(); }, milliseconds);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => {
        if (timer !== undefined) timers.delete(timer);
        clearTimeoutBefore(timer);
      },
    };
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    try {
      const preparation = prepareProof({ channelCount: 2, maximumFrames: 1024,
        timeoutMilliseconds: 1000, signal: controller.signal });
      if (failure === "worker error") {
        await expect(preparation).rejects.toMatchObject({ code: InitializationFailure.InvalidMessage });
      } else {
        await expect(preparation).rejects.toThrow(failure === "abort" ? "Preparation cancelled" : failure);
      }
      expect(closed).toBe(1);
      expect(terminated).toBe(1);
      expect(timers.size).toBe(0);
    } finally {
      // Clean up even on the red regression, before any orphaned timeout can reject.
      for (const timer of timers) clearTimeoutBefore(timer);
      for (const name of Object.keys(globals)) {
        const descriptor = original[name];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}
