import { LocalMedia, PreparedRateConverter, initSync } from "./generated/kkb_audio.js";
import { isPcmStreamConfig } from "./pcm-protocol";
import { fillDeterministic } from "./pcm-worker-pool";
import { LocalPcmProducer } from "./local-pcm-producer";

// Bound reads independently of transport capacity without fragmenting refills
// into many serial File operations (at most 6 KiB for PCM24 stereo).
const WAV_READ_FRAMES = 1024;

let producer: LocalPcmProducer | undefined;
let file: File | undefined;
let media: LocalMedia | undefined;
let converter: PreparedRateConverter | undefined;
let memory: WebAssembly.Memory | undefined;
let outputRate: number | undefined;
let transport: MessagePort | undefined;
let latestSeek: { epoch: number; target: number } | undefined;
let seeking = false;
let seekReady: (() => void) | undefined;
let cachedBytes = new Uint8Array(0);
let cachedOffset = 0;
let steps = 0;
async function readEncoded(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return new Uint8Array(await Promise.race([
      file!.slice(offset, Math.min(file!.size, offset + length)).arrayBuffer(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("MP3 file read timed out")), 30000); }),
    ]));
  } finally { clearTimeout(timer); }
}
async function readWindow(offset: number, length: number): Promise<Uint8Array> {
  if (!media?.anchor_and_discard()) return new Uint8Array(await file!.slice(offset, offset + length).arrayBuffer());
  if (++steps % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  if (offset < cachedOffset || offset + length > cachedOffset + cachedBytes.length) {
    cachedOffset = offset;
    cachedBytes = await readEncoded(offset, 65536);
  }
  return cachedBytes.subarray(offset - cachedOffset, offset - cachedOffset + length);
}
let transitionReply: ((value: { pcmFrame: number }) => void) | undefined;

function transition(type: "begin-seek" | "finish-seek", epoch: number, target: number): Promise<{ pcmFrame: number }> {
  return new Promise(resolve => { transitionReply = resolve; transport!.postMessage({ type, epoch, target }); });
}
async function runSeeks(): Promise<void> {
  if (seeking) return;
  seeking = true;
  try {
    while (latestSeek) {
      await producer!.quiesce();
      const request = latestSeek;
      latestSeek = undefined;
      const { pcmFrame } = await transition("begin-seek", request.epoch, request.target);
      if (latestSeek) continue;
      converter!.seek(BigInt(request.target));
      media!.seek(converter!.source_frames_read());
      const ready = new Promise<void>(resolve => { seekReady = resolve; });
      producer!.reset(request.epoch, pcmFrame);
      await ready;
      seekReady = undefined;
      if (latestSeek) continue;
      await transition("finish-seek", request.epoch, request.target);
      if (!latestSeek) {
        const actualMediaFrame = Math.min(Number(media!.total_frames()), Math.floor(pcmFrame * media!.sample_rate() / outputRate!));
        const result = actualMediaFrame !== request.target ? "Adjusted" : media!.anchor_and_discard() || media!.sample_rate() !== outputRate ? "AnchorAndDiscard" : "Exact";
        self.postMessage({ type: "seek-complete", epoch: request.epoch, requestedFrame: request.target, pcmFrame, result });
      }
    }
  } catch (error) { fail(error); }
  finally { seeking = false; }
}
const fail = (error: unknown) => self.postMessage({ type: "worker-failed", code: 70, detail: typeof error === "number" ? error === 72 ? "Unsupported or malformed MP3 (72): expected bounded MPEG-1 Layer III mono/stereo 44100/48000 Hz with consistent frames and metadata." : error === 71 ? "Unsupported sample-rate conversion (71): expected same rate or 44100 ↔ 48000 Hz." : "Unsupported or malformed WAV: expected nonempty little-endian RIFF PCM16/24 mono/stereo with consistent chunk bounds." : String(error) });
self.onmessage = async (event: MessageEvent) => {
  try {
    const value = event.data;
    if (value.type === "inspect") {
      if (media !== undefined || !(value.file instanceof File)) throw new Error("invalid file");
      memory = (initSync({ module: value.module }) as { memory: WebAssembly.Memory }).memory;
      file = value.file;
      const magic = new Uint8Array(await file!.slice(0, 4).arrayBuffer());
      media = new LocalMedia(BigInt(file!.size), !(magic[0] === 82 && magic[1] === 73 && magic[2] === 70 && magic[3] === 70));
      if (media.anchor_and_discard()) self.postMessage({ type: "inspection-started", timeoutMilliseconds: 35000 });
      const inspectionStarted = performance.now();
      while (media.length() !== 0) {
        const offset = Number(media.offset());
        if (media.anchor_and_discard() && performance.now() - inspectionStarted > 30000) throw new Error("MP3 inspection timed out");
        media.accept(await readWindow(offset, media.length()));
      }
      outputRate = value.sampleRate;
      converter = new PreparedRateConverter(media.sample_rate(), value.sampleRate, media.channels(), media.total_frames());
      self.postMessage({ type: "metadata", channelCount: media.channels(), totalFrames: Number(media.total_frames()), sampleRate: media.sample_rate(), totalPcmFrames: Number(converter.total_pcm_frames()), anchorAndDiscard: media.anchor_and_discard() });
      media.seek(0n);
      return;
    }
    if (value.type === "seek") {
      if (!producer || !media || !Number.isSafeInteger(value.epoch) || value.epoch <= producer.config.epoch || !Number.isSafeInteger(value.target) || value.target < 0 || value.target > Number(media.total_frames())) throw new Error("invalid seek");
      latestSeek = { epoch: value.epoch, target: value.target };
      self.postMessage({ type: "seek-accepted", epoch: value.epoch });
      seekReady?.();
      void runSeeks();
      return;
    }
    if (value.type === "activate") { producer?.activate(); return; }
    if (value.type === "stall") { producer?.stall(value.value === true); return; }
    if (value.type === "producer-status") {
      self.postMessage({ type: "producer-status", epoch: producer?.config.epoch, polls: producer?.polls, preparedPcmFrames: producer?.preparedPcmFrames, initialAdmittedBlocks: producer?.initialAdmittedBlocks, admittedPcmFrames: producer?.admittedPcmFrames, rejections: producer?.rejections, maxPollDelayMilliseconds: producer?.maxPollDelayMilliseconds, sourceFramesRead: converter ? Number(converter.source_frames_read()) : undefined }); return;
    }
    if (producer !== undefined || value.type !== "initialize" || !isPcmStreamConfig(value.config) || !(value.port instanceof MessagePort)) throw new Error("invalid initialization");
    const config = value.config;
    if (media && (config.sampleRate !== outputRate || config.channelCount !== media.channels())) throw new Error("Media initialization does not match prepared conversion");
    const port: MessagePort = value.port;
    transport = port;
    producer = new LocalPcmProducer(config, converter ? Number(converter.total_pcm_frames()) : Number.MAX_SAFE_INTEGER,
      async (buffer, start, frames) => {
        if (!media || !file) { fillDeterministic(buffer, config, start); return; }
        const output = new Float32Array(buffer);
        let written = 0;
        while (written < frames) {
          const needed = Math.min(converter!.input_frames_needed(), WAV_READ_FRAMES);
          if (needed > 0) {
            media.request(needed);
            const started = performance.now();
            while (media.available_frames() === 0) {
              if (latestSeek) return;
              if (media.anchor_and_discard() && performance.now() - started > 30000) throw new Error("MP3 reconstruction timed out");
              if (media.length() === 0) throw new Error("truncated media payload");
              media.accept(await readWindow(Number(media.offset()), media.length()));
            }
            if (latestSeek) return;
            converter!.push(media.take(needed));
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
      () => {
        if (seeking) seekReady?.();
        else self.postMessage({ type: "worker-ready", slotCount: config.slotCount, initialAdmittedBlocks: producer!.initialAdmittedBlocks });
      },
      fail);
    port.onmessage = message => {
      if (message.data?.type === "seek-transition") {
        const resolve = transitionReply; transitionReply = undefined; resolve?.(message.data);
      } else producer?.accept(message.data);
    };
    port.start();
    producer.start();
  } catch (error) { fail(error); }
};
