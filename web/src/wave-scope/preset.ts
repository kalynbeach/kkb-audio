/** One proposed instance preset. Kalyn owns the visual direction; no listener settings. */
export const WAVE_SCOPE_PRESET = {
  id: "p31-xy",
  name: "P31 / XY",
  owner: "Kalyn",
  status: "proposed",
  canvas: { background: 0.012 },
  phosphor: { bloom: 0.75, color: "p31-green", trailLength: 64 },
  gain: 0.86,
} as const;

export type PlaybackScopePreset = typeof WAVE_SCOPE_PRESET;
