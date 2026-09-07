export const SAMPLE_RATE = 48_000;
export const TOTAL_FRAMES = 96_000;
export type Processor = 10 | 20 | 30 | 40 | 50 | 60 | 70;
export interface LabEvent {
  id: number;
  processor: 20 | 40;
  frame: number;
  kind: "set" | "ramp";
  value: number;
  end: number;
}
export interface LabConfig {
  frequencyA: number;
  frequencyB: number;
  gainA: number;
  gainB: number;
  partition: number;
  events: LabEvent[];
}
export interface LabOperation {
  id: Processor;
  kind: number;
  inputs: number[];
  value: number;
}
export interface LabResult {
  request: number;
  operations: LabOperation[];
  traces: Float32Array[];
  observation: number[];
  partition: number;
  renderMs: number;
  comparison: number | null;
}
export interface LabRequest {
  request: number;
  config: LabConfig;
  compare?: boolean;
}

export function lesson(index: number): LabConfig {
  const base = {
    frequencyA: 220,
    frequencyB: 224,
    gainA: 0.3,
    gainB: 0.3,
    partition: 128,
    events: [] as LabEvent[],
  };
  if (index === 1)
    return {
      ...base,
      frequencyB: 330,
      gainB: 0.12,
      events: [
        {
          id: 1,
          processor: 20,
          frame: 24017,
          kind: "set",
          value: 0.08,
          end: 0,
        },
      ],
    };
  if (index === 2)
    return {
      ...base,
      frequencyB: 330,
      events: [
        {
          id: 1,
          processor: 20,
          frame: 24017,
          kind: "ramp",
          value: 0.02,
          end: 24529,
        },
      ],
    };
  return base;
}

export function eventWords(events: LabEvent[]): Float64Array {
  return Float64Array.from(
    events.flatMap((e) => [
      e.processor,
      e.frame,
      e.kind === "set" ? 1 : 2,
      e.value,
      e.kind === "set" ? 0 : e.end,
    ]),
  );
}

/** Read metadata from the actual canonical description returned by the Rust compiler. */
export function decodeOperations(words: Uint32Array): LabOperation[] {
  if (words[0] !== 2 || words[6] !== 7 || words.length < 64)
    throw new Error("Unsupported compiled lab description");
  const view = new DataView(words.buffer, words.byteOffset, words.byteLength);
  return Array.from({ length: words[6] }, (_, slot) => {
    const offset = 8 + slot * 8;
    const kind = words[offset];
    return {
      id: words[offset + 1] as Processor,
      kind,
      inputs:
        kind === 1
          ? []
          : kind === 3
            ? [words[offset + 3], words[offset + 4]]
            : [words[offset + 3]],
      value: view.getFloat64((offset + 5) * 4, true),
    };
  });
}

export function moveEvent(event: LabEvent, frame: number): LabEvent {
  const duration = event.kind === "ramp" ? event.end - event.frame : 0;
  const next = Math.max(
    0,
    Math.min(TOTAL_FRAMES - 1 - duration, Math.round(frame)),
  );
  return {
    ...event,
    frame: next,
    end: event.kind === "ramp" ? next + duration : 0,
  };
}

export function windowStart(cursor: number, span: number): number {
  return Math.max(
    0,
    Math.min(TOTAL_FRAMES - span, Math.round(cursor - span / 2)),
  );
}

export function levels(
  samples: Float32Array,
  start: number,
  end: number,
): { peak: number; rms: number } {
  let peak = 0,
    squares = 0;
  for (let i = start; i < end; i++) {
    const value = samples[i];
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
  }
  return { peak, rms: Math.sqrt(squares / Math.max(1, end - start)) };
}
