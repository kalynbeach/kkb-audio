/** Public demonstration media. This is a WAV file, decoded by the real playback path. */
export function createSyntheticStudy(): File {
  const rate = 48_000;
  const frames = rate * 30;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / rate;
    const fade = Math.min(1, time / 0.1, (30 - time) / 0.1);
    const phase = time * 2 * Math.PI * 110;
    const drift = 0.75 * Math.sin(time * 0.6);
    const left = Math.sin(phase) * 0.7 + Math.sin(phase * 3) * 0.2;
    const right = Math.cos(phase + drift) * 0.7 + Math.cos(phase * 2) * 0.2;
    view.setInt16(44 + frame * 4, Math.round(left * fade * 32767), true);
    view.setInt16(46 + frame * 4, Math.round(right * fade * 32767), true);
  }
  return new File([bytes], "Synthetic stereo study.wav", { type: "audio/wav" });
}
