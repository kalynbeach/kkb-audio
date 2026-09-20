import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PlaybackOwner } from "../web/src/playback-owner";
import { FakeMediaLoopPlayback } from "../web/test/media-loop-fixture";
import { FakePlayback, deferred } from "../web/test/playback-fixture";

GlobalRegistrator.register({ url: "http://localhost/player" });
HTMLElement.prototype.setPointerCapture = () => {};
// UI fixtures do not fetch/build real Wasm; compiled-worker coverage lives separately.
const unavailableWaveform = async () => { throw new Error("Fixture waveform unavailable"); };
const measure = HTMLElement.prototype.getBoundingClientRect;
// Happy DOM has no layout; Base UI's edge-aligned slider needs nonzero measurement.
HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.hasAttribute("data-base-ui-slider-control")) return new DOMRect(0, 0, 100, 44);
  if (this.dataset.slot === "slider-thumb") return new DOMRect(0, 0, 12, 12);
  return measure.call(this);
};
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { PlayerApp } = await import("../web/src/player-app");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("WAV loop disclosure, exact frame fields, keyboard handles and terminal retry clarity",async()=>{
  const playback=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>playback,unavailableWaveform);
  const view=render(<PlayerApp owner={owner}/>);await act(()=>owner.load(new File([],"loop.wav")));
  await userEvent.setup().click(view.getByRole("button",{name:"Loop editor"}));
  expect(playback.loopCalls).toEqual([]);expect(view.getByRole("checkbox",{name:"Loop"})).toBeTruthy();
  const a=view.getByRole("textbox",{name:"Loop A time"});
  fireEvent.change(a,{target:{value:"48000f"}});fireEvent.keyDown(a,{key:"Enter"});await waitFor(()=>expect(owner.getState().loop.region?.a).toBe(48000));
  expect(playback.loopCalls).toEqual([]);
  fireEvent.change(a,{target:{value:"bad"}});fireEvent.keyDown(a,{key:"Enter"});expect(a.getAttribute("aria-invalid")).toBe("true");fireEvent.keyDown(a,{key:"Escape"});expect(a.getAttribute("aria-invalid")).toBe("false");
  await userEvent.setup().click(view.getByRole("checkbox",{name:"Loop"}));await waitFor(()=>expect(owner.getState().loop.phase).toBe("Armed"));expect(playback.paused).toBe(true);
  fireEvent.keyDown(view.getByRole("slider",{name:"Loop A"}),{key:"ArrowRight",shiftKey:true});await waitFor(()=>expect(owner.getState().loop.region?.a).toBe(288000));await waitFor(()=>expect(owner.getState().loop.enabled).toBe(false));expect(playback.snapshot.pcmPosition).toBe(48000);
  await act(()=>owner.setLoopEnabled(true));await act(()=>owner.play());
  playback.snapshot={...playback.snapshot,ready:false,loopRecovering:true,loopUnderruns:1};await act(()=>owner.refresh());
  expect(view.getByRole("button",{name:/^Pause$/}).hasAttribute("disabled")).toBe(false);
  await act(()=>owner.pause());expect(view.getByRole("button",{name:/^Play$/})).toBeTruthy();
  playback.snapshot={...playback.snapshot,ready:true,loopRecovering:false};await act(()=>owner.refresh());
  playback.pendingStatus=deferred();const failure=owner.refresh();playback.pendingStatus.reject(Error("terminal source failure"));await act(()=>failure);
  expect(view.queryByRole("checkbox",{name:"Loop"})).toBeNull();expect(view.getByText(/Loop Failed — source unavailable/)).toBeTruthy();
});

async function setup() {
  const playback = new FakePlayback();
  const owner = new PlaybackOwner(async () => playback, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />);
  await act(() => owner.load(new File([], "quiet.wav")));
  return { playback, owner, view, seek: view.getByRole("slider", { name: "Position" }) };
}

test.each(["wav", "mp3"])("multi-file %s admission never prepares; row selection is independent from explicit play", async extension => {
  const playback = new FakePlayback(); let preparations = 0;
  const owner = new PlaybackOwner(async () => { preparations++; return playback; }, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />);
  expect(view.getByRole("button", { name: "Play" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByText("No track loaded")).toBeTruthy();
  expect(view.queryByText("YOUR MUSIC")).toBeNull();
  expect(view.getByText("Open local WAV or MP3 files.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Open files" })).toBeTruthy();
  await userEvent.setup().upload(view.getByLabelText("Add local WAV or MP3 files"), [new File(["fixture"], `quiet.${extension}`), new File(["fixture"], "other.wav")]);
  expect(preparations).toBe(0);
  expect(view.getByLabelText("Duration").textContent).toBe("—");
  await userEvent.setup().click(view.getByRole("button", { name: "Select other.wav" }));
  expect(preparations).toBe(0);
  await userEvent.setup().click(view.getByRole("button", { name: `Play quiet.${extension}` }));
  await waitFor(() => expect(view.getByText("Playing", { exact: true })).toBeTruthy());
  expect(preparations).toBe(1);
  expect(view.getByRole("button", { name: "Select other.wav" }).getAttribute("aria-pressed")).toBe("true");
});

test("drag previews separately from consumed time, release commits exactly once and waits for readiness", async () => {
  const { playback, owner, view, seek } = await setup();
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 });
  fireEvent.change(seek, { target: { value: "3" } });
  fireEvent.change(seek, { target: { value: "4" } });
  expect(playback.seeks).toEqual([]);
  expect(view.getByText(/Preview 0:04 · Release/)).toBeTruthy();
  expect(view.getByLabelText("Elapsed media time").textContent).toBe("0:00");
  const held = playback.pendingSeek = deferred();
  fireEvent.pointerUp(seek, { pointerId: 1 });
  await waitFor(() => expect(playback.seeks).toEqual([192000]));
  expect(view.getByText("Seeking…")).toBeTruthy();
  expect(view.getByLabelText("Elapsed media time").textContent).toBe("0:00");
  await act(async () => { held.resolve(); await owner.refresh(); });
  expect(view.getByLabelText("Elapsed media time").textContent).toBe("0:04");
  expect(view.getByText("Paused")).toBeTruthy();
});

test.each(["escape", "pointercancel", "blur", "windowblur", "lostcapture"])("%s cancels preview without seeking", async cancellation => {
  const { playback, view, seek } = await setup();
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 });
  fireEvent.change(seek, { target: { value: "3" } });
  if (cancellation === "escape") fireEvent.keyDown(seek, { key: "Escape" });
  else if (cancellation === "pointercancel") fireEvent.pointerCancel(seek, { pointerId: 1 });
  else if (cancellation === "lostcapture") fireEvent.lostPointerCapture(seek, { pointerId: 1 });
  else if (cancellation === "windowblur") fireEvent(window, new Event("blur"));
  else fireEvent.blur(seek);
  if (cancellation === "escape" || cancellation === "blur" || cancellation === "windowblur") {
    // Focus loss and Escape do not end a held-pointer gesture.
    await act(() => { fireEvent.change(seek, { target: { value: "4" } }); });
    expect(playback.seeks).toEqual([]);
    expect(view.queryByText(/Preview 0:04/)).toBeNull();
  }
  fireEvent.pointerUp(seek, { pointerId: 1 });
  expect(playback.seeks).toEqual([]);
  expect(view.queryByText(/Preview 0:03/)).toBeNull();
  fireEvent.keyDown(seek, { key: "ArrowRight" });
  await waitFor(() => expect(playback.seeks).toEqual([240000]));
});

test("keyboard seeking, endpoint and explicit replay preserve playback intent", async () => {
  const { playback, view, seek } = await setup();
  const user = userEvent.setup();
  await user.click(view.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Pause" })).toBeTruthy());
  seek.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(playback.seeks).toEqual([240000]));
  await waitFor(() => expect(view.getByText("Playing", { exact: true })).toBeTruthy());
  await user.keyboard("{End}");
  await waitFor(() => expect(view.getByText("Ended", { exact: true })).toBeTruthy());
  expect(playback.seeks).toEqual([240000, 480000]);
  await user.click(view.getByRole("button", { name: "Replay" }));
  await waitFor(() => expect(playback.seeks).toEqual([240000, 480000, 0]));
  await waitFor(() => expect(view.getByText("Playing", { exact: true })).toBeTruthy());
  await user.click(view.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(view.getByText("Paused")).toBeTruthy());
  seek.focus();
  await user.keyboard("{Home}");
  await waitFor(() => expect(playback.seeks).toEqual([240000, 480000, 0, 0]));
});

test("accessible volume popup has keyboard control, mute and focus return independent of playback", async () => {
  const { playback, view } = await setup();
  const user = userEvent.setup();
  view.getByRole("button", { name: "Volume" }).focus(); await user.keyboard("{Enter}");
  const volume = await view.findByRole("slider", { name: "Listening volume" });
  act(() => volume.focus()); await user.keyboard("{ArrowRight}");
  await user.click(view.getByRole("button", { name: "Mute" }));
  expect(view.getByRole("button", { name: "Unmute" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(view.getByRole("button", { name: "Unmute" }));
  expect(playback.gains).toEqual([0.15, 0.16, 0, 0.16]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole("button", { name: "Volume" })));
  expect(playback.seeks).toEqual([]);
});

test("endpoint keeps keyboard focus; seeking back from Ended requires explicit Play", async () => {
  const { playback, view, seek } = await setup();
  const user = userEvent.setup();
  await user.click(view.getByRole("button", { name: "Play" }));
  seek.focus();
  await user.keyboard("{End}");
  await waitFor(() => expect(view.getByText("Ended", { exact: true })).toBeTruthy());
  expect(document.activeElement).toBe(seek);
  expect(seek.hasAttribute("disabled")).toBe(false);
  expect(playback.paused).toBe(true);
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(view.getByText("Paused")).toBeTruthy());
  expect(playback.paused).toBe(true);
  expect(playback.seeks).toEqual([480000, 240000]);
  await user.click(view.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(view.getByText("Playing", { exact: true })).toBeTruthy());
});

test("playing drag preview survives periodic consumed updates and resumes acknowledged playing state", async () => {
  const { playback, owner, view, seek } = await setup();
  await act(() => owner.play());
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 });
  fireEvent.change(seek, { target: { value: "7" } });
  playback.snapshot = { ...playback.snapshot, sourcePosition: 48000, pcmPosition: 48000, renderFrame: 48000 };
  await act(() => owner.refresh());
  expect(view.getByLabelText("Elapsed media time").textContent).toBe("0:01");
  expect(view.getByText(/Preview 0:07 · Release/)).toBeTruthy();
  expect(playback.seeks).toEqual([]);
  fireEvent.pointerUp(seek, { pointerId: 1 });
  await waitFor(() => expect(playback.seeks).toEqual([336000]));
  await waitFor(() => expect(view.getByText("Playing", { exact: true })).toBeTruthy());
  expect(view.getByLabelText("Elapsed media time").textContent).toBe("0:07");
});

test("library/Settings/theme/responsive disclosures preserve owner and seek identity, and return focus", async () => {
  let preparations = 0; const playback = new FakePlayback();
  const owner = new PlaybackOwner(async () => { preparations++; return playback; }, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />); const user = userEvent.setup();
  await user.upload(view.getByLabelText("Add local WAV or MP3 files"), new File(["fixture"], "quiet.wav"));
  await user.click(view.getByRole("button", { name: "Play quiet.wav" }));
  await waitFor(() => expect(owner.getState().phase).toBe("playing"));
  const seek = view.getByRole("slider", { name: "Position" });
  await act(() => owner.seek(3));
  await user.click(view.getByRole("button", { name: "Hide library" }));
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole("button", { name: "Show library" })));
  await user.click(view.getByRole("button", { name: "Show library" }));
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole("heading", { name: /Library/ })));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole("button", { name: "Show library" })));
  await user.click(view.getByRole("button", { name: "Settings" }));
  await user.click(await view.findByRole("button", { name: "Dark" }));
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole("button", { name: "Settings" })));
  act(() => { (window as unknown as { happyDOM: { setWindowSize(size: { width: number; height: number }): void } }).happyDOM.setWindowSize({ width: 390, height: 844 }); });
  await user.click(view.getByRole("button", { name: "Show library" }));
  await waitFor(() => expect(view.container.querySelector(".player-main-field .player-library")).toBeTruthy());
  expect(view.getByRole("slider", { name: "Position" })).toBe(seek);
  expect(owner.getState().phase).toBe("playing"); expect(owner.getState().snapshot!.sourcePosition).toBe(144000);
  expect(preparations).toBe(1); expect(playback.closeCount).toBe(0);
});

test("same-named entry replacement cancels an uncommitted seek, and session removal/Clear stays recoverable", async () => {
  const prepared: FakePlayback[] = [];
  const owner = new PlaybackOwner(async () => { const p = new FakePlayback(); prepared.push(p); return p; }, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />); const user = userEvent.setup();
  await user.upload(view.getByLabelText("Add local WAV or MP3 files"), [new File(["a"], "same.wav"), new File(["b"], "same.wav")]);
  await user.click(view.getAllByRole("button", { name: "Play same.wav" })[0]!);
  await waitFor(() => expect(owner.getState().phase).toBe("playing"));
  const seek = view.getByRole("slider", { name: "Position" });
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 }); fireEvent.change(seek, { target: { value: "7" } });
  await user.click(view.getByRole("button", { name: "Next track" }));
  await waitFor(() => expect(prepared).toHaveLength(2));
  fireEvent.pointerUp(seek, { pointerId: 1 });
  expect(view.getByRole("slider", { name: "Position" })).not.toBe(seek);
  expect(prepared.every(p => p.seeks.length === 0)).toBe(true);
  // Selection is still the first (inactive) file.
  await user.click(view.getByRole("button", { name: "Settings" }));
  await user.click(await view.findByRole("button", { name: "Remove selected" }));
  expect(owner.getState().phase).toBe("playing"); expect(prepared[1]!.closeCount).toBe(0);
  await user.click(view.getByRole("button", { name: "Clear session" }));
  expect(owner.getState().phase).toBe("empty"); expect(prepared[1]!.closeCount).toBe(1);
  expect(view.getByRole("button", { name: "Add files" }).hasAttribute("disabled")).toBe(false);
});

test("loading is cancellable from internal library Settings; malformed files remain browsable and retryable", async () => {
  const held = deferred<FakePlayback>(); let count = 0;
  const owner = new PlaybackOwner(async () => { if (++count === 1) return held.promise; if (count === 2) throw new Error("Unsupported WAV encoding"); return new FakePlayback(); }, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />); const user = userEvent.setup();
  await user.upload(view.getByLabelText("Add local WAV or MP3 files"), [new File(["a"], "late.wav"), new File(["b"], "bad.wav")]);
  await user.click(view.getByRole("button", { name: "Play late.wav" }));
  await waitFor(() => expect(owner.getState().phase).toBe("loading"));
  await user.click(view.getByRole("button", { name: "Settings" }));
  await user.click(await view.findByRole("button", { name: "Cancel loading" }));
  const late = new FakePlayback(); await act(async () => { held.resolve(late); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(late.closeCount).toBe(1); expect(owner.getState().phase).toBe("empty");
  await user.keyboard("{Escape}");
  await user.click(await view.findByRole("button", { name: "Play bad.wav" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Unsupported WAV encoding"));
  await user.click(view.getByRole("button", { name: "Select late.wav" }));
  await user.click(view.getByRole("button", { name: "Play bad.wav" }));
  await waitFor(() => expect(owner.getState().phase).toBe("playing"));
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByRole("button", { name: "Select late.wav" }).getAttribute("aria-pressed")).toBe("true");
});

test("completed source waveform keeps consumed progress separate and reconciles an adjusted seek", async () => {
  class AdjustedPlayback extends FakePlayback {
    override async seek(target: number) {
      const result = await super.seek(target);
      this.snapshot.sourcePosition = Math.max(0, target - 1);
      return { ...result, actualMediaFrame: this.snapshot.sourcePosition, result: "Adjusted" as const };
    }
  }
  const playback = new AdjustedPlayback();
  const job = deferred<import("../web/src/source-waveform").SourceWaveform>();
  const owner = new PlaybackOwner(async () => playback, () => job.promise);
  const view = render(<PlayerApp owner={owner} />);
  await act(() => owner.load(new File([], "source.wav")));
  expect(view.getByText("Preparing waveform…")).toBeTruthy();
  expect(view.getByRole("button", { name: "Play" }).hasAttribute("disabled")).toBe(false);
  await act(async () => { job.resolve({ totalFrames: 480000, sourceRate: 48000, framesPerBin: 480000, extrema: new Float32Array([-0.5, 0.5]) }); });
  const path = view.container.querySelector(".player-wave-envelope path")!.getAttribute("d");
  const seek = view.getByRole("slider", { name: "Position" });
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 });
  fireEvent.change(seek, { target: { value: "4" } });
  expect((view.container.querySelector(".player-consumed-cursor") as HTMLElement).style.left).toBe("0%");
  expect((view.container.querySelector(".player-preview-cursor") as HTMLElement).style.left).toBe("40%");
  fireEvent.pointerUp(seek, { pointerId: 1 });
  await waitFor(() => expect(owner.getState().seekResult?.result).toBe("Adjusted"));
  expect((seek as HTMLInputElement).valueAsNumber).toBe(191999 / 48000);
  expect(view.container.querySelector(".player-preview-cursor")).toBeNull();
  expect(parseFloat((view.container.querySelector(".player-consumed-cursor") as HTMLElement).style.left)).toBeCloseTo(191999 / 480000 * 100);
  await act(() => { owner.setVolume(0.8); owner.setMuted(true); });
  expect(view.container.querySelector(".player-wave-envelope path")!.getAttribute("d")).toBe(path);
});

test("Settings Pause visual leaves audio running and its stable canvas visible across status polls", async () => {
  const original = HTMLCanvasElement.prototype.getContext;
  let draws = 0;
  const context = { fillRect() { draws++; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {} };
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof original;
  try {
    const { owner, view } = await setup();
    await act(() => owner.play());
    const user = userEvent.setup();
    await user.click(view.getByRole("button", { name: "Settings" }));
    await user.click(view.getByRole("button", { name: "Pause visual" }));
    expect(view.getByText("Visual paused · audio unchanged")).toBeTruthy();
    expect(owner.getState().phase).toBe("playing");
    const canvas = view.container.querySelector("canvas")!;
    const before = draws;
    await act(() => owner.refresh()); await act(() => owner.refresh());
    expect(canvas.hidden).toBe(false); expect(draws).toBe(before);
    await user.click(view.getByRole("button", { name: "Resume visual" }));
    expect(owner.getState().phase).toBe("playing");
    await act(() => owner.close());
  } finally { HTMLCanvasElement.prototype.getContext = original; }
});

test("visual failure keeps its explanation after reduced motion is toggled without remounting", async () => {
  const originalContext = HTMLCanvasElement.prototype.getContext;
  const originalMedia = globalThis.matchMedia;
  let reduced = false;
  const query = originalMedia("(prefers-reduced-motion: reduce)");
  Object.defineProperty(query, "matches", { configurable: true, get: () => reduced });
  globalThis.matchMedia = value => value === "(prefers-reduced-motion: reduce)" ? query : originalMedia(value);
  HTMLCanvasElement.prototype.getContext = () => null;
  try {
    const { owner, view } = await setup();
    let reads = 0;
    owner.readOscilloscope = () => { reads++; return 2; };
    await act(() => owner.play());
    expect(view.getByText("Visual unavailable · playback controls remain available")).toBeTruthy();
    const canvas = view.container.querySelector("canvas");
    for (const preference of [true, false]) {
      reduced = preference;
      await act(() => { query.dispatchEvent(new Event("change")); });
      await act(() => owner.refresh());
    }
    expect(view.getByText("Visual unavailable · playback controls remain available")).toBeTruthy();
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(canvas!.hidden).toBe(true);
    expect(reads).toBe(0);
    expect(owner.getState().phase).toBe("playing");
    await act(() => owner.close());
  } finally { HTMLCanvasElement.prototype.getContext = originalContext; globalThis.matchMedia = originalMedia; }
});

test("reduced motion observed by polling redraws only a baseline even without a media-change event", async () => {
  const originalContext = HTMLCanvasElement.prototype.getContext;
  const originalMedia = globalThis.matchMedia;
  let reduced = false; let draws = 0; let vertices = 0;
  const query = originalMedia("(prefers-reduced-motion: reduce)");
  Object.defineProperty(query, "matches", { configurable: true, get: () => reduced });
  globalThis.matchMedia = value => value === "(prefers-reduced-motion: reduce)" ? query : originalMedia(value);
  const context = { fillRect() { draws++; vertices = 0; }, beginPath() {}, moveTo() { vertices++; }, lineTo() { vertices++; }, stroke() {}, setLineDash() {} };
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof originalContext;
  try {
    const { owner, view } = await setup();
    let reads = 0;
    owner.readOscilloscope = () => { reads++; return 2; };
    await act(() => owner.play());
    await waitFor(() => expect(view.getByText("Live oscilloscope")).toBeTruthy());
    expect(vertices).toBeGreaterThan(2);
    const before = draws; const readsBefore = reads;
    reduced = true; // Deliberately no matchMedia event; owner polling must reconcile pixels.
    await act(() => owner.refresh());
    expect(view.getByText("Reduced motion · live visual off")).toBeTruthy();
    expect(vertices).toBe(2); expect(draws).toBe(before + 1);
    await act(() => owner.refresh()); await act(() => owner.refresh());
    expect(draws).toBe(before + 1); expect(reads).toBe(readsBefore);
    expect(owner.getState().phase).toBe("playing");
    await act(() => owner.close());
  } finally { HTMLCanvasElement.prototype.getContext = originalContext; globalThis.matchMedia = originalMedia; }
});

test("initial seven-output-frame WAV exposes its loop reason while linear Play remains usable",async()=>{
  const p=new FakeMediaLoopPlayback();p.totalFrames=7;
  const owner=new PlaybackOwner(async()=>p,unavailableWaveform);const view=render(<PlayerApp owner={owner}/>);
  try{
    await act(()=>owner.load(new File([],"seven.wav")));
    const trigger=view.getByRole("button",{name:"Loop editor"});expect(trigger.hasAttribute("disabled")).toBe(false);
    await userEvent.setup().click(trigger);
    expect(view.getByRole("group",{name:"Loop editor"}).textContent).toContain("8");
    expect(view.queryByRole("checkbox",{name:"Loop"})).toBeNull();
    expect(view.getByRole("button",{name:/^Play$/}).hasAttribute("disabled")).toBe(false);
    await act(()=>owner.play());expect(owner.getState().phase).toBe("playing");expect(p.loopCalls).toEqual([]);
  }finally{await act(()=>owner.close());}
});

test("loop disclosure preserves the single failed visual caption and closed enabled cue",async()=>{
  const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=()=>null;
  const p=new FakeMediaLoopPlayback();const owner=new PlaybackOwner(async()=>p,unavailableWaveform);
  try{
    const view=render(<PlayerApp owner={owner}/>);await act(()=>owner.load(new File([],"loop.wav")));
    const caption=view.container.querySelector("figcaption")!;const canvas=view.container.querySelector("canvas");
    const trigger=view.getByRole("button",{name:"Loop editor"});
    await userEvent.setup().click(trigger);
    expect(view.container.querySelector(".player-oscilloscope")?.getAttribute("data-loop-editing")).toBe("true");
    fireEvent.click(view.getByText("Loop coordinates & limits"));
    expect(view.container.querySelector("figcaption")).toBe(caption);expect(caption.querySelectorAll('[role="status"]').length).toBe(1);
    expect(caption.textContent).toContain("Visual unavailable");expect(view.container.querySelector("canvas")).toBe(canvas);
    await act(()=>owner.setLoopEnabled(true));await userEvent.setup().click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");expect(trigger.getAttribute("data-active")).toBe("true");
    expect(trigger.getAttribute("title")).toContain("Loop enabled");
    await act(()=>owner.setLoopEnabled(false));expect(trigger.getAttribute("data-active")).toBe("false");
    expect(caption.textContent).toContain("Visual unavailable");
  }finally{await act(()=>owner.close());HTMLCanvasElement.prototype.getContext=original;}
});

test("an open loop editor remains dismissible after closing the track", async () => {
  const playback = new FakeMediaLoopPlayback();
  const owner = new PlaybackOwner(async () => playback, unavailableWaveform);
  const view = render(<PlayerApp owner={owner} />);
  await act(() => owner.load(new File([], "loop.wav")));
  await userEvent.setup().click(view.getByRole("button", { name: "Loop editor" }));
  await act(() => owner.close());
  const toggle = view.getByRole("button", { name: "Loop editor" });
  expect(toggle.hasAttribute("disabled")).toBe(false);
  await userEvent.setup().click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText("Loops unavailable.")).toBeNull();
});
