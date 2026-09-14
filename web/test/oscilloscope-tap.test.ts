import { afterEach, beforeEach, expect, test } from "bun:test";
import { OscilloscopeTap, OSCILLOSCOPE_SAMPLES, type OscilloscopeBuffers } from "../src/oscilloscope-tap";
import { PreparedProof } from "../src/prepared-playback";
import { InitializationGate } from "../src/protocol";
import { FakePlayback } from "./playback-fixture";

class Node {
  static all: Node[] = [];
  connections: { node: Node; output: number }[] = [];
  channelCount = 2;
  constructor() { Node.all.push(this); }
  connect(node: Node, output = 0): Node { this.connections.push({ node, output }); return node; }
  disconnect(node?: Node): void { this.connections = node ? this.connections.filter(c => c.node !== node) : []; }
}
class Gain extends Node { gain: { value: number }; constructor(_context: unknown, options: GainOptions) { super(); this.gain = { value: options.gain! }; } }
class Analyser extends Node {
  static fail = false;
  fftSize = OSCILLOSCOPE_SAMPLES;
  getFloatTimeDomainData(array: Float32Array) { if (Analyser.fail) throw new Error("injected read"); array.fill(0.25); }
}
class Context {
  state = "suspended";
  sampleRate = 48000;
  currentTime = 0;
  destination = new Node();
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async close() { this.state = "closed"; }
}
const original = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  Node.all = []; Analyser.fail = false;
  for (const [key, value] of Object.entries({ ChannelSplitterNode: Node, AnalyserNode: Analyser, GainNode: Gain })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterEach(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const buffers = (): OscilloscopeBuffers => [new Float32Array(OSCILLOSCOPE_SAMPLES), new Float32Array(OSCILLOSCOPE_SAMPLES)];
function setup(file = true) {
  const fixture = new FakePlayback();
  fixture.snapshot.processCount = 1;
  const context = new Context();
  const node = new Node();
  const gate = new InitializationGate(); gate.accept(fixture.ready);
  let proof: PreparedProof;
  const port = { postMessage: () => queueMicrotask(() => proof.acceptRuntimeMessage({ type: "snapshot", snapshot: fixture.snapshot })) };
  const worklet = Object.assign(node, { port });
  const worker = { terminate() {}, postMessage(message: { type: string; epoch?: number; target?: number }) {
    if (message.type !== "seek") return;
    fixture.snapshot = { ...fixture.snapshot, epoch: message.epoch!, ready: true };
    queueMicrotask(() => {
      proof.acceptWorkerMessage({ type: "seek-accepted", epoch: message.epoch });
      proof.acceptWorkerMessage({ type: "seek-complete", epoch: message.epoch, requestedFrame: message.target, pcmFrame: message.target, result: "Exact" });
    });
  } };
  proof = new PreparedProof(context as unknown as AudioContext, worklet as unknown as AudioWorkletNode, gate,
    fixture.ready, worker as unknown as Worker, 4, file ? 480000 : undefined, file ? 48000 : undefined);
  return { proof, context, node, fixture };
}

test.each([1, 2] as const)("tap retains %s independent channels, muted sink and context-time warmup", channels => {
  const context = new Context(); context.state = "running";
  const source = new Node(); const direct = new Node(); source.connect(direct);
  const tap = new OscilloscopeTap(context as unknown as AudioContext, source as unknown as AudioNode, channels);
  const data = buffers();
  expect(tap.read(data)).toBe("warming");
  context.currentTime = 3071 / 48000; expect(tap.read(data)).toBe("warming");
  context.currentTime = 3072 / 48000; expect(tap.read(data)).toBe(channels);
  expect(data[0][0]).toBe(0.25); expect(data[1][0]).toBe(channels === 2 ? 0.25 : 0);
  expect(Node.all.filter(n => n instanceof Analyser)).toHaveLength(channels);
  expect(Node.all.filter(n => n instanceof Gain).every(n => n.gain.value === 0)).toBe(true);
  const splitter = source.connections[1]!.node;
  expect(splitter.connections.map(c => c.output)).toEqual(channels === 2 ? [0, 1] : [0]);
  context.state = "suspended"; expect(tap.read(data)).toBe("warming");
  tap.restartWarmup(); context.state = "running"; expect(tap.read(data)).toBe("warming");
  tap.dispose(); tap.dispose(); expect(tap.read(data)).toBe("unavailable");
  expect(source.connections.map(c => c.node)).toEqual([direct]);
  expect(splitter.connections).toEqual([]);
});

test.each([true, false])("first listening gain before activation=%s preserves tap and single file route", async before => {
  const { proof, context, node } = setup();
  if (before) proof.setListeningGain(0);
  await proof.play();
  expect(proof.readOscilloscope(buffers())).toBe("warming");
  const splitter = node.connections.find(c => !(c.node instanceof Gain) && c.node !== context.destination)!.node;
  if (!before) proof.setListeningGain(0);
  proof.setListeningGain(0.6); proof.setListeningGain(0);
  expect(node.connections).toHaveLength(2);
  expect(node.connections.some(c => c.node === splitter)).toBe(true);
  expect(node.connections.some(c => c.node === context.destination)).toBe(false);
  context.currentTime = 1; expect(proof.readOscilloscope(buffers())).toBe(2);
  await proof.close(); expect(node.connections).toEqual([]); expect(splitter.connections).toEqual([]);
});

test("proof-only activate retains its analyser route when listening gain is first set", async () => {
  const { proof, node } = setup(false);
  const result = await proof.activate();
  const route = node.connections[0]!.node;
  proof.setListeningGain(0.5);
  expect(node.connections.map(c => c.node)).toEqual([route]);
  expect(result.analyserObservedSignal).toBe(true);
  expect(proof.readOscilloscope(buffers())).toBe("unavailable");
  await proof.close();
});

test("seek destroys history; paused seek cannot qualify with wall time; resume restarts warmup", async () => {
  const { proof, context, node, fixture } = setup();
  proof.setListeningGain(0); await proof.play(); proof.readOscilloscope(buffers()); context.currentTime = 1;
  expect(proof.readOscilloscope(buffers())).toBe(2);
  const old = node.connections[1]!.node;
  await proof.pause(); await proof.seek(48000);
  expect(old.connections).toEqual([]);
  proof.acceptRuntimeMessage({ type: "snapshot", snapshot: { ...fixture.snapshot, epoch: 1 } });
  expect(proof.readOscilloscope(buffers())).toBe("warming");
  await proof.status(); context.currentTime = 100;
  expect(proof.readOscilloscope(buffers())).toBe("warming");
  await proof.play(); expect(proof.readOscilloscope(buffers())).toBe("warming");
  context.currentTime += 1; expect(proof.readOscilloscope(buffers())).toBe(2);
  await proof.pause(); await proof.play(); expect(proof.readOscilloscope(buffers())).toBe("warming");
  await proof.close(); expect(proof.readOscilloscope(buffers())).toBe("unavailable");
});

test("analyser setup/read failure never stops playback", async () => {
  const { proof, context, node } = setup();
  proof.setListeningGain(0); await proof.play(); proof.readOscilloscope(buffers()); context.currentTime = 1;
  Analyser.fail = true;
  expect(proof.readOscilloscope(buffers())).toBe("unavailable");
  expect(context.state).toBe("running"); expect(node.connections).toHaveLength(1);
  expect((await proof.status()).failureCode).toBe(0);
  await proof.close();
  Object.defineProperty(globalThis, "AnalyserNode", { configurable: true, value: class { constructor() { throw new Error("injected setup"); } } });
  const next = setup(); next.proof.setListeningGain(0); await next.proof.play();
  expect(next.proof.readOscilloscope(buffers())).toBe("unavailable");
  expect(next.context.state).toBe("running"); expect(next.node.connections).toHaveLength(1);
  next.proof.releaseOscilloscope(); await next.proof.close();
});
