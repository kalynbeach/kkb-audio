import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { PlaybackOwner, sourceFrameAtSeconds, type PlaybackState } from "./playback-owner";

export function mediaTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const phaseLabels: Record<PlaybackState["phase"], string> = {
  empty: "No file selected", loading: "Preparing your WAV…", paused: "Ready · Paused",
  playing: "Playing", seeking: "Seeking…", ended: "Ended", error: "Unable to play this file",
};

export function PlayerApp({ owner: suppliedOwner }: { owner?: PlaybackOwner }) {
  const [owner] = useState(() => suppliedOwner ?? new PlaybackOwner());
  const state = useSyncExternalStore(owner.subscribe, owner.getState);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { void owner.close(); }, [owner]);
  const available = state.snapshot !== null && state.phase !== "error";

  return <main className="player-page">
    <header className="player-header">
      <a className="player-wordmark" href="/lab.html">KKB / Audio</a>
      <span className="player-caption">Local playback · Experimental</span>
    </header>
    <section className="player-intro" aria-labelledby="player-title">
      <h1 id="player-title">Your WAV. Just play.</h1>
      <p>One local file, played through the Rust/Wasm engine. Nothing uploaded.</p>
    </section>
    <section className="player-deck" aria-label="Local WAV player">
      <div className="player-file">
        <label htmlFor="wav-file">{state.fileName ? "Replace local WAV" : "Choose local WAV"}</label>
        <Input ref={fileInput} id="wav-file" type="file" accept=".wav,audio/wav,audio/x-wav"
          aria-describedby="supported-files" onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void owner.load(file);
          }} />
        <p id="supported-files" className="player-caption">PCM16/24 · Mono or stereo · Same-rate or 44.1 ↔ 48 kHz conversion</p>
      </div>
      <div className="player-track">
        <h2>{state.fileName || "Choose a WAV to begin"}</h2>
        <p role="status" aria-live="polite">{phaseLabels[state.phase]}</p>
        {state.error ? <p role="alert" className="player-error">{state.error}. Choose another supported WAV to try again.</p> : null}
        {state.phase === "empty" ? <p className="player-caption">Loading never starts audio. Press Play when you’re ready.</p> : null}
      </div>
      <SeekBar key={state.fileName + ":" + state.sourceRate + ":" + state.totalFrames}
        state={state} unavailable={!available} disabled={!available || state.busy} onSeek={seconds => { void owner.seek(seconds); }} />
      <div className="player-transport">
        <Button size="lg" disabled={!available || state.busy} onClick={() => {
          void (state.phase === "playing" ? owner.pause() : owner.play());
        }}>{state.phase === "playing" ? "Pause" : state.phase === "ended" ? "Replay" : "Play"}</Button>
        <Button variant="outline" disabled={state.phase === "empty"} onClick={() => {
          void owner.close();
          fileInput.current?.focus();
        }}>{state.phase === "loading" ? "Cancel loading" : "Close file"}</Button>
        <span className="player-caption">{state.busy && state.phase !== "loading" && state.phase !== "seeking" ? "Updating playback…" : "Audio starts only with Play."}</span>
      </div>
      <div className="player-volume">
        <label htmlFor="listening-volume">Listening volume <output>{Math.round(state.volume * 100)}%</output></label>
        <Input id="listening-volume" className="player-range" type="range" min="0" max="100" step="1"
          value={Math.round(state.volume * 100)} aria-valuetext={`${Math.round(state.volume * 100)} percent${state.muted ? ", muted" : ""}`}
          onChange={event => owner.setVolume(Number(event.currentTarget.value) / 100)} />
        <Button variant="outline" aria-pressed={state.muted} onClick={() => owner.setMuted(!state.muted)}>
          {state.muted ? "Unmute" : "Mute"}
        </Button>
      </div>
      <p className="player-caption">Volume starts at 15%, after the engine’s fixed 50% gain. Mute keeps your chosen level.</p>
    </section>
    <details className="player-details">
      <summary>Playback details & limits</summary>
      <p>Elapsed time follows consumed source media, not measured sound at your speakers. Seeking may briefly output silence; click-free transitions are not guaranteed. The end pauses playback; seeking back stays paused until Play.</p>
      <p>Nonempty little-endian RIFF WAV only. Other encodings, layouts and rate conversions are rejected. No waveform, playlists or background-playback guarantee.</p>
      {state.snapshot ? <dl>
        <div><dt>Source / output rate</dt><dd>{state.sourceRate} / {state.outputRate} Hz</dd></div>
        <div><dt>Consumed source frame</dt><dd>{state.snapshot.sourcePosition} / {state.totalFrames}</dd></div>
        <div><dt>Epoch / ready</dt><dd>{state.snapshot.epoch} / {String(state.snapshot.ready)}</dd></div>
        <div><dt>Starved callbacks</dt><dd>{state.snapshot.starvationCount}</dd></div>
        <div><dt>Worklet memory</dt><dd>{state.snapshot.memoryBytes} bytes</dd></div>
        {state.seekResult ? <div><dt>Last seek</dt><dd>{state.seekResult.requestedFrame} → {state.seekResult.actualMediaFrame} ({state.seekResult.result})</dd></div> : null}
      </dl> : null}
    </details>
    <footer className="player-caption">Local WAV player / <a href="/lab.html">Learning lab</a> / <a href="/index.html">Engine proof</a></footer>
  </main>;
}

function SeekBar({ state, unavailable, disabled, onSeek }: {
  state: PlaybackState; unavailable: boolean; disabled: boolean; onSeek: (seconds: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ target: number; cancelled: boolean } | null>(null);
  const duration = state.sourceRate ? state.totalFrames / state.sourceRate : 0;
  const elapsed = state.sourceRate ? (state.snapshot?.sourcePosition ?? 0) / state.sourceRate : 0;
  const cancel = () => {
    if (drag.current) drag.current.cancelled = true;
    setPreview(null);
  };
  // Closing or replacing a file cancels any uncommitted interaction.
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  const targetTime = (seconds: number) => state.sourceRate
    ? sourceFrameAtSeconds(seconds, state.sourceRate, state.totalFrames) / state.sourceRate : 0;
  return <div className="player-seek">
    <div className="player-time"><label htmlFor="seek-position">Position</label>
      <span><output aria-label="Elapsed media time" aria-live="off">{mediaTime(elapsed)}</output> / <output aria-label="Duration" aria-live="off">{mediaTime(duration)}</output></span>
    </div>
    <Input id="seek-position" className="player-range" type="range" min={0} max={duration || 1}
      step={state.sourceRate ? 1 / state.sourceRate : 1} value={preview ?? elapsed} disabled={unavailable} aria-disabled={disabled}
      aria-describedby="seek-help" aria-valuetext={`${preview === null ? "Position" : "Preview"} ${mediaTime(preview ?? elapsed)} of ${mediaTime(duration)}`}
      onPointerDown={event => {
        if (disabled) { event.preventDefault(); return; }
        if (event.button !== 0) return;
        drag.current = { target: elapsed, cancelled: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onChange={event => {
        if (disabled) return;
        const target = targetTime(Number(event.currentTarget.value));
        if (drag.current) {
          if (!drag.current.cancelled) { drag.current.target = target; setPreview(target); }
        } else onSeek(target);
      }}
      onPointerUp={() => {
        const pending = drag.current;
        drag.current = null;
        setPreview(null);
        if (pending && !pending.cancelled && !disabled) onSeek(pending.target);
      }}
      onPointerCancel={() => { cancel(); drag.current = null; }}
      onLostPointerCapture={() => { cancel(); drag.current = null; }}
      onBlur={cancel}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
        const targets: Record<string, number> = {
          ArrowLeft: elapsed - 5, ArrowDown: elapsed - 5, ArrowRight: elapsed + 5, ArrowUp: elapsed + 5,
          PageDown: elapsed - 30, PageUp: elapsed + 30, Home: 0, End: duration,
        };
        const target = targets[event.key];
        if (target !== undefined) {
          event.preventDefault();
          if (!disabled && !drag.current) onSeek(targetTime(target));
        }
      }} />
    <p id="seek-help" className="player-caption">{preview !== null
      ? `Preview ${mediaTime(preview)} · Release to seek. Escape cancels.`
      : "Drag to preview, release to seek. Arrow keys: 5 seconds. Home / End: start / end."}</p>
  </div>;
}
