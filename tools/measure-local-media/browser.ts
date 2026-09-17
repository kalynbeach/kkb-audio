import { prepareProof, type PreparedProof } from "../../web/src/prepared-playback";
import { prepareWaveform } from "../../web/src/prepare-waveform";

type Fixture = { name: string; seconds: number; rate: number; channels: 1 | 2; bytes: number; sha256: string };
type Resources = { reads: number; readBytes: number; maxReadBytes: number; readWaitMs: number; yields: number; yieldWaitMs: number; wasmBytes: number | null };
type WorkerRecord = { worker: Worker; url: string; terminated: boolean; resources?: Resources; onRead?: () => void; onArmed?: () => void };
const workers: WorkerRecord[] = [];
const contexts: AudioContext[] = [];
let nextRead: (() => void) | undefined;
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const record: WorkerRecord = { worker: this, url: String(url), terminated: false, onRead: nextRead };
    nextRead = undefined;
    workers.push(record);
    this.addEventListener("message", event => {
      if (!String(event.data?.type).startsWith("measurement-")) return;
      event.stopImmediatePropagation();
      if (event.data.type === "measurement-resources") record.resources = event.data;
      if (event.data.type === "measurement-read") { const callback = record.onRead; record.onRead = undefined; callback?.(); }
      if (event.data.type === "measurement-armed") record.onArmed?.();
    });
  }
  override terminate() { workers.find(record => record.worker === this)!.terminated = true; super.terminate(); }
};
const NativeContext = AudioContext;
globalThis.AudioContext = class extends NativeContext {
  constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
};
const output = document.querySelector("pre")!;
const button = document.querySelector("button")!;
const rows: unknown[] = [];
const cancellations: unknown[] = [];
const longTasks: number[] = [];
let runDeadline = Infinity;
const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
  ? new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); }) : undefined;
const deadline = <T>(operation: Promise<T>, ms = 40000): Promise<T> => {
  ms = Math.max(0, Math.min(ms, runDeadline - performance.now()));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Measurement exceeded ${ms} ms`)), ms);
  })]).finally(() => clearTimeout(timer));
};
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function resources(record: WorkerRecord) { check(record.resources, "Missing worker resource sample"); return { ...record.resources }; }
async function timed<T>(run: () => Promise<T>) {
  const started = performance.now();
  const value = await deadline(run());
  return { ms: performance.now() - started, value };
}
function prepare(file: File, signal?: AbortSignal) { return prepareProof({ file, signal, channelCount: 2, maximumFrames: 1024 }); }
async function arm(record: WorkerRecord, onRead: () => void) {
  record.onRead = onRead;
  await deadline(new Promise<void>(resolve => {
    record.onArmed = resolve;
    record.worker.postMessage({ type: "measurement-arm" });
  }), 2000);
}
function cleaned() {
  check(workers.every(record => record.terminated), "Worker left alive");
  check(contexts.every(context => context.state === "closed"), "AudioContext left open");
}
async function measure(file: File, fixture: Fixture, repetition: number) {
  const openedAt = performance.now();
  const firstWorker = workers.length;
  let proof: PreparedProof | undefined;
  const waveformAbort = new AbortController();
  try {
    const preparation = await timed(() => prepare(file, waveformAbort.signal));
    proof = preparation.value;
    proof.setListeningGain(0);
    check(proof.totalFrames === fixture.seconds * fixture.rate && proof.sourceRate === fixture.rate, "Incorrect decoded timeline");
    const pcmWorker = workers[firstWorker]!;
    const preparationResources = resources(pcmWorker);
    // Match PlaybackOwner: waveform starts once playback preparation completes.
    const waveformTask = timed(() => prepareWaveform(file, proof!.totalFrames!, proof!.sourceRate!, waveformAbort.signal))
      .then(result => ({ ...result, fromOpenMs: performance.now() - openedAt }));
    void waveformTask.catch(() => {});
    const target = Math.floor(proof.totalFrames! * 0.9);
    const seek = await timed(() => proof!.seek(target));
    check(seek.value.requestedFrame === target && Math.abs(seek.value.actualMediaFrame - target) <= 1, "Seek did not reach requested source frame");
    const seekResources = resources(pcmWorker);
    const loop = await timed(() => proof!.setLoop(target, target + fixture.rate, true));
    check(loop.value.loopEnabled === true, "Loop was not armed");
    const loopResources = resources(pcmWorker);
    const snapshot = await proof.status();
    check(snapshot.ready && snapshot.failureCode === 0 && snapshot.memoryBytes === 16777216 && snapshot.slotCount === 4, `Invalid prepared transport: ${JSON.stringify(snapshot)}`);
    const waveform = await waveformTask;
    check(waveform.value.totalFrames === proof.totalFrames && waveform.value.extrema.byteLength <= 32768 && waveform.value.extrema.every(Number.isFinite), "Invalid waveform summary");
    const waveformWorker = workers.slice(firstWorker).find(record => record.url.includes("waveform"))!;
    rows.push({ fixture: fixture.name, repetition, preparationMs: preparation.ms, seekMs: seek.ms, loopArmMs: loop.ms,
      waveformAfterReadyMs: waveform.ms, waveformFromOpenMs: waveform.fromOpenMs,
      seekResult: seek.value, outputRate: proof.ready.sampleRate, preparationResources, seekResources, loopResources,
      waveformResources: resources(waveformWorker), waveformSummaryBytes: waveform.value.extrema.byteLength,
      workletMemoryBytes: snapshot.memoryBytes, slots: snapshot.slotCount, producer: proof.producerObservation });
  } finally { waveformAbort.abort(); await proof?.close(); }
  cleaned();
}
async function cancel(file: File, fixture: Fixture, operation: "preparation" | "seek" | "loop" | "waveform") {
  let proof: PreparedProof | undefined;
  const controller = new AbortController();
  let requestedAt: number | undefined;
  let closeTask: Promise<void> | undefined;
  const cancelOnRead = () => {
    requestedAt = performance.now();
    if (operation === "preparation" || operation === "waveform") controller.abort();
    else closeTask = proof!.close();
  };
  try {
    let pending: Promise<unknown>;
    if (operation === "preparation") { nextRead = cancelOnRead; pending = prepare(file, controller.signal); }
    else {
      proof = await deadline(prepare(file, controller.signal));
      proof.setListeningGain(0);
      const target = Math.floor(proof.totalFrames! * 0.9);
      if (operation === "waveform") {
        nextRead = cancelOnRead;
        pending = prepareWaveform(file, proof.totalFrames!, proof.sourceRate!, controller.signal);
      } else {
        await arm(workers.at(-1)!, cancelOnRead);
        pending = operation === "seek" ? proof.seek(target) : proof.setLoop(target, target + fixture.rate, true);
      }
    }
    const outcome = await deadline(pending.then(() => "resolved", () => "rejected"));
    const settledAt = performance.now();
    await closeTask;
    await proof?.close();
    check(requestedAt !== undefined && outcome === "rejected", `${operation} finished before active-read cancellation`);
    cancellations.push({ fixture: fixture.name, operation, trigger: "first worker Blob read in operation", outcome,
      rejectMs: settledAt - requestedAt, cleanupMs: performance.now() - requestedAt });
  } finally { nextRead = undefined; controller.abort(); await proof?.close(); }
  cleaned();
}
button.onclick = async () => {
  button.disabled = true;
  runDeadline = performance.now() + 8 * 60 * 1000;
  const visibility = [{ state: document.visibilityState, at: performance.now() }];
  const recordVisibility = () => visibility.push({ state: document.visibilityState, at: performance.now() });
  document.addEventListener("visibilitychange", recordVisibility);
  observer?.observe({ entryTypes: ["longtask"] });
  let error: string | undefined;
  try {
    check(document.visibilityState === "visible", "Run measurements in a visible document");
    const fixtures: Fixture[] = await deadline(fetch("/fixtures.json").then(response => response.json()));
    for (const fixture of fixtures) {
      check(performance.now() < runDeadline, "Measurement run exceeded eight minutes");
      const file = new File([await deadline(fetch(`/fixtures/${fixture.name}`).then(response => response.blob()))], fixture.name);
      for (let repetition = 1; repetition <= 3; repetition++) {
        check(performance.now() < runDeadline, "Measurement run exceeded eight minutes");
        output.textContent = `${fixture.name}, run ${repetition}/3`;
        await measure(file, fixture, repetition);
      }
      if (fixture.seconds === 180 && (fixture.name.endsWith(".wav") || fixture.name.startsWith("cbr"))) {
        for (const operation of ["preparation", "seek", "loop", "waveform"] as const) {
          output.textContent = `${fixture.name}, cancel ${operation}`;
          await cancel(file, fixture, operation);
        }
      }
    }
    check(visibility.every(entry => entry.state === "visible"), "Document became hidden during measurement");
  } catch (cause) { error = String(cause); }
  finally {
    document.removeEventListener("visibilitychange", recordVisibility);
    observer?.disconnect();
    for (const record of workers) if (!record.terminated) record.worker.terminate();
    await Promise.all(contexts.filter(context => context.state !== "closed").map(context => context.close()));
  }
  const report = { schema: 1, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    timeOrigin: performance.timeOrigin, completedAt: new Date().toISOString(), visibility, error: error ?? null, rows, cancellations,
    longTasks: observer ? longTasks : null, workersCreated: workers.length,
    workersTerminated: workers.filter(record => record.terminated).length, contextsClosed: contexts.filter(context => context.state === "closed").length };
  const saved = await fetch("/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
  output.textContent = `${error ? `FAILED: ${error}` : "Complete"}. Results ${saved.ok ? "saved" : "could not be saved"}.\n${JSON.stringify(report, null, 2)}`;
};
