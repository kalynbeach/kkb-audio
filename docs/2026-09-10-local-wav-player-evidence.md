# Initial local WAV player

Issue [#15](https://github.com/kalynbeach/kkb-audio/issues/15), base
`858dfc25cbb25377ff5c45d5321868e3380bb37f`. Date: 2026-09-10.
Implementation checks, the bounded muted observations below and independent Standards/Spec reviews
pass. This is not production or broad host certification.

## Delivered surface and private ownership

`/player.html` is separate from `/lab.html`, `/index.html` and `/plan.html`. Bun's existing HTML build
bundles the player and the development server provides its hot-reload route. Existing React/shadcn
Button and Input controls, research theme, Inter and TX-02 are reused; no dependency was added.
The player has one local file, replacement, play/pause/resume, seek preview/commit, replay, elapsed
media time/duration, listening volume/mute and close/cancel. Engine details are collapsed secondary
content. Files are never uploaded.

- `web/src/prepared-playback.ts` extracts the existing `PreparedProof` and preparation internals out
  of proof-page DOM wiring. Both proof and player consume it. Worker decoding/conversion, four
  transferable PCM slots, epoch handling and readiness are unchanged. The deterministic proof's
  muted analyser and the WAV proof's original direct output remain intact.
- `web/src/playback-owner.ts` is private and task-oriented. It owns the active preparation lifecycle,
  replacement/cancellation, one user operation at a time and one coalesced status request. A command
  reserves its busy state synchronously, waits for any existing poll, and then performs its own
  snapshots. Polls during a command join it rather than overlap the low-level one-request seam.
  There is no command backlog, generic dispatch framework or public session interface. User controls
  wait for acknowledgment; Close, replacement and volume remain available.
- Status acquisition runs every 100 ms while a file is ready, including while paused. UI position
  derives only from `snapshot.sourcePosition`; duration is `totalFrames / sourceRate`. Read-ahead and
  render frames never become elapsed media time. Starvation freezes source consumption, not the
  render clock. `presentationTime` remains explicitly unavailable (`null`).
- Existing `PreparationLifecycle` owns abort and late-result disposal. Each replacement gets its own
  lifecycle so cancelled asynchronous preparation can unwind without blocking the new file. Owner
  generations guard state publication across load, command, poll, close and replacement completion.
  Close stops polling, aborts preparation, terminates the worker and closes the context. Failures show
  an error and dispose playback; selecting another file recovers.
- `web/src/player-app.tsx` owns presentation and gestures only. It subscribes through React's external
  store hook; no React component coordinates worker messages, converters, transfer ownership or epochs.

## Interaction contracts

Supported files remain **nonempty little-endian RIFF PCM16/24 mono/stereo**, same-rate playback and
prepared **44100 ↔ 48000 Hz** conversion. Unsupported encodings/layouts/rates and malformed files are
rejected rather than decoded through a second browser path.

There is one seconds-to-frame rule: clamp `seconds * sourceRate` to `[0, totalFrames]`, then round to
the nearest integer source frame, with half frames rounded upward. Nonfinite input is rejected.
Zero and exact duration map to exact endpoints. The slider uses seconds; it does not introduce a
separate normalized-coordinate conversion rule. The underlying source-frame/output-grid seek
contract and realized coordinates remain those of the
[seeking foundation](2026-09-10-wav-seeking-lifecycle-evidence.md).

During a pointer drag, the slider and preview text show a proposed target while elapsed time continues
to show the acknowledged consumed cursor. No seek is sent until release, which commits exactly once.
Escape, pointer cancellation, lost capture and blur abandon the draft. Arrow keys commit five-second
steps, Page Up/Down thirty seconds, Home/End exact start/end; assistive input changes can also commit.
A busy seek retains native keyboard focus using `aria-disabled` with guarded handlers, rather than
removing the focused control. Seeking remains visible through current-epoch readiness and its fresh
snapshot; the UI reconciles to the realized consumed cursor, not its original preview.

Normal seeks preserve playing/paused state. **Terminal exception:** consumed EOS, including a seek
to the exact endpoint, acknowledges suspension of the same context and displays Ended. Seeking away
from Ended stays paused; explicit Play starts consumption. Replay explicitly seeks zero, waits for
readiness and plays. This endpoint policy was confirmed during implementation. Loading, replacing,
volume changes and seeking from a paused/ended state never start audio. Close/Cancel returns focus
to file choice. State is announced politely; elapsed/duration outputs are not live announcements.

Listening volume uses one **post-worklet GainNode**, not a recompiled plan or render callback feature.
It starts at **0.15**, after the existing compiled **0.5** gain: combined initial linear gain **0.075**.
The slider ranges from zero to unity; mute writes zero while retaining the chosen level. Editing the
level while muted retains mute. Unmute restores that level. Volume and mute persist through replacement
and close for this page session, not across page reloads. Neither changes context identity, transport,
converter state or cursor. Gain changes are immediate; no click-free automation claim is made.

## Automated checks

Bun **1.4.0** (repository executable), Rust/Cargo **1.98.0**, wasm-bindgen **0.2.127**; dependency pins
unchanged. All final commands below passed:

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets --all-features -- -D warnings
bun run check
git diff --check
```

- Rust debug/release: each **66 passed, 2 ignored**, zero failures. Ignored device-opening tests were
  not selected. No Rust source or engine contract changed.
- Bun: **62 web tests**, **12 WAV/conversion/scheduling/seek tests**, **6 lab/canvas tests**, **8 lab UI
  tests**, **11 player UI tests**, zero failures; TypeScript, actual-Wasm kernel/plan, memory checks and
  worklet audits also pass. UI tests run separately to isolate their happy-dom globals from the proof
  fixtures. Initial test-authoring TypeScript errors for an unsupported Testing Library `exact` option
  were corrected before the passing full gates; no failing test was removed.
- **16 owner tests** cover rounding/endpoints, explicit load/play, periodic consumed position,
  starvation vs render time, acknowledged pause, coalesced polling vs play/pause/seek, readiness,
  preservation of pause/play, EOS suspension, replay, gain/mute, malformed recovery, runtime failure,
  aborted/late preparation and late status/seek completion after close/replacement.
- Player UI fixtures cover labelled empty/load/close and focus, preview without seeks, one release,
  cancellation paths, keyboard seeking/endpoint/replay, retained focus, EOS seek-back remaining paused,
  malformed recovery, preparation cancellation, volume/mute and playing previews during position updates.
  An added extracted-playback fixture verifies the actual GainNode routing seam updates the same node
  without disconnect/reconnect, context reset or cursor movement on level changes.
- Existing engine fixtures retain converter/reference comparisons, ownership/epoch rejection,
  starvation/recovery, bounded buffers and fixed **16 MiB** worklet memory. They are reused, not
  reproduced in React tests. Wasm/worker/worklet hashes match the prior foundation build.

## Actual built-player browser observations

macOS **26.6.2 (25G83), arm64**; agent-browser **0.37.1**, managed headless Chrome with user-agent
`HeadlessChrome/152.0.0.0` (the full binary patch version was not queried). Owned loopback proof server
on **127.0.0.1:4327**, isolated session **kkb-player-15-final**, launched with **`--mute-audio`**, an empty
explicit CLI config, no profile or state reuse. No physical output, native device test, system volume,
device configuration, existing browser profile or deployment was touched.

The two generated fixtures are quiet 30-second stereo files: 44100 Hz PCM24 and 48000 Hz PCM16, source
peak 0.02. These are short interactive workflows, **not uninterrupted 30-second or sustained-load
runs**. No extra CPU load, visibility/background manipulation or device-rate changes were applied.
Test-only host-constructor/message instrumentation recorded context identity/rate, gains, snapshots
and outgoing seek messages without modifying decoder/converter/render code. The reverse-conversion
row explicitly requested a 44100 Hz AudioContext; other contexts used the observed **48000 Hz default**.

| Source → context | Actual player workflow observed |
| --- | --- |
| 44100 → default 48000 | Load suspended at zero; paused pointer preview/release/cancel; Play, automatic updates, Pause freeze, resume; volume/mute; injected stall/recovery; playing keyboard seek; endpoint; seek-back paused; consume final five-second tail to EOS; Replay; replacement while playing |
| 48000 → default 48000 | Replacement ready/paused at zero with old context closed; Play, endpoint, Replay and Close |
| 48000 → requested 44100 | Recovery after malformed/unsupported files; Play, keyboard seek, Pause; Close while injected-stall seek preparation remained pending |

Specific final-build observations:

- Drag to 15 seconds: **zero outgoing seeks** during preview, elapsed **0:00**; release sent exactly
  one target **661500**, epoch 2. Ready snapshot: source **661500**, PCM **720000**, render **0**, paused.
  Another drag followed by Escape/release left seek count **1** and the acknowledged target unchanged.
- After Home and Play, automatic updates reached source **45393** / PCM **49408**. Acknowledged pause
  froze source **49862**, PCM/render **54272** across a **1.2-second** wall-clock observation.
- Volume changed from 15% to 16%; mute/unmute observed gain **0 / 0.1599999964237213** (AudioParam float
  representation). Context count stayed **1** and paused source cursor stayed **49862**.
- Test-only worker Stall then Feed: source **53625**, PCM **58368** stayed fixed across **0.5 seconds**
  while render advanced **62464 → 86528** and starvation **32 → 220**. Recovery and the subsequent
  final tail completed; total injected starvation stopped at **270**. Zero failure/invalid-block codes.
  This deliberately starved workflow is not a claim of universal gap-free scheduling.
- Playing ArrowRight committed target **276948**. Focus remained on `seek-position`. End then committed
  **1323000**, epoch 5; ready/ended source **1323000**, PCM **1440000**, context suspended. ArrowLeft
  committed **1102500** and stayed paused at that source cursor across **0.5 seconds**, without Play.
  Explicit Play consumed the tail to EOS and again suspended. Replay sent target **0**, epoch 7,
  resumed the **same context**, and new consumption reached source **235** / PCM **256**.
- Replacement while playing closed the old context and installed a suspended, zero-cursor file. A
  malformed text file and an unsupported format-code-3 WAV displayed errors; valid replacement recovered.
- For preparation cancellation, the harness held a completed Wasm fetch response before returning it.
  Cancel showed Empty and closed its context; releasing the obsolete response did not revive it. A
  second held load replaced by another file stayed on that replacement after the late release.
- Close and replacement during stalled seek preparation cancelled the obsolete playback. Replacement
  stayed at epoch **1**, source/PCM/render **0**; late old work did not restore its UI. Final cleanup
  confirmed **all 9 owned contexts closed**, **all 7 created workers terminated**, and **zero page errors
  or unhandled rejections**.
- Desktop **1280 × 1000** and narrow **360 × 800** screenshots were inspected. Narrow document width
  equalled viewport width (**360 px**), with readable wrapping and usable controls. Keyboard focus was
  retained after seeking and visibly outlined (**2px**, `:focus-visible=true`). Close restored file-input
  focus. axe-core **4.12.1** reported **0 violations / 0 incomplete / 36 passes** at both sizes.
  This is targeted keyboard/label/layout evidence, not screen-reader or accessibility certification.
- `/player.html`, `/lab.html`, `/index.html` and `/plan.html` each returned HTTP 200 on the owned server.
  Both candidate and final browser sessions and the owned loopback process were closed; port 4327
  had no remaining listener. No owned background CPU process was created.

Earlier candidate observations exposed keyboard focus loss from native disabling during a seek and
an inappropriate `aria-label` on a generic duration span. The final player uses guarded `aria-disabled`
for busy seeks and non-live output elements; final focus and accessibility checks above confirm those
repairs. Candidate observations are not substituted for the final endpoint/replay evidence.

Final runtime artifact hashes (unchanged after the final full check):

```text
3805cc0f103f897a8517efc9abe5928a5a3a53f47feda6c55fd4f4e398f6d60a  kkb_audio_bg.wasm
748ee77d0cc44500770c9c3beea79a328258871f898abd850aa69c4b3c4366bf  pcm-worker.js
a8413ee5bc0aec09da30e8f5fda77fa958b4f7fb92c1e837d5b759bb3730758a  worklet-processor.js
04eed5cc6a3ff06201a86092ff1df2fc43320796bf6d42253161ce067669c105  player.html
23a2997ed9fc62b102ee6c7b80a1d52d23fee2e02e3787b2f2e82692ce18beb3  chunk-m8r6gca8.js
7453e180f2b61c57357b3fd6bb43643cfd2a5ff38ec88f0cdb4867726f5148da  chunk-9vbfscsy.css
```

## Independent review and acceptance

Fresh-context read-only Standards and Spec reviewers inspected the delivered source, focused tests,
documentation and recorded logs. Both returned **zero findings**. Neither reviewer had shell access;
they did not independently run Git commands, tests or browser observations. The parent inspected the
complete pending diff and new-file inventory, confirmed the unchanged engine/runtime artifact hashes,
and reran TypeScript, 32 playback-owner/proof lifecycle tests and all 11 player UI tests. Staging
exposed an extra trailing blank line in the extracted module; after removing it, the parent reran the
full `bun run check` and staged whitespace check successfully. Built player hashes remained unchanged.
No behavioral changes were needed after review.

## Limits and reproduction

This does not certify audible timing, subjective quality, click-free seeks/gain changes, arbitrary
I/O stalls, sustained performance, all browsers/devices, background/sleep/interruption behavior or
production readiness. Presentation estimates remain unavailable. WAV format/rate limitations,
converter history and transport capacity are unchanged. No waveform, codec expansion, queue, loop,
HTTP media, catalog, public package/session API or eventual application migration was added.

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
bun tools/local-wav-fixture.ts /tmp/kkb-player-44100.wav 44100 24 2 30
bun tools/local-wav-fixture.ts /tmp/kkb-player-48000.wav 48000 16 2 30
bun run build:worklet
PORT=4327 bun run serve:proof
```

Use a unique free loopback port and an isolated **muted** browser for routine reproduction. Open
`/player.html`, upload a fixture, then exercise the controls. A real user Play gesture is required;
fetch/message holds used above are fault injection, not normal player controls. Physical native
output or audible listening requires separate permission. See also the
[validation sequence](2026-08-29-initial-render-engine-validation-plan.md#playback-validation-after-the-four-milestones)
and [canonical playback responsibility](2026-08-28-kkb-audio-system-architecture.md#playback-session).
