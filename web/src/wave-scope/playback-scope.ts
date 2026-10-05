// Adapted from kalynbeach/kkb's WebGPU oscilloscope renderer.
// See THIRD_PARTY_NOTICES.md for source provenance and local changes.
import { WAVE_SCOPE_PRESET } from "./preset";
import { COMPOSITE_SHADER } from "./shaders/composite";
import { FADE_SHADER } from "./shaders/fade";
import { TRACE_SHADER } from "./shaders/trace";
import { createRendererUniformValues, packRendererUniforms } from "./uniforms";
import { createPlaybackXy, MAX_SCOPE_SAMPLES } from "./xy";

export interface PlaybackScope {
  draw(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>, channels: 1 | 2, deltaSeconds: number): void;
  resize(width: number, height: number, dpr: number): void;
  present(): void;
  clear(): void;
  destroy(): void;
}

const HISTORY_FORMAT: GPUTextureFormat = "rgba16float";
// WebGPU usage flags, matching the upstream renderer.
const COPY_DST = 0x0008;
const VERTEX = 0x0020;
const UNIFORM = 0x0040;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;
const MAX_DIMENSION = 2048;
const EMPTY_POINTS = new Float32Array(0);
const canvasOwners = new WeakMap<HTMLCanvasElement, symbol>();
const aborted = () => new DOMException("Oscilloscope setup was cancelled.", "AbortError");

/** Owns only graphics resources. It never creates an audio source or playback owner. */
export async function createPlaybackScope(
  canvas: HTMLCanvasElement,
  onFailure: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<PlaybackScope> {
  if (signal?.aborted) throw aborted();
  const ownership = Symbol();
  canvasOwners.set(canvas, ownership);
  const ownsCanvas = () => canvasOwners.get(canvas) === ownership;
  const cancelled = () => signal?.aborted || !ownsCanvas();
  const releaseOwnership = () => { if (ownsCanvas()) canvasOwners.delete(canvas); };
  if (!navigator.gpu) throw new Error("WebGPU is unavailable in this browser.");
  const adapter = await navigator.gpu.requestAdapter();
  if (cancelled()) { releaseOwnership(); throw aborted(); }
  if (!adapter) throw new Error("Unable to acquire a WebGPU adapter.");
  const device = await adapter.requestDevice();
  if (cancelled()) { device.destroy(); releaseOwnership(); throw aborted(); }
  let context: GPUCanvasContext | null = null;
  const buffers: GPUBuffer[] = [];
  let history: { texture: GPUTexture; view: GPUTextureView; binding: GPUBindGroup } | null = null;
  let historyPrimed = false;
  let destroyed = false;
  let setupFailure: unknown;

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    signal?.removeEventListener("abort", destroy);
    device.removeEventListener("uncapturederror", uncapturedError);
    history?.texture.destroy();
    history = null;
    for (const buffer of buffers) buffer.destroy();
    if (ownsCanvas()) context?.unconfigure();
    releaseOwnership();
    device.destroy();
  };
  const fail = (error: unknown) => {
    if (destroyed) return;
    if (cancelled()) { destroy(); return; }
    setupFailure = error;
    destroy();
    onFailure(error);
  };
  const uncapturedError = (event: GPUUncapturedErrorEvent) => {
    event.preventDefault();
    fail(event.error);
  };
  device.addEventListener("uncapturederror", uncapturedError);
  signal?.addEventListener("abort", destroy, { once: true });
  void device.lost.then(info => {
    if (!destroyed) fail(new Error(`WebGPU device lost: ${info.message || info.reason}`));
  });

  try {
    context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw new Error("Unable to acquire a WebGPU canvas context.");
    const gpuContext = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    const maxDimension = Math.min(MAX_DIMENSION, device.limits.maxTextureDimension2D);
    const dimensions = (width: number, height: number, dpr: number) => {
      const ratio = Number.isFinite(dpr) ? Math.max(1, Math.min(2, dpr)) : 1;
      const w = Number.isFinite(width) ? Math.max(1, width) * ratio : 1;
      const h = Number.isFinite(height) ? Math.max(1, height) * ratio : 1;
      const scale = Math.min(1, maxDimension / Math.max(w, h));
      return [Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale))] as const;
    };
    [canvas.width, canvas.height] = dimensions(canvas.width, canvas.height, 1);
    gpuContext.configure({ alphaMode: "opaque", device, format });

    const sampler = device.createSampler({
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
      magFilter: "linear", minFilter: "linear",
    });
    const makeBuffer = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const uniformScratch = new Float32Array(8);
    const uniformBuffer = makeBuffer(32, COPY_DST | UNIFORM);
    const vertexBuffer = makeBuffer(MAX_SCOPE_SAMPLES * 8, COPY_DST | VERTEX);
    const fadeModule = device.createShaderModule({ code: FADE_SHADER });
    const traceModule = device.createShaderModule({ code: TRACE_SHADER });
    const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });

    // Async pipeline creation surfaces WGSL/pipeline errors before the scope is ready.
    const [fadePipeline, tracePipeline, compositePipeline] = await Promise.all([
      device.createRenderPipelineAsync({
        layout: "auto", vertex: { module: fadeModule, entryPoint: "vs" },
        fragment: { module: fadeModule, entryPoint: "fs", targets: [{
          format: HISTORY_FORMAT,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }] }, primitive: { topology: "triangle-list" },
      }),
      device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module: traceModule, entryPoint: "vs", buffers: [{
          arrayStride: 8, attributes: [{ format: "float32x2", offset: 0, shaderLocation: 0 }],
        }] },
        fragment: { module: traceModule, entryPoint: "fs", targets: [{
          format: HISTORY_FORMAT,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }] }, primitive: { topology: "line-strip" },
      }),
      device.createRenderPipelineAsync({
        layout: "auto", vertex: { module: compositeModule, entryPoint: "vs" },
        fragment: { module: compositeModule, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      }),
    ]);
    if (destroyed || cancelled()) throw setupFailure ?? aborted();
    const fadeBinding = device.createBindGroup({
      layout: fadePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const traceBinding = device.createBindGroup({
      layout: tracePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const rebuildHistory = () => {
      history?.texture.destroy();
      history = null;
      historyPrimed = false;
      const texture = device.createTexture({
        format: HISTORY_FORMAT, size: { width: canvas.width, height: canvas.height },
        usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
      });
      try {
        const view = texture.createView();
        const binding = device.createBindGroup({
          layout: compositePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: view }, { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: uniformBuffer } },
          ],
        });
        history = { texture, view, binding };
      } catch (error) {
        texture.destroy();
        throw error;
      }
    };
    rebuildHistory();

    const background = WAVE_SCOPE_PRESET.canvas.background;
    const clearValue = { r: background, g: background, b: background, a: 1 };
    const compositeHistory = (encoder: GPUCommandEncoder) => {
      if (!history) return;
      const screenPass = encoder.beginRenderPass({ colorAttachments: [{
        view: gpuContext.getCurrentTexture().createView(), loadOp: "clear", clearValue, storeOp: "store",
      }] });
      screenPass.setPipeline(compositePipeline);
      screenPass.setBindGroup(0, history.binding);
      screenPass.draw(3);
      screenPass.end();
    };
    const drawFrame = (points: Float32Array<ArrayBuffer>, deltaSeconds: number) => {
      if (!history) return;
      const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(1, deltaSeconds)) : 1 / 30;
      const uniforms = packRendererUniforms(
        createRendererUniformValues(WAVE_SCOPE_PRESET, canvas.width, canvas.height, dt), uniformScratch,
      );
      device.queue.writeBuffer(uniformBuffer, 0, uniforms);
      if (points.length) device.queue.writeBuffer(vertexBuffer, 0, points);
      const encoder = device.createCommandEncoder();
      const historyPass = encoder.beginRenderPass({ colorAttachments: [{
        view: history.view, loadOp: historyPrimed ? "load" : "clear", clearValue, storeOp: "store",
      }] });
      historyPass.setPipeline(fadePipeline);
      historyPass.setBindGroup(0, fadeBinding);
      historyPass.draw(3);
      if (points.length) {
        historyPass.setPipeline(tracePipeline);
        historyPass.setBindGroup(0, traceBinding);
        historyPass.setVertexBuffer(0, vertexBuffer);
        historyPass.draw(points.length / 2);
      }
      historyPass.end();
      compositeHistory(encoder);
      device.queue.submit([encoder.finish()]);
      historyPrimed = true;
    };
    const xy = createPlaybackXy(WAVE_SCOPE_PRESET.gain);
    const guard = (operation: () => void) => {
      if (destroyed) return;
      if (cancelled()) { destroy(); return; }
      try { operation(); } catch (error) { fail(error); }
    };
    const clear = () => guard(() => { historyPrimed = false; drawFrame(EMPTY_POINTS, 0); });
    // Validate resource creation and the first render before returning an instance.
    device.pushErrorScope("validation");
    drawFrame(EMPTY_POINTS, 0);
    const validationError = await device.popErrorScope();
    if (validationError) throw validationError;
    if (destroyed || cancelled()) throw setupFailure ?? aborted();

    return {
      draw: (left, right, channels, deltaSeconds) => guard(() => drawFrame(xy(left, right, channels, canvas.width, canvas.height), deltaSeconds)),
      resize: (width, height, dpr) => guard(() => {
        const [nextWidth, nextHeight] = dimensions(width, height, dpr);
        if (canvas.width === nextWidth && canvas.height === nextHeight) return;
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        gpuContext.configure({ alphaMode: "opaque", device, format });
        rebuildHistory();
        drawFrame(EMPTY_POINTS, 0);
      }),
      // Browser repaint may discard the canvas image while playback is paused.
      // Re-present saved history without another trace, fade, or sample read.
      present: () => guard(() => {
        const encoder = device.createCommandEncoder();
        compositeHistory(encoder);
        device.queue.submit([encoder.finish()]);
      }),
      clear,
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
