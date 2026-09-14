import { expect, test } from "bun:test";
import { LocalMedia, PreparedRateConverter, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import type { PcmBlockMessage } from "../web/src/pcm-protocol";

const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
function reference(bytes: Uint8Array, rate: number): Float32Array[] {
  const wav = new LocalMedia(BigInt(bytes.length), true);
  while (wav.length()) { const offset = Number(wav.offset()); wav.accept(bytes.subarray(offset, offset + wav.length())); }
  wav.seek(0n);
  const converter = new PreparedRateConverter(wav.sample_rate(), rate, wav.channels(), wav.total_frames());
  const output = Array.from({ length: wav.channels() }, () => new Float32Array(Number(converter.total_pcm_frames())));
  let written = 0;
  try {
    while (written < output[0]!.length) {
      const needed = Math.min(239, converter.input_frames_needed());
      if (needed) {
        wav.request(needed);
        while (!wav.available_frames()) { const offset = Number(wav.offset()); wav.accept(bytes.subarray(offset,offset+wav.length())); }
        converter.push(wav.take(needed));
      }
      const copied = Math.min(17, converter.available_frames());
      output.forEach((plane, channel) => plane.set(new Float32Array(memory.buffer, converter.output_ptr(channel), copied), written));
      converter.consume(copied); written += copied;
    }
    return output;
  } finally { converter.free(); wav.free(); }
}

function vbriVariant(input: Uint8Array, scaled: boolean): Uint8Array<ArrayBuffer> {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);
  if (scaled) {
    view.setUint16(54, 2); view.setUint16(56, 5); view.setUint16(60, 4);
    view.setUint32(62, Math.floor(4 * 384 / 5)); view.setUint32(66, Math.floor(3 * 384 / 5));
  } else {
    view.setUint32(46, 1); view.setUint32(50, 1); view.setUint32(62, 1);
  }
  return bytes;
}

test("MP3 actual worker/Wasm seeks: uninterrupted reference, paused reclamation, superseding reads/admissions, EOS and finite ownership", async () => {
  const originalSelf = globalThis.self;
  for (const name of ["cbr-44100-1", "cbr-44100-2", "vbr-44100-1", "vbr-44100-2", "cbr-48000-1", "cbr-48000-2", "vbr-48000-1", "vbr-48000-2", "crc", "vbri", "vbri-advisory", "vbri-scaled", "short", "long"]) {
    for (const outputRate of [44100,48000]) {
      const fixture = name.startsWith("vbri-") ? "vbri" : name === "long" ? "cbr-48000-2" : name;
      let bytes = new Uint8Array(await Bun.file(`tools/fixtures/mp3/${fixture}.mp3`).arrayBuffer());
      if (name.startsWith("vbri-")) bytes = vbriVariant(bytes, name === "vbri-scaled");
      if (name === "long") { const packet = bytes.slice(384,768); bytes = new Uint8Array(384*250); for(let p=0;p<bytes.length;p+=384) bytes.set(packet,p); }
      const inspected = new LocalMedia(BigInt(bytes.length),true);
      while(inspected.length()) { const p = Number(inspected.offset()); inspected.accept(bytes.subarray(p,p+inspected.length())); }
      const sourceRate = inspected.sample_rate(), channels = inspected.channels() as 1|2, total = Number(inspected.total_frames()); inspected.free();
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
      type WorkerMessage = { type: string; epoch?: number; detail?: string; result?: string };
      const messages: WorkerMessage[] = [];
      const host = { onmessage: undefined as ((event: { data: unknown }) => Promise<void>) | undefined, postMessage: (message: WorkerMessage) => messages.push(message) };
      Object.defineProperty(globalThis, "self", { configurable: true, value: host });
      await import(`data:text/javascript;base64,${Buffer.from((await Bun.file("web/dist/pcm-worker.js").text()) + `\n// mp3 seek ${name} ${sourceRate} ${outputRate} ${total}`).toString("base64")}`);
      const send = (data: unknown) => host.onmessage!({ data });
      const wait = async (condition: () => boolean) => {
        const deadline = performance.now() + 3000;
        while (!condition()) {
          if (messages.some(message => message.type === "worker-failed") || performance.now() > deadline) throw new Error(JSON.stringify(messages));
          await Bun.sleep(1);
        }
      };
      const expected = reference(bytes, outputRate);
      if (name !== "long" && outputRate === sourceRate) {
        const independent = new Float32Array(await Bun.file(`tools/fixtures/mp3/${fixture}.f32`).arrayBuffer());
        expect(independent.length).toBe(total*channels);
        let maxError = 0;
        for(let c=0;c<channels;c++) for(let f=0;f<total;f++) maxError = Math.max(maxError,Math.abs(expected[c]![f]!-independent[f*channels+c]!));
        expect(maxError).toBeLessThanOrEqual(1e-5);
      }
      await send({ type: "inspect", file: new ControlledFile([bytes], "seek.mp3"), module, sampleRate: outputRate });
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
        const completion = messages.find(message => message.type === "seek-complete" && message.epoch === wanted)!;
        expect(completion.result).toBe(Math.min(total,Math.floor(Math.ceil(target*outputRate/sourceRate)*sourceRate/outputRate)) !== target ? "Adjusted" : "AnchorAndDiscard");
        return wanted;
      };
      try {
        await send({ type: "initialize", config: { channelCount: channels, sampleRate: outputRate, sourceId: 3, epoch, slotCount: 4, slotFrames: 1024 }, port: channel.port1 });
        await wait(() => messages.some(message => message.type === "worker-ready"));
        adapter.process([Array.from({ length: channels }, () => new Float32Array(17))]);
        for (const target of (name === "long" ? [total-1,total,1] : [Math.floor(total / 2), 0, total - 1, total, 1, 0])) {
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
          if (name === "long") {
            holdRead = true;
            const obsolete = ++epoch;
            await send({ type: "seek", epoch: obsolete, target: total-1024 });
            await wait(() => releaseRead !== undefined);
            await send({ type: "seek", epoch: ++epoch, target: 3000 });
            const wanted = ++epoch;
            await send({ type: "seek", epoch: wanted, target: 1176 });
            releaseRead!(); releaseRead = undefined;
            await wait(() => messages.some(message => message.type === "seek-complete" && message.epoch === wanted));
            expect(messages.some(message => message.type === "seek-complete" && message.epoch === obsolete)).toBe(false);
          }
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
        expect(Math.max(...reads)).toBeLessThanOrEqual(65536);
        expect(memory.buffer.byteLength).toBe(16777216);
      } finally {
        releaseRead?.(); releaseAdmission?.();
        await send({ type: "stall", value: true });
        channel.port1.close(); channel.port2.close(); kernel.free();
        Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
      }
    }
  }
}, 20000);

test("compiled MP3 inspector rejects corrupt/config-changing/truncated metadata and accepts missing optional trim", async () => {
  const bytes = new Uint8Array(await Bun.file("tools/fixtures/mp3/cbr-48000-2.mp3").arrayBuffer());
  const inspect = (input: Uint8Array) => {
    const reader = new LocalMedia(BigInt(input.length),true);
    try { while(reader.length()) { const p=Number(reader.offset()); reader.accept(input.subarray(p,p+reader.length())); } return Number(reader.total_frames()); }
    finally { reader.free(); }
  };
  for(const n of [0,1,9,127,383,bytes.length-1]) expect(()=>inspect(bytes.subarray(0,n))).toThrow();
  for(const [offset,value] of [[1,0xf3],[2,0x98],[3,0xc4],[43,255],[47,8],[51,1],[60,255],[384,0],[386,0x90],[387,0xc4],[177,0xf0],[178,255],[179,255],[190,1]] as const) {
    const bad = bytes.slice(); bad[offset]=value; expect(()=>inspect(bad)).toThrow();
  }
  expect(inspect(bytes.subarray(384))).toBe(8064);
  const missing=bytes.slice(); missing.fill(0,40,384); expect(inspect(missing)).toBe(8064);
  const corrupt=bytes.slice(); corrupt.fill(255,388,420); expect(()=>inspect(corrupt)).toThrow();
  expect(memory.buffer.byteLength).toBe(16777216);
});

test("compiled MP3 VBRI uses scan fallback for advisory declarations but rejects malformed structure/audio", async () => {
  const bytes = new Uint8Array(await Bun.file("tools/fixtures/mp3/vbri.mp3").arrayBuffer());
  const expected = reference(bytes, 48000);
  expect(expected[0]!.length).toBe(8064);
  for (const offset of [46, 50, 62]) for (const value of [0, 1, 0xffffffff]) {
    const advisory = bytes.slice(); new DataView(advisory.buffer).setUint32(offset, value);
    expect(reference(advisory, 48000)).toEqual(expected);
  }
  expect(reference(vbriVariant(bytes, true), 48000)).toEqual(expected);
  const inspect = (input: Uint8Array) => {
    const reader = new LocalMedia(BigInt(input.length), true);
    try { while (reader.length()) { const p = Number(reader.offset()); reader.accept(input.subarray(p, p + reader.length())); } }
    finally { reader.free(); }
  };
  for (const [offset, value] of [[40, 2], [54, 0], [54, 300], [56, 0], [58, 0], [58, 5], [60, 0]] as const) {
    const bad = bytes.slice(); new DataView(bad.buffer).setUint16(offset, value);
    expect(() => inspect(bad)).toThrow();
  }
  expect(() => inspect(bytes.subarray(0, bytes.length - 1))).toThrow();
  const bad = bytes.slice(); bad[384] = 0;
  expect(() => inspect(bad)).toThrow();
  expect(memory.buffer.byteLength).toBe(16777216);
});
