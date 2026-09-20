# Audio-engine lab and compact local player

<!-- impeccable:product-schema 1 -->

This product brief applies KKB's [product baseline](https://github.com/kalynbeach/kkb/blob/c30c935932ff5a7c245454491cef2591a55fece4/PRODUCT.md)
and [`@kkb/ui` boundaries](https://github.com/kalynbeach/kkb/tree/c30c935932ff5a7c245454491cef2591a55fece4/packages/ui)
to this standalone engine lab. The [canonical architecture](docs/2026-08-28-kkb-audio-system-architecture.md)
remains authoritative for the Rust engine. [DESIGN.md](DESIGN.md) records the requested research-theme
and Inter/TX-02 choices.

## Platform

web

## Compact local player

`/player.html` delivers #22's approved track-first listening object alongside the unchanged lab and
proofs. Open files or Settings → Add files admits up to 100 WAV/MP3 File references in picker order,
with explicit unsupported/over-limit counts. Repeated names do not imply identity. Nothing is
uploaded, persisted, eagerly decoded or cached across the collection. Reload ends the session.
Only the active track is prepared through the existing private PlaybackOwner; this is not a public
session API. Filename is the identity fallback; artist, album and artwork are unavailable. Duration
stays unknown until actual preparation, elapsed time follows consumed source frames, not speakers.

Library rows are playback-only: selection does not affect playback; row Play explicitly loads/plays,
or pauses/resumes/replays the current track. Previous/next replace at zero, preserving playing or
paused intent. No wrap or auto-advance. Addition/selection/ordinary preparation never autoplays.
Settings holds Add files, Remove selected, Clear session and Close track/Cancel loading. Removing an
inactive entry does not interrupt; removing active or Clear cancels/closes without a playback
successor. Removed selection moves to the next remaining row, or previous at the end. Original files
are never modified. Failed files remain browsable and retryable.

The centered 380 × 532 desktop player contains identity, a live oscilloscope with honest fallback, a functional
40px source-waveform seek target with consumed time, and independent centered transport. At ≥1212px the library is
a right companion; below it replaces only the visual region. Viewport, library and Light/Dark/System
changes preserve the owner and playback. Volume is a slim anchored disclosure; mute retains the level,
initially 15% after compiled gain 0.5. Seeking previews before a single commit; cancellation abandons
the draft. Ended is terminal and paused; seeking back stays paused until Play, Replay returns to zero.

Supported: nonempty little-endian RIFF PCM16/24 WAV or MPEG-1 Layer III MP3, mono/stereo, same-rate or
44.1 ↔ 48 kHz conversion. MP3 is bounded to 32 MiB and ten minutes including codec padding; full policy
is in [MP3 evidence](docs/2026-09-13-mp3-preparation.md). Errors recover through another row or retry.
The full-track source waveform (#18) scans only the active file in an independent cancellable Rust/Wasm
worker after playback readiness. Playback/seek remain functional during preparation or analysis failure.
At most 4096 time bins (32 KiB) retain channel min/max extrema, not signed averages; display columns
combine all overlapping bins. Fixed full-scale amplitude is not listening volume or measured output.
Seeks, mute and conversion do not rebuild it; replacement/close discard it and reject late jobs. There
is no retained collection cache. See [waveform evidence](docs/2026-09-13-source-waveform.md) for source-frame
mapping and bounded extra decoding costs.

The separate live oscilloscope (#23) observes actual worklet output before
listening volume/mute, including fixed engine gain and output-rate conversion. Mono has one solid
trace; stereo independently overlays left solid/right dashed traces. Private browser analyser
histories are untagged, approximate trailing windows, not source-frame or measured speaker sync.
At most three 2048-sample windows/channel (48 KiB total) provide finite persistence at ≤30 Hz.
Pause freezes the last observation; seeking clears it even while paused. Ended shows no live signal.
Hidden/internal-library, reduced-motion and Settings Pause visual stop reads/drawing and detach the
tap; returning waits for fresh rendered history without starting audio. Canvas/analyser failure is
visual-only. No extra decoding, audio callback work, microphone or playback owner is introduced.
[Live signal evidence](docs/2026-09-13-live-oscilloscope.md) records timing and support limitations.
WAV/MP3 loops (#19/#20) are implemented, with one region defaulting to whole-track/off. Opening
its opaque editor does not enable looping or start audio. Exact fields (fractional mm:ss or source
frames suffixed `f`), independent labelled handles, hatched region, Shift-drag and Reset preserve the
approved compact composition. Fields expose requested boundaries; details distinguish realized output
period and accumulated conversion quantization. At acknowledgment, enable outside moves to A without
autoplay; disable preserves exact PCM; an edit excluding the current cursor disables without moving
it. Normal prepared wraps keep render/downstream state continuous. Preparing and Failed are honest;
starvation adds a bounded fade/silence/re-prime interval. Terminal source failures require explicit
track retry, not a dead loop-only Retry. Held-head smoothing is not a universal click-free guarantee;
human listening remains pending. Review repairs retain latest control intent before preparation,
pause an acknowledgment-time EOS before any loop head can play, expose initial short-file rejection,
and keep visual explanations visible above the bounded editor. See [loop evidence](docs/2026-09-14-wav-loops.md).
MP3 loop continuation uses a bounded private encoded anchor on the decoded-and-trimmed timeline; internal carrier/predecessor PCM is discarded, never media. See [MP3 loop evidence](docs/2026-09-14-mp3-loops.md). Persistence/catalog, queues, HTTP, broader codecs and deployment remain out of scope. No fake signal, clock or dead loop controls ship.
Muted/device-free checks are not listening, broad browser, device or background certification; see
[implementation evidence](docs/2026-09-13-compact-player.md).

## Experimental WebGPU player

`/wave-player.html` composes the same React player, private PlaybackOwner and local
collection with KKB's WebGPU P31 phosphor XY renderer. `/player.html` remains
available with its Canvas2D oscilloscope. Transport, source waveform, seeking,
WAV/MP3 loops and session rules are shared. There is one audio owner and no new
decode, microphone input, media persistence or upload path.

The visual reads the existing 2048-sample worklet-output tap at at most 30 Hz,
before listening gain/mute. Left drives X and right drives Y; mono drives both
axes. The authored preset applies a fixed 0.86 visual gain with equal physical
axis scale across aspect ratios, no per-track normalization. GPU persistence
fades actual observations. This approximate trailing history has no source-frame
or speaker synchronization. Pause freezes the image; seek, replacement, close,
hidden views, reduced motion and visual suspension discard its history.

One P31 green preset lives in the instance source, with Kalyn owning its direction.
It is the proposed initial treatment, pending owner confirmation; listeners have
no visual configuration. Its dark phosphor field is consistent across page themes.
Missing WebGPU, device loss and render errors leave playback controls functional.
GPU resources belong to the visual and are disposed on unmount, including cancelled
asynchronous setup. Texture dimensions are capped at 2048 with DPR at most 2.

The optional, explicitly labelled synthetic study creates a 30-second PCM16 stereo
WAV in memory and adds it to the ordinary collection. It never autoplays and is
decoded by the same Rust/Wasm path. It is demonstration media, never a replacement
for a local track's observed samples. See the [implementation and case-study
handoff](docs/2026-09-20-wave-player.md) for verification boundaries.

## Users and purpose

KKB is Kalyn Beach's technical and creative workshop. This lab helps Kalyn and invited reviewers
understand how the private audio engine turns a signal graph into an execution plan and samples.
Experiments should produce inspectable behavior and reusable knowledge, with clear links to the
engine code and its limits.

## Operating context

The frontend uses Bun 1.4.0, React and shadcn/ui. Bun serves the React HTML entry with hot reload
for local development and bundles its production assets. Cargo builds Rust/Wasm; a worker renders
the engine's recorded samples. The existing PCM and oscillator worklet proof pages remain available.

This repository vendors the research repo's shadcn component implementations and theme. Shared
control behavior remains in those components; graph composition, browser sessions, workers and
audio lifecycle stay in lab code. There is no dependency on the KKB monorepo's Next.js applications.

## Capabilities and constraints

Two oscillators, separate gains, mixing, observation and output use the private closed engine
program. Graph selection, compiled order, waveform inspection and timed events agree on processor
and sample identity. Gain sets and ramps use absolute render frames. Frequency edits compile a
new plan. The user can hear beating, move an exact gain change, and compare all samples across
render-call partitions.

The lab renders two seconds offline and replays the resulting mono buffer after Play. It is an
inspection tool, with no general graph editing, backend, deployment or new real-time callback work.
Browser replay may resample for the device. The UI reports experimental status and measured
comparisons without claiming production readiness or wider host support.

## Product principles

- Make the engine inspectable through real samples, direct controls, linked code and documented evidence.
- Reuse the shared UI foundation; keep complete experiment and session behavior in the app.
- Preserve KKB's technical and creative identity through consistent typography, geometry and interaction semantics.
- Let visual complexity serve the experiment. Expose uncertainty and implementation limits plainly.

## Accessibility and success

Audio begins only after an explicit action, with visible play state, Stop, Mute and an independent
monitor gain. Keyboard access, visible focus, responsive composition and reduced-motion behavior
are required. Signal and selection meaning must not depend on color or hover alone. Light and dark
modes use the same control layout and behavior.

Success means a reviewer can run the lab locally, follow the compiled signal, inspect a sample-level
event, hear its result and verify a partition comparison without reading the implementation first.
The [lab guide](docs/2026-09-06-audio-engine-learning-lab.md) provides the review path and evidence.
