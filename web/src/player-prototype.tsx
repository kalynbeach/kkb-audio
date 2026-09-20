import { useAppearance } from "../../app/appearance";
import { startTransition, ViewTransition, useEffect, useReducer, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { PrototypeTimeline } from "./player-prototype-timeline";
import { initialSession, sessionReducer, time, type Phase, type Track } from "./player-prototype-state";
import { ArrowLeftIcon, GearSixIcon, PauseIcon, PlayIcon, QueueIcon, RepeatIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, SpeakerSlashIcon, XIcon } from "./player-prototype-icons";

const phaseText: Record<Phase, string> = { empty: "No track loaded", loading: "Preparing track…", paused: "Paused", playing: "Playing", ended: "Ended", error: "Could not load" };

export function PlayerPrototype() {
  const [params] = useState(() => new URLSearchParams(location.search));
  const [state, dispatch] = useReducer(sessionReducer, undefined, initialSession);
  const [libraryOpen, setLibraryOpen] = useState(params.get("view") === "library");
  const [editing, setEditing] = useState(params.get("loop") === "edit");
  const {mode, setMode} = useAppearance();
  const [volume, setVolume] = useState(15);
  const [muted, setMuted] = useState(false);
  const [staticVisual, setStaticVisual] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 1211px)").matches);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontRole, setFontRole] = useState("inter");
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const loaded = state.tracks.find(track => track.id === state.loaded);
  const duration = loaded?.duration ?? 272;
  const available = !!loaded && state.phase !== "empty" && state.phase !== "loading" && state.phase !== "error";

  useEffect(() => {
    const query = matchMedia("(max-width: 1211px)");
    const change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (state.phase !== "playing") return;
    const timer = setInterval(() => dispatch({ type: "tick" }), 250);
    return () => clearInterval(timer);
  }, [state.phase]);
  useEffect(() => { if (libraryOpen) libraryHeading.current?.focus(); }, [libraryOpen]);
  useEffect(() => {
    if (params.get("loop") === "edit") {
      dispatch({ type: "region", a: 48, b: 96 });
      dispatch({ type: "loop", enabled: true });
    }
  }, []);

  const openLibrary = () => startTransition(() => setLibraryOpen(true));
  const closeLibrary = () => { startTransition(() => setLibraryOpen(false)); libraryToggle.current?.focus(); };
  const playTrack = (id: string) => dispatch({ type: "activate", id, playing: true });
  const moveTrack = (direction: number) => {
    const index = state.tracks.findIndex(track => track.id === state.loaded);
    const next = state.tracks[index + direction];
    if (next) dispatch({ type: "activate", id: next.id, playing: state.phase === "playing" });
  };
  const library = <section id="prototype-library" className="prototype-library" aria-labelledby="library-heading">
    <header className="prototype-library-header">
      {narrow ? <Button variant="ghost" size="icon" aria-label="Return to visual" onClick={closeLibrary}>{ArrowLeftIcon}</Button> : null}
      <h2 id="library-heading" ref={libraryHeading} tabIndex={-1}>Library <span>{state.tracks.length} tracks</span></h2>
      {!narrow ? <Button variant="ghost" size="icon" aria-label="Close library" onClick={closeLibrary}>{XIcon}</Button> : null}
    </header>
    <div className="prototype-library-scroll" aria-label="Session tracks" tabIndex={0}>
      {state.tracks.length ? <ul>{state.tracks.map(track => <TrackRow key={track.id} track={track} selected={track.id === state.selected}
        current={track.id === state.loaded && available} playing={track.id === state.loaded && state.phase === "playing"}
        onSelect={() => dispatch({ type: "select", id: track.id })}
        onPlay={() => track.id === state.loaded && state.phase === "playing" ? dispatch({ type: "play" }) : playTrack(track.id)} />)}</ul>
        : <div className="prototype-empty"><p>No tracks available.</p></div>}
    </div>
  </section>;

  return <>
    <header className="prototype-app-header"><span>Wave Player <span className="prototype-pixel">/ PROTOTYPE</span></span>
      <Dialog.Root open={settingsOpen} onOpenChange={open => startTransition(() => setSettingsOpen(open))}>
        <Dialog.Trigger render={<Button variant="ghost" size="icon" aria-label="Settings" title="Settings" />}>{GearSixIcon}</Dialog.Trigger>
        <Dialog.Portal keepMounted>{settingsOpen ? <ViewTransition default="none" enter="fade-in" exit="fade-out"><Dialog.Backdrop className="prototype-scrim" /><Dialog.Popup className="prototype-settings">
          <div className="prototype-settings-heading"><Dialog.Title>Settings</Dialog.Title><Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close settings" />}>{XIcon}</Dialog.Close></div>
          <Dialog.Description>Appearance changes the view, never the playback state.</Dialog.Description>
          <p id="mode-label">Appearance</p>
          <ToggleGroup value={[mode]} onValueChange={values => { const value = values[0]; if (value === "system" || value === "light" || value === "dark") setMode(value); }} aria-labelledby="mode-label">
            <ToggleGroupItem value="system">System</ToggleGroupItem><ToggleGroupItem value="light">Light</ToggleGroupItem><ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
          <label className="prototype-setting-checkbox"><input type="checkbox" checked={staticVisual} onChange={event => { const checked = event.target.checked; startTransition(() => setStaticVisual(checked)); }} />Use static visual fallback</label>
          <p className="prototype-settings-note">No preferences are saved. Reduced motion skips UI animations. The visual is static and playback is silent.</p>
        </Dialog.Popup></ViewTransition> : null}</Dialog.Portal>
      </Dialog.Root>
    </header>
    <main className="prototype-stage">
      <div className="prototype-composition" data-library={libraryOpen && !narrow}>
        <section className="prototype-card" aria-label="Wave Player" data-title-font={fontRole}>
          <header className="prototype-track-header">
            <h1 title={loaded?.title}>{state.phase === "empty" ? "Choose your music" : loaded?.title ?? "Choose your music"}</h1>
            <p title={loaded?.artist ? `${loaded.artist} · ${loaded.album}` : loaded?.title}>{loaded && state.phase !== "empty" ? loaded.artist ? <>{loaded.artist}<span className="prototype-dot"> · </span>{loaded.album}</> : "Metadata unavailable" : "Local files. This session only."}</p>
          </header>
          <ViewTransition key={narrow && libraryOpen ? "library" : staticVisual ? "fallback" : "visual"} default="none" enter="fade-in" exit="fade-out">
          <div className="prototype-main-field">
            {narrow && libraryOpen ? library : state.phase === "loading" || state.phase === "error" || state.phase === "empty" ? <div className="prototype-empty">
              <span className="prototype-pixel">{state.phase === "loading" ? "PREPARING" : state.phase === "error" ? "UNAVAILABLE" : "YOUR MUSIC"}</span>
              <p>{state.phase === "loading" ? "Preparing this track…" : state.phase === "error" ? "This track could not be loaded." : "Choose a track from your library."}</p>
              {state.phase === "loading" ? <><Button variant="outline" onClick={() => dispatch({ type: "scenario", phase: "paused" })}>Finish simulated load</Button><Button variant="ghost" onClick={() => dispatch({ type: "scenario", phase: "empty" })}>Cancel</Button></> : <Button variant="outline" onClick={openLibrary}>Browse library</Button>}
            </div> : <figure className="prototype-visual" data-fallback={staticVisual}>
              {staticVisual ? <div className="prototype-static-signal"><span /><p>Visual unavailable</p><small>Playback controls remain available.</small></div>
                : <img src="/prototype-assets/signal.jpg" alt="Static phosphor-green signal study, not audio-reactive" draggable={false} onError={() => setStaticVisual(true)} />}
              <figcaption className="sr-only">Static design reference. No sound or live signal analysis.</figcaption>
            </figure>}
          </div>
          </ViewTransition>
          <div className="prototype-navigation">
            <PrototypeTimeline key={state.loaded} duration={duration} position={state.position} loop={state.loop} editing={editing && available} disabled={!available}
              onSeek={position => dispatch({ type: "seek", position })} onRegion={(a, b) => dispatch({ type: "region", a, b })}
              onEnable={enabled => dispatch({ type: "loop", enabled })} onReady={() => dispatch({ type: "loop-phase", phase: "ready" })} />
          </div>
          <footer className="prototype-transport">
            <div className="prototype-utilities">
              <Popover.Root><Popover.Trigger render={<Button variant="ghost" size="icon" aria-label="Volume" title={muted ? "Volume (muted)" : `Volume ${volume}%`} />}>{muted || volume === 0 ? SpeakerSlashIcon : SpeakerHighIcon}</Popover.Trigger>
                <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={8} className="prototype-popover-positioner"><Popover.Popup className="prototype-volume-popup">
                  <Popover.Title id="prototype-volume-label" className="sr-only">Volume</Popover.Title>
                  <Button variant="ghost" size="icon-xs" aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted(value => !value)}>{muted ? SpeakerSlashIcon : SpeakerHighIcon}</Button>
                  <Slider value={[volume]} min={0} max={100} step={1} aria-labelledby="prototype-volume-label" onValueChange={values => setVolume(Array.isArray(values) ? values[0]! : values)} />
                  <output aria-label="Volume level">{volume}%</output>
                </Popover.Popup></Popover.Positioner></Popover.Portal>
              </Popover.Root>
              <Button variant="ghost" size="icon" disabled={!available} aria-label={editing ? "Close loop editor" : "Edit loop"} title={state.loop.enabled ? "Edit loop (enabled)" : "Edit loop (off)"}
                aria-expanded={editing} data-active={state.loop.enabled} onClick={() => startTransition(() => setEditing(value => !value))}>{RepeatIcon}</Button>
            </div>
            <div className="prototype-playback">
              <Button variant="ghost" size="icon" aria-label="Previous track" disabled={state.tracks.findIndex(track => track.id === state.loaded) <= 0} onClick={() => moveTrack(-1)}>{SkipBackIcon}</Button>
              <Button variant="secondary" size="icon-lg" className="prototype-play" aria-label={state.phase === "playing" ? "Pause" : state.phase === "ended" ? "Replay" : "Play"}
                disabled={!available} onClick={() => dispatch({ type: "play" })}>{state.phase === "playing" ? PauseIcon : PlayIcon}</Button>
              <Button variant="ghost" size="icon" aria-label="Next track" disabled={state.tracks.findIndex(track => track.id === state.loaded) >= state.tracks.length - 1} onClick={() => moveTrack(1)}>{SkipForwardIcon}</Button>
            </div>
            <Button ref={libraryToggle} variant="ghost" size="icon" className="prototype-library-trigger" aria-label={libraryOpen ? "Hide library" : "Show library"} title="Library"
              aria-expanded={libraryOpen} aria-controls="prototype-library" onClick={() => libraryOpen ? closeLibrary() : openLibrary()}>{QueueIcon}</Button>
          </footer>
        </section>
        {!narrow && libraryOpen ? <ViewTransition default="none" enter="fade-in" exit="fade-out">{library}</ViewTransition> : null}
      </div>
    </main>
    <footer className="prototype-review-footer">
      <p>Design prototype — simulated waveform and playback. No audio.</p>
      <Button variant="ghost" size="xs" aria-expanded={inspector} onClick={() => setInspector(value => !value)}>Review controls</Button>
    </footer>
    {inspector ? <aside className="prototype-review-controls" aria-label="Prototype review controls">
      <div><p>Controlled state</p><div className="prototype-scenarios">{(["empty", "loading", "paused", "playing", "ended", "error"] as const).map(phase => <Button key={phase} size="sm" variant="outline" onClick={() => dispatch({ type: "scenario", phase })}>{phaseText[phase]}</Button>)}</div></div>
      <div><p>Loop state</p><div className="prototype-scenarios">{(["ready", "preparing", "failed"] as const).map(phase => <Button key={phase} size="sm" variant="outline" onClick={() => { setEditing(true); dispatch({ type: "loop-phase", phase }); }}>{phase}</Button>)}<Button size="sm" variant="outline" onClick={() => { dispatch({ type: "region", a: 48, b: 96 }); dispatch({ type: "loop", enabled: true }); setEditing(true); }}>Example A/B</Button></div></div>
      <div><p id="title-role-label">Loaded title study</p><ToggleGroup value={[fontRole]} onValueChange={values => { if (values[0]) setFontRole(String(values[0])); }} aria-labelledby="title-role-label"><ToggleGroupItem value="inter">Inter</ToggleGroupItem><ToggleGroupItem value="tx">TX-02</ToggleGroupItem></ToggleGroup></div>
      <Button variant="outline" onClick={() => { dispatch({ type: "reset" }); setEditing(false); }}>Restore fixture collection</Button>
      <p>Loop policy under review: enabling outside the region moves to A without starting playback; seeking outside disables the loop, retaining its bounds. Edits commit on release; Escape cancels.</p>
      <pre>{JSON.stringify({ phase: state.phase, loaded: state.loaded, selected: state.selected, position: Number(state.position.toFixed(2)), loop: state.loop, volume, muted, libraryOpen }, null, 2)}</pre>
    </aside> : null}
    <p role="status" className="sr-only">{state.notice}</p>
  </>;
}

function TrackRow({ track, selected, current, playing, onSelect, onPlay }: {
  track: Track; selected: boolean; current: boolean; playing: boolean;
  onSelect: () => void; onPlay: () => void;
}) {
  const metadata = track.failed ? "Unavailable · choose another track" : track.artist ? `${track.artist} · ${track.album}` : "Metadata unavailable";
  return <li className="prototype-track-row" data-selected={selected} data-current={current}>
    <button className="prototype-track-select" type="button" onClick={onSelect} aria-pressed={selected} aria-current={current ? "true" : undefined} aria-label={`Select ${track.title}`} aria-describedby={`prototype-track-${track.id}-meta`}>
      <span className="prototype-track-copy">
        <span className="prototype-track-title" data-filename={!track.artist} title={track.title}>{track.title}</span>
        <span id={`prototype-track-${track.id}-meta`} className="prototype-track-meta" title={metadata}>{metadata}</span>
      </span>
      <span className="prototype-track-duration">{track.failed || !track.artist ? "—" : time(track.duration)}</span>
    </button>
    {current ? <span className="prototype-track-cue" aria-hidden="true">{playing ? SpeakerHighIcon : <span className="prototype-current-dot" />}</span> : null}
    <Button variant="ghost" size="icon" className="prototype-track-play" aria-label={`${playing ? "Pause" : "Play"} ${track.title}`} aria-describedby={`prototype-track-${track.id}-meta`} onClick={onPlay}>{playing ? PauseIcon : PlayIcon}</Button>
  </li>;
}
