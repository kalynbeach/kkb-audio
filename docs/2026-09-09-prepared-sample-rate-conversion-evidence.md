# Prepared local WAV sample-rate conversion

Date: 2026-09-09. [Issue #11](https://github.com/kalynbeach/kkb-audio/issues/11),
base `3487a4d8f9ee0e11101e9d9ba6a27e74121a87ff`.

The private local WAV path now converts **44100 ↔ 48000 Hz** in native and browser workers.
Same-rate playback remains an exact bypass, including previously accepted matching rates outside
that pair. Other mismatched rates and unsupported channel layouts are rejected. WAV encodings
remain little-endian RIFF PCM16/24 mono/stereo. The host still chooses its output rate.

Automated native and actual-Wasm checks and muted real-browser observations of the **final build**
pass as described below. No physical converted output was observed. Neither these bounded runs nor the prior
[same-rate WAV observations](2026-09-08-local-wav-playback-evidence.md) establish sustained reliability.

## Conversion contract

```text
bounded file reads → shared Rust WAV decode → PreparedRateConverter
  → four-slot host transport → PreparedPcmInput → compiled gain / observation / output
```

- Pin `rubato = 5.0.0`, default features disabled, only `fft_resampler` enabled, and
  `audioadapter-buffers = 5.1.0`. `Cargo.lock` pins the transitive graph, including realfft 3.5.0
  and rustfft 6.4.1. No decoder dependency or Wasm threads are added.
- `Fft<f32>` uses `FixedSync::Both` and the pinned constructor's BlackmanHarris2 window.
  Eight rational units give **1176 input / 1280 output frames** for 44100 → 48000, and
  **1280 input / 1176 output frames** in reverse. Both lengths are even: the output delays
  are exactly **640 / 588 frames**, respectively. These private fixture capacities are not
  product limits. Dependency construction and processing were also probed on native and
  `wasm32-unknown-unknown` before integration.
- Construct and allocate converter state in workers, never callbacks. Partial planar decode windows
  fill one fixed input chunk. Rubato processes into one preallocated output chunk, retaining its
  own prepared FFT scratch and overlap history. Transport-sized copies drain that output before
  accepting the next chunk. Browser reads remain at most 256 frames / 1536 bytes; native reads at
  most 1024 frames / 6144 bytes. Decoder result allocation remains bounded and worker-only.
- Trim the initial output delay once. Zero-extend the final input chunk and process further zeros
  as needed, emitting exactly **ceil(sourceFrames × outputRate / sourceRate)** frames. Discard
  filter tail beyond that declared media duration. Delay compensation does not remove the need
  to decode ahead before readiness; it is not a zero-latency or audible-position claim.
- Same-rate bypass constructs no FFT resampler and makes every supplied decode window immediately
  available without waiting for a conversion chunk. Its samples remain bit-exact.
- Reset clears input/output, counts, overlap history and delay trimming. The playback UI still
  reloads a new instance after EOS. Pause never resets conversion: it preserves queued and partial
  PCM and worker history. Workers may prepare ahead into their bounded slots while paused.

## Coordinates and finite completion

Private transport metadata now uses `pcm_frame_start` / `pcmFrameStart`. `PreparedPcmInput` reports
`pcm_position`: the next consumed **output-rate PCM frame**, not a decoded source frame. The compiled
plan still sees only host-neutral PCM at the active output rate.

`PcmTimeline` shares the conversion mapping in Rust:

- `pcmPosition` advances only for copied PCM, never starvation or EOS padding.
- `sourcePosition` is **floor(pcmPosition × sourceRate / outputRate)**, capped at the original
  source length. Consuming the final valid converted PCM yields exactly that source length.
  Products of `u64` frame counts and `u32` rates fit the `u128` intermediates; preparation rejects
  a converted length that cannot fit `u64`.
- After filtering, this is a floor-rounded **media cursor**, not the exact set of source samples
  contributing to an output sample or an audible presentation estimate. It equals the old next
  source-frame coordinate on the same-rate path.
- Render time remains independent: starvation advances render time but neither consumption cursor;
  acknowledged pause freezes all three. Consumed EOS is set on the final nonempty converted block,
  not when reading ends, when the converter flushes, or when the worker admits the tail.

Browser status adds `pcmPosition` and `sourceRate`; `totalFrames` remains the original source length.
Producer telemetry distinguishes `sourceFramesRead`, `preparedPcmFrames`, and `admittedPcmFrames`.
It remains an asynchronous last observation, not a synchronized render snapshot. Native interactive
status prints source and PCM positions separately. Existing epoch/ownership rejection stays at the
prepared PCM seam; seeking, resampler pre-roll for seeks, and presentation clocks are not implemented.

## Automated evidence

Host: macOS 26.6.2 (25G83), arm64. Rust/Cargo 1.98.0, Bun 1.4.0, wasm-bindgen crate/CLI 0.2.127.
Commands:

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

Rust debug/release: **63 passed, 2 ignored** (device-opening proofs). Bun: **42 web tests**, **7 WAV /
conversion tests**, **6 lab/canvas tests**, **8 lab UI tests**, plus TypeScript, the existing kernel/plan
Wasm checks, fixed memory checks and worklet source audits. No audio devices are opened by these commands.

New evidence includes:

- `src/sample_rate/tests.rs`: both directions, exact same-rate bypass, 1/2/17-frame files, exact and
  partial converter chunks, finite lengths, independently partitioned input/output, impulse alignment,
  channel isolation, reset/history isolation, invalid inputs, wide integer mapping and overflow rejection.
- Independent analytic 0.5-amplitude sine fixtures at 100/1000/10000/18000 Hz in native and Wasm:
  maximum sample error ≤0.002 and gain error ≤0.1 dB, excluding 2000 output frames at each boundary.
  Native debug's worst observed sample error was below 9e-7 and gain error below 0.000015 dB.
  A 23 kHz input downsampled to 44100 Hz must have RMS alias attenuation ≥70 dB; native debug
  observed approximately 139.6 dB. These are stated fixture thresholds, not a complete frequency
  response, perceptual quality certification, or native-to-Wasm bit-identity claim.
- Native real-file worker → fixed rings → compiled callback tests cover both rates, both encodings
  and layouts, short/exact/partial tails, pause at irregular partitions, forced starvation/recovery,
  media mapping and consumed EOS. Every consumed sample is compared against a differently partitioned
  offline conversion on the same build.
- `tools/check-sample-rate.test.ts`: actual Wasm conversion and quality checks; the **built browser
  worker** reads tracked `File.slice` windows and supplies real transferable buffers to the compiled
  Wasm adapter. Both conversion directions, encodings/layouts, short readiness, pause, starvation,
  recovery, exact converted samples, source cursor and EOS are exercised. This runs under Bun,
  not a browser AudioWorklet scheduler.
- Warmed converter processing/flush/reset has no observed Rust alloc/realloc/dealloc calls. The
  callback allocator probe includes the new timeline mapping and acknowledged pause/resume. Decoder
  and JavaScript allocation remain worker-owned; these probes do not certify hard real-time behavior.
- Unshared Wasm memory remains fixed at **256 pages / 16 MiB**. Existing 10000-render-call checks and
  worklet callback audits remain green. Conversion never runs in `process()`.

## Browser pacing and runtime boundary

The browser still has four 256-frame transfer buffers and four worklet PCM slots. Admission returns
ownership, not consumption credit. The same paced free-slot query and ordered retry rules remain;
no transport replacement or capacity increase is included. Conversion now performs several bounded
reads per FFT chunk, so previous same-rate poll/starvation measurements must not be reused as evidence
for the new path. The bounded final-build observations below measure that path without changing
transport. They neither identify a starvation root cause nor establish a sustained scheduling/I/O/load
margin. Gap-free sustained playback and production readiness remain unproven.

### Muted browser observations — final build

Agent-browser exercised Chrome **152.0.7977.83**, macOS **26.6.2 (25G83), arm64**, with `--mute-audio`.
Callbacks were **128 frames**, Wasm memory **16 MiB**, and transport capacity four slots. The final
Rust/Bun gates above passed before these runs. No page errors were observed; owned browser sessions
and loopback servers were closed afterward.

| Fixture / active context | Consumed source / PCM at EOS | Starvation callbacks | Maximum observed producer poll delay |
| --- | --- | --- | --- |
| 10 s PCM24 stereo, 44100 → default 48000 Hz, no injected stall | 441000 / 480000 | 0 | 6.5 ms |
| 10 s PCM16 stereo, 48000 → harness-requested 44100 Hz, no injected stall | 480000 / 441000 | 0 | 5.4 ms |
| Separate 10 s PCM24 stereo, 44100 → default 48000 Hz, pause and injected stall | 441000 / 480000 | 378 total | 12.3 ms |

- Acknowledged pause held source **81614**, PCM **88832**, and render **88832** unchanged across
  repeated snapshots. During the injected stall, source **117835** and PCM **128256** stayed frozen
  while render advanced **158720 → 176128** and starvation **238 → 374**. Feed recovered consumption;
  starvation was 378 at recovery and remained 378 at EOS. Play after EOS did not rewind either cursor.
- All three final snapshots reported zero failure code, invalid/stale blocks and producer rejections.
  Producer source-read/prepared/admitted totals reached the respective finite source/PCM totals.
  Producer telemetry remains asynchronous, not a synchronized consumption snapshot.
- The reverse-rate run used a test harness wrapping `AudioContext` to explicitly request **44100 Hz**.
  This is **not** a device-default observation or product rate-selection behavior. Its two analyser
  channels measured peaks **0.0099990 / 0.0099975** and RMS **0.0071160 / 0.0070459**; these signal
  observations are not subjective listening evidence.
- A harness-requested 32000 Hz context rejected the 44100 Hz file with the explicit unsupported
  conversion message. Reload then succeeded at the default 48000 Hz context: a **one-frame PCM16
  mono** source prepared after one admission, and reached consumed EOS at source **1**, PCM **2**,
  with zero starvation. This exercises ceil rounding and very short-file readiness in the real browser.
- The zero-starvation ten-second runs do not establish gap-free sustained playback, a broad browser/
  device matrix, background-load tolerance, or an explanation for prior starvation. The existing
  transport is retained without claiming that four slots provide sufficient production margin.

### Final artifact identity and review

An earlier candidate's worker bundle changed after observation. Those runs were not reused as
final-build proof: the full gates and browser observations were repeated, with these SHA-256 values
checked unchanged before and after the final browser runs. Generated artifacts are not committed.

```text
d8208d2fa17aee9ef526f3f9ca0906a0ac5b97a18777ef088405b32d02765dde  web/dist/kkb_audio_bg.wasm
7d321f3ab4014e47801760adf0958cd6d2021ff99fbc3895ed4a289646322e37  web/dist/pcm-worker.js
bc8f49500ce77df151807503dc12df7b476be4dd45ed06a89fcb544a5802371f  web/dist/worklet-processor.js
933d5470e3fce9d7f7d0e6f0e8edf948a035b3d420fc6ff547f39b5fb77f420e  web/dist/main.js
```

Independent read-only DSP/spec and browser/standards reviews found no actionable issues. Reviewers
inspected the tests; the parent separately reran the full gates and performed the browser observations.
Only evidence documentation changed afterward.

## Safe runtime reproduction

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
bun tools/local-wav-fixture.ts /tmp/kkb-convert-44100.wav 44100 24 2 10
bun tools/local-wav-fixture.ts /tmp/kkb-convert-48000.wav 48000 16 2 10
bun run build:worklet
bun run serve:proof
```

Use an isolated **muted** browser session at `/index.html`. With a 48000 Hz context, load the 44100 Hz
fixture, verify paused source/PCM positions at zero, Play, Pause/Status, resume, inject Stall worker,
then feed and observe consumed EOS. At ten seconds EOS should be source 441000 and PCM 480000; render
frames may be larger after starvation. Also run a separate no-stall sample to distinguish unforced
starvation; record browser/OS, actual context rate and callbacks, poll delay, failures, EOS, and
observation limits. For the reverse-rate runtime path, record how the actual 44100 Hz context was
selected. A harness may explicitly request 44100 Hz as in the bounded observation above, but must
label that choice rather than presenting it as device-default or product rate-selection behavior.

The [native interactive proof](2026-09-08-local-wav-playback-evidence.md#safe-reproduction) accepts
these mismatched-rate fixtures where channels match. **Obtain explicit authorization before opening
physical audio output**, lower listening volume and use only the low-amplitude fixture. No physical
converted playback, subjective listening test, broad device/browser matrix or background-load
certification is claimed by the automated evidence above.
