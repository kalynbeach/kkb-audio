"use client";
import { useEffect, useRef, useState } from "react";
import { mountPcmProof } from "../../../web/src/main";
export default function PcmControls() {
  const root = useRef<HTMLFieldSetElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { if (!root.current) return; const release = mountPcmProof(root.current); setReady(true); return release; }, []);
  return <fieldset ref={root} className="proof-controls" disabled={!ready}>
    <button id="prepare">Prepare stereo proof</button><button id="activate" disabled>Activate muted proof</button><button id="failure">Inject preparation failure</button><button id="close">Close</button>
    <h2>Local WAV playback</h2><p>PCM16/24 or IEEE float32 mono/stereo WAV, with same-rate playback or 44.1 ↔ 48 kHz conversion. Play emits sound at gain 0.5. Lower your system volume first.</p>
    <p><label>Local WAV file <input id="wav-file" type="file" accept=".wav,audio/wav" /></label></p>
    <button id="wav-load">Load WAV (paused)</button><button id="wav-play" disabled>Play / resume WAV</button><button id="wav-pause" disabled>Pause WAV</button><button id="wav-status" disabled>WAV status</button>
    <p><label>Source frame <input id="wav-frame" type="number" min="0" step="1" defaultValue="0" /></label><button id="wav-seek" disabled>Seek WAV</button></p>
    <p><label><input id="wav-stall" type="checkbox" disabled /> Stall worker (starvation proof)</label></p>
    <p>Position follows consumed source frames, not measured speaker output. Status updates on request.</p><pre id="result" aria-live="polite">idle</pre>
  </fieldset>;
}
