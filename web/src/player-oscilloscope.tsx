import { useEffect, useRef, useState } from "react";
import type { PlaybackOwner } from "./playback-owner";
import { drawOscilloscope, OscilloscopeHistory, OSCILLOSCOPE_INTERVAL } from "./oscilloscope-render";

export function PlayerOscilloscope({ owner, paused, editing = false }: { owner: PlaybackOwner; paused: boolean; editing?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [label, setLabel] = useState("Play to observe");
  const [channels, setChannels] = useState<1 | 2 | null>(null);
  useEffect(() => {
    const element = canvas.current!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const history = new OscilloscopeHistory();
    let revision = owner.getOscilloscopeRevision();
    let phase = owner.getState().phase;
    let reducedMotion = reduced.matches;
    let frame = 0;
    let last = -Infinity;
    let disposed = false;
    let failed = false;
    let context: CanvasRenderingContext2D | null = null;
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    const clear = () => { history.clear(); setChannels(null); };
    const fail = () => {
      failed = true; stop(); clear(); element.hidden = true;
      owner.releaseOscilloscope(); setLabel("Visual unavailable · playback controls remain available");
    };
    const draw = () => {
      if (disposed || document.hidden || failed) return;
      try {
        context ??= element.getContext("2d");
        if (!context) { fail(); return; }
        drawOscilloscope(element, context, history, document.documentElement.classList.contains("dark"));
        element.hidden = false;
      } catch { fail(); }
    };
    const tick = (now: number) => {
      frame = 0;
      if (disposed || document.hidden || failed || paused || reduced.matches || owner.getState().phase !== "playing") return;
      // Every scheduled closure revalidates identity, not only React's render/effect.
      if (revision !== owner.getOscilloscopeRevision()) { update(); return; }
      if (now - last >= OSCILLOSCOPE_INTERVAL && !owner.getState().busy) {
        last = now;
        const result = owner.readOscilloscope(revision, history.destination);
        if (result === "unavailable") { fail(); return; }
        if (result !== "warming") {
          history.accept(result); setChannels(result); setLabel("Live oscilloscope"); draw();
        }
      }
      if (!failed) frame = requestAnimationFrame(tick);
    };
    const update = (force = false) => {
      if (disposed) return;
      stop();
      const current = owner.getState().phase;
      const changed = revision !== owner.getOscilloscopeRevision() || current !== phase || reducedMotion !== reduced.matches;
      reducedMotion = reduced.matches;
      if (revision !== owner.getOscilloscopeRevision() || current === "seeking" || current === "ended" || current === "empty" || current === "error" || current === "loading") clear();
      revision = owner.getOscilloscopeRevision(); phase = current;
      // Failure remains the explanation until this consumer is remounted.
      if (failed) return;
      if (document.hidden || paused || reduced.matches) {
        clear(); owner.releaseOscilloscope();
        if (document.hidden) { element.hidden = true; return; }
        setLabel(reduced.matches ? "Reduced motion · live visual off" : "Visual paused · audio unchanged");
        if (changed || force) draw(); return;
      }
      if (current === "playing") {
        if (changed) clear();
        if (!history.count) setLabel("Waiting for fresh signal…");
        frame = requestAnimationFrame(tick);
      } else setLabel(current === "paused" ? history.count ? "Paused · last observed signal" : "Paused · Play to observe"
        : current === "ended" ? "Ended · no live signal" : current === "seeking" ? "Seeking · waiting for fresh signal…" : "No live signal");
      if (changed || force) draw();
    };
    const visibility = () => { clear(); element.hidden = true; last = -Infinity; update(true); };
    const resize = new ResizeObserver(draw);
    const theme = new MutationObserver(draw);
    resize.observe(element);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const unsubscribe = owner.subscribe(update);
    reduced.addEventListener("change", visibility);
    document.addEventListener("visibilitychange", visibility);
    element.addEventListener("contextlost", fail);
    update(true);
    return () => {
      disposed = true; stop(); history.clear(); unsubscribe(); resize.disconnect(); theme.disconnect();
      reduced.removeEventListener("change", visibility);
      document.removeEventListener("visibilitychange", visibility);
      element.removeEventListener("contextlost", fail);
      owner.releaseOscilloscope();
    };
  }, [owner, paused]);
  return <figure className="player-visual player-oscilloscope" data-loop-editing={editing} aria-label="Live oscilloscope, rendered signal before listening volume">
    <canvas ref={canvas} aria-hidden="true" />
    <figcaption><span role="status">{label}</span>{channels ? <span>{channels === 1 ? "Mono" : "L solid / R dashed"} · before volume</span> : null}</figcaption>
  </figure>;
}
