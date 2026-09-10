import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PlaybackOwner } from "../web/src/playback-owner";
import { FakePlayback, deferred } from "../web/test/playback-fixture";

GlobalRegistrator.register({ url: "http://localhost/player.html" });
HTMLElement.prototype.setPointerCapture = () => {};
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { PlayerApp } = await import("../web/src/player-app");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

async function setup() {
  const playback = new FakePlayback();
  const owner = new PlaybackOwner(async () => playback);
  const view = render(<PlayerApp owner={owner} />);
  await act(() => owner.load(new File([], "quiet.wav")));
  return { playback, owner, view, seek: view.getByRole("slider", { name: "Position" }) };
}

test("labelled empty player never starts audio, supports file selection and close focus", async () => {
  const playback = new FakePlayback();
  const owner = new PlaybackOwner(async () => playback);
  const view = render(<PlayerApp owner={owner} />);
  expect(view.getByRole("button", { name: "Play" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByText("No file selected")).toBeTruthy();
  const fileInput = view.getByLabelText("Choose local WAV");
  await userEvent.setup().upload(fileInput, new File(["fixture"], "quiet.wav", { type: "audio/wav" }));
  await waitFor(() => expect(view.getByText("Ready · Paused")).toBeTruthy());
  expect(playback.calls).toEqual(["status"]);
  await userEvent.setup().click(view.getByRole("button", { name: "Close file" }));
  expect(view.getByText("No file selected")).toBeTruthy();
  expect(document.activeElement).toBe(fileInput);
  expect(playback.closeCount).toBe(1);
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
  expect(view.getByText("Ready · Paused")).toBeTruthy();
});

test.each(["escape", "pointercancel", "blur", "lostcapture"])("%s cancels preview without seeking", async cancellation => {
  const { playback, view, seek } = await setup();
  fireEvent.pointerDown(seek, { pointerId: 1, button: 0 });
  fireEvent.change(seek, { target: { value: "3" } });
  if (cancellation === "escape") fireEvent.keyDown(seek, { key: "Escape" });
  else if (cancellation === "pointercancel") fireEvent.pointerCancel(seek, { pointerId: 1 });
  else if (cancellation === "lostcapture") fireEvent.lostPointerCapture(seek, { pointerId: 1 });
  else fireEvent.blur(seek);
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
  await waitFor(() => expect(view.getByText("Ready · Paused")).toBeTruthy());
  seek.focus();
  await user.keyboard("{Home}");
  await waitFor(() => expect(playback.seeks).toEqual([240000, 480000, 0, 0]));
});

test("accessible volume and mute are independent of seek and playback", async () => {
  const { playback, view } = await setup();
  const volume = view.getByRole("slider", { name: /Listening volume/ });
  fireEvent.change(volume, { target: { value: "37" } });
  await userEvent.setup().click(view.getByRole("button", { name: "Mute" }));
  expect(view.getByRole("button", { name: "Unmute" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.setup().click(view.getByRole("button", { name: "Unmute" }));
  expect(playback.gains).toEqual([0.15, 0.37, 0, 0.37]);
  expect(playback.seeks).toEqual([]);
  expect(playback.calls).toEqual(["status"]);
});

test("cancel while loading and malformed recovery leave replacement controls usable", async () => {
  const held = deferred<FakePlayback>();
  const late = new FakePlayback();
  let count = 0;
  const owner = new PlaybackOwner(async () => {
    count++;
    if (count === 1) return held.promise;
    if (count === 2) throw new Error("Unsupported WAV encoding");
    return new FakePlayback();
  });
  const view = render(<PlayerApp owner={owner} />);
  let loading!: Promise<void>;
  act(() => { loading = owner.load(new File([], "late.wav")); });
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  await userEvent.setup().click(view.getByRole("button", { name: "Cancel loading" }));
  await act(async () => { held.resolve(late); await loading; });
  expect(view.getByText("No file selected")).toBeTruthy();
  expect(late.closeCount).toBe(1);
  await act(() => owner.load(new File([], "bad.wav")));
  expect(view.getByRole("alert").textContent).toContain("Unsupported WAV encoding");
  expect(view.getByLabelText("Replace local WAV").hasAttribute("disabled")).toBe(false);
  await act(() => owner.load(new File([], "good.wav")));
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText("Ready · Paused")).toBeTruthy();
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
  await waitFor(() => expect(view.getByText("Ready · Paused")).toBeTruthy());
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
