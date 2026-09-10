# Audio-engine lab and local WAV player

<!-- impeccable:product-schema 1 -->

This product brief applies KKB's [product baseline](https://github.com/kalynbeach/kkb/blob/c30c935932ff5a7c245454491cef2591a55fece4/PRODUCT.md)
and [`@kkb/ui` boundaries](https://github.com/kalynbeach/kkb/tree/c30c935932ff5a7c245454491cef2591a55fece4/packages/ui)
to this standalone engine lab. The [canonical architecture](docs/2026-08-28-kkb-audio-system-architecture.md)
remains authoritative for the Rust engine. [DESIGN.md](DESIGN.md) records the requested research-theme
and Inter/TX-02 choices.

## Platform

web

## Local WAV player

`/player.html` is the first usable local-file playback surface alongside the learning lab and proof
pages. Kalyn can choose one supported WAV, play/pause/resume, preview and commit a seek, replay,
control listening volume and close/cancel without understanding the transport. Nothing is uploaded.
Loading and replacement stay paused; playback starts with explicit Play. Ended is terminal and
paused, so seeking backward does not restart audio until Play; Replay seeks zero then plays.

The supported subset remains nonempty little-endian RIFF PCM16/24 mono/stereo, same-rate playback
and prepared 44100 ↔ 48000 Hz conversion. Unsupported files recover through replacement. Duration
comes from source metadata and elapsed time from consumed source frames, not an audible clock.
Listening gain starts at 15% after the compiled 0.5 gain, with mute retaining the chosen level.

The private playback owner is established through this consumer, not a frozen public session API.
The eventual separate `wave-player` app/package, additional codecs, waveform, queues, loops, HTTP,
catalog, device handoff and production deployment remain out of scope. Targeted muted checks are
not broad browser/device/background or listening-quality certification. See the
[player evidence](docs/2026-09-10-local-wav-player-evidence.md).

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
