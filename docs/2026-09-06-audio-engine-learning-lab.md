# Audio-engine learning lab

Date: 2026-09-06
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
bun run build:worklet
PORT=4197 bun run serve:proof
```

Open `http://127.0.0.1:4197/lab.html`. Port 4197 is this feature's task-local preview.
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

Recorded automated results: 49 Rust tests passed in debug and release, with the existing hardware
test ignored; 39 existing Bun tests and 4 lab tests passed, 802 assertions total. Native and Wasm
Clippy, TypeScript, actual-Wasm kernel/plan checks, fixed-memory checks and both worklet audits passed.

Browser verification used the Codex in-app browser at 1280×720 and a 390×844 viewport.
It exercised graph/connection/sequence selection, sample stepping, event editing and retargeting,
overlapping-event selection, partition comparison, and muted replay. The comparison reported zero
difference for all 672,000 node samples for both 128/257 and 257/128 frame calls. Dragging a selected
overlapping ramp from sample 24,017 to 31,504 preserved its 512-frame duration and moved its end to
32,016. Marker Enter retained keyboard focus; ArrowRight moved both event and cursor by one sample.

Play/Stop, source-edit interruption, completion, and replay after navigating to the existing worklet
proof and back were exercised. No console warnings or errors were observed in the browser log
capture. Browser build metadata was unavailable. The narrow page had document client/scroll widths
of 390/390; its graph had an intentional internal client/scroll width of 356/640. Selecting Output
through the compiled sequence moved that internal scroll position to 284. Guided actions brought
the microscope or comparison result into view and focused it.

An independent reviewer executed the actual main-thread code with mocked browser APIs to verify
stale response rejection during dragging, resource recreation after persisted page restoration,
and recovery after a failed worker initialization. These deterministic lifecycle checks supplement
the browser run; they are not a browser cache implementation or network-fault test.

The complete feature was independently reviewed against the pinned Gate B base, including all new
files and this guide. Final disposition: zero actionable standards or specification findings.
The separate design review concluded **pass**, with all five material findings resolved:

| Design finding | Final status |
| --- | --- |
| Event-marker keyboard focus | Resolved |
| Mobile sample-label collisions | Resolved |
| Guided actions leaving results off-screen | Resolved |
| Mobile graph navigation discoverability | Resolved |
| Lesson statements becoming stale after edits | Resolved |

This is offline replay, not a new real-time worklet or sustained playback proof. No audible listening
assessment, other browser engine, physical mobile device, new CPAL run, deadline benchmark or
cross-target bit identity is claimed. Reduced-motion CSS was reviewed; no assistive-technology or
reduced-motion emulation run is claimed. The design detector could not run because its installed
htmlparser2, css-select and css-tree dependencies were absent; screenshots and a separate read-only
design review were used. The global skill installation was left untouched.

## Assets

The lab self-hosts the existing KKB Geist font. Its [upstream OFL license](https://github.com/vercel/geist-font/blob/main/OFL.txt)
is included in `web/assets/Geist-LICENSE.txt` and copied into the build. No runtime dependency was added.
