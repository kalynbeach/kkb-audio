import { LocalWav, initSync } from "./generated/kkb_audio.js";
import { isPcmStreamConfig } from "./pcm-protocol";
import { fillDeterministic } from "./pcm-worker-pool";
import { LocalPcmProducer } from "./local-pcm-producer";

let producer: LocalPcmProducer | undefined;
let file: File | undefined;
let wav: LocalWav | undefined;
const fail = (error: unknown) => self.postMessage({ type: "worker-failed", code: 70, detail: typeof error === "number" ? "Unsupported or malformed WAV: expected nonempty little-endian RIFF PCM16/24 mono/stereo with consistent chunk bounds." : String(error) });
self.onmessage = async (event: MessageEvent) => {
  try {
    const value = event.data;
    if (value.type === "inspect") {
      if (wav !== undefined || !(value.file instanceof File)) throw new Error("invalid file");
      initSync({ module: value.module });
      file = value.file;
      wav = new LocalWav(BigInt(file!.size));
      while (wav.length() !== 0) {
        const offset = Number(wav.offset());
        wav.accept(new Uint8Array(await file!.slice(offset, offset + wav.length()).arrayBuffer()));
      }
      if (wav.sample_rate() !== value.sampleRate) throw new Error(`source ${wav.sample_rate()} Hz does not match active host ${value.sampleRate} Hz`);
      self.postMessage({ type: "metadata", channelCount: wav.channels(), totalFrames: Number(wav.total_frames()), sampleRate: wav.sample_rate() });
      return;
    }
    if (value.type === "activate") { producer?.activate(); return; }
    if (value.type === "stall") { producer?.stall(value.value === true); return; }
    if (value.type === "producer-status") {
      self.postMessage({ type: "producer-status", polls: producer?.polls, readFrames: producer?.readFrames, initialAdmittedBlocks: producer?.initialAdmittedBlocks, admittedFrames: producer?.admittedFrames, rejections: producer?.rejections, maxPollDelayMilliseconds: producer?.maxPollDelayMilliseconds }); return;
    }
    if (producer !== undefined || value.type !== "initialize" || !isPcmStreamConfig(value.config) || !(value.port instanceof MessagePort)) throw new Error("invalid initialization");
    const config = value.config;
    const port: MessagePort = value.port;
    producer = new LocalPcmProducer(config, wav ? Number(wav.total_frames()) : Number.MAX_SAFE_INTEGER,
      async (buffer, start, frames) => {
        if (!wav || !file) { fillDeterministic(buffer, config, start); return; }
        const offset = Number(wav.data_offset()) + start * wav.block_align();
        const bytes = new Uint8Array(await file.slice(offset, offset + frames * wav.block_align()).arrayBuffer());
        if (bytes.length !== frames * wav.block_align()) throw new Error("truncated WAV payload");
        const decoded = wav.decode(bytes);
        const output = new Float32Array(buffer);
        for (let channel = 0; channel < config.channelCount; channel += 1) output.set(decoded.subarray(channel * frames, (channel + 1) * frames), channel * config.slotFrames);
      },
      (message, transfer = []) => port.postMessage(message, transfer),
      () => self.postMessage({ type: "worker-ready", slotCount: config.slotCount, initialAdmittedBlocks: producer!.initialAdmittedBlocks }),
      fail);
    port.onmessage = message => producer?.accept(message.data);
    port.start();
    producer.start();
  } catch (error) { fail(error); }
};
