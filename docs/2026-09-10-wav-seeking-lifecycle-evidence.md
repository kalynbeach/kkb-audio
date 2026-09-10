# Local WAV seeking and bounded playback lifecycle

Issue [#13](https://github.com/kalynbeach/kkb-audio/issues/13), base `b2b35c91610063241aeed69a684ade6c85226d97`.
Date: 2026-09-10. Implementation and device-free/muted runtime checks pass; independent review
identified three concrete repairs, now implemented and accepted on follow-up. The bounded foundation
gate passes for the tested local-WAV contract; the initial player is next.

## Preparation decisions

- Accept integer source-media targets in `[0, sourceFrames]`, including zero and the exact endpoint;
  reject invalid/out-of-range targets without changing playback. Seeking after consumed EOS is allowed.
  Proof controls use source frames directly (no floating-point seconds conversion).
- Coordinates remain absolute within the file. Select output-grid frame
  `ceil(target * outputRate / sourceRate)`, capped at the finite PCM endpoint. Report requested frame,
  realized PCM frame, and the floor-mapped realized source cursor (the endpoint maps to sourceFrames).
  Same-rate seeks report `Exact`; conversion reports `AnchorAndDiscard` when the realized source
  cursor equals the request, otherwise `Adjusted(actual_media_frame)`. Also expose the rational grid
  coordinate via PCM frame and both rates: an integer media cursor is not sub-frame exactness.
- Reconstruct the pinned FFT converter's finite overlap history from a preceding globally aligned
  input chunk, not by resetting at the requested byte offset. Choose the chunk preceding the raw
  output chunk containing `targetPcm + outputDelay`; clamp to zero. Reset overlap, read from that
  aligned anchor, discard through the globally delay-compensated target, and retain exactly
  `totalPcmFrames - targetPcm` output frames. Pre-roll is at most two converter chunks; payload reads
  retain their independent 1024-frame/6144-byte cap. Compare against uninterrupted same-build output,
  including boundaries; do not infer converter exactness from decoder positioning.
- Activate an epoch at an acknowledged render/control boundary before preparing its replacement PCM.
  Reject and reclaim old partial/queued blocks even while paused. During preparation, a playing
  instance renders silence and advances its existing clock; acknowledged pause keeps render time
  frozen. Do not recreate the render instance or output context/stream.
- Readiness is four new-epoch admissions or the entire shorter remaining tail; the exact endpoint
  needs no PCM and is immediately ended. Seek completion acknowledges active epoch plus this
  readiness, not sound reaching the listener. Play/pause state is preserved. Repeated seeks use
  bounded latest-request state; obsolete preparation/completion cannot restore an older epoch.
- Keep worker I/O/conversion outside callbacks. Late reads/admissions are either cancelled before
  publication or rejected at the epoch seam; ownership still returns. Close cancels pending work and
  cannot be revived by late replies. No unbounded command queue or transport replacement.
- The current compiled gain is stateless. Clear/disqualify old-epoch source observations at a seek;
  preserve the render clock and render-time processing state. Playback snapshots carry an epoch and
  distinguish absolute source cursor, absolute consumed-output PCM cursor, and render frames.
  Presentation estimate is explicitly unavailable (`null`): neither host proof has a validated
  render-to-audible clock/latency model. Consumption is never labelled audible position.

## Validation plan

Focused uninterrupted-reference tests in both directions and same-rate bypass; native real-file
worker/rings/compiled callbacks and actual browser-worker/Wasm fixtures; paused partial blocks,
repeated seeks, late work, starvation/recovery, short/endpoint/EOS, close/reload and malformed files.
Retain allocator probes, fixed 16 MiB worklet memory and source audits. Run Rust debug/release/Clippy,
Bun 1.4.0 checks and targeted isolated muted browser observations with recorded load. No physical
native output, device configuration changes, production, or daily-driver channels are authorized.

The complete lifecycle gate is the foundation boundary for the thin local-WAV player. Remaining
codecs, loops, public session APIs, player UI and broad hardening remain outside this issue.
Governing sequence: [validation plan](2026-08-29-initial-render-engine-validation-plan.md).

## Implemented lifecycle and narrow integration needs

- Native control publishes one packed latest `(epoch, sourceFrame)` request (the RIFF subset bounds
  targets to `u32`). The callback activates it, reclaims stale blocks even when paused, and publishes
  the active request to the worker. The worker checks cancellation between bounded decode windows
  and before admission; any racing old admission remains rejectable at the seam. Readiness counts
  admissions for the new epoch, not merely occupied slots. Snapshot `ready=true` acknowledges both
  callback activation and matching worker readiness. Control-side snapshot retries read a sequence-
  guarded atomic tuple; the callback never retries, locks, allocates, or waits.
- Browser control retains one posted seek command and one replaceable latest command. Worker
  receipt returns command credit; the worker also retains only one latest target. The producer
  drains its one read/admission and outstanding supply reply before resetting the same four transfer
  buffers and converter. Ordered begin/finish messages on the direct worker/worklet port acknowledge
  epoch activation and readiness. During prefill, the existing render instance emits silence.
  A superseded seek promise rejects explicitly; only the current epoch can complete it.
- Snapshot tuples contain `epoch`, `ready`, `sourcePosition`, `pcmPosition`, `renderFrame`, `ended`
  and `presentationTime: null`. `pcmPosition` is an **absolute next-consumption cursor**, initialized
  at the realized seek grid point; it is not a cumulative count of samples copied since load.
  Source position is its floor-rounded media cursor. Native includes acknowledged paused state in
  the same tuple; browser pause awaits context suspension before requesting its tuple. Producer
  telemetry is epoch-tagged but remains a separate asynchronous last observation. Its read/prepared/
  admitted coordinates are absolute per-epoch cursors, not cumulative I/O counts.
- Close aborts browser preparation, terminates its worker and closes the context. A late preparation
  result is disposed rather than installed. Pending status/seek promises reject; obsolete replies
  cannot revive playback. Close and the existing Stall/feed proof control remain available during
  pending operations. Native shutdown joins the worker outside the callback. Local file reads are
  bounded, but an operating-system I/O stall cannot be synchronously interrupted by this private path.
- The current PCM plan has stateless gain. Seek clears pending/partial source level windows while
  preserving render-time state. No generic processor reset/state-migration contract is added.
- Proof controls accept source frames only. Invalid targets leave the active epoch unchanged. Native
  `seek FRAME` prints requested/realized coordinates and an epoch; subsequent `status` reports its
  readiness. Browser Seek resolves readiness, with a five-second preparation timeout. An injected
  stall must be released within that timeout; timeout is an explicit failure, not a readiness claim.

The initial player needs local-file load/cancel, readiness/error state, play/pause, source-frame seek
and its result, epoch-tagged snapshots, gain control and close. These are integration needs, not a
new public `PlaybackSession`, transport abstraction, catalog or player UI implementation.

## Automated evidence

Rust/Cargo 1.98.0, Bun **1.4.0** through `node_modules/.bin`, wasm-bindgen 0.2.127; dependency pins
unchanged. Device-opening tests remain ignored. Commands:

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

Final results: Rust debug/release each **66 passed, 2 ignored** (device-opening proofs). Bun:
**45 web tests, 12 WAV/conversion/scheduling/seek tests, 6 lab/canvas tests, 8 lab UI tests**, plus
TypeScript, actual-Wasm programs, memory checks and source audits. All commands above passed on the
final source, and generated runtime artifact hashes remained unchanged after rebuilding.

Coverage:

- Shared converter: exact **same-build** comparisons of complete post-seek tails against uninterrupted
  output, both conversion directions and same-rate bypass, distinct stereo content, short files,
  zero/end/near-end, forward/backward/repeated seeks and FFT boundaries. Globally aligned overlap
  reconstruction passes bit-exactly; this is not native-to-Wasm identity or a new analytic DSP claim.
- Native real-file worker → fixed rings → compiled callback: matching rate/format fixtures, paused
  partial-block reclamation and readiness, latest-request replacement, finite tails/EOS/post-EOS,
  preparation silence with continuous render time, invalid-target rejection and close while preparing.
  Existing starvation/recovery and format/layout suites remain green. Callback allocator coverage
  includes paused seek/reclamation and readiness; no Rust alloc/realloc/dealloc calls observed.
- `tools/check-wav-seek.test.ts`: **built browser worker**, actual Wasm, transferable MessageChannels,
  same-rate and both conversions, PCM24 stereo/PCM16 mono and 1/17/10003-frame sources. Every rendered
  tail is compared to separately partitioned uninterrupted conversion. Held asynchronous reads and
  admission returns exercise superseding work; endpoint reclamation verifies all four slots free and
  zero transfers in flight. These tests run in Bun, not an AudioWorklet scheduler.
- Browser control tests cover explicit supersession/close rejection, command credit, obsolete producer
  observations, replacement of reordered stale snapshots and cancellation/disposal of late preparation.
  Prepared-input tests reject malformed blocks during paused reclamation before they become current.
- Existing 10000-render-call checks retain unshared **256 pages / 16 MiB** memory. Worklet source
  audits find no forbidden callback patterns. Allocator/memory/source checks remain bounded empirical
  evidence, not proof of hard real-time deadlines or JavaScript allocation freedom.

## Muted browser lifecycle observations

Chrome **152.0.7977.83**, macOS **26.6.2 (25G83), arm64**, isolated agent-browser session with
`--mute-audio`, loopback proof server on port **4313** (not the daily-driver channel). The final
harness explicitly requests each context rate; these are **not device-default or device-rate-change
observations**. No native device output, system volume or device configuration was touched.

Each row uses a quiet 30-second stereo local WAV (44100 PCM24; 48000 PCM16), but does **not** play the
whole file uninterrupted. The coherent workflow is: load/ready; paused seek to 7001; play for a
10-second wall-clock observation; pause/backward seek; twenty superseded requests plus a final seek;
play/stall/recover; playing seek to the last second; consumed EOS; paused endpoint seek; seek back to
zero; close during another seek. Two competing `nice -n 10 yes` CPU workers and requested **8 ms main-
thread busy work every 40 ms** run throughout. No visibility manipulation or browser matrix is claimed.

| Source → context | Unforced starvation at 10 s check | Injected starvation total at EOS | EOS source / PCM | Preserved render frame at EOS → paused endpoint → zero | Maximum producer poll delay |
| --- | --- | --- | --- | --- | --- |
| 44100 → 48000 | 0 | 130 | 1323000 / 1440000 | 542464 | 15.6 ms |
| 48000 → 44100 | 0 | 120 | 1440000 / 1323000 | 511232 | 17.3 ms |
| 48000 → 48000 | 0 | 128 | 1440000 / 1440000 | 557824 | 16.0 ms |

All rows: 128-frame callbacks, fixed 16 MiB memory, zero failure/invalid-block codes and producer
rejections. Each final epoch is 27. Expected stale-block retirement counts reach 16 before post-EOS
reload; these count discarded old buffers, **not old audio consumption**. Sample non-contamination is
established by the offline/native/worker-Wasm reference fixtures, not inferred from browser counters.
No new starvation was recorded after recovery through EOS. During the injected stall, PCM stayed at
52096 / 48196 / 52096 respectively while render time advanced; after Feed, consumption resumed.

The same final build also verifies:

- abort after sending an actual worker `inspect` request: preparation rejects and the owned worker is
  terminated once; no later result installs a session
- malformed WAV rejection followed by a valid one-frame stereo reload, explicit ready at zero and
  consumed EOS at source/PCM 1/1, zero starvation
- the actual proof-page Stall → Seek → Feed interaction: Feed remains enabled while seeking, and
  readiness completes paused at source/PCM 7001/7001 without a render-clock reset
- pending seek rejects `Playback closed`; twenty superseded promises reject `Seek superseded`
- no page errors; owned browser sessions, loopback servers and CPU workers cleaned up

An earlier long harness timed out before playback because it invoked `AudioContext.resume()` without
first providing a browser user gesture. It is **not** passing playback evidence. A paused-only
21-request reproduction completed; after a real page click, the complete final harness above passed.
Earlier short candidate observations were also not reused after source changes: final artifact hashes
were checked unchanged around the recorded final run.

```text
3805cc0f103f897a8517efc9abe5928a5a3a53f47feda6c55fd4f4e398f6d60a  web/dist/kkb_audio_bg.wasm
748ee77d0cc44500770c9c3beea79a328258871f898abd850aa69c4b3c4366bf  web/dist/pcm-worker.js
a8413ee5bc0aec09da30e8f5fda77fa958b4f7fb92c1e837d5b759bb3730758a  web/dist/worklet-processor.js
7179b3679e8d8203bc1331c9934eb1784e7d5631fe7c469b54010c5beb8e36f3  web/dist/main.js
```

## Independent review and gate disposition

Fresh-context read-only Standards and Spec reviews identified three in-scope findings: prepared-input
reclamation bypassing validation, an obsolete snapshot leaving its pending request to time out, and
Stall/feed being disabled during seek preparation. All three were repaired; targeted tests cover the
first two and the actual proof-page Stall/Seek/Feed interaction passes. Both retained reviewers
accepted their corrections on focused read-only follow-up, with **no remaining findings**. Parent
reran all gates and performed runtime observations; reviewers did not execute tests or open devices.

No concrete blocker to the initial local-WAV player has emerged from the completed fixtures. The
bounded gate is **not** production readiness: presentation estimates, click-free transitions,
subjective listening, physical native output for this increment, broad browser/device support,
background/sleep/device-handoff behavior, arbitrary I/O stall tolerance and sustained performance
certification remain unclaimed. The retained transfer transport and refill headroom are unchanged.

## Safe reproduction

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
bun tools/local-wav-fixture.ts /tmp/kkb-seek-44100.wav 44100 24 2 30
bun tools/local-wav-fixture.ts /tmp/kkb-seek-48000.wav 48000 16 2 30
bun run build:worklet
PORT=4313 bun run serve:proof
```

In an isolated **muted** browser, select/load a fixture and exercise the sequence above. Record the
actual context rate and any harness override; a real page interaction is required before Play.
`sourcePosition` and `pcmPosition` freeze during starvation; `renderFrame` advances unless paused.
Seek to `totalFrames` is ready/ended without a sentinel audio block; seek zero after EOS re-primes the
same instance. Close may cancel loading or seeking. Native `seek FRAME` is available through the
[opt-in interactive proof](2026-09-08-local-wav-playback-evidence.md#safe-reproduction), but **requires
separate physical-output permission**; normal checks remain device-free.
