export type WavLoopRegion = { a: number; b: number; pcmA: number; pcmB: number; period: number; fade: number };
export type WavLoopState = { supported: boolean; enabled: boolean; phase: "Disabled" | "Preparing" | "Armed" | "Active" | "Failed"; region: WavLoopRegion | null; error: string | null };
/** Same ceil output grid as Rust PcmTimeline, not an accumulating fractional clock. */
export function wavLoopRegion(a: number, b: number, sourceRate: number, outputRate: number, totalFrames: number): WavLoopRegion {
  if (![a,b,sourceRate,outputRate,totalFrames].every(Number.isSafeInteger) || a < 0 || a >= b || b > totalFrames || sourceRate <= 0 || outputRate <= 0) throw new Error("Use A before B within this WAV.");
  const ceil = (n: number) => Number((BigInt(n)*BigInt(outputRate)+BigInt(sourceRate)-1n)/BigInt(sourceRate));
  const pcmA=ceil(a),pcmB=ceil(b),period=pcmB-pcmA,fade=Math.min(Math.floor(outputRate/200),Math.floor(period/4));
  if (period<8 || fade<2) throw new Error("Loop needs at least 8 output frames and a 2-frame fade within 5 ms.");
  return {a,b,pcmA,pcmB,period,fade};
}
export const emptyWavLoop: WavLoopState = { supported: false, enabled: false, phase: "Disabled", region: null, error: null };
