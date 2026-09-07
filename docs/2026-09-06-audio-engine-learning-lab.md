# Audio-engine learning lab

Date: 2026-09-06
Frontend updated: 2026-09-07
Branch: `feat/audio-engine-learning-lab`
Base: reviewed Gate B `e199dbe82d184ca05ff28c711e2ca0afde888439`

The lab is a dedicated page at `/lab.html`. It makes the existing closed oscillator program
inspectable without changing the real-time executor or replacing the PCM and worklet proof pages.
The [canonical architecture](2026-08-28-kkb-audio-system-architecture.md) and
[Gate A/B evidence](2026-09-06-milestone-4-compiled-plan-evidence.md) retain their authority.

## Run

Use the repository's pinned Bun 1.4.0, Rust 1.98.0 and wasm-bindgen CLI 0.2.127.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:4197/lab.html`. This builds Rust/Wasm and worker assets, then serves the
React HTML entry with hot reload. `PORT` overrides 4197. React/CSS changes update live; restart
`bun run dev` after Rust, worker or build-tool edits. To inspect production bundles, use
`bun run build:worklet` followed by `PORT=4197 bun run serve:proof`. Existing proof pages remain
at `/index.html` and `/plan.html` in development.
No deployment or existing preview channel is involved. Audio remains silent until Play.
Listening volume begins at 15% and can be muted independently of the engine samples.

## Explore

- **Hear the beating.** Start with 220 and 224 Hz at equal gains. Show the two-second envelope,
  then play the mix. Bring source B toward 220 Hz to reduce the beat rate. Frequencies are static
  compiler settings; every source edit prepares a new instance with phase zero.
- **Move one moment.** Gain A changes from 0.30 to 0.08 before sample 24,017. That is offset 81
  in 128-frame block 187. Inspect the event at 32-sample zoom and step between 24,016 and 24,017.
  Move the marker or edit its numeric sample to relocate the change.
- **Cross a boundary.** A gain ramp starts at 24,017 and reaches 0.02 at 24,529 inclusive.
  Change the render partition to 17, 64, 128, 257 or 1,024 frames. Compare renders to check every
  sample of every node, including both ramp endpoints. The comparison reports maximum absolute
  sample difference; zero means exact same-Wasm numeric equality for these tapes.

Select graph nodes, connections, execution steps or trace legends to coordinate the inspector and
waveform. The graph's miniature traces show 384 recorded samples and autoscale each node. The main
microscope uses one shared amplitude scale across its three lanes and labels that scale. Selecting
an oscillator replaces its gained lane with the raw source. A and B are independent mono sources,
not stereo channels. Mixing performs an unnormalized sum; engine values can exceed ±1.

Click the waveform to scrub within its current view. Click the overview to move through the full
two-second tape. Waveform Left/Right steps one sample; Shift uses the current block size. Home/End
go to tape endpoints. Event-marker Left/Right moves an event one sample; Shift moves 128 samples.
Native inputs provide exact editing. The event selector reaches overlapping markers in insertion
order. Adding a gain event targets selected source A/B, with A as the default for downstream nodes.
There are at most sixteen events. Moving a ramp preserves duration and clamps it within the tape.
Same-frame events execute in insertion order. Reset restores the selected experiment.

## Engine and clock boundaries

[`LabSession`](../src/compiled_plan/lab.rs) modifies only the existing private fixture's frequencies
and initial gains, then invokes `CompiledPlan::compile`. It encodes the events, decodes that canonical
description, and prepares one `RenderInstance`. The graph connections and execution sequence derive
from that returned description, rather than a second TypeScript compilation model.

The executor runs its seven operations for each sample. IDs are 10 oscillator A, 20 gain A,
30 oscillator B, 40 gain B, 50 mix, 60 observation and 70 output. Only gains accept events.
Sets apply before their frame. Ramps capture the current start value and reach their target at the
inclusive end. These are the existing engine semantics, exercised by both native and Wasm tests.

The offline binding accepts at most 1,024 frames per call and 96,000 per instance. It copies each
operation's freshly rendered plane into a bounded result. The worker assembles seven two-second
Float32 tapes, about 2.69 MB in total, then transfers them to the UI. It frees the Wasm session in
`finally`. This allocating inspection API is intentionally outside the audio callback. Wasm memory
remains unshared and fixed at 16 MiB. The existing worklet render path is unchanged.

The observation node retains the actual latest completed 64-frame engine window and its overwritten
window count. Those windows are independent of render-call partitions. The transport bar instead
computes peak/RMS from the recorded output's 64-frame window at the cursor and labels it offline.
The main plot draws min/max bins when zoomed out and individual sample points at detailed zoom.
Block lines appear when at most eighty fall within the view; zoom in to inspect denser boundaries.
Ramp brackets annotate their start/end interval, not a separate simulated parameter curve.

Web Audio replays the completed mono output through a monitor gain. It may resample for the device.
The UI estimates replay position from `AudioContext.currentTime`; it is not a device presentation
measurement. UI animation never applies engine events. Edits stop playback and invalidate earlier
render responses. Dragging marks the previous render stale until release. Stop, hidden-page handling
and page cleanup stop sources; returning through the browser's page cache recreates worker resources.

## Verification

The complete check command includes the lab's actual-Wasm conformance suite:

```sh
cargo fmt --check
cargo test --all-targets --all-features
cargo test --release --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --target wasm32-unknown-unknown --lib -- -D warnings
bun run check
```

Native tests cover per-node tap equations at event boundaries, ramp endpoints, identical traces
across partitions, input rejection, unchanged clock after invalid calls, and engine observations.
The lab's four actual-Wasm tests cover the displayed operation metadata, analytic oscillator values,
exact sets/ramps, all seven two-second tapes across 17/128/257/1,024-frame calls, capacity/value
rejection and event movement bounds. They run in a separate Bun process because an existing worklet
transport unit test mocks the generated Wasm module globally.

### September 7 React migration

The full `bun run check` passes under Bun 1.4.0: 39 existing tests, four actual-Wasm lab tests
and eight React tests, with 900 assertions total. The React suite exercises immediate revision
invalidation, drag/release, StrictMode and unmount cleanup, worker failure recovery, page
restoration, negative numeric drafts and selector focus. It uses a controlled Worker transport
and stubs canvas drawing; the separate Wasm suite validates actual samples.

Native debug and release each pass 49 tests, with the existing device-opening test ignored.
Rust formatting, native/Wasm Clippy, TypeScript, fixed 16 MiB Wasm memory, kernel/plan conformance
and both worklet source audits pass. No Rust engine changes were made during the React migration.

Browser verification used the Codex in-app browser at 1280×720, 960×800 and 390×844. Document
client/scroll widths matched at all three sizes. The mobile graph scrolls internally; the compiled
Output step brings its node into view. Peak/RMS moves below the microscope on narrow layouts.
Both research color modes and Inter/TX-02 computed font roles were inspected.

The React page exercised graph selection, keyboard source sliders, exact negative event edits,
overlapping event selection, sample inspection, muted playback/Stop, source edits stopping replay
and partition comparisons. The bundled production page also prepared the engine, replayed muted
output, reported exact equality across all 672,000 node samples for 128/257-frame calls, and opened
the existing worklet proof. Development entry updates reuse one React root; after the fix, hot
replacement produced no new duplicate-root or unaccepted-update warnings.

The complete branch and migration received independent read-only code and design reviews.
Review fixes preserve event-selector keyboard focus, keep diagnostics available on narrow screens,
contain horizontal control groups and expose graph scrolling at tablet widths. Coincident events
retain their lines while only the selected event receives a waveform annotation.

### Original September 6 implementation

The original implementation passed the same native and actual-Wasm engine checks before React.
Its browser run additionally exercised dragging an overlapping ramp while preserving its 512-frame
duration, marker Enter/ArrowRight focus, navigation back from the proof and completed replay. These
are historical observations of the previous frontend, not additional React browser coverage.

The lab remains an offline inspection and replay tool. No audible listening assessment, other
browser engine, physical mobile device, new CPAL device run, deadline benchmark or cross-target
bit identity is claimed. Reduced-motion CSS was inspected; no assistive-technology or reduced-motion
emulation run is claimed. The original design detector was unavailable because its installed
parser dependencies were absent; current review uses rendered screenshots and a separate reviewer.

## Frontend and assets

The frontend uses Bun 1.4.0, React 19 and shadcn/ui backed by Base UI. React owns component state
and DOM updates. The session hook owns worker revisions, debounce cancellation, audio resources
and page lifecycle. Canvas drawing reads the same state and the theme tokens. Engine DSP remains
in Rust/Wasm; JavaScript does not synthesize the displayed traces.

[DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md) apply the KKB design-system baseline and
record source revisions. The research theme and fourteen component modules are vendored unchanged.
The build self-hosts Inter variable Latin from inter-ui and TX-02 from KKB; Inter's OFL license
is copied to the build as Inter-LICENSE.txt. The legacy Geist assets are removed.
