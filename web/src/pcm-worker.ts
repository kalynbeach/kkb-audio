import { LocalWav, PreparedRateConverter, initSync } from "./generated/kkb_audio.js";
import { isPcmStreamConfig } from "./pcm-protocol";
import { fillDeterministic } from "./pcm-worker-pool";
import { LocalPcmProducer } from "./local-pcm-producer";

let producer: LocalPcmProducer | undefined;
let file: File | undefined;
let wav: LocalWav | undefined;
let converter: PreparedRateConverter | undefined;
let memory: WebAssembly.Memory | undefined;
let outputRate: number | undefined;
const fail = (error: unknown) => self.postMessage({ type: "worker-failed", code: 70, detail: typeof error === "number" ? error === 71 ? "Unsupported sample-rate conversion (71): expected same rate or 44100 ↔ 48000 Hz." : "Unsupported or malformed WAV: expected nonempty little-endian RIFF PCM16/24 mono/stereo with consistent chunk bounds." : String(error) });
self.onmessage = async (event: MessageEvent) => {
  try {
    const value = event.data;
    if (value.type === "inspect") {
      if (wav !== undefined || !(value.file instanceof File)) throw new Error("invalid file");
      memory = (initSync({ module: value.module }) as { memory: WebAssembly.Memory }).memory;
      file = value.file;
      wav = new LocalWav(BigInt(file!.size));
      while (wav.length() !== 0) {
        const offset = Number(wav.offset());
        wav.accept(new Uint8Array(await file!.slice(offset, offset + wav.length()).arrayBuffer()));
      }
      outputRate = value.sampleRate;
      converter = new PreparedRateConverter(wav.sample_rate(), value.sampleRate, wav.channels(), wav.total_frames());
      self.postMessage({ type: "metadata", channelCount: wav.channels(), totalFrames: Number(wav.total_frames()), sampleRate: wav.sample_rate(), totalPcmFrames: Number(converter.total_pcm_frames()) });
      return;
    }
    if (value.type === "activate") { producer?.activate(); return; }
    if (value.type === "stall") { producer?.stall(value.value === true); return; }
    if (value.type === "producer-status") {
      self.postMessage({ type: "producer-status", polls: producer?.polls, preparedPcmFrames: producer?.preparedPcmFrames, initialAdmittedBlocks: producer?.initialAdmittedBlocks, admittedPcmFrames: producer?.admittedPcmFrames, rejections: producer?.rejections, maxPollDelayMilliseconds: producer?.maxPollDelayMilliseconds, sourceFramesRead: converter ? Number(converter.source_frames_read()) : undefined }); return;
    }
    if (producer !== undefined || value.type !== "initialize" || !isPcmStreamConfig(value.config) || !(value.port instanceof MessagePort)) throw new Error("invalid initialization");
    const config = value.config;
    if (wav && (config.sampleRate !== outputRate || config.channelCount !== wav.channels())) throw new Error("WAV initialization does not match prepared conversion");
    const port: MessagePort = value.port;
    producer = new LocalPcmProducer(config, converter ? Number(converter.total_pcm_frames()) : Number.MAX_SAFE_INTEGER,
      async (buffer, start, frames) => {
        if (!wav || !file) { fillDeterministic(buffer, config, start); return; }
        const output = new Float32Array(buffer);
        let written = 0;
        while (written < frames) {
          const needed = Math.min(converter!.input_frames_needed(), config.slotFrames);
          if (needed > 0) {
            const offset = Number(wav.data_offset()) + Number(converter!.source_frames_read()) * wav.block_align();
            const bytes = new Uint8Array(await file.slice(offset, offset + needed * wav.block_align()).arrayBuffer());
            if (bytes.length !== needed * wav.block_align()) throw new Error("truncated WAV payload");
            converter!.push(wav.decode(bytes));
          }
          const copied = Math.min(converter!.available_frames(), frames - written);
          for (let channel = 0; channel < config.channelCount; channel += 1) {
            output.set(new Float32Array(memory!.buffer, converter!.output_ptr(channel), copied), channel * config.slotFrames + written);
          }
          converter!.consume(copied);
          written += copied;
        }
      },
      (message, transfer = []) => port.postMessage(message, transfer),
      () => self.postMessage({ type: "worker-ready", slotCount: config.slotCount, initialAdmittedBlocks: producer!.initialAdmittedBlocks }),
      fail);
    port.onmessage = message => producer?.accept(message.data);
    port.start();
    producer.start();
  } catch (error) { fail(error); }
};
