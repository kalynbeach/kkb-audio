// Authored device-free coverage. Explicit resample prevents LAME low-bitrate MPEG-2 fallback.
import { wavFixture } from "./local-wav-fixture";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const temporary = await mkdtemp(`${tmpdir()}/kkb-loop-fixtures-`);
await mkdir("tools/fixtures/mp3", { recursive: true });
try {
  for (const rate of [44100, 48000]) for (const channels of [1, 2] as const) {
    const wav = `${temporary}/source.wav`;
    await Bun.write(wav, wavFixture(16, channels, rate, rate));
    const args = ["lame", "--silent", "--resample", String(rate / 1000), "-m", channels === 1 ? "m" : "s", "-b", "32", "-p", wav, `tools/fixtures/mp3/loop-crc-${rate}-${channels}.mp3`];
    const result = Bun.spawnSync(args, { stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    if (rate === 48000 && channels === 2) {
      const dual = Bun.spawnSync(["lame", "--silent", "--resample", "48", "-m", "d", "-b", "128", wav, "tools/fixtures/mp3/loop-dual-48000-2.mp3"], { stderr: "pipe" });
      if (dual.exitCode !== 0) throw new Error(dual.stderr.toString());
    }
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
