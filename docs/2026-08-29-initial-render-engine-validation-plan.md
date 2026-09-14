# Initial render-engine validation plan

Date: 2026-08-29
Status: Working validation plan

## Purpose and authority

This document defines the implementation order, scope, required evidence, pivot criteria, and
explicit non-goals for the first KKB audio render-engine work.

[KKB audio system architecture](./2026-08-28-kkb-audio-system-architecture.md) is the sole authority
for architecture, terminology, enduring invariants, and decision gates. This validation plan cannot
override it. If implementation evidence contradicts the architecture, update the architecture first
and then adjust this plan.

The first four milestones test one claim at a time:

1. a prepared offline oscillator-and-gain kernel is correct across callback partitions
2. the same kernel interface runs in an `AudioWorklet`, through CPAL, and offline
3. native and browser workers can supply bounded PCM through one host-neutral input seam
4. a private compiled plan earns its place through static fan-in, observations, and sample-timed
   automation

Catalog, storage, authentication, analysis jobs, microphone input, broad playback behavior, and
production networking do not block these milestones.

## Evidence rules

- Stable Rust 1.98 is the pinned baseline for the initial milestones.
- A numeric capacity used in a fixture is not a permanent product limit.
- Same-build partition comparisons may be bit-exact. Analytic and cross-target comparisons state a
  tolerance.
- Allocator counters report only observed allocator, reallocator, and deallocator calls in the
  exercised Rust path. They do not prove hard real-time safety.
- JavaScript allocation, Wasm memory growth, host work, page faults, locks, system calls, and deadline
  behavior require separate evidence.
- Expected invalid input and capacity conditions return fixed statuses. Panic containment is not an
  acceptance mechanism.
- Record the pinned toolchain and dependency versions once for each built artifact. Each browser
  observation names the browser and OS versions, relevant platform or physical device, sample rate,
  channel layout, and bounded load conditions.
- Browser observations validate only the tested configurations. They do not establish minimum-version
  or branded-browser support.
- Public interfaces remain provisional until more than one product or adapter earns them.

## Milestone 1: offline prepared kernel

### Question

Can one small, concrete Rust kernel render deterministic planar audio correctly across arbitrary
in-capacity callback partitions without observed render-path allocation or deallocation?

### Scope

Implement one direct path:

```text
mono sine oscillator -> linked scalar gain -> mono or semantic L/R planar output
```

The kernel follows the canonical architecture contract:

- phase starts at zero on a positive-going crossing
- each frame emits the current phase, then advances and wraps an `f64` phase accumulator
- stereo duplicates the same generated sample identically into distinct left and right planes
- one scalar gain applies to mono or both stereo planes
- each instance owns a checked `u64` next-frame clock
- frame count derives from equal-length borrowed output planes
- zero frames are a strict no-op
- malformed layout, clock overflow, and over-capacity zero every supplied sample and do not advance
  clock or DSP state
- over-capacity is terminal for that prepared instance
- preparation rejects a non-positive or non-finite sample rate, non-finite gain or frequency, and
  frequencies outside `0 <= frequency < sample_rate / 2`

The kernel renders directly into borrowed output. It needs no graph, queue, public processor trait,
internal heap buffer, or synthetic heap owner for drop instrumentation.

A fixture may use 48 kHz and a prepared maximum of 1,024 frames so the 1,000-frame single-block
comparison remains in capacity. That value is not a product decision.

### Explicit non-goals

- automation or event queues
- mixer, observations, or graph compilation
- decoder, PCM transport, or sample-rate conversion
- native or browser host adapters
- public processor abstractions
- production-quality anti-aliased synthesis
- cross-CPU, cross-toolchain, or native-to-Wasm bit identity

### Required evidence

- Analytic mono sine fixtures establish initial phase, emit-then-advance order, gain, and clock.
- Analytic stereo fixtures establish semantic left/right duplication and distinct planar storage.
- A unity-gain fixture prevents gain from hiding oscillator errors; a non-unity fixture establishes the
  composed path.
- Rendering 1,000 frames as one block, one-frame blocks, and generated irregular partitions produces
  bit-identical samples and the same final clock on one pinned build.
- Boundary partitions include zero, 1, 17, 64, 128, 257, and the prepared maximum, including zero
  calls adjacent to phase wraps and maximum-sized calls.
- Zero frames alter no output guard, phase, clock, status counter, allocator counter, or owned state.
- Unequal stereo planes and over-capacity mono and stereo output become positive zero in full, return
  the specified fixed status, and leave state unchanged. A later render on the over-capacity instance
  remains rejected, proving its terminal state.
- Checked clock-overflow fixtures fail atomically rather than differing between debug and release.
- Preparation rejects invalid sample rate, non-finite gain or frequency, and frequency outside the
  initial half-open range.
- A serialized, warmed allocator probe observes no `alloc`, `alloc_zeroed`, `realloc`, or `dealloc`
  calls around valid, zero-frame, invalid-layout, and over-capacity render calls.
- The probe runs in debug and optimized builds. Its conclusion remains limited to the measured Rust
  path.
- `cargo fmt --check`, `cargo test --all-targets --all-features`, and strict Clippy pass.

### Acceptance claim

Success validates only the concrete prepared kernel, its frame semantics, borrowed planar output,
and same-build partition independence. It does not validate hosts, deadlines, Wasm, a processor
interface, or a compiled plan.

## Milestone 2: dual-host kernel proof

### Question

Can the exact Milestone 1 kernel interface execute offline, in an `AudioWorklet`, and through CPAL
without host branches entering its processing path?

### Order

1. non-threaded Wasm in an `AudioWorklet`
2. macOS CPAL

Browser engine observations enter here, not before Milestone 1. Before closing this milestone, run
the proof in Helium on macOS for Chromium, Zen on macOS for Gecko, Safari on macOS for desktop
WebKit, and Safari on a physical iOS device for mobile WebKit and iOS lifecycle behavior. Record the
versions actually tested as observations rather than minimums. A fork establishes evidence for its
engine family and configuration, not support for the corresponding upstream branded browser.
Supplementary browser results are welcome but do not add required rows.

### Browser scope

- compile the kernel for an unshared, worklet-local Wasm instance
- load and instantiate Wasm before active `process()` callbacks
- bound constructor work and create the node before connection or audible context activity
- signal explicit `ready` or `failed` state before activation
- map planar engine output to Web Audio channel arrays using their actual length
- record the context's selected render quantum rather than assuming 128
- pin initial and maximum Wasm pages and treat unexpected growth as failure
- audit generated JavaScript glue used in the worklet
- keep Bun, React, decoding, networking, and application control outside the worklet

The maintained wasm-bindgen AudioWorklet example uses shared memory and threads. It is reference
material for a later deliberate shared-memory build, not the design for this milestone.

### CPAL scope

- negotiate device sample rate, channel layout, and sample format
- derive actual frames from the interleaved callback slice and channel count
- adapt planar kernel output into the prepared interleaved destination
- record observed callback lengths and deadline counters
- move single-owner kernel state into the callback without requiring shared mutable ownership

### Explicit non-goals

- graph or operation-table portability
- decoding or worker PCM transport
- shared Wasm memory or Wasm threads
- dynamic instance replacement
- automation, render observation operators, or sustained application-load performance

### Required evidence

- the same core render interface works offline, in the worklet, and in CPAL
- no host conditionals enter the core processing path
- Web Audio channel mapping and CPAL interleaving are correct
- actual callback lengths are accepted without a fixed-block assumption
- Wasm memory identity and length remain stable after preparation
- the active Rust render path does not allocate, deallocate, or initialize lazily
- worklet initialization produces deterministic ready or failed state
- host-specific failures produce silence without panicking across the callback

### Pivot criterion

This milestone gates the kernel interface, host adaptation, lifecycle, and Wasm memory stability
only. If those cannot remain separated, narrow the kernel interface before adding engine behavior.
Do not decide whether hosts share a compiled operation representation here; that gate follows
Milestone 4.

## Milestone 3: bounded PCM transport and ownership

### Question

Can native and browser workers supply prepared PCM through one private, host-neutral seam while the
transport remains bounded and the render callback does not wait, grow transport state, or release
final ownership?

### Entry decisions

Before work begins, define one private prepared PCM input seam with:

- stream-level semantic channel layout, sample rate, and source identity
- block-level slot ID, epoch, source-frame start, and valid frame count
- block-level discontinuity and end-of-stream state
- fixed-capacity planar `f32` storage
- fixed ownership, backpressure, starvation, and off-callback retirement rules

Native and browser transport mechanisms may differ. Transport terminates at this seam before a render
operation reads the prepared PCM view.

### Scope

Use deterministic generated PCM without adding a production decoder.

Native path:

- one worker thread feeding the CPAL callback through a fixed slot pool or fixed sample ring

Browser path:

- main-thread bootstrap of a direct `MessageChannel` between a dedicated worker and the worklet
- a fixed pool of recycled transferable `ArrayBuffer` slots
- explicit slot IDs and ownership transitions
- no waiting in `process()`

Both paths:

- adapt prepared block boundaries to actual callback frame counts
- bound admission and pool exhaustion behavior
- reject stale epochs
- zero-fill starvation and record a bounded counter
- return or retire ownership outside the callback

### Required evidence

- deterministic PCM output across varied callback partitions
- fixed pool capacity without transport growth
- valid ownership transitions and rejection of invalid or duplicate transitions
- stale-epoch rejection
- deterministic starvation and pool-exhaustion behavior
- a callback-side Rust allocation probe
- no callback-local collection or typed-array-view construction in project worklet code
- one brief recorded CPAL run and one brief recorded browser run, limited to their exact configurations
- the existing Rust and Bun validation commands remain green

The recorded host runs prove only that the bounded paths execute in those configurations. They do not
require a browser matrix, a fixed duration, representative application load, or sustained-performance
claim.

### Explicit non-goals

- a production decoder
- HTTP ranges or grants
- sample-rate conversion
- seeking beyond stale-epoch rejection
- observations or general command infrastructure
- graph compilation or PCM-input plan integration
- automation or looping
- `SharedArrayBuffer` or Wasm threads
- sustained-load certification or a browser compatibility matrix
- production host-support claims

### Later transport evidence

Milestone 3 does not select the final production browser transport or require cross-origin isolation.
Representative sustained tests belong to a later playback path with realistic decoding, application
load, and lifecycle behavior. If that evidence shows recycled transferable buffers are inadequate,
then evaluate `SharedArrayBuffer`, a narrower browser shared center, or another measured alternative.

## Milestone 4: minimal compiled plan

Gate A and Gate B are implemented. Their native Rust, Wasm, and built-in-browser results are recorded
in the [compiled-plan evidence](./2026-09-06-milestone-4-compiled-plan-evidence.md). The private shared
operation representation is retained within that evidence's limits; same-rate local WAV is next.

### Question

Does a private `CompiledPlan` and single-owner `RenderInstance` provide useful leverage across
offline, native, and browser execution?

### Gate A: oscillator-only compiled program

Compile a private description for:

```text
oscillator A -> gain A ┐
                       mixer -> level observation -> output
oscillator B -> gain B ┘
```

Include:

- validation of topology, ports, layouts, and capacity
- compilation to a fixed enum operation table
- stable processor and parameter identities
- preassigned planar buffers and deterministic operation order
- two independent instances from one immutable plan
- one immediate value event and one linear ramp at exact in-block offsets
- deterministic same-frame ordering for the supported subset
- bounded post-master peak and RMS observations
- a versioned, pointer-free compiled description transferred to the worklet
- worklet-local validation and instance preparation

### Gate A explicit non-goals

- public graph construction
- trait-object plugin extensibility
- graph mutation, live replacement, or state migration
- processor state save and restore
- latency compensation
- cancellation or a public automation language
- PCM-input integration

### Gate A required evidence

- invalid topology, layouts, capacities, and identifiers fail compilation
- the two-tone mix matches an independent direct reference
- peak and RMS observations match rendered output
- output and supported automation are partition-independent
- ramp endpoint semantics have no block-boundary off-by-one ambiguity
- two instances from one plan share no clock or processor state
- repeated rendering grows no buffer or Wasm memory
- the compiled description validates and prepares locally in the worklet

### Gate B: PCM input integration

After Gate A, compile a plan that consumes the host-neutral prepared PCM seam from Milestone 3. Prove
that native and browser transport both terminate at the same seam, epoch rejection remains outside or
inside the same explicitly chosen operation, and the plan does not acquire host transport types.

Gate B is separate so a transport decision cannot hide behind oscillator-only plan evidence.

Implemented on 2026-09-06 as `PCM input -> linked gain -> level observation -> output`. Both native
SPSC blocks and browser fixed slots terminate at `PreparedPcmInput`. It owns epoch rejection before
the input operation reads its prepared planes, including rejection of partially consumed old blocks.
The plan carries stream identity, layout, and rate, with no host transport types. See the
[Gate B evidence](./2026-09-06-milestone-4-compiled-plan-evidence.md#gate-b-pcm-integration).

### Shared operation-representation decision

Only after Gate A and Gate B decide whether offline, native, and browser hosts can use the same
compiled operation representation without host conditions entering the renderer.

- If yes, the initial `CompiledPlan` and `RenderInstance` split is earned.
- If no, narrow the shared center to portable DSP, clocks, event and observation semantics, schemas,
  and conformance fixtures.
- If replacement cannot avoid callback-side final drops, keep one immutable instance per active node
  or stream and defer live replacement.

Decision, 2026-09-06: retain the private `CompiledPlan`/`RenderInstance` split. The same operation
table and executor handle oscillator and prepared-PCM programs in native Rust and unshared Wasm.
Native and browser lifecycle and transport remain outside the renderer. Keep one prepared instance
per active stream; production transport, sustained performance, and live replacement remain unproven.

## Playback validation after the four milestones

Playback proceeds through small, ordered increments:

1. **Same-rate local WAV.** Play, pause, position, bounded buffering, and starvation reporting with a
   source rate matching the active host.
2. **Prepared sample-rate conversion.** Account for chunk adaptation, delay, history, reset, flush,
   and input/output position mapping.
3. **WAV seeking, epochs, and complete playback lifecycle.** Prove stale-buffer rejection, decoder
   repositioning, bounded resampler pre-roll, readiness, honest media/render/presentation snapshots,
   and one coherent load/play/pause/resume/seek/starvation/EOS/close/reload workflow on both paths.
   This is the last planned foundation increment unless it exposes a concrete blocking problem.
4. **Initial thin local-WAV wave-player.** After the lifecycle gate passes, add file selection,
   play/pause, seeking, time/duration, volume, and clear loading/error states. Playback—not UI—owns
   worker coordination, converter state, and epochs. Let this integration establish the smallest
   useful playback interface; do not freeze a generic public session API first.
5. **Local MP3 playback (#17).** Deliver the shared bounded Rust reader, reliable decoded/trimmed
   timeline, native/browser worker integration, picker/recovery and fixture-proven history-restoring
   seeks. This is a playback capability, not another research-only prerequisite.
6. **Product design (#21) and player frontend (#22).** Design proceeds independently of MP3.
   #22 consumes the approved compact player/session-library design and existing WAV, using MP3
   when available. The research player and silent prototype are not substitutes for design approval.
7. **Waveform (#18).** Depends on both MP3 (#17) and the player frontend (#22).
8. **WAV loops (#19), then MP3 loops (#20).** Establish seam/period geometry on WAV before
   adding codec history/trim. No loop behavior is implied by linear MP3 seek reconstruction.
9. **Live visualization (#23).** Follows #22 independently of the waveform/loop chain.

FLAC, HTTP delivery and catalog work are not prerequisites for this sequence.

Implementation status, 2026-09-08: the private same-rate local WAV slice accepts PCM16/24 RIFF PCM
mono/stereo through the existing browser/native transports. Pause acknowledgment freezes consumption
and render time; media position is the next source frame to consume and freezes on starvation.
Empty/malformed files and source/active-host rate or unsupported layout mismatches are rejected; EOS
requires explicit reload, with no resampling, seeking or loops. Automated conformance, browser runtime
and physical macOS output observations complete increment 1 within the
[dated WAV evidence](./2026-09-08-local-wav-playback-evidence.md). Unforced browser starvation remains
observable; this does not establish gap-free sustained playback, production transport or a public
session API.

Implementation status, 2026-09-09: increment 2 adds private prepared 44100 ↔ 48000 Hz conversion,
with same-rate bypass, bounded worker chunk adaptation, delay trimming, ceil-rounded finite output,
reset/history isolation and a floor-rounded source cursor derived from consumed output-rate PCM.
Native/actual-Wasm automated checks and ten-minute physical output in both directions pass.
Browser stress testing exposed starvation; four larger slots and independently bounded 1024-frame
reads improved refill margin without changing ownership. Final-build browser observations pass:
ten-minute same-rate/up-conversion and a one-minute reverse confirmation under recorded load.
See the [conversion contract and evidence](./2026-09-09-prepared-sample-rate-conversion-evidence.md)
for failed intermediate trials, exact configurations and limits. This is not broad sustained-performance
or subjective listening certification. WAV seeking and epochs is the next ordered increment.

Implementation status, 2026-09-10: increment 3 adds source-frame seeks with explicit rational output-grid
coordinates, bounded globally aligned converter pre-roll, epoch readiness, paused slot reclamation,
latest-request cancellation and epoch-tagged snapshots. Both host paths retain one compiled render
instance and its clock. Presentation estimates are explicitly unavailable. The complete lifecycle
fixtures and targeted muted browser observations are recorded in the
[seeking/lifecycle evidence](2026-09-10-wav-seeking-lifecycle-evidence.md), including verification status
and limitations. No physical native output is claimed for this increment.

Implementation status, 2026-09-10: increment 4 (#15) adds the separate `/player.html` local-WAV
player. Private extracted playback internals plus a task-oriented owner provide cancellation,
replacement, serialized/coalesced snapshots and user commands, source-cursor updates, seek/replay
and post-worklet listening gain. React owns presentation and preview/commit interaction only.
Normal seeks preserve play/pause; consumed EOS and the exact endpoint acknowledge suspension, and
seek-back stays paused until explicit Play. Replay seeks zero then plays without replacing the context.
Focused owner/UI tests, the full device-free Rust/Bun gates and targeted muted built-player workflows
pass within the [local-player evidence](2026-09-10-local-wav-player-evidence.md). Independent Standards
and Spec reviews returned zero findings; parent diff inspection and targeted checks also pass. These
observations do not certify broad browser/device or audible behavior.

Implementation status, 2026-09-13: #17 adds the private strict MPEG-1 Layer III reader with
pinned Symphonia 0.6.1 packet decoding, bounded full inspection/counting, validated Xing/Info/LAME
and VBRI policies, and codec reset/decode/discard through the existing converter read anchor.
The same native worker/rings and browser worker/Wasm transport now prepare WAV or MP3; React
remains codec-unaware. Fixture, worker/compiled-callback, memory and muted browser evidence is
recorded in the [dated MP3 document](2026-09-13-mp3-preparation.md). Independent final review and
parent acceptance checks passed; #21/#22 and all waveform/loop/visualization features are unchanged.

`PlaybackSession` remains provisional. This player establishes a private consumer, not the eventual
application migration or another speculative foundation/API layer. “Foundation ready” means this
declared local-file contract works in the tested configurations, not production readiness or a
finished audio platform.

## Progressive HTTP validation

Test the byte source against a deterministic local server before choosing or integrating production
storage. The server simulates:

- valid single-range `206` responses
- ignored `Range` with `200`
- valid and invalid `416`
- rejected `HEAD` with successful ranged `GET`
- weak, strong, and changed validators
- inconsistent `Content-Range` and complete lengths
- delayed, truncated, and oversized responses
- fake expiring grants and refresh without revision or epoch change
- loop-head range reads
- required and missing CORS response headers

After selecting an object store or CDN, run the same suite through the provider on every supported
browser. Production HTTP readiness requires provider evidence; fixture-server success alone is not
sufficient.

## Later product gates

Engine validation does not settle catalog or deployment design. Before dependent product work ships,
require evidence for:

- staged, immutable, idempotent publication of originals and derived revisions
- independent digest and identity for every binary derivation
- playback-grant bearer lifetime, leakage, refresh, and revocation behavior
- exact provider CORS, range, validator, and expiry behavior
- connection-time SSRF validation and independent outbound network controls
- canonical analysis provenance and current-policy access inheritance
- playlist visibility remaining independent from asset authorization

Provider selection, Convex schema, job implementation, grant lifetime, artifact payload split, and
public summary policy remain deferred until those gates become active.

## Plan-wide non-goals

The initial validation sequence does not commit to:

- a workspace or many crates
- a public arbitrary graph interface
- render-thread graph mutation
- live plan replacement or state migration
- processor state serialization
- plugin hosting or plugin ABI
- a storage provider or production catalog schema
- user-created catalogs or public collaborative playlists
- automatic media garbage collection
- musical automation units
- native iOS support
- bit-identical native and browser output
- a nightly Rust default

The plan should be shortened or revised when evidence makes a milestone unnecessary. It should not be
expanded merely to make future features appear accommodated.

## Primary references

- [KKB audio system architecture](./2026-08-28-kkb-audio-system-architecture.md)
- [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [wasm-bindgen AudioWorklet example](https://wasm-bindgen.github.io/wasm-bindgen/examples/wasm-audio-worklet.html)
- [CPAL](https://docs.rs/cpal/latest/cpal/)
- [Rust `GlobalAlloc`](https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html)
- [Rust panic handling](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html)
- [SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)
- [RFC 9110: HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
