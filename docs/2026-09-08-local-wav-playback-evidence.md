# Same-rate local WAV playback evidence

Date: 2026-09-08. [Issue #9](https://github.com/kalynbeach/kkb-audio/issues/9);
base `91574506391ad88a4ed41c631ec04b55b1f3f271`.

The first playback increment is implemented and verified within the automated, browser and physical
macOS observations below. **Browser starvation remains observable: this is not gap-free or production
playback certification.** The [canonical architecture](2026-08-28-kkb-audio-system-architecture.md)
and [validation plan](2026-08-29-initial-render-engine-validation-plan.md#playback-validation-after-the-four-milestones)
remain authoritative. No public session API or broad host-support claim is introduced.

## Implemented boundary

```text
local RIFF PCM16/24 -> bounded worker payload reads / shared Rust decode
  -> existing four-slot PCM transport -> compiled gain 0.5 / observation / output
```

`src/local_wav.rs` is the private shared incremental parser/decoder, exported to the browser worker
through Wasm. Header requests are at most 16 bytes. The declared RIFF end must equal actual file
length. The parser scans all chunk headers before preparation, skips unknown chunks and odd-byte
padding, accepts data before fmt, and rejects duplicate fmt/data, truncation, empty or unaligned
data, inconsistent byte rate/block alignment, and absent fmt/data. Only little-endian RIFF/WAVE PCM
tag 1, signed 16- or 24-bit samples, and mono/stereo are accepted. RIFX, RF64, float, extensible and
compressed encodings are rejected. Normalization is integer / 32768 or / 8388608.

Browser reads use worker-side `File.slice(...).arrayBuffer()`, never whole-file decode or
`decodeAudioData`. Native headers are inspected on the control thread; payload reading and decoding
run in the existing worker. Payload windows are at most 6144 bytes natively (1024 stereo PCM24 frames)
and 1536 bytes in the browser (256 frames). Decode scratch is bounded and released outside callbacks.
No decoder dependency was added.

Sources must match the actual context/default-device rate. Browser node layout comes from the source;
Web Audio destination mapping remains host-owned. Native requires an exact source/device channel
match; mono-to-stereo conversion is not implemented. Mismatches fail before playback, rather than
requesting a different context rate to disguise them.

One private prepared instance is retained per stream. Resampling, seeking, loops, compressed/network
media, public playback/graph APIs, live replacement and UI redesign remain excluded. The oscillator
proof and learning lab remain separate.

## Consumption, control and finite files

`PreparedPcmInput` updates source position where samples are actually copied. For the ordered finite
source this is the next source frame to consume: initially zero, frozen during starvation, and exactly
`totalFrames` at consumed EOS. The existing seam still permits discontinuous coordinates; the finite
producer owns contiguous ordering. The final nonempty block carries EOS, including exact-block tails.
Output padding does not count as source consumption. Read EOF, admitted EOF and consumed EOS differ.

Short files become ready after their final block is admitted; longer files after four admissions.
Browser Pause awaits `AudioContext.suspend()` and a snapshot. Native pause uses a numbered command
acknowledged at a callback boundary after publishing observations. Paused native callbacks emit
silence without invoking the renderer; they still record actual host callback sizes. Both hosts retain
partial/queued PCM, freeze media and render time at acknowledged pause, and resume the same instance.
During starvation only media position freezes. Render time can continue through EOS silence.
Play after EOS does not rewind; Load WAV/new native invocation explicitly reloads.

These are not sample-exact user-click controls or audible-position estimates. Browser controls disable
during pending actions, including Status, to avoid silently discarding an enabled Pause request.
Producer telemetry is a separate asynchronous `producerLastObserved` value, not an atomic snapshot
with render/media coordinates; request status again for a later producer observation.

## Browser pacing and ownership

The old one-block-per-ceil-duration producer could supply only 42667 frames/s at 48 kHz before
scheduling overhead (256 frames per 6 ms). `LocalPcmProducer` retains four transfer buffers and four
Wasm slots. It queries free-slot state over the existing direct MessageChannel outside `process()`
using one bounded timer (2 ms at 44.1/48 kHz). A reply permits bounded serial refill of available slots.
There is one outstanding read/admission, one retained retry, and one supply query/timer. Admission
returns transfer ownership, not consumption credit. Later blocks cannot overtake a retry. Full or
paused slots cause paced polling rather than rejection spinning. Stalling stops refill, with at most
one already-started read/admission still in flight.

The initial browser run exposed `TypeError: Illegal invocation`: storing native `setTimeout` as an
instance method gave it the wrong receiver. The default now uses an unqualified-call wrapper. A
receiver-contract regression reproduces the old invocation failure; the real browser rerun below
exercises the corrected production worker. Virtual scheduling tests alone had missed this constraint.

## Automated verification

Toolchain: Rust/cargo 1.98.0, wasm-bindgen crate/CLI 0.2.127, Bun 1.4.0. Observation host: macOS 26.6.2,
build 25G83, arm64. No dependency versions or lockfile changed. Use the pinned local Bun binary when
ambient Bun differs:

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

All passed on the corrected candidate. Rust debug/release each: **56 passed, 2 ignored** (the physical
device proofs). Bun: **42 web tests**, **4 actual-Wasm WAV tests**, **6 lab/canvas tests**, and **8 lab UI
tests**, all passing, plus TypeScript, the existing actual-Wasm programs, memory checks and source
audits. Focused coverage includes:

- PCM16/24 mono/stereo at 44.1/48 kHz, integer extrema, malformed/truncated/duplicate/odd chunks.
- Native real-file worker/rings/compiled callback: 1/17/1024/1025/4096/5003-frame files, exact scaled
  channels, irregular partitions, pause/resume without loss or duplication, EOS, starvation/recovery.
- Actual decoder/producer/Wasm: 1/17/256/257/1024/1025-frame tails, real buffer transfers, sample
  identity, bounded reads, rate rejection and short-file readiness.
- Ordered rejection retry, four fixed buffers, bounded polling, malformed ownership, receiver-safe
  timer invocation, deferred Status/Pause controls and reload/close cleanup.
- A simulated ten-second 48 kHz run checks all 480000 source frames: 3793 callbacks, zero unforced
  starvation, 43 injected starvation callbacks, 5080 polls, zero rejection, at most one pending timer.
  This is virtual pacing, not a browser timing result.
- Callback allocator probes include pause/resume. Existing 10000-call Wasm checks preserve unshared
  256-page memory (16777216 bytes). Textual callback audits report no forbidden patterns. These are
  bounded empirical checks, not JavaScript allocation profiling or deadline certification.

Independent read-only Rust/native and browser reviews found two corrections: paused callback-size
telemetry and enabled-but-dropped Pause requests. Both were fixed, tested and accepted on focused
follow-up; no remaining actionable findings were reported.

## Browser observations

Agent-browser used an isolated headless Chrome **152.0.7977.76** session on the macOS host above,
with `--mute-audio`. Full version came from User-Agent Client Hints. AudioContext chose **48000 Hz**;
callbacks reported **128 frames** and `renderQuantumSize` was unavailable. These are observations of
this configuration, not a browser matrix or branded-browser support commitment.

A thirty-second PCM24 stereo file (1440000 frames) prepared at source/render frame zero. Pause froze
source at **638720** and render at **639488** across repeated snapshots. During deliberately stalled
supply, source stayed **658688** while render advanced **673024 → 687616** and starvation callbacks
**112 → 226**. Feed resumed consumption; final source position was exactly **1440000**, with EOS true.
Play after EOS did not rewind. Final producer admission was 1440000, rejection count zero, and maximum
observed poll delay 9.5 ms. The **272 total starvation callbacks include injected and unforced gaps**;
six had already occurred before the injected stall. This run does not isolate every later gap's cause.

A separate ten-second PCM16 stereo run, with no injected stall, reached **480000** source frames and
EOS, with **2 starvation callbacks**, zero rejected/invalid/stale blocks, zero failure code and fixed
16 MiB Wasm memory. Producer reported 3315 polls and maximum poll delay approximately 7.4 ms. Analyser
branches on both channels measured peak **0.0099945068359375** and RMS approximately **0.0071030 /
0.0070858**, consistent with the low-amplitude fixture and compiled gain. Browser output was muted;
no listening assessment is inferred.

Additional actual browser checks:

- PCM16 mono 257-frame tail: two admissions before ready, EOS at 257, zero starvation.
- PCM24 stereo exact 256-frame block: one admission before ready, EOS at 256, zero starvation.
- 44100 Hz source rejected against 48000 Hz context; empty WAV rejected; subsequent valid reload works.
- Existing deterministic muted proof still observed signal with no failure or starvation.
- Desktop 1280-pixel and mobile 390×844 layouts were visually inspected; mobile document client and
  scroll widths both measured 390. No page JavaScript errors were reported on the corrected build.

Four 256-frame slots provide little scheduling margin. These observations justify retaining the
bounded transport for this validation slice, not calling it production-ready. Real I/O, scheduling,
background throttling and application load remain relevant; gap-free sustained playback is unproven.

## Physical macOS observation

An announced, unmuted CPAL run used **MacBook Pro Speakers**, **48000 Hz**, **stereo F32**, and observed
**512-frame callbacks**, with the same thirty-second PCM24 fixture. Source peak was 0.02 and compiled
peak nominally 0.01. This exercised physical output; no subjective listening-quality assessment or
measurement of sound reaching the listener is claimed.

The completed scripted run took 32.99 seconds and passed its ignored test. Pause held source/render
at **87552** across status requests. After resume and worker stall, source stayed **92160** while
render advanced **107520 → 122368**, with starvation callbacks **30 → 59**. Feed recovered, and final
source position was exactly **1440000/1440000**, EOS true; subsequent Play did not rewind. Final
snapshot: **3082 callbacks**, **59 starvation callbacks** (all within the injected stall; no additional
count after feed), **0 deadline overruns**, **0 host/render/worker failures**, and no invalid/stale blocks
or retirement backpressure. This is a short observation, not sustained deadline or device coverage.

An earlier interactive run also verified initial paused callback telemetry and paused position, but its
shell timeout interrupted the run before EOS; it is not counted as a completed playback proof. All
owned native processes, browser contexts/workers, the browser session and the loopback server were
stopped after verification. Native physical PCM16, other output devices, other browser engines and
physical mobile hardware were not tested; automated format/layout fixtures cover the broader subset.

## Safe reproduction

```sh
bun tools/local-wav-fixture.ts /tmp/kkb-wav-24-stereo-48000.wav 48000 24 2 10
# PATH [44100|48000] [16|24] [1|2] [seconds <= 60]
bun run build:worklet
bun run serve:proof
```

The generator uses distinct 220/330 Hz tones at source peak 0.02. Lower listening volume first; never
play the extrema fixtures used by unit tests. Open `/index.html`, choose WAV, Load (paused), Play,
Pause, Status, and Stall worker as needed. Status is sampled on request, so request it again after
playback progresses. Reload after EOS. Close releases the context/worker; stop the server afterward.

Native (requires explicit physical-output authorization):

```sh
KKB_WAV=/tmp/kkb-wav-24-stereo-48000.wav cargo test --release \
  cpal_host::tests::local_wav_playback -- --exact --ignored --nocapture --test-threads=1
```

Commands: `play`, `pause`, `status`, `stall`, `feed`, `close`; stdin EOF closes too. The stream opens
with adapter consumption paused. Only Play enables sound. Regenerate a matching-rate/channel fixture
rather than converting it. Both device-opening tests stay ignored in ordinary suites.

## Verified browser build identity

Generated artifacts, not committed source files:

| Artifact | SHA-256 |
|---|---|
| `web/dist/kkb_audio_bg.wasm` | `3a5c42eefef4248d255a43a5713f1716487013016e33b05f58978640ea3c9663` |
| `web/dist/worklet-processor.js` | `e6482efda9d9e0bd5b667f6711e8d65b639e5f9a089b207aad5a70276f1e4ba0` |
| `web/dist/pcm-worker.js` | `6a3dc7d17f4148ca34e966ba8b34dbc7189ae22ffd216625f6422c98f0145f1f` |
| `web/dist/main.js` | `82c1ed556f65b395e1941b3f1a804846d7cdcce2a27ecae29291991079e8214f` |
