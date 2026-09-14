import { expect, test } from "bun:test";
import { drawOscilloscope, OscilloscopeHistory, OSCILLOSCOPE_INTERVAL, oscilloscopePalettes } from "../src/oscilloscope-render";

test("oscilloscope history is exactly three reusable windows / 48 KiB with bounded vertices and paired palettes", () => {
  const history = new OscilloscopeHistory();
  const retained = history.windows.flat();
  expect(retained.reduce((sum, array) => sum + array.byteLength, 0)).toBe(49152);
  for (let i = 0; i < 100; i++) { history.destination[0].fill(0.25); history.destination[1].fill(-0.25); history.accept(2); }
  expect(history.count).toBe(3); expect(history.windows.flat()).toEqual(retained);
  expect(OSCILLOSCOPE_INTERVAL).toBeGreaterThanOrEqual(1000 / 30);
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 4 } });
  let vertices = 0; const dashes: number[][] = []; const fills: string[] = [];
  const context = { fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1,
    fillRect() { fills.push(this.fillStyle); }, setLineDash(value: number[]) { dashes.push(value); },
    beginPath() {}, moveTo() { vertices++; }, lineTo() { vertices++; }, stroke() {} };
  const canvas = { width: 0, height: 0, clientWidth: 5000, clientHeight: 5000 };
  try {
    for (const dark of [false, true]) {
      vertices = 0;
      drawOscilloscope(canvas as HTMLCanvasElement, context as unknown as CanvasRenderingContext2D, history, dark);
      expect(vertices).toBe(12290); // 12288 signal vertices, two baseline vertices.
      expect(canvas.width).toBe(760); expect(canvas.height).toBe(1000);
      expect(fills.at(-1)).toBe(oscilloscopePalettes[dark ? "dark" : "light"].surface);
    }
    expect(dashes.some(dash => dash.join() === "8,6")).toBe(true);
    history.clear(); vertices = 0;
    drawOscilloscope(canvas as HTMLCanvasElement, context as unknown as CanvasRenderingContext2D, history, false);
    expect(vertices).toBe(2); expect(history.count).toBe(0);
    history.destination[0][0] = NaN; history.accept(1);
    expect(() => drawOscilloscope(canvas as HTMLCanvasElement, context as unknown as CanvasRenderingContext2D, history, false)).toThrow("Invalid oscilloscope observation");
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
