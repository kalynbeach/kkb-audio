import { beforeAll, describe, expect, test } from "bun:test";
import { initSync, LabSession } from "../web/src/generated/kkb_audio.js";
import {
  eventWords,
  lesson,
  levels,
  moveEvent,
  TOTAL_FRAMES,
  windowStart,
} from "../web/src/lab-model.ts";
import { renderLab } from "../web/src/lab-render.ts";

beforeAll(async () => {
  const module = await WebAssembly.compile(
    await Bun.file(
      new URL("../web/dist/kkb_audio_bg.wasm", import.meta.url),
    ).arrayBuffer(),
  );
  initSync({ module });
});

describe("learning lab with actual Wasm", () => {
  test("the displayed plan, all taps, and the exact set sample agree", () => {
    const config = lesson(1),
      rendered = renderLab(config, 128);
    expect(rendered.operations.map((op) => [op.id, op.inputs])).toEqual([
      [10, []],
      [20, [0]],
      [30, []],
      [40, [2]],
      [50, [1, 3]],
      [60, [4]],
      [70, [5]],
    ]);
    for (const frame of [0, 1, 24016, 24017, 24018, 95999]) {
      const [oscA, gainA, oscB, gainB, mix, observe, output] =
        rendered.traces.map((t) => t[frame]);
      expect(oscA).toBeCloseTo(
        Math.sin((2 * Math.PI * 220 * frame) / 48000),
        5,
      );
      expect(gainA).toBe(
        Math.fround(oscA * Math.fround(frame < 24017 ? 0.3 : 0.08)),
      );
      expect(gainB).toBe(Math.fround(oscB * Math.fround(0.12)));
      expect(mix).toBe(Math.fround(gainA + gainB));
      expect(observe).toBe(mix);
      expect(output).toBe(mix);
    }
    expect(rendered.traces.every((t) => t.length === TOTAL_FRAMES)).toBe(true);
    expect(24017 % 128).toBe(81);
    const [start, end, peak, rms] = rendered.observation;
    expect([start, end]).toEqual([95936, 96000]);
    const measured = levels(rendered.traces[6], start, end);
    expect(measured.peak).toBe(peak);
    expect(measured.rms).toBe(rms);
  });

  test("ramp endpoints and all seven tapes are identical across driver partitions", () => {
    const config = lesson(2),
      reference = renderLab(config, 128);
    for (const partition of [17, 257, 1024]) {
      const other = renderLab(config, partition);
      for (let slot = 0; slot < 7; slot++)
        expect(
          Buffer.from(other.traces[slot].buffer).equals(
            Buffer.from(reference.traces[slot].buffer),
          ),
        ).toBe(true);
    }
    expect(reference.traces[1][24017]).toBe(
      Math.fround(reference.traces[0][24017] * Math.fround(0.3)),
    );
    expect(reference.traces[1][24529]).toBe(
      Math.fround(reference.traces[0][24529] * Math.fround(0.02)),
    );
  });

  test("invalid partitions, excessive events, and invalid values are rejected", () => {
    for (const partition of [0, -1, 1025, 1.5, NaN])
      expect(() => renderLab(lesson(0), partition)).toThrow();
    const settings = Float64Array.from([220, 224, 0.3, 0.3]);
    const excessive = Array.from({ length: 17 }, (_, id) => ({
      id,
      processor: 20 as const,
      frame: id,
      kind: "set" as const,
      value: 0.1,
      end: 0,
    }));
    expect(() => new LabSession(settings, eventWords(excessive))).toThrow();
    expect(
      () =>
        new LabSession(
          Float64Array.from([24000, 224, 0.3, 0.3]),
          new Float64Array(),
        ),
    ).toThrow();
  });
});

test("moving ramps retains their duration and remains inside the tape", () => {
  const event = lesson(2).events[0];
  expect(moveEvent(event, -20)).toEqual({ ...event, frame: 0, end: 512 });
  expect(moveEvent(event, TOTAL_FRAMES)).toEqual({
    ...event,
    frame: 95487,
    end: 95999,
  });
  expect(moveEvent(event, 257.4)).toEqual({ ...event, frame: 257, end: 769 });
  expect(windowStart(0, 2048)).toBe(0);
  expect(windowStart(95999, 2048)).toBe(93952);
});
