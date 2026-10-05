# `kkb-audio`

A Rust foundation for KKB sound, audio, and music software. The long-term system will share a portable render engine across web, native, and offline hosts while keeping host-specific lifecycle, media, and device concerns outside the real-time core.

## Project direction

Kalyn confirmed on October 4, 2026 that `kkb-audio` is the current focus for audio/music work and the planned home of the actual WavePlayer product.

[`wave-player-next`](https://github.com/kalynbeach/wave-player-next) is an older experiment and a historical reference for future development. Use its code and design records as prior work; prioritize current audio/music and WavePlayer development here.

The current player and local catalog remain experimental. This direction does not establish a completed product or production readiness. See [PRODUCT.md](PRODUCT.md) for implemented behavior and limits, and the [canonical architecture](docs/2026-08-28-kkb-audio-system-architecture.md) for accepted decisions and deferred work.

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
Issue #15 adds the first usable local-WAV player at `/player`: select/replace, play/pause,
preview-and-commit seek, replay, volume/mute and close/cancel. A private playback owner reuses this
foundation; it is not a public package API or the eventual separate `wave-player` application.
See the [player implementation and evidence](docs/2026-09-10-local-wav-player-evidence.md).

See the canonical [system architecture](docs/2026-08-28-kkb-audio-system-architecture.md) and [initial validation plan](docs/2026-08-29-initial-render-engine-validation-plan.md).

## Development

The repository pins stable Rust 1.98 and Bun 1.4.0. `rust-toolchain.toml` pins the toolchain and the `wasm32-unknown-unknown` target, and rustup installs both on first use. The worklet build also requires the matching pinned `wasm-bindgen` CLI.

```sh
cargo install wasm-bindgen-cli --version 0.2.127 --locked
bun install --frozen-lockfile

cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets --all-features -- -D warnings
bun run check
```

Run the Next.js 16.3.5 app with the pinned Bun runtime:

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
bun run dev --port 3000
# Production, after stopping the development server:
bun run build
bun run start --port 3000
```

Open `http://localhost:3000`. The overview links to `/player`, `/lab`, and `/developer`.
The PCM and compiled-plan proofs live at `/developer/pcm` and `/developer/plan`.
The historical simulated prototype remains at `/developer/player-study`.
Leaving a player, lab, or proof route releases its audio resources. Appearance is shared across
routes for this page session; reload returns to System.

`build:worklet` only builds Rust/Wasm and independent worker/worklet bundles into
`public/audio-runtime`. Next builds and serves the pages. Rebuild the audio runtime after Rust,
worker, or build-tool edits. There is no Bun HTML server or legacy URL redirect.
See [the route and build migration](docs/2026-09-20-nextjs-frontend.md).
The deterministic and oscillator proof activations remain muted. **Local-file Play emits sound** at compiled
gain 0.5; lower system volume first. Load prepares a suspended, disconnected node; Pause freezes media
and render time without discarding PCM or converter history. WAV status distinguishes source-media
position, absolute next-consumed PCM position, render frames, epoch readiness, starvation and EOS.
Seek accepts an integer source frame from zero through `totalFrames`, including after EOS. Its result
reports the realized output-grid position; completion means new-epoch readiness, not audibility.
Close cancels preparation and pending seeks. The oscillator page also displays its level observation.

A private native interactive entry and a safe low-amplitude fixture generator are documented in the
[WAV reproduction guide](docs/2026-09-08-local-wav-playback-evidence.md#safe-reproduction).
Normal checks never open audio devices; device-opening tests must be explicitly selected.

For a bounded, paused-browser measurement of WAV/MP3 preparation, late seeking, loop arming,
waveform completion, cancellation and resources, run `bun run measure:media /tmp/local-media-measurements.json`.
See the [measurement guide](tools/measure-local-media/README.md). It builds and serves a separate temporary copy.

## Local WAV/MP3 player

Run `bun run dev`, then open `/player`. The development server supports React hot reload. When the global Bun
version differs, first run `export PATH="$PWD/node_modules/.bin:$PATH"` to use the pinned Bun 1.4.0.

The compact #22 player follows the [approved interactive prototype](docs/2026-09-13-wave-player-prototype.md).
Use **Open files** in the empty player or **Settings → Add files** to select several WAV/MP3 files.
The session retains at most **100 File references**, in picker order; unsupported extensions and
files beyond the limit are counted explicitly. Repeated/same-named files remain distinct entries.
No file is read or prepared on addition or row selection. Only the active entry is prepared; filename
is the honest identity, artist/album/artwork remain unavailable, and duration appears only after
preparation. Reload discards the collection and preferences. Nothing is uploaded or persisted.

Rows select independently of playback. Their **Play** target explicitly prepares and plays; the
current row pauses/resumes/replays. Previous/next replace at zero preserving playing/paused intent,
with no wrap or automatic advance. Ordinary preparation/replacement never autoplays. **Settings →
Remove selected / Clear session** only discard session entries, never original files. Removing an
inactive entry leaves playback untouched; removing the active entry or Clear cancels/closes it
without selecting a playback successor. Removed selection moves to the next remaining row, or previous
at the end. **Close track / Cancel loading** in Settings retains the collection; the visual loading
state also offers Cancel. Errors leave rows available for another file or retry.

Choose nonempty little-endian RIFF PCM16/24 or IEEE float32 mono/stereo WAV, or supported MP3. Playback supports the
active context's rate and prepared 44100 ↔ 48000 Hz conversion only. Library/theme/responsive
changes do not replace the active owner or session. Desktop keeps a centered compact player and
right companion library at ≥1212px; narrower browsing replaces only the visual region. Settings
provides Light/Dark/System and a separate Pause visual action. The WebGPU XY scope is the primary
player visual at `/player`; its synthetic study enters the real playback engine after explicit Play.
See the [scope contract](docs/2026-09-20-wave-player.md). The original Canvas2D oscilloscope (#23)
is retained at `/developer/classic-player` and
observes actual rendered output before listening volume/mute: mono solid, stereo left solid/right
dashed, never channel-averaged. It is an approximate untagged browser history, not source/speaker
synchronization. Reduced motion uses a stable baseline; unsupported/failed visuals leave playback
controls available. See [signal contract and muted evidence](docs/2026-09-13-live-oscilloscope.md).
The distinct 40px seek timeline shows
an actual full-track source waveform (#18). A separate cancellable worker scans Rust decoded/trimmed
PCM after playback is ready; Play and seeking remain available while the overview prepares or fails.
At most 4096 min/max bins (32 KiB) preserve extrema across channels, including opposite-phase stereo;
display reduction includes every covered bin. The fixed full-scale overview is unaffected by volume,
mute, conversion or seeks. No summaries are cached across tracks. See [waveform evidence](docs/2026-09-13-source-waveform.md)
for mapping, working memory and measured extra decoding cost. The live visual adds no decoder or
worklet callback work. WAV/MP3 A/B loops (#19/#20) are implemented: open the repeat editor,
choose one region or the default whole track, then enable separately. Exact fields accept mm:ss.fraction
or integer source frames followed by `f`; Shift-drag creates a region and labelled handles support
arrows (1 second, Shift 5). MP3 uses its validated decoded-and-trimmed timeline and a private bounded codec-history anchor. Requested source bounds and realized
converted period are shown separately; fixed-grid quantization accumulates across iterations. Bounded
held-head smoothing preserves the realized output period, not every tail sample or arbitrary endpoint
slopes. Preparing/Failed are explicit; loop underrun fades to silence and re-primes without resetting
the render clock. Normal wraps do not use public seek or UI polling. Explicit control changes may
prepare silence. Review repairs cover EOF head draining, acknowledgment-time EOS pause, latest control
intent and visible visual/capability explanations at the smallest layout. Human listening remains pending; see [MP3 loop evidence](docs/2026-09-14-mp3-loops.md) and [WAV loop evidence](docs/2026-09-14-wav-loops.md#bounded-review-repair-2026-09-14),
including the small repository-hosted screenshot/runtime/check set.

IEEE float32 WAV uses RIFF format tag 3 with 32-bit little-endian samples. The shared
reader preserves finite values, including signed zero and values outside `[-1, 1]`,
without normalization or clipping. NaN/Inf reject the entire decode block. Decode
windows contain at most 1024 frames, up to 8192 bytes for stereo float32. Unknown
RIFF chunks, including `JUNK` before `fmt`, follow the existing bounds/padding checks.
PCM32, float64, WAVE_FORMAT_EXTENSIBLE and RF64 remain unsupported.

Same-rate preparation preserves every finite float32 value. Cross-rate conversion
requires `|sample| <= 1e30` to reserve headroom for the pinned float32 FFT; larger
values reject before entering it. Conversion also rejects nonfinite output before
publishing a chunk. Numeric failures report code 74. The compiled gain remains 0.5;
this is not normalization. Native integer output clips rendered samples to `[-1, 1)`
before conversion, matching browser output clipping. Float output preserves finite
rendered values; device output can still clip at its physical limits. Nonfinite rendered
output rejects the callback and reports output failure code 6. The waveform summary
retains source extrema above full scale; its fixed-scale drawing clips visually.
Validation of later decode blocks happens as they are read, not during WAV header inspection.

MP3 support (#17) uses pinned Symphonia 0.6.1 in the shared Rust preparation path,
not browser decoding. Accepted: MPEG-1 Layer III, 44.1/48 kHz mono/stereo, CBR/VBR
32–320 kbit/s including CRC-protected frames, validated Xing/Info/LAME, structurally
bounded VBRI v1, or missing optional metadata. Missing trim means untrimmed decoder
output, **not** recovered encoder input. **VBRI fallback:** byte/frame counts and
seek-table values are untrusted advisory data, including inconsistent values;
full scan/decode alone establishes duration and seeking. VBRI does not recover trim.
Malformed metadata structure, inconsistent Xing/LAME metadata, truncated/corrupt
frames, unsupported variants and changing rates/layouts reject. Bounds: 32 MiB encoded,
1 MiB leading ID3, at most 25,000 packets / 600 seconds **including codec padding**.

Inspection decodes/counts the whole bounded stream before publishing duration, with
constant PCM storage. Ordinary MP3 seeks reset/decode/discard to reconstruct codec history
before converter pre-roll; even equal-rate seeks report `AnchorAndDiscard` (or
`Adjusted` for output-grid rounding), not guessed `Exact`. Preparation/seeking
can take time and are cancellable; a 30-second worker deadline rejects excessively
slow work. See [MP3 policy and evidence](docs/2026-09-13-mp3-preparation.md),
[fixture provenance](tools/fixtures/mp3/README.md) and [decoder notices](THIRD_PARTY_NOTICES.md).
The native device-free worker/rings use the same reader; the existing opt-in native
file proof also accepts MP3 without changing its historical test/environment names.
No physical output was used to validate MP3.

Drag Position to preview; release commits one seek. Escape, pointer cancellation or leaving focus
cancels the preview. Arrow keys seek five seconds, Page Up/Down thirty seconds, Home/End to the exact
start/end. Normal seeks preserve play/pause; consumed EOS (including an endpoint seek) pauses the
same context. Seeking back from Ended stays paused; **Replay** seeks zero and plays. Elapsed time is
the consumed source-media cursor, **not measured audible presentation time**.

Listening volume starts at **15% after the compiled 0.5 gain** (initial linear combined gain 0.075).
Mute remembers the selected level; volume/mute never rebuild playback or move its cursor. Close
cancels loading/seeking and releases the context/worker. Playback details and limits live in Settings. No broad browser,
background, device or click-free-transition guarantee follows from the muted checks; see the
[compact-player evidence](docs/2026-09-13-compact-player.md) and
[foundational playback limitations](docs/2026-09-10-local-wav-player-evidence.md).

## Audio-engine learning lab

The Next.js App Router frontend uses the research repo's shadcn/ui components and theme, with Inter and
TX-02 fonts. Open `/lab` to explore the closed oscillator graph, compiled operation order, per-node waveforms,
sample-timed gain events, and render partitions. The lab renders the actual Rust/Wasm engine offline
in a worker, then replays its mono output after an explicit Play action. It preserves both proof pages.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:3000/lab`. `bun run dev --port 3000` builds the audio runtime and starts Next.
React and CSS edits update live. Restart after Rust, worker, or build-tool changes.
Use `bun run build` and `bun run start --port 3000` to inspect production output.

See the
[learning lab guide and evidence](docs/2026-09-06-audio-engine-learning-lab.md) for experiments,
keyboard controls, implementation boundaries, and verification.
