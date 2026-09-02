import { describe, expect, test } from "bun:test";
import {
  InitializationFailure,
  InitializationGate,
  type ReadyMessage,
} from "../src/protocol";

const ready: ReadyMessage = {
  type: "ready",
  memoryBytes: 16_777_216,
  memoryPages: 256,
  maximumFrames: 1_024,
  sampleRate: 48_000,
  slotCount: 4,
};

describe("InitializationGate", () => {
  test("accepts one explicit ready message", () => {
    const gate = new InitializationGate();
    expect(gate.accept(ready)).toEqual({ type: "ready", message: ready });
  });

  test("accepts one coded failed message", () => {
    const gate = new InitializationGate();
    expect(gate.accept({ type: "failed", code: 41 })).toEqual({
      type: "failed",
      code: 41,
    });
  });

  test("rejects malformed and duplicate initialization messages", () => {
    const malformed = new InitializationGate();
    expect(malformed.accept({ type: "ready", memoryBytes: "large" })).toEqual({
      type: "failed",
      code: InitializationFailure.InvalidMessage,
    });

    const duplicate = new InitializationGate();
    duplicate.accept(ready);
    expect(duplicate.accept(ready)).toEqual({
      type: "failed",
      code: InitializationFailure.DuplicateMessage,
    });
  });

  test("records timeout and processor errors as coded failures", () => {
    const timeout = new InitializationGate();
    expect(timeout.fail(InitializationFailure.Timeout)).toEqual({
      type: "failed",
      code: InitializationFailure.Timeout,
    });

    const processor = new InitializationGate();
    expect(processor.fail(InitializationFailure.ProcessorError)).toEqual({
      type: "failed",
      code: InitializationFailure.ProcessorError,
    });
  });
});
