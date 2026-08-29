export const InitializationFailure = {
  DuplicateMessage: 20,
  InvalidMessage: 21,
  ProcessorError: 22,
  Timeout: 23,
  ContextState: 24,
} as const;

export type ReadyMessage = {
  type: "ready";
  memoryBytes: number;
  memoryPages: number;
  maximumFrames: number;
  sampleRate: number;
};

export type FailedMessage = {
  type: "failed";
  code: number;
};

export type InitializationMessage = ReadyMessage | FailedMessage;

export type GateResult =
  | { type: "pending" }
  | { type: "ready"; message: ReadyMessage }
  | { type: "failed"; code: number };

export class InitializationGate {
  #result: GateResult = { type: "pending" };

  get result(): GateResult {
    return this.#result;
  }

  accept(value: unknown): GateResult {
    if (this.#result.type !== "pending") {
      this.#result = {
        type: "failed",
        code: InitializationFailure.DuplicateMessage,
      };
      return this.#result;
    }

    if (!isRecord(value)) {
      return this.fail(InitializationFailure.InvalidMessage);
    }
    if (value.type === "failed" && isFiniteInteger(value.code)) {
      return this.fail(value.code);
    }
    if (
      value.type === "ready" &&
      isFiniteInteger(value.memoryBytes) &&
      isFiniteInteger(value.memoryPages) &&
      isFiniteInteger(value.maximumFrames) &&
      typeof value.sampleRate === "number" &&
      Number.isFinite(value.sampleRate) &&
      value.sampleRate > 0
    ) {
      this.#result = { type: "ready", message: value as ReadyMessage };
      return this.#result;
    }
    return this.fail(InitializationFailure.InvalidMessage);
  }

  fail(code: number): GateResult {
    this.#result = { type: "failed", code };
    return this.#result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
