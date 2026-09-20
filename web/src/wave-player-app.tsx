import { PlayerApp } from "./player-app";
import { WavePlayerScope } from "./wave-player-scope";
import { createSyntheticStudy } from "./synthetic-study";

export function WavePlayerApp() {
  return <PlayerApp Visual={WavePlayerScope} createStudy={createSyntheticStudy}
    visualDetails={<p>The WebGPU XY scope maps left to X and right to Y. Mono drives both axes; silence rests at the center. The P31 green preset belongs to this player instance, with no listener configuration. Its phosphor history shows approximate trailing 2048-sample worklet-output observations before volume and mute. Seeking clears the history. This is not a source-frame or speaker clock. WebGPU availability affects only the visual.</p>}
  />;
}
