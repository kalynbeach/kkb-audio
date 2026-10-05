# KKB audio system architecture

Date: 2026-08-28
Status: Working architecture and decision record

## Purpose

This document is the sole canonical authority for the KKB sound, audio, and music software system's
architecture, terminology, enduring invariants, and decision gates. It consolidates the product
vision, architecture review, primary-source research, and decisions made while discussing the first
implementation.

The system is intended to grow into a modular audio foundation for:

- audio file and progressive HTTP playback
- web and native audio players
- source and processed-signal analysis
- real-time visualizations
- synthesis, including binaural audio and beat applications
- microphone analysis, monitoring, and effects
- live-performance features
- offline processing and export
- a shared, account-backed media catalog

The first product will be a new version of `wave-player`. It will eventually have:

- a web application whose control layer uses TypeScript, Bun tooling, React, and Web Audio, with a
  Rust render engine compiled to WebAssembly
- a native application using Rust and a native UI such as GPUI

The current web frontend uses Next.js 16.3.5 App Router for pages and navigation. Bun separately
bundles the audio runtime into `public/audio-runtime`; Cargo and the pinned wasm-bindgen build
retain the worklet glue audit and fixed-memory contract. React owns route-scoped sessions, and
leaving an audio page closes its resources. See the [frontend migration](2026-09-20-nextjs-frontend.md).

Bun and React remain outside real-time execution. The browser `AudioWorklet` contains only the Wasm
renderer and minimal, hand-audited JavaScript glue.

The immediate target is ordinary single-track playback. The broader design must preserve a credible
path toward synthesis, live input, analysis, visualization, and multiple synchronized sources
without requiring those features in the first implementation.

This document supersedes the historical
[Audio engine and runtime architecture](./2026-07-31-audio-engine-runtime-architecture.md) survey.
That file is retained only as a redirect; Git history preserves its original content. Its earlier
claims are not active guidance.

Supporting foundations:

- [Digital audio from first principles](./2026-08-27-digital-audio-from-first-principles.md)
- [Psychoacoustics for digital audio and audio-engine software](./2026-08-27-psychoacoustics.md)

The [initial render-engine validation plan](./2026-08-29-initial-render-engine-validation-plan.md)
controls implementation order and evidence. It cannot override this architecture.

## Decision language

This document distinguishes three kinds of statements:

- **Decision**: accepted as the current design.
- **Working design**: the recommended implementation shape, subject to validation through the
  focused milestones.
- **Deferred**: intentionally not part of the initial system.

The architecture should change when implementation evidence contradicts it. Public interfaces
should remain narrow until concrete products prove which flexibility they require.

## Architectural position

### One shared render engine, not one universal runtime

**Decision.** The system will share a platform-independent Rust render engine. It will not force
playback, cataloging, analysis jobs, live capture, native devices, and browser lifecycle into one
universal runtime.

The products share audio and time semantics, a compiled processing model, DSP implementations, and
analysis operators. They do not all share one lifecycle, pacing policy, failure policy, or host
implementation.

```text
Clerk identity and sessions          Managed object storage
             │                      originals · delivery · artifacts
             ▼                                  │
Convex catalog and control plane ◄──────────────┘
             │
             ▼
Product modules
PlaybackSession · AnalysisJob · Synthesis · Live processing · Export
             │
             ▼
Shared render engine
Plan compiler · timeline · events · DSP · mixing · observations
             │
             ▼
Host runtimes
Native device/workers · Web AudioWorklet/workers · Offline driver
```

Conceptual modules do not need to become separate crates immediately. A crate or package seam should
exist only when separate use, replacement, testing, or host compilation makes it real.

### Product modules

The first product-facing deep module is `PlaybackSession`. Later product modules may include:

- `AnalysisJob` for complete, durable asset analysis
- synthesis sessions or instruments
- live-input sessions
- offline render or export jobs
- catalog clients and administration tools

These modules should expose task-oriented interfaces. An audio player should not need to construct
nodes and edges to play a track.

### The shared execution module

The common center is a platform-independent render program with two parts:

- an immutable `CompiledPlan` containing topology, operation order, buffer layout, processor
  configuration, channel and sample-rate decisions, latency metadata, and observation locations
- a single-owner mutable `RenderInstance` containing prepared processor state, preallocated buffers,
  the integer render-frame clock, event cursors, and other execution state

Different drivers create and execute render instances from the same compiled model:

- the native device callback drives real-time rendering
- the browser `AudioWorklet` drives real-time rendering
- an offline driver renders without wall-clock pacing

Drivers may use different underrun, cancellation, and completion policies. Sharing a compiled plan
and DSP code does not imply shared mutable state, bit-identical output, or failure-identical output.

## Domain vocabulary

Use these terms consistently.

### Catalog terms

- **Catalog**: an account-backed collection of releases, assets, playlists, metadata, and analysis
  artifacts. The initial production system has one KKB catalog.
- **Release**: a published grouping of media, such as an album, EP, or single. Use `Release`, not
  `Record`, to avoid confusion with database records and captured recordings.
- **Media asset**: the stable logical catalog identity for a finite piece of media.
- **Media revision**: a particular immutable encoded representation or managed derivation of an
  asset.
- **Media locator**: a way to access a revision, such as an object-store key, local path, or external
  URL. A locator is not an identity.
- **Stream endpoint**: an ongoing source that may not represent one finite asset.
- **Delivery rendition**: a managed revision prepared for reliable playback, such as a fast-start
  M4A remux.
- **Analysis artifact**: durable derived information tied to immutable input provenance and an
  analyzer definition.
- **Processor preset revision**: an immutable snapshot of processor identities, versions, ordering,
  and parameter values.

### Audio and time terms

- **Media time**: position in a finite media source.
- **Render time**: position on the engine's continuous integer frame timeline.
- **Presentation time**: the estimated time at which rendered audio becomes audible.
- **Host or device time**: the clock exposed by the current host or output device.
- **Epoch**: a generation identifier that changes when a source seeks, is replaced, or is
  reconfigured. Epochs prevent stale buffered data from crossing a discontinuity.
- **Compiled plan**: an immutable execution description containing validated topology, operation
  order, buffer layout, processor configuration, and static metadata.
- **Render instance**: one driver's mutable, single-owner execution state created from a compiled
  plan. It owns prepared processor state, buffer storage, clocks, and event progress.
- **Observation point**: a named signal location from which bounded live observations or offline
  analysis input may be produced.

## Catalog, identity, and authorization

### Clerk and Convex

**Decision.** Clerk owns users, authentication, and session lifecycle. Convex is the catalog and
control plane.

Clerk responsibilities:

- identity
- authentication
- session lifecycle

Convex responsibilities:

- the KKB catalog
- catalog-scoped role assignments
- authorization decisions
- releases, assets, revisions, locators, and playlists
- import and analysis job state
- analysis artifact metadata
- playback and download grant orchestration

Catalog roles should live in Convex rather than only in Clerk token claims. Catalog authorization can
change independently of identity, and token claims may remain stale until refresh.

The effective initial role is:

```text
No Clerk identity                 → guest
Clerk identity without elevation → guest
KKB catalog VIP membership       → vip
KKB catalog administrator        → admin
```

Anonymous and authenticated guests have the same catalog capabilities initially. Authentication may
support private assignment and personalization later without changing public guest access.

The initial catalog has one administrator. General catalog creation and management by other users is
deferred. Role assignments should still be scoped to the KKB catalog rather than stored as global
user roles.

The web client should use Convex's authenticated state when deciding whether Convex has received and
validated the Clerk identity. UI visibility is not authorization. Every Convex query, mutation,
action, or grant operation must enforce its own access rules.

### Operation-specific media access

**Decision.** Media access is defined separately for browsing, streaming, and downloading. A single
`locked` flag is insufficient.

```text
MediaAccessPolicy {
  browse:   guest | vip | admin | disabled
  stream:   guest | vip | admin | disabled
  download: guest | vip | admin | disabled
}
```

Examples:

```text
Public and playable
  browse: guest
  stream: guest
  download: disabled

Public but playback-locked
  browse: guest
  stream: vip
  download: disabled

VIP-only
  browse: vip
  stream: vip
  download: disabled

Admin source
  browse: admin
  stream: admin
  download: admin
```

Anonymous guests may browse and play guest-streamable media without an account. The server may issue
a short-lived playback grant without a Clerk identity after confirming that the asset permits guest
streaming.

Streaming is the initial user-facing delivery operation. Exact-original downloads are desired but
may be deferred. The working storage design retains originals from the first import so downloads do
not later require re-importing media.

### Releases

**Decision.** Release metadata access and media access are evaluated separately.

A guest may browse a release that contains locked tracks. Every included media asset independently
controls streaming and downloading. Release membership never grants access to an asset.

The initial product may show inaccessible tracks as locked. The server remains responsible for
refusing playback or download grants.

### Playlists

**Decision.** All initial playlists are admin-created. VIP and guest users have no shared-content
write access.

Initial audiences:

```text
Public
MinimumRole(Vip)
AdminOnly
SpecificUsers([clerk_subject, ...])
```

`SpecificUsers` supports admin-created private playlists assigned to one or several authenticated
users. Admin access is implicit.

Playlist visibility never expands asset permissions and never implies that every entry is playable.
The initial product may display inaccessible entries as locked. Playback-grant issuance always checks
the asset's current stream policy, regardless of playlist membership. This invariant remains valid
when a playlist audience or an asset policy changes and avoids transactional revalidation of every
referencing playlist.

Write permissions should remain action-based. Do not encode "VIP can never write" as an intrinsic
property of the role, because future collaborative playlists may grant narrow write capabilities
without granting catalog administration.

## Media identity and revision recognition

### Stable asset identity

**Decision.** Every media asset receives a stable, catalog-owned identifier. The content hash is not
the asset identifier.

The stable asset survives:

- moving or replacing a locator
- adding cloud and local copies
- metadata changes
- creating a delivery rendition
- discovering duplicates
- associating several encodings with one logical asset

### Exact revision identity

**Decision.** Hash the exact encoded source bytes with an algorithm-qualified digest.

**Working choice.** Use SHA-256 initially:

```text
sha256:<digest>
```

Compute the digest incrementally while importing or uploading when practical. The exact-byte digest
answers whether two encoded objects are identical. It does not prove that two different encodings
contain the same recording. HTTP `ETag` values are transport validators, not catalog content hashes.

A changed hash creates a new media revision. An exact duplicate may reuse one stored object while
remaining associated with more than one logical catalog entry when catalog semantics require it.
Every remux, transcode, or other binary derivation has its own exact-byte digest and media revision,
plus an immutable derivation link to its input revision.

### Recording equivalence

**Deferred.** Acoustic fingerprinting may later identify likely equivalent recordings across codecs,
containers, metadata changes, and transcodes.

Fingerprint matches are probabilistic. They should suggest relationships or merges, not silently
replace stable catalog identity.

### Locator identity

A URL is a locator, not an asset or revision identity. Mutable URLs may return different bytes over
time. `ETag`, `Last-Modified`, content length, and the final URL after redirects are useful import
provenance, but the exact managed digest remains authoritative.

## Managed media storage and ingestion

### Managed copies by default

**Decision.** The catalog imports remote media into managed object storage by default. External URL
references remain representable, but unmanaged external playback is not part of the first production
guarantee.

Managed copies provide:

- stable bytes and revision hashes
- controlled CORS
- reliable byte-range behavior
- predictable seeking and loop prebuffering
- reproducible analysis input
- access-controlled playback URLs
- continued availability when upstream URLs change or disappear
- container normalization for progressive delivery

The original URL remains as provenance. Playback and durable source analysis normally use the managed
revision.

External-only references may later support media that cannot or should not be copied. They have
weaker availability, CORS, seeking, revision, and analysis guarantees.

### Storage split

**Working design.** Convex remains the control plane, while a range-capable object store holds large
binary data.

```text
Convex
  catalog metadata
  roles and authorization
  jobs and status
  artifact indexes and provenance
  access-grant orchestration

Object storage and CDN
  imported originals
  delivery renditions
  artwork
  large analysis payloads
```

Convex File Storage may remain useful for artwork, small artifacts, or public files. It is not the
preferred initial delivery path for large protected audio because generated storage URLs are bearer
URLs, while authenticated HTTP action responses have size limits. A provider such as Cloudflare R2,
S3, or an equivalent service should supply expiring signed URLs, byte ranges, CORS control, lifecycle
rules, and reasonable egress.

Provider-specific types must remain inside a storage adapter.

A reasonable initial private object namespace is:

```text
originals/<sha256>
delivery/<derived-revision-sha256>
artifacts/<artifact-id>/<payload-digest>
artwork/<asset-id>/<revision>
```

Content-addressed names do not by themselves guarantee immutability. Importers stage bytes under a
job key, finish hashing and length validation, and only then publish the immutable object and revision
idempotently. Immutable keys cannot be overwritten. Failed or cancelled jobs never publish a media
revision.

One provider and private bucket with logical prefixes is sufficient initially. Separate buckets may
follow when retention, security, or billing differences justify them.

### Playback grants

Permanent playable URLs are not stored as media identity.

```text
ManagedObjectLocator {
  provider
  bucket
  object_key
}

PlaybackGrant {
  media_revision
  signed_url
  expires_at
}
```

The application requests a grant from Convex. Convex resolves the caller's effective role, checks the
asset's current stream policy, and returns a short-lived URL scoped to one immutable object and
operation.

A signed URL is a bearer capability. Anyone who obtains it may use it until expiry, so policy and role
revocation take effect no later than the grant's expiration unless the provider offers a stronger
revocation mechanism. Grant responses are not cached, URLs are excluded from logs and analytics, and
every refresh repeats authorization. Grant lifetime and refresh margin remain measurement-driven.

The media worker performs HTTP reads. The audio render thread and browser `AudioWorklet` never fetch
media. The worker must be able to refresh an expired grant without changing the media revision or
source epoch. Signed URLs must permit repeated range requests and satisfy the exact browser CORS and
range contract validated for the selected provider.

### Original retention

**Working design.** Retain exact imported originals from the beginning when the catalog has
permission to copy them.

Retention supports:

- future original-file downloads
- reproducible analysis
- new delivery formats without generation loss
- recovery when an upstream source disappears
- decoder and parser comparisons
- preservation of original tags and container metadata

If an original already supports progressive delivery, one stored object may serve as both original
and delivery rendition. Do not duplicate identical bytes merely to maintain conceptual roles.

A delivery remux or transcode is a derived revision. It never overwrites the imported original.

Initial deletion should be conservative:

```text
Active → SoftDeleted → PurgeEligible → Purged
```

Physical deletion must account for shared object references, analysis provenance, dependent catalog
entities, and a recovery interval. Automatic garbage collection is deferred.

### Import pipeline

**Working design.** Remote import proceeds through explicit durable job states:

```text
Requested → Fetching → Probing → Storing → PreparingDelivery → Ready
       └──────────────────────────────────────────────────────→ Failed
```

Hashing may occur while fetching. A successful import records:

- submitted URL
- final URL after redirects
- observed `ETag` and `Last-Modified`
- import time and content length
- exact content digest
- codec and container
- duration when known
- channel layout and sample rate
- priming and trailing trim metadata when available
- available seeking information

Server-side remote fetching must defend against SSRF. The importer uses one canonical URL parser,
permits only approved HTTP schemes and ports, rejects ambiguous destinations, resolves and classifies
all IPv4 and IPv6 answers, and connects to a validated address while preserving the validated host
and TLS identity. It repeats the complete validation for every manually followed redirect. Network
policy independently blocks loopback, private, link-local, multicast, unspecified, metadata, and
other internal destinations. The fetcher disables ambient proxies, bounds streamed and decompressed
bytes, time, redirects, and concurrency, supports cancellation, and cleans up staged partial objects.

### Artifact payload storage

**Working design.** Use the same object-storage provider for large analysis payloads, with a separate
logical namespace and access policy. Convex stores searchable facts, artifact status, schema,
provenance, summaries, and object references.

Artifacts default to no more access than their input signal. Derived waveforms, spectra, and musical
features can reveal restricted media. Publishing a safe public summary should be an explicit catalog
action rather than an automatic consequence of analysis.

## Progressive HTTP media

### Scope

**Decision.** Progressive HTTP files are the first network media type. HLS, Icecast-style radio, and
real-time socket audio are separate future source types.

A progressive HTTP media reader combines two conceptual modules:

```text
HttpByteSource
  capabilities
  length
  validators
  read_range

MediaReader
  probe
  decode
  seek
```

The byte source understands:

- `Accept-Ranges`
- `Range`
- `206 Partial Content`
- `Content-Range`
- `If-Range`
- `ETag`
- `Last-Modified`
- `200 OK` when a server ignores a range
- `416 Requested Range Not Satisfiable`

The reader should tolerate servers that reject `HEAD` but accept a small ranged `GET`. Range support
is discovered for arbitrary locators. A managed delivery rendition does not become delivery-ready
until it passes the required range and browser CORS conformance checks.

The browser delivery contract names the allowed application origins and exposes every header the
worker reads, including `Accept-Ranges`, `Content-Range`, `ETag`, and `Content-Length`. It permits the
request headers and methods used by `Range`, `If-Range`, `GET`, and any retained `HEAD` probe. Provider
errors may be hidden by CORS, so grant refresh cannot rely on reading a particular HTTP error body.

A changed strong validator during playback must not splice bytes from two resource versions into one
source epoch. Weak validators are not used with `If-Range`; every `206` response is checked against
the requested interval and known complete length; a `200` response is never appended to partial
state; and truncated or inconsistent bodies fail the read. The reader should fail or reopen against a
newly identified revision.

Progressive HTTP behavior is first tested against a deterministic local fixture server, independent
of Clerk, Convex, an object-store provider, and production signing. The selected provider and target
browsers must later pass the same range, CORS, expiry, refresh, and validator suite before the reader
or grant contract is considered production-ready.

### Initial codecs and containers

**Working design.** The recommended first decode set is:

1. MP3
2. FLAC
3. WAV/PCM

This set is deliberately varied:

- MP3 exercises framed decoding, coarse seek anchors, trim, and discard-to-target behavior.
- FLAC exercises faithful lossless decoding and optional seek metadata.
- WAV provides a simple sample-exact reference for engine and loop verification.

**Next.** Add AAC-LC in M4A/MP4. Managed ingestion should require a progressive-friendly container or
losslessly remux it so required metadata, such as the MP4 `moov` box, is available near the start.
FFmpeg is a suitable ingestion adapter for remuxing. It does not belong in the real-time engine.

Later candidates include Ogg Vorbis, Opus in Ogg or WebM, and ALAC in M4A. Browser codec support and
WebCodecs capabilities vary, so the product must detect host capabilities rather than infer them from
the platform name.

## Source kinds

**Decision.** Files, network media, microphones, and generators do not share one universal source
interface merely because they eventually produce PCM.

### Media readers

Media readers handle encoded finite or progressive media. Their capabilities may include:

- known duration
- exact or approximate decoder seeking
- byte-range access
- codec trim metadata
- end-of-stream
- recoverable starvation

They run outside the real-time thread and feed timestamped, epoch-tagged PCM into a host-neutral,
prepared engine input seam. The seam defines layout, sample rate, valid frame count, source-frame
coordinates, epoch, discontinuity, end-of-stream, starvation, and bounded ownership or retirement.
Native and browser transports may differ, but transport terminates before the render operation reads
this prepared view. The validation plan proves this seam before decoding and gives its compiled-plan
integration a separate acceptance gate.

### Live inputs

Microphones and line inputs are driven by a capture clock. They cannot seek and may drift relative to
the output clock. Monitoring may require adaptive resampling, latency control, permissions, feedback
protection, and device-route handling.

The first microphone slice is live analysis. Visualization follows from the same observation stream.
Monitoring and effects come later because they add capture-to-output clock and latency constraints.

### Generators

Oscillators and binaural generators execute directly on the render timeline. They do not require a
decoder queue. They accept sample-timed parameter events and may render indefinitely.

### Network streams

Progressive HTTP files behave like media readers. Continuous radio, HLS live streams, and real-time
sockets require different timeline, reconnection, buffering, and revision policies. They remain
separate future adapters.

## Render engine

### Internal graph and public interface

**Decision.** The engine is graph-shaped internally from the beginning. Public arbitrary graph
construction is deferred.

Visualization branches, source crossfades, mixing, synthesis, and future sends require fan-out or
fan-in. A strictly linear implementation would eventually accumulate special cases or require a
replacement.

The initial graph remains closed and small:

- source input port
- generator
- gain
- basic processor
- mixer
- observation point
- output port

A player calls a narrow `PlaybackSession` interface. The session constructs the internal plan.
Callers do not initially receive `add_node`, `connect`, or render-thread mutation interfaces.

### Editable description, compiled plan, and render instance

**Working design.** Graph editing and plan compilation happen off the render thread. Render-instance
allocation and processor preparation happen before the instance becomes active and never during an
active render callback.

The compiler:

- validates ports, layouts, and acyclic topology
- rejects zero-delay cycles
- assigns stable processor and parameter identities
- determines a stable execution order
- determines buffer layout and required capacity
- inserts explicit channel mapping and mixing operations
- records processor configuration, latency, and tail metadata
- emits an immutable `CompiledPlan`

Preparation creates a mutable `RenderInstance` from that plan. It allocates and pre-touches buffer
storage, constructs and prepares processors and resamplers, and initializes clocks and event state.
The render thread owns that instance and executes its linear prepared operation sequence rather than
recursively traversing a mutable object graph.

Native hosts prepare instances off-thread. A browser host with an unshared worklet-local Wasm heap may
instantiate and prepare its local instance during `AudioWorkletProcessor` construction. That work is
bounded, occurs before the node is connected or activated, and ends with an explicit ready or failed
handshake. Heavy compilation remains in a worker.

Live topology replacement remains unvalidated. If introduced, a host prepares a replacement before
activation and publishes it at a safe render boundary. Old instances are reclaimed off-thread so a
final reference drop cannot deallocate in the callback. State migration and processor state
serialization remain deferred.

### Internal audio representation

**Decision.** The render engine uses one canonical internal representation rather than supporting
both planar and interleaved layouts in every processor.

Initial target:

- planar `f32` PCM
- mono and stereo semantic channel layouts
- a known engine sample rate chosen from the active output context
- variable frame counts up to a prepared maximum
- checked `u64` render-frame arithmetic owned by each `RenderInstance`

Faithful decoding is required. Bit-perfect device output is not an initial goal. When a 44.1 kHz
source plays through a 48 kHz device or browser context, resampling is expected. The system should
avoid unnecessary conversion and preserve source metadata.

The initial source-rate focus is 44.1 kHz and 48 kHz. The engine rate is negotiated per active host
rather than globally fixed for every session.

### Variable render sizes

**Decision.** The core never assumes that callbacks always contain 128, 256, or 512 frames. Each
`RenderInstance` is the sole authority for its next render frame; callers do not supply an independent
clock value.

Conceptual render contract:

```text
render(inputs, outputs, events) -> RenderStatus
```

Frame count derives from the borrowed output channel planes, whose lengths must agree. It may vary
between calls up to the prepared maximum. Nodes that require fixed FFT, convolution, or resampling
chunks use preallocated local buffering and report added latency.

Zero frames are a strict no-op. A malformed layout, checked clock overflow, or request beyond prepared
capacity zero-fills every supplied output sample, returns a fixed non-allocating status, and does not
advance the render clock or DSP state. Exceeding capacity makes that prepared instance terminal; the
host replaces it outside the callback rather than repeatedly retrying it.

Web Audio 1.1 chooses a render quantum for an `AudioContext` and keeps it constant for that context's
lifetime. Browser code reads the actual channel-array length instead of hard-coding 128. The portable
core still accepts variable partitions because CPAL callbacks and offline drivers have different
contracts.

### Initial prepared kernel

**Decision.** The first implementation is one concrete offline path:

```text
mono sine oscillator -> linked scalar gain -> mono or semantic L/R planar output
```

The oscillator starts at phase zero on a positive-going crossing, emits the current phase, then
advances and wraps an `f64` phase accumulator. Stereo output duplicates the same generated sample
identically into distinct left and right planes. Preparation rejects a non-positive or non-finite
sample rate, non-finite gain or frequency, and frequencies outside `0 <= frequency < sample_rate / 2`
for this proof.

The kernel renders directly into borrowed output planes. It does not require a graph, queue, public
processor trait, internal heap buffer, or synthetic heap ownership for drop testing. Same-build
partition comparisons may require bit-exact samples because they execute the same recurrence in the
same order. Analytic references and comparisons across targets, toolchains, or math implementations
use an explicit tolerance and do not imply bit identity.

This contract governs the first milestone only. The focused validation plan defines its evidence and
explicit exclusions.

### Real-time discipline

**Decision.** The render callback never:

- allocates or grows collections
- deallocates through a final object drop
- waits for locks or blocking atomics
- performs file, network, device-control, or logging I/O
- formats strings
- initializes dependencies lazily
- panics or unwinds across the host callback
- performs unbounded work

Permitted work is bounded arithmetic over prepared buffers, bounded event consumption, lock-free or
wait-free access to prepared queues, and updates to real-time-safe counters.

Expected invalid input and capacity conditions return fixed statuses rather than panicking.
`catch_unwind` is not a real-time-safety mechanism: panic hooks and panic-payload ownership can perform
unbounded work or require callback-side retirement, and aborting Wasm panics cannot be caught by an
ordinary host boundary.

Allocator instrumentation supplies bounded empirical evidence only. A measured render path can show
no observed allocator, reallocator, or deallocator calls; it cannot prove the absence of host or
JavaScript allocation, page faults, system calls, locks, or deadline misses.

Decoding, streaming, graph compilation, allocation, logging, artifact persistence, and device
reconfiguration occur outside the callback.

### Clock and event model

**Decision.** The engine timeline uses integer frames. Floating-point seconds are accepted at product
interfaces and converted immediately using an explicit sample rate and rounding policy.

The system distinguishes:

- media time
- render frames
- presentation estimates
- host or device time
- source epochs

Lookahead makes events available before their deadline. It does not itself provide sample accuracy.
The executor applies timestamped events at exact in-block frame offsets.

Initial automation inputs:

- integer frames
- seconds represented with sufficient precision

Musical units such as beats, measures, and tempo-relative positions are deferred.

### Automation

**Decision.** The engine supports generic sample-timed automation. A full user automation editor or
scripting language is not part of the first implementation.

Initial event actions should include:

- immediate value changes
- linear ramps
- cancellation or replacement by stable identity

Every parameter has:

- a stable processor and parameter address
- a declared valid range
- a default value
- sample-rate or block-rate evaluation semantics

Every event identifies its timeline:

- **Media-time automation** follows seeks and repeats with loops.
- **Render-time automation** continues independently across seeks and loops.

The initial engine internally schedules render-frame events. `PlaybackSession` maps media-time events
into render frames.

The event queue is bounded. Ordering for events at the same frame must be deterministic. Late events,
overflow, cancellation, and removed processor targets require explicit error or coalescing policies
before the public automation interface is finalized.

Browser application code must schedule ahead into the `AudioWorklet`. Main-thread timers do not drive
sample-accurate audio directly.

### Processor lifecycle

**Working design.** First-party processors use plugin-like lifecycle semantics without committing to
third-party plugin hosting:

```text
prepare
process
reset
reported latency
reported tail
parameter description
sample-timed parameter events
```

Most useful DSP is stateful. The goal is deterministic state transition with explicit lifecycle and
bounded work, not mathematical purity.

Third-party VST, Audio Unit, CLAP, or custom plugin hosting is deferred. Plugin hosting introduces
ABI, crash isolation, dynamic latency, state serialization, parameter discovery, and cross-platform
compatibility concerns.

### Latency and tails

**Working design.** Processors and adapters report algorithmic latency in engine frames and tail
behavior. The plan compiler must eventually account for cumulative path latency at mix points.

Full plugin delay compensation is deferred, but the initial processor contract should not prevent it.
Live-input adapters separately report capture, buffering, resampling, and output latency where known.

### Denormals and invalid values

**Working design.** Real-time render threads should enable the platform's appropriate flush-to-zero
and denormals-are-zero behavior. Processors should prevent unstable state and the engine should count
non-finite output without formatting or logging in the callback.

## Playback session

### Responsibility

**Decision.** `PlaybackSession` is the first deep product module. It coordinates:

- catalog or direct media references
- media-reader lifecycle
- decoding and buffering
- source epochs
- output preparation
- internal render-plan construction
- play, pause, seek, loop, and position semantics
- automation mapping
- observations for player UI and visualization
- host interruption and failure events

The engine does not know about releases, playlists, Clerk, Convex, or catalog roles.

### Current private browser consumer

The [initial local-WAV player](2026-09-10-local-wav-player-evidence.md) at `/player.html` exercises a
narrow subset of this responsibility. `web/src/prepared-playback.ts` retains the existing private
worker/worklet lifecycle, epochs and readiness used by both proof and player. `playback-owner.ts`
owns file replacement/cancellation, command/snapshot ordering, consumed-source state, periodic UI
updates and listening gain. React owns interaction and presentation, never worker messages or epochs.
The owner uses a post-worklet GainNode (initial 0.15 after compiled gain 0.5); volume changes preserve
the context and cursor. EOS/endpoint acknowledges pause; replay is explicit seek-zero plus play.
This is not a published `PlaybackSession` interface, a new transport or a general command framework.

### Conceptual interface

The exact Rust interface remains open, but the product contract should remain close to:

```text
load(media_reference)
play()
pause()
seek(media_time)
set_loop(optional media interval)
schedule(automation events)
set_output(output selection or host default)
subscribe(playback and observation events)
close()
```

This is an application-facing shape, not a commitment to these exact method names or one mutable
object model.

### Transport ownership

Transport is split into three concepts:

- **Render timeline**: engine-owned sample position and events.
- **Playback control**: session-owned play, pause, seek, loop, rate, and source transitions.
- **Player policy**: application-owned queue, playlist, shuffle, and repeat behavior.

A seek cannot remain mere UI state. It coordinates decoder position, buffered PCM, resampler history,
processor state, events, observations, and audible-position estimates.

### Seek contract

**Decision.** Logical seeks target frames on a declared decoded-and-trimmed media PCM timeline. They
do not promise recovery of an encoder's original input samples. Coarse codec seeking must not silently
move the requested audible position.

A reader reports the realized capability and result:

```text
Exact
AnchorAndDiscard
Adjusted(actual_media_frame)
```

`AnchorAndDiscard` seeks to an earlier decoder anchor, decodes forward, and discards through the
requested frame. Exactness depends on the codec, container, trim metadata, decoder version, byte
source, and resampler history. When exact recovery is unavailable, the session reports the adjusted
position rather than weakening the promise silently.

A seek creates a new source epoch. Stale queued PCM and observations from the prior epoch are ignored.
The session reports completion only after the new epoch is prepared according to the eventual
readiness contract.

### Loop contract

**Decision (#19/#20, parent-approved 2026-09-14; implementation accepted for stacked PR publication).** Local WAV/MP3 loops use half-open logical intervals:

```text
[loop_start, loop_end)
```

Events at `loop_start` repeat. Events exactly at `loop_end` are outside the active loop. The working
priority is to preserve this nominal loop period and report any seam transformation explicitly.

Both codecs use **held-head seam smoothing**, not a moving-head crossfade. Let the requested source
boundaries be A/B at rate Rs and realized converted boundaries be a=ceil(A·Ro/Rs), b=ceil(B·Ro/Rs).
Repeat the fixed globally aligned converted slice [a,b), P=b−a output frames. With
F=min(floor(Ro/200),floor(P/4)), require P≥8 and F≥2; otherwise reject looping without changing
linear playback or the last accepted region. No zero-crossing adjustment moves either boundary.
For j=0…F−1, replace only tail sample x[b−F+j] with
(1−j/(F−1))·x[b−F+j] + (j/(F−1))·x[a], independently per channel. The final tail value is exactly
x[a]. The first head sample is reused as a held contribution; the last outgoing sample has zero
weight. All P timeline frames remain, the head is replayed unmodified at wrap, and no other span is
skipped or duplicated. Convex weights preserve DC within f32 rounding and avoid intentional gain
overshoot, but change slopes and can distort periodic signals. This is not universal click-free or
listening acceptance. An ordinary overlap cannot preserve every sample at unit rate, the period,
and one authoritative coordinate together; this deliberately transforms the tail instead.

The preserved period is the **realized output-grid period**, not exact requested source duration.
Each conversion period differs from (B−A)·Ro/Rs by less than one output frame; repeated fixed-grid
quantization accumulates over iterations, without a bounded cumulative-drift promise. The converter
does not synthesize new fractional phases or alternate period lengths. Same-rate bypass remains
exact before the stated seam. Display requested source boundaries/duration and realized output
boundaries/period separately, including the floor-mapped realized start cursor. Exact fields accept
fractional seconds or explicit integer source frames, so a legal short region remains inspectable.

Prepare at most 4096 head frames (possibly the entire short region), using the incumbent converter's
preceding globally aligned FFT chunk and at most two input chunks of reconstruction pre-roll. The
head is worker-owned, separate from four 1024-frame transport slots. Cached-head continuation uses
an exact output-frame seek, never a lossy PCM→source→PCM round trip. Head preparation must also
progress when consuming a converter chunk exposes EOF drain output without another input push. Longer regions are streamed;
no unbounded full-track PCM cache or extra waveform analysis is introduced. References independently
convert uninterrupted source from zero, crop the realized interval, apply the formula and repeat it.
Same-build exactness is not native-to-Wasm bit identity or a new converter quality guarantee.

The session still prepares the loop head before activation, keeps render time continuous while media
time wraps, and reports the media discontinuity and transformation provenance. Any seam processing
occurs on decoded and resampled source PCM before shared downstream processors. Those processors
preserve state across the wrap. Decoder and source-side seek state reset or re-prime as necessary.
Generators continue on render time unless explicitly bound to media time.

At the nominal wrap frame, media-time automation begins the new loop iteration. Render-time
automation continues unchanged. Applications use explicit ramps when parameter continuity matters.

Loop readiness is explicit:

```text
Disabled → Preparing → Armed → Active
                    └────────→ Failed
```

The player must not claim Armed until both the prepared head and the initial four-slot supply are
acknowledged. Preparing is not effective looping. Armed is ready but paused; Active is consuming an
enabled loop. Normal wraps are worker/prepared-input behavior, never UI polling, EOS replay, public
seek, or render-instance replacement. Initial head-not-ready is Preparing, not LoopUnderrun.

| Control | Acknowledged behavior |
| --- | --- |
| Load/replacement | Whole track, Disabled; editor disclosure may stay open. |
| Disabled edit/reset | Store only a valid region, no engine reposition or autoplay. |
| Enable | Capture the exact next media PCM cursor at the renderer/control boundary, after any normal wrap. Inside [a,b), preserve it; outside choose a. Preserve pause; EOS becomes paused. |
| Disable | Preserve that exact acknowledged PCM cursor and resume ordinary source preparation there, not after finishing an iteration. |
| Enabled edit | Test inclusion at acknowledgment, not the stale UI snapshot. Preserve exact PCM; if excluded, disable without relocating. Report the effective enabled state, including an edit that became outside while playing. |
| Explicit user seek | Existing nearest-source/ceil-output rule; inside retains enable, outside including B disables. |
| Pause/resume | Freeze/resume current media and render clocks; keep readiness and downstream state. |
| Disabled EOS/replay | EOS remains ended; explicit replay returns to zero. An enabled normal loop does not consume EOS. |
| Preparing changes/close | One executing worker job plus one replaceable latest request; identity/epoch covers begin, captured PCM, head and finish. Superseded completions cannot arm old work. Close/replacement cancels ownership through the incumbent lifecycle. |

A private loop-change begin/finish acknowledgment captures exact output PCM **and prior EOS**; it is
not a public seek with a stale source cursor. Enabling after acknowledgment-time EOS pauses before
new PCM can become consumable. Browser preparation waits for main-thread context-suspension
acknowledgment before head/supply/finish, including across superseded begins. Native acknowledgment
uses a bounded pause-command update without overwriting a newer explicit transport command.
Native seeks and disabled region edits use acknowledged effective enable or latest pending intent,
never mere presence of requested bounds. A seek submitted before callback acknowledgment retains a
pending disable, enable or region edit, then applies the inside/outside rule to those bounds.
A seek retaining pending enable also retains its acknowledgment-time EOS pause, while the explicit
seek target remains authoritative. Repeated seeks before acknowledgment preserve that pause intent.
Owner requests waiting for a status poll still retain latest loop
intent/revision; superseding preparation discards obsolete pending work. Explicit control changes may prepare silence while preserving render time;
that is distinct from normal wrap behavior. Invalid/unsupported/too-short requests are rejected with
feedback, retaining the previous accepted region and playback. Media I/O, decoder or worker/runtime
corruption remains a terminal playback failure **and loop Failed**. Recovery after teardown is an
explicit track retry/reload, never a loop checkbox pretending to revive a dead worker. There is no
additional invented loop-local recoverable error category.

If an armed loop still underruns:

1. latch `Failed` / `LoopUnderrun` once, hold the authoritative media cursor and retain the last rendered source-side value v per channel
2. emit F fade-out frames v·(F−1−j)/F for j=0…F−1, then silence; the render clock continues, with no callback wait
3. reject obsolete supply under a fresh source epoch and request exact output-grid a through the bounded recovery handshake, not public seek
4. re-prime head plus initial supply; readiness cannot truncate the fade-out, and silence remains until both it and preparation are complete
5. restart at a with F fade-in frames x·(j+1)/F; preserve downstream state, count the failed interval's added render frames and discarded remaining media PCM separately

This lengthens the failed loop iteration. It does not block the callback or play unrelated media past
the boundary. Stricter policies may be required when several synchronized sources are active.

Normal wraps increment a loop iteration when its first head frame is consumed, not the control
epoch. Through the seam the authoritative coordinate is still the outgoing tail position; bounded
contribution accounting identifies that tail and the held head at a from the incoming iteration,
under the same source identity/control epoch. A block can contain multiple wraps; its first PCM
coordinate plus the region maps every frame, with fixed callback first/final iteration and seam-frame
counts rather than an unbounded contribution list. Render-frame processing/automation is continuous;
media-time boundary semantics remain as above without adding a public event system.

Explicit changes/recovery clear obsolete source observations and #23 visual history. Normal wraps
leave the private pre-volume analyser continuous. Its samples remain untagged approximate browser
history, not a canonical provenance API or speaker clock. The original full-track waveform retains
its identity and amplitude. Long creative crossfades remain separate future scope;
no general transition/session framework is introduced by #19.

#### Private MP3 loop history (#20)

The source coordinate is #17's pinned-decoder validated decoded-and-trimmed timeline,
not recovered encoder input. Ordinary seeks retain reset/decode/discard and truthful
`AnchorAndDiscard` even at equal rates. Normal loop continuation instead uses one
source-owner-local encoded recipe, acquired **before Armed**. Initial acquisition and
head/start reconstruction may decode linearly with cancellation and a30-second rejection
budget; no O(target) acquisition is initiated by an active normal wrap.

For the packet containing the converter's earlier source read anchor plus validated delay,
retain its unchanged predecessor, up to511 preceding main-data bytes, exact raw/byte/source
coordinates and genuine unread-reservoir bookkeeping. Reset the unmodified Symphonia0.6.1
decoder, feed an internal same-rate/channel zero-side-information carrier containing that
suffix, then decode the original predecessor. Discard both outputs. Packet0 needs no warm-up;
packet1 needs only original packet0. At most two discarded decodes plus the ordinary next
source packet precede raw readiness; converter pre-roll remains separate. Carrier bytes are
never source PCM, waveform input, media-time contributions, metadata or validation evidence.

This horizon is source-derived: MPEG-1 reservoir references are9bits (511bytes), hybrid overlap
is replaced by each granule, and synthesis retains16 steps. After correct compressed history,
the predecessor's second granule provides18 correct synthesis steps. Packet-local scalefactors
and overwritten spectral scratch add no older dependency. No guessed preroll, incomplete-history
concealment, state cloning, decoder fork or general seek index is used. Original CRC and genuine
reservoir checks remain mandatory before original packets decode. Artificial carrier padding
cannot legitimize missing source history; decode/I/O failures remain terminal track failures.

One completed anchor and at most one transient replacement belong to the active reader.
Each owns fixed1045-byte predecessor and511-byte history arrays (1556 encoded payload bytes).
The replacement's rolling buffer is511bytes; carrier scratch is at most1044bytes; at most one
additional owned packet-input copy is1045bytes. The conservative additional encoded payload
ceiling is **5712bytes**, excluding existing host cache/read buffers, decoder working/output
buffers and scalar/container/allocator overhead. There is still only one active reader/decoder,
4096 converted head frames, four1024-frame slots and fixed16MiB Wasm memory. All allocation,
replacement and destruction remain off-callback. Superseding preparation cancels pending
acquisition before install/publication. Same-owner/same-target completed recipes may be reused
under a verified new request; replacement/close never transfers an anchor across sources.

See [dated evidence and limitations](2026-09-14-mp3-loops.md) for the corrected CRC/VBRI research
coverage, actual worker/callback references, measured normal wraps and pending human listening.

### Underrun and failure policy

**Working design.** Distinguish:

- source starvation
- loop underrun
- command or automation overflow
- observation loss
- decoder failure
- device deadline miss
- device loss
- HTTP revision change
- browser suspension

Real-time source starvation zero-fills the missing span, advances render time, and reports a
counter/event. It never waits for data. Recording and offline jobs may use stricter stop or retry
policies.

### Device handoff

**Deferred implementation, preserved contract.** Device handoff means route or output configuration
changes during a session, such as headphones connecting, a USB device disappearing, or an operating
system default changing.

The host runtime should eventually quiesce, reopen or reconfigure output, renegotiate rate and layout,
rebuild prepared adapters, preserve logical playback position, and report any discontinuity. Moving a
session between computers is a different distributed product feature above the audio runtime.

## Analysis and visualization

### Two execution paths

**Decision.** Analysis has shared signal-processing operators but two distinct product paths.

#### Live observations

Live observations support:

- level meters
- spectrum displays
- waveforms
- live microphone analysis
- low-latency visualizations

They are bounded, timestamped, and potentially lossy. The callback may compute a small summary inline
or copy into a preallocated queue. Consumers never retain render-owned buffers.

Every observation states:

- its render-frame interval
- zero or more contributing source coordinates, each with source identity, epoch, and media range
- observation location
- sequence number
- whether prior observations were dropped

A source-local observation normally has one coordinate. A generator-only observation may have none.
A post-mix observation or loop seam may have several because several source positions or epochs
contribute to one rendered interval. The contribution description must remain bounded and may use an
explicit aggregate marker when full provenance would exceed its fixed capacity.

Named locations may include:

- original decoded source
- post-resample source
- post-source processing
- pre-master
- post-master
- post-sink conversion

No software observation proves exactly what reached a listener's ears. Device underruns, operating
system processing, hardware volume, and acoustic playback remain downstream.

#### Analysis jobs

Durable musical analysis uses jobs that may:

- read the complete source
- seek and make multiple passes
- access future and past context
- run expensive models or algorithms
- aggregate streaming features
- produce whole-track facts
- produce timestamped events
- identify structural sections
- persist versioned results

Initial durable artifacts primarily describe original source media. The artifact model treats source
and processed signals equally so future processor analysis requires no separate storage architecture.

### Analysis provenance

**Decision.** Artifact identity derives from immutable input provenance rather than a `source` versus
`processed` boolean.

Conceptual source input:

```text
AssetSignal {
  media_revision
  decode_configuration
  channel_selection
  analyzed_range
}
```

Conceptual processed input:

```text
ProcessedSignal {
  source_revision
  processor_preset_revision
  render_configuration
  observation_location
  rendered_range
}
```

An artifact records:

- analyzer identity and version
- analyzer parameters
- result schema version
- immutable input provenance
- time coordinate and range
- status and creation metadata
- searchable summaries
- payload object reference when needed

A practical cache or identity key derives from a domain-separated, algorithm-qualified digest over a
canonical encoding of:

```text
analyzer identity and version
+ canonical parameters
+ complete input provenance
+ result schema version
```

Complete provenance includes the exact media-revision digest, decoded sample semantics, relevant
decoder or processor implementations and versions, trim, channel mapping, sample rate, analyzed
range, and every ordered source or immutable render-recipe input that can affect the result. Large
payloads have their own digest and length.

Artifacts are immutable. Reanalysis creates a new artifact. A separate catalog reference may identify
the preferred current result.

A mutable saved preset never identifies processed input. Artifacts refer to an immutable processor
preset revision. A future multi-source or routing system may generalize this to a `RenderRecipeRevision`.

### Artifact access

Artifacts default to no more access than their input signal. Processed artifacts use the intersection
of all source and preset access requirements. Access is derived from current input policies rather
than copied once at creation, so later restriction cannot leave an artifact exposed. Explicit
publication creates a distinct reviewed public summary rather than changing the restricted payload's
policy.

### Source and rendered analysis

Both are supported:

- source analysis describes the original media revision independent of playback state
- rendered analysis describes a named signal location after a specific processing configuration

The same streaming FFT, loudness, onset, pitch, or chroma front ends may be reused in live and offline
contexts. Whole-track inference and persistence remain job-level responsibilities.

## Synthesis and synchronized sources

### Generators

Generators are first-class render nodes. The initial prepared kernel uses a minimal oscillator to
validate frame progression and partition independence without involving a decoder. Sample-timed
automation follows in the compiled-plan milestone.

This supports future:

- binaural tones and beats
- test signals
- modulation sources
- generated layers under media
- synthesis applications

### Synchronized sources

**Deferred product feature, preserved engine capability.** Several sources are synchronized when they
share one render timeline and begin at declared frame offsets or phase relationships.

Potential uses include:

- generated tones aligned with spoken or musical media
- modulation changes aligned to source sections
- several generated oscillators with defined phase
- a click or cue track aligned to playback
- multiple stems or dry/wet paths

The engine timeline and plan must not prevent this. Specialized multi-source UI, drift policy, and
session semantics are deferred.

## Native and web hosts

### Shared behavior

**Decision.** Native and web applications are the same KKB product in different environments. They
should share behavioral contracts for:

- play, pause, seek, and loop
- media and render time
- automation
- graph processing
- observation schemas
- catalog identity
- artifact schemas
- error categories

They are not initially guaranteed to produce bit-identical samples or identical latency and recovery
under every host condition.

### Shared Rust code

The strongest shared unit is the prepared render engine and portable DSP. Host-specific concerns
remain outside it.

Shared where practical:

- time and event types
- graph description and compiler
- compiled-plan and render-instance execution
- channel mapping and mixing
- portable DSP and generators
- observation operators
- reset and tail semantics

Host-specific:

- device and `AudioContext` creation
- native workers versus browser workers
- decoder and demuxer selection
- HTTP implementation and CORS
- AudioWorklet registration and Wasm initialization
- file access and permissions
- autoplay, suspension, and route changes
- access-grant refresh
- plugin loading

### Browser execution

The browser architecture is:

```text
React and application control
            │
            ▼
Dedicated worker
HTTP ranges · demux · decode · buffering · grant refresh
            │
            ▼
AudioWorklet
Wasm render engine · events · DSP · observations
            │
            ▼
Web Audio output
```

WebCodecs decoding does not occur inside the `AudioWorklet`. Browser codec support must be detected
per configuration at runtime, and WebCodecs does not supply container demuxing. A Rust decoder such as
Symphonia may run in a worker when its target and feature set are validated.

A dedicated worker and `AudioWorklet` use separate Wasm instances and heaps by default. The worker
sends a versioned, pointer-free compiled description; the worklet validates it and prepares local
state. Explicitly shared `WebAssembly.Memory` is a different design that requires Wasm atomics and
shared-memory deployment.

The main thread bootstraps a direct `MessageChannel` between the media worker and worklet. The first
PCM transport experiment uses a fixed pool of recycled transferable buffers with explicit ownership,
epoch, backpressure, starvation, and retirement states. Its initial gate establishes bounded
correctness and lifecycle behavior, not sustained production viability. Representative sustained
tests wait for a playback path with realistic decoding, application load, and lifecycle behavior.

`SharedArrayBuffer` and threads are a measured fallback, not a prerequisite or a decision required by
the initial transport proof. They require secure cross-origin isolation and affect every embedded
resource, authentication flow, and deployment header. If later playback evidence shows transferable
transport is inadequate, evaluate shared memory or narrow the browser shared center to portable DSP,
clocks, schemas, and conformance fixtures rather than forcing the complete Rust executor into the
browser.

### Native execution

The native runtime uses host device adapters such as CPAL and native workers for media reading. The
first native target is macOS, with Windows a possible later target. iOS currently refers to the web
application running on iOS rather than a separate native GPUI application.

## Offline execution

**Decision.** Real-time and offline execution reuse the compiled processing model and DSP code when
semantically appropriate. They do not promise identical failure behavior.

Offline execution may allocate outside processor calls, block for input, report progress, support
cancellation, render tails, and run faster than wall time. It should not inherit real-time data-loss
policies.

Deterministic offline output requires explicit configuration:

- fixed sample rate and channel layout
- stable operation and summation order
- seeded randomness
- immutable inputs
- fixed event timeline
- processor and decoder versions
- explicit tail flushing
- no live or wall-clock-dependent sources

Same-machine repeatability is a realistic initial goal. Cross-CPU or native-to-Wasm bit identity is a
separate, stronger goal and is deferred.

## Rust toolchain policy

**Decision.** Stable Rust 1.98 is the initial reproducible baseline. The package uses Rust 2024, pins
the selected toolchain for implementation and CI, and records a compatible `rust-version` policy.

Nightly remains an intentional future option, not the default. It may be adopted when a concrete
feature requires it, such as a deliberate Wasm threads and shared-memory build. Adoption requires a
separate compatibility decision covering the exact target features, standard-library build, panic
strategy, wasm-bindgen version, browsers, and deployment requirements.

## Dependencies and implementation candidates

Dependency choices remain subject to prototypes and pinned-version audits.

### CPAL

Role: native output and capture adapter.

CPAL does not define the shared render engine. Callback frame counts must be read from the actual
buffer and treated as variable. Browser support is worth evaluating separately rather than assuming
it makes the native runtime portable unchanged.

### Symphonia

Role: pure-Rust demuxing and decoding candidate; the private local-MP3 slice now pins
Symphonia 0.6.1 with MP3-only features. Its strict incremental inspector feeds the packet decoder,
not the tolerant demuxer, and reconstructs seek history by reset/decode/discard. WAV retains its
existing private PCM parser. See [MP3 policies/evidence](2026-09-13-mp3-preparation.md); other
codec/container roles below remain future candidates, not current support.

Enable only required format and codec features. Keep all parsing, decoding, I/O, construction, and
allocation outside the render thread. Validate browser worker compilation and performance for the
exact pinned version.

The first target set is MP3, FLAC, and WAV/PCM. AAC-LC and ISO/MP4 follow. Opus support may require a
separate implementation depending on current Symphonia support.

### Rubato

Role: prepared sample-rate conversion candidate.

Construct and allocate resamplers outside the render thread. Use preallocated processing methods and
account for chunk adaptation and output delay. Live capture and output on independent clocks may
later require asynchronous ratio adjustment rather than only fixed conversion.

### FunDSP

Role: possible source of DSP building blocks and implementation ideas.

Do not expose dependency-specific graph or node types through the product interface before auditing
real-time behavior, allocation, Wasm support, and enabled features.

### Rodio

Role: comparison point or rapid playback prototype.

Rodio overlaps with the proposed high-level playback runtime. It is not expected to sit beneath a
custom shared render engine alongside CPAL and Symphonia.

### FFmpeg

Role: optional native ingestion, remux, broad decode, encode, or export adapter.

FFmpeg is not part of the portable real-time core. Distribution must account for the exact build's
LGPL, GPL, nonfree, codec, and relinking obligations.

### Clap

Role: individual CLI applications.

Clap does not belong in the engine.

## Validation sequence and decision gates

**Decision.** The [initial render-engine validation plan](./2026-08-29-initial-render-engine-validation-plan.md)
contains the sole governing initial implementation sequence. Milestone 1 is only the concrete offline
prepared kernel defined above. It excludes automation, mixing, observations, decoding, resampling,
queues, graph compilation, and host adapters.

The first four milestones answer separate architecture questions:

1. whether the concrete oscillator-and-gain kernel is partition-independent and allocation-prepared
2. whether that same kernel interface works offline, in an `AudioWorklet`, and through CPAL
3. whether native and browser workers can supply bounded PCM through the host-neutral input seam
4. whether a private compiled plan earns its place through static fan-in, observations, and
   sample-timed automation

Milestone 2 gates the kernel interface, host adaptation, lifecycle, and Wasm memory stability only.
It cannot decide whether hosts share a prepared operation representation because that representation
does not exist until Milestone 4.

After Milestone 4, decide whether the same compiled operation representation remains useful across
offline, native, and browser hosts. If it does not, narrow the shared center rather than adding host
conditions to the renderer. PCM-input integration with a compiled plan has its own acceptance gate;
it does not need to be part of the first oscillator-only plan proof.

**Validation decision, 2026-09-06.** Gates A and B support retaining the private `CompiledPlan` and
`RenderInstance` split for the next playback increment. The same operation table and executor run
oscillator and prepared-PCM programs in native Rust and unshared Wasm. Native and browser transports
both end at `PreparedPcmInput`, which owns epoch rejection and block retirement before the PCM
operation reads its planes. The [Milestone 4 evidence](./2026-09-06-milestone-4-compiled-plan-evidence.md)
does not establish a production browser transport, sustained deadline performance, public graph API,
or live instance replacement. Keep one prepared instance per active stream.

Local playback then proceeds incrementally through same-rate WAV, prepared sample-rate conversion,
source epochs and seeking, compressed-format trim fixtures, and WAV loop fixtures. Progressive HTTP
uses the deterministic fixture server before production storage. Catalog, managed import,
authentication, grants, durable analysis, and microphone work follow the applicable engine and media
evidence.

Before production catalog and media delivery are considered ready, evidence must cover:

- immutable, staged, idempotent publication of original and derived revisions
- independent identity and digest for every derived binary revision
- bearer-grant expiration, refresh, leakage, and revocation semantics
- exact provider and browser CORS, range, validator, and expiry behavior
- connection-time SSRF enforcement plus independent outbound network policy
- canonical artifact provenance, payload identity, and current-policy access inheritance
- playlist visibility remaining independent from current asset authorization

Provider selection, exact Convex schemas, grant lifetime, and job implementation remain deferred until
their corresponding evidence is available.

## Explicitly deferred

- a public arbitrary graph-building interface
- render-thread graph mutation
- live plan replacement and processor state migration
- processor state save and restore
- third-party plugin hosting
- a full DAW or Ableton replacement
- general buses and sends without a product workflow
- HLS, Icecast, and real-time socket sources
- creative crossfade controls beyond seam smoothing
- public user-authored playlists
- general user-created catalogs
- VIP write access
- original-file downloads in the first UI
- acoustic fingerprint matching
- automatic media garbage collection
- musical automation units such as beats and measures
- native iOS application support
- bit-identical native and web rendering
- distributed handoff between computers

## Open decisions

The following questions remain intentionally unresolved:

- Which object-storage provider best satisfies range, signed URL, CORS, lifecycle, and egress needs?
- What exact Convex schema and job implementation should back imports and analysis?
- What playback-grant lifetime and refresh strategy works across long sessions and later seeks?
- What exact processor and parameter interface best supports static Rust dispatch, dynamic plans, and
  Wasm?
- What are the initial maximum callback frames, channel count, graph size, event capacity, and
  observation capacity?
- What precise rounding rule converts seconds to media or render frames?
- How should simultaneous events at one frame be ordered?
- Which automation events may be coalesced or dropped when their queue is full?
- What listening evidence supports the chosen WAV held-head smoothing on representative music,
  beyond the declared fixed-grid geometry and numerical fixtures?
- What latency target is required for microphone monitoring and live effects?
- When should processed-signal provenance generalize from a preset revision to a complete render
  recipe revision?
- Which analysis facts and timelines belong directly in Convex versus object payloads?
- Which summaries may be published more broadly than their source artifacts?
- What canonical provenance encoding and digest domain should artifact identities use?
- When should downloads, public user playlists, additional catalogs, and collaborative writes enter
  product scope?

## Corrections to the historical survey

The following canonical refinements explain why the 2026-07-31 survey is superseded:

- The common center is a render engine and execution contract, not one universal host runtime.
- Adapters may have small interfaces but substantial implementations. They are not assumed to be
  thin.
- PCM alone is not a sufficient source contract. Time, epochs, layout, end-of-stream, discontinuity,
  trim, ownership, and failure semantics matter.
- The render core accepts variable frame counts rather than assuming fixed 128 to 512 frame blocks.
- DSP processors are often stateful. Explicit lifecycle and bounded deterministic state transitions
  matter more than purity.
- Boundary resampling is the default for playback, not an absolute rule. Creative resampling and
  asynchronous live-clock correction may occur elsewhere.
- A pre-sink observation does not prove exactly what a listener hears.
- Live observations and durable musical analysis are distinct product paths that may share analysis
  operators.
- The same graph and DSP code do not guarantee identical real-time and offline outcomes without a
  determinism contract.
- A lock-free SPSC queue is a mechanism for one producer and consumer, not a complete concurrency or
  failure policy.
- Lookahead makes sample-timed events available. It does not create sample accuracy without an event
  timeline and in-block application.
- Public graph construction is deferred, while an internal compiled DAG is retained from the start.

## Research references

### Audio execution and real-time behavior

- [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)
- [AudioWorkletProcessor `process()`](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process)
- [JACK process callback contract](https://jackaudio.org/api/group__ClientCallbacks.html)
- [JACK latency API](https://jackaudio.org/api/group__LatencyFunctions.html)
- [CPAL documentation](https://docs.rs/cpal/latest/cpal/)
- [JUCE `AudioProcessor`](https://docs.juce.com/master/classjuce_1_1AudioProcessor.html)
- [JUCE `AudioProcessorGraph` implementation](https://github.com/juce-framework/JUCE/blob/master/modules/juce_audio_processors/processors/juce_AudioProcessorGraph.cpp)
- [Rubato documentation](https://docs.rs/rubato/latest/rubato/)
- [`rtrb` bounded SPSC ring buffer](https://docs.rs/rtrb/latest/rtrb/)

### Web and Wasm

- [WebCodecs specification](https://www.w3.org/TR/webcodecs/)
- [wasm-bindgen AudioWorklet example](https://wasm-bindgen.github.io/wasm-bindgen/examples/wasm-audio-worklet.html)
- [SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)
- [Web Audio render-size explainer](https://github.com/WebAudio/web-audio-api/blob/main/explainer/user-selectable-render-size.md)

### Media and HTTP

- [RFC 9110: HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [WHATWG Fetch](https://fetch.spec.whatwg.org/)
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [MDN audio codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs)
- [MDN media container guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Symphonia](https://github.com/pdeljanov/Symphonia)
- [FFmpeg legal guidance](https://ffmpeg.org/legal.html)

### Catalog, authentication, and storage

- [Convex with Clerk](https://docs.convex.dev/auth/clerk)
- [Clerk's Convex integration](https://clerk.com/docs/guides/development/integrations/databases/convex)
- [Convex file storage](https://docs.convex.dev/file-storage/overview)
- [Convex file serving](https://docs.convex.dev/file-storage/serve-files)
- [Convex actions](https://docs.convex.dev/functions/actions)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
