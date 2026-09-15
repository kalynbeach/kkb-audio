// Device-free authored signals. Run with Bun 1.4.0, FFmpeg 9.0.1, LAME 4.0.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const out = "tools/fixtures/mp3";
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(`${tmpdir()}/kkb-mp3-fixtures-`);
function run(args: string[]) { const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }); if (p.exitCode) throw new Error(p.stderr.toString()); }
try {
  for (const rate of [44100, 48000]) for (const channels of [1, 2]) for (const mode of ["cbr", "vbr"]) {
    const name = `${mode}-${rate}-${channels}`;
    const expr = channels === 1 ? "0.1*sin(2*PI*440*t)" : "0.1*sin(2*PI*440*t)|0.1*sin(2*PI*659*t)";
    run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=${rate}:d=0.137`, "-c:a", "pcm_s16le", `${tmp}/source.wav`]);
    run(["lame", "--silent", ...(mode === "cbr" ? ["-b", "128"] : ["-V", "2"]), `${tmp}/source.wav`, `${out}/${name}.mp3`]);
    run(["ffmpeg", "-v", "error", "-y", "-i", `${out}/${name}.mp3`, "-f", "f32le", `${out}/${name}.f32`]);
  }
  for (const [name, frames, flags] of [["short", 17, []], ["crc", 6576, ["-p"]]] as const) {
    run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*659*t):s=48000", "-af", `atrim=end_sample=${frames}`, "-c:a", "pcm_s16le", `${tmp}/source.wav`]);
    run(["lame", "--silent", "-b", "128", ...flags, `${tmp}/source.wav`, `${out}/${name}.mp3`]);
    run(["ffmpeg", "-v", "error", "-y", "-i", `${out}/${name}.mp3`, "-f", "f32le", `${out}/${name}.f32`]);
  }
  // Construct a version-1 VBRI metadata frame over unmodified LAME audio packets.
  // Use AndroidX media's post-metadata byte origin for both count and table.
  // FFmpeg skips this metadata frame and ignores VBRI delay. This constructed
  // example does not establish encoder byte origins or scaled-table rounding.
  const original = new Uint8Array(await Bun.file(`${out}/cbr-48000-2.mp3`).arrayBuffer());
  const vbri = original.slice(); vbri.fill(0, 4, 384);
  vbri.set(new TextEncoder().encode("VBRI"), 36);
  const view = new DataView(vbri.buffer);
  const audioBytes = vbri.length - 384;
  view.setUint16(40, 1); view.setUint32(46, audioBytes);
  const count = new DataView(original.buffer).getUint32(44);
  view.setUint32(50, count); view.setUint16(54, 1); view.setUint16(56, 1); view.setUint16(58, 4); view.setUint16(60, count); view.setUint32(62, audioBytes);
  await Bun.write(`${out}/vbri.mp3`, vbri);
  run(["ffmpeg", "-v", "error", "-y", "-i", `${out}/vbri.mp3`, "-f", "f32le", `${out}/vbri.f32`]);
} finally { rmSync(tmp, { recursive: true }); }
