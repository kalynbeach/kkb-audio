import { describe, expect, test } from "bun:test";
import {
  isAdmissionResultMessage,
  isPcmBlockMessage,
  type AdmissionResultMessage,
  type PcmStreamConfig,
} from "../src/pcm-protocol";
import {
  FixedPcmProducer,
  FixedTransferPool,
  PCM_WORKER_FAILURE_CODE,
  PROOF_REJECTION_RETRY_LIMIT,
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
      type: "pcm", slotId: 0, epoch: 7, sourceFrameStart: 0,
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
    expect(resumed?.sourceFrameStart).toBe(16);
    expect(pool.snapshot().invalidRecycleCount).toBe(1);
  });

  test("suspended returns stay quiescent and active pumping uses one positively paced timer", () => {
    const sent: NonNullable<ReturnType<FixedTransferPool["takeNext"]>>[] = [];
    const failures: number[] = [];
    const scheduled: Array<{ callback: () => void; delayMilliseconds: number }> = [];
    const producer = new FixedPcmProducer(
      config,
      (block) => sent.push(block),
      (code) => failures.push(code),
      (callback, delayMilliseconds) => scheduled.push({ callback, delayMilliseconds }),
    );

    producer.prefill(config.slotCount);
    expect(sent.map((block) => block.sourceFrameStart)).toEqual([0, 4, 8, 12]);
    expect(producer.snapshot().exhaustionCount).toBe(1);
    for (const block of sent.slice()) {
      expect(producer.acceptAdmissionResult(admissionResult(block, true))).toBe(true);
    }
    expect(sent).toHaveLength(4);
    expect(scheduled).toHaveLength(0);

    producer.activate();
    producer.activate();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMilliseconds).toBe(
      Math.ceil((config.slotFrames * 1_000) / config.sampleRate),
    );
    expect(scheduled[0]?.delayMilliseconds).toBeGreaterThan(0);
    scheduled.shift()?.callback();
    expect(sent).toHaveLength(5);
    expect(failures).toEqual([]);
  });

  test("preserves a rejected block through the bounded retries then fails once and stops scheduling", () => {
    const sent: NonNullable<ReturnType<FixedTransferPool["takeNext"]>>[] = [];
    const failures: number[] = [];
    const scheduled: Array<() => void> = [];
    const singleSlotConfig = { ...config, slotCount: 1 };
    const producer = new FixedPcmProducer(
      singleSlotConfig,
      (block) => sent.push(block),
      (code) => failures.push(code),
      (callback) => scheduled.push(callback),
    );

    producer.prefill(1);
    const original = sent[0]!;
    expect(producer.acceptAdmissionResult(admissionResult(original, true))).toBe(true);
    producer.activate();
    scheduled.shift()?.();
    const rejected = sent[1]!;
    const metadata = {
      type: rejected.type,
      slotId: rejected.slotId,
      epoch: rejected.epoch,
      sourceFrameStart: rejected.sourceFrameStart,
      validFrames: rejected.validFrames,
      discontinuity: rejected.discontinuity,
      endOfStream: rejected.endOfStream,
    };

    for (let rejection = 1; rejection <= PROOF_REJECTION_RETRY_LIMIT; rejection += 1) {
      expect(producer.acceptAdmissionResult(admissionResult(sent.at(-1)!, false))).toBe(true);
      if (rejection < PROOF_REJECTION_RETRY_LIMIT) {
        expect(scheduled).toHaveLength(1);
        scheduled.shift()?.();
        expect(sent.at(-1)).toMatchObject(metadata);
        expect(sent.at(-1)?.buffer).toBe(rejected.buffer);
      }
    }

    expect(failures).toEqual([PCM_WORKER_FAILURE_CODE]);
    expect(scheduled).toHaveLength(0);
    producer.activate();
    expect(producer.acceptAdmissionResult(admissionResult(sent.at(-1)!, false))).toBe(false);
    expect(failures).toEqual([PCM_WORKER_FAILURE_CODE]);
    expect(scheduled).toHaveLength(0);
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
    expect(resumed.sourceFrameStart).toBe(4);
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
