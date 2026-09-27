// Adapted from kalynbeach/kkb's oscilloscope/modes/xy.ts.
export const MAX_SCOPE_SAMPLES = 2048;

/** Reuses a bounded buffer. Mono repeats on both axes; stereo maps left to X, right to Y. */
export function createPlaybackXy(gain: number) {
  const points = new Float32Array(MAX_SCOPE_SAMPLES * 2);
  let active = points.subarray(0, 0);
  const sample = (value: number) => Number.isFinite(value) ? Math.max(-1, Math.min(1, value * gain)) : 0;
  return (left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>, channels: 1 | 2, width = 1, height = 1) => {
    const y = channels === 1 ? left : right;
    const count = Math.min(MAX_SCOPE_SAMPLES, left.length, y.length);
    // Clip space spans both viewport dimensions. Fit both axes to its smaller dimension.
    const xScale = Math.min(1, height / width);
    const yScale = Math.min(1, width / height);
    if (active.length !== count * 2) active = points.subarray(0, count * 2);
    for (let index = 0; index < count; index += 1) {
      active[index * 2] = sample(left[index]!) * xScale;
      active[index * 2 + 1] = sample(y[index]!) * yScale;
    }
    return active;
  };
}
