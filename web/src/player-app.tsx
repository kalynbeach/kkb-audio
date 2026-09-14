import { startTransition, ViewTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "@base-ui/react/popover";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Slider } from "./components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { PlaybackOwner, sourceFrameAtSeconds, type PlaybackState } from "./playback-owner";
import { PlayerLoopEditor } from "./player-loop-editor";
import { PlayerOscilloscope } from "./player-oscilloscope";
import { waveformPath } from "./source-waveform";
import { PlayerCollection, SESSION_LIMIT, type SessionEntry } from "./player-collection";
import { RepeatIcon, ArrowLeftIcon, GearSixIcon, PauseIcon, PlayIcon, QueueIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, SpeakerSlashIcon, XIcon } from "./player-icons";

export function mediaTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
const phaseLabels: Record<PlaybackState["phase"], string> = {
  empty: "No track loaded", loading: "Preparing…", paused: "Paused",
  playing: "Playing", seeking: "Seeking…", ended: "Ended", error: "Unavailable",
};

export function PlayerApp({ owner: suppliedOwner }: { owner?: PlaybackOwner }) {
  const [owner] = useState(() => suppliedOwner ?? new PlaybackOwner());
  const [collection] = useState(() => new PlayerCollection(owner));
  const state = useSyncExternalStore(owner.subscribe, owner.getState);
  const session = useSyncExternalStore(collection.subscribe, collection.getState);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [loopEditing, setLoopEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [visualPaused, setVisualPaused] = useState(false);
  const [mode, setMode] = useState<"system" | "light" | "dark">("system");
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 1211px)").matches);
  const fileInput = useRef<HTMLInputElement>(null);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const active = session.entries.find(entry => entry.id === session.active);
  const activeIndex = session.entries.findIndex(entry => entry.id === session.active);
  const available = state.snapshot !== null && state.phase !== "error";

  useEffect(() => {
    const unsubscribe = owner.subscribe(collection.captureMetadata);
    return () => { unsubscribe(); void collection.close(); };
  }, [owner, collection]);
  useEffect(() => {
    const query = matchMedia("(max-width: 1211px)");
    const change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && query.matches));
    apply(); query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [mode]);
  useEffect(() => { if (libraryOpen) libraryHeading.current?.focus(); }, [libraryOpen, narrow]);
  const openLibrary = () => startTransition(() => setLibraryOpen(true));
  const closeLibrary = () => { startTransition(() => setLibraryOpen(false)); libraryToggle.current?.focus(); };
  const closeTrack = () => { void collection.close(); libraryToggle.current?.focus(); };
  const library = <section id="player-library" className="player-library" aria-labelledby="library-heading" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); closeLibrary(); }
  }}>
    <header className="player-library-header">
      {narrow ? <Button variant="ghost" size="icon" aria-label="Return to visual" onClick={closeLibrary}>{ArrowLeftIcon}</Button> : null}
      <h2 id="library-heading" ref={libraryHeading} tabIndex={-1}>Library <span>{session.entries.length} tracks</span></h2>
      {!narrow ? <Button variant="ghost" size="icon" aria-label="Close library" onClick={closeLibrary}>{XIcon}</Button> : null}
    </header>
    <div className="player-library-scroll" aria-label="Session tracks" tabIndex={0}>
      {session.entries.length ? <ul>{session.entries.map(entry => <TrackRow key={entry.id} entry={entry}
        selected={entry.id === session.selected} current={entry.id === session.active} state={state}
        onSelect={() => collection.select(entry.id)} onPlay={() => { void collection.rowPlay(entry.id); }} />)}</ul>
        : <div className="player-empty"><p>No files in this session.</p><p>Add WAV or MP3 files in Settings.</p></div>}
    </div>
  </section>;
  return <>
    <input ref={fileInput} id="session-files" type="file" hidden multiple accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg" aria-label="Add local WAV or MP3 files"
      onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (!files.length) return;
        collection.add(files);
        startTransition(() => { setSettingsOpen(false); setLibraryOpen(true); });
      }} />
    <header className="player-app-header"><span>Wave Player <span className="player-pixel">/ LOCAL</span></span>
      <Dialog.Root open={settingsOpen} onOpenChange={open => startTransition(() => setSettingsOpen(open))}>
        <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Settings" title="Settings" />}>{GearSixIcon}</Dialog.Trigger>
        <Dialog.Portal keepMounted>{settingsOpen ? <ViewTransition default="none" enter="fade-in" exit="fade-out"><Dialog.Backdrop className="player-scrim" /><Dialog.Popup className="player-settings">
          <div className="player-settings-heading"><Dialog.Title>Settings</Dialog.Title><Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close settings" />}>{XIcon}</Dialog.Close></div>
          <Dialog.Description>Local files. This session only. Nothing uploaded or saved.</Dialog.Description>
          <div className="player-session-actions">
            <Button variant="outline" onClick={() => fileInput.current?.click()}>Add files</Button>
            <Button variant="outline" disabled={!session.selected} onClick={() => { void collection.removeSelected(); }}>Remove selected</Button>
            <Button variant="outline" disabled={!session.entries.length} onClick={() => { void collection.clear(); }}>Clear session</Button>
          </div>
          <p className="player-settings-note">{session.entries.length} / {SESSION_LIMIT} files. Remove and Clear affect this session, never your original files. Removing the active file stops playback.</p>
          {session.selected ? <p className="player-selected-name">Selected: {session.entries.find(entry => entry.id === session.selected)?.file.name}</p> : null}
          <p id="mode-label">Appearance</p>
          <ToggleGroup value={[mode]} onValueChange={values => { const value = values[0]; if (value === "system" || value === "light" || value === "dark") setMode(value); }} aria-labelledby="mode-label">
            <ToggleGroupItem value="system">System</ToggleGroupItem><ToggleGroupItem value="light">Light</ToggleGroupItem><ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" aria-pressed={visualPaused} onClick={() => setVisualPaused(!visualPaused)}>{visualPaused ? "Resume visual" : "Pause visual"}</Button>
          <p className="player-settings-note">The oscilloscope observes rendered audio before listening volume or mute. Pausing the visual does not pause audio.</p>
          {session.active ? <Button variant="outline" onClick={closeTrack}>{state.phase === "loading" ? "Cancel loading" : "Close track"}</Button> : null}
          <details className="player-limits"><summary>Playback details & limits</summary>
            <p>WAV PCM16/24 or MPEG-1 Layer III MP3, mono/stereo. MP3: 44.1/48 kHz, up to 32 MiB and 10 minutes. Same-rate or 44.1 ↔ 48 kHz conversion. Other encodings and conversions are rejected.</p>
            <p>Only the active file is prepared. Row Play explicitly starts audio; adding or selecting never does. Previous/next preserve playing or paused intent. No track wrap or auto-advance. A/B loops use decoded source coordinates for WAV and MP3. The waveform is source amplitude, independent of listening volume; at most 4096 time bins combine channel extrema, reduced without dropping peaks. It is an overview, not sample-level detail.</p>
            <p>Position follows consumed source media, not measured speaker output. Seeking may briefly output silence; click-free transitions and background playback are not guaranteed. Volume starts at 15%, after fixed 50% engine gain.</p>
            <p>The live oscilloscope shows an approximate trailing 2048-sample browser window, not source-tagged or speaker-synchronized data. Mono has one trace; stereo has solid left and dashed right traces, with three-window persistence. Seeking clears history and waits for fresh rendering. Silence is a flat line.</p>
            <p>No preferences are saved. Reduced motion disables live visual motion and skips disclosure animations. Visual failure leaves transport available.</p>
          </details>
        </Dialog.Popup></ViewTransition> : null}</Dialog.Portal>
      </Dialog.Root>
    </header>
    <main className="player-stage">
      <div className="player-composition">
        <section className="player-card" aria-label="Wave Player">
          <header className="player-track-header">
            <h1 title={active?.file.name}>{active?.file.name || "Choose your music"}</h1>
            <p>{active ? "Metadata unavailable" : "Local files. This session only."}</p>
          </header>
          <div className="player-visual-area">
          <ViewTransition key={narrow && libraryOpen ? "library" : "visual"} default="none" enter="fade-in" exit="fade-out">
            <div className="player-main-field">
              {narrow && libraryOpen ? library : state.phase === "empty" || state.phase === "loading" || state.phase === "error" ? <div className="player-empty">
                {state.phase !== "empty" ? <span className="player-pixel">{state.phase === "loading" ? "PREPARING" : "UNAVAILABLE"}</span> : null}
                <p>{state.phase === "loading" ? "Preparing this track…" : state.phase === "error" ? "This file could not be played." : session.entries.length ? "Play a track from your library." : "Open local WAV or MP3 files."}</p>
                {state.phase === "loading" ? <Button variant="outline" onClick={closeTrack}>Cancel loading</Button> : state.phase === "empty" ? <Button variant="outline" onClick={() => fileInput.current?.click()}>Open files</Button> : null}
                {state.phase !== "loading" && session.entries.length ? <Button variant="outline" onClick={openLibrary}>Browse library</Button> : null}
              </div> : <PlayerOscilloscope owner={owner} paused={visualPaused} editing={loopEditing} />}
            </div>
          </ViewTransition>
            {loopEditing ? <ViewTransition default="none" enter="loop-layer" exit="loop-layer"><PlayerLoopEditor state={state} owner={owner}/></ViewTransition> : null}
          </div>
          <div className="player-navigation">
            <SeekBar key={session.active ?? "empty"} state={state} unavailable={!available} disabled={!available || state.busy} editing={loopEditing && state.loop.supported}
            onRegion={(a,b)=>{void owner.setLoopRegion(a,b);}} onSeek={seconds => { void owner.seek(seconds); }} /></div>
          <footer className="player-transport">
            <div className="player-utilities"><Popover.Root>
              <Popover.Trigger render={<Button variant="ghost" size="icon" aria-label="Volume" title={state.muted ? "Volume (muted)" : `Volume ${Math.round(state.volume * 100)}%`} />}>{state.muted || state.volume === 0 ? SpeakerSlashIcon : SpeakerHighIcon}</Popover.Trigger>
              <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={8} className="player-popover-positioner"><Popover.Popup className="player-volume-popup">
                <Popover.Title id="volume-label" className="sr-only">Listening volume</Popover.Title>
                <Button variant="ghost" size="icon-xs" aria-label={state.muted ? "Unmute" : "Mute"} aria-pressed={state.muted} onClick={() => owner.setMuted(!state.muted)}>{state.muted ? SpeakerSlashIcon : SpeakerHighIcon}</Button>
                <Slider value={[Math.round(state.volume * 100)]} min={0} max={100} step={1} aria-labelledby="volume-label" onValueChange={values => owner.setVolume((Array.isArray(values) ? values[0]! : values) / 100)} />
                <output aria-label="Volume level">{Math.round(state.volume * 100)}%</output>
              </Popover.Popup></Popover.Positioner></Popover.Portal>
            </Popover.Root><Button variant="ghost" size="icon" aria-label="Loop editor" title={state.loop.error ?? (state.loop.supported ? state.loop.enabled ? "Loop enabled · Edit loop" : "Loop off · Edit loop" : "Loop unavailable")} data-active={state.loop.enabled} aria-expanded={loopEditing} disabled={!available || (!state.loop.supported && !state.loop.error && !loopEditing)} onClick={()=>startTransition(()=>setLoopEditing(!loopEditing))}>{RepeatIcon}</Button></div>
            <div className="player-playback">
              <Button variant="ghost" size="icon" aria-label="Previous track" disabled={activeIndex <= 0 || (state.busy && state.phase !== "loading")} onClick={() => { void collection.move(-1); }}>{SkipBackIcon}</Button>
              <Button variant="secondary" size="icon-lg" className="player-play" aria-label={state.phase === "playing" ? "Pause" : state.phase === "ended" ? "Replay" : "Play"} disabled={!available || state.busy}
                onClick={() => { void (state.phase === "playing" ? owner.pause() : owner.play()); }}>{state.phase === "playing" ? PauseIcon : PlayIcon}</Button>
              <Button variant="ghost" size="icon" aria-label="Next track" disabled={activeIndex < 0 || activeIndex >= session.entries.length - 1 || (state.busy && state.phase !== "loading")} onClick={() => { void collection.move(1); }}>{SkipForwardIcon}</Button>
            </div>
            <Button ref={libraryToggle} variant="ghost" size="icon" className="player-library-trigger" aria-label={libraryOpen ? "Hide library" : "Show library"} title="Library" aria-expanded={libraryOpen} aria-controls="player-library" onClick={() => libraryOpen ? closeLibrary() : openLibrary()}>{QueueIcon}</Button>
          </footer>
        </section>
        {!narrow && libraryOpen ? <ViewTransition default="none" enter="fade-in" exit="fade-out">{library}</ViewTransition> : null}
      </div>
    </main>
    <footer className="player-review-footer">
      {state.error ? <p role="alert" className="player-error">{state.error}. Play another file from the library, or retry this one.</p> : null}
      <p role="status">{session.notice || "Local WAV & MP3 · This session only"}</p>
      <p><a href="/lab.html">Learning lab</a> / <a href="/index.html">Engine proof</a></p>
    </footer>
  </>;
}

function TrackRow({ entry, selected, current, state, onSelect, onPlay }: {
  entry: SessionEntry; selected: boolean; current: boolean; state: PlaybackState; onSelect: () => void; onPlay: () => void;
}) {
  const playing = current && state.phase === "playing";
  const metadata = entry.error ? "Unavailable · Play to retry" : current && state.phase === "loading" ? "Preparing…" : "Metadata unavailable";
  return <li className="player-track-row" data-selected={selected} data-current={current}>
    <button className="player-track-select" type="button" onClick={onSelect} aria-pressed={selected} aria-current={current ? "true" : undefined} aria-label={`Select ${entry.file.name}`} aria-describedby={`${entry.id}-meta`}>
      <span className="player-track-copy"><span className="player-track-title" data-filename="true" title={entry.file.name}>{entry.file.name}</span><span id={`${entry.id}-meta`} className="player-track-meta" title={metadata}>{metadata}</span></span>
      <span className="player-track-duration">{entry.duration === null ? "—" : mediaTime(entry.duration)}</span>
    </button>
    {current ? <span className="player-track-cue" aria-hidden="true">{playing ? SpeakerHighIcon : <span className="player-current-dot" />}</span> : null}
    <Button variant="ghost" size="icon" className="player-track-play" aria-label={`${playing ? "Pause" : current && state.phase === "ended" ? "Replay" : "Play"} ${entry.file.name}`} aria-describedby={`${entry.id}-meta`} disabled={current && state.busy} onClick={onPlay}>{playing ? PauseIcon : PlayIcon}</Button>
  </li>;
}
function SeekBar({ state, unavailable, disabled, onSeek, editing, onRegion }: {
  state: PlaybackState; unavailable: boolean; disabled: boolean; onSeek: (seconds: number) => void; editing: boolean; onRegion: (a: number,b: number) => void;
}) {
  const regionDrag=useRef<{kind:"a"|"b"|"region";start:number;a:number;b:number}|null>(null);
  const [regionPreview,setRegionPreview]=useState<{a:number;b:number}|null>(null);
  const cancelRegion=()=>{regionDrag.current=null;setRegionPreview(null);};
  useEffect(()=>{cancelRegion();},[editing,disabled]);
  useEffect(()=>{window.addEventListener("blur",cancelRegion);return()=>window.removeEventListener("blur",cancelRegion);},[]);
  const region=regionPreview??state.loop.region;
  const sourceAtX=(x:number,element:HTMLElement)=>{const box=element.getBoundingClientRect();return Math.round(Math.max(0,Math.min(1,(x-box.left)/box.width))*state.totalFrames);};
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ target: number; cancelled: boolean } | null>(null);
  const path = useMemo(() => state.waveform ? waveformPath(state.waveform) : "", [state.waveform]);
  const duration = state.sourceRate ? state.totalFrames / state.sourceRate : 0;
  const elapsed = state.sourceRate ? (state.snapshot?.sourcePosition ?? 0) / state.sourceRate : 0;
  const cancel = () => {
    if (drag.current) drag.current.cancelled = true;
    setPreview(null);
  };
  // Entry identity keys this component; replacement cannot commit an old draft.
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  useEffect(() => {
    const blur = () => { if (drag.current) drag.current.cancelled = true; setPreview(null); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);
  const targetTime = (seconds: number) => state.sourceRate
    ? sourceFrameAtSeconds(seconds, state.sourceRate, state.totalFrames) / state.sourceRate : 0;
  return <div className="player-seek">
    <label className="sr-only" htmlFor="seek-position">Position</label>
    <div className="player-waveform" data-complete={!!path} data-editing={editing}
      onPointerDownCapture={event=>{
        if(!editing||unavailable||event.button!==0||!region)return;
        const boundary=(event.target as HTMLElement).closest<HTMLElement>("[data-boundary]")?.dataset.boundary as "a"|"b"|undefined;
        if(!boundary&&!event.shiftKey)return;
        event.preventDefault();event.stopPropagation();
        if(boundary)(event.target as HTMLElement).closest<HTMLElement>("[data-boundary]")?.focus();
        regionDrag.current={kind:boundary??"region",start:sourceAtX(event.clientX,event.currentTarget),a:region.a,b:region.b};
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event=>{const d=regionDrag.current;if(!d)return;event.stopPropagation();const frame=sourceAtX(event.clientX,event.currentTarget);if(d.kind==="a")d.a=Math.min(frame,d.b-1);else if(d.kind==="b")d.b=Math.max(frame,d.a+1);else{d.a=Math.min(d.start,frame);d.b=Math.max(d.start,frame);}setRegionPreview({a:d.a,b:d.b});}}
      onPointerUp={event=>{const d=regionDrag.current;if(!d)return;event.stopPropagation();cancelRegion();onRegion(d.a,d.b);}}
      onPointerCancel={cancelRegion} onLostPointerCapture={cancelRegion} onBlur={cancelRegion} onKeyDown={event=>{if(event.key==="Escape")cancelRegion();}}>
      {editing&&region?<><span className="player-loop-region" aria-hidden="true" style={{left:`${region.a/state.totalFrames*100}%`,width:`${(region.b-region.a)/state.totalFrames*100}%`}}/>{(["a","b"] as const).map(boundary=><button key={boundary} type="button" role="slider" data-boundary={boundary} className={`player-loop-boundary player-loop-boundary-${boundary}`} aria-label={`Loop ${boundary.toUpperCase()}`} aria-valuemin={0} aria-valuemax={state.totalFrames} aria-valuenow={region[boundary]} aria-valuetext={`Source frame ${region[boundary]}`} style={{left:`${region[boundary]/state.totalFrames*100}%`}} onKeyDown={event=>{const direction=event.key==="ArrowLeft"||event.key==="ArrowDown"?-1:event.key==="ArrowRight"||event.key==="ArrowUp"?1:0;if(!direction)return;event.preventDefault();const value=Math.max(0,Math.min(state.totalFrames,region[boundary]+direction*(event.shiftKey?5:1)*state.sourceRate));onRegion(boundary==="a"?value:region.a,boundary==="b"?value:region.b);}}><span>{boundary.toUpperCase()}</span></button>)}</>:null}
      {path ? <div className="player-wave-envelope" aria-hidden="true">
        <svg viewBox="0 0 320 40" preserveAspectRatio="none"><path d={path} /></svg>
        <svg className="player-wave-consumed" viewBox="0 0 320 40" preserveAspectRatio="none" style={{ clipPath: `inset(0 ${100 - elapsed / duration * 100}% 0 0)` }}><path d={path} /></svg>
      </div> : <span className="player-wave-status" role="status">{state.waveformPhase === "pending" ? "Preparing waveform…" : state.waveformPhase === "failed" ? "Waveform unavailable" : ""}</span>}
      {!unavailable ? <span className="player-consumed-cursor" aria-hidden="true" style={{ left: `${elapsed / duration * 100}%` }} /> : null}
      {preview !== null ? <span className="player-preview-cursor" aria-hidden="true" style={{ left: `${preview / duration * 100}%` }} /> : null}
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
    </div>
    <div className="player-time"><output aria-label="Elapsed media time" aria-live="off">{unavailable ? "—" : mediaTime(elapsed)}</output><span className="player-pixel" role="status">{phaseLabels[state.phase]}</span><output aria-label="Duration" aria-live="off">{unavailable ? "—" : mediaTime(duration)}</output></div>
    <p id="seek-help" className="sr-only">{preview !== null
      ? `Preview ${mediaTime(preview)} · Release to seek. Escape cancels.`
      : "Source amplitude overview; not sample-level detail. Drag to preview, release to seek. Escape or blur cancels. Arrow keys: 5 seconds. Home / End: start / end."}</p>
  </div>;
}
