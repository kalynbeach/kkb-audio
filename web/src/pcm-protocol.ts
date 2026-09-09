export type PcmStreamConfig = {
  channelCount: 1 | 2;
  epoch: number;
  sampleRate: number;
  slotCount: number;
  slotFrames: number;
  sourceId: number;
  sourceRate?: number;
  sourceFrames?: number;
};

export type PcmBlockMessage = {
  type: "pcm";
  slotId: number;
  epoch: number;
  pcmFrameStart: number;
  validFrames: number;
  discontinuity: boolean;
  endOfStream: boolean;
  buffer: ArrayBuffer;
};

export type AdmissionResultMessage = {
  type: "admission-result";
  slotId: number;
  accepted: boolean;
  buffer: ArrayBuffer;
};

export function isPcmStreamConfig(value: unknown): value is PcmStreamConfig {
  if (!isRecord(value)) return false;
  return (
    (value.channelCount === 1 || value.channelCount === 2) &&
    nonNegativeSafeInteger(value.epoch) &&
    typeof value.sampleRate === "number" &&
    Number.isFinite(value.sampleRate) &&
    value.sampleRate > 0 &&
    nonNegativeSafeInteger(value.sourceId) &&
    nonNegativeSafeInteger(value.slotCount) &&
    value.slotCount > 0 &&
    nonNegativeSafeInteger(value.slotFrames) &&
    value.slotFrames > 0
  );
}

export function isPcmBlockMessage(
  value: unknown,
  config: PcmStreamConfig,
): value is PcmBlockMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === "pcm" &&
    nonNegativeSafeInteger(value.slotId) &&
    value.slotId < config.slotCount &&
    nonNegativeSafeInteger(value.epoch) &&
    nonNegativeSafeInteger(value.pcmFrameStart) &&
    nonNegativeSafeInteger(value.validFrames) &&
    value.validFrames > 0 &&
    value.validFrames <= config.slotFrames &&
    typeof value.discontinuity === "boolean" &&
    typeof value.endOfStream === "boolean" &&
    value.buffer instanceof ArrayBuffer &&
    value.buffer.byteLength ===
      config.channelCount * config.slotFrames * Float32Array.BYTES_PER_ELEMENT
  );
}

export function isAdmissionResultMessage(
  value: unknown,
  config: PcmStreamConfig,
): value is AdmissionResultMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === "admission-result" &&
    nonNegativeSafeInteger(value.slotId) &&
    value.slotId < config.slotCount &&
    typeof value.accepted === "boolean" &&
    value.buffer instanceof ArrayBuffer &&
    value.buffer.byteLength ===
      config.channelCount * config.slotFrames * Float32Array.BYTES_PER_ELEMENT
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
