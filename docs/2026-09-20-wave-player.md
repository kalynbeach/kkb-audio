# Experimental Wave Player

The new `/wave-player.html` combines the existing compact React player with KKB's
WebGPU phosphor XY scope. The classic `/player.html` remains available. This is
an unreleased experiment, not a deployment or a stable public player package.

## Design and ownership

The original player already had the transport, file collection, source waveform,
seeking and WAV/MP3 loop behavior needed for the experiment. `PlayerApp` now accepts
a visual component and its explanatory copy. Both entry points retain one private
`PlaybackOwner` and one `PlayerCollection`. The engine, workers and output tap are
unchanged.

The visual calls `PlaybackOwner.readOscilloscope` with two reusable 2048-sample
buffers. The tap observes actual worklet output before listening gain/mute, after
fixed engine gain and output-rate conversion. Stereo maps left to X and right to
Y. Mono repeats on both axes. The renderer clips full-scale samples, applies the
fixed 0.86 visual inset, and preserves equal physical axis scale across aspect
ratios. It never normalizes a track or creates replacement samples.

A small renderer copy keeps this repository independently buildable. The original
KKB runtime accepted its external provider only under microphone mode; this
integration instead exposes a playback-array contract and copies no source runtime.
[Source provenance](../THIRD_PARTY_NOTICES.md#kkb-webgpu-oscilloscope) records the
pinned source, adaptations and undeclared upstream license. No KKB checkout was
modified and no unpublished cross-repository dependency was added.

One proposed P31 green preset belongs to the instance, with Kalyn owning its
selection. No listener scene/settings system is introduced. The page preserves
the existing square controls, Inter/TX-02/Departure Mono roles, light/dark/system
appearance, source-waveform navigation and narrow-screen library behavior.

## Lifecycle and failure boundary

- Read and draw at most 30 times per second while playing. The fixed sample
  buffers use 16 KiB, with another 16 KiB for XY vertices. GPU backing dimensions
  are capped at 2048 and DPR at 2.
- Audio pause freezes the last observation. Seeking clears old history, including
  a seek while paused. Ended, replacement and close cannot retain the prior track.
- Theme/disclosure invalidation composites retained history once, with no new
  samples or phosphor decay. A paused viewport resize redraws the last observation
  at its new physical scale; it does not read audio.
- Hidden views, reduced motion and Pause visual stop observation and detach the
  tap. Narrow library view unmounts the visual without changing playback ownership.
- GPU setup accepts cancellation. A late setup cannot release a newer scope's
  canvas, including React StrictMode cleanup/setup on the same element.
- Missing WebGPU, shader/setup errors, device loss and render failures report
  visual unavailability. They release owned GPU resources and the observation tap,
  without closing, pausing or replacing the playback owner.
- An open loop editor remains dismissible after Close track or Clear session.

## Verification

Checks use Bun 1.4.0 and the pinned Rust/Wasm toolchain. The full `bun run check`
passed on the final implementation, including build, typecheck, browser-independent
UI tests, media/loop checks, fixed-memory checks and worklet audits. This includes
the paused-image repaint, warming-read cadence and Close-track loop-editor repairs.

The renderer tests cover direct sample upload, stereo/mono mapping, silence and
nonfinite samples, rectangular axis scale, persistence clearing, capped resources,
resource destruction, setup failures, device loss, render errors and cancelled
asynchronous setup. Observer tests cover real owner phase/revision changes,
paused seeking, hidden/reduced-motion suppression, failure isolation and repeated
mount/disposal. These are controlled tests, not physical GPU/device-loss trials.

Muted verification in the Codex built-in browser on macOS used the dedicated
loopback port 4218 and this worktree's output. Observed behavior:

- Explicit synthetic study admission does not start audio. Play produces the
  actual WebGPU XY trace and source waveform. Pause freezes the observation.
- Keyboard seek while paused clears old visual history and preserves paused
  intent. Resume produces fresh samples. Source-frame A/B fields enable a bounded
  three-second PCM WAV loop without replacing the player.
- A synthetic 44.1 kHz mono WAV plays and drives both axes. Replacement resets the
  prior loop. Page themes and 320/390px narrow layouts retain transport; the
  internal library can replace and remount the visual during playback.
- The selected real local MP3 plays, seeks and loops on its decoded timeline.
  Close track clears transport and visual state. Clear session drops the collection.
- The selected real WAV is IEEE float32, format 3 at 48 kHz, and is correctly
  rejected by the existing PCM16/24 policy. Its path and audio are not included.
- Pause visual leaves active playback running. No browser error logs were observed.

No listening, speaker/device latency, broad browser, background playback or
click-free-loop claim follows from these muted checks. The observation is a
browser history window without source-frame tags or measured speaker timing.
The authored preset is provisional pending Kalyn's visual confirmation. The
Impeccable detector could not run because its installation lacks `htmlparser2`,
`css-select` and `css-tree`; this is separate from the passing repository checks.
The independent finish review returned `ship` with no material fixes. The existing
design sidecar was already stale and remains outside this experiment's scope.
The temporary server was stopped and port 4218 was verified closed after inspection.

## Public-safe case-study handoff

**Problem.** Connect a real local audio engine to an expressive visual without
creating a second player or confusing synthetic demo signals with track output.

**Decision.** Keep one playback owner and compose the existing React controls with
an explicit sample-array adapter to a bounded WebGPU renderer. Isolate graphics
failure from audio, and preserve the current player as a separate entry point.

**Verified behavior.** Local MP3 and supported PCM WAV playback drive the XY scope;
transport, seeking, A/B loops and session navigation remain available. The evidence
is from muted browser checks and controlled lifecycle tests, not listening tests.

The public study is generated by `web/src/synthetic-study.ts`. It creates a
30-second, 48 kHz, PCM16 stereo WAV with two authored periodic signals and short
edge fades. The file is visibly named `Synthetic stereo study.wav`, enters the
ordinary collection and runs through the actual Rust/Wasm playback/analysis path.
It is optional demonstration media, not a visualization fallback.

Captures in `2026-09-20-wave-player/` contain only that synthetic study. Use the
390 × 844 light/dark mobile images for the site's portrait figure. Public copy must
omit private repository links, private filenames and local paths. Describe this
as an unreleased WebGPU experiment; separate it from earlier engine measurements.

| Capture | Viewport | Observed state |
| --- | --- | --- |
| [mobile-light.jpg](2026-09-20-wave-player/mobile-light.jpg) | 390 × 844 | Paused, retained image after changing appearance |
| [mobile-dark.jpg](2026-09-20-wave-player/mobile-dark.jpg) | 390 × 844 | Playing, live XY signal |
| [desktop-dark.jpg](2026-09-20-wave-player/desktop-dark.jpg) | 1440 × 1000 | Playing, compact centered player |

These are unaltered JPEG captures from the built-in browser. Their SHA256 values
are recorded in [the capture manifest](2026-09-20-wave-player/manifest.json).

## Run locally

```sh
bun install --frozen-lockfile
bun run build:worklet
PORT=4218 bun tools/serve-proof.ts
```

Open `/wave-player.html` on that loopback server. `bun run dev` also exposes both
player entries when intentionally used in a development checkout. Do not use an
existing daily preview directory for isolated validation. Stop the server after
inspection.
