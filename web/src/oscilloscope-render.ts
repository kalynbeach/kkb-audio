import { OSCILLOSCOPE_SAMPLES, type OscilloscopeBuffers } from "./oscilloscope-tap";

export const OSCILLOSCOPE_INTERVAL = 1000 / 30;
export const OSCILLOSCOPE_HISTORY = 3;
export const oscilloscopePalettes = {
  light: { surface: "#edf1e8", signal: "#27633d", right: "#466c28", baseline: "#b5c3ad" },
  dark: { surface: "#0b140e", signal: "#97d979", right: "#cee9a0", baseline: "#33452e" },
} as const;

/** Three caller-owned windows, never worklet-owned memory. No per-frame sample allocation. */
export class OscilloscopeHistory {
  readonly windows: OscilloscopeBuffers[] = Array.from({ length: OSCILLOSCOPE_HISTORY }, () =>
    [new Float32Array(OSCILLOSCOPE_SAMPLES), new Float32Array(OSCILLOSCOPE_SAMPLES)]);
  count = 0;
  next = 0;
  channels: 1 | 2 = 1;
  get destination(): OscilloscopeBuffers { return this.windows[this.next]!; }
  accept(channels: 1 | 2): void {
    this.channels = channels;
    this.next = (this.next + 1) % OSCILLOSCOPE_HISTORY;
    this.count = Math.min(OSCILLOSCOPE_HISTORY, this.count + 1);
  }
  clear(): void { this.count = 0; this.next = 0; }
}

export function drawOscilloscope(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D,
  history: OscilloscopeHistory, dark: boolean): void {
  const palette = oscilloscopePalettes[dark ? "dark" : "light"];
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.min(760, Math.round(canvas.clientWidth * ratio)));
  const height = Math.max(1, Math.min(1000, Math.round(canvas.clientHeight * ratio)));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.globalAlpha = 1;
  context.fillStyle = palette.surface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = palette.baseline;
  context.lineWidth = ratio * 0.5;
  context.setLineDash([]);
  context.beginPath(); context.moveTo(12 * ratio, height / 2); context.lineTo(width - 12 * ratio, height / 2); context.stroke();
  // Oldest to newest, finite persistence, fixed full-scale amplitude (no AGC).
  for (let age = history.count - 1; age >= 0; age--) {
    const samples = history.windows[(history.next - 1 - age + OSCILLOSCOPE_HISTORY) % OSCILLOSCOPE_HISTORY]!;
    context.globalAlpha = age === 0 ? 1 : age === 1 ? 0.24 : 0.10;
    context.lineWidth = ratio;
    for (let channel = 0; channel < history.channels; channel++) {
      context.strokeStyle = channel === 0 ? palette.signal : palette.right;
      context.setLineDash(channel === 0 ? [] : [4 * ratio, 3 * ratio]);
      context.beginPath();
      for (let index = 0; index < OSCILLOSCOPE_SAMPLES; index++) {
        const value = samples[channel]![index]!;
        if (!Number.isFinite(value)) throw new Error("Invalid oscilloscope observation");
        const x = 12 * ratio + index / (OSCILLOSCOPE_SAMPLES - 1) * (width - 24 * ratio);
        const y = height / 2 - Math.max(-1, Math.min(1, value)) * height * 0.38;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  context.globalAlpha = 1;
  context.setLineDash([]);
}
