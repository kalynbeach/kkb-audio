import { expect, spyOn, test } from "bun:test";
import { prepareWaveform } from "../src/prepare-waveform";
import { deferred } from "./playback-fixture";

test.each(["deadline", "replacement"])("prepare-waveform %s settles held compilation and never creates a late worker", async reason => {
  const deadline = new AbortController(), caller = new AbortController();
  const compilation = deferred<WebAssembly.Module>();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([0])));
  const compile = spyOn(WebAssembly, "compile").mockReturnValue(compilation.promise);
  const OriginalWorker = globalThis.Worker;
  let workers = 0;
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { workers++; } } });
  try {
    const result = prepareWaveform(new File([], "source.wav"), 1, 48000, caller.signal);
    for (let turn = 0; turn < 100 && compile.mock.calls.length === 0; turn++) await Bun.sleep(0);
    expect(compile).toHaveBeenCalledTimes(1);
    (reason === "deadline" ? deadline : caller).abort();
    await expect(result).rejects.toThrow(/cancelled|timed out/);
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(workers).toBe(0);
    compilation.resolve({} as WebAssembly.Module);
    await Bun.sleep(0);
    expect(workers).toBe(0);
  } finally {
    timeout.mockRestore(); fetcher.mockRestore(); compile.mockRestore();
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: OriginalWorker });
  }
});
