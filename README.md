# `kkb-audio`

A Rust foundation for KKB sound, audio, and music software. The long-term system will share a portable render engine across web, native, and offline hosts while keeping host-specific lifecycle, media, and device concerns outside the real-time core.

## Status

The project is in focused render-engine validation. Milestone 1 implements a private offline kernel:

```text
mono sine oscillator -> linked scalar gain -> mono or semantic L/R planar output
```

Its tests establish frame and phase semantics, partition-independent output, bounded capacity behavior, checked clock handling, and no observed allocator calls in the exercised render path.

Milestone 2 is complete for the recorded browser and macOS native configurations. The unshared, fixed-memory Wasm `AudioWorklet` proof and the private CPAL proof run around the same kernel seam. Browser results do not declare minimum-version or branded-browser support, and the five-second native observation does not declare broad macOS device support or sustained deadline behavior. See the [Milestone 2 evidence](docs/2026-08-29-milestone-2-dual-host-kernel-evidence.md) for exact configurations, claims, and limitations.

Milestone 3 is complete within its bounded-PCM ownership and delivery claim for the exact recorded macOS CPAL and managed headless Chrome proofs. One private prepared-block seam is fed by one native worker through fixed SPSC rings and by one browser worker through a direct `MessageChannel` and four recycled transferable buffers. Variable callback partitions, epochs, starvation, ownership rejection, backpressure, callback allocator instrumentation, fixed Wasm memory, and worklet source constraints are covered. This does not establish a production transport, production performance, sustained-load or deadline behavior, branded-browser compatibility, or broad host support. See the [Milestone 3 evidence](docs/2026-09-01-milestone-3-bounded-pcm-transport-evidence.md) for the exact configurations and limitations. This milestone did not establish a public engine API or playback application.

Milestone 4 Gate A adds a private compiled plan for two oscillators, separate gains, mixing, post-master peak/RMS observations, and sample-timed gain automation. Native Rust tests and the Wasm proof cover independent instances, exact same-build partition comparisons, and bounded rendering. A separate browser proof compiles in a worker, validates and prepares locally in the worklet, and measures muted output.

Gate B adds prepared PCM, linked gain, observation, and output to the same compiler and renderer. Both existing transports feed `PreparedPcmInput`, which retains epoch rejection and block ownership. The native and browser PCM proofs now apply a compiled gain of 0.5 and preserve distinct L/R channels. The private shared operation representation is retained for the next increment, same-rate local WAV playback. See the [Milestone 4 evidence](docs/2026-09-06-milestone-4-compiled-plan-evidence.md#gate-b-pcm-integration), including the short browser run's starvation and host-coverage limits.

Issue #9 adds private same-rate local WAV proofs for the browser and macOS: PCM16/24 mono/stereo,
bounded worker decoding, compiled gain/output, play/pause/resume, next-consumed-source position and
consumed EOS. Its original same-rate checks and recorded browser/macOS playback observations pass
within the [WAV evidence limits](docs/2026-09-08-local-wav-playback-evidence.md).

Issue #11 adds private prepared **44100 ↔ 48000 Hz** conversion in both workers, exact same-rate bypass,
bounded chunk/history storage, delay trimming and finite-file flushing. Status distinguishes consumed
output-rate PCM from a floor-rounded source-media cursor. Unsupported conversions/layouts/encodings
and empty/malformed files are rejected. Extended tests exposed
browser starvation, addressed by four 1024-frame slots and independently bounded 1024-frame reads.
Automated checks, ten-minute physical output in both directions, and final-build browser checks
pass within the [conversion evidence limits](docs/2026-09-09-prepared-sample-rate-conversion-evidence.md)
(ten-minute same-rate/up-conversion; one-minute reverse confirmation). Subjective listening quality,
broad host support and production readiness are not established.

Issue #13 adds source-frame WAV seeking, bounded converter pre-roll, epoch readiness and coherent
playback snapshots. Paused seeks reclaim old buffers without consuming audio; playing seeks prepare
silence on the same continuous render clock. Repeated seeks supersede obsolete work, including late
reads/admissions; endpoint seeks and seeking after EOS are supported. Presentation time is explicitly
unavailable, not inferred from consumption. The bounded load/play/pause/resume/seek/starvation/EOS/
close/reload gate is documented in the [seeking/lifecycle evidence](docs/2026-09-10-wav-seeking-lifecycle-evidence.md).
Issue #15 adds the first usable local-WAV player at `/player.html`: select/replace, play/pause,
preview-and-commit seek, replay, volume/mute and close/cancel. A private playback owner reuses this
foundation; it is not a public package API or the eventual separate `wave-player` application.
See the [player implementation and evidence](docs/2026-09-10-local-wav-player-evidence.md).

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
cargo clippy --target wasm32-unknown-unknown --all-targets --all-features -- -D warnings
bun run check
```

Run the local proof after `bun run build:worklet`:

```sh
bun run serve:proof
```

Open `/player.html` for the usable local-WAV player, `/` for the PCM transport and local WAV proof
controls, or `/plan.html` for the oscillator plan.
The deterministic and oscillator proof activations remain muted. **WAV Play emits sound** at compiled
gain 0.5; lower system volume first. Load prepares a suspended, disconnected node; Pause freezes media
and render time without discarding PCM or converter history. WAV status distinguishes source-media
position, absolute next-consumed PCM position, render frames, epoch readiness, starvation and EOS.
Seek accepts an integer source frame from zero through `totalFrames`, including after EOS. Its result
reports the realized output-grid position; completion means new-epoch readiness, not audibility.
Close cancels preparation and pending seeks. The oscillator page also displays its level observation.

A private native interactive entry and a safe low-amplitude fixture generator are documented in the
[WAV reproduction guide](docs/2026-09-08-local-wav-playback-evidence.md#safe-reproduction).
Normal checks never open audio devices; device-opening tests must be explicitly selected.

## Local WAV player

Build with `bun run build:worklet` and serve with `bun run serve:proof`, then open `/player.html`.
`bun run dev` also serves the player with React hot reload alongside the lab. When the global Bun
version differs, first run `export PATH="$PWD/node_modules/.bin:$PATH"` to use the pinned Bun 1.4.0.

Choose a nonempty little-endian RIFF PCM16/24 mono/stereo WAV. Playback supports the active context's
rate and prepared 44100 ↔ 48000 Hz conversion only. Files stay local; unsupported files show an error
and can be replaced. Loading/replacing never starts audio. Press **Play** explicitly.

Drag Position to preview; release commits one seek. Escape, pointer cancellation or leaving focus
cancels the preview. Arrow keys seek five seconds, Page Up/Down thirty seconds, Home/End to the exact
start/end. Normal seeks preserve play/pause; consumed EOS (including an endpoint seek) pauses the
same context. Seeking back from Ended stays paused; **Replay** seeks zero and plays. Elapsed time is
the consumed source-media cursor, **not measured audible presentation time**.

Listening volume starts at **15% after the compiled 0.5 gain** (initial linear combined gain 0.075).
Mute remembers the selected level; volume/mute never rebuild playback or move its cursor. Close
cancels loading/seeking and releases the context/worker. Details remain secondary. No broad browser,
background, device or click-free-transition guarantee follows from the muted checks; see the
[player evidence and limitations](docs/2026-09-10-local-wav-player-evidence.md).

## Audio-engine learning lab

The Bun + React frontend uses the research repo's shadcn/ui components and theme, with Inter and
TX-02 fonts. Open `/lab.html` to explore the closed oscillator graph, compiled operation order, per-node waveforms,
sample-timed gain events, and render partitions. The lab renders the actual Rust/Wasm engine offline
in a worker, then replays its mono output after an explicit Play action. It preserves both proof pages.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:4197/lab.html`. `bun run dev` builds Rust/Wasm and the workers, then serves
the React page with hot reload on localhost. Set `PORT` to change the default 4197. React and CSS
edits update live; restart `bun run dev` after Rust, worker or build-tool changes to rebuild them.
For the bundled production assets, run `bun run build:worklet` then `PORT=4197 bun run serve:proof`.
The existing proof pages remain at `/index.html` and `/plan.html` during development.

See the
[learning lab guide and evidence](docs/2026-09-06-audio-engine-learning-lab.md) for experiments,
keyboard controls, implementation boundaries, and verification.
