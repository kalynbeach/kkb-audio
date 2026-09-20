import { expect, test } from "bun:test";
import { LocalWav, PreparedRateConverter, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import { wavFixture } from "./local-wav-fixture";
import type { PcmBlockMessage } from "../web/src/pcm-protocol";

const module = await WebAssembly.compile(await Bun.file("public/audio-runtime/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
function reference(bytes: Uint8Array, rate: number): Float32Array[] {
  const wav = new LocalWav(BigInt(bytes.length));
  while (wav.length()) { const offset = Number(wav.offset()); wav.accept(bytes.subarray(offset, offset + wav.length())); }
  const converter = new PreparedRateConverter(wav.sample_rate(), rate, wav.channels(), wav.total_frames());
  const output = Array.from({ length: wav.channels() }, () => new Float32Array(Number(converter.total_pcm_frames())));
  let written = 0;
  try {
    while (written < output[0]!.length) {
      const needed = Math.min(239, converter.input_frames_needed());
      if (needed) {
        const offset = Number(wav.data_offset()) + Number(converter.source_frames_read()) * wav.block_align();
        converter.push(wav.decode(bytes.subarray(offset, offset + needed * wav.block_align())));
      }
      const copied = Math.min(17, converter.available_frames());
      output.forEach((plane, channel) => plane.set(new Float32Array(memory.buffer, converter.output_ptr(channel), copied), written));
      converter.consume(copied); written += copied;
    }
    return output;
  } finally { converter.free(); wav.free(); }
}

test("actual worker/Wasm seeks: uninterrupted reference, paused reclamation, superseding reads/admissions, EOS and finite ownership", async () => {
  const originalSelf = globalThis.self;
  for (const [sourceRate, outputRate, bits, channels] of [[44100, 48000, 24, 2], [48000, 44100, 16, 1], [48000, 48000, 24, 2]] as const) {
    for (const total of [1, 17, 10003]) {
      let releaseRead: (() => void) | undefined;
      let holdRead = false;
      const reads: number[] = [];
      class ControlledFile extends File {
        override slice(start = 0, end = this.size): Blob {
          reads.push(end - start);
          const blob = super.slice(start, end);
          if (!holdRead || start < 44) return blob;
          holdRead = false;
          return { arrayBuffer: async () => { await new Promise<void>(resolve => { releaseRead = resolve; }); return blob.arrayBuffer(); } } as Blob;
        }
      }
      type WorkerMessage = { type: string; epoch?: number; detail?: string };
      const messages: WorkerMessage[] = [];
      const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (message: WorkerMessage) => messages.push(message) };
      Object.defineProperty(globalThis, "self", { configurable: true, value: host });
      await import(`data:text/javascript;base64,${Buffer.from((await Bun.file("public/audio-runtime/pcm-worker.js").text()) + `\n// seek ${sourceRate} ${outputRate} ${total}`).toString("base64")}`);
      const send = (data: unknown) => host.onmessage!({ data });
      const wait = async (condition: () => boolean) => {
        const deadline = performance.now() + 3000;
        while (!condition()) {
          if (messages.some(message => message.type === "worker-failed") || performance.now() > deadline) throw new Error(JSON.stringify(messages));
          await Bun.sleep(1);
        }
      };
      const bytes = wavFixture(bits, channels, sourceRate, total);
      const expected = reference(bytes, outputRate);
      await send({ type: "inspect", file: new ControlledFile([bytes], "seek.wav"), module, sampleRate: outputRate });
      const kernel = new WorkletKernel(channels, outputRate, 3n, 1n, 1024, 1024);
      kernel.set_media_timeline(sourceRate, BigInt(total));
      const adapter = new PreparedPlanarAdapter(channels, kernel, memory, 1024);
      const channel = new MessageChannel();
      let holdAdmission = false;
      let releaseAdmission: (() => void) | undefined;
      const inFlight = new Set<number>();
      channel.port2.onmessage = event => {
        const value = event.data;
        if (value.type === "supply") { channel.port2.postMessage({ type: "supply", free: [0, 1, 2, 3].map(slot => kernel.slot_free(slot)) }); return; }
        if (value.type === "begin-seek" || value.type === "finish-seek") {
          const pcmFrame = value.type === "begin-seek" ? Number(kernel.begin_seek(BigInt(value.epoch), BigInt(value.target))) : Number(kernel.pcm_position());
          if (value.type === "finish-seek") expect(kernel.finish_seek(BigInt(value.epoch))).toBe(true);
          channel.port2.postMessage({ type: "seek-transition", epoch: value.epoch, pcmFrame }); return;
        }
        const block = value as PcmBlockMessage;
        expect(inFlight.has(block.slotId)).toBe(false); inFlight.add(block.slotId);
        const accepted = adapter.acceptBlock(block);
        const reply = () => { inFlight.delete(block.slotId); channel.port2.postMessage({ type: "admission-result", slotId: block.slotId, buffer: block.buffer, accepted }, [block.buffer]); };
        if (holdAdmission) { holdAdmission = false; releaseAdmission = reply; } else reply();
      };
      let epoch = 1;
      const seek = async (target: number) => {
        const wanted = ++epoch;
        await send({ type: "seek", epoch: wanted, target });
        await wait(() => messages.some(message => message.type === "seek-complete" && message.epoch === wanted));
        return wanted;
      };
      try {
        await send({ type: "initialize", config: { channelCount: channels, sampleRate: outputRate, sourceId: 3, epoch, slotCount: 4, slotFrames: 1024 }, port: channel.port1 });
        await wait(() => messages.some(message => message.type === "worker-ready"));
        adapter.process([Array.from({ length: channels }, () => new Float32Array(17))]);
        for (const target of [Math.floor(total / 2), 0, total - 1, total, 1, 0]) {
          const renderFrame = kernel.next_frame();
          await seek(target); // No process calls: old partial/queued slots must retire while paused.
          expect(kernel.next_frame()).toBe(renderFrame);
          expect(kernel.epoch()).toBe(BigInt(epoch));
          let position = Math.ceil(target * outputRate / sourceRate);
          expect(kernel.pcm_position()).toBe(BigInt(position));
          await send({ type: "activate" });
          let turn = 0;
          const deadline = performance.now() + 3000;
          while (!kernel.ended()) {
            const frames = [1, 17, 257, 1024][turn++ % 4]!;
            const output = Array.from({ length: channels }, () => new Float32Array(frames));
            adapter.process([output]);
            const next = Number(kernel.pcm_position());
            for (let ch = 0; ch < channels; ch++) for (let frame = 0; frame < frames; frame++) {
              expect(output[ch]![frame]).toBe(frame < next - position ? Math.fround(expected[ch]![position + frame]! * 0.5) : 0);
            }
            if (next === position) await Bun.sleep(1);
            position = next;
            if (performance.now() > deadline) throw new Error("seek tail timeout");
          }
          expect(position).toBe(expected[0]!.length);
          expect(kernel.source_position()).toBe(BigInt(total));
          expect(kernel.invalid_count()).toBe(0n);
        }
        if (total > 1000) {
          // Hold an actual asynchronous file read, then supersede preparation twice.
          holdRead = true;
          const obsolete = ++epoch;
          await send({ type: "seek", epoch: obsolete, target: 123 });
          await wait(() => releaseRead !== undefined);
          await send({ type: "seek", epoch: ++epoch, target: 7001 });
          const wanted = ++epoch;
          await send({ type: "seek", epoch: wanted, target: 1176 });
          releaseRead!(); releaseRead = undefined;
          await wait(() => messages.some(message => message.type === "seek-complete" && message.epoch === wanted));
          expect(messages.some(message => message.type === "seek-complete" && message.epoch === obsolete)).toBe(false);
          expect(kernel.pcm_position()).toBe(BigInt(Math.ceil(1176 * outputRate / sourceRate)));
          // Hold transfer return; a reset cannot lose/duplicate this slot or overtake its admission.
          holdAdmission = true;
          await send({ type: "seek", epoch: ++epoch, target: 3000 });
          await wait(() => releaseAdmission !== undefined);
          const finalEpoch = ++epoch;
          await send({ type: "seek", epoch: finalEpoch, target: 1 });
          releaseAdmission!(); releaseAdmission = undefined;
          await wait(() => messages.some(message => message.type === "seek-complete" && message.epoch === finalEpoch));
          const output = Array.from({ length: channels }, () => new Float32Array(17));
          const start = Number(kernel.pcm_position()); adapter.process([output]);
          for (let ch = 0; ch < channels; ch++) expect(output[ch]).toEqual(Float32Array.from(expected[ch]!.subarray(start, start + 17), value => value * 0.5));
        }
        await seek(total);
        expect([0, 1, 2, 3].every(slot => kernel.slot_free(slot))).toBe(true);
        expect(inFlight.size).toBe(0);
        expect(Math.max(...reads)).toBeLessThanOrEqual(6144);
        expect(memory.buffer.byteLength).toBe(16777216);
      } finally {
        releaseRead?.(); releaseAdmission?.();
        await send({ type: "stall", value: true });
        channel.port1.close(); channel.port2.close(); kernel.free();
        Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
      }
    }
  }
});
