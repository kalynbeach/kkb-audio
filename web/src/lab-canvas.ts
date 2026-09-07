import { TOTAL_FRAMES, type Processor } from "./lab-model.ts";
import { trace, type LabState } from "./use-lab.ts";

function palette(canvas: HTMLCanvasElement) {
  const styles = getComputedStyle(canvas);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    a: token("--chart-1"),
    b: token("--chart-2"),
    output: token("--chart-3"),
    grid: token("--border"),
    muted: token("--muted-foreground"),
    foreground: token("--foreground"),
    mono: token("--pi-font-mono"),
  };
}

export const scopeInsets = { left: 62, right: 18 };
export const overviewInsets = { left: 36, right: 16 };

export function frameAt(
  clientX: number,
  canvas: HTMLCanvasElement,
  state: LabState,
  whole = false,
) {
  const rect = canvas.getBoundingClientRect();
  const { left, right } = whole ? overviewInsets : scopeInsets;
  const fraction = Math.max(
    0,
    Math.min(
      1,
      (clientX - rect.left - left) / Math.max(1, rect.width - left - right),
    ),
  );
  return Math.round(
    (whole ? 0 : state.viewStart) +
      fraction * ((whole ? TOTAL_FRAMES : state.span) - 1),
  );
}

function canvasContext(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} {
  const rect = canvas.getBoundingClientRect(),
    ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width),
    height = rect.height;
  if (
    canvas.width !== Math.round(width * ratio) ||
    canvas.height !== Math.round(height * ratio)
  ) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Preserve peaks while zoomed out; show individual sample points while zoomed in. */
function waveform(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  start: number,
  count: number,
  x: number,
  width: number,
  center: number,
  amplitude: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  if (count > width * 2) {
    for (let pixel = 0; pixel < width; pixel++) {
      const first = start + Math.floor((pixel / width) * count),
        end = Math.min(
          samples.length,
          start + count,
          start + Math.ceil(((pixel + 1) / width) * count),
        );
      let lo = Infinity,
        hi = -Infinity;
      for (let i = first; i < end; i++) {
        lo = Math.min(lo, samples[i]);
        hi = Math.max(hi, samples[i]);
      }
      ctx.moveTo(x + pixel, center - hi * amplitude);
      ctx.lineTo(x + pixel, center - lo * amplitude);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const px = x + (i / Math.max(1, count - 1)) * width,
        py = center - samples[start + i] * amplitude;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  if (count <= 256) {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      ctx.beginPath();
      ctx.arc(
        x + (i / Math.max(1, count - 1)) * width,
        center - samples[start + i] * amplitude,
        count <= 32 ? 2.6 : 1.5,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
}

/** Draw recorded engine samples. Theme tokens affect drawing only, never rendering. */
export function drawScope(canvas: HTMLCanvasElement, state: LabState) {
  const { result, peaks, cursor, span, viewStart, config, selected, blocks } =
    state;
  const { ctx, width, height } = canvasContext(canvas);
  if (!result) return;
  const colors = palette(canvas);
  const color = (id: Processor) =>
    id <= 20 ? colors.a : id <= 40 ? colors.b : colors.output;
  const left = scopeInsets.left,
    right = width - scopeInsets.right,
    plotWidth = right - left;
  const top = 32,
    laneHeight = (height - 54) / 3;
  ctx.font = `11px ${colors.mono}`;
  ctx.fillStyle = colors.muted;
  const tickCount = plotWidth < 500 ? 2 : 4;
  for (let tick = 0; tick <= tickCount; tick++) {
    const frame = viewStart + Math.round(((span - 1) * tick) / tickCount);
    ctx.textAlign =
      tick === 0 ? "left" : tick === tickCount ? "right" : "center";
    ctx.fillText(
      frame.toLocaleString(),
      left + (plotWidth * tick) / tickCount,
      17,
    );
  }
  ctx.textAlign = "left";
  ctx.fillText("sample", 6, 17);
  if (blocks && span / result.partition <= 80) {
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    for (
      let frame = Math.ceil(viewStart / result.partition) * result.partition;
      frame < viewStart + span;
      frame += result.partition
    ) {
      const x = left + ((frame - viewStart) / (span - 1)) * plotWidth;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, height - 15);
      ctx.stroke();
      if (span / result.partition < 12) {
        ctx.fillStyle = colors.muted;
        ctx.fillText(
          `b${Math.floor(frame / result.partition)}`,
          x + 3,
          height - 3,
        );
      }
    }
  }
  const ids: Processor[] = [
    selected === 10 ? 10 : 20,
    selected === 30 ? 30 : 40,
    70,
  ];
  const scale = Math.max(
    0.05,
    ...ids.map(
      (id) => peaks[result.operations.findIndex((op) => op.id === id)],
    ),
  );
  ids.forEach((id, lane) => {
    const samples = trace(result, id)!;
    const center = top + laneHeight * (lane + 0.5),
      amplitude = (laneHeight * 0.39) / scale;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(left, center);
    ctx.lineTo(right, center);
    ctx.stroke();
    ctx.fillStyle = color(id);
    ctx.fillText(lane === 0 ? "A" : lane === 1 ? "B" : "OUT", 10, center - 4);
    ctx.fillStyle = colors.muted;
    ctx.font = `10px ${colors.mono}`;
    ctx.fillText(`±${scale.toFixed(2)}`, 8, center + 12);
    ctx.font = `11px ${colors.mono}`;
    waveform(
      ctx,
      samples,
      viewStart,
      span,
      left,
      plotWidth,
      center,
      amplitude,
      color(id),
    );
    const x = left + ((cursor - viewStart) / (span - 1)) * plotWidth;
    if (x >= left && x <= right) {
      ctx.fillStyle = color(id);
      ctx.beginPath();
      ctx.arc(x, center - samples[cursor] * amplitude, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  for (const event of config.events) {
    const points = [
      { frame: event.frame, label: event.kind },
      ...(event.kind === "ramp" ? [{ frame: event.end, label: "end" }] : []),
    ];
    for (const point of points) {
      if (point.frame < viewStart || point.frame >= viewStart + span) continue;
      const x = left + ((point.frame - viewStart) / (span - 1)) * plotWidth;
      ctx.strokeStyle = color(event.processor);
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, height - 15);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label the selected event so coincident and nearby events remain legible.
      if (event.id === (state.selectedEvent ?? config.events[0]?.id)) {
        ctx.fillStyle = color(event.processor);
        ctx.fillText(
          point.label,
          Math.min(right - 32, x + 5),
          top + (event.processor === 20 ? 8 : laneHeight + 8),
        );
      }
    }
  }
  const x = left + ((cursor - viewStart) / (span - 1)) * plotWidth;
  if (x >= left && x <= right) {
    ctx.strokeStyle = colors.foreground;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, height - 15);
    ctx.stroke();
  }
}

export function drawOverview(canvas: HTMLCanvasElement, state: LabState) {
  const { ctx, width } = canvasContext(canvas);
  if (!state.result) return;
  const colors = palette(canvas),
    left = overviewInsets.left,
    right = width - overviewInsets.right,
    plotWidth = right - left;
  ctx.font = `10px ${colors.mono}`;
  ctx.fillStyle = colors.muted;
  const ticks = width < 500 ? 2 : 4;
  for (let tick = 0; tick <= ticks; tick++) {
    ctx.textAlign = tick === ticks ? "right" : "left";
    ctx.fillText(
      `${((2 * tick) / ticks).toFixed(1)} s`,
      left + (plotWidth * tick) / ticks,
      15,
    );
  }
  ctx.textAlign = "left";
  waveform(
    ctx,
    trace(state.result, 70)!,
    0,
    TOTAL_FRAMES,
    left,
    plotWidth,
    48,
    11,
    colors.output,
  );
  for (const [label, y, color] of [
    ["A", 94, colors.a],
    ["B", 134, colors.b],
  ] as const) {
    ctx.fillStyle = color;
    ctx.fillText(label, 12, y + 3);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  for (const event of state.config.events) {
    if (event.kind !== "ramp") continue;
    const y = event.processor === 20 ? 94 : 134;
    const x = left + (event.frame / (TOTAL_FRAMES - 1)) * plotWidth,
      end = left + (event.end / (TOTAL_FRAMES - 1)) * plotWidth;
    ctx.strokeStyle = event.processor === 20 ? colors.a : colors.b;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(end, y);
    ctx.moveTo(end, y - 5);
    ctx.lineTo(end, y + 5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

export function miniature(
  samples: Float32Array | undefined,
  peak: number,
  cursor: number,
) {
  if (!samples) return "";
  const count = 384,
    start = Math.min(cursor, TOTAL_FRAMES - count),
    scale = Math.max(0.05, peak);
  return Array.from(
    { length: count },
    (_, i) =>
      `${i ? "L" : "M"}${((i / (count - 1)) * 100).toFixed(1)},${(11 - (samples[start + i] * 9) / scale).toFixed(1)}`,
  ).join(" ");
}
