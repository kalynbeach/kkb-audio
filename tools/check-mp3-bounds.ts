// Device-free worst-duration stepping/reconstruction probe. No whole-track PCM.
import { LocalMedia, initSync } from "../web/src/generated/kkb_audio.js";
const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
const source = new Uint8Array(await Bun.file("tools/fixtures/mp3/cbr-48000-2.mp3").arrayBuffer());
// Repeating the first independently decodable audio frame is explicitly synthetic,
// not an encoded-music or independent-timeline oracle. 25,000*1152 = 600 seconds.
const bytes = new Uint8Array(25000 * 384);
for (let p = 0; p < bytes.length; p += 384) bytes.set(source.subarray(384, 768), p);
const reader = new LocalMedia(BigInt(bytes.length), true);
const fixedMemory = memory.buffer;
let steps = 0;
const step = () => { const p = Number(reader.offset()); reader.accept(bytes.subarray(p,p+reader.length())); steps++; };
try {
  const start = performance.now();
  while (reader.length()) step();
  const inspectionMs = performance.now() - start;
  if (reader.total_frames() !== 28800000n) throw new Error("wrong bound timeline");
  reader.seek(28799999n);
  const seeking = performance.now();
  reader.request(1);
  while (!reader.available_frames()) step();
  const reconstructionMs = performance.now()-seeking;
  if (reader.take(1).length !== 2 || memory.buffer !== fixedMemory || memory.buffer.byteLength !== 16777216) throw new Error("bound/memory failed");
  console.log(JSON.stringify({ encodedBytes: bytes.length, packets: 25000, sourceFrames: 28800000, inspectionMs, reconstructionMs, steps, fixedMemoryBytes: memory.buffer.byteLength }));
  const tooLong = new Uint8Array(bytes.length+384); tooLong.set(bytes); tooLong.set(bytes.subarray(0,384),bytes.length);
  const bad = new LocalMedia(BigInt(tooLong.length),true);
  let rejected = false;
  try { while(bad.length()) { const p = Number(bad.offset()); bad.accept(tooLong.subarray(p,p+bad.length())); } } catch { rejected = true; } finally { bad.free(); }
  if (!rejected) throw new Error("over-duration stream accepted");
} finally { reader.free(); }
