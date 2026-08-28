# KKB audio system architecture

Date: 2026-08-28
Status: Working architecture and decision record

## Purpose

This document records the current architecture for the KKB sound, audio, and music software system.
It consolidates the product vision, architecture review, primary-source research, and decisions made
while discussing the first implementation.

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

- a web application using WebAssembly, TypeScript, Bun, React, and Web Audio
- a native application using Rust and a native UI such as GPUI

The immediate target is ordinary single-track playback. The broader design must preserve a credible
path toward synthesis, live input, analysis, visualization, and multiple synchronized sources
without requiring those features in the first implementation.

This document refines [Audio engine and runtime architecture](./2026-07-31-audio-engine-runtime-architecture.md).
That earlier document remains useful as a survey of audio-engine concerns. This document narrows
several claims, adds missing contracts and failure policies, and separates the full product system
from the shared render engine.

Supporting foundations:

- [Digital audio from first principles](./2026-08-27-digital-audio-from-first-principles.md)
- [Psychoacoustics for digital audio and audio-engine software](./2026-08-27-psychoacoustics.md)

## Decision language

This document distinguishes three kinds of statements:

- **Decision**: accepted as the current design.
- **Working design**: the recommended implementation shape, subject to validation through the first
  vertical slices.
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

Playlist visibility never expands asset permissions. The simplest initial policy is to reject a
playlist configuration whose audience could access entries that its media policies forbid. A later
product may instead display inaccessible entries as locked.

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
contain the same recording.

A changed hash creates a new media revision. An exact duplicate may reuse one stored object while
remaining associated with more than one logical catalog entry when catalog semantics require it.

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
delivery/<revision-id>/<rendition>
artifacts/<artifact-id>/<payload>
artwork/<asset-id>/<revision>
```

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
asset's stream policy, and returns a short-lived URL.

The media worker performs HTTP reads. The audio render thread and browser `AudioWorklet` never fetch
media. The worker must be able to refresh an expired grant without changing the media revision or
source epoch. Signed URLs must permit repeated range requests and expose the required CORS and range
headers.

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

Server-side remote fetching must defend against SSRF. The importer should restrict schemes, reject
localhost and private or link-local addresses, revalidate DNS and every redirect, bound sizes and
time, limit redirects, allow cancellation, and clean up partial objects.

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
is a discovered capability, not a catalog promise.

A changed strong validator during playback must not splice bytes from two resource versions into one
source epoch. The reader should fail or reopen against a newly identified revision.

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

They run outside the real-time thread and feed timestamped, epoch-tagged PCM into prepared engine
input ports.

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

**Working design.** Graph editing, compilation, allocation, and processor preparation happen off the
render thread.

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

Future topology changes should compile and prepare a replacement instance off-thread and publish it
at a safe render boundary. Old instances must be reclaimed off-thread so a final reference drop
cannot deallocate in the callback. State migration may initially be limited to matching stable
processor identities.

### Internal audio representation

**Decision.** The render engine uses one canonical internal representation rather than supporting
both planar and interleaved layouts in every processor.

Initial target:

- planar `f32` PCM
- mono and stereo semantic channel layouts
- a known engine sample rate chosen from the active output context
- variable frame counts up to a prepared maximum

Faithful decoding is required. Bit-perfect device output is not an initial goal. When a 44.1 kHz
source plays through a 48 kHz device or browser context, resampling is expected. The system should
avoid unnecessary conversion and preserve source metadata.

The initial source-rate focus is 44.1 kHz and 48 kHz. The engine rate is negotiated per active host
rather than globally fixed for every session.

### Variable render sizes

**Decision.** The core never assumes that callbacks always contain 128, 256, or 512 frames.

Conceptual render contract:

```text
render(
  start_frame,
  frame_count,
  inputs,
  outputs,
  events
)
```

`frame_count` may vary for each host callback up to a prepared maximum. Nodes that require fixed FFT,
convolution, or resampling chunks use preallocated local buffering and report added latency.

If a callback exceeds prepared capacity, the real-time path must not allocate. It should zero-fill,
report a reconfiguration condition, and allow the host runtime to rebuild safely.

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
state save and restore
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

**Decision.** Logical seeks target media PCM frames. Coarse codec seeking must not silently move the
requested audible position.

The reader may seek to an earlier decoder anchor, decode forward, and discard samples until the exact
logical target. Only when exact recovery is genuinely impossible may the session negotiate an
adjusted position, and it must report the actual result.

A seek creates a new source epoch. Stale queued PCM and observations from the prior epoch are ignored.
The session reports completion only after the new epoch is prepared according to the eventual
readiness contract.

### Loop contract

**Decision.** Initial loops are click-free and retain exact logical PCM boundaries where decoding
allows them.

Loop intervals are half-open:

```text
[loop_start, loop_end)
```

Events at `loop_start` repeat. Events exactly at `loop_end` are outside the active loop.

Click prevention uses a short built-in equal-power seam crossfade, initially expected to be about
5 to 10 milliseconds. This is transition smoothing, not the later creative crossfade feature.

The session:

1. seeks or reads ahead to a decoder anchor before the loop start
2. decodes and discards to the exact loop start
3. buffers the loop head before reaching the loop end
4. overlaps the tail and head through a short seam transition
5. keeps render time continuous while media time wraps
6. emits the media discontinuity and transition provenance

The initial seam transition occurs on decoded and resampled source PCM before shared downstream
processors. Those processors receive one crossfaded stream and preserve state across the loop.
Decoder and source-side seek state reset or re-prime as necessary. Generators continue on render time
unless explicitly bound to media time.

At the nominal wrap frame, media-time automation begins the new loop iteration. The short tail used
for seam smoothing does not create a second simultaneous parameter state in shared downstream
processors. An explicitly discontinuous automated parameter may still create an audible transition;
applications use ramps when parameter continuity is required. Render-time automation continues
unchanged.

Loop readiness is explicit:

```text
Disabled → Preparing → Armed → Active
                    └────────→ Failed
```

The player should not claim a loop is armed until the head is buffered.

If an armed loop still underruns:

1. fade quickly to silence
2. keep the render thread and render clock running
3. emit `LoopUnderrun`
4. re-prime the exact loop start
5. fade back in and resume

This lengthens the failed loop iteration. It does not block the callback or play unrelated media past
the boundary. Stricter policies may be required when several synchronized sources are active.

Long creative crossfades remain deferred but should reuse the same transition machinery.

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

A practical cache or identity key derives from:

```text
analyzer version
+ parameters
+ input provenance digest
+ result schema version
```

Artifacts are immutable. Reanalysis creates a new artifact. A separate catalog reference may identify
the preferred current result.

A mutable saved preset never identifies processed input. Artifacts refer to an immutable processor
preset revision. A future multi-source or routing system may generalize this to a `RenderRecipeRevision`.

### Artifact access

Artifacts default to no more access than their input signal. Processed artifacts use the intersection
of all source and preset access requirements. Explicit publication may create a safe public summary.

### Source and rendered analysis

Both are supported:

- source analysis describes the original media revision independent of playback state
- rendered analysis describes a named signal location after a specific processing configuration

The same streaming FFT, loudness, onset, pitch, or chroma front ends may be reused in live and offline
contexts. Whole-track inference and persistence remain job-level responsibilities.

## Synthesis and synchronized sources

### Generators

Generators are first-class render nodes. A minimal oscillator or tone generator belongs in an early
engine slice because it validates sample-timed automation without involving a decoder.

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
at runtime. A Rust decoder such as Symphonia may run in a worker when its target and feature set are
validated.

Shared memory and threads are optional optimizations. `SharedArrayBuffer` requires secure cross-origin
isolation and affects deployment headers and embedded resources. A first prototype should not require
shared memory unless measurement proves message or copy-based transport inadequate.

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

## Dependencies and implementation candidates

Dependency choices remain subject to prototypes and pinned-version audits.

### CPAL

Role: native output and capture adapter.

CPAL does not define the shared render engine. Callback frame counts must be read from the actual
buffer and treated as variable. Browser support is worth evaluating separately rather than assuming
it makes the native runtime portable unchanged.

### Symphonia

Role: pure-Rust demuxing and decoding candidate.

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

## Initial vertical slices

**Working design.** The following order is a recommended implementation sequence, not a settled
native-first product commitment. Adjacent slices may be combined when prototypes make that cheaper.

### Slice 1: render engine proof

- planar mono and stereo `f32`
- arbitrary render frame counts up to a prepared maximum
- oscillator generator
- gain processor
- sample-timed immediate values and linear ramps
- mixer and output port
- post-master level observation
- offline deterministic fixtures

### Slice 2: native single-track playback

- WAV reference playback
- MP3 and FLAC decoding
- negotiated macOS output rate through CPAL
- play, pause, seek, and position
- source epochs and bounded buffering
- exact logical seek through decode pre-roll and discard
- click-free loops with an armed loop head
- starvation and loop-underrun reporting

### Slice 3: progressive HTTP playback

- managed object-store source
- HTTP range probing and reads
- validator handling
- grant refresh
- MP3 and FLAC streaming
- loop-head prefetch over HTTP
- browser-compatible CORS and range behavior

### Slice 4: web playback

- Rust render engine compiled to Wasm
- dedicated media worker
- hand-audited AudioWorklet adapter
- the same playback and loop conformance fixtures as native
- level and spectrum observations delivered to React
- suspension and resume behavior

### Slice 5: catalog integration

- Clerk identity and Convex authentication
- anonymous guest resolution
- KKB catalog admin and VIP assignments
- releases, assets, revisions, locators, and playlists
- managed import and exact hashing
- browse and stream policies
- short-lived playback grants
- public, VIP, admin-only, and specific-user playlists

### Slice 6: analysis and microphone input

- durable source analysis artifacts
- live microphone analysis
- real-time visualization observations
- artifact provenance and object payloads
- monitoring and basic effects after capture-only behavior is stable

These slices describe sequencing, not separate permanent architectures.

## Explicitly deferred

- a public arbitrary graph-building interface
- render-thread graph mutation
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
- What state should source-local processors restore at a loop boundary beyond the default of
  preserving downstream state?
- What latency target is required for microphone monitoring and live effects?
- When should processed-signal provenance generalize from a preset revision to a complete render
  recipe revision?
- Which analysis facts and timelines belong directly in Convex versus object payloads?
- Which summaries may be published more broadly than their source artifacts?
- When should downloads, public user playlists, additional catalogs, and collaborative writes enter
  product scope?

## Corrections to the initial architecture note

The following refinements replace stronger claims in the initial architecture document:

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

- [Web Audio API](https://www.w3.org/TR/webaudio/)
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
- [wasm-bindgen AudioWorklet example](https://rustwasm.github.io/docs/wasm-bindgen/examples/wasm-audio-worklet.html)
- [SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)
- [Web Audio render-size explainer](https://github.com/WebAudio/web-audio-api/blob/main/explainer/user-selectable-render-size.md)

### Media and HTTP

- [MDN HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)
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
