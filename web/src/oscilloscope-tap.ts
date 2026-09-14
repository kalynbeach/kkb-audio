export const OSCILLOSCOPE_SAMPLES = 2048;
export type OscilloscopeRead = 1 | 2 | "warming" | "unavailable";
export type OscilloscopeBuffers = readonly [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];

/** Private, untagged browser history of worklet output, before listening gain.
 * Readiness is only a freshness gate: these samples have no source/frame tags. */
export class OscilloscopeTap {
  #splitter: ChannelSplitterNode | undefined;
  #analysers: AnalyserNode[] = [];
  #mute: GainNode | undefined;
  #eligibleAt = Infinity;
  #disposed = false;

  constructor(private readonly context: AudioContext, private readonly source: AudioNode,
    private readonly channels: 1 | 2) {
    try {
      this.#splitter = new ChannelSplitterNode(context, { numberOfOutputs: channels });
      this.#mute = new GainNode(context, { gain: 0 });
      for (let channel = 0; channel < channels; channel++) {
        const analyser = new AnalyserNode(context, { fftSize: OSCILLOSCOPE_SAMPLES });
        this.#analysers.push(analyser);
        this.#splitter.connect(analyser, channel);
        analyser.connect(this.#mute);
      }
      this.#mute.connect(context.destination);
      source.connect(this.#splitter);
      this.restartWarmup();
    } catch (error) { this.dispose(); throw error; }
  }

  restartWarmup(): void {
    // Full trailing window plus the prepared adapter's maximum callback budget.
    // Context time advances only with rendering; wall time during pause cannot qualify.
    this.#eligibleAt = this.context.currentTime + (OSCILLOSCOPE_SAMPLES + 1024) / this.context.sampleRate;
  }

  read(buffers: OscilloscopeBuffers): OscilloscopeRead {
    if (this.#disposed) return "unavailable";
    if (this.context.state !== "running" || this.context.currentTime < this.#eligibleAt) return "warming";
    try {
      for (let channel = 0; channel < this.channels; channel++) {
        if (buffers[channel]!.length !== OSCILLOSCOPE_SAMPLES) throw new Error("Invalid oscilloscope buffer");
        this.#analysers[channel]!.getFloatTimeDomainData(buffers[channel]!);
      }
      return this.channels;
    } catch { this.dispose(); return "unavailable"; }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // A failed observation must never disconnect the audible/proof output.
    const disconnect = (node: AudioNode | undefined) => { try { node?.disconnect(); } catch { /* visual-only cleanup */ } };
    try { if (this.#splitter) this.source.disconnect(this.#splitter); } catch { /* partial setup */ }
    disconnect(this.#splitter);
    for (const analyser of this.#analysers) disconnect(analyser);
    disconnect(this.#mute);
    this.#analysers = [];
  }
}
