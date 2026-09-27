// Adapted from kalynbeach/kkb. See THIRD_PARTY_NOTICES.md for source provenance.
import type { PlaybackScopePreset } from "./preset";

export type RendererUniformValues = {
  backgroundLift: number;
  bloomStrength: number;
  fadeAlpha: number;
  glowSpread: number;
  texelSizeX: number;
  texelSizeY: number;
  traceAlpha: number;
  traceGain: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const createRendererUniformValues = (
  config: PlaybackScopePreset,
  width: number,
  height: number,
  deltaSeconds: number,
): RendererUniformValues => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const bloomStrength = clamp(config.phosphor.bloom, 0, 1.5);
  const trailLength = Math.max(16, config.phosphor.trailLength);
  const trailBlend = clamp((trailLength - 16) / 112, 0, 1);
  const fadeAlphaAtSixtyHertz = clamp(
    (0.24 + trailBlend * 0.1) / Math.sqrt(trailLength),
    0.016,
    0.08,
  );
  const retainedAtSixtyHertz = 1 - fadeAlphaAtSixtyHertz;
  const normalizedFrames = Math.max(0, deltaSeconds) * 60;
  const fadeAlpha = clamp(1 - retainedAtSixtyHertz ** normalizedFrames, 0, 1);

  return {
    backgroundLift: clamp(
      clamp(config.canvas.background, 0, 1) * 0.35 + bloomStrength * 0.006 + trailBlend * 0.004,
      0,
      0.05,
    ),
    bloomStrength,
    fadeAlpha,
    glowSpread: clamp(0.85 + bloomStrength * 1.45 + trailBlend * 0.35, 0.85, 3.4),
    texelSizeX: 1 / safeWidth,
    texelSizeY: 1 / safeHeight,
    traceAlpha: clamp(0.004 + (1 - trailBlend) * 0.016, 0.004, 0.02),
    traceGain: clamp(0.74 + bloomStrength * 0.22, 0.74, 1.08),
  };
};

export const packRendererUniforms = (values: RendererUniformValues, target: Float32Array) => {
  if (target.length < 8) {
    throw new Error("Renderer uniform target must contain at least 8 floats.");
  }

  target[0] = values.fadeAlpha;
  target[1] = values.traceAlpha;
  target[2] = values.backgroundLift;
  target[3] = values.glowSpread;
  target[4] = values.texelSizeX;
  target[5] = values.texelSizeY;
  target[6] = values.bloomStrength;
  target[7] = values.traceGain;
  return target;
};
