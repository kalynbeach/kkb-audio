import { LocalMedia, initSync } from "./generated/kkb_audio.js";
import { WaveformAccumulator } from "./source-waveform";

// Independent decoder: never steals playback's source, converter or refill slots.
self.onmessage = async (event: MessageEvent) => {
  let media: LocalMedia | undefined;
  try {
    const { file, module, totalFrames, sourceRate } = event.data;
    if (!(file instanceof File)) throw new Error("Invalid waveform file");
    const { memory } = initSync({ module });
    const started = performance.now();
    let steps = 0, sliceStarted = started, lastProgress = started;
    const yieldWork = async () => {
      if (++steps >= 32 || performance.now() - sliceStarted >= 8) {
        await new Promise(resolve => setTimeout(resolve, 4));
        steps = 0; sliceStarted = performance.now();
      }
      if (performance.now() - lastProgress > 30000) throw new Error("Waveform scan stopped progressing");
    };
    const read = async (offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return new Uint8Array(await Promise.race([
          file.slice(offset, offset + length).arrayBuffer(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Waveform file read timed out")), 30000); }),
        ]));
      } finally { clearTimeout(timeout); }
    };
    let cache = new Uint8Array(0), cacheOffset = 0;
    const window = async (offset: number, length: number) => {
      await yieldWork();
      if (length > 65536) throw new Error("Waveform read exceeds window");
      if (offset < cacheOffset || offset + length > cacheOffset + cache.length) {
        cacheOffset = offset; cache = await read(offset, 65536);
      }
      const bytes = cache.subarray(offset - cacheOffset, offset - cacheOffset + length);
      if (bytes.length !== length) throw new Error("Truncated waveform source");
      return bytes;
    };
    const magic = await read(0, 4);
    media = new LocalMedia(BigInt(file.size), !(magic[0] === 82 && magic[1] === 73 && magic[2] === 70 && magic[3] === 70));
    while (media.length()) {
      media.accept(await window(Number(media.offset()), media.length()));
      lastProgress = performance.now();
    }
    if (Number(media.total_frames()) !== totalFrames || media.sample_rate() !== sourceRate) throw new Error("Waveform timeline does not match playback");
    const summary = new WaveformAccumulator(totalFrames, sourceRate);
    media.seek(0n);
    let position = 0;
    while (position < totalFrames) {
      await yieldWork();
      media.request(1024);
      while (!media.available_frames()) {
        if (!media.length()) throw new Error("Incomplete waveform PCM");
        media.accept(await window(Number(media.offset()), media.length()));
        lastProgress = performance.now();
      }
      const pcm = media.take(1024);
      summary.push(pcm, media.channels());
      position += pcm.length / media.channels();
      lastProgress = performance.now();
    }
    const result = summary.finish();
    self.postMessage({ type: "waveform-complete", summary: result, milliseconds: performance.now() - started, memoryBytes: memory.buffer.byteLength }, { transfer: [result.extrema.buffer] });
  } catch (error) {
    self.postMessage({ type: "waveform-failed", detail: String(error) });
  } finally { media?.free(); }
};
