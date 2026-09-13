// Throwaway interaction model for #21. No audio, decoding, persistence or engine contracts.
export type Track = { id: string; title: string; artist?: string; album?: string; duration: number; failed?: boolean };
export const fixtures: Track[] = [
  { id: "tide", title: "Low Tide", artist: "North Window", album: "Tidal Studies", duration: 272 },
  { id: "glass", title: "Glass Current", artist: "Static Bloom", album: "Afterimage", duration: 378 },
  { id: "map", title: "A Map of the Room After Everyone Has Left", artist: "North Window", album: "Tidal Studies — Late Sessions", duration: 527 },
  { id: "field", title: "field-recording_2026-08-19_take-07.wav", duration: 272 },
  { id: "night", title: "Night Transit", artist: "Static Bloom", album: "Afterimage", duration: 272, failed: true },
];
export type Phase = "empty" | "loading" | "paused" | "playing" | "ended" | "error";
export type Loop = { a: number; b: number; enabled: boolean; phase: "ready" | "preparing" | "failed" };
export type Session = { tracks: Track[]; loaded: string | null; selected: string | null; phase: Phase; position: number; loop: Loop; notice: string };
export function initialSession(): Session {
  return { tracks: fixtures, loaded: "tide", selected: "glass", phase: "paused", position: 84,
    loop: { a: 0, b: 272, enabled: false, phase: "ready" }, notice: "Simulated track ready. No audio will play." };
}
export type Action =
  | { type: "select"; id: string }
  | { type: "activate"; id: string; playing: boolean }
  | { type: "play" }
  | { type: "seek"; position: number }
  | { type: "tick" }
  | { type: "region"; a: number; b: number }
  | { type: "loop"; enabled: boolean }
  | { type: "loop-phase"; phase: Loop["phase"] }
  | { type: "scenario"; phase: Phase }
  | { type: "reset" };

export function sessionReducer(state: Session, action: Action): Session {
  const track = state.tracks.find(t => t.id === state.loaded);
  const duration = track?.duration ?? 272;
  switch (action.type) {
    case "reset": return initialSession();
    case "select": return { ...state, selected: action.id };
    case "activate": {
      const next = state.tracks.find(t => t.id === action.id);
      if (!next) return state;
      const resume = next.id === state.loaded && (state.phase === "paused" || state.phase === "playing");
      // Playback actions do not change the independent row selection.
      return { ...state, loaded: next.id, position: resume ? state.position : 0,
        phase: next.failed ? "error" : action.playing ? "playing" : "paused",
        loop: resume ? state.loop : { a: 0, b: next.duration, enabled: false, phase: "ready" },
        notice: next.failed ? "This track is unavailable. Choose another track." : `${next.title}. ${action.playing ? "Playing the silent simulation." : "Paused."}` };
    }
    case "play":
      if (!track || state.phase === "empty" || state.phase === "error" || state.phase === "loading") return state;
      return { ...state, phase: state.phase === "playing" ? "paused" : "playing", position: state.phase === "ended" ? 0 : state.position,
        notice: state.phase === "playing" ? "Paused." : "Playing the silent simulation." };
    case "seek": {
      const position = Math.max(0, Math.min(duration, action.position));
      const outside = state.loop.enabled && (position < state.loop.a || position >= state.loop.b);
      return { ...state, position, phase: position === duration ? "ended" : state.phase === "ended" ? "paused" : state.phase,
        loop: outside ? { ...state.loop, enabled: false } : state.loop,
        notice: outside ? "Seek committed outside the region. Loop disabled; boundaries retained." : "Seek committed." };
    }
    case "region": {
      // One second is only a prototype gesture bound, not the audio engine's minimum interval.
      const a = Math.max(0, Math.min(duration - 1, action.a));
      const b = Math.max(a + 1, Math.min(duration, action.b));
      const outside = state.position < a || state.position >= b;
      return { ...state, loop: { ...state.loop, a, b, enabled: state.loop.enabled && !outside, phase: "ready" },
        notice: state.loop.enabled && outside ? "Region updated outside the playhead. Loop disabled; playback unchanged." : "Region updated. Boundaries do not start playback." };
    }
    case "loop": return { ...state, phase: action.enabled && state.phase === "ended" ? "paused" : state.phase,
      loop: { ...state.loop, enabled: action.enabled, phase: "ready" },
      position: action.enabled && (state.position < state.loop.a || state.position >= state.loop.b) ? state.loop.a : state.position,
      notice: action.enabled ? "Loop enabled in the simulation. Play/pause preserved." : "Loop disabled. Boundaries retained." };
    case "loop-phase": return { ...state, loop: { ...state.loop, phase: action.phase }, notice: `Simulated loop ${action.phase}.` };
    case "scenario": {
      if (action.phase === "empty") return { ...state, loaded: null, phase: "empty", position: 0, loop: { a: 0, b: 272, enabled: false, phase: "ready" }, notice: "No track loaded." };
      const tracks = state.tracks.length ? state.tracks : fixtures;
      const current = track ?? tracks[0]!;
      return { ...state, tracks: tracks.map(t => t.id === current.id ? { ...t, failed: action.phase === "error" } : t),
        loaded: current.id, phase: action.phase, position: action.phase === "ended" ? current.duration : state.position >= current.duration ? 0 : state.position,
        loop: { ...state.loop, enabled: false }, notice: `Controlled ${action.phase} state. No media processing.` };
    }
    case "tick": {
      if (state.phase !== "playing") return state;
      let position = state.position + 0.25;
      if (state.loop.enabled && state.loop.phase === "ready" && position >= state.loop.b) position = state.loop.a;
      return { ...state, position: Math.min(position, duration), phase: position >= duration ? "ended" : "playing" };
    }
  }
}

export function time(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
