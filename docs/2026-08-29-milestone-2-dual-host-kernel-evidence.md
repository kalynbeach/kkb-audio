# Milestone 2 dual-host kernel evidence

Date: 2026-08-29
Browser observations: 2026-08-30
Status: Checkpoint A complete; Checkpoint B remains open
Issue: [#2](https://github.com/kalynbeach/kkb-audio/issues/2)

## Claim boundary

This document records evidence for the private Milestone 1 kernel in an unshared, worklet-local Wasm
instance. Checkpoint A is complete for the recorded Helium, Zen, macOS Safari, and physical iOS Safari
configurations. CPAL work has not begun.

The proof does not cover PCM transport, shared memory, Wasm threads, sustained application load,
a processor interface, a compiled plan, minimum browser versions, branded-browser support, or broad
browser compatibility.

## Browser engine observation scope

Checkpoint A used four configurations to catch browser-engine and iOS lifecycle differences without
turning this architecture proof into browser support certification:

- Helium on macOS for Chromium
- Zen on macOS for Gecko
- Safari on macOS for desktop WebKit
- Safari on a physical iOS device for mobile WebKit and iOS lifecycle behavior

The results apply only to the recorded configurations. Helium does not establish Chrome support, and
Zen does not establish Firefox support. The existing Chrome run remains supplementary evidence rather
than a required row. No browser or operating-system application was updated for the observations.

## Toolchain and local host

Recorded for the built artifact and original local implementation:

- Rust `rustc 1.98.0 (88d9e12ae 2026-08-18)`
- Cargo `1.98.0 (797e8a9bc 2026-08-05)`
- Bun `1.4.0`
- `wasm-bindgen` crate and CLI `0.2.127`
- TypeScript `7.0.2`, executed through Bun
- macOS 26.5.2 build 25F84
- MacBook Pro `MacBookPro18,2`, Apple M1 Max, 64 GB memory
- installed Helium 0.15.7.1, Chromium 151.0.7922.173
- installed Zen 1.21.16b, based on Firefox 154.0.1
- installed Safari 26.5.2
- supplementary installed Chrome 151.0.7922.175
- physical iPhone 15 Pro Max, iOS and Safari 26.6.1 build 23G83

No browser or operating-system application was updated during implementation or observation.

## Observed artifact

The four required browser observations used one build from commit
`84ee1e30ed7bb9d5133adee47124c46a2f4e22a2`:

```text
17e140727e2ec114046914abaadb71d0934696eec342002cf31b7db2b59c8dd4  web/dist/kkb_audio_bg.wasm
48566b19aed038e32bd8103fedbbf90f0e469d6a6cd22674eb64eafd27223840  web/dist/main.js
17a2b7ddc4e8353273213ba7d4f6ea943f9d3983ab19050c4c790638ff0e4193  web/dist/worklet-processor.js
e52bab89d9d043dbabb421290a0030c4735fc16306f2eb5269826ef64f438475  web/dist/index.html
```

No source changed between browser runs.

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

The worklet captures `memory.buffer` and its 16,777,216-byte length after preparation. Every required
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

## Required browser engine observations

All four configurations used 48 kHz stereo, a prepared maximum of 1,024 frames, one active proof
document, a short muted run, and no deliberate representative application load. Each produced
the deterministic injected preparation failure:

```json
{"state":"failed","code":41}
```

Each normal preparation reported 16,777,216 memory bytes, 256 pages, a 1,024-frame maximum, and a
48 kHz sample rate. Each active run observed a nonzero stereo signal before the zero-gain sink, kept
memory length stable, reported failure code zero, and observed an actual 128-frame callback through
the processor snapshot. `AudioContext.renderQuantumSize` was unavailable in every configuration.

### Safari on macOS

Safari 26.5.2 ran headed on macOS 26.5.2 build 25F84 on the recorded `MacBookPro18,2`. The proof
reported a visible, focused document and 114 active process calls. WebDriver BiDi captured no console
entries.

### Zen on macOS

The exact installed Zen 1.21.16b binary reported Firefox 154.0.1 build 20260828113729. It ran with an
isolated temporary headless profile on macOS 26.5.2 build 25F84 on the recorded `MacBookPro18,2`; the
document reported visible and focused, and the proof recorded 114 active process calls. WebDriver
BiDi captured no console entries.

Isolated headed Zen sessions produced a zero-sized content viewport while the existing personal Zen
process remained open. The observation therefore used the isolated headless configuration rather
than disturbing that process or its profile. The project accepts this as configuration-specific Gecko
evidence, not a general Zen or Firefox support claim.

### Helium on macOS

The exact installed Helium 0.15.7.1 binary reported Chromium 151.0.7922.173. It ran headed with an
isolated temporary profile on macOS 26.5.2 build 25F84 on the recorded `MacBookPro18,2`. The proof
reported a visible, focused document and 112 active process calls. Browser console and page-error
capture were empty.

### Safari on physical iOS

Safari ran on a physical iPhone 15 Pro Max with iOS and Safari 26.6.1 build 23G83. SafariDriver
reported `useSimulator: false`; the proof document was visible and focused and recorded 110 active
process calls. WebDriver BiDi captured no console entries.

SafariDriver pointer input emitted trusted touch events without dispatching a click. The successful
activation used a trusted WebDriver Enter key sequence; the page observed trusted keydown, click, and
keyup events with `navigator.userActivation.isActive` equal to `true`. This records the tested input
path without claiming broader touch-activation behavior.

## Supplementary Chrome observation

Short muted proof runs used `agent-browser` against the installed Google Chrome 151 build. The browser
identified itself as HeadlessChrome 151.0.0.0, with Google Chrome and Chromium major version 151. The
page was served from `http://127.0.0.1:4173` without cross-origin isolation;
`crossOriginIsolated` was false and `SharedArrayBuffer` was undefined.

The initial run observed deterministic injected preparation failure:

```json
{"state":"failed","code":41}
```

After the lifecycle and diagnostic hardening in commit `2da3de9`, the proof rejected a concurrent
Prepare action, closed the active proof before sequential replacement, and rendered successfully:

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
    "processCount": 30
  }
}
```

Chrome 151 did not expose `AudioContext.renderQuantumSize`, so the processor snapshot supplied the
actual 128-frame channel-array length. The test harness does not assume that value. The analyser saw
nonzero stereo oscillator output before a zero-gain sink muted device output. No browser console
errors were recorded. The server, context, and isolated browser session were closed after each run.

This is supplementary implementation evidence for one Chrome/Chromium configuration, not a minimum
version or branded-browser support claim. The run was too short to support a deadline or
sustained-load claim.

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

## Checkpoint A conclusion

The project accepts Checkpoint A for the exact configurations and bounded conditions recorded above.
The observations establish deterministic initialization, active rendering through actual host channel
lengths, stable fixed Wasm memory, and failure-free short muted execution across the tested Chromium,
Gecko, desktop WebKit, and physical mobile WebKit configurations.

The observations do not establish sustained-load or deadline behavior. Characterize JavaScript-engine
and host allocation separately if a stronger allocation claim is needed. Current evidence only rules
out explicit callback-local collection or view construction in project code and retains the Milestone
1 native Rust allocator probe.

Checkpoint B may now begin. The macOS CPAL adapter and native observation remain required before
Milestone 2 closes.
