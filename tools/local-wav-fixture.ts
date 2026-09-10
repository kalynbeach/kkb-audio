// Test/reproduction fixture generation only; playback never reads a whole file.
export function wavFixture(bits: 16 | 24, channels: 1 | 2, sampleRate: number, frames: number, audible = false): Uint8Array<ArrayBuffer> {
  const width = bits / 8;
  const dataBytes = frames * channels * width;
  const bytes = new Uint8Array(44 + dataBytes + (dataBytes & 1));
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true); view.setUint16(34, bits, true); text(36, "data"); view.setUint32(40, dataBytes, true);
  const scale = 2 ** (bits - 1);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const integer = audible
      ? Math.round(Math.sin(2 * Math.PI * (channel === 0 ? 220 : 330) * frame / sampleRate) * 0.02 * scale)
      : [-scale, scale - 1, -1, 0, scale / 2][(frame + channel * 2) % 5]!;
    const start = 44 + (frame * channels + channel) * width;
    for (let byte = 0; byte < width; byte++) bytes[start + byte] = (integer >> (byte * 8)) & 255;
  }
  return bytes;
}
export function expectedWavSample(bits: 16 | 24, frame: number, channel: number): number {
  const scale = 2 ** (bits - 1);
  return [-scale, scale - 1, -1, 0, scale / 2][(frame + channel * 2) % 5]! / scale * 0.5;
}
if (import.meta.main) {
  const [path, rate = "48000", bits = "24", channels = "2", seconds = "10"] = Bun.argv.slice(2);
  if (!path || !["44100", "48000"].includes(rate) || !["16", "24"].includes(bits) || !["1", "2"].includes(channels) || !(Number(seconds) > 0 && Number(seconds) <= 600)) throw new Error("usage: bun tools/local-wav-fixture.ts PATH [44100|48000] [16|24] [1|2] [seconds <= 600]");
  await Bun.write(path, wavFixture(Number(bits) as 16 | 24, Number(channels) as 1 | 2, Number(rate), Math.round(Number(rate) * Number(seconds)), true));
  console.log(`Wrote ${path}: peak source amplitude 0.02; playback compiled gain 0.5. Lower system volume before Play.`);
}
