# Milestone 2 dual-host kernel evidence

Date: 2026-08-29
Status: Checkpoint A implemented; required browser matrix and Checkpoint B remain open
Issue: [#2](https://github.com/kalynbeach/kkb-audio/issues/2)

## Claim boundary

This document records evidence for the private Milestone 1 kernel in an unshared, worklet-local Wasm
instance. It does not mark the `AudioWorklet` checkpoint complete. The current stable browser matrix
has not run, Safari on a physical iOS device has not been recorded, and CPAL work has not begun.

The proof does not cover PCM transport, shared memory, Wasm threads, sustained application load,
a processor interface, a compiled plan, or broad browser support.

## Browser minimums recorded at implementation start

The issue requires the current stable releases on 2026-08-29 to become the minimum versions for this
proof:

| Host | Required minimum | Source | Checkpoint A result |
| --- | --- | --- | --- |
| Chrome on macOS | 152.0.7977.65 | [Chrome Releases, 2026-08-25](https://chromereleases.googleblog.com/2026/08/stable-channel-update-for-desktop_0256176589.html) | Not run |
| Firefox on macOS | 154.0.1 | [Mozilla product details](https://product-details.mozilla.org/1.0/firefox_versions.json) | Not run |
| Safari on macOS | 26.6.1 | [Apple Safari 26.6.1](https://support.apple.com/en-us/148286) | Not run |
| Safari on physical iOS | iOS 26.6.1 / Safari | [Apple iOS 26.6.1](https://support.apple.com/en-us/148282) | Device model and OS build not yet recorded; not run |

Older browsers, Android, other iOS browser apps, Windows, and Linux are outside Milestone 2.

## Toolchain and local host

Recorded before implementation:

- Rust `rustc 1.98.0 (88d9e12ae 2026-08-18)`
- Cargo `1.98.0 (797e8a9bc 2026-08-05)`
- Bun `1.4.0`
- `wasm-bindgen` crate and CLI `0.2.127`
- TypeScript `7.0.2`, executed through Bun
- macOS 26.5.2 build 25F84
- MacBook Pro `MacBookPro18,2`, Apple M1 Max, 64 GB memory
- installed Chrome 151.0.7922.175
- installed Firefox 95.0.2
- installed Safari 26.5.2

The installed browsers are below the required matrix and do not earn a minimum-version support claim.
No browser or operating-system application was updated during implementation.

## Implemented Checkpoint A behavior

The Milestone 1 `PreparedKernel::prepare` and `PreparedKernel::render(Output)` definitions remain in
the private `prepared_kernel` module. The Wasm-only adapter owns fixed planar `f32` storage and calls
that render seam directly. Host lifecycle, memory checks, channel-array validation, copying, and
failure-to-silence behavior remain in the adapter and worklet glue.

The control-thread harness:

1. creates and suspends an `AudioContext`
2. fetches and compiles the Wasm module outside the worklet
3. loads the audited processor module
4. transfers the compiled `WebAssembly.Module` in `processorOptions`
5. constructs the node while disconnected
6. waits for one coded `ready` or `failed` message
7. connects and resumes only through a separate user activation

Timeout, malformed-message, duplicate-message, and `processorerror` paths become coded failures.
The processor catches preparation errors, reports one initialization result, and produces positive-zero
silence whenever it is not ready or its prepared adapter has failed.

Each active `process()` call derives its frame count from the actual first output channel and validates
equal stereo channel lengths. The adapter checks the Wasm memory buffer object and byte length before
every render. It calls the unchanged Rust render seam, then copies from pre-created maximum-length
planar views without creating callback-local views. Invalid layout, capacity excess, non-rendered
Rust status, memory replacement, or an exception permanently silence every supplied host channel.

## Wasm memory and generated-glue evidence

`.cargo/config.toml` passes explicit wasm-ld limits of 16,777,216 bytes for both initial and maximum
memory. This is 256 64-KiB pages and is a proof fixture, not a product capacity.

`bun run check:wasm` parses the emitted memory section and compiles the final binding artifact. It
reported:

```json
{"bytes":16777216,"exportedName":"memory","maximumPages":256,"minimumPages":256,"shared":false}
```

The worklet captures `memory.buffer` and its 16,777,216-byte length after preparation. The local
browser snapshot reported the same length after active callbacks with failure code zero. The test
suite also replaces the buffer identity and verifies permanent positive-zero silence without a Wasm
render call.

The build uses `wasm-bindgen` 0.2.127 generated glue, replaces its error-string formatting import with
a fixed numeric trap code, and lets Bun remove the now-unused decoder helpers. This pinned transform
fails the build if the generated source changes. `bun run audit:worklet` reported one synchronous
initializer, one processor registration, and no `fetch`, streaming instantiation, `TextDecoder`,
`SharedArrayBuffer`, Atomics, logging, worker, socket, or `AudioContext` references in the 10,487-byte
worklet bundle:

```json
{"bytes":10487,"forbiddenPatterns":[],"processorRegistrations":1,"synchronousInstantiation":true}
```

Networking and application control exist only in the main-thread proof harness.

## Automated evidence

The Bun tests cover:

- mono mapping with actual lengths 17 and 257
- stereo mapping with distinct 96-frame host channels
- unequal stereo lengths and persistent positive-zero silence
- capacity excess without a Wasm render call
- Wasm memory identity replacement
- unambiguous non-rendered Rust status mapping and caught exceptions
- one `ready`, one coded `failed`, malformed messages, duplicate messages, timeout, and
  `processorerror` state transitions
- closure during observation and runtime failure during a snapshot request
- exclusive proof preparation and close-before-replace lifecycle ownership

Fifteen TypeScript tests pass. A direct Wasm binding check also verifies that an over-capacity call
preserves a zero-frame no-op before later nonzero calls report the terminal state. The existing
fourteen Rust tests remain the offline reference and pass in debug and optimized builds, including the
warmed native allocator probe.

## Local browser observation

A short muted proof ran through `agent-browser` against the installed Google Chrome 151 build. The
browser identified itself as HeadlessChrome 151.0.0.0, with Google Chrome and Chromium major version
151. The page was served from `http://127.0.0.1:4173` without cross-origin isolation;
`crossOriginIsolated` was false and `SharedArrayBuffer` was undefined.

Observed failure path:

```json
{"state":"failed","code":41}
```

Observed preparation and active rendering:

```json
{
  "analyserObservedSignal": true,
  "channelCount": 2,
  "contextRenderQuantumSize": null,
  "contextSampleRate": 48000,
  "initialization": {
    "memoryBytes": 16777216,
    "memoryPages": 256,
    "maximumFrames": 1024,
    "sampleRate": 48000,
    "type": "ready"
  },
  "snapshot": {
    "failureCode": 0,
    "lastFrameCount": 128,
    "memoryBytes": 16777216,
    "processCount": 2
  }
}
```

Chrome 151 did not expose `AudioContext.renderQuantumSize`, so the processor snapshot supplied the
actual 128-frame channel-array length. The test harness does not assume that value. The analyser saw
nonzero stereo oscillator output before a zero-gain sink muted device output. No browser console
messages were recorded. The server, context, and isolated browser session were closed after the run.

This is useful implementation history only. It predates the lifecycle and diagnostic hardening pass,
Chrome 151 is below the required minimum, and the run was too short to support a deadline or
sustained-load claim. The required browser matrix must establish evidence for the hardened artifact.

## Validation commands

The following checks pass on the recorded host:

```text
cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --release -- -D warnings
bun run check
```

The Wasm-target strict Clippy command completed successfully with no warnings. `bun run check` builds
the Wasm and JavaScript artifacts, type-checks the TypeScript, runs the fifteen Bun tests, verifies
direct binding zero-frame and terminal behavior and fixed unshared Wasm memory, and audits the worklet
bundle.

## Evidence still required before Checkpoint A closes

- Run the ready, injected-failure, active-render, actual-quantum, and stable-memory proof on Chrome
  152.0.7977.65 on macOS.
- Run the same proof on Firefox 154.0.1 on macOS.
- Run the same proof on Safari 26.6.1 on macOS.
- Record a physical iOS device model and build, then run the same proof on iOS 26.6.1 Safari.
- Record exact sample rate, channel layout, load conditions, and browser console result for each row.
- Characterize JavaScript-engine and host allocation separately if a stronger allocation claim is
  needed. Current evidence only rules out explicit callback-local collection or view construction in
  project code and retains the Milestone 1 native Rust allocator probe.

Checkpoint B must not begin until the project accepts this browser checkpoint evidence.
