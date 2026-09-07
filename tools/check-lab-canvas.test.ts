import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { drawScope } from "../web/src/lab-canvas.ts";
import { lesson, TOTAL_FRAMES } from "../web/src/lab-model.ts";
import type { LabState } from "../web/src/use-lab.ts";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

test.each([0, 12_000])(
  "fractional-width scope bins stay inside the window starting at %i",
  (viewStart) => {
    type Point = [number, number];
    let points: Point[] = [];
    const waveforms: Point[][] = [];
    // Record the real drawing path; no pixels or DSP are simulated.
    const context = {
      lineWidth: 0,
      setTransform() {},
      clearRect() {},
      fillText() {},
      arc() {},
      fill() {},
      beginPath() {
        points = [];
      },
      moveTo(x: number, y: number) {
        points.push([x, y]);
      },
      lineTo(x: number, y: number) {
        points.push([x, y]);
      },
      stroke() {
        if (this.lineWidth === 1.2) waveforms.push(points);
      },
    };
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 380.5, 354);
    Object.defineProperty(canvas, "getContext", { value: () => context });
    const samples = new Float32Array(TOTAL_FRAMES);
    const state: LabState = {
      config: lesson(0),
      lesson: 0,
      selected: 20,
      connection: null,
      selectedEvent: null,
      cursor: viewStart,
      span: 2048,
      viewStart,
      blocks: false,
      result: {
        request: 1,
        operations: ([20, 40, 70] as const).map((id) => ({
          id, kind: 2, inputs: [], value: 1,
        })),
        traces: [samples, samples, samples],
        observation: [],
        partition: 128,
        renderMs: 0,
        comparison: null,
      },
      peaks: [1, 1, 1],
      renderStatus: "ready",
      renderError: null,
      comparing: false,
      playback: "stopped",
      playbackNote: "",
      volume: 15,
      muted: true,
    };
    const draw = () => {
      waveforms.length = 0;
      drawScope(canvas, state);
      expect(waveforms).toHaveLength(3);
      return waveforms.map((path) => path.slice(-2));
    };
    const silent = draw();
    expect(silent).toEqual([
      [[362, 82], [362, 82]],
      [[362, 182], [362, 182]],
      [[362, 282], [362, 282]],
    ]);

    samples[viewStart + state.span] = 1;
    expect(draw()).toEqual(silent);

    samples[viewStart + state.span - 1] = 1;
    expect(draw()).toEqual([
      [[362, 43], [362, 82]],
      [[362, 143], [362, 182]],
      [[362, 243], [362, 282]],
    ]);
  },
);
