import { LocalMedia, PreparedRateConverter, PreparedMediaLoop, initSync } from "./generated/kkb_audio.js";
import { isPcmStreamConfig } from "./pcm-protocol";
import { fillDeterministic } from "./pcm-worker-pool";
import { LocalPcmProducer } from "./local-pcm-producer";

// Bound reads independently of transport capacity without fragmenting refills
// into many serial File operations (at most 8 KiB for float32 stereo).
const WAV_READ_FRAMES = 1024;

let producer: LocalPcmProducer | undefined;
let file: File | undefined;
let media: LocalMedia | undefined;
let converter: PreparedRateConverter | undefined;
let memory: WebAssembly.Memory | undefined;
let outputRate: number | undefined;
let transport: MessagePort | undefined;
type LoopRequest = { a: number; b: number };
type LoopChange = LoopRequest & { enabled: boolean; edit: boolean };
let mediaLoop: PreparedMediaLoop | undefined;
let loopReadRevision = 0n;
let latestSeek: { epoch: number; target: number; loop?: LoopRequest; recovery?: boolean; loopChange?: LoopChange } | undefined;
let reportedUnderruns = 0;
async function feedLoop(): Promise<void> {
  const loop = mediaLoop!;
  if (loop.read_revision() !== loopReadRevision) {
    loopReadRevision = loop.read_revision();
    media!.seek_loop(loop.source_frames_read());
  }
  const needed = Math.min(loop.input_frames_needed(), WAV_READ_FRAMES);
  if (!needed) return;
  media!.request(needed);
  const started = performance.now();
  while (media!.available_frames() === 0) {
    if (latestSeek) return;
    if (performance.now() - started > 30000 || !media!.length()) throw new Error("Loop reconstruction timed out or truncated");
    const bytes = await readWindow(Number(media!.offset()), media!.length());
    if (latestSeek) return;
    media!.accept(bytes);
  }
  if (!latestSeek) loop.push(media!.take(needed));
}
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
type LoopTransition = { pcmFrame: number; loopEnabled?: boolean; pauseRequired?: boolean };
let transitionReply: ((value: LoopTransition) => void) | undefined;
let loopPause: { epoch: number; resolve: () => void } | undefined;

function transition(type: "begin-seek" | "finish-seek", epoch: number, target: number, extra: Record<string, unknown> = {}): Promise<LoopTransition> {
  return new Promise(resolve => { transitionReply = resolve; transport!.postMessage({ type, epoch, target, ...extra }); });
}
async function runSeeks(): Promise<void> {
  if (seeking) return;
  seeking = true;
  try {
    while (latestSeek) {
      await producer!.quiesce();
      const request = latestSeek;
      latestSeek = undefined;
      const reply = await transition("begin-seek", request.epoch, request.target, { recovery: request.recovery === true, loopChange: request.loopChange });
      if (reply.pauseRequired) {
        // EOS was captured with PCM. No new supply/finish can precede confirmed
        // context suspension, even if a newer request is already waiting.
        await new Promise<void>(resolve => {
          loopPause = { epoch: request.epoch, resolve };
          self.postMessage({ type: "loop-ended", epoch: request.epoch });
        });
      }
      if (latestSeek) continue;
      let pcmFrame = reply.pcmFrame;
      if (request.loopChange) request.loop = reply.loopEnabled ? { a: request.loopChange.a, b: request.loopChange.b } : undefined;
      if (request.loop) {
        if (!request.recovery) {
          mediaLoop?.free();
          mediaLoop = new PreparedMediaLoop(media!.sample_rate(), outputRate!, media!.channels(), media!.total_frames(), BigInt(request.loop.a), BigInt(request.loop.b));
          loopReadRevision = 0n;
          const continuation = mediaLoop.continuation_source_frame();
          if (continuation !== undefined) {
            media!.prepare_loop_anchor(continuation);
            const started = performance.now();
            while (!media!.loop_anchor_ready(continuation) && !latestSeek) {
              if (performance.now() - started > 30000 || !media!.length()) throw new Error("Loop anchor preparation timed out or truncated");
              const bytes = await readWindow(Number(media!.offset()), media!.length());
              if (latestSeek) break;
              media!.accept(bytes);
            }
            if (latestSeek) { media!.cancel_loop_anchor(); continue; }
          } else media!.clear_loop_anchor();
          while (!mediaLoop.head_ready() && !latestSeek) { await feedLoop(); mediaLoop.prepare_head(); }
          if (latestSeek) continue;
        }
        pcmFrame = Number(request.loopChange ? converter!.seek_output_frame(BigInt(pcmFrame)) : converter!.seek(BigInt(request.target)));
        mediaLoop!.start(BigInt(pcmFrame));
        producer!.totalPcmFrames = Number.MAX_SAFE_INTEGER;
        producer!.loopRegion = { a: Number(mediaLoop!.pcm_a()), b: Number(mediaLoop!.pcm_b()) };
        transport!.postMessage({ type: "loop-head", epoch: request.epoch, recovery: request.recovery === true,
          a: Number(mediaLoop!.pcm_a()), b: Number(mediaLoop!.pcm_b()), left: mediaLoop!.head_sample(0), right: mediaLoop!.head_sample(1) });
      } else {
        const hadLoop = mediaLoop !== undefined;
        mediaLoop?.free(); mediaLoop = undefined;
        media!.clear_loop_anchor();
        if(request.loopChange)converter!.seek_output_frame(BigInt(pcmFrame));else converter!.seek(BigInt(request.target));
        media!.seek(converter!.source_frames_read());
        producer!.totalPcmFrames = Number(converter!.total_pcm_frames());
        producer!.loopRegion = undefined;
        if (hadLoop) transport!.postMessage({ type: "loop-head", epoch: request.epoch, disabled: true });
      }
      const ready = new Promise<void>(resolve => { seekReady = resolve; });
      producer!.reset(request.epoch, pcmFrame);
      await ready;
      seekReady = undefined;
      if (latestSeek) continue;
      await transition("finish-seek", request.epoch, request.target);
      if (!latestSeek) {
        const actualMediaFrame = Math.min(Number(media!.total_frames()), Math.floor(pcmFrame * media!.sample_rate() / outputRate!));
        const result = actualMediaFrame !== request.target ? "Adjusted" : media!.anchor_and_discard() || media!.sample_rate() !== outputRate ? "AnchorAndDiscard" : "Exact";
        self.postMessage({ type: "seek-complete", epoch: request.epoch, requestedFrame: request.loopChange ? actualMediaFrame : request.target, pcmFrame, result, loopEnabled: request.loop !== undefined });
      }
    }
  } catch (error) { fail(error); }
  finally { seeking = false; }
}
const fail = (error: unknown) => self.postMessage({ type: "worker-failed", code: 70, detail: typeof error === "number" ? error === 72 ? "Unsupported or malformed MP3 (72): expected bounded MPEG-1 Layer III mono/stereo 44100/48000 Hz with consistent frames and metadata." : error === 74 ? "Nonfinite PCM or conversion range exceeded (74): conversion requires sample magnitudes at most 1e30. Samples are never normalized or clipped." : error === 71 ? "Unsupported sample-rate conversion (71): expected same rate or 44100 ↔ 48000 Hz." : "Unsupported or malformed WAV: expected nonempty little-endian RIFF PCM16/24 or IEEE float32 mono/stereo with finite samples and consistent chunk bounds." : String(error) });
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
      if (value.loop && (!Number.isSafeInteger(value.loop.a) || !Number.isSafeInteger(value.loop.b) || value.loop.a < 0 || value.loop.a >= value.loop.b || value.loop.b > Number(media.total_frames()))) throw new Error("Invalid media loop");
      if (value.loopChange && (!Number.isSafeInteger(value.loopChange.a) || !Number.isSafeInteger(value.loopChange.b) || value.loopChange.a < 0 || value.loopChange.a >= value.loopChange.b || value.loopChange.b > Number(media.total_frames()) || typeof value.loopChange.enabled !== "boolean" || typeof value.loopChange.edit !== "boolean")) throw new Error("Invalid media loop change");
      media.cancel_loop_anchor();
      latestSeek = { epoch: value.epoch, target: value.target, loop: value.loop, recovery: value.recovery === true, loopChange: value.loopChange };
      self.postMessage({ type: "seek-accepted", epoch: value.epoch });
      seekReady?.();
      void runSeeks();
      return;
    }
    if (value.type === "loop-paused") {
      if (loopPause && loopPause.epoch === value.epoch) {
        const resolve = loopPause.resolve; loopPause = undefined; resolve();
      }
      return;
    }
    if (value.type === "activate") { producer?.activate(); return; }
    if (value.type === "stall") { producer?.stall(value.value === true); return; }
    if (value.type === "producer-status") {
      self.postMessage({ type: "producer-status", epoch: producer?.config.epoch, polls: producer?.polls, preparedPcmFrames: producer?.preparedPcmFrames, initialAdmittedBlocks: producer?.initialAdmittedBlocks, admittedPcmFrames: producer?.admittedPcmFrames, rejections: producer?.rejections, maxPollDelayMilliseconds: producer?.maxPollDelayMilliseconds, loopRestorePackets: media ? Number(media.loop_restore_packets()) : 0, sourceFramesRead: converter ? Number(converter.source_frames_read()) : undefined }); return;
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
        if (mediaLoop) {
          while (written < frames && !latestSeek) {
            await feedLoop();
            if (latestSeek) return;
            const copied = Math.min(mediaLoop.available_frames(), frames - written);
            for (let channel = 0; channel < config.channelCount; channel++) output.set(new Float32Array(memory!.buffer, mediaLoop.output_ptr(channel), copied), channel * config.slotFrames + written);
            mediaLoop.consume(copied);
            written += copied;
          }
          return;
        }
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
      } else {
        if (message.data?.type === "supply" && message.data.loopUnderruns > reportedUnderruns) {
          reportedUnderruns = message.data.loopUnderruns;
          self.postMessage({ type: "loop-underrun", epoch: producer!.config.epoch, count: reportedUnderruns });
        }
        producer?.accept(message.data);
      }
    };
    port.start();
    producer.start();
  } catch (error) { fail(error); }
};
