import { describe, expect, test } from "bun:test";
import {
  PreparationLifecycle,
  type ClosableProof,
} from "../src/preparation-lifecycle";

class FakeProof implements ClosableProof {
  readonly name: string;
  readonly #events: string[];

  constructor(name: string, events: string[]) {
    this.name = name;
    this.#events = events;
  }

  async close(): Promise<void> {
    this.#events.push(`close:${this.name}`);
  }
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe("PreparationLifecycle", () => {
  test("rejects a concurrent preparation without creating or replacing a proof", async () => {
    const events: string[] = [];
    const lifecycle = new PreparationLifecycle<FakeProof>();
    const firstResult = deferred<FakeProof>();
    const first = lifecycle.tryReplace(() => {
      events.push("create:first");
      return firstResult.promise;
    });
    expect(first).toBeDefined();

    let concurrentFactoryCalls = 0;
    const concurrent = lifecycle.tryReplace(async () => {
      concurrentFactoryCalls += 1;
      return new FakeProof("concurrent", events);
    });

    expect(concurrent).toBeUndefined();
    expect(concurrentFactoryCalls).toBe(0);
    expect(lifecycle.active).toBeUndefined();

    const firstProof = new FakeProof("first", events);
    firstResult.resolve(firstProof);
    await first;

    expect(lifecycle.active).toBe(firstProof);
    expect(events).toEqual(["create:first"]);
  });

  test("close aborts preparation and disposes an uncancellable late result before reload", async () => {
    const events: string[] = [];
    const lifecycle = new PreparationLifecycle<FakeProof>();
    const result = deferred<FakeProof>();
    let signal: AbortSignal | undefined;
    const pending = lifecycle.tryReplace(value => { signal = value; return result.promise; })!;
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await lifecycle.closeActive();
    expect(signal?.aborted).toBe(true);
    result.resolve(new FakeProof("late", events));
    await expect(pending).rejects.toThrow("cancelled");
    expect(lifecycle.active).toBeUndefined();
    expect(events).toEqual(["close:late"]);
    await lifecycle.tryReplace(async () => new FakeProof("reload", events));
    expect(lifecycle.active?.name).toBe("reload");
    await lifecycle.closeActive();
  });

  test("closes the active proof before creating its sequential replacement", async () => {
    const events: string[] = [];
    const lifecycle = new PreparationLifecycle<FakeProof>();
    const firstProof = new FakeProof("first", events);
    await lifecycle.tryReplace(async () => {
      events.push("create:first");
      return firstProof;
    });

    const secondProof = new FakeProof("second", events);
    const second = lifecycle.tryReplace(async () => {
      events.push("create:second");
      return secondProof;
    });
    expect(second).toBeDefined();
    await second;

    expect(lifecycle.active).toBe(secondProof);
    expect(events).toEqual(["create:first", "close:first", "create:second"]);
  });
});
