import { ViewTransition, useEffect, useId, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { time, type Loop } from "./player-prototype-state";

type Draft = { kind: "seek" | "a" | "b" | "region"; position: number; a: number; b: number };
const bars = Array.from({ length: 160 }, (_, i) => {
  const envelope = 0.3 + Math.abs(Math.sin(i * 0.037)) * 0.4 + Math.abs(Math.cos(i * 0.091)) * 0.25;
  const amplitude = (0.18 + Math.abs(Math.sin(i * 2.317)) * 0.82) * envelope * 17;
  return `M${i * 2 + 1},${(23 - amplitude).toFixed(2)}v${(amplitude * 2).toFixed(2)}`;
}).join("");

export function PrototypeTimeline({ duration, position, loop, editing, disabled, onSeek, onRegion, onEnable, onReady }: {
  duration: number; position: number; loop: Loop; editing: boolean; disabled: boolean;
  onSeek: (position: number) => void; onRegion: (a: number, b: number) => void; onEnable: (enabled: boolean) => void; onReady: () => void;
}) {
  const uid = useId().replaceAll(":", "");
  const graph = useRef<HTMLDivElement>(null);
  const pending = useRef<{ draft: Draft; start: number; cancelled: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const cancel = () => { if (pending.current) pending.current.cancelled = true; setDraft(null); };
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);
  useEffect(() => { cancel(); }, [editing, disabled]);
  const xTime = (x: number) => {
    const rect = graph.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * duration);
  };
  const update = (x: number) => {
    const drag = pending.current;
    if (!drag || drag.cancelled) return;
    const value = xTime(x);
    const next = { ...drag.draft };
    if (next.kind === "seek") next.position = value;
    if (next.kind === "a") next.a = Math.min(value, next.b - 1);
    if (next.kind === "b") next.b = Math.max(value, next.a + 1);
    if (next.kind === "region") { next.a = Math.min(drag.start, value, duration - 1); next.b = Math.max(next.a + 1, drag.start, value); }
    drag.draft = next;
    setDraft(next);
  };
  const start = (event: PointerEvent<HTMLElement>, kind: Draft["kind"]) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    pending.current = { draft: { kind, position, a: loop.a, b: loop.b }, start: xTime(event.clientX), cancelled: false };
    graph.current!.setPointerCapture(event.pointerId);
    update(event.clientX);
  };
  const commit = () => {
    const drag = pending.current;
    pending.current = null;
    setDraft(null);
    if (!drag || drag.cancelled || disabled) return;
    if (drag.draft.kind === "seek") onSeek(drag.draft.position);
    else onRegion(drag.draft.a, drag.draft.b);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, kind: "seek" | "a" | "b") => {
    if (event.key === "Escape") { cancel(); return; }
    if (disabled) return;
    const current = kind === "seek" ? position : loop[kind];
    const step = kind === "seek" ? 5 : event.shiftKey ? 5 : 1;
    const keys: Record<string, number> = { ArrowLeft: current - step, ArrowDown: current - step, ArrowRight: current + step, ArrowUp: current + step,
      PageDown: current - 30, PageUp: current + 30, Home: 0, End: duration };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    if (kind === "seek") onSeek(target);
    else if (kind === "a") onRegion(Math.max(0, Math.min(target, loop.b - 1)), loop.b);
    else onRegion(loop.a, Math.max(loop.a + 1, Math.min(duration, target)));
  };
  const shown = draft?.kind === "seek" ? draft.position : position;
  const a = draft?.a ?? loop.a;
  const b = draft?.b ?? loop.b;
  const percent = (value: number) => `${value / duration * 100}%`;

  return <section className="prototype-timeline" aria-label="Track navigation">
    {editing ? <ViewTransition default="none" enter="loop-layer" exit="loop-layer"><div className="prototype-loop-overlay" role="group" aria-label="Loop editor">
      <div className="prototype-loop-fields">
      <BoundaryField name="A" value={loop.a} max={loop.b - 1} onCommit={value => onRegion(value, loop.b)} />
      <BoundaryField name="B" value={loop.b} min={loop.a + 1} max={duration} onCommit={value => onRegion(loop.a, value)} />
      <label className="prototype-loop-enable"><input type="checkbox" checked={loop.enabled} onChange={event => onEnable(event.target.checked)} />Loop</label>
      <Button variant="ghost" size="xs" onClick={() => onRegion(0, duration)}>Reset</Button>
      </div>
      {loop.phase !== "ready" ? <p className="prototype-loop-message" role="status">{loop.phase === "preparing" ? "Preparing loop…" : "Loop preparation failed."}
        <Button variant="ghost" size="xs" onClick={onReady}>{loop.phase === "preparing" ? "Finish simulation" : "Retry simulation"}</Button></p> : null}
    </div></ViewTransition> : null}
    <div ref={graph} className="prototype-waveform" data-editing={editing} data-disabled={disabled}
      onPointerMove={event => update(event.clientX)} onPointerUp={commit}
      onPointerCancel={cancel} onLostPointerCapture={cancel}
      onBlur={cancel} onKeyDown={event => { if (event.key === "Escape") cancel(); }}>
      <svg viewBox="0 0 320 46" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id={`${uid}-played`}><rect width={shown / duration * 320} height="46" /></clipPath>
          <pattern id={`${uid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 4L4 0" stroke="currentColor" strokeWidth="0.6" /></pattern>
        </defs>
        <path d={bars} className="prototype-wave-remaining" strokeWidth="1.25" />
        <path d={bars} stroke="currentColor" strokeWidth="1.25" clipPath={`url(#${uid}-played)`} />
        {editing ? <rect x={a / duration * 320} width={(b - a) / duration * 320} height="46" fill={`url(#${uid}-hatch)`} opacity="0.4" /> : null}
      </svg>
      <div className="prototype-seek-target" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Playback position"
        aria-disabled={disabled} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.floor(shown)} aria-valuetext={`${draft ? "Preview " : ""}${time(shown)} of ${time(duration)}`}
        aria-describedby={`${uid}-help`} onPointerDown={event => start(event, editing && event.shiftKey ? "region" : "seek")}
        onKeyDown={event => keyboard(event, "seek")} />
      {editing ? (["a", "b"] as const).map(boundary => <button key={boundary} type="button" role="slider"
        className={`prototype-boundary prototype-boundary-${boundary}`} style={{ left: percent(boundary === "a" ? a : b) }}
        disabled={disabled} aria-label={`Loop ${boundary.toUpperCase()}`} aria-valuemin={boundary === "a" ? 0 : a + 1}
        aria-valuemax={boundary === "a" ? b - 1 : duration} aria-valuenow={boundary === "a" ? a : b}
        aria-valuetext={time(boundary === "a" ? a : b)}
        onPointerDown={event => start(event, boundary)} onKeyDown={event => keyboard(event, boundary)}>
          <span>{boundary.toUpperCase()}</span>
        </button>) : null}
      <span className="prototype-playhead" data-preview={draft?.kind === "seek"} style={{ left: percent(shown) }} />
    </div>
    <div className="prototype-time"><output aria-label="Elapsed time" aria-live="off">{time(shown)}{draft ? <span className="prototype-pixel"> · PREVIEW</span> : null}</output><output aria-label="Duration" aria-live="off">{time(duration)}</output></div>
    <span id={`${uid}-help`} className="sr-only">Drag to preview a seek; release to commit. Escape or blur cancels. Arrow keys seek five seconds. Home and End reach endpoints. When editing, Shift-drag selects a region. Loop handles use one-second arrow steps; exact fields are also available.</span>
  </section>;
}

function BoundaryField({ name, value, min = 0, max, onCommit }: { name: string; value: number; min?: number; max: number; onCommit: (value: number) => void }) {
  const errorId = useId();
  const [text, setText] = useState(time(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(time(value)); setInvalid(false); }, [value]);
  const commit = () => {
    const match = /^(\d+):([0-5]\d)$/.exec(text);
    const seconds = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
    if (!Number.isFinite(seconds) || seconds < min || seconds > max) { setInvalid(true); return; }
    setInvalid(false);
    onCommit(seconds);
  };
  return <label className="prototype-boundary-field"><span className="prototype-pixel">{name}</span>
    <Input aria-label={`Loop ${name} time`} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} title={`mm:ss, ${time(min)}–${time(max)}`} value={text}
      onChange={event => { setText(event.target.value); setInvalid(false); }} onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") { event.preventDefault(); setText(time(value)); setInvalid(false); }
      }} />
    {invalid ? <span id={errorId} role="alert" className="sr-only">Use mm:ss between {time(min)} and {time(max)}.</span> : null}
  </label>;
}
