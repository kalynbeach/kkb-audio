import { expect, test } from "bun:test";
import { LocalPcmProducer } from "../src/local-pcm-producer";
import type { PcmBlockMessage } from "../src/pcm-protocol";

const config = { channelCount: 2, epoch: 1, sourceId: 3, slotCount: 4, slotFrames: 256, sampleRate: 48000 } as const;
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function harness(total: number) {
  const sent: PcmBlockMessage[] = [];
  const scheduled: Array<() => void> = [];
  const free = [true, true, true, true];
  const failures: unknown[] = [];
  let ready = 0;
  let polls = 0;
  const producer = new LocalPcmProducer(config, total,
    async (buffer, start, frames) => { new Float32Array(buffer).fill(start + frames); },
    message => {
      const block = message as PcmBlockMessage;
      if (block.type === "pcm") sent.push(block);
      else { polls++; producer.accept({ type: "supply", free: [...free] }); }
    }, () => ready++, error => failures.push(error), (callback, ms) => { expect(ms).toBe(2); scheduled.push(callback); });
  const ack = (accepted = true) => {
    const block = sent.at(-1)!;
    if (accepted) free[block.slotId] = false;
    producer.accept({ type: "admission-result", slotId: block.slotId, buffer: block.buffer, accepted });
  };
  return { producer, sent, scheduled, free, failures, ack, get ready() { return ready; }, get polls() { return polls; } };
}

test("short/exact/partial finite prefill waits for admission, not all four slots or read EOF", async () => {
  for (const total of [1, 17, 256, 257, 1024]) {
    const h = harness(total); h.producer.start(); await flush();
    for (let start = 0; start < total; start += 256) {
      expect(h.ready).toBe(0);
      expect(h.sent.at(-1)).toMatchObject({ pcmFrameStart: start, validFrames: Math.min(256, total - start), endOfStream: start + 256 >= total });
      h.ack(); await flush();
    }
    expect(h.ready).toBe(1);
    h.producer.activate();
    expect(h.scheduled).toHaveLength(0);
    expect(h.producer.admittedPcmFrames).toBe(total);
    expect(h.failures).toEqual([]);
  }
});

test("admission is not consumption credit; pause/full slots cannot rejection-spin; retry stays ordered", async () => {
  const h = harness(5000); h.producer.start(); await flush();
  for (let i = 0; i < 4; i++) { h.ack(); await flush(); }
  expect(h.sent).toHaveLength(4); expect(h.scheduled).toHaveLength(0);
  h.producer.activate(); h.producer.activate();
  for (let i = 0; i < 100; i++) {
    expect(h.scheduled).toHaveLength(1); h.scheduled.shift()!(); await flush();
  }
  expect(h.sent).toHaveLength(4); expect(h.producer.rejections).toBe(0);
  h.free[0] = true; h.scheduled.shift()!(); await flush();
  const rejected = h.sent.at(-1)!;
  h.ack(false); await flush();
  expect(h.sent).toHaveLength(5);
  h.scheduled.shift()!(); await flush();
  expect(h.sent.at(-1)).toEqual(rejected);
  expect(new Float32Array(h.sent.at(-1)!.buffer)[0]).toBe(1280);
  h.ack(); await flush();
  expect(h.sent.map(b => b.pcmFrameStart)).toEqual([0, 256, 512, 768, 1024, 1024]);
  h.producer.stall(true); h.scheduled.shift()?.(); await flush();
  expect(h.scheduled).toHaveLength(0);
  h.producer.stall(false); expect(h.scheduled).toHaveLength(1);
  expect(h.producer.buffers).toHaveLength(4);
  expect(h.failures).toEqual([]);
});

test("malformed/duplicate ownership replies fail once and stop scheduling", async () => {
  const h = harness(5000); h.producer.start(); await flush();
  h.producer.accept({ type: "admission-result", slotId: 3, buffer: h.sent[0]!.buffer, accepted: true });
  h.producer.accept(null); h.producer.activate();
  expect(h.failures).toHaveLength(1); expect(h.scheduled).toHaveLength(0);
});

test("default timer scheduling does not pass the producer as a browser host-function receiver", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const scheduled: Array<() => void> = [];
  // Web IDL timers accept a global/unqualified call, but reject a foreign receiver.
  const browserTimer = function (this: unknown, callback: () => void, ms: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    expect(ms).toBe(2);
    scheduled.push(callback);
    return 1;
  };
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: browserTimer });
  try {
    const broken = { schedule: globalThis.setTimeout };
    expect(() => broken.schedule(() => {}, 2)).toThrow("Illegal invocation");
    const messages: unknown[] = [];
    const producer = new LocalPcmProducer(config, 5000, async () => {}, message => messages.push(message), () => {}, error => { throw error; });
    expect(() => producer.activate()).not.toThrow();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    expect(messages).toEqual([{ type: "supply" }]);
  } finally {
    Object.defineProperty(globalThis, "setTimeout", original);
  }
});
