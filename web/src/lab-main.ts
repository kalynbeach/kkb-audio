import {
  lesson,
  levels,
  moveEvent,
  SAMPLE_RATE,
  TOTAL_FRAMES,
  windowStart,
  type LabConfig,
  type LabEvent,
  type LabResult,
  type Processor,
} from "./lab-model.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing lab element: ${id}`);
  return found as T;
}
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const text = (id: string, value: string) => {
  element(id).textContent = value;
};
const svgNS = "http://www.w3.org/2000/svg";
const colors = {
  a: "#70cadd",
  b: "#f1b38e",
  mix: "#dce8ac",
  grid: "#2d414e",
  muted: "#a4b4c1",
};
const names: Record<Processor, string> = {
  10: "Oscillator A",
  20: "Gain A",
  30: "Oscillator B",
  40: "Gain B",
  50: "Mix",
  60: "Observe",
  70: "Output",
};
const shortNames: Record<Processor, string> = {
  10: "Osc A",
  20: "Gain A",
  30: "Osc B",
  40: "Gain B",
  50: "Mix",
  60: "Observe",
  70: "Output",
};
const positions: Record<Processor, [number, number]> = {
  10: [100, 67],
  20: [310, 67],
  30: [100, 187],
  40: [310, 187],
  50: [520, 127],
  60: [720, 127],
  70: [910, 127],
};
const explanations: Record<Processor, string> = {
  10: "A sine oscillator starts at phase zero. Its frequency is fixed in this compiled plan. Changing it prepares a fresh render.",
  20: "Every sample from oscillator A is multiplied by this gain. Sets and ramps change the gain at exact render frames.",
  30: "A second, independent sine oscillator. Nearby frequencies drift in and out of phase when the signals are mixed.",
  40: "Gain B scales only oscillator B. A negative value inverts its polarity. Events address processor 40, parameter 1.",
  50: "Adds the two gained signals, sample by sample. There is no normalization or clipping inside the engine.",
  60: "Passes the mix through and measures peak and RMS over fixed 64-frame windows. It retains the latest completed window.",
  70: "Writes the final mono signal to the output plane. Playback replays these samples through a separate listening-volume control.",
};
let config: LabConfig = lesson(0);
let currentLesson = 0,
  selected: Processor = 50,
  selectedEvent: number | null = null;
let cursor = 0,
  span = 2048,
  viewStart = 0,
  nextEventId = 2;
let result: LabResult | null = null,
  revision = 0,
  renderTimer = 0,
  pending = true;
let worker: Worker | null = null;
let context: AudioContext | null = null,
  source: AudioBufferSourceNode | null = null,
  monitor: GainNode | null = null;
let playbackGeneration = 0,
  playing = false,
  starting = false,
  playbackStart = 0,
  playbackOffset = 0,
  animation = 0;
let activeConnection: string | null = null;
let tracePeaks: number[] = [];
const scope = element<HTMLCanvasElement>("scope"),
  overview = element<HTMLCanvasElement>("overview");

function trace(id: Processor): Float32Array | undefined {
  return result?.traces[result.operations.findIndex((op) => op.id === id)];
}
function valueAt(id: Processor): number {
  return trace(id)?.[cursor] ?? 0;
}
function sourceColor(id: Processor): string {
  return id <= 20 ? colors.a : id <= 40 ? colors.b : colors.mix;
}
function frequency(id: Processor): number {
  return id === 10 ? config.frequencyA : config.frequencyB;
}

function lessonText(): string {
  if (currentLesson === 0) {
    const difference = Math.abs(config.frequencyA - config.frequencyB);
    return difference === 0
      ? `${config.frequencyA} Hz + ${config.frequencyB} Hz. Both oscillators begin in phase. Separate them by a few hertz to hear slow beating.`
      : `${config.frequencyA} Hz + ${config.frequencyB} Hz. Their frequency difference is ${difference} Hz. Bring the frequencies closer to hear slow beating.`;
  }
  const event =
    config.events.find((e) => e.id === selectedEvent) ?? config.events[0];
  if (!event)
    return "Add a gain event at the cursor, then inspect its exact sample. The Rust engine applies events inside the render call.";
  if (currentLesson === 2 && event.kind === "ramp")
    return `Gain ${event.processor === 20 ? "A" : "B"} ramps from sample ${event.frame.toLocaleString()} to ${event.end.toLocaleString()} inclusive. Change the block size and compare all seven traces sample for sample.`;
  return `Gain ${event.processor === 20 ? "A" : "B"} ${event.kind === "set" ? "changes" : "starts a ramp"} at sample ${event.frame.toLocaleString()}, offset ${event.frame % config.partition} inside a ${config.partition}-frame call. Inspect the first affected sample.`;
}

function buildGraph(): void {
  if (!result) return;
  const nodes = element("nodes"),
    operations = element("operations"),
    connections = document.querySelector<SVGSVGElement>(".connections")!;
  nodes.replaceChildren();
  operations.replaceChildren();
  connections.replaceChildren();
  result.operations.forEach((op, index) => {
    const [x, y] = positions[op.id];
    const node = document.createElement("button");
    node.className = `node ${op.id <= 20 ? "source-a" : op.id <= 40 ? "source-b" : ""}`;
    node.dataset.node = String(op.id);
    node.style.left = `${x / 10}%`;
    node.style.top = `${(y / 254) * 100}%`;
    node.setAttribute(
      "aria-label",
      `Select ${names[op.id]}, processor ${op.id}`,
    );
    const label = document.createElement("span");
    label.className = "node-label";
    label.textContent = shortNames[op.id];
    const idLabel = document.createElement("span");
    idLabel.className = "node-id";
    idLabel.textContent = String(op.id);
    const value = document.createElement("span");
    value.className = "node-value";
    value.textContent =
      op.kind === 1
        ? `${op.value} Hz`
        : op.kind === 2
          ? `× ${op.value.toFixed(2)} initial`
          : op.kind === 4
            ? "64-frame windows"
            : op.kind === 5
              ? "mono · f32"
              : "A + B";
    const mini = document.createElementNS(svgNS, "svg");
    mini.setAttribute("viewBox", "0 0 100 22");
    mini.setAttribute("aria-hidden", "true");
    mini.append(document.createElementNS(svgNS, "path"));
    node.append(label, idLabel, value, mini);
    node.onclick = () => selectNode(op.id);
    nodes.append(node);
    const chip = document.createElement("button");
    chip.className = "operation";
    chip.dataset.node = String(op.id);
    const slot = document.createElement("span");
    slot.textContent = `${index + 1}`;
    chip.append(slot, shortNames[op.id]);
    chip.setAttribute(
      "aria-label",
      `Execution step ${index + 1}: ${names[op.id]}`,
    );
    chip.onclick = () => {
      selectNode(op.id);
      node.scrollIntoView({ block: "nearest", inline: "center" });
    };
    operations.append(chip);
    for (const inputSlot of op.inputs) {
      const from = result!.operations[inputSlot].id,
        [sx, sy] = positions[from];
      const path = document.createElementNS(svgNS, "path");
      const d = `M${sx + 75},${sy} C${sx + 125},${sy} ${x - 125},${y} ${x - 75},${y}`;
      path.setAttribute("d", d);
      path.setAttribute(
        "class",
        `connection ${from <= 20 ? "a" : from <= 40 ? "b" : ""}`,
      );
      path.dataset.connection = `${from}-${op.id}`;
      const hit = document.createElementNS(svgNS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "connection-hit");
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute(
        "aria-label",
        `Inspect connection from ${names[from]} to ${names[op.id]}`,
      );
      const choose = () => {
        selectNode(from);
        activeConnection = `${from}-${op.id}`;
        text("inspector-title", `${shortNames[from]} → ${shortNames[op.id]}`);
        text(
          "inspector-copy",
          `This connection carries the mono output of ${names[from].toLowerCase()} into ${names[op.id].toLowerCase()}. Its value at the cursor is the source sample shown below.`,
        );
        updateSelection();
      };
      hit.addEventListener("click", choose);
      hit.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
      connections.append(path, hit);
    }
  });
  selectNode(selected);
}

function updateSelection(): void {
  document
    .querySelectorAll<HTMLButtonElement>("[data-node]")
    .forEach((node) => {
      const active = Number(node.dataset.node) === selected;
      node.classList.toggle("selected", active);
      node.setAttribute("aria-pressed", String(active));
    });
  document
    .querySelectorAll<SVGPathElement>("[data-connection]")
    .forEach((path) =>
      path.classList.toggle(
        "selected",
        path.dataset.connection === activeConnection,
      ),
    );
}

function selectNode(id: Processor): void {
  selected = id;
  activeConnection = null;
  text("node-id", `PROCESSOR ${id}`);
  text("inspector-title", names[id]);
  text("inspector-copy", explanations[id]);
  element("node-dot").style.background = sourceColor(id);
  const detail =
    id === 10 || id === 30
      ? `${frequency(id)} cycles / second · phase begins at 0`
      : id === 20 || id === 40
        ? `Event address ${id}:1 · initial gain ${(id === 20 ? config.gainA : config.gainB).toFixed(2)} · ${config.events.filter((e) => e.processor === id).length} scheduled event(s)`
        : id === 50
          ? `Beat rate with these frequencies: ${Math.abs(config.frequencyA - config.frequencyB)} Hz. A and B are sources, not stereo channels.`
          : id === 60 && result?.observation.length
            ? `Latest engine window [${result.observation[0]}, ${result.observation[1]}). Peak ${result.observation[2].toFixed(4)}, RMS ${result.observation[3].toFixed(4)}. ${result.observation[5]} overwritten windows.`
            : "Engine samples are unchanged by listening volume. The replay cursor estimates position using the Web Audio clock.";
  text("node-detail", detail);
  updateSelection();
  draw();
}

function syncControls(): void {
  for (const [suffix, hz, gain] of [
    ["a", config.frequencyA, config.gainA],
    ["b", config.frequencyB, config.gainB],
  ] as const) {
    input(`frequency-${suffix}`).value = String(hz);
    input(`frequency-${suffix}-number`).value = String(hz);
    input(`gain-${suffix}`).value = String(gain);
    text(`gain-${suffix}-value`, gain.toFixed(2));
  }
  element<HTMLSelectElement>("partition").value = String(config.partition);
  element<HTMLSelectElement>("zoom").value = String(span);
  text("lesson-copy", lessonText());
  text(
    "lesson-action",
    currentLesson === 0
      ? "Show the beat envelope ↗"
      : currentLesson === 1
        ? "Inspect the gain change ↗"
        : "Compare the samples ↗",
  );
  document.querySelectorAll<HTMLButtonElement>("[data-lesson]").forEach((b) => {
    const active = Number(b.dataset.lesson) === currentLesson;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  renderEvents();
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./lab-worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (
    message: MessageEvent<
      | { type: "rendered"; result: LabResult }
      | { type: "failed"; request: number; message: string }
    >,
  ) => {
    const data = message.data;
    if (
      (data.type === "rendered" ? data.result.request : data.request) !==
      revision
    )
      return;
    if (data.type === "failed") {
      worker?.terminate();
      worker = null;
      fail(data.message);
      return;
    }
    result = data.result;
    tracePeaks = result.traces.map(
      (samples) => levels(samples, 0, samples.length).peak,
    );
    pending = false;
    document.body.classList.remove("pending");
    element("scope-empty").style.display = "none";
    text("status", "Rust / Wasm · ready");
    button("play").disabled = false;
    button("compare").disabled = false;
    text(
      "render-evidence",
      `96,000 frames · ${result.partition}-frame calls · ${result.renderMs.toFixed(0)} ms offline render`,
    );
    text(
      "comparison",
      result.comparison === null
        ? "Compare a second render using a different block size."
        : result.comparison === 0
          ? `Exact match · 672,000 node samples · ${result.partition} vs ${result.partition === 128 ? 257 : 128} frames/call`
          : `Maximum sample difference: ${result.comparison}`,
    );
    buildGraph();
    draw();
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    fail("The render worker failed. Reset the experiment to retry.");
  };
  return worker;
}

function fail(message: string): void {
  pending = true;
  text("status", "Render failed");
  text("scope-empty", message);
  element("scope-empty").style.display = "grid";
  button("play").disabled = true;
  button("compare").disabled = false;
}
function requestRender(compare = false, immediate = false): void {
  stopPlayback();
  revision++;
  pending = true;
  document.body.classList.add("pending");
  text("status", "Rendering a fresh plan…");
  text(
    "comparison",
    compare
      ? "Rendering both partitions…"
      : "Settings changed · render pending…",
  );
  button("play").disabled = true;
  button("compare").disabled = true;
  window.clearTimeout(renderTimer);
  const request = revision;
  renderTimer = window.setTimeout(
    () =>
      getWorker().postMessage({
        request,
        config: structuredClone(config),
        compare,
      }),
    immediate ? 0 : 110,
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

function draw(): void {
  if (!result) return;
  text("lesson-copy", lessonText());
  const { ctx, width, height } = canvasContext(scope),
    left = 62,
    right = width - 18,
    plotWidth = right - left;
  const top = 29,
    laneHeight = (height - 50) / 3;
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = colors.muted;
  const tickCount = plotWidth < 500 ? 2 : 4;
  for (let tick = 0; tick <= tickCount; tick++) {
    const frame = viewStart + Math.round(((span - 1) * tick) / tickCount),
      x = left + (plotWidth * tick) / tickCount;
    ctx.textAlign =
      tick === 0 ? "left" : tick === tickCount ? "right" : "center";
    ctx.fillText(frame.toLocaleString(), x, 16);
  }
  ctx.textAlign = "left";
  ctx.fillText("sample", 6, 16);
  if (input("show-blocks").checked && span / result.partition <= 80) {
    ctx.strokeStyle = "#516475";
    ctx.lineWidth = 0.7;
    for (
      let frame = Math.ceil(viewStart / result.partition) * result.partition;
      frame < viewStart + span;
      frame += result.partition
    ) {
      const x = left + ((frame - viewStart) / (span - 1)) * plotWidth;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, height - 13);
      ctx.stroke();
      if (span / result.partition < 12) {
        ctx.fillStyle = "#738a9b";
        ctx.fillText(
          `b${Math.floor(frame / result.partition)}`,
          x + 3,
          height - 4,
        );
      }
    }
  }
  const ids: Processor[] = [
    selected === 10 ? 10 : 20,
    selected === 30 ? 30 : 40,
    70,
  ];
  const commonScale = Math.max(
    0.05,
    ...ids.map(
      (id) => tracePeaks[result!.operations.findIndex((op) => op.id === id)],
    ),
  );
  ids.forEach((id, lane) => {
    const center = top + laneHeight * (lane + 0.5),
      amplitude = (laneHeight * 0.39) / commonScale;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(left, center);
    ctx.lineTo(right, center);
    ctx.stroke();
    ctx.fillStyle = sourceColor(id);
    ctx.fillText(lane === 0 ? "A" : lane === 1 ? "B" : "OUT", 10, center - 4);
    ctx.fillStyle = colors.muted;
    ctx.font = "8px ui-monospace, monospace";
    ctx.fillText(`±${commonScale.toFixed(2)}`, 10, center + 10);
    ctx.font = "10px ui-monospace, monospace";
    waveform(
      ctx,
      trace(id)!,
      viewStart,
      span,
      left,
      plotWidth,
      center,
      amplitude,
      sourceColor(id),
    );
    const cx = left + ((cursor - viewStart) / (span - 1)) * plotWidth;
    if (cx >= left && cx <= right) {
      ctx.fillStyle = sourceColor(id);
      ctx.beginPath();
      ctx.arc(cx, center - valueAt(id) * amplitude, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  for (const event of config.events) {
    for (const [frame, end] of [
      [event.frame, false],
      ...(event.kind === "ramp" ? [[event.end, true] as const] : []),
    ] as const) {
      if (frame < viewStart || frame >= viewStart + span) continue;
      const x = left + ((frame - viewStart) / (span - 1)) * plotWidth;
      ctx.strokeStyle = sourceColor(event.processor);
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, height - 13);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = sourceColor(event.processor);
      ctx.fillText(
        end ? "end" : event.kind,
        Math.min(right - 25, x + 5),
        top + (event.processor === 20 ? 8 : laneHeight + 8),
      );
    }
  }
  const cursorX = left + ((cursor - viewStart) / (span - 1)) * plotWidth;
  if (cursorX >= left && cursorX <= right) {
    ctx.strokeStyle = "#edf3f7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cursorX, top);
    ctx.lineTo(cursorX, height - 13);
    ctx.stroke();
  }
  text("trace-a-label", selected === 10 ? "A raw oscillator" : "A after gain");
  text("trace-b-label", selected === 30 ? "B raw oscillator" : "B after gain");
  text("sample-a", valueAt(ids[0]).toFixed(4));
  text("sample-b", valueAt(ids[1]).toFixed(4));
  text("sample-mix", valueAt(70).toFixed(4));
  text("node-sample", valueAt(selected).toFixed(6));
  text("node-frame", `sample ${cursor.toLocaleString()}`);
  if (document.activeElement !== input("cursor-number"))
    input("cursor-number").value = String(cursor);
  text("cursor-time", `${((cursor / SAMPLE_RATE) * 1000).toFixed(3)} ms`);
  scope.setAttribute("aria-valuenow", String(cursor));
  scope.setAttribute(
    "aria-valuetext",
    `Sample ${cursor}, output ${valueAt(70).toFixed(6)}`,
  );
  const start = Math.floor(cursor / 64) * 64,
    meter = levels(trace(70)!, start, Math.min(TOTAL_FRAMES, start + 64));
  text(
    "peak",
    meter.peak ? `${(20 * Math.log10(meter.peak)).toFixed(1)} dBFS` : "−∞ dBFS",
  );
  text(
    "rms",
    `Offline RMS ${meter.rms.toFixed(4)} · [${start}, ${Math.min(TOTAL_FRAMES, start + 64)})`,
  );
  element("peak-fill").style.width = `${Math.min(1, meter.peak) * 100}%`;
  element("peak-fill").style.background =
    meter.peak > 1 ? colors.b : colors.mix;
  document.querySelectorAll<HTMLButtonElement>(".node").forEach((node) => {
    const id = Number(node.dataset.node) as Processor,
      samples = trace(id)!;
    const count = 384,
      start = Math.min(cursor, TOTAL_FRAMES - count);
    const scale = Math.max(
      0.05,
      tracePeaks[result!.operations.findIndex((op) => op.id === id)],
    );
    const path = Array.from(
      { length: count },
      (_, i) =>
        `${i === 0 ? "M" : "L"}${((i / (count - 1)) * 100).toFixed(1)},${(11 - (samples[start + i] * 9) / scale).toFixed(1)}`,
    ).join(" ");
    node.querySelector("path")!.setAttribute("d", path);
  });
  drawOverview();
}

function drawOverview(): void {
  if (!result) return;
  const { ctx, width } = canvasContext(overview),
    left = 36,
    plotWidth = width - 52;
  ctx.font = "9px ui-monospace, monospace";
  ctx.fillStyle = colors.muted;
  for (let tick = 0; tick <= 4; tick++) {
    const x = left + (plotWidth * tick) / 4;
    ctx.fillText(`${(tick * 0.5).toFixed(1)} s`, Math.min(width - 29, x), 13);
  }
  waveform(
    ctx,
    trace(70)!,
    0,
    TOTAL_FRAMES,
    left,
    plotWidth,
    45,
    21 / 2,
    colors.mix,
  );
  for (const [label, y, color] of [
    ["A", 89, colors.a],
    ["B", 117, colors.b],
  ] as const) {
    ctx.fillStyle = color;
    ctx.fillText(label, 12, y + 3);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - 16, y);
    ctx.stroke();
  }
  config.events
    .filter((e) => e.kind === "ramp")
    .forEach((e) => {
      const y = e.processor === 20 ? 89 : 117;
      const x = left + (e.frame / (TOTAL_FRAMES - 1)) * plotWidth,
        end = left + (e.end / (TOTAL_FRAMES - 1)) * plotWidth;
      ctx.strokeStyle = sourceColor(e.processor);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(end, y);
      ctx.moveTo(end, y - 5);
      ctx.lineTo(end, y + 5);
      ctx.stroke();
      ctx.lineWidth = 1;
    });
  element("timeline-cursor").style.left =
    `${left + (cursor / (TOTAL_FRAMES - 1)) * plotWidth}px`;
  element("view-window").style.left =
    `${left + (viewStart / TOTAL_FRAMES) * plotWidth}px`;
  element("view-window").style.width =
    `${Math.max(2, (span / TOTAL_FRAMES) * plotWidth)}px`;
  document
    .querySelectorAll<HTMLButtonElement>(".event-marker")
    .forEach((marker) => {
      const e = config.events.find(
        (event) => event.id === Number(marker.dataset.id),
      );
      if (e)
        marker.style.left = `${left + (e.frame / (TOTAL_FRAMES - 1)) * plotWidth}px`;
    });
}

function setCursor(frame: number, recenter = true): void {
  cursor = Math.max(0, Math.min(TOTAL_FRAMES - 1, Math.round(frame)));
  if (recenter) viewStart = windowStart(cursor, span);
  draw();
}
function pointerFrame(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  whole = false,
): number {
  const rect = canvas.getBoundingClientRect(),
    left = whole ? 36 : 62,
    width = rect.width - left - (whole ? 16 : 18);
  return Math.round(
    (whole ? 0 : viewStart) +
      Math.max(0, Math.min(1, (event.clientX - rect.left - left) / width)) *
        ((whole ? TOTAL_FRAMES : span) - 1),
  );
}

function renderEvents(): void {
  const markers = element("event-markers");
  markers.replaceChildren();
  for (const event of config.events) {
    const marker = document.createElement("button");
    marker.className = `event-marker ${event.processor === 40 ? "b" : ""} ${event.id === selectedEvent ? "selected" : ""}`;
    marker.dataset.id = String(event.id);
    marker.textContent = `${event.kind === "set" ? "◆" : "↗"} ${event.frame.toLocaleString()}`;
    marker.setAttribute(
      "aria-label",
      `${event.kind} gain ${event.processor === 20 ? "A" : "B"} at sample ${event.frame}. Arrow keys move one sample; Shift moves 128.`,
    );
    marker.onclick = (e) => selectEvent(event.id, e.detail === 0);
    marker.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      stopPlayback();
      revision++;
      window.clearTimeout(renderTimer);
      selectedEvent = event.id;
      selectNode(event.processor);
      updateEventEditor();
      marker.classList.add("selected");
      marker.setPointerCapture(e.pointerId);
      pending = true;
      document.body.classList.add("pending");
      button("play").disabled = true;
      text("status", "Move event · release to render");
    };
    marker.onpointermove = (e) => {
      if (!marker.hasPointerCapture(e.pointerId)) return;
      config.events = config.events.map((item) =>
        item.id === event.id
          ? moveEvent(item, pointerFrame(e, overview, true))
          : item,
      );
      const moved = config.events.find((item) => item.id === event.id)!;
      marker.textContent = `${moved.kind === "set" ? "◆" : "↗"} ${moved.frame.toLocaleString()}`;
      setCursor(moved.frame);
      updateEventEditor();
    };
    marker.onpointerup = (e) => {
      if (marker.hasPointerCapture(e.pointerId)) {
        marker.releasePointerCapture(e.pointerId);
        requestRender();
        renderEvents();
      }
    };
    marker.onpointercancel = () => {
      requestRender();
      renderEvents();
    };
    marker.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const current = config.events.find((item) => item.id === event.id)!;
      const frame =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? TOTAL_FRAMES - 1
            : current.frame +
              (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 128 : 1);
      config.events = config.events.map((item) =>
        item.id === event.id ? moveEvent(item, frame) : item,
      );
      selectedEvent = event.id;
      setCursor(config.events.find((item) => item.id === event.id)!.frame);
      requestRender();
      renderEvents();
      document
        .querySelector<HTMLButtonElement>(
          `.event-marker[data-id="${event.id}"]`,
        )
        ?.focus();
    };
    markers.append(marker);
  }
  button("add-set").disabled = config.events.length >= 16;
  button("add-ramp").disabled = config.events.length >= 16;
  const choices = element<HTMLSelectElement>("event-choice");
  choices.replaceChildren();
  config.events.forEach((e, i) => {
    const option = document.createElement("option");
    option.value = String(e.id);
    option.textContent = `${i + 1} · ${e.processor === 20 ? "A" : "B"} ${e.kind} @ ${e.frame}`;
    choices.append(option);
  });
  choices.value = String(selectedEvent);
  updateEventEditor();
  drawOverview();
}

function selectEvent(id: number, focusMarker = false): void {
  stopPlayback();
  selectedEvent = id;
  const event = config.events.find((e) => e.id === id)!;
  selectNode(event.processor);
  setCursor(event.frame);
  renderEvents();
  if (focusMarker)
    document
      .querySelector<HTMLButtonElement>(`.event-marker[data-id="${id}"]`)
      ?.focus();
}
function updateEventEditor(): void {
  const event = config.events.find((e) => e.id === selectedEvent);
  element("event-editor").hidden = !event;
  if (!event) {
    text(
      "event-help",
      "Add an event at the cursor. Select source A or B in the graph to choose its target. Maximum 16 events.",
    );
    return;
  }
  text(
    "event-title",
    `${event.kind === "set" ? "Set" : "Ramp"} gain ${event.processor === 20 ? "A" : "B"}`,
  );
  element<HTMLSelectElement>("event-source").value = String(event.processor);
  input("event-frame").value = String(event.frame);
  input("event-value").value = String(event.value);
  input("event-end").value = String(event.end);
  element("end-label").hidden = event.kind !== "ramp";
  text(
    "event-help",
    event.kind === "set"
      ? `Applied before sample ${event.frame.toLocaleString()}. This is offset ${event.frame % config.partition} inside block ${Math.floor(event.frame / config.partition)}. Same-frame events follow insertion order.`
      : `Starts at ${event.frame.toLocaleString()}, reaches ${event.value.toFixed(2)} at ${event.end.toLocaleString()} inclusive. Duration ${event.end - event.frame} sample intervals. Same-frame events follow insertion order.`,
  );
}

function addEvent(kind: "set" | "ramp"): void {
  if (config.events.length >= 16) return;
  const frame = Math.min(
    cursor,
    kind === "ramp" ? TOTAL_FRAMES - 513 : TOTAL_FRAMES - 1,
  );
  const event: LabEvent = {
    id: nextEventId++,
    processor: selected === 30 || selected === 40 ? 40 : 20,
    frame,
    kind,
    value: 0.1,
    end: kind === "ramp" ? frame + 512 : 0,
  };
  config.events.push(event);
  selectedEvent = event.id;
  selectNode(event.processor);
  renderEvents();
  requestRender();
}

function stopPlayback(): void {
  playbackGeneration++;
  playing = false;
  starting = false;
  cancelAnimationFrame(animation);
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* Already ended. */
    }
    source.disconnect();
    source = null;
  }
  monitor?.disconnect();
  monitor = null;
  if (context?.state === "running") void context.suspend().catch(() => {});
  button("play").disabled = pending || !result;
  button("stop").disabled = true;
  text("playback-status", "Offline engine replay");
  text("playback-clock", "Audio starts when you press play");
}

async function play(): Promise<void> {
  if (pending || !result || playing || starting) return;
  starting = true;
  const generation = ++playbackGeneration;
  button("play").disabled = true;
  button("stop").disabled = false;
  try {
    context ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.resume();
    if (generation !== playbackGeneration) return;
    const buffer = context.createBuffer(1, TOTAL_FRAMES, SAMPLE_RATE);
    buffer.copyToChannel(Float32Array.from(trace(70)!), 0);
    source = context.createBufferSource();
    source.buffer = buffer;
    monitor = context.createGain();
    monitor.gain.value = input("mute").checked
      ? 0
      : Number(input("volume").value) / 100;
    source.connect(monitor).connect(context.destination);
    playbackOffset = cursor >= TOTAL_FRAMES - 1 ? 0 : cursor;
    playbackStart = context.currentTime;
    source.onended = () => {
      if (generation === playbackGeneration) {
        stopPlayback();
        setCursor(TOTAL_FRAMES - 1);
        text(
          "playback-clock",
          "Replay complete · play again from the beginning",
        );
      }
    };
    source.start(0, playbackOffset / SAMPLE_RATE);
    starting = false;
    playing = true;
    text(
      "playback-status",
      input("mute").checked ? "Replaying · muted" : "Replaying engine output",
    );
    let last = 0;
    const tick = (now: number) => {
      if (!playing || !context) return;
      if (now - last >= 32) {
        const frame = Math.min(
          TOTAL_FRAMES - 1,
          playbackOffset +
            Math.floor((context.currentTime - playbackStart) * SAMPLE_RATE),
        );
        cursor = frame;
        if (cursor >= viewStart + span || cursor < viewStart)
          viewStart = windowStart(cursor, span);
        draw();
        text(
          "playback-clock",
          `${(cursor / SAMPLE_RATE).toFixed(3)} / 2.000 s · estimated replay cursor`,
        );
        last = now;
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  } catch (error) {
    stopPlayback();
    text(
      "playback-clock",
      `Playback unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

document
  .querySelectorAll<HTMLButtonElement>("[data-lesson]")
  .forEach((b) => (b.onclick = () => loadLesson(Number(b.dataset.lesson))));
function loadLesson(index: number): void {
  currentLesson = index;
  config = lesson(index);
  selected = index ? 20 : 50;
  selectedEvent = config.events[0]?.id ?? null;
  cursor = config.events[0]?.frame ?? 0;
  span = index === 0 ? 12000 : 2048;
  viewStart = windowStart(cursor, span);
  nextEventId = 2;
  syncControls();
  requestRender(false, true);
}
button("reset").onclick = () => loadLesson(currentLesson);
button("lesson-action").onclick = () => {
  if (currentLesson === 0) {
    span = 96000;
    viewStart = 0;
    element<HTMLSelectElement>("zoom").value = String(span);
    draw();
  } else if (currentLesson === 1) {
    span = 256;
    element<HTMLSelectElement>("zoom").value = String(span);
    const event =
      config.events.find((e) => e.id === selectedEvent) ?? config.events[0];
    setCursor(event?.frame ?? cursor);
  } else {
    requestRender(true, true);
    element("comparison").scrollIntoView({ block: "center" });
    element("comparison").focus({ preventScroll: true });
    return;
  }
  element("scope-title").scrollIntoView({ block: "start" });
  scope.focus({ preventScroll: true });
};
for (const suffix of ["a", "b"] as const) {
  for (const id of [`frequency-${suffix}`, `frequency-${suffix}-number`])
    input(id).addEventListener(
      id.endsWith("number") ? "change" : "input",
      () => {
        const value = Number(input(id).value);
        if (!Number.isFinite(value)) return;
        const next = Math.max(20, Math.min(2000, Math.round(value)));
        config[suffix === "a" ? "frequencyA" : "frequencyB"] = next;
        input(`frequency-${suffix}`).max = "2000";
        input(`frequency-${suffix}`).min = "20";
        syncControls();
        requestRender();
      },
    );
  input(`gain-${suffix}`).oninput = () => {
    config[suffix === "a" ? "gainA" : "gainB"] = Number(
      input(`gain-${suffix}`).value,
    );
    text(
      `gain-${suffix}-value`,
      Number(input(`gain-${suffix}`).value).toFixed(2),
    );
    requestRender();
  };
}
element<HTMLSelectElement>("zoom").onchange = (e) => {
  span = Number((e.target as HTMLSelectElement).value);
  viewStart = windowStart(cursor, span);
  draw();
};
input("show-blocks").onchange = draw;
element<HTMLSelectElement>("partition").onchange = (e) => {
  config.partition = Number((e.target as HTMLSelectElement).value);
  updateEventEditor();
  requestRender();
};
button("compare").onclick = () => requestRender(true, true);
for (const canvas of [scope, overview]) {
  canvas.onpointerdown = (e) => {
    stopPlayback();
    canvas.setPointerCapture(e.pointerId);
    setCursor(
      pointerFrame(e, canvas, canvas === overview),
      canvas === overview,
    );
  };
  canvas.onpointermove = (e) => {
    if (canvas.hasPointerCapture(e.pointerId))
      setCursor(
        pointerFrame(e, canvas, canvas === overview),
        canvas === overview,
      );
  };
  canvas.onpointerup = (e) => {
    if (canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
  };
}
scope.onkeydown = (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    stopPlayback();
    setCursor(
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? TOTAL_FRAMES - 1
          : cursor +
            (e.key === "ArrowLeft" ? -1 : 1) *
              (e.shiftKey ? config.partition : 1),
    );
  }
};
input("cursor-number").onchange = () => {
  const value = Number(input("cursor-number").value);
  if (Number.isFinite(value)) {
    stopPlayback();
    setCursor(value);
    input("cursor-number").value = String(cursor);
  }
};
button("previous-sample").onclick = () => {
  stopPlayback();
  setCursor(cursor - 1);
};
button("next-sample").onclick = () => {
  stopPlayback();
  setCursor(cursor + 1);
};
document
  .querySelectorAll<HTMLButtonElement>("[data-select]")
  .forEach(
    (b) =>
      (b.onclick = () => selectNode(Number(b.dataset.select) as Processor)),
  );
button("add-set").onclick = () => addEvent("set");
button("add-ramp").onclick = () => addEvent("ramp");
element<HTMLSelectElement>("event-choice").onchange = (e) =>
  selectEvent(Number((e.target as HTMLSelectElement).value));
button("delete-event").onclick = () => {
  config.events = config.events.filter((e) => e.id !== selectedEvent);
  selectedEvent = null;
  renderEvents();
  requestRender();
};
button("inspect-event").onclick = () => {
  const event = config.events.find((e) => e.id === selectedEvent);
  if (event) {
    stopPlayback();
    span = 32;
    element<HTMLSelectElement>("zoom").value = String(span);
    setCursor(event.frame);
    element("scope-title").scrollIntoView({ block: "start" });
    scope.focus({ preventScroll: true });
  }
};
for (const id of ["event-source", "event-frame", "event-value", "event-end"])
  element(id).onchange = () => {
    const event = config.events.find((e) => e.id === selectedEvent);
    if (!event) return;
    const frame = Number(input("event-frame").value),
      value = Number(input("event-value").value),
      end = Number(input("event-end").value);
    if (![frame, value, end].every(Number.isFinite)) {
      updateEventEditor();
      return;
    }
    let next = moveEvent(event, frame);
    next.processor =
      Number(element<HTMLSelectElement>("event-source").value) === 40 ? 40 : 20;
    next.value = Math.max(-1, Math.min(1, value));
    if (next.kind === "ramp" && id === "event-end")
      next.end = Math.max(
        next.frame + 1,
        Math.min(TOTAL_FRAMES - 1, Math.round(end)),
      );
    config.events = config.events.map((e) => (e.id === next.id ? next : e));
    selectNode(next.processor);
    renderEvents();
    setCursor(next.frame);
    requestRender();
  };
button("play").onclick = () => {
  void play();
};
button("stop").onclick = stopPlayback;
function updateMonitor(): void {
  const volume = Number(input("volume").value) / 100;
  text("volume-value", `${Math.round(volume * 100)}%`);
  if (monitor && context)
    monitor.gain.setTargetAtTime(
      input("mute").checked ? 0 : volume,
      context.currentTime,
      0.01,
    );
  if (playing)
    text(
      "playback-status",
      input("mute").checked ? "Replaying · muted" : "Replaying engine output",
    );
}
input("volume").oninput = updateMonitor;
input("mute").onchange = updateMonitor;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
});
window.addEventListener("pagehide", () => {
  stopPlayback();
  revision++;
  window.clearTimeout(renderTimer);
  worker?.terminate();
  worker = null;
  const closing = context;
  context = null;
  void closing?.close().catch(() => {});
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) requestRender(false, true);
});
new ResizeObserver(() => draw()).observe(element("scope"));
syncControls();
requestRender(false, true);
