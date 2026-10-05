import type { SourceWaveform } from "./source-waveform";

export type PrepareWaveform = (file: File, totalFrames: number, sourceRate: number, signal: AbortSignal) => Promise<SourceWaveform>;

export const prepareWaveform: PrepareWaveform = async (file, totalFrames, sourceRate, signal) => {
  signal.throwIfAborted();
  // Fetch/compile is abort-raced too; replacing during compilation cannot start a worker.
  let worker: Worker | undefined;
  let abort: () => void = () => {};
  const deadline = AbortSignal.timeout(30000);
  const startupSignal = AbortSignal.any([signal, deadline]);
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { worker?.terminate(); reject(new Error("Waveform cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      let startupAbort: () => void = () => {};
      const startupCancelled = new Promise<never>((_resolve, reject) => {
        startupAbort = () => reject(new Error("Waveform startup cancelled or timed out"));
        startupSignal.addEventListener("abort", startupAbort, { once: true });
        if (startupSignal.aborted) startupAbort();
      });
      let module: WebAssembly.Module;
      try {
        module = await Promise.race([startupCancelled, (async () => {
          const response = await fetch("/audio-runtime/kkb_audio_bg.wasm", { signal: startupSignal });
          if (!response.ok) throw new Error("Waveform module unavailable");
          return WebAssembly.compile(await response.arrayBuffer());
        })()]);
      } finally { startupSignal.removeEventListener("abort", startupAbort); }
      signal.throwIfAborted();
      startupSignal.throwIfAborted();
      worker = new Worker("/audio-runtime/waveform-worker.js", { type: "module" });
      return await new Promise<SourceWaveform>((resolve, reject) => {
        worker!.onerror = () => reject(new Error("Waveform worker unavailable"));
        worker!.onmessage = event => {
          const message = event.data;
          if (message?.type === "waveform-complete") resolve(message.summary);
          else reject(new Error("Waveform analysis unavailable"));
        };
        worker!.postMessage({ file, module, totalFrames, sourceRate });
      });
    })()]);
  } finally {
    signal.removeEventListener("abort", abort);
    worker?.terminate();
  }
};
