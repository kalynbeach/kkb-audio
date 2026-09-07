import { useEffect, useRef, useState } from "react";
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

export interface LabState {
  config: LabConfig;
  lesson: number;
  selected: Processor;
  connection: { from: Processor; to: Processor } | null;
  selectedEvent: number | null;
  cursor: number;
  span: number;
  viewStart: number;
  blocks: boolean;
  result: LabResult | null;
  peaks: number[];
  renderStatus: "pending" | "dragging" | "ready" | "failed";
  renderError: string | null;
  comparing: boolean;
  playback: "stopped" | "starting" | "playing";
  playbackNote: string;
  volume: number;
  muted: boolean;
}

interface Runtime {
  active: boolean;
  revision: number;
  timer: number | undefined;
  worker: Worker | null;
  context: AudioContext | null;
  source: AudioBufferSourceNode | null;
  monitor: GainNode | null;
  generation: number;
  animation: number;
  nextEvent: number;
}

function initialState(): LabState {
  return {
    config: lesson(0),
    lesson: 0,
    selected: 50,
    connection: null,
    selectedEvent: null,
    cursor: 0,
    span: 12000,
    viewStart: 0,
    blocks: true,
    result: null,
    peaks: [],
    renderStatus: "pending",
    renderError: null,
    comparing: false,
    playback: "stopped",
    playbackNote: "Audio starts when you press play",
    volume: 15,
    muted: false,
  };
}

export function trace(result: LabResult | null, id: Processor) {
  return result?.traces[
    result.operations.findIndex((operation) => operation.id === id)
  ];
}

/** React owns the view. Refs own resources and invalidate work before an edit commits. */
export function useLab() {
  const [state, setState] = useState(initialState);
  const current = useRef(state);
  const resources = useRef<Runtime>({
    active: false,
    revision: 0,
    timer: undefined,
    worker: null,
    context: null,
    source: null,
    monitor: null,
    generation: 0,
    animation: 0,
    nextEvent: 2,
  });

  function update(patch: Partial<LabState>) {
    current.current = { ...current.current, ...patch };
    if (resources.current.active) setState(current.current);
  }

  function stop() {
    const runtime = resources.current;
    runtime.generation++;
    cancelAnimationFrame(runtime.animation);
    if (runtime.source) {
      runtime.source.onended = null;
      try {
        runtime.source.stop();
      } catch {
        /* Already ended. */
      }
      runtime.source.disconnect();
      runtime.source = null;
    }
    runtime.monitor?.disconnect();
    runtime.monitor = null;
    if (runtime.context?.state === "running")
      void runtime.context.suspend().catch(() => {});
    update({
      playback: "stopped",
      playbackNote: "Audio starts when you press play",
    });
  }

  function invalidate() {
    const runtime = resources.current;
    runtime.revision++;
    window.clearTimeout(runtime.timer);
  }

  function fail(message: string) {
    const runtime = resources.current;
    runtime.worker?.terminate();
    runtime.worker = null;
    update({ renderStatus: "failed", renderError: message, comparing: false });
  }

  function getWorker() {
    const runtime = resources.current;
    if (runtime.worker) return runtime.worker;
    const worker = new Worker(new URL("/lab-worker.js", window.location.href), {
      type: "module",
    });
    runtime.worker = worker;
    worker.onmessage = (
      event: MessageEvent<
        | { type: "rendered"; result: LabResult }
        | { type: "failed"; request: number; message: string }
      >,
    ) => {
      const data = event.data;
      const request =
        data.type === "rendered" ? data.result.request : data.request;
      if (
        !runtime.active ||
        runtime.worker !== worker ||
        request !== runtime.revision
      )
        return;
      if (data.type === "failed") return fail(data.message);
      update({
        result: data.result,
        peaks: data.result.traces.map(
          (samples) => levels(samples, 0, samples.length).peak,
        ),
        renderStatus: "ready",
        renderError: null,
        comparing: false,
      });
    };
    worker.onerror = () => {
      if (runtime.active && runtime.worker === worker)
        fail("The render worker failed. Reset the experiment to retry.");
    };
    return worker;
  }

  function render(config: LabConfig, compare = false, immediate = false) {
    stop();
    invalidate();
    update({
      config,
      renderStatus: "pending",
      renderError: null,
      comparing: compare,
    });
    const runtime = resources.current;
    const request = runtime.revision;
    // Capture the exact configuration associated with this revision, not a later React render.
    runtime.timer = window.setTimeout(
      () => {
        if (!runtime.active || request !== runtime.revision) return;
        try {
          getWorker().postMessage({ request, config, compare });
        } catch {
          fail(
            "The render worker could not start. Reset the experiment to retry.",
          );
        }
      },
      immediate ? 0 : 110,
    );
  }

  function position(frame: number, recenter = true) {
    const cursor = Math.max(0, Math.min(TOTAL_FRAMES - 1, Math.round(frame)));
    if (!Number.isFinite(cursor)) return;
    update({
      cursor,
      ...(recenter
        ? { viewStart: windowStart(cursor, current.current.span) }
        : {}),
    });
  }

  function scrub(frame: number, recenter = true) {
    stop();
    position(frame, recenter);
  }

  function selectNode(selected: Processor) {
    update({ selected, connection: null });
  }

  function selectEvent(id: number) {
    const event = current.current.config.events.find((item) => item.id === id);
    if (!event) return;
    stop();
    update({ selectedEvent: id, selected: event.processor, connection: null });
    position(event.frame);
  }

  function loadLesson(index: number) {
    const config = lesson(index);
    const cursor = config.events[0]?.frame ?? 0;
    const span = index === 0 ? 12000 : 2048;
    resources.current.nextEvent = 2;
    update({
      lesson: index,
      selected: index ? 20 : 50,
      connection: null,
      selectedEvent: config.events[0]?.id ?? null,
      cursor,
      span,
      viewStart: windowStart(cursor, span),
    });
    render(config, false, true);
  }

  function setSource(
    key: "frequencyA" | "frequencyB" | "gainA" | "gainB",
    value: number,
  ) {
    if (!Number.isFinite(value)) return;
    const next = key.startsWith("frequency")
      ? Math.max(20, Math.min(2000, Math.round(value)))
      : Math.max(-1, Math.min(1, value));
    render({ ...current.current.config, [key]: next });
  }

  function setSpan(span: number) {
    update({ span, viewStart: windowStart(current.current.cursor, span) });
  }

  function editEvent(
    id: number,
    key: "frame" | "end" | "value" | "processor",
    value: number,
  ) {
    if (!Number.isFinite(value)) return;
    const config = current.current.config;
    const event = config.events.find((item) => item.id === id);
    if (!event) return;
    let next = { ...event };
    if (key === "frame") next = moveEvent(event, value);
    if (key === "value") next.value = Math.max(-1, Math.min(1, value));
    if (key === "processor") next.processor = value === 40 ? 40 : 20;
    if (key === "end" && next.kind === "ramp")
      next.end = Math.max(
        next.frame + 1,
        Math.min(TOTAL_FRAMES - 1, Math.round(value)),
      );
    update({ selected: next.processor, connection: null });
    position(next.frame);
    render({
      ...config,
      events: config.events.map((item) => (item.id === id ? next : item)),
    });
  }

  function addEvent(kind: LabEvent["kind"]) {
    const { config, selected, cursor } = current.current;
    if (config.events.length >= 16) return;
    const frame = Math.min(
      cursor,
      kind === "ramp" ? TOTAL_FRAMES - 513 : TOTAL_FRAMES - 1,
    );
    const event: LabEvent = {
      id: resources.current.nextEvent++,
      processor: selected === 30 || selected === 40 ? 40 : 20,
      frame,
      kind,
      value: 0.1,
      end: kind === "ramp" ? frame + 512 : 0,
    };
    update({
      selectedEvent: event.id,
      selected: event.processor,
      connection: null,
    });
    position(frame);
    render({ ...config, events: [...config.events, event] });
  }

  function beginDrag(id: number) {
    selectEvent(id);
    invalidate();
    update({ renderStatus: "dragging", comparing: false });
  }

  function moveMarker(id: number, frame: number, dragging = false) {
    const config = current.current.config;
    const event = config.events.find((item) => item.id === id);
    if (!event) return;
    const next = moveEvent(event, frame);
    const updated = {
      ...config,
      events: config.events.map((item) => (item.id === id ? next : item)),
    };
    update({ selectedEvent: id, selected: next.processor, connection: null });
    position(next.frame);
    if (dragging) update({ config: updated });
    else render(updated);
  }

  async function play() {
    const snapshot = current.current;
    const runtime = resources.current;
    const samples = trace(snapshot.result, 70);
    if (
      snapshot.renderStatus !== "ready" ||
      !samples ||
      snapshot.playback !== "stopped"
    )
      return;
    const generation = ++runtime.generation;
    update({ playback: "starting", playbackNote: "Starting audio replay…" });
    try {
      const context = (runtime.context ??= new AudioContext({
        sampleRate: SAMPLE_RATE,
      }));
      await context.resume();
      if (
        !runtime.active ||
        generation !== runtime.generation ||
        context !== runtime.context
      ) {
        if (
          context === runtime.context &&
          current.current.playback === "stopped"
        )
          void context.suspend().catch(() => {});
        return;
      }
      const buffer = context.createBuffer(1, TOTAL_FRAMES, SAMPLE_RATE);
      buffer.copyToChannel(Float32Array.from(samples), 0);
      const source = context.createBufferSource();
      const monitor = context.createGain();
      runtime.source = source;
      runtime.monitor = monitor;
      source.buffer = buffer;
      monitor.gain.value = current.current.muted
        ? 0
        : current.current.volume / 100;
      source.connect(monitor).connect(context.destination);
      const offset = snapshot.cursor >= TOTAL_FRAMES - 1 ? 0 : snapshot.cursor;
      const started = context.currentTime;
      source.onended = () => {
        if (!runtime.active || generation !== runtime.generation) return;
        stop();
        position(TOTAL_FRAMES - 1);
        update({
          playbackNote: "Replay complete. Play again from the beginning.",
        });
      };
      source.start(0, offset / SAMPLE_RATE);
      update({ playback: "playing", playbackNote: "Estimated replay cursor" });
      let last = 0;
      const tick = (now: number) => {
        if (!runtime.active || generation !== runtime.generation) return;
        if (now - last >= 32) {
          const frame = Math.min(
            TOTAL_FRAMES - 1,
            offset + Math.floor((context.currentTime - started) * SAMPLE_RATE),
          );
          const { viewStart, span } = current.current;
          position(frame, frame < viewStart || frame >= viewStart + span);
          last = now;
        }
        runtime.animation = requestAnimationFrame(tick);
      };
      runtime.animation = requestAnimationFrame(tick);
    } catch (error) {
      if (generation !== runtime.generation || !runtime.active) return;
      stop();
      update({
        playbackNote: `Playback unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  function monitor(patch: Partial<Pick<LabState, "volume" | "muted">>) {
    update(patch);
    const { context, monitor } = resources.current;
    if (context && monitor)
      monitor.gain.setTargetAtTime(
        current.current.muted ? 0 : current.current.volume / 100,
        context.currentTime,
        0.01,
      );
  }

  useEffect(() => {
    const runtime = resources.current;
    runtime.active = true;
    function release() {
      stop();
      invalidate();
      runtime.worker?.terminate();
      runtime.worker = null;
      const context = runtime.context;
      runtime.context = null;
      void context?.close().catch(() => {});
    }
    const visibility = () => {
      if (document.hidden) stop();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) render(current.current.config, false, true);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", restore);
    render(current.current.config, false, true);
    return () => {
      runtime.active = false;
      release();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  return {
    state,
    actions: {
      stop,
      play,
      scrub,
      selectNode,
      selectEvent,
      loadLesson,
      setSource,
      setSpan,
      editEvent,
      addEvent,
      beginDrag,
      moveMarker,
      endDrag: () => render(current.current.config),
      selectConnection: (from: Processor, to: Processor) =>
        update({ selected: from, connection: { from, to } }),
      setBlocks: (blocks: boolean) => update({ blocks }),
      setPartition: (partition: number) =>
        render({ ...current.current.config, partition }),
      compare: () => render(current.current.config, true, true),
      removeEvent: (id: number) => {
        update({ selectedEvent: null });
        render({
          ...current.current.config,
          events: current.current.config.events.filter(
            (event) => event.id !== id,
          ),
        });
      },
      setVolume: (volume: number) => monitor({ volume }),
      setMuted: (muted: boolean) => monitor({ muted }),
    },
  };
}

export type LabActions = ReturnType<typeof useLab>["actions"];
