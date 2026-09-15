// Source-frame spans, not output frames or listening gain. No per-file normalization.
export const MAX_WAVEFORM_BINS = 4096;
export type SourceWaveform = {
  totalFrames: number;
  sourceRate: number;
  framesPerBin: number;
  extrema: Float32Array;
};

export class WaveformAccumulator {
  readonly framesPerBin: number;
  readonly extrema: Float32Array;
  #position = 0;
  constructor(readonly totalFrames: number, readonly sourceRate: number) {
    if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || !Number.isSafeInteger(sourceRate) || sourceRate <= 0) throw new Error("Invalid waveform timeline");
    this.framesPerBin = Math.ceil(totalFrames / MAX_WAVEFORM_BINS);
    this.extrema = new Float32Array(Math.ceil(totalFrames / this.framesPerBin) * 2);
    for (let bin = 0; bin < this.extrema.length; bin += 2) {
      this.extrema[bin] = Infinity; this.extrema[bin + 1] = -Infinity;
    }
  }
  // LocalMedia.take returns compact planar PCM, including partial packet tails.
  push(pcm: Float32Array, channels: number): void {
    const frames = pcm.length / channels;
    if ((channels !== 1 && channels !== 2) || !Number.isInteger(frames) || frames < 1 || frames > 1024 || this.#position + frames > this.totalFrames) throw new Error("Invalid waveform chunk");
    for (let frame = 0; frame < frames; frame++) {
      const bin = Math.floor((this.#position + frame) / this.framesPerBin) * 2;
      for (let channel = 0; channel < channels; channel++) {
        const sample = pcm[channel * frames + frame]!;
        if (!Number.isFinite(sample)) throw new Error("Nonfinite source PCM");
        this.extrema[bin] = Math.min(this.extrema[bin]!, sample);
        this.extrema[bin + 1] = Math.max(this.extrema[bin + 1]!, sample);
      }
    }
    this.#position += frames;
  }
  finish(): SourceWaveform {
    if (this.#position !== this.totalFrames) throw new Error("Incomplete source waveform");
    return { totalFrames: this.totalFrames, sourceRate: this.sourceRate, framesPerBin: this.framesPerBin, extrema: this.extrema };
  }
}

/** Each display column covers an equal source-time interval. Include every bin
 * intersecting that interval, including boundary overlaps and the final partial bin. */
export function waveformPath(summary: SourceWaveform, maximumColumns = 160): string {
  const columns = Math.min(maximumColumns, summary.extrema.length / 2);
  const paths: string[] = [];
  for (let column = 0; column < columns; column++) {
    const first = Math.floor(column * summary.totalFrames / columns / summary.framesPerBin);
    const end = Math.min(summary.extrema.length / 2, Math.ceil((column + 1) * summary.totalFrames / columns / summary.framesPerBin));
    let min = Infinity, max = -Infinity;
    for (let bin = first; bin < end; bin++) {
      min = Math.min(min, summary.extrema[bin * 2]!);
      max = Math.max(max, summary.extrema[bin * 2 + 1]!);
    }
    // Fixed full-scale display; MP3 overshoot clips visually, never in the summary.
    const top = 20 - Math.min(1, Math.max(-1, max)) * 17;
    const bottom = 20 - Math.min(1, Math.max(-1, min)) * 17;
    paths.push(`M${((column + 0.5) * 320 / columns).toFixed(2)},${top.toFixed(2)}v${Math.max(0.5, bottom - top).toFixed(2)}`);
  }
  return paths.join("");
}
