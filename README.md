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
