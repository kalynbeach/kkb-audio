import type { Processor } from "./lab-model.ts";
import type { LabState } from "./use-lab.ts";

export const names: Record<Processor, string> = {
  10: "Oscillator A",
  20: "Gain A",
  30: "Oscillator B",
  40: "Gain B",
  50: "Mix",
  60: "Observe",
  70: "Output",
};
export const shortNames: Record<Processor, string> = {
  ...names,
  10: "Osc A",
  30: "Osc B",
};
export const positions: Record<Processor, [number, number]> = {
  10: [100, 67],
  20: [310, 67],
  30: [100, 187],
  40: [310, 187],
  50: [520, 127],
  60: [720, 127],
  70: [910, 127],
};
const explanations: Record<Processor, string> = {
  10: "A sine oscillator starts at phase zero. Its frequency is fixed in this compiled plan. Changing it prepares a fresh render.",
  20: "Every sample from oscillator A is multiplied by this gain. Sets and ramps change the gain at exact render frames.",
  30: "A second, independent sine oscillator. Nearby frequencies drift in and out of phase when the signals are mixed.",
  40: "Gain B scales only oscillator B. A negative value inverts its polarity. Events address processor 40, parameter 1.",
  50: "Adds the two gained signals, sample by sample. There is no normalization or clipping inside the engine.",
  60: "Passes the mix through and measures peak and RMS over fixed 64-frame windows. It retains the latest completed window.",
  70: "Writes the final mono signal to the output plane. Playback replays these samples through a separate listening-volume control.",
};

export function signalClass(id: Processor) {
  return id <= 20 ? "signal-a" : id <= 40 ? "signal-b" : "signal-output";
}

export function lessonCopy(state: LabState) {
  const { config } = state;
  if (state.lesson === 0) {
    const difference = Math.abs(config.frequencyA - config.frequencyB);
    return difference === 0
      ? `${config.frequencyA} Hz + ${config.frequencyB} Hz. Both oscillators begin in phase. Separate them by a few hertz to hear slow beating.`
      : `${config.frequencyA} Hz + ${config.frequencyB} Hz. Their frequency difference is ${difference} Hz. Bring the frequencies closer to hear slow beating.`;
  }
  const event =
    config.events.find((item) => item.id === state.selectedEvent) ??
    config.events[0];
  if (!event)
    return "Add a gain event at the cursor, then inspect its exact sample. The Rust engine applies events inside the render call.";
  if (state.lesson === 2 && event.kind === "ramp")
    return `Gain ${event.processor === 20 ? "A" : "B"} ramps from sample ${event.frame.toLocaleString()} to ${event.end.toLocaleString()} inclusive. Change the block size and compare all seven traces sample for sample.`;
  return `Gain ${event.processor === 20 ? "A" : "B"} ${event.kind === "set" ? "changes" : "starts a ramp"} at sample ${event.frame.toLocaleString()}, offset ${event.frame % config.partition} inside a ${config.partition}-frame call. Inspect the first affected sample.`;
}

export function inspector(state: LabState) {
  const { selected: id, config, result, connection } = state;
  const title = connection
    ? `${shortNames[connection.from]} → ${shortNames[connection.to]}`
    : names[id];
  const description = connection
    ? `This connection carries the mono output of ${names[connection.from].toLowerCase()} into ${names[connection.to].toLowerCase()}. Its value at the cursor is the source sample shown below.`
    : explanations[id];
  const detail =
    id === 10 || id === 30
      ? `${id === 10 ? config.frequencyA : config.frequencyB} cycles / second. Phase begins at zero.`
      : id === 20 || id === 40
        ? `Event address ${id}:1 · initial gain ${(id === 20 ? config.gainA : config.gainB).toFixed(2)} · ${config.events.filter((event) => event.processor === id).length} scheduled event(s)`
        : id === 50
          ? `Beat rate: ${Math.abs(config.frequencyA - config.frequencyB)} Hz. A and B are sources, not stereo channels.`
          : id === 60 && result?.observation.length
            ? `Latest engine window [${result.observation[0]}, ${result.observation[1]}). Peak ${result.observation[2].toFixed(4)}, RMS ${result.observation[3].toFixed(4)}. ${result.observation[5]} overwritten windows.`
            : "Engine samples are unchanged by listening volume. The replay cursor estimates position using the Web Audio clock.";
  return { title, description, detail };
}
