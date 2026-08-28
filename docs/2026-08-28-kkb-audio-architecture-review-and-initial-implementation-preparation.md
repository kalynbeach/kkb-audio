# KKB audio architecture review and initial implementation preparation

Date: 2026-08-28
Status: Working review and implementation preparation

## Purpose

This document reviews [KKB audio system architecture](./2026-08-28-kkb-audio-system-architecture.md)
and records the recommended path into the first implementation phase.

It is not a replacement architecture. It identifies which decisions should remain, which contracts
need more work, and which prototypes should produce evidence before the system grows. The architecture
should be updated when those prototypes confirm or contradict the current working design.

The immediate recommendation is:

1. preserve the shared render-engine model
2. revise the browser preparation rule
3. prove the smallest render kernel offline
4. test that same kernel in an `AudioWorklet` and through CPAL
5. prove bounded PCM ownership across worker and render seams
6. add the first compiled plan only after those host constraints are understood

Catalog, storage, authentication, analysis, microphone input, and broad playback features should not
block this work.

## Review method

The review combined:

- a complete reading of the current architecture and supporting documents
- inspection of the repository and its Git state
- an independent deep-module and seam review
- an independent repository-readiness and sequencing review
- a skeptical real-time, Rust, Wasm, and `AudioWorklet` feasibility review
- a follow-up challenge that reconciled offline-first testing with the need to test the browser early

The review uses the following terms:

- **Module**: something with an interface and an implementation.
- **Interface**: everything a caller must know, including ordering, lifecycle, errors, performance,
  and invariants.
- **Seam**: the location where a module's interface lives.
- **Adapter**: a concrete implementation used at a seam.
- **Depth**: how much useful behavior a module hides behind a small interface.
- **Locality**: how well change and verification remain concentrated in one place.

## Current repository state

The repository is still a Cargo skeleton:

- `Cargo.toml` declares one edition-2024 package with no dependencies.
- `src/main.rs` prints `Hello, world!`.
- There is no library target, audio implementation, test fixture, or host adapter.
- `cargo test` passes with zero tests.
- strict `cargo clippy` passes because there is no substantive implementation.
- the Wasm compilation target is not installed.
- `main` has no commits.
- all existing project files are staged additions.

There are no compatibility constraints or existing interfaces to preserve. The first code should
therefore test the architecture rather than prematurely formalize it.

The dated 2026-08-28 architecture records the earlier working design imported from the previous
`rust-audio` project. It is not yet authoritative. This review is the newer planning record and
identifies changes to apply before implementation as the design is validated. The older
[Audio engine and runtime architecture](./2026-07-31-audio-engine-runtime-architecture.md) remains a
useful survey, but its fixed-block, thin-adapter, and stronger observation-equivalence language has
been superseded.

## Overall assessment

The architecture is directionally strong. Its best decision is to share a platform-independent Rust
render engine rather than force playback, cataloging, analysis, device handling, browser lifecycle,
and offline work into one universal runtime.

The document is not yet an implementation-ready blueprint. Several important interfaces describe
responsibilities without defining ownership, lifecycle, or failure behavior. The current vertical
slices also postpone the browser risks most likely to change the shared-renderer design.

The next phase should produce executable evidence. It should not add another broad interface or begin
with cloud infrastructure.

## Decisions to keep

### One shared render engine, not one universal runtime

Keep the shared center limited to portable audio and time semantics:

- compiled render programs
- mutable prepared execution state
- integer frame clocks and events
- channel mapping and mixing
- portable DSP and generators
- bounded observations
- reset, latency, and tail semantics where they are earned

Host lifecycle, device handling, worker topology, decoding choices, browser suspension, HTTP, grant
refresh, and platform permissions should remain outside the render engine.

This is the highest-value seam in the design. Native, web, and offline drivers can reuse audio
behavior without pretending they share pacing or failure policies.

### `CompiledPlan` and `RenderInstance`

Keep the conceptual split between:

- an immutable `CompiledPlan` containing validated topology, operation order, buffer assignments,
  processor configuration, layouts, and static metadata
- a single-owner mutable `RenderInstance` containing prepared processor state, buffers, clocks, and
  event progress

This shape fits Rust ownership and real-time execution. It also allows several instances to use one
plan without sharing mutable audio state.

The first prototype should not assume that live plan replacement, state migration, or a general
processor representation has already been solved.

### A deep `PlaybackSession`

Keep `PlaybackSession` task-oriented. Player applications should request load, play, pause, seek, and
loop behavior. They should not construct nodes and edges.

The module passes the deletion test. Without it, decoder control, buffering, source epochs,
resampling, seek completion, position reporting, and failure recovery would spread across every
player.

Its responsibilities are justified, but its interface still needs a behavioral contract before the
native and web implementations can conform to it.

### A private graph

Keep the engine graph-shaped internally while deferring public graph construction. Mixing,
fan-in, fan-out, observations, synthesis, and crossfades eventually require graph behavior. That does
not justify exposing arbitrary graph editing to products.

The first implementation may use a fixed operation sequence. The graph compiler becomes earned when
the minimal fan-in milestone requires it.

### Canonical audio and time semantics

Keep these decisions:

- planar `f32` PCM
- mono and stereo semantic layouts initially
- host-negotiated engine sample rate for real-time sessions
- explicit offline sample rate and layout
- variable render frame counts up to prepared capacity
- integer render-frame clocks
- explicit media, render, presentation, and host time
- source epochs at discontinuities
- exact in-block event application

These choices provide a credible shared contract without promising bit-identical native and Wasm
output.

### Strict real-time behavior

Keep the prohibition on active render-callback allocation, final drops, locks, I/O, logging, string
formatting, lazy initialization, panic propagation, and unbounded work.

A lock-free queue is not enough. Ownership and reclamation must also be designed so consuming a queue
item cannot release its final allocation on the callback.

### Distinct source kinds

Keep finite media readers, live inputs, generators, and continuous network streams separate. They may
all produce PCM, but they do not share seek, duration, clock, drift, starvation, or reconnection
semantics.

### Live observations and durable analysis jobs

Keep these as distinct product paths that share signal-processing operators when useful:

- live observations are bounded, timestamped, and lossy
- analysis jobs may make several passes, persist results, and use complete-track context

Keep immutable provenance for durable artifacts. Also keep the qualification that no software
observation proves exactly what reached a listener after operating-system and hardware processing.

### Catalog identity and access distinctions

Keep the distinctions among:

- stable media asset identity
- immutable encoded or derived revisions
- locators
- delivery renditions
- browse, stream, and download authorization
- immutable analysis provenance

These decisions are coherent. They should remain outside render-engine types and should not delay the
first engine experiments.

## Architecture issues to resolve

### Browser preparation and separate Wasm heaps

**Severity: high.**

The current architecture says graph compilation, allocation, and processor preparation happen off
the render thread. In a browser, the dedicated worker and `AudioWorklet` normally own separate Wasm
instances and heaps. A worker cannot prepare a mutable Rust `RenderInstance` and transfer that object
to the worklet without shared Wasm memory.

Revise the rule now:

> Graph editing and plan compilation happen off the render thread. Render-instance allocation and
> processor preparation happen before the instance becomes active and never during an active render
> callback. Native hosts prepare instances off-thread. A browser host may prepare its local instance
> during `AudioWorkletProcessor` construction. Browser topology replacement remains unvalidated.

The browser spike should determine how a compiled description reaches the worklet and how future
replacement works. It should not determine whether allocation is acceptable inside `process()`.
Allocation and lazy preparation inside active callbacks remain forbidden.

### PCM ownership at the worker-to-render seam

**Severity: high.**

The architecture says readers feed timestamped, epoch-tagged PCM into the engine, but it does not
define the bounded packet and ownership protocol. Passing `Vec`, `Box`, `Arc`, owned event payloads,
or transferable buffers through a queue can still allocate or deallocate on the render path.

The first transport proof should establish:

- fixed PCM slots or a fixed sample ring
- fixed-size command and metadata records
- epoch and source-frame coordinates
- channel layout and sample-rate metadata
- discontinuity and end-of-stream status
- explicit free-slot or retirement flow back to the producer
- bounded backpressure and starvation behavior
- no last-reference drops in the callback
- explicit off-thread retirement of old plans and instances

The native and browser adapters may use different transport mechanisms while preserving the same
engine-input semantics.

### `PlaybackSession` lifecycle and command results

**Severity: high before playback work.**

The current conceptual methods look synchronous even though loading, seeking, output changes, and
closure require asynchronous work. Before compressed playback, define a compact state and command
contract covering:

- load readiness
- whether `play` before readiness queues, rejects, or changes desired state
- pause semantics
- whether render time advances while paused
- request identity and completion
- command supersession and cancellation
- seek readiness
- terminal and recoverable failures
- close behavior
- position snapshots across media, render, and estimated presentation time

This should remain a behavioral contract rather than a large public Rust interface. Native and web
fixtures should exercise the same observable outcomes.

### Output ownership

**Severity: high before device handoff or output selection.**

The architecture currently gives drivers responsibility for creating and executing render instances,
while `PlaybackSession` owns output preparation and exposes output selection. The host runtime also
owns device reconfiguration and handoff.

Choose one ownership direction. The recommended shape is:

- the host driver owns the device or `AudioContext`, callback, and active `RenderInstance`
- the session publishes prepared commands or replacement descriptions
- the driver reports timing, deadline, device, and presentation information to the session
- a narrow host factory or driver adapter handles output selection

Do not finalize device handoff until basic playback has proved this direction.

### Automation ordering and bounded queues

**Severity: high before automation becomes public.**

Immediate values and linear ramps appear in the first documented slice, but simultaneous-event
ordering, late events, overflow, cancellation, and removed targets remain open.

The first automation proof should use a temporary internal policy:

- integer-frame events only
- prevalidated ordering
- stable parameter identity
- deterministic same-frame tie-breaking
- malformed input rejected during preparation
- no queue or seconds conversion in the offline test

Queue policy, cancellation, and seconds-to-frame rounding can be chosen later with host evidence.
Public automation should remain provisional until then.

### Loop overlap semantics

**Severity: high before loop implementation.**

The architecture promises exact logical boundaries and a click-free equal-power seam, but the
crossfade causes loop tail and head coordinates to contribute to the same rendered interval.

Define:

- where the overlap sits relative to the nominal loop boundary
- whether the overlap changes the apparent loop period
- minimum loop length
- fade-length clamping for short loops
- the authoritative UI media position during overlap
- observation provenance during overlap
- whether source-local automation evaluates separately for the head contribution
- whether and when loop iteration changes the source epoch

WAV fixtures should settle these semantics before compressed looping.

### Seek capability

**Severity: medium before compressed-media seeking.**

Exact logical targeting is a good goal, but codec, container, trim metadata, decoder behavior, and
resampler history determine what can be recovered.

A reader should eventually report a capability or result such as:

```text
Exact
AnchorAndDiscard
Adjusted(actual_position)
```

The system must not silently pretend an approximate position is exact. Managed delivery renditions
may later provide stronger seeking or looping guarantees for formats that cannot.

### Browser transport without shared memory

**Severity: high.**

The current browser diagram does not define MessagePort wiring, transferable-buffer recycling,
capacity, backpressure, epoch flushing, or reverse observation delivery.

The first prototype should test message and transferable-buffer transport without requiring
`SharedArrayBuffer`. If sustained measurement shows unstable allocation or missed deadlines, require
shared Wasm memory and cross-origin isolation.

If the product cannot accept that deployment requirement, reconsider whether the full Rust renderer
should drive web playback. Sharing DSP, time semantics, and conformance fixtures may be a more honest
center than sharing the entire executor.

### Vertical-slice sequencing

**Severity: high.**

The current slices have several dependency and scope problems:

- the first render slice combines too many independent claims
- native playback combines CPAL, three formats, transport, resampling, seek, loops, and failures
- progressive HTTP includes managed storage and grant refresh before catalog integration provides
  imports and grants
- web feasibility is tested only after substantial native and HTTP work
- sample-rate conversion is required by native playback but is not validated earlier

Replace the initial sequence with the four milestones below. Retain the later slices as product areas,
not indivisible implementation units.

## Choices that should remain deferred

Do not require these in the initial interfaces:

- processor state save and restore
- live plan replacement
- processor state migration
- trait-object plugin extensibility
- public graph construction
- render-thread graph mutation
- general buses and sends
- plugin hosting
- full delay compensation
- arbitrary multi-source product behavior
- device handoff implementation
- a workspace or many crates
- a storage-provider choice
- a final Convex schema
- numeric capacities not supported by measurements
- `SharedArrayBuffer` unless the transport test requires it

Processor state serialization is especially premature. Keep `prepare`, `process`, `reset`, parameter
descriptions, and measured latency or tail behavior only when an initial processor needs them.

Playlist visibility should remain independent from asset authorization unless the catalog defines how
playlist validity is rechecked after roles or asset policies change. Playback grants must always
enforce the current asset policy.

## Recommended first four milestones

### Milestone 1: offline prepared kernel

#### Question

Can a small, portable, allocation-prepared kernel render deterministic planar audio correctly across
arbitrary callback partitions?

#### Scope

Implement one direct path:

```text
oscillator -> gain -> planar output
```

Include:

- mono and stereo `f32`
- explicit sample rate
- integer render clock
- variable frame counts, including 0, 1, 17, 64, 128, 257, and prepared maximum
- fixed prepared buffers
- over-capacity zero-fill and a reconfiguration result
- allocator and drop probes around `render`

Exclude:

- automation
- mixer
- decoder
- resampler
- queue
- graph compiler
- host adapter
- external dependencies unless instrumentation requires one

The implementation should begin as a library target in the existing crate. Do not create a workspace
or multiple crates yet.

#### Required evidence

- Rendering the same 1,000 frames as one block, one-frame blocks, and irregular blocks produces the
  same samples and final clock.
- Mono and stereo fixtures are correct.
- Zero frames are a no-op.
- Over-capacity output is silence and does not expose stale samples.
- `render` does not allocate, grow storage, or destroy owned heap values after preparation.
- `cargo test` and strict `cargo clippy` pass.

#### Claims validated on success

- planar mono and stereo are workable for the initial processors
- oscillator and gain behavior do not depend on block partitioning
- a single-owner mutable render state works offline
- integer render clocks work for this kernel
- same-machine deterministic fixtures are practical
- these processor calls can run without Rust allocation or destruction after preparation

#### Not validated

- device deadlines
- native or Wasm portability
- graph compilation
- queue ownership
- automation
- source-rate conversion

### Milestone 2: dual-host oscillator proof

#### Question

Can the same Rust render interface execute in an `AudioWorklet`, through CPAL, and offline without
host branches entering the kernel?

#### Scope

Use the exact Milestone 1 kernel. Test hosts in this order:

1. Wasm in an `AudioWorklet`
2. macOS CPAL

For the browser:

- compile the minimum Rust target to Wasm
- instantiate and prepare fixed memory before active `process()` callbacks
- map planar engine output to Web Audio channel arrays
- audit generated glue used on the worklet
- verify that Wasm memory does not grow during processing

For CPAL:

- negotiate the device rate and layout
- pass actual callback frame counts into the variable-size kernel
- record observed callback sizes and deadline counters

Keep the plan static. Do not add decoding, worker PCM, graph compilation, or live replacement.

#### Required evidence

- the same core render interface works offline, in the worklet, and in CPAL
- no host conditionals enter the core processing path
- Web Audio channel mapping is correct
- CPAL callback sizes are accepted without a fixed-block assumption
- Wasm memory remains stable after preparation
- the active render callback does not allocate or lazily initialize Rust state

#### Claims validated on success

- the portable kernel works in native and browser hosts
- host creation and lifecycle can remain outside the renderer
- initial worklet-local preparation before activation is feasible
- variable host frame counts fit the prepared kernel

#### Not validated

- worker-to-worklet PCM transport
- dynamic plan replacement
- decoding
- sustained performance under application load
- media seeking or looping

#### Pivot criterion

If native and browser hosts cannot execute the same prepared operation representation without host
concerns entering the renderer, reduce the shared center to portable DSP, clocks, event semantics,
and conformance fixtures. Do not force a false shared executor.

### Milestone 3: bounded PCM transport and ownership proof

#### Question

Can native and browser workers feed predecoded audio to the render callback without unbounded work,
callback-side ownership release, or unreliable browser transport?

#### Scope

Feed known, predecoded WAV PCM into the kernel. Do not add a real decoder yet.

Implement equivalent adapters:

- native worker thread to CPAL callback
- browser dedicated worker to `AudioWorklet`

Use:

- fixed PCM slots or a fixed sample ring
- fixed-size, non-dropping metadata
- explicit slot recycling or retirement
- bounded command and observation paths
- zero-fill starvation and a counter
- one bounded level observation returned to the consumer
- epoch tags sufficient to flush stale PCM
- message or transferable-buffer transport before shared memory

#### Proposed sustained gate

Test 48 kHz stereo for 30 minutes on target Chrome and Safari environments.

Measure:

- transport-induced underruns after startup
- Wasm memory growth after warmup
- callback-side buffer destruction
- render-time distribution under representative browser load
- command, observation, and PCM queue saturation behavior

A proposed performance target is render p99.99 below half of a 128-frame quantum budget. This is a
prototype threshold, not a permanent product requirement.

#### Claims validated on success

- the worker/render seam has a concrete bounded ownership protocol
- PCM consumption does not free worker-owned allocations in the callback
- backpressure, starvation, and observation loss remain bounded
- native and browser adapters can provide the same engine-input semantics
- non-shared-memory browser transport is viable for the tested environment, or measurement has shown
  that it is not

#### Not validated

- decoder correctness
- HTTP ranges
- seek epochs beyond stale-buffer rejection
- automation
- compiled fan-in
- loops

#### Decision gate

If transferable-buffer transport misses deadlines, causes unstable worklet allocation, or fails the
sustained test, require `SharedArrayBuffer` and cross-origin isolation.

Before this milestone closes, decide whether that deployment requirement is acceptable. If it is not,
revise the web execution model before adding more engine behavior.

### Milestone 4: minimal compiled plan, automation, and fan-in

#### Question

Is the proposed `CompiledPlan` and `RenderInstance` split useful across all three execution
environments?

#### Scope

Implement a private graph description for:

```text
oscillator A -> gain A ┐
                       mixer -> level observation -> output
oscillator B -> gain B ┘
```

Add:

- compilation to a fixed enum operation table
- validated topology and layouts
- preassigned buffers
- deterministic operation order
- two independent instances from one immutable plan
- one immediate parameter event
- one linear ramp at exact in-block offsets
- deterministic same-frame ordering for the supported subset
- bounded post-master peak and RMS observation
- browser transfer of a compiled description followed by worklet-local instance preparation

Execute the same representation offline and through the existing native and browser adapters.

Exclude:

- public graph methods
- arbitrary processors
- trait-object plugin interfaces
- graph mutation
- latency compensation
- state migration
- cancellation and a full public automation language

#### Required evidence

- invalid topology and layouts fail compilation
- a two-tone mix matches a direct reference sum
- peak and RMS observations match the rendered output
- output and automation are independent of callback partitioning
- ramp endpoint semantics are asserted without off-by-one ambiguity
- two instances from one plan do not share clocks or processor state
- repeated rendering does not grow buffers
- the compiled description can be prepared locally in the worklet

#### Claims validated on success

- a private graph can compile to a bounded linear render program
- static fan-in and observation points work
- sample-timed immediate values and ramps are independent of block partitioning
- the same compiled representation drives offline, native, and browser execution
- browser-local instance preparation from a compiled description is feasible
- the initial `CompiledPlan` and `RenderInstance` split is earned

#### Not validated

- live plan replacement
- state migration
- general processor dispatch
- compressed-media timing
- `PlaybackSession`

#### Pivot criterion

If instance replacement cannot avoid callback-side drops, defer live plan replacement. Use immutable
plans for the lifetime of an active session or recreate the host node or stream.

## Playback implementation after the four proofs

Split native and web playback into smaller evidence-producing increments.

### 1. Same-rate local WAV playback

Add:

- local PCM WAV input
- play and pause
- position reporting
- bounded buffering
- starvation zero-fill and reporting

Constrain the first fixture to a source rate matching the active host rate. This isolates the media
reader and transport from resampling.

### 2. Prepared sample-rate conversion

Add a prepared resampler and account for:

- input and output chunk adaptation
- algorithmic latency
- resampler history
- flush behavior
- partition-independent position mapping

Do this before claiming that a 44.1 kHz source can seek or loop correctly through a 48 kHz host.

### 3. WAV seeking and source epochs

Prove:

- decoder repositioning
- stale-buffer rejection
- resampler reset or pre-roll
- seek completion readiness
- media, render, and presentation position snapshots

This is the first point where the minimal `PlaybackSession` state machine becomes necessary.

### 4. MP3 playback and trim fixtures

Use checked-in, license-safe fixtures with known decoded PCM truth. Test codec delay, trailing padding,
coarse seek anchors, decode-forward behavior, and the seek capability result.

### 5. FLAC playback and seek fixtures

Test lossless reference output, seek metadata where present, and behavior without optional seek
metadata.

### 6. Seek precision reporting

Expose exact, anchor-and-discard, or adjusted results. Do not weaken exactness silently when the
decoder lacks sufficient information.

### 7. WAV loops

Settle the loop-overlap contract with sample-readable fixtures before compressed media complicates the
result.

Test:

- half-open boundaries
- short loops
- fade clamping
- head preparation
- media-time automation at the wrap
- dual-coordinate observations
- underrun recovery

### 8. Compressed loops

Add MP3 and FLAC loops only after decoder timing and trim fixtures pass. If a format cannot meet the
required loop precision, use capability reporting or a managed seekable rendition.

## Progressive HTTP after local playback

Test HTTP reader behavior independently of the catalog using a deterministic local server.

The fixture server should simulate:

- `206 Partial Content`
- a server that ignores `Range` and returns `200`
- `416 Requested Range Not Satisfiable`
- rejected `HEAD` with successful ranged `GET`
- strong validator changes
- delayed responses
- truncated responses
- expiring fake playback grants
- refresh without changing media revision or source epoch
- loop-head range fetches

This separates byte-source behavior from Clerk, Convex, object-store choice, and production signing.
Actual managed storage and grant orchestration should follow only after the reader contract is stable.

## Product work that follows engine evidence

After local and progressive playback behavior is stable:

1. choose the object-storage provider
2. implement managed import and exact hashing
3. implement delivery renditions when required
4. add Convex catalog records and job state
5. add Clerk authentication and catalog-scoped roles
6. enforce browse, stream, and download operations independently
7. issue and refresh short-lived playback grants
8. add release and playlist behavior
9. add durable analysis artifacts
10. add microphone analysis before monitoring and effects

Do not let catalog types enter the shared render engine or PCM transport protocol.

## Decision gates

### Shared executor gate

After the dual-host oscillator proof, decide whether native and browser can share the prepared
operation representation. If not, narrow the shared center rather than adding host conditions to the
renderer.

### Browser transport gate

After sustained predecoded PCM playback, decide whether transferable-buffer transport is sufficient
or whether `SharedArrayBuffer` and cross-origin isolation are required.

### Plan replacement gate

After the compiled-plan proof, decide whether live plan replacement can avoid callback-side
deallocation on each host. Defer replacement if it cannot.

### Playback interface gate

Do not freeze `PlaybackSession` until local WAV playback, seek epochs, and at least one browser path
pass the same behavior fixtures.

### Seek and loop gate

Let decoder evidence determine exactness. If compressed formats cannot recover the requested PCM
position reliably, report the limitation or create a managed rendition with stronger guarantees.

## Implementation-preparation checklist

Before beginning Milestone 1:

- review and accept the four-milestone order
- update the architecture's preparation wording
- mark browser topology replacement as unvalidated
- split the documented vertical slices into smaller milestones
- decide the minimum supported browsers for the compatibility and transport proofs
- decide whether cross-origin isolation is an acceptable fallback, even though the first prototype
  should not require it
- add a library target to the existing crate when implementation begins
- define the smallest fixture licensing and storage policy
- choose test-only allocation and drop instrumentation
- avoid a workspace, public graph interface, or dependency framework until evidence requires one

## Recommended architecture-document changes

When the working architecture is revised, make these focused changes:

1. Replace the absolute off-render-thread preparation rule with the inactive-instance rule recorded
   above.
2. Add a bounded PCM packet and ownership contract.
3. Clarify host-driver, output, and active-instance ownership.
4. Record that the `PlaybackSession` state and command-result contract must precede compressed
   playback.
5. Define the initial internal automation ordering policy when Milestone 4 provides evidence.
6. Defer processor state serialization.
7. Clarify loop overlap, short-loop, coordinate, and epoch behavior after WAV fixtures.
8. Reorder the initial slices around the four milestones.
9. Separate deterministic HTTP fixtures from production catalog and object storage.
10. Record each prototype result, including rejected assumptions and pivot decisions.

## Residual risks

Even after the first four milestones:

- browser scheduling and message behavior may differ on Safari and iOS
- CPAL behavior on macOS will not prove Windows behavior
- Rust allocation instrumentation will not detect JavaScript allocation in generated glue
- floating-point fixtures will not prove cross-CPU or native-to-Wasm bit identity
- decoder timing and trim behavior may change across dependency versions
- callback timing in a prototype will not prove hard real-time safety under every system load
- measured capacities will remain host and product decisions rather than universal constants

These risks are acceptable if the project keeps its interfaces narrow and records what each milestone
actually proves.

## Recommended immediate action

The next implementation planning session should scope Milestone 1 only. It should select the smallest
Rust types and fixtures needed to prove partition-independent oscillator and gain rendering without
committing to the later graph, playback, catalog, or host interfaces.
