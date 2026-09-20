import { useAppearance } from "../../app/appearance";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  DiamondIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  TrendingUpIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { Badge } from "#components/ui/badge";
import { Button, buttonVariants } from "#components/ui/button";
import { Checkbox } from "#components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#components/ui/field";
import { Input } from "#components/ui/input";
import { NativeSelect, NativeSelectOption } from "#components/ui/native-select";
import { Progress } from "#components/ui/progress";
import { Separator } from "#components/ui/separator";
import { Skeleton } from "#components/ui/skeleton";
import { Slider } from "#components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "#components/ui/toggle-group";
import { cn } from "#lib/utils";
import { drawOverview, drawScope, frameAt, miniature } from "./lab-canvas.ts";
import {
  levels,
  SAMPLE_RATE,
  TOTAL_FRAMES,
  type LabEvent,
  type Processor,
} from "./lab-model.ts";
import {
  inspector,
  lessonCopy,
  names,
  positions,
  shortNames,
  signalClass,
} from "./lab-presentation.ts";
import { trace, useLab, type LabActions, type LabState } from "./use-lab.ts";

type LabProps = { state: LabState; actions: LabActions };
const experiments = ["Hear the beating", "Move one moment", "Cross a boundary"];
const views = [
  [96000, "2 s · all samples"],
  [12000, "250 ms · 12,000 samples"],
  [2048, "42.7 ms · 2,048 samples"],
  [256, "5.3 ms · 256 samples"],
  [32, "0.67 ms · 32 samples"],
] as const;

/** Numeric drafts commit on blur/Enter, so negative and partially typed values remain editable. */
function NumberInput({
  value,
  onCommit,
  onDraft,
  ...props
}: Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "onBlur" | "onKeyDown"
> & {
  value: number;
  onCommit: (value: number) => void;
  onDraft?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft)))
      onCommit(Number(draft));
    setDraft(null);
  }
  return (
    <Input
      {...props}
      type="number"
      value={draft ?? String(value)}
      onChange={(event) => {
        onDraft?.();
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}

function usePaint(
  ref: RefObject<HTMLCanvasElement | null>,
  state: LabState,
  dark: boolean,
  draw: typeof drawScope,
) {
  const paint = useEffectEvent(() => {
    if (ref.current) draw(ref.current, state);
  });
  useLayoutEffect(() => {
    paint();
  }, [state, dark]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let mounted = true;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    void document.fonts.ready.then(() => {
      if (mounted) paint();
    });
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, []);
}

function Graph({ state, actions }: LabProps) {
  const nodes = useRef(new Map<Processor, HTMLButtonElement>());
  const info = inspector(state);
  const value = trace(state.result, state.selected)?.[state.cursor];
  return (
    <section aria-labelledby="graph-title" className="lab-graph-section">
      <div className="lab-graph-main">
        <div className="lab-section-heading">
          <h2 id="graph-title">The signal graph</h2>
          <p>Select a signal · miniature traces autoscaled</p>
        </div>
        <p id="graph-scroll-hint" className="lab-scroll-hint">
          Scroll the graph sideways or select a step below.
        </p>
        <div
          className="lab-graph-scroll"
          tabIndex={0}
          role="region"
          aria-label="Signal graph canvas"
          aria-describedby="graph-scroll-hint"
        >
          <div className="lab-graph-stage">
            {!state.result && <Skeleton className="absolute inset-6" />}
            <svg
              className="lab-connections"
              viewBox="0 0 1000 254"
              preserveAspectRatio="none"
              role="group"
              aria-label="Signal connections"
            >
              {state.result?.operations.flatMap((operation) =>
                operation.inputs.map((slot) => {
                  const from = state.result!.operations[slot].id;
                  const [sx, sy] = positions[from],
                    [x, y] = positions[operation.id];
                  const d = `M${sx + 75},${sy} C${sx + 125},${sy} ${x - 125},${y} ${x - 75},${y}`;
                  const active =
                    state.connection?.from === from &&
                    state.connection.to === operation.id;
                  return (
                    <g
                      key={`${from}-${operation.id}`}
                      className={signalClass(from)}
                    >
                      <path
                        d={d}
                        className="lab-connection"
                        data-selected={active}
                      />
                      <path
                        d={d}
                        className="lab-connection-hit"
                        role="button"
                        tabIndex={0}
                        aria-pressed={active}
                        aria-label={`Inspect connection from ${names[from]} to ${names[operation.id]}`}
                        onClick={() =>
                          actions.selectConnection(from, operation.id)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            actions.selectConnection(from, operation.id);
                          }
                        }}
                      />
                    </g>
                  );
                }),
              )}
            </svg>
            {state.result?.operations.map((operation, slot) => {
              const [x, y] = positions[operation.id];
              return (
                <Button
                  key={operation.id}
                  ref={(element) => {
                    if (element) nodes.current.set(operation.id, element);
                    else nodes.current.delete(operation.id);
                  }}
                  variant={
                    state.selected === operation.id ? "secondary" : "outline"
                  }
                  className="lab-graph-node"
                  style={{ left: `${x / 10}%`, top: `${(y / 254) * 100}%` }}
                  aria-pressed={state.selected === operation.id}
                  aria-label={`Select ${names[operation.id]}, processor ${operation.id}`}
                  onClick={() => actions.selectNode(operation.id)}
                >
                  <span className="lab-node-name">
                    {shortNames[operation.id]}
                  </span>
                  <code>{operation.id}</code>
                  <span className="lab-node-value">
                    {operation.kind === 1
                      ? `${operation.value} Hz`
                      : operation.kind === 2
                        ? `× ${operation.value.toFixed(2)} initial`
                        : operation.kind === 4
                          ? "64-frame windows"
                          : operation.kind === 5
                            ? "mono · f32"
                            : "A + B"}
                  </span>
                  <svg
                    viewBox="0 0 100 22"
                    className={cn(signalClass(operation.id), "size-full")}
                    aria-hidden="true"
                  >
                    <path
                      d={miniature(
                        trace(state.result, operation.id),
                        state.peaks[slot],
                        state.cursor,
                      )}
                    />
                  </svg>
                </Button>
              );
            })}
          </div>
        </div>
        <Separator />
        <div className="lab-sequence">
          <div>
            <h3>Compiled order</h3>
            <p>Runs for every sample</p>
          </div>
          <ToggleGroup
            aria-label="Compiled execution order"
            value={[String(state.selected)]}
            variant="outline"
            size="sm"
            className="flex-wrap"
            onValueChange={(values) => {
              if (values[0]) actions.selectNode(Number(values[0]) as Processor);
            }}
          >
            {state.result?.operations.map((operation, index) => (
              <ToggleGroupItem
                key={operation.id}
                value={String(operation.id)}
                aria-label={`Execution step ${index + 1}: ${names[operation.id]}`}
                onClick={() =>
                  nodes.current
                    .get(operation.id)
                    ?.scrollIntoView({ block: "nearest", inline: "center" })
                }
              >
                <code>{index + 1}</code>
                {shortNames[operation.id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <aside className="lab-inspector" aria-labelledby="inspector-title">
        <div className="lab-meta">Processor {state.selected}</div>
        <h2 id="inspector-title">{info.title}</h2>
        <p>{info.description}</p>
        <div className="lab-inspector-reading">
          <span>Signal at cursor</span>
          <output className="lab-reading">{value?.toFixed(6) ?? "—"}</output>
          <code>sample {state.cursor.toLocaleString()}</code>
        </div>
        <Separator />
        <p>{info.detail}</p>
      </aside>
    </section>
  );
}

function Sources({ state, actions }: LabProps) {
  return (
    <section aria-label="Source settings" className="lab-sources">
      {(["A", "B"] as const).map((source) => {
        const frequency =
          source === "A" ? state.config.frequencyA : state.config.frequencyB;
        const gain = source === "A" ? state.config.gainA : state.config.gainB;
        const suffix = source.toLowerCase();
        return (
          <FieldSet key={source}>
            <FieldLegend>
              <span className={source === "A" ? "signal-a" : "signal-b"}>
                ●
              </span>{" "}
              Source {source}
            </FieldLegend>
            <FieldGroup className="lab-source-fields">
              <Field>
                <FieldLabel
                  id={`frequency-${suffix}-label`}
                  htmlFor={`frequency-${suffix}`}
                >
                  <span className="sr-only">Source {source} </span>Frequency{" "}
                  <code aria-hidden="true">{frequency} Hz</code>
                </FieldLabel>
                <div className="lab-frequency-control">
                  <Slider
                    id={`frequency-${suffix}`}
                    aria-labelledby={`frequency-${suffix}-label`}
                    value={[frequency]}
                    min={20}
                    max={2000}
                    step={1}
                    onValueChange={(values) =>
                      actions.setSource(
                        source === "A" ? "frequencyA" : "frequencyB",
                        Array.isArray(values) ? values[0] : values,
                      )
                    }
                  />
                  <NumberInput
                    aria-label={`Source ${source} frequency in Hz`}
                    value={frequency}
                    min={20}
                    max={2000}
                    step={1}
                    onDraft={actions.stop}
                    onCommit={(value) =>
                      actions.setSource(
                        source === "A" ? "frequencyA" : "frequencyB",
                        value,
                      )
                    }
                  />
                </div>
              </Field>
              <Field>
                <FieldLabel
                  id={`gain-${suffix}-label`}
                  htmlFor={`gain-${suffix}`}
                >
                  <span className="sr-only">Source {source} </span>Gain{" "}
                  <code aria-hidden="true">{gain.toFixed(2)}</code>
                </FieldLabel>
                <Slider
                  id={`gain-${suffix}`}
                  aria-labelledby={`gain-${suffix}-label`}
                  value={[gain]}
                  min={-1}
                  max={1}
                  step={0.01}
                  onValueChange={(values) =>
                    actions.setSource(
                      source === "A" ? "gainA" : "gainB",
                      Array.isArray(values) ? values[0] : values,
                    )
                  }
                />
              </Field>
            </FieldGroup>
          </FieldSet>
        );
      })}
      <p className="lab-caption">
        Source edits compile a fresh plan and reset oscillator phase. Timed
        events change gain inside the render.
      </p>
    </section>
  );
}

function Scope({
  state,
  actions,
  dark,
  canvasRef,
}: LabProps & {
  dark: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  usePaint(canvasRef, state, dark, drawScope);
  const value = trace(state.result, 70)?.[state.cursor] ?? 0;
  function pointer(event: React.PointerEvent<HTMLCanvasElement>) {
    actions.scrub(frameAt(event.clientX, event.currentTarget, state), false);
  }
  return (
    <section aria-labelledby="scope-title" className="lab-section">
      <div className="lab-section-heading">
        <div>
          <h2 id="scope-title">Signal microscope</h2>
          <p>Actual engine samples, before listening volume</p>
        </div>
        <div className="lab-scope-options">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="zoom">View</FieldLabel>
            <NativeSelect
              id="zoom"
              value={state.span}
              onChange={(event) => actions.setSpan(Number(event.target.value))}
            >
              {views.map(([value, title]) => (
                <NativeSelectOption key={value} value={value}>
                  {title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="show-blocks"
              checked={state.blocks}
              onCheckedChange={actions.setBlocks}
            />
            <FieldLabel htmlFor="show-blocks">Blocks</FieldLabel>
          </Field>
        </div>
      </div>
      <div
        className="lab-scope-wrap"
        aria-busy={state.renderStatus !== "ready"}
      >
        <canvas
          ref={canvasRef}
          id="scope"
          className="lab-scope"
          role="slider"
          tabIndex={0}
          aria-label="Waveform sample cursor"
          aria-valuemin={0}
          aria-valuemax={TOTAL_FRAMES - 1}
          aria-valuenow={state.cursor}
          aria-valuetext={`Sample ${state.cursor}, output ${value.toFixed(6)}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              pointer(event);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            actions.scrub(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? TOTAL_FRAMES - 1
                  : state.cursor +
                    (event.key === "ArrowLeft" ? -1 : 1) *
                      (event.shiftKey ? state.config.partition : 1),
            );
          }}
        />
        {state.renderStatus !== "ready" && (
          <div className="lab-render-overlay" role="status">
            {state.renderStatus === "dragging"
              ? "Move event · release to render"
              : state.renderStatus === "failed"
                ? "Render unavailable"
                : "Rendering updated samples…"}
          </div>
        )}
      </div>
      <div className="lab-scope-footer">
        <div className="lab-trace-legend" aria-label="Displayed signals">
          {(
            [
              [
                state.selected === 10 ? 10 : 20,
                state.selected === 10 ? "A raw oscillator" : "A after gain",
              ],
              [
                state.selected === 30 ? 30 : 40,
                state.selected === 30 ? "B raw oscillator" : "B after gain",
              ],
              [70, "Mix / output"],
            ] as const
          ).map(([id, title]) => (
            <Button
              key={id}
              variant="ghost"
              size="sm"
              onClick={() => actions.selectNode(id)}
            >
              <span className={signalClass(id)} aria-hidden="true">
                ●
              </span>
              {title}
              <code>
                {(trace(state.result, id)?.[state.cursor] ?? 0).toFixed(4)}
              </code>
            </Button>
          ))}
        </div>
        <div className="lab-cursor-control">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous sample"
            onClick={() => actions.scrub(state.cursor - 1)}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="cursor-number">Sample</FieldLabel>
            <NumberInput
              id="cursor-number"
              value={state.cursor}
              min={0}
              max={TOTAL_FRAMES - 1}
              step={1}
              onDraft={actions.stop}
              onCommit={actions.scrub}
            />
          </Field>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next sample"
            onClick={() => actions.scrub(state.cursor + 1)}
          >
            <ArrowRightIcon aria-hidden="true" />
          </Button>
          <code>{((state.cursor / SAMPLE_RATE) * 1000).toFixed(3)} ms</code>
        </div>
      </div>
      <WindowMeter state={state} className="lab-scope-meter" />
    </section>
  );
}

function timelineLeft(frame: number) {
  const fraction = frame / (TOTAL_FRAMES - 1);
  return `calc(${fraction * 100}% + ${36 - 52 * fraction}px)`;
}

function Events({
  state,
  actions,
  dark,
  inspect,
}: LabProps & { dark: boolean; inspect: () => void }) {
  const overview = useRef<HTMLCanvasElement>(null);
  usePaint(overview, state, dark, drawOverview);
  const selected = state.config.events.find(
    (event) => event.id === state.selectedEvent,
  );
  function move(event: React.PointerEvent, item: LabEvent) {
    if (overview.current)
      actions.moveMarker(
        item.id,
        frameAt(event.clientX, overview.current, state, true),
        true,
      );
  }
  return (
    <section className="lab-section" aria-labelledby="events-title">
      <div className="lab-section-heading">
        <div>
          <h2 id="events-title">Events in render time</h2>
          <p>
            Drag a marker or use its arrow keys. Select overlapping events
            below.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={state.config.events.length >= 16}
            onClick={() => actions.addEvent("set")}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Gain set
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={state.config.events.length >= 16}
            onClick={() => actions.addEvent("ramp")}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Linear ramp
          </Button>
        </div>
      </div>
      <div className="lab-timeline">
        <canvas
          ref={overview}
          className="lab-overview"
          aria-label="Two-second output overview and gain event lanes"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            actions.scrub(
              frameAt(event.clientX, event.currentTarget, state, true),
            );
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              actions.scrub(
                frameAt(event.clientX, event.currentTarget, state, true),
              );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        />
        <div
          className="lab-timeline-window"
          style={{
            left: timelineLeft(state.viewStart),
            width: `calc(${(state.span / TOTAL_FRAMES) * 100}% - ${(52 * state.span) / TOTAL_FRAMES}px)`,
          }}
        />
        <div
          className="lab-timeline-cursor"
          style={{ left: timelineLeft(state.cursor) }}
        />
        {state.config.events.map((event) => (
          <Button
            key={event.id}
            size="icon-sm"
            variant={selected?.id === event.id ? "default" : "outline"}
            className="lab-event-marker"
            data-selected={selected?.id === event.id}
            data-event-id={event.id}
            style={{
              left: timelineLeft(event.frame),
              top: event.processor === 20 ? 94 : 134,
            }}
            aria-pressed={selected?.id === event.id}
            title={`${event.kind} · sample ${event.frame.toLocaleString()}`}
            aria-label={`${event.kind} gain ${event.processor === 20 ? "A" : "B"} at sample ${event.frame}. Arrow keys move one sample; Shift moves 128.`}
            onClick={() => actions.selectEvent(event.id)}
            onPointerDown={(pointer) => {
              pointer.preventDefault();
              pointer.stopPropagation();
              pointer.currentTarget.focus();
              pointer.currentTarget.setPointerCapture(pointer.pointerId);
              actions.beginDrag(event.id);
            }}
            onPointerMove={(pointer) => {
              if (pointer.currentTarget.hasPointerCapture(pointer.pointerId))
                move(pointer, event);
            }}
            onPointerUp={(pointer) => {
              if (pointer.currentTarget.hasPointerCapture(pointer.pointerId)) {
                pointer.currentTarget.releasePointerCapture(pointer.pointerId);
                actions.endDrag();
              }
            }}
            onPointerCancel={actions.endDrag}
            onKeyDown={(key) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key.key))
                return;
              key.preventDefault();
              actions.moveMarker(
                event.id,
                key.key === "Home"
                  ? 0
                  : key.key === "End"
                    ? TOTAL_FRAMES - 1
                    : event.frame +
                      (key.key === "ArrowLeft" ? -1 : 1) *
                        (key.shiftKey ? 128 : 1),
              );
            }}
          >
            {event.kind === "set" ? (
              <DiamondIcon aria-hidden="true" />
            ) : (
              <TrendingUpIcon aria-hidden="true" />
            )}
          </Button>
        ))}
      </div>
      {selected ? (
        <FieldSet className="lab-event-editor">
          <FieldLegend>
            {selected.kind === "set" ? "Set" : "Ramp"} gain{" "}
            {selected.processor === 20 ? "A" : "B"}
          </FieldLegend>
          <FieldGroup className="lab-event-fields">
            <Field>
              <FieldLabel htmlFor="event-choice">Event</FieldLabel>
              <NativeSelect
                id="event-choice"
                aria-label="Selected event"
                value={selected.id}
                onChange={(event) =>
                  actions.selectEvent(Number(event.target.value))
                }
              >
                {state.config.events.map((event, index) => (
                  <NativeSelectOption key={event.id} value={event.id}>
                    {index + 1} · {event.processor === 20 ? "A" : "B"}{" "}
                    {event.kind} @ {event.frame}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-source">Source</FieldLabel>
              <NativeSelect
                id="event-source"
                value={selected.processor}
                onChange={(event) =>
                  actions.editEvent(
                    selected.id,
                    "processor",
                    Number(event.target.value),
                  )
                }
              >
                <NativeSelectOption value={20}>A</NativeSelectOption>
                <NativeSelectOption value={40}>B</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-frame">At sample</FieldLabel>
              <NumberInput
                key={`frame-${selected.id}`}
                id="event-frame"
                value={selected.frame}
                min={0}
                max={TOTAL_FRAMES - 1}
                step={1}
                onDraft={actions.stop}
                onCommit={(value) =>
                  actions.editEvent(selected.id, "frame", value)
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="event-value">Value</FieldLabel>
              <NumberInput
                key={`value-${selected.id}`}
                id="event-value"
                value={selected.value}
                min={-1}
                max={1}
                step={0.01}
                onDraft={actions.stop}
                onCommit={(value) =>
                  actions.editEvent(selected.id, "value", value)
                }
              />
            </Field>
            {selected.kind === "ramp" && (
              <Field>
                <FieldLabel htmlFor="event-end">End sample</FieldLabel>
                <NumberInput
                  key={`end-${selected.id}`}
                  id="event-end"
                  value={selected.end}
                  min={selected.frame + 1}
                  max={TOTAL_FRAMES - 1}
                  step={1}
                  onDraft={actions.stop}
                  onCommit={(value) =>
                    actions.editEvent(selected.id, "end", value)
                  }
                />
              </Field>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="outline" onClick={inspect}>
                Inspect exact sample
              </Button>
              <Button
                variant="ghost"
                onClick={() => actions.removeEvent(selected.id)}
              >
                Remove
              </Button>
            </div>
          </FieldGroup>
          <FieldDescription>
            {selected.kind === "set"
              ? `Applied before sample ${selected.frame.toLocaleString()}. This is offset ${selected.frame % state.config.partition} inside block ${Math.floor(selected.frame / state.config.partition)}.`
              : `Starts at ${selected.frame.toLocaleString()}, reaches ${selected.value.toFixed(2)} at ${selected.end.toLocaleString()} inclusive. Duration ${selected.end - selected.frame} sample intervals.`}{" "}
            Same-frame events follow insertion order.
          </FieldDescription>
        </FieldSet>
      ) : (
        <p className="lab-caption">
          Add an event at the cursor. Select source A or B in the graph to
          choose its target. Maximum 16 events.
        </p>
      )}
    </section>
  );
}

function WindowMeter({
  state,
  className,
}: {
  state: LabState;
  className?: string;
}) {
  const output = trace(state.result, 70);
  const start = Math.floor(state.cursor / 64) * 64,
    end = Math.min(TOTAL_FRAMES, start + 64);
  const meter = output ? levels(output, start, end) : { peak: 0, rms: 0 };
  return (
    <div className={cn("lab-meter", className)}>
      <div>
        <span>Cursor window peak</span>
        <code>
          {meter.peak
            ? `${(20 * Math.log10(meter.peak)).toFixed(1)} dBFS`
            : "−∞ dBFS"}
        </code>
      </div>
      <Progress
        aria-label="Offline peak level"
        value={Math.min(1, meter.peak) * 100}
      />
      <code>
        Offline RMS {meter.rms.toFixed(4)} · [{start}, {end})
      </code>
    </div>
  );
}

function Transport({ state, actions }: LabProps) {
  return (
    <footer className="lab-transport" aria-label="Playback controls">
      <div className="flex items-center gap-2">
        <Button
          disabled={
            state.renderStatus !== "ready" || state.playback !== "stopped"
          }
          onClick={() => void actions.play()}
        >
          <PlayIcon data-icon="inline-start" aria-hidden="true" />
          Play mix
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Stop playback"
          disabled={state.playback === "stopped"}
          onClick={actions.stop}
        >
          <SquareIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="lab-playback-status">
        <strong>
          {state.playback === "playing"
            ? state.muted
              ? "Replaying · muted"
              : "Replaying engine output"
            : "Offline engine replay"}
        </strong>
        <p>
          {state.playback === "playing"
            ? `${(state.cursor / SAMPLE_RATE).toFixed(3)} / 2.000 s · estimated replay cursor`
            : state.playbackNote}
        </p>
      </div>
      <WindowMeter state={state} />
      <FieldGroup className="lab-monitor">
        <Field>
          <FieldLabel id="volume-label" htmlFor="volume">
            Listening volume <code aria-hidden="true">{state.volume}%</code>
          </FieldLabel>
          <Slider
            id="volume"
            aria-labelledby="volume-label"
            min={0}
            max={50}
            step={1}
            value={[state.volume]}
            onValueChange={(values) =>
              actions.setVolume(Array.isArray(values) ? values[0] : values)
            }
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="mute"
            checked={state.muted}
            onCheckedChange={actions.setMuted}
          />
          <FieldLabel htmlFor="mute">Mute</FieldLabel>
        </Field>
      </FieldGroup>
    </footer>
  );
}

export function LabApp() {
  const lab = useLab();
  const { state, actions } = lab;
  const theme = useAppearance();
  const scope = useRef<HTMLCanvasElement>(null);
  const comparison = useRef<HTMLOutputElement>(null);
  function showScope() {
    document.getElementById("scope-title")?.scrollIntoView({ block: "start" });
    scope.current?.focus({ preventScroll: true });
  }
  function inspect() {
    const event = state.config.events.find(
      (item) => item.id === state.selectedEvent,
    );
    if (!event) return;
    actions.setSpan(32);
    actions.scrub(event.frame);
    showScope();
  }
  function guide() {
    if (state.lesson === 2) {
      actions.compare();
      comparison.current?.scrollIntoView({ block: "center" });
      comparison.current?.focus({ preventScroll: true });
      return;
    }
    actions.setSpan(state.lesson === 0 ? TOTAL_FRAMES : 256);
    if (state.lesson === 1) {
      const event =
        state.config.events.find((item) => item.id === state.selectedEvent) ??
        state.config.events[0];
      actions.scrub(event?.frame ?? state.cursor);
    }
    showScope();
  }
  const status =
    state.renderStatus === "ready"
      ? "Rust / Wasm · ready"
      : state.renderStatus === "failed"
        ? "Render failed"
        : state.renderStatus === "dragging"
          ? "Move event · release to render"
          : "Rendering a fresh plan…";
  return (
    <div className="lab-page">
      <a className="lab-skip-link" href="#scope">
        Skip to sample microscope
      </a>
      <header className="lab-header">
        <div>
          <a className="lab-wordmark" href="/lab">
            KKB / AUDIO
          </a>
          <h1>Audio engine lab</h1>
          <p>Follow a signal. Change a sample. Hear the difference.</p>
        </div>
        <div className="lab-header-tools">
          <Badge variant="outline" role="status">
            {state.renderStatus === "ready" && <CheckIcon aria-hidden="true" />}
            {status}
          </Badge>
          <code>48,000 Hz · mono · 2 seconds</code>
        </div>
      </header>
      <main>
        <section className="lab-experiments" aria-label="Guided experiments">
          <div className="lab-experiment-nav">
            <span className="lab-meta">Try an experiment</span>
            <ToggleGroup
              value={[String(state.lesson)]}
              onValueChange={(values) => {
                if (values[0]) actions.loadLesson(Number(values[0]));
              }}
              variant="outline"
              className="lab-lessons"
              aria-label="Choose an experiment"
            >
              {experiments.map((title, index) => (
                <ToggleGroupItem key={title} value={String(index)}>
                  <code>{String(index + 1).padStart(2, "0")}</code>
                  {title}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button
              variant="ghost"
              onClick={() => actions.loadLesson(state.lesson)}
            >
              <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
              Reset
            </Button>
          </div>
          <div className="lab-lesson-copy">
            <p>{lessonCopy(state)}</p>
            <Button variant="link" onClick={guide}>
              {
                [
                  "Show the beat envelope",
                  "Inspect the gain change",
                  "Compare the samples",
                ][state.lesson]
              }
              <ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        </section>
        {state.renderError && (
          <Alert variant="destructive" className="mb-5">
            <AlertTitle>Render unavailable</AlertTitle>
            <AlertDescription>{state.renderError}</AlertDescription>
          </Alert>
        )}
        <Graph {...lab} />
        <Sources {...lab} />
        <Scope {...lab} dark={theme.dark} canvasRef={scope} />
        <Separator />
        <Events {...lab} dark={theme.dark} inspect={inspect} />
        <Separator />
        <section
          className="lab-partitions"
          aria-label="Render partition experiment"
        >
          <div>
            <h2>Render partitions</h2>
            <p>How many samples the offline driver requests per call.</p>
          </div>
          <div className="lab-partition-controls">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="partition">Block size</FieldLabel>
              <NativeSelect
                id="partition"
                value={state.config.partition}
                onChange={(event) =>
                  actions.setPartition(Number(event.target.value))
                }
              >
                {[17, 64, 128, 257, 1024].map((size) => (
                  <NativeSelectOption key={size} value={size}>
                    {size.toLocaleString()} frames
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              disabled={
                state.renderStatus === "pending" ||
                state.renderStatus === "dragging"
              }
              onClick={actions.compare}
            >
              Compare partitions
            </Button>
          </div>
          <output ref={comparison} tabIndex={-1} className="lab-comparison">
            {state.comparing
              ? "Rendering both partitions…"
              : state.renderStatus !== "ready"
                ? "Updated samples are not ready for comparison."
                : state.result?.comparison === null
                  ? "Compare a second render using a different block size."
                  : state.result?.comparison === 0
                    ? `Exact match · 672,000 node samples · ${state.result.partition} vs ${state.result.partition === 128 ? 257 : 128} frames/call`
                    : `Maximum sample difference: ${state.result?.comparison}`}
          </output>
        </section>
      </main>
      <Transport {...lab} />
      <div className="lab-evidence">
        <span>Rust compiler → Wasm offline render → Web Audio replay</span>
        <span>
          {state.result
            ? `96,000 frames · ${state.result.partition}-frame calls · ${state.result.renderMs.toFixed(0)} ms offline render`
            : "Preparing the compiled plan"}
        </span>
        <a
          className={cn(buttonVariants({ variant: "link", size: "sm" }))}
          href="/developer/plan"
        >
          Open the worklet proof
        </a>
      </div>
    </div>
  );
}
