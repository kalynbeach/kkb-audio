# Milestone 4 compiled-plan evidence

Date: 2026-09-06
Status: Gates A and B implemented within the automated and browser observations below
Gate A branch: `feat/4-compiled-plan`, based on `b1bf745`
Gate B branch: `feat/4-prepared-pcm-plan`, based on verified Gate A `a9c25735625b14246197002760587beafe7f1385`

The original sections through Reproduction record the Gate A checkpoint, including its wire version
and artifact hashes. The [Gate B section](#gate-b-pcm-integration) records the current PCM integration,
wire version 2, validation, and shared operation-representation decision.

## Claim boundary

This implements the oscillator-only Gate A in the
[initial validation plan](./2026-08-29-initial-render-engine-validation-plan.md#milestone-4-minimal-compiled-plan).
It proves a private fixed operation table, independent prepared instances, static fan-in,
sample-timed gain events, and bounded output observations. The same Rust program runs in native
offline tests and unshared Wasm, including a real `AudioWorklet` observation.

The [canonical architecture](./2026-08-28-kkb-audio-system-architecture.md) remains the authority.
At the Gate A checkpoint there was no PCM-input plan integration, public graph API, live replacement,
state migration, production synthesis claim, or new CPAL device run. The Milestone 3 PCM implementations
remained separate. Gate B below closes PCM integration and records the operation-representation decision.

## Closed program and ownership

```text
997 Hz oscillator  -> gain A ┐
                            mix -> level observation -> mono or semantic L/R output
1499 Hz oscillator -> gain B ┘
```

[`src/compiled_plan.rs`](../src/compiled_plan.rs) contains the private description, compiler, immutable
`CompiledPlan`, and single-owner `RenderInstance`. Compilation checks the seven-node topology,
zero-delay cycles, source ports, mono internal layouts, sink layout, processor and parameter
identifiers, values, and preparation capacities. It accepts exactly two distinct oscillator/gain
paths into one mix followed by observation and output. Shuffling the input description preserves
operation order because the topological sort breaks ties by stable processor ID.

Processor IDs are 10 and 30 for oscillators, 20 and 40 for gains, 50 for mixing, 60 for the
post-master observation, and 70 for output. Gain parameter 1 belongs to its processor, so its address
is the pair of IDs. The gains default to 0.25 and 0.125 and support sample-rate evaluation over
`[-1, 1]`. Frequencies remain static, finite, and within `0 <= frequency < sample_rate / 2`.
Output is the sum without normalization or clipping. Stereo duplicates that sum into distinct planes.

Each instance copies the small immutable operation table, allocates and initializes seven fixed
mono planes, and owns its phases, gain/ramp state, event slots, clock, and observation progress.
No reference counting or callback-side final owner release is involved. The fixture prepares for at
most 1,024 frames, 16 pending events, and one latest completed level observation. These bounds are
proof choices, not product limits. Buffer reuse optimization is unnecessary for this seven-node proof.

Frame count comes from borrowed output planes. Zero frames are a strict no-op. Invalid layouts and
checked clock overflow silence every supplied sample without changing render state. Over-capacity
does the same and makes the instance terminal. The executor contains no host branches or PCM types.

## Automation semantics

Events use absolute `u64` render frames. Admission orders them by frame, then by admission order for
equal frames. Invalid targets, nonfinite or out-of-range values, late events, invalid ramp intervals,
and a full queue return fixed errors without changing the queue. An event cannot target `u64::MAX`,
because the checked next-frame clock cannot advance beyond that frame. Consumption reclaims slots.
The browser fixture admits all events during preparation; main-thread timers do not apply them.

The executor applies events before producing the sample at their frame. A set replaces any active
ramp. A ramp captures the parameter's current value at its start frame, including earlier events at
that frame, and reaches the target exactly at its inclusive end frame. It evaluates from integer
offsets relative to the start, so callback partitions cannot move the endpoint. An interrupted ramp
first evaluates its value at the interruption frame. Cancellation by event identity and a public
automation language remain deferred.

| Frame | Event |
|---|---|
| 17 | Set gain A to 0.5 |
| 31 | Begin gain B ramp from 0.125 to 0.375, reaching its target at frame 257 |
| 400 | Set gain A to 0.2, then to 0.3 in admission order |

## Observations

Observation 60 measures the final mixed signal before output mapping. There is no subsequent engine
master gain in this proof. It accumulates peak and `f64` squared samples across fixed 64-frame windows,
then reports peak and RMS for `[start_frame, end_frame)`. Stereo has the same values in each plane.

Window boundaries depend on render time, not callback boundaries. Each summary contains its location,
interval, sequence number, and cumulative dropped-summary count. There are no media coordinates for
these generators. A new completed window overwrites an unread summary and increments the saturating
drop counter. Taking the summary clears the pending slot. An incomplete window remains in the
instance until more frames arrive. This is a bounded observation path, not a stream of retained audio.

## Browser preparation and execution

[`src/compiled_plan_wasm.rs`](../src/compiled_plan_wasm.rs) exports a private fixture compiler and
`WorkletPlan` binding. [`plan-worker.ts`](../web/src/plan-worker.ts) compiles the fixture in a dedicated
worker and transfers its `Uint32Array` backing buffer to the main thread. The main thread terminates
the compiler worker and passes the pointer-free words to the worklet through structured-cloned node
options. No worker participates in rendering.

Wire version 1 contains an eight-word header, seven eight-word operation records, and up to sixteen
eight-word event records. The header fixes rate, layout, frame capacity, observation window, and record
counts. Operation inputs refer to earlier table slots; IDs remain stable across compilation. Event
frames use low/high `u32` words, preserving the full integer clock. The fixture occupies 96 words.

The worklet bounds the incoming description length before entering Wasm. Local validation checks exact
length, version, operation types and references, topology, identities, values, event capacity, and
the negotiated host rate/layout. Canonical re-encoding also rejects nonzero reserved fields and
noncanonical records. This is bounded validation of seven operations during construction, before the
node is connected. Failed preparation returns code 60; malformed browser options return code 40.

[`plan-processor.ts`](../web/src/plan-processor.ts) signals ready only after local preparation.
[`plan-adapter.ts`](../web/src/plan-adapter.ts) constructs and retains all Wasm output views before
activation, uses actual channel-array lengths, and latches host/render failures to silence. Its
callback does not create views, messages, collections, or observation objects. Snapshot messages
consume the one pending observation outside `process()` and convert integer clocks to decimal strings.

The separate [`plan-proof.html`](../web/plan-proof.html) page prepares a suspended, disconnected node,
then connects it through an analyser and zero-gain output for a muted observation. Activation fails
if the analyser sees no signal or the render snapshot reports failure. Failed activation disconnects
and suspends the context. Closing releases the context. The original `/` PCM proof is unchanged.

## Automated evidence

The final native suite passed in debug and release: 41 tests passed, with the existing device-opening
CPAL test ignored. Twelve focused Gate A tests in
[`src/compiled_plan/tests.rs`](../src/compiled_plan/tests.rs) cover:

- direct two-tone references with and without automation, including distinct stereo planes
- invalid topology, ports, layouts, identifiers, values, and capacities
- stable compilation order and independent instance state and storage
- bit-exact output, automation state, and observation accumulation across one-block, one-frame,
  and irregular partitions, including zero calls and event boundaries
- ramp start/end samples, interrupted ramps, same-frame admission order, and integer offsets near
  the clock limit
- atomic event rejection, queue exhaustion and reuse, output failures, and terminal capacity behavior
- peak/RMS agreement with output, partial windows, overwritten observations, and saturating counters
- versioned description round trips and malformed/truncated record rejection
- stable buffer addresses and no observed `alloc`, `alloc_zeroed`, `realloc`, or `dealloc` calls in
  warmed rendering, event consumption/admission, observation retrieval, zero, and failure paths

`bun run check` passed using Bun 1.4.0: strict TypeScript checking, 39 tests with 719 assertions, the
existing PCM checks, the plan checks, and both worklet source audits.
[`tools/check-worklet-plan.ts`](../tools/check-worklet-plan.ts) exercises actual Wasm at 44.1 and 48 kHz
in mono and stereo. Its 1,000-frame direct reference has tolerance `1e-6`; maximum measured error was
zero on this build. That does not establish cross-target bit identity. Same-Wasm partition comparisons
are exact. Peak/RMS summaries agree with output at tolerance `1e-12` for RMS. Ten thousand 128-frame
renders per configuration preserve Wasm memory identity and byte length.

The same script instantiates the built processor with only its browser host mocked. It verifies local
ready/failed handshakes, invalid-version rejection, failure silence, and observation publication only
on snapshot messages. Bun unit tests also cover preallocated output mapping, terminal host failures,
bounded snapshot consumption, and failed activation cleanup.

The source audit checks the plan processor, generated `WorkletPlan.render` wrapper, planar adapter,
and callback-reachable failure/silence helpers. It found no forbidden host facilities, callback-local
construction, observation object creation, scheduling, or messaging in those bodies. The Wasm memory
check reports an unshared 256-page minimum and maximum, 16,777,216 bytes.

Allocator counters describe only the exercised Rust path. The source audit is a bounded textual
check, not a JavaScript allocation profiler. Neither establishes deadline safety, sustained load
performance, absence of page faults, or broad browser/device support.

## Recorded browser observation

The final build ran through Codex's built-in Chromium browser on macOS 26.6.2, build 25G83, arm64.
The browser reported `Chrome/152.0.0.0` in its reduced user agent. The full browser build was not
available because the browser URL policy blocked the internal version page. This is an observation
of the built-in browser, not a branded Chrome support claim. No other browser or physical device was
tested for Gate A.

The muted stereo proof at 48 kHz sampled the analyser after a 300 ms timer, then requested a worklet
snapshot. This timer only samples evidence; all gain events execute against the Rust frame clock.
The context did not expose `renderQuantumSize`; the callback's actual observed length was 128 frames.
Preparation succeeded while suspended and disconnected. The final snapshot reported:

```json
{
  "analyserObservedSignal": true,
  "failureCode": 0,
  "lastFrameCount": 128,
  "memoryBytes": 16777216,
  "processCount": 114,
  "nextFrame": "14592",
  "observation": {
    "startFrame": "14528",
    "endFrame": "14592",
    "sequence": "228",
    "dropped": "227",
    "peak": 0.666486382484436,
    "rms": 0.3399522582368812,
    "location": 60
  }
}
```

The 227 drops are expected: the snapshot reads the latest of 228 completed windows. The browser's
invalid-version control separately reported `plan preparation failed: 60` before activation. The
valid context was closed after the observation.

## Toolchain and artifact identity

The artifact used Rust `1.98.0 (88d9e12ae 2026-08-18)`, wasm-bindgen crate/CLI 0.2.127, Bun 1.4.0,
TypeScript 7.0.2, and `@types/bun` 1.4.0. The Wasm target is `wasm32-unknown-unknown`; build memory
settings remain in [`.cargo/config.toml`](../.cargo/config.toml). No dependencies changed.

| Built artifact | SHA-256 |
|---|---|
| `web/dist/kkb_audio_bg.wasm` | `12287fe019ae4dac11798c03266e202116edce8bad6f42dad6294cfab169a1e5` |
| `web/dist/plan-processor.js` | `7993f3372d67b9dac75bcdb80a8d0f80212abeee923c882a5eef2bc6b56ba271` |
| `web/dist/plan-worker.js` | `bde85ea5bacd58cb6b752124722dc2b997fc7ee260940a76cc0642d65726ecd8` |
| `web/dist/plan-main.js` | `41cf381e50d5672e29b94f2d0f6e45fb3f9699aa05ee74ca5663f7de163b4a50` |

## Reproduction

```sh
cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --lib -- -D warnings
bun run check
bun run serve:proof
```

Use the pinned Bun 1.4.0 binary. Open `/plan.html`, prepare, then activate the muted proof. Close it
after reading the result. The invalid-version control checks the local worklet rejection path.

## Gate B PCM integration

Date: 2026-09-06
Base: `a9c25735625b14246197002760587beafe7f1385`, verified locally and through GitHub before branching

The second closed program is:

```text
prepared PCM input -> linked gain 0.5 -> level observation -> mono or semantic L/R output
```

The compiler accepts four operations for this program, alongside the seven-operation Gate A program.
Processor IDs are 10 for PCM, 20 for gain parameter 1, 60 for observation, and 70 for output. Static
PCM configuration contains source identity, sample rate, and channel layout. Compilation rejects
rate/layout mismatches, invalid topology, and invalid capacity before preparing an instance.

The PCM program preserves distinct stereo planes. Gain uses the existing sample-timed set/ramp
semantics and applies one value to both channels. Peak is the maximum absolute sample across the
channels; RMS is the square root of the mean square across all channel samples in a 64-frame window.
Observation intervals and the instance clock remain render coordinates. They are not media position,
epoch-tagged playback observations, or seek-completion reports. The render clock and automation
continue through starvation and end-of-stream silence.

### Input and ownership boundary

`RenderInstance::render_pcm` validates output layout, frame capacity, checked clock, source identity,
rate, layout, and prepared input capacity before pulling PCM. A matching zero-frame call changes
neither the plan nor the seam. Rejected output or incompatible input is silenced without consuming
blocks, advancing events, changing meter state, or advancing the clock. An over-capacity output makes
the render instance terminal. Missing or incompatible input returns `InvalidInput`; the Wasm binding
maps this to code 6. The oscillator-only `WorkletPlan` binding rejects a PCM description at preparation.

`PreparedPcmInput` remains the only owner of epoch filtering, block partition adaptation, starvation,
end-of-stream handling, and retirement. It rejects stale queued blocks and the remaining tail of an
old current block before the PCM operation reads its samples. Future epochs remain invalid. Native
retirement backpressure retains ownership in the seam and produces silence until retirement succeeds.
The operation reads only the instance's preallocated planes; it has no SPSC ring, `MessagePort`,
transferable buffer, host clock, or host conditional.

The two adapter paths now call that same seam and renderer:

- Native worker -> `NativeSource` SPSC rings -> `PreparedPcmInput` -> `RenderInstance` -> CPAL mapping.
- Browser worker -> recycled transferable buffers -> `FixedSlotSource` -> `PreparedPcmInput` ->
  `RenderInstance` -> Web Audio mapping.

Neither transport protocol changed. A transferred browser buffer returns after off-callback copying
and admission. Its corresponding Wasm slot stays unavailable until rendering retires it. A rejected
new block remains in the worker's bounded retry state. Malformed ownership messages still terminate
the transport through the existing failure paths.

The native proof keeps its 4,096-frame preparation bound; the browser proof keeps 1,024. The compiler
allows at most 4,096 PCM frames, while the oscillator program remains bounded at 1,024. Each PCM
instance allocates four sets of mono or stereo planes during preparation. No new runtime dependency,
transport queue, reference counting, or callback-side final drop is introduced.

### Compiled description and preparation

Wire version 2 represents either four PCM operations or seven oscillator operations. The PCM record
stores the stream rate, source ID as two `u32` words, and semantic channel count. Encoding remains
pointer-free; decoding recompiles and checks canonical records, including reserved fields. Version 1
is intentionally rejected. The native round-trip fixture preserves a source ID above JavaScript's
safe-integer range.

Both PCM hosts compile the same small fixed program during preparation. In the browser this bounded
four-node work happens in worklet construction, before the existing ready/activation handshake.
The Gate A oscillator proof still compiles in its dedicated worker and transfers its description.
Gate B does not introduce a second browser compilation or transport protocol.

### Gate B automated evidence

The final Rust suite passes in debug and release: 47 tests pass, and the existing device-opening CPAL
test is ignored. Five new conformance tests cover PCM compilation and wire validation; independent
mono/stereo samples with gain sets and ramps; exact one-block, one-frame, and irregular partitions;
channel-combined observations; source compatibility and atomic rejection; stale current/queued blocks;
future epochs; starvation, recovery, and EOS; and retirement backpressure without allocator calls.

A native worker-to-callback test runs real SPSC delivery through the compiled gain, verifies exact
scaled samples across 17-, 257-, and 1,024-frame calls, and checks the render clock and observation.
It covers mono and stereo. The existing callback allocator test now exercises the compiled PCM path.
The warmed seam-to-plan allocation probe observes zero `alloc`, `alloc_zeroed`, `realloc`, and `dealloc`
calls, including backpressured retirement, observation retrieval, zero calls, and rejection paths.

`bun run check` passes with Bun 1.4.0: 39 unit tests, 725 assertions, strict TypeScript checks, both
actual-Wasm programs, fixed-memory validation, and both worklet source audits. The expanded
`tools/check-worklet-kernel.ts` adds:

- 44.1 and 48 kHz, mono and stereo, 1,000-frame analytic PCM comparisons at gain 0.5
- exact same-Wasm output across one block, one-frame blocks, and uneven block boundaries
- partially consumed old-epoch rejection, stale/future queued blocks, starvation and recovery, EOS,
  duplicate reservation rejection, slot reuse, and terminal capacity behavior
- 10,000 PCM admission/render/recycle calls per configuration with stable memory identity and size
- the built worklet with actual Wasm and a real Bun `MessageChannel`, checking sender detachment,
  returned buffer ownership, full Wasm-slot rejection, retained retry, and exact output after recycling

The transport fixture mocks only the AudioWorklet host. It does not mock the PCM protocol, fixed pool,
Wasm renderer, or worklet adapter. The prior malformed-envelope tests in both transfer directions
remain green. The Gate A actual-Wasm analytic check still reports maximum error zero with tolerance
`1e-6`; this is not a cross-target bit-identity claim.

The following commands passed:

```sh
cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --lib -- -D warnings
bun run check
git diff --check
```

### Gate B browser observation and limits

A fresh muted stereo run used Codex's built-in Chromium browser on macOS 26.6.2, build 25G83, arm64.
The browser's version was unavailable through this session's browser interface; an auxiliary local
header-inspection page was blocked by the browser. This is a limited integration observation with
incomplete browser-version metadata, not a browser support claim.

Preparation completed while suspended and disconnected. Activation observed signal at 48 kHz with
128-frame callbacks. The page sampled after its existing 300 ms timer and reported:

```json
{
  "analyserObservedSignal": true,
  "channelCount": 2,
  "contextRenderQuantumSize": null,
  "contextSampleRate": 48000,
  "workerInitialExhaustionCount": 1,
  "snapshot": {
    "failureCode": 0,
    "invalidBlockCount": 0,
    "lastFrameCount": 128,
    "memoryBytes": 16777216,
    "processCount": 114,
    "slotCount": 4,
    "staleBlockCount": 0,
    "starvationCount": 26
  }
}
```

The 26 starvation callbacks are observed gaps in prepared PCM supply. This run proves execution and
starvation reporting under those conditions; it does not prove continuous playback or adequate
production worker pacing. The context was closed, the temporary tab closed, and the task-local
servers stopped after the observation. No new physical-device CPAL run or browser matrix was run.

The observation preceded the final render-status mapping changes. It used Wasm SHA-256
`4ddd6891c5eb026cd903877982b1ec6dcff7f1254f4158e4478ffa2e4dd78796` and worklet SHA-256
`520bcfff3872eaa4f605764909a3f9fe01d5faa40c1ac3ff0d130fcc3f12f29c`. The final automated checks cover
the later explicit clock-overflow and invalid-input mappings and the final artifacts below.

Allocator probes and textual JavaScript audits are limited to the exercised paths. They do not
establish deadline safety, JavaScript allocation profiling, sustained load, or freedom from page faults.
The fixed Wasm memory remains unshared, with 256 initial and maximum pages, 16,777,216 bytes.

### Gate B artifact identity

The toolchain is unchanged from Gate A: Rust 1.98.0, wasm-bindgen crate/CLI 0.2.127, Bun 1.4.0,
TypeScript 7.0.2, and `@types/bun` 1.4.0. No dependency or lockfile changed.

| Built artifact | SHA-256 |
|---|---|
| `web/dist/kkb_audio_bg.wasm` | `e58cb79a965e4a0a7b30f8102a318aa4db47209f27a9b0a34ee25a8b55b5c69a` |
| `web/dist/worklet-processor.js` | `aa04a9421ccf229b2c1b3aba3e0ca769908cfc8487a1acdbd6ecd91a88fb8bb1` |
| `web/dist/plan-processor.js` | `3a4ce0318fa1336d734cb8b9250b5a2dfab2246a03b1c09bc5b584737a8588e2` |

### Shared operation-representation decision

An independent read-only review accepted the complete Gate B diff against
`a9c25735625b14246197002760587beafe7f1385` with zero actionable standards or specification findings.
The reviewer inspected the code, tests, documentation, final artifact hashes, and whitespace check;
the suite results above were run by the writer.

Retain the private `CompiledPlan` and `RenderInstance` split. Gates A and B demonstrate the same
operation table and executor for native Rust and unshared Wasm, with both transports ending at the
same prepared input seam. Transport mechanisms and host lifecycle remain outside rendering.

Keep one prepared instance per active stream. Live replacement, state migration, production transport
selection, and sustained performance remain unproven. The next scoped increment is same-rate local
WAV with play, pause, position, bounded buffering, and starvation reporting. No decoder, seeking,
resampling, compressed format, HTTP source, production storage, or UI redesign is added here.
