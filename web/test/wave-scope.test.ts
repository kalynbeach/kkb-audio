import { afterEach, expect, test } from "bun:test";
import { createPlaybackScope } from "../src/wave-scope/playback-scope";
import { createPlaybackXy, MAX_SCOPE_SAMPLES } from "../src/wave-scope/xy";

const original = new Map<string, PropertyDescriptor | undefined>();
afterEach(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  original.clear();
});

function environment(options: {
  noContext?: boolean; rejectPipeline?: boolean; validationError?: boolean;
  deviceGate?: Promise<void>; pipelineGate?: Promise<void>;
} = {}) {
  const stats = {
    buffersDestroyed: 0, texturesDestroyed: 0, devicesDestroyed: 0, unconfigured: 0,
    submissions: 0, configured: 0, failSubmit: false, textureSizes: [] as unknown[], passes: [] as GPURenderPassDescriptor[],
    uploads: [] as { buffer: GPUBuffer; data: Float32Array<ArrayBuffer> }[],
  };
  const events = new EventTarget();
  let deviceStarted!: () => void;
  let pipelineStarted!: () => void;
  const deviceRequested = new Promise<void>(resolve => { deviceStarted = resolve; });
  const pipelineRequested = new Promise<void>(resolve => { pipelineStarted = resolve; });
  let pipelineCalls = 0;
  let loseDevice!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>(resolve => { loseDevice = resolve; });
  const texture = (kind = "screen") => ({
    createView: () => ({ kind }), destroy: () => { stats.texturesDestroyed += 1; },
  });
  const pass = {
    setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {},
  };
  const device = {
    limits: { maxTextureDimension2D: 8192 }, lost,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    createBuffer: () => ({ destroy: () => { stats.buffersDestroyed += 1; } }),
    createSampler: () => ({}), createShaderModule: () => ({}),
    createRenderPipelineAsync: async () => {
      pipelineCalls += 1;
      pipelineStarted();
      if (pipelineCalls <= 3) await options.pipelineGate;
      if (options.rejectPipeline) throw new Error("injected pipeline error");
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup: () => ({}),
    createTexture: (descriptor: GPUTextureDescriptor) => {
      stats.textureSizes.push(descriptor.size);
      return texture("history");
    },
    createCommandEncoder: () => ({
      beginRenderPass: (descriptor: GPURenderPassDescriptor) => { stats.passes.push(descriptor); return pass; },
      finish: () => ({}),
    }),
    pushErrorScope() {}, popErrorScope: async () => options.validationError ? new Error("injected validation error") : null,
    queue: {
      writeBuffer: (buffer: GPUBuffer, _offset: number, data: Float32Array<ArrayBuffer>) => {
        stats.uploads.push({ buffer, data: data.slice() });
      },
      submit: () => {
        if (stats.failSubmit) throw new Error("injected submission error");
        stats.submissions += 1;
      },
    },
    destroy: () => { stats.devicesDestroyed += 1; },
  };
  const context = {
    configure: () => { stats.configured += 1; }, unconfigure: () => { stats.unconfigured += 1; }, getCurrentTexture: texture,
  };
  const canvas = {
    width: 320, height: 320, getContext: () => options.noContext ? null : context,
  } as unknown as HTMLCanvasElement;
  for (const [key, value] of Object.entries({
    navigator: { gpu: {
      requestAdapter: async () => ({ requestDevice: async () => {
        deviceStarted();
        await options.deviceGate;
        return { ...device };
      } }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    } },
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return { canvas, stats, events, loseDevice, deviceRequested, pipelineRequested };
}

test("XY uses the provided channels, sanitizes nonfinite values and reuses bounded storage", () => {
  const xy = createPlaybackXy(1);
  const left = new Float32Array([0.2, -0.4, Number.NaN, 2]);
  const right = new Float32Array([-0.6, 0.8, 1, Number.POSITIVE_INFINITY]);
  const stereo = xy(left, right, 2);
  expect(Array.from(stereo)).toEqual(Array.from(new Float32Array([0.2, -0.6, -0.4, 0.8, 0, 1, 1, 0])));
  const mono = xy(left, new Float32Array(0), 1);
  expect(mono).toBe(stereo);
  expect(Array.from(mono)).toEqual(Array.from(new Float32Array([0.2, 0.2, -0.4, -0.4, 0, 0, 1, 1])));
  const large = xy(new Float32Array(4000), new Float32Array(4000), 2);
  expect(large.length).toBe(MAX_SCOPE_SAMPLES * 2);
  expect(large.buffer).toBe(stereo.buffer);
  expect(xy(left, right.subarray(0, 2), 2).length).toBe(4);
});

test("clearing erases history immediately and draw uploads actual stereo samples", async () => {
  const { canvas, stats } = environment();
  const failures: unknown[] = [];
  const scope = await createPlaybackScope(canvas, error => failures.push(error));
  const left = new Float32Array([0.5, -0.5]);
  const right = new Float32Array([-0.25, 0.25]);
  scope.draw(left, right, 2, 1 / 30);
  expect(Array.from(stats.uploads.at(-1)!.data)).toEqual(Array.from(new Float32Array([0.43, -0.215, -0.43, 0.215])));
  scope.clear();
  scope.draw(left, right, 2, 1 / 30);
  expect(stats.passes.filter((_, i) => i % 2 === 0).map(p => [...p.colorAttachments][0]!.loadOp)).toEqual(["clear", "load", "clear", "load"]);
  expect(failures).toEqual([]);
  scope.destroy();
});

test("present restores only the saved screen image without uploading samples or accumulating history", async () => {
  const { canvas, stats } = environment();
  const scope = await createPlaybackScope(canvas, () => {});
  const left = new Float32Array([0.5, -0.5]);
  const right = new Float32Array([-0.25, 0.25]);
  scope.draw(left, right, 2, 1 / 30);
  const uploads = stats.uploads.length;
  const passes = stats.passes.length;
  const submissions = stats.submissions;
  scope.present(); scope.present();
  expect(stats.submissions).toBe(submissions + 2);
  expect(stats.uploads).toHaveLength(uploads);
  expect(stats.passes).toHaveLength(passes + 2);
  for (const pass of stats.passes.slice(passes)) {
    expect([...pass.colorAttachments]).toMatchObject([{ view: { kind: "screen" }, loadOp: "clear" }]);
  }
  scope.draw(left, right, 2, 1 / 30);
  expect([...stats.passes.at(-2)!.colorAttachments]).toMatchObject([{ view: { kind: "history" }, loadOp: "load" }]);
  scope.destroy();
  const afterDestroy = stats.submissions;
  scope.present();
  expect(stats.submissions).toBe(afterDestroy);
});

test.each([[800, 400], [400, 800]])("XY preserves equal physical amplitudes at %sx%s", async (width, height) => {
  const { canvas, stats } = environment();
  const scope = await createPlaybackScope(canvas, () => {});
  scope.resize(width, height, 1);
  // Quadrature cardinal points form a circle with equal physical X and Y radii.
  scope.draw(new Float32Array([1, 0, -1, 0]), new Float32Array([0, 1, 0, -1]), 2, 1 / 30);
  const points = stats.uploads.at(-1)!.data;
  const radius = Math.min(width, height) * 0.86 / 2;
  expect(points[0]! * width / 2).toBeCloseTo(radius, 4);
  expect(points[3]! * height / 2).toBeCloseTo(radius, 4);
  expect(points[4]! * width / 2).toBeCloseTo(-radius, 4);
  expect(points[7]! * height / 2).toBeCloseTo(-radius, 4);
  scope.destroy();
});

test("abort releases a late device without configuring the canvas or reporting failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { canvas, stats, deviceRequested } = environment({ deviceGate: gate });
  const abort = new AbortController();
  const failures: unknown[] = [];
  const pending = createPlaybackScope(canvas, error => failures.push(error), abort.signal);
  await deviceRequested;
  abort.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(stats.devicesDestroyed).toBe(1);
  expect(stats.configured).toBe(0);
  expect(stats.unconfigured).toBe(0);
  expect(failures).toEqual([]);
});

test("aborting delayed setup cannot clear or unconfigure a newer scope on the same canvas", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { canvas, stats, pipelineRequested } = environment({ pipelineGate: gate });
  const abort = new AbortController();
  const failures: unknown[] = [];
  const older = createPlaybackScope(canvas, error => failures.push(error), abort.signal);
  await pipelineRequested;
  const newer = await createPlaybackScope(canvas, error => failures.push(error));
  expect(stats.configured).toBe(2);
  expect(stats.submissions).toBe(1);
  abort.abort();
  expect(stats.buffersDestroyed).toBe(2);
  expect(stats.devicesDestroyed).toBe(1);
  expect(stats.unconfigured).toBe(0);
  release();
  await expect(older).rejects.toMatchObject({ name: "AbortError" });
  expect(stats.submissions).toBe(1);
  expect(stats.unconfigured).toBe(0);
  newer.clear();
  expect(stats.submissions).toBe(2);
  newer.destroy();
  expect(stats.unconfigured).toBe(1);
  expect(stats.devicesDestroyed).toBe(2);
  expect(stats.buffersDestroyed).toBe(4);
  expect(failures).toEqual([]);
});

test("resize bounds GPU memory; destruction releases resources once and stops work", async () => {
  const { canvas, stats } = environment();
  const scope = await createPlaybackScope(canvas, () => {});
  scope.resize(10000, 5000, 5);
  expect([canvas.width, canvas.height]).toEqual([2048, 1024]);
  expect(stats.texturesDestroyed).toBe(1);
  scope.resize(10000, 5000, 5);
  expect(stats.textureSizes).toHaveLength(2);
  scope.destroy(); scope.destroy();
  const submissions = stats.submissions;
  scope.clear(); scope.resize(300, 200, 1);
  scope.draw(new Float32Array(1), new Float32Array(1), 1, 1 / 30);
  expect(stats.submissions).toBe(submissions);
  expect(stats.buffersDestroyed).toBe(2);
  expect(stats.texturesDestroyed).toBe(2);
  expect(stats.devicesDestroyed).toBe(1);
  expect(stats.unconfigured).toBe(1);
});

test.each([
  [{ noContext: true }, 0, 0, 0],
  [{ rejectPipeline: true }, 2, 0, 1],
  [{ validationError: true }, 2, 1, 1],
] as const)("failed initialization cleans resources: %j", async (options, buffers, textures, contexts) => {
  const { canvas, stats } = environment(options);
  await expect(createPlaybackScope(canvas, () => {})).rejects.toBeDefined();
  expect(stats.devicesDestroyed).toBe(1);
  expect(stats.buffersDestroyed).toBe(buffers);
  expect(stats.texturesDestroyed).toBe(textures);
  expect(stats.unconfigured).toBe(contexts);
});

test.each(["lost", "uncaptured", "submission"])("%s failure reports once and releases graphics", async source => {
  const { canvas, stats, events, loseDevice } = environment();
  const failures: unknown[] = [];
  const scope = await createPlaybackScope(canvas, error => failures.push(error));
  if (source === "lost") loseDevice({ message: "injected loss", reason: "unknown" } as GPUDeviceLostInfo);
  if (source === "uncaptured") {
    events.dispatchEvent(Object.assign(new Event("uncapturederror", { cancelable: true }), { error: new Error("injected GPU error") }));
  }
  if (source === "submission") { stats.failSubmit = true; scope.clear(); }
  await Promise.resolve();
  expect(failures).toHaveLength(1);
  expect(stats.buffersDestroyed).toBe(2);
  expect(stats.texturesDestroyed).toBe(1);
  expect(stats.devicesDestroyed).toBe(1);
  scope.clear(); scope.destroy();
  loseDevice({ message: "late loss", reason: "destroyed" } as GPUDeviceLostInfo);
  await Promise.resolve();
  expect(failures).toHaveLength(1);
  expect(stats.devicesDestroyed).toBe(1);
});
