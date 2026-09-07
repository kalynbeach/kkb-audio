# `kkb-audio`

A Rust foundation for KKB sound, audio, and music software. The long-term system will share a portable render engine across web, native, and offline hosts while keeping host-specific lifecycle, media, and device concerns outside the real-time core.

## Status

The project is in focused render-engine validation. Milestone 1 implements a private offline kernel:

```text
mono sine oscillator -> linked scalar gain -> mono or semantic L/R planar output
```

Its tests establish frame and phase semantics, partition-independent output, bounded capacity behavior, checked clock handling, and no observed allocator calls in the exercised render path.

Milestone 2 is complete for the recorded browser and macOS native configurations. The unshared, fixed-memory Wasm `AudioWorklet` proof and the private CPAL proof run around the same kernel seam. Browser results do not declare minimum-version or branded-browser support, and the five-second native observation does not declare broad macOS device support or sustained deadline behavior. See the [Milestone 2 evidence](docs/2026-08-29-milestone-2-dual-host-kernel-evidence.md) for exact configurations, claims, and limitations.

Milestone 3 is complete within its bounded-PCM ownership and delivery claim for the exact recorded macOS CPAL and managed headless Chrome proofs. One private prepared-block seam is fed by one native worker through fixed SPSC rings and by one browser worker through a direct `MessageChannel` and four recycled transferable buffers. Variable callback partitions, epochs, starvation, ownership rejection, backpressure, callback allocator instrumentation, fixed Wasm memory, and worklet source constraints are covered. This does not establish a production transport, production performance, sustained-load or deadline behavior, branded-browser compatibility, or broad host support. See the [Milestone 3 evidence](docs/2026-09-01-milestone-3-bounded-pcm-transport-evidence.md) for the exact configurations and limitations. There is no public engine API or playback application yet.

Milestone 4 Gate A adds a private compiled plan for two oscillators, separate gains, mixing, post-master peak/RMS observations, and sample-timed gain automation. Native Rust tests and the Wasm proof cover independent instances, exact same-build partition comparisons, and bounded rendering. A separate browser proof compiles in a worker, validates and prepares locally in the worklet, and measures muted output.

Gate B adds prepared PCM, linked gain, observation, and output to the same compiler and renderer. Both existing transports feed `PreparedPcmInput`, which retains epoch rejection and block ownership. The native and browser PCM proofs now apply a compiled gain of 0.5 and preserve distinct L/R channels. The private shared operation representation is retained for the next increment, same-rate local WAV playback. See the [Milestone 4 evidence](docs/2026-09-06-milestone-4-compiled-plan-evidence.md#gate-b-pcm-integration), including the short browser run's starvation and host-coverage limits.

See the canonical [system architecture](docs/2026-08-28-kkb-audio-system-architecture.md) and [initial validation plan](docs/2026-08-29-initial-render-engine-validation-plan.md).

## Development

The repository pins stable Rust 1.98 and Bun 1.4.0. The worklet build also requires the matching pinned `wasm-bindgen` CLI.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked
bun install --frozen-lockfile

cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
bun run check
```

Run the local proof after `bun run build:worklet`:

```sh
bun run serve:proof
```

Open `/` for the PCM transport through the compiled plan, or `/plan.html` for the oscillator plan. Both pages prepare a suspended, disconnected node before activation and mute output after the analyser. The oscillator page also displays its output-level observation.

## Audio-engine learning lab

Open `/lab.html` to explore the closed oscillator graph, compiled operation order, per-node waveforms,
sample-timed gain events, and render partitions. The lab renders the actual Rust/Wasm engine offline
in a worker, then replays its mono output after an explicit Play action. It preserves both proof pages.

```sh
bun run build:worklet
PORT=4197 bun run serve:proof
```

The task-local URL is `http://127.0.0.1:4197/lab.html`. See the
[learning lab guide and evidence](docs/2026-09-06-audio-engine-learning-lab.md) for experiments,
keyboard controls, implementation boundaries, and verification.
