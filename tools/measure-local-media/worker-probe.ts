// Prepended only to the measurement build. Production workers stay unchanged.
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void;
};
const send = scope.postMessage.bind(scope);
const counters = { reads: 0, readBytes: 0, maxReadBytes: 0, readWaitMs: 0, yields: 0, yieldWaitMs: 0 };
let measuredMemory: WebAssembly.Memory | undefined;
let reportRead = true;
WebAssembly.Instance = new Proxy(WebAssembly.Instance, {
  construct(target, args: ConstructorParameters<typeof WebAssembly.Instance>) {
    const instance = new target(...args);
    const memory = instance.exports.memory;
    if (memory instanceof WebAssembly.Memory) measuredMemory = memory;
    return instance;
  },
});
const read = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = async function () {
  if (reportRead) { reportRead = false; send({ type: "measurement-read" }); }
  const started = performance.now();
  const bytes = await read.call(this);
  counters.reads++;
  counters.readBytes += bytes.byteLength;
  counters.maxReadBytes = Math.max(counters.maxReadBytes, bytes.byteLength);
  counters.readWaitMs += performance.now() - started;
  return bytes;
};
const timer = globalThis.setTimeout;
globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (typeof callback !== "function" || (delay !== 0 && delay !== 4)) return timer(callback, delay, ...args);
  const started = performance.now();
  return timer(() => { counters.yields++; counters.yieldWaitMs += performance.now() - started; callback(...args); }, delay);
}) as typeof setTimeout;
scope.postMessage = (message, transfer) => {
  send({ type: "measurement-resources", ...counters, wasmBytes: measuredMemory?.buffer.byteLength ?? null });
  send(message, transfer);
};
self.addEventListener("message", event => {
  if (event.data?.type !== "measurement-arm") return;
  event.stopImmediatePropagation();
  reportRead = true;
  send({ type: "measurement-armed" });
});
