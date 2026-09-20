// From kalynbeach/kkb. See THIRD_PARTY_NOTICES.md for source provenance.
export const TRACE_SHADER = /* wgsl */ `
struct RenderUniforms {
  fadeAlpha: f32,
  traceAlpha: f32,
  backgroundLift: f32,
  glowSpread: f32,
  texelSizeX: f32,
  texelSizeY: f32,
  bloomStrength: f32,
  traceGain: f32,
};

@group(0) @binding(0) var<uniform> uniforms: RenderUniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@location(0) point: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(point.x, point.y, 0.0, 1.0);
  return out;
}

@fragment
fn fs() -> @location(0) vec4f {
  let phosphor = vec3f(0.03, 0.78, 0.2) * uniforms.traceGain;
  let shoulder = vec3f(0.004, 0.08, 0.018) * uniforms.bloomStrength;
  return vec4f(phosphor + shoulder, uniforms.traceAlpha);
}
`;
