import { describe, expect, test } from "bun:test";
import {
  isAdmissionResultMessage,
  isPcmBlockMessage,
  type AdmissionResultMessage,
  type PcmStreamConfig,
} from "../src/pcm-protocol";
import {
  FixedTransferPool,
} from "../src/pcm-worker-pool";

const config: PcmStreamConfig = {
  channelCount: 2,
  epoch: 7,
  sampleRate: 48_000,
  slotCount: 4,
  slotFrames: 4,
  sourceId: 3,
};

function admissionResult(
  block: { slotId: number; buffer: ArrayBuffer },
  accepted: boolean,
): AdmissionResultMessage {
  return {
    type: "admission-result",
    slotId: block.slotId,
    accepted,
    buffer: block.buffer,
  };
}

describe("PCM transferable protocol", () => {
  test("accepts only exact fixed-capacity blocks and admission results", () => {
    const buffer = new ArrayBuffer(2 * 4 * 4);
    const block = {
      type: "pcm", slotId: 0, epoch: 7, pcmFrameStart: 0,
      validFrames: 4, discontinuity: true, endOfStream: false, buffer,
    };
    expect(isPcmBlockMessage(block, config)).toBe(true);
    expect(isPcmBlockMessage({ ...block, slotId: 4 }, config)).toBe(false);
    expect(isPcmBlockMessage({ ...block, validFrames: 5 }, config)).toBe(false);
    expect(isPcmBlockMessage({ ...block, buffer: new ArrayBuffer(4) }, config)).toBe(false);
    expect(isAdmissionResultMessage(admissionResult(block, true), config)).toBe(true);
    expect(isAdmissionResultMessage({ ...admissionResult(block, true), accepted: 1 }, config)).toBe(false);
  });

  test("fixed pool exhausts without replacement and rejects duplicate returns", () => {
    const pool = new FixedTransferPool(config);
    const blocks = [pool.takeNext(), pool.takeNext(), pool.takeNext(), pool.takeNext()];
    expect(blocks.every((block) => block !== undefined)).toBe(true);
    expect(new Set(blocks.map((block) => block?.buffer)).size).toBe(4);
    expect(pool.takeNext()).toBeUndefined();
    expect(pool.takeNext()).toBeUndefined();
    expect(pool.snapshot()).toEqual({ exhaustionCount: 1, invalidRecycleCount: 0 });

    const first = blocks[0]!;
    const returned = admissionResult(first, true);
    expect(pool.acceptAdmissionResult(returned)).toBe(true);
    expect(pool.acceptAdmissionResult(returned)).toBe(false);
    const resumed = pool.takeNext();
    expect(resumed?.slotId).toBe(first.slotId);
    expect(resumed?.buffer).toBe(first.buffer);
    expect(resumed?.pcmFrameStart).toBe(16);
    expect(pool.snapshot().invalidRecycleCount).toBe(1);
  });

  test("MessageChannel transfer detaches each sender and reuses returned ownership", async () => {
    const singleSlotConfig = { ...config, slotCount: 1 };
    const pool = new FixedTransferPool(singleSlotConfig);
    const channel = new MessageChannel();
    const block = pool.takeNext()!;
    const originallySent = block.buffer;

    const returned = new Promise<AdmissionResultMessage>((resolve, reject) => {
      channel.port1.onmessage = (event: MessageEvent<AdmissionResultMessage>) => {
        try {
          expect(isAdmissionResultMessage(event.data, singleSlotConfig)).toBe(true);
          expect(pool.acceptAdmissionResult(event.data)).toBe(true);
          resolve(event.data);
        } catch (error) {
          reject(error);
        }
      };
      channel.port2.onmessage = (event: MessageEvent<typeof block>) => {
        try {
          expect(event.data.buffer.byteLength).toBe(2 * 4 * 4);
          const result = admissionResult(event.data, true);
          channel.port2.postMessage(result, [result.buffer]);
          expect(result.buffer.byteLength).toBe(0);
        } catch (error) {
          reject(error);
        }
      };
      channel.port1.start();
      channel.port2.start();
      channel.port1.postMessage(block, [block.buffer]);
    });

    expect(originallySent.byteLength).toBe(0);
    const result = await returned;
    const resumed = pool.takeNext()!;
    expect(resumed.buffer).toBe(result.buffer);
    expect(resumed.buffer.byteLength).toBe(2 * 4 * 4);
    expect(resumed.pcmFrameStart).toBe(4);
    channel.port1.close();
    channel.port2.close();
  });

  test("generated planar samples are deterministic by source frame and channel", () => {
    const pool = new FixedTransferPool(config);
    const block = pool.takeNext()!;
    const samples = new Float32Array(block.buffer);
    expect(Array.from(samples.slice(0, 4))).toEqual([-512 / 16_384, -511 / 16_384, -510 / 16_384, -509 / 16_384]);
    expect(Array.from(samples.slice(4, 8))).toEqual([512 / 16_384, 511 / 16_384, 510 / 16_384, 509 / 16_384]);
  });
});
