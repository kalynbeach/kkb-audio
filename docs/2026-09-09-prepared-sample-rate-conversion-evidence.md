# Prepared local WAV sample-rate conversion

Date: 2026-09-09. [Issue #11](https://github.com/kalynbeach/kkb-audio/issues/11),
base `3487a4d8f9ee0e11101e9d9ba6a27e74121a87ff`.

Follow-on: [issue #13 seeking/lifecycle evidence](2026-09-10-wav-seeking-lifecycle-evidence.md)
adds bounded seek pre-roll, epochs and post-EOS repositioning. Statements below about missing seeking
and reload-only EOS describe the original #11 build, not the current path.

The private local WAV path now converts **44100 ↔ 48000 Hz** in native and browser workers.
Same-rate playback remains an exact bypass, including previously accepted matching rates outside
that pair. Other mismatched rates and unsupported channel layouts are rejected. WAV encodings
remain little-endian RIFF PCM16/24 mono/stereo. The host still chooses its output rate.

Automated native and actual-Wasm checks pass. Physical output completed ten minutes in each
conversion direction with clean engine counters. Browser stress testing exposed starvation and led
to a bounded refill repair; passing final-build observations and failed earlier trials are recorded
below. These results support the tested configurations, not universal gap-free playback or production
readiness. Subjective listening quality remains unassessed.

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
  accepting the next chunk. Browser and native reads are at most 1024 frames / 6144 bytes,
  independently enforced by the shared decoder. Decoder result allocation remains bounded and worker-only.
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

Rust debug/release: **63 passed, 2 ignored** (device-opening proofs). Bun: **42 web tests**, **11 WAV /
conversion and scheduling tests**, **6 lab/canvas tests**, **8 lab UI tests**, plus TypeScript, the existing kernel/plan
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

The initial build used four 256-frame transfer buffers and four worklet PCM slots. Admission
returns ownership, not consumption credit. The repaired build retains that ownership model but uses
**four × 1024 PCM frames** (85.3 ms total at 48 kHz), with an independent **1024-source-frame /
6144-byte** read cap. Render quantum, credit queries and ordered admission are unchanged.

`tools/check-local-pcm-scheduling.test.ts` exercises independent virtual render, timer, read and
transferred-message delivery with the actual producer and Wasm kernel. A single 21 ms poll with
1 ms message legs reproduces starvation at the old capacity; the selected capacity passes both
conversion directions and same-rate control, even with conservative 256-frame reads. A separate
source-worker test enforces the 6144-byte read bound and at most eight payload reads for initial
prefill; it failed with the old serial 256-frame window (20 reads), then passed with 1024-frame reads.
These establish queue-headroom and read-amplification mechanisms, not exact browser-event causality.

### Initial short browser observations — four × 256 frames

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

### Initial artifact identity and review

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
These observations apply to the initial published build, before the refill repair.

## Extended validation and refill repair

The extended fixtures contain 600 seconds of quiet stereo PCM: 44100 Hz PCM16 and 48000 Hz PCM24,
source peak 0.02 through compiled gain 0.5. Native and browser suites initially ran concurrently.
Durations below are source-media durations; final snapshots can include additional post-EOS silence.

### Physical macOS output

Explicitly authorized runs selected **MacBook Pro Speakers**, F32 stereo, with 512-frame callbacks.
The ignored native proof's `KKB_OUTPUT_RATE` selects a supported 44100/48000 Hz configuration matching
the default channels and sample format; ordinary playback selection is unchanged. Each run included
two competing `nice -n 10` CPU workers from approximately 120–420 seconds.

| Source → output | Duration | Consumed source / PCM at EOS | Callbacks | Starvation / processing deadline overruns |
| --- | --- | --- | --- | --- |
| 44100 → 48000 | 600 s | 26460000 / 28800000 | 56340 | 0 / 0 |
| 48000 → 44100 | 600 s | 28800000 / 26460000 | 51774 | 0 / 0 |

Both ended with zero failure code, invalid/stale blocks, retirement backpressure, host failures and
worker failures. These are engine/callback observations, not measurements of every driver deadline.
System volume was 6%, unmuted, when inspected after the native runs; the agent did not change volume.
The original 48000 Hz device rate was restored and verified after all browser tests using a paused
proof without Play. The owner reported not hearing or not listening to the test;
**no subjective artifact-free sound claim is made**. Subsequent changes affect browser
buffering/reads only, not the native conversion or render path.

### Failed browser trials retained

Chrome 152.0.7977.83 on the same macOS host, `--mute-audio`, 128-frame callbacks, fixed 16 MiB Wasm.
Ten-minute trials requested 12 ms of main-thread busy work every 40 ms during approximately 120–420 s,
and actually changed visibility to hidden during 180–360 s. Background timer throttling can reduce
the achieved main-thread load. Later trials also ran two CPU workers during 120–420 s.

- Initial four × 256 buffers: **32** starvation callbacks for 44100 → 48000 and **6** in reverse;
  both reached exact EOS without failures, invalid/stale blocks or rejections. Maximum observed
  producer poll delays were 21 / 13.6 ms. Native CPU activity overlapped these runs; they were not
  globally unloaded. The reverse harness's elapsed counter was reactivated once; source/PCM totals
  and absolute visibility events, not that reset elapsed counter, support its duration record.
- Four × 1024 buffers with reads still capped at 256: both conversion directions passed 600 s with
  zero starvation (maximum polls 24.1 / 39.4 ms), but same-rate 48000 Hz recorded **3** callbacks.
  A separate audio-context control test overlapped that trial. An isolated repeat also recorded
  **2** callbacks and was stopped after roughly four minutes, disproving overlap as a sufficient
  explanation. The capacity-only candidate was not accepted as the final fix.
- Temporary instrumented 90-second same-rate comparisons held capacity at four × 1024. The
  256-frame window recorded **3** starvation callbacks, 17008 reads, an 8 ms maximum individual read
  and 13.7 ms maximum accumulated block-read time. A 1024-frame window recorded **0**, 4264 reads,
  and 4.2 ms maxima. Poll peaks differed (29.8 / 18.2 ms), so this is supporting evidence for reducing
  serial read amplification, not an isolated proof of exact causation. Instrumentation was not shipped.

### Final build

All automated gates passed and both the capacity change and subsequent read-window change received
independent read-only review. The final build uses four × 1024 slots and independently bounded
1024-frame reads. No second audio context was added to these runs.

| Source → context | Duration | Consumed source / PCM at EOS | Starvation | Maximum observed poll delay |
| --- | --- | --- | --- | --- |
| 48000 → 48000 control | 600 s | 28800000 / 28800000 | 0 | 51.3 ms |
| 44100 → 48000 | 600 s | 26460000 / 28800000 | 0 | 20.7 ms |
| 48000 → 44100 | 60 s | 2880000 / 2646000 | 0 | 15.6 ms |

All three reached consumed EOS with zero failure code, invalid/stale blocks and producer rejections;
source-read/prepared/admitted totals matched the respective finite source/PCM totals. Wasm memory
remained 16 MiB. Artifact hashes were checked unchanged after the observations; owned browsers,
servers and load workers were closed.

The ten-minute cases used the load/visibility schedule above. The shorter reverse confirmation uses
CPU/main-thread load during approximately 0–45 s and hidden visibility during 15–30 s. Its duration
was deliberately shortened to finish review preparation: **there is no ten-minute reverse-direction
observation on the final read-window build**. The earlier ten-minute reverse pass used smaller reads.
All context rates are harness-requested, not claims about device-default selection or a product rate UI.

Final artifact SHA-256 values (generated artifacts are not committed):

```text
d8208d2fa17aee9ef526f3f9ca0906a0ac5b97a18777ef088405b32d02765dde  web/dist/kkb_audio_bg.wasm
9b5cbcff4ee63073858dab733b97bb6673f620740198eb611de8ad05c6222b85  web/dist/pcm-worker.js
bc8f49500ce77df151807503dc12df7b476be4dd45ed06a89fcb544a5802371f  web/dist/worklet-processor.js
bddea374ba7e1f90c277a5d3ed692520ddad6aadff39ba87fe418279208e9c00  web/dist/main.js
```

The recorded failures above occurred on superseded configurations. The passing observations remain
bounded by this browser/device, finite durations and synthetic load; they do not certify arbitrary
I/O stalls, simultaneous audio contexts, sleep/resume, a browser matrix, or production readiness.

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
these mismatched-rate fixtures where channels match. The fixture CLI accepts up to 600 seconds.
For an explicitly selected proof rate, set `KKB_OUTPUT_RATE=44100` or `48000` alongside `KKB_WAV` when
running the ignored `local_wav_playback` test. **Obtain authorization before opening physical output**
and use only the quiet fixture at a safe listening volume. On CoreAudio, selecting a stream rate can
change the device's nominal rate; record the original rate and restore it after testing. Physical
observations require this opt-in proof and are not implied by the default automated commands.
