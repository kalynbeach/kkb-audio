import { useEffect, useRef, useState } from "react";
import type { PlayerVisualProps } from "./player-app";
import type { PlaybackOwner } from "./playback-owner";
import { OSCILLOSCOPE_SAMPLES, type OscilloscopeBuffers } from "./oscilloscope-tap";
import { createPlaybackScope } from "./wave-scope/playback-scope";

type ScopeOwner = Pick<PlaybackOwner, "getState" | "subscribe" | "getOscilloscopeRevision" | "readOscilloscope" | "releaseOscilloscope">;
type ScopeFactory = typeof createPlaybackScope;
type ScopeStatus = { label: string; channels: 1 | 2 | null };

/** This observer owns only visual resources. PlaybackOwner remains the sole audio owner. */
export function observePlaybackScope(canvas: HTMLCanvasElement, owner: ScopeOwner, paused: boolean,
  report: (status: ScopeStatus) => void, createScope: ScopeFactory = createPlaybackScope) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const initialization = new AbortController();
  const buffers: OscilloscopeBuffers = [new Float32Array(OSCILLOSCOPE_SAMPLES), new Float32Array(OSCILLOSCOPE_SAMPLES)];
  let scope: Awaited<ReturnType<ScopeFactory>> | undefined;
  let starting = false;
  let disposed = false;
  let failed = false;
  let frame = 0;
  let lastRead = -Infinity;
  let last = -Infinity;
  let revision = owner.getOscilloscopeRevision();
  let phase = owner.getState().phase;
  let channels: 1 | 2 | null = null;
  let dirty = false;
  canvas.hidden = true;
  const status = (label: string) => report({ label, channels });
  const stop = () => { cancelAnimationFrame(frame); frame = 0; };
  const clear = () => {
    channels = null; canvas.hidden = true; lastRead = -Infinity; last = -Infinity;
    if (dirty) { dirty = false; scope?.clear(); }
  };
  const fail = () => {
    if (disposed || failed) return;
    failed = true; stop(); channels = null; canvas.hidden = true;
    scope?.destroy(); scope = undefined; owner.releaseOscilloscope();
    status("Visual unavailable · audio unchanged");
  };
  const eligible = () => !disposed && !failed && !document.hidden && !paused && !reduced.matches;
  const tick = (now: number) => {
    frame = 0;
    if (!eligible() || owner.getState().phase !== "playing") return;
    if (revision !== owner.getOscilloscopeRevision()) { update(); return; }
    if (now - lastRead >= 1000 / 30 && !owner.getState().busy && scope) {
      try {
        lastRead = now;
        const read = owner.readOscilloscope(revision, buffers);
        if (read === "unavailable") { fail(); return; }
        if (read !== "warming") {
          const delta = Number.isFinite(last) ? Math.min(0.25, (now - last) / 1000) : 1 / 30;
          scope.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
          scope.draw(buffers[0], buffers[1], read, delta);
          if (failed) return;
          last = now; channels = read; dirty = true; canvas.hidden = false; status("Live XY · P31 green");
        }
      } catch { fail(); return; }
    }
    if (eligible()) frame = requestAnimationFrame(tick);
  };
  const update = () => {
    if (disposed || failed) return;
    stop();
    const current = owner.getState().phase;
    const nextRevision = owner.getOscilloscopeRevision();
    if (nextRevision !== revision || (current !== phase && current !== "paused")) clear();
    revision = nextRevision; phase = current;
    if (failed) return;
    if (!eligible()) {
      clear(); owner.releaseOscilloscope();
      status(reduced.matches ? "Reduced motion · live visual off" : document.hidden ? "Visual suspended" : "Visual paused · audio unchanged");
      return;
    }
    if (current === "playing") {
      if (!channels) status("Waiting for fresh playback signal…");
      if (scope) frame = requestAnimationFrame(tick);
      else if (!starting) {
        starting = true;
        void createScope(canvas, fail, initialization.signal).then(created => {
          starting = false;
          if (disposed || failed) { created.destroy(); return; }
          scope = created; update();
        }, fail);
      }
    } else status(current === "paused" ? channels ? "Paused · last observed signal" : "Paused · Play to observe"
      : current === "ended" ? "Ended · no live signal" : current === "seeking" ? "Seeking · waiting for fresh signal…" : "No live signal");
  };
  const visibility = () => { if (!disposed && !failed) { clear(); update(); } };
  const repaint = () => {
    if (!eligible() || !scope || !channels || !dirty || owner.getState().phase !== "paused") return;
    try {
      const width = canvas.width; const height = canvas.height;
      scope.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
      if (failed) return;
      if (width !== canvas.width || height !== canvas.height) scope.draw(buffers[0], buffers[1], channels, 0);
      else scope.present();
    } catch { fail(); }
  };
  const resize = new ResizeObserver(repaint);
  const theme = new MutationObserver(repaint);
  resize.observe(canvas);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const unsubscribe = owner.subscribe(update);
  reduced.addEventListener("change", visibility);
  document.addEventListener("visibilitychange", visibility);
  update();
  const dispose = () => {
    disposed = true; initialization.abort(); stop(); unsubscribe();
    resize.disconnect(); theme.disconnect();
    reduced.removeEventListener("change", visibility);
    document.removeEventListener("visibilitychange", visibility);
    scope?.destroy(); scope = undefined;
    owner.releaseOscilloscope(); canvas.hidden = true;
  };
  return { dispose, repaint };
}

export function WavePlayerScope({ owner, paused, editing = false, obscured = false }: PlayerVisualProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const observer = useRef<ReturnType<typeof observePlaybackScope> | null>(null);
  const [state, setState] = useState<ScopeStatus>({ label: "Play to observe", channels: null });
  useEffect(() => {
    const view = observePlaybackScope(canvas.current!, owner, paused, next => {
      setState(previous => previous.label === next.label && previous.channels === next.channels ? previous : next);
    });
    observer.current = view;
    return () => { observer.current = null; view.dispose(); };
  }, [owner, paused]);
  useEffect(() => {
    if (obscured) return;
    let cancelled = false;
    // Native disclosure snapshots can invalidate a paused WebGPU presentation.
    // Composite the retained history once after they finish, without reading audio.
    const frame = requestAnimationFrame(() => {
      void Promise.allSettled([document.activeViewTransition?.finished,
        ...document.getAnimations().map(animation => animation.finished)]).then(() => {
        if (!cancelled) observer.current?.repaint();
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [obscured, editing]);
  return <figure className="player-visual wave-player-scope" data-loop-editing={editing}
    aria-label="Live WebGPU XY oscilloscope, rendered playback before listening volume">
    <div className="wave-player-scope-screen"><canvas ref={canvas} aria-hidden="true" /></div>
    <figcaption><span role="status">{state.label}</span>{state.channels
      ? <span>{state.channels === 1 ? "Mono → X + Y" : "L → X · R → Y"} · before volume</span> : null}</figcaption>
  </figure>;
}
