# `kkb-audio`: a Rust-beginner-friendly walkthrough

Date: 2026-09-04
Status: Codebase walkthrough at commit `eaccf29`

This describes **commit `eaccf29` on `feat/3-bounded-pcm-transport`**. Three read-only subagents explored the Rust core, native host, and browser/Wasm path; I inspected the surrounding architecture, documentation, and tooling and ran the non-device checks.

No source files were changed during the exploration.

## 1. What this project is today

**`kkb-audio` is a small collection of working audio-engine proofs—not yet an audio player or a public engine library.**

It currently demonstrates two things:

1. A prepared sine oscillator can generate correct audio regardless of how rendering is divided into callbacks.
2. Workers can deliver generated PCM through bounded storage to native and browser audio callbacks without those callbacks waiting for input or growing their buffers.

There are **two separate render paths**:

```text
Original oscillator proof
─────────────────────────
oscillator state → sine calculation → gain → output


Current PCM transport proof
───────────────────────────
worker-generated samples
          ↓
bounded transport
          ↓
PreparedPcmInput
          ↓
output
```

The oscillator does **not** feed the PCM transport. They are independent validation steps.

The current native and browser host implementations use the **PCM path**. Older Milestone 2 evidence describes the previous oscillator-based host proofs.

### Implemented versus planned

| Implemented now | Described in the architecture, but not implemented yet |
|---|---|
| Mono/stereo sine kernel | Compiled processing graph |
| Prepared PCM block consumption | `CompiledPlan` / `RenderInstance` |
| Fixed buffer ownership and recycling | Mixing and sample-timed automation |
| Native macOS CPAL proof | Production native application |
| Browser worker → AudioWorklet proof | React player application |
| Epoch rejection, starvation, EOS handling | Full play/pause/seek/loop behavior |
| Tests and diagnostic observations | File decoding, HTTP playback, resampling |
| Build and worklet audits | Catalog, authentication, storage, analysis jobs |

Keep that distinction in mind when reading the large architecture document: **it describes the intended system, not a catalog of existing code.**

---

## 2. The audio concepts you need first

### Samples, frames, and channels

A **sample** is one amplitude value for one channel.

A **frame** contains the samples for every channel at one instant.

```text
Mono frame:    [sample]
Stereo frame:  [left sample, right sample]
```

At 48,000 Hz:

- There are 48,000 frames per second.
- Stereo has 96,000 individual sample values per second.

This matters because the engine advances time **once per frame**, not once per channel.

### Planar versus interleaved storage

The Rust core uses planar `f32` audio:

```text
left:  [L0, L1, L2, L3]
right: [R0, R1, R2, R3]
```

Native device output is adapted to interleaved storage:

```text
[L0, R0, L1, R1, L2, R2, L3, R3]
```

Same audio; different memory arrangement.

### Callback size versus prepared block size

The worker might produce a block containing 1,024 frames. The audio device might request 512 frames at a time.

Those sizes do not have to match:

```text
One worker block:
[────────────────── 1,024 frames ──────────────────]

Two callbacks:
[────── 512 frames ──────][────── 512 frames ──────]
```

The PCM adapter handles this mismatch.

### Why “prepared” matters

A real-time audio callback has a deadline. At 48 kHz, 256 frames represent approximately:

```text
256 / 48,000 = 5.33 milliseconds
```

The callback cannot stop and wait for a worker, download a file, or allocate a larger buffer whenever convenient.

The project therefore separates:

```text
Preparation:
allocate storage, validate configuration, construct state

Rendering:
read prepared state, perform bounded work, fill output
```

The recurring design rule is:

> Do potentially unpredictable work before activation or outside the render callback.

---

## 3. Repository map

```text
kkb-audio/
├── Cargo.toml                  Rust package and dependencies
├── Cargo.lock                  Exact resolved Rust dependency graph
├── rust-toolchain.toml         Pinned Rust toolchain
├── .cargo/config.toml          Fixed Wasm memory settings
│
├── src/
│   ├── lib.rs                  Crate root, oscillator kernel, kernel tests
│   ├── prepared_pcm.rs         Shared PCM types, consumption, slots, tests
│   ├── cpal_host.rs            macOS native proof and tests
│   └── worklet_wasm.rs         Rust-to-JavaScript Wasm adapter
│
├── web/
│   ├── proof.html              Minimal browser proof page
│   ├── src/
│   │   ├── main.ts             Browser preparation, activation, cleanup
│   │   ├── preparation-lifecycle.ts
│   │   ├── protocol.ts         Initialization/runtime control protocol
│   │   ├── pcm-protocol.ts     PCM transport types and validation
│   │   ├── pcm-worker-pool.ts  Transferable pool and paced producer
│   │   ├── pcm-worker.ts       Dedicated worker entry point
│   │   ├── render-adapter.ts   Wasm memory views and browser output mapping
│   │   └── worklet-processor.ts
│   └── test/                  Six Bun test files
│
├── tools/
│   ├── build-worklet.ts
│   ├── check-wasm-memory.ts
│   ├── check-worklet-kernel.ts
│   ├── audit-worklet.ts
│   └── serve-proof.ts
│
├── package.json               Bun scripts and TypeScript dependencies
├── bun.lock                   Exact JavaScript dependency resolution
├── tsconfig.json              Strict TypeScript configuration
├── README.md                  Status and development entry point
├── AGENTS.md                  Repository-specific agent instructions
└── docs/                      Foundations, architecture, plan, evidence
```

Generated or installed directories are ignored:

- `target/`: Rust build products.
- `node_modules/`: JavaScript dependencies.
- `web/src/generated/`: wasm-bindgen JavaScript and type bindings.
- `web/dist/`: built browser assets.

### One package, not a workspace

In Rust terminology:

- A **package** is described by `Cargo.toml`.
- A **crate** is a compilation unit.
- A **module** organizes code within a crate.

This repository has one Rust package with a library crate. It does not have a multi-crate workspace or a native application entry point.

That is why there is no `src/main.rs` and no ordinary application to launch with `cargo run`.

### Target-specific compilation

In [`src/lib.rs`](../src/lib.rs#L166):

```rust
mod prepared_pcm;

#[cfg(all(test, target_os = "macos"))]
mod cpal_host;

#[cfg(target_arch = "wasm32")]
mod worklet_wasm;
```

Read this as:

- Include the shared PCM module.
- Include the CPAL host **only in macOS test builds**.
- Include the Wasm adapter **only when compiling for Wasm**.

`#[cfg(...)]` is a compile-time condition, not an `if` executed during rendering.

### Dependencies

[`Cargo.toml`](../Cargo.toml) pins:

- CPAL `0.18.2`: native device integration, macOS only.
- `rtrb` `0.4.0`: bounded single-producer/single-consumer queues, macOS only.
- `wasm-bindgen` `0.2.127`: Wasm/JavaScript bindings, Wasm only.

The shared processing code has no target-independent third-party dependency.

The library emits:

- `rlib`: Rust library form.
- `cdylib`: a library form suitable for external integration, including this Wasm build.

Rust is pinned to **1.98.0**, using the **2024 edition**. Edition and compiler version are related but different: the edition selects language compatibility rules; the toolchain selects the actual compiler.

---

## 4. The Rust syntax that carries the design

You do not need to understand every Rust feature before reading this repository. These are the important ones.

### Structs and methods

```rust
struct PreparedKernel {
    gain: f32,
    phase: f64,
    next_frame: u64,
}
```

A `struct` groups fields. An `impl PreparedKernel` block supplies its methods.

Common types here:

| Type | Meaning |
|---|---|
| `f32` | 32-bit floating-point sample |
| `f64` | Higher-precision floating-point calculations |
| `u32`, `u64` | Unsigned integers of fixed width |
| `usize` | Platform-sized type used for indexing and lengths |
| `bool` | Boolean |

### Ownership versus borrowing

These are different:

```rust
Box<[f32]>  // owns a heap allocation containing samples
&[f32]      // borrows samples for reading
&mut [f32]  // exclusively borrows samples for reading/writing
```

A slice includes a length. It is not just a raw pointer.

The distinction is central:

- A block **owns** its sample storage.
- A renderer temporarily **borrows** output storage.
- Moving the block transfers ownership of its allocation.
- Borrowing output does not transfer ownership or cause the renderer to free it.

### `&self` and `&mut self`

```rust
fn counters(&self) -> PcmCounters
fn render(&mut self, ...)
```

- `&self`: temporarily borrow the object read-only.
- `&mut self`: temporarily borrow it exclusively so its state can change.

The renderers require exclusive mutable access because phase, offsets, queues, and counters change between calls.

### Enums carry alternatives

```rust
enum PcmOutput<'a> {
    Mono(&'a mut [f32]),
    Stereo {
        left: &'a mut [f32],
        right: &'a mut [f32],
    },
}
```

This resembles a TypeScript discriminated union, but Rust checks the alternatives and borrowing rules at compile time.

The lifetime `'a` means the output wrapper contains borrowed buffers that must remain valid while used. It is not a runtime timer. `'_` lets the compiler infer the lifetime.

### `Option` and `Result`

```rust
Option<Block>         // Some(block) or None
Result<Kernel, Error> // Ok(kernel) or Err(error)
```

These make absence and failure explicit.

```rust
let Some(block) = source.pop_ready() else {
    break;
};
```

means:

> Obtain a block; if none is ready, leave the loop.

The `?` operator propagates an error—or `None` in an `Option`-returning function—without continuing down the successful path.

### Visibility

Most engine types use `pub(crate)`:

> Other modules in this crate may use this, but external Rust consumers may not.

This is intentional. The project has not committed to a public engine API.

---

## 5. `src/lib.rs`: the original oscillator kernel

The most approachable starting point is [`PreparedKernel`](../src/lib.rs#L53).

It implements:

```text
sine oscillator → scalar gain → mono or duplicated stereo
```

### State

The kernel owns only scalar state:

- Output layout.
- Gain.
- Current phase.
- Phase increment.
- Next render-frame index.
- Maximum frames per call.
- Terminal flag.

It does **not** own an audio buffer.

The caller supplies buffers:

```rust
kernel.render(Output::Stereo {
    left: &mut left,
    right: &mut right,
});
```

That call lends the kernel temporary permission to fill the two arrays.

### Preparation

[`PreparedKernel::prepare`](../src/lib.rs#L63) checks:

- Sample rate is finite and positive.
- Gain is finite.
- Frequency is finite and nonnegative.
- Frequency is below half the sample rate.

It computes:

```text
phase increment = 2π × frequency / sample rate
```

Initial phase and frame clock are zero.

Gain is not restricted to `0..1`. Negative gain and values above one are accepted. There is no clipping stage.

### Rendering

The essential calculation is:

```rust
*sample = phase.sin() as f32 * gain;
phase += phase_increment;
if phase >= TAU {
    phase -= TAU;
}
```

A few Rust details:

- `sample` is a mutable reference.
- `*sample = ...` writes through that reference.
- `sin()` operates on the `f64` phase.
- `as f32` converts the result to the sample format.
- `TAU` is `2π`.

**The current phase is emitted before advancing.**

For stereo, the code calculates one sample, writes it to both channels, and advances phase once.

### A concrete example

With an artificial sample rate of 8 Hz and a 1 Hz oscillator:

```text
phase increment = π / 4

frame:   0      1       2      3       4
sample:  0    ≈0.707    1    ≈0.707   ≈0
```

Rendering those frames as:

```text
one call:   [5]
two calls:  [2, 3]
five calls: [1, 1, 1, 1, 1]
```

produces the same arithmetic sequence.

That is **partition independence**: callback boundaries do not change the generated signal.

### Clock handling

`next_frame: u64` identifies the next frame to generate.

Before writing samples, the kernel uses `checked_add` to ensure the frame clock can advance without overflowing.

This is different from phase:

- Phase is a wrapping floating-point position within a waveform cycle.
- The frame clock is an integer count of generated frames.

### Error behavior

The ordering in [`render`](../src/lib.rs#L94) matters:

| Condition | Behavior |
|---|---|
| Wrong layout or unequal stereo lengths | Silence all supplied samples; return `InvalidLayout` |
| Valid zero-frame output | Strict no-op; return `Rendered` |
| Already terminal | Silence; return `Terminal` |
| Too many frames | Silence; latch terminal; return `CapacityExceeded` |
| Clock overflow | Silence; return `ClockOverflow`, without advancing state |
| Valid request | Generate samples and advance state |

An over-capacity call permanently rejects later nonempty renders on that instance.

A valid zero-frame call still succeeds after terminal failure. It does not revive the instance; it simply does nothing.

### Why most of the file is tests

The kernel implementation is small. The rest establishes:

- Initial phase and gain behavior.
- Identical stereo duplication.
- Partition independence.
- Zero-frame behavior.
- Capacity and overflow handling.
- Invalid numeric configuration handling.
- No observed allocations on selected warmed render paths.

These tests are the current specification for the kernel’s exact behavior.

---

## 6. `src/prepared_pcm.rs`: the shared PCM boundary

This is the center of the **current** host proofs.

Instead of calculating samples itself, it consumes already-prepared PCM.

Its main job is:

> Turn independently sized input blocks into the number of frames requested now, while preserving bounded ownership and explicit failure behavior.

### Stream configuration versus block metadata

[`StreamSpec`](../src/prepared_pcm.rs#L19) describes the stream:

```rust
struct StreamSpec {
    layout: ChannelLayout,
    sample_rate: u32,
    source_id: u64,
}
```

[`BlockMeta`](../src/prepared_pcm.rs#L32) describes one block:

| Field | Meaning |
|---|---|
| `slot_id` | Which reusable storage slot this block belongs to |
| `epoch` | Which source generation produced it |
| `source_frame_start` | Source-coordinate label for its first frame |
| `valid_frames` | How much of the allocated storage contains valid audio |
| `discontinuity` | Metadata indicating a source discontinuity |
| `end_of_stream` | This block contains the final frames |

Capacity and valid length are separate. A 256-frame slot can contain fewer than 256 valid frames.

### Traits define the source boundary

In [`prepared_pcm.rs:104`](../src/prepared_pcm.rs#L104):

```rust
trait PreparedBlock {
    fn meta(&self) -> BlockMeta;
    fn planes(&self) -> PlanarBlock<'_>;
}

trait PreparedBlockSource {
    type Block: PreparedBlock;

    fn pop_ready(&mut self) -> Option<Self::Block>;
    fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block>;
    fn scan_limit(&self) -> usize;
}
```

A **trait** describes required behavior.

`type Block: PreparedBlock` is an associated type:

> Each source implementation chooses its concrete block type, and that type must expose metadata and sample planes.

The generic adapter:

```rust
PreparedPcmInput<S: PreparedBlockSource>
```

means:

> A PCM input parameterized by a source implementation satisfying this interface.

The same render algorithm can therefore use:

- A native queue-backed source.
- A Wasm-local fixed-slot source.
- A test source.

The render loop does not need to know about CPAL or `MessagePort`.

This uses concrete generic types, not a runtime `dyn` plugin interface.

### The most important signature

```rust
fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block>;
```

The error contains **the block itself**.

Read it as:

```text
Ok(())     → the source accepted ownership back
Err(block) → it could not accept ownership; keep this block
```

That is more than error reporting. It is an ownership contract.

If a retirement queue is full, the callback cannot simply discard a heap-owning block: dropping its final owner could deallocate its sample storage during rendering.

Instead, it retains the block for a later attempt.

### Adapter state

[`PreparedPcmInput`](../src/prepared_pcm.rs#L135) contains:

- Stream specification and active epoch.
- Maximum callback size.
- The source.
- An optional current block.
- An offset into that block.
- An optional block awaiting retirement.
- Ended and terminal flags.
- Fixed-width counters.

There is no growing list of outstanding blocks.

### The render loop

[`PreparedPcmInput::render`](../src/prepared_pcm.rs#L186) does this:

1. Validate output layout and capacity.
2. Handle zero-frame and terminal conditions.
3. Clear output to silence.
4. Retry any blocked retirement.
5. Obtain a ready block if none is current.
6. Validate its metadata and epoch.
7. Copy as many frames as fit.
8. Retain a partial block or retire an exhausted block.
9. Continue until output is full, input is unavailable, EOS is reached, or the scan bound is reached.
10. Count starvation if appropriate.

Only newly popped blocks count toward `scan_limit()`. Both current host sources return four, preventing an unbounded scan through rejected input.

### Following a block across callbacks

Suppose input contains:

```text
A: frames 0–3
B: frames 4–7
C: frames 8–9, EOS
```

The host requests:

```text
1 frame → 3 frames → 5 frames → 1 frame
```

The adapter behaves like this:

| Request | Work |
|---|---|
| 1 | Copy A[0]; keep A at offset 1 |
| 3 | Copy A[1..4]; retire A |
| 5 | Copy all of B, retire it, then copy C[0] |
| 1 | Copy C[1]; retire C and mark ended |

Neither the host nor producer needs to choose matching block sizes.

### Starvation is not terminal failure

If only four frames are available for a five-frame request:

```text
[audio, audio, audio, audio, silence]
```

The callback finishes without waiting.

It increments `starvation_callbacks` once and returns `Rendered`.

Thus:

> `Rendered` means the request was processed successfully under its policy—not that every output frame came from source audio.

The counter measures affected callbacks, not missing frames.

### EOS is different from starvation

After consuming a valid nonempty EOS block:

- Subsequent output is silent.
- Starvation is not incremented.
- Further ready blocks are not consumed until ended state is cleared.

A zero-length EOS marker is not supported; valid blocks must contain at least one frame.

### Epochs reject old generations

An epoch is a generation number, useful when a source is replaced or eventually seeks.

```text
active epoch: 3

block epoch 2 → stale; reject
block epoch 3 → eligible
block epoch 4 → invalid future epoch; reject
```

Changing the active epoch also causes a partially consumed old block to be rejected on a subsequent render.

However, `set_active_epoch` is **not a full seek implementation**. It does not reposition a decoder, coordinate a worker, reset counters, or clear terminal failure.

### Important: timestamps are not scheduling yet

The adapter checks that:

```text
source_frame_start + valid_frames
```

does not overflow.

It does **not** use source positions to schedule playback, fill timestamp gaps, reject overlaps, or enforce continuity.

For example, blocks labeled source frames `10–13` and `30–33` are concatenated directly. There is an explicit test for that behavior.

Similarly:

- `discontinuity` is carried but does not trigger processing behavior.
- This adapter has no continuous output-frame clock.
- It does no gain, mixing, resampling, clipping, or sample sanitization.

Those are deliberately outside this proof.

---

## 7. Owned blocks and the Wasm-local slot pool

### `OwnedPcmBlock`

In [`prepared_pcm.rs:335`](../src/prepared_pcm.rs#L335), each owning block contains:

```rust
left: Box<[f32]>,
right: Box<[f32]>,
```

Storage is created before rendering:

```rust
vec![0.0; capacity].into_boxed_slice()
```

This allocates and initializes samples, then gives the block fixed-length owned storage.

**Moving a block does not copy the underlying PCM allocation.** It transfers its owning handle and metadata.

### `Option::take()` makes ownership movement explicit

You will repeatedly see:

```rust
let block = self.current.take();
```

If `current` contains a block, `take()`:

1. Moves the block out.
2. Leaves `None` behind.

This makes “this location no longer owns that block” explicit and compiler-checked.

By contrast:

```rust
self.current.as_ref()
```

only borrows the contained block.

The render loop briefly borrows sample planes, finishes copying, then moves the exhausted block into retirement.

### `FixedSlotSource<const N: usize>`

[`FixedSlotSource`](../src/prepared_pcm.rs#L395) provides the browser-side Rust storage.

`const N: usize` is a **const generic**: the number of slots is part of the type.

```rust
FixedSlotSource<4>
```

contains fixed arrays for:

- Four optional owned blocks.
- Four state values.
- Four queued slot IDs.

The lifecycle is:

```text
FREE
  ↓ reserve
RESERVED
  ↓ copy samples and admit metadata
QUEUED
  ↓ pop_ready
READING
  ↓ retire
FREE
```

Invalid or duplicate ownership transitions are rejected.

The queue contains IDs, not copies of sample arrays.

This structure is **not a cross-thread atomic queue**. Its normal Rust fields are accessed through exclusive mutable ownership. Browser message transport exists outside it.

### The deterministic signal

The current workers generate the same simple fixture:

```text
base = ((source_frame modulo 1024) - 512) / 16384

left  = base
right = -base
```

It is a repeating ramp made from exactly representable binary fractions.

It is not:

- The sine oscillator.
- Decoded media.
- A production synthesizer.

The opposite-polarity stereo channels make channel mapping easy to test—but they cancel if averaged into mono. That explains the browser analyser routing later.

---

## 8. `src/cpal_host.rs`: the native macOS proof

The entire file is currently **private, macOS-only test infrastructure**.

There is no native application or public host API.

### Native topology

```text
Worker thread                           Audio callback
─────────────                           ──────────────
owns free blocks
fills generated PCM
      │
      └── ready SPSC ring ─────────────► PreparedPcmInput
                                               │
                                               ▼
                                        planar scratch
                                               │
                                               ▼
                                        interleaved device output
                                               │
      ◄── retired SPSC ring ────────────────────┘
reuses returned blocks
```

**SPSC** means single producer, single consumer.

There are:

- Two rings, each capacity four.
- **Four total PCM blocks**, not four per ring.
- 1,024 frames per PCM block.
- A 4,096-frame prepared callback capacity.

These are proof constants, not permanent product limits.

### The worker

[`spawn_pcm_worker`](../src/cpal_host.rs#L185):

1. Creates four owning blocks.
2. Fills them with generated samples.
3. Pushes them into the ready ring.
4. Receives retired blocks.
5. Refills and republishes them.

When no block is free, it does not allocate a replacement. It yields when no progress is possible.

This is a simple polling/yielding proof worker, not a production scheduling strategy.

### Preparing the callback

[`CallbackProcessor::prepare`](../src/cpal_host.rs#L279):

- Accepts only mono or stereo.
- Creates `PreparedPcmInput<NativeSource>`.
- Allocates planar scratch storage.
- Initializes observations and failure state.

The callback owns this state directly. It does not share a mutable renderer behind a mutex.

### Processing device output

[`CallbackProcessor::process`](../src/cpal_host.rs#L330):

1. Fills the entire device buffer with format-correct silence.
2. Checks host and previously latched failures.
3. Checks that sample count is divisible by channel count.
4. Computes actual frames:

   ```text
   frame count = interleaved sample count / channel count
   ```

5. Rejects requests beyond prepared capacity.
6. Renders PCM into the active prefix of planar scratch.
7. Converts and interleaves successful output.
8. Publishes diagnostic counters.

Unsigned sample formats use their equilibrium value for silence, not necessarily numeric zero.

### Generics adapt sample formats

```rust
fn process<T>(&mut self, output: &mut [T])
where
    T: Sample + FromSample<f32>,
```

means:

> Process an output sample type that supports audio sample behavior and conversion from `f32`.

The format-dispatch function selects concrete implementations such as `f32`, `i16`, or CPAL’s 24-bit wrappers.

Stereo interleaving uses iterators. The iterator chain does not build an intermediate `Vec`.

### A `move` closure owns the renderer

In [`build_stream`](../src/cpal_host.rs#L490):

```rust
move |output: &mut [T], _| {
    processor.process(output);
}
```

`move` transfers the processor into the callback closure.

It can then retain its state across callbacks after `build_stream` returns.

This is one of the strongest practical examples of Rust ownership in the repository: **the audio callback has one clear owner of its mutable processing state.**

### Atomics and shutdown

`Arc<AtomicBool>` shares stop/readiness flags between worker and control code.

- `Arc` shares ownership.
- `AtomicBool` permits synchronized flag access.
- `Arc` alone would not make arbitrary mutable fields safe.

Worker shutdown sets the stop flag and joins the thread. `Drop` also performs shutdown so ordinary scope exit cleans up the worker.

Joining happens outside rendering.

### Observations

The callback records:

- Callback count.
- Minimum/maximum frame sizes.
- Up to eight distinct frame sizes.
- A truncation flag if more sizes occur.
- Starvation, stale, invalid, and retirement-backpressure counters.
- Local processing-time overruns.
- Failure codes.

A fixed observation array avoids allocating whenever a new callback size appears.

The deadline counter is narrow: it compares measured project processing time with the current audio duration. It is **not** an end-to-end hardware underrun detector.

### The live entry point

[`observe_default_macos_output_for_five_seconds`](../src/cpal_host.rs#L794) is an ignored test that:

- Opens the default output device.
- Uses its default configuration.
- Runs the generated PCM proof for five seconds.
- Stops and prints observations.

**It can produce audible output.** Normal test runs do not execute it.

---

## 9. `src/worklet_wasm.rs`: Rust exposed to JavaScript

[`WorkletKernel`](../src/worklet_wasm.rs#L22) wraps the shared PCM adapter for Wasm.

Despite the name, it currently wraps **prepared PCM**, not `PreparedKernel`’s oscillator.

### What wasm-bindgen does

```rust
#[wasm_bindgen]
pub struct WorkletKernel { ... }
```

and the attribute on its `impl` tell wasm-bindgen to generate JavaScript bindings.

JavaScript can then do:

```typescript
const kernel = new WorkletKernel(...);
kernel.render(frameCount);
```

This is a private proof binding, not a stable product API.

### What it owns

- `PreparedPcmInput<FixedSlotSource<4>>`.
- Fixed left/right output storage.
- Preparation status.
- Terminal state.

It exposes methods for:

- Reserving/canceling slots.
- Obtaining slot pointers.
- Admitting block metadata.
- Setting the lower-level epoch.
- Rendering.
- Reading counters and output pointers.

### Numeric statuses

The bridge uses small numeric statuses:

| Value | Meaning |
|---:|---|
| 0 | Rendered / admission accepted |
| 1 | Invalid layout |
| 2 | Capacity exceeded |
| 3 | Terminal |
| 5 | Admission rejected |

Preparation has separate error values.

This avoids formatting strings in the render path.

### Pointers become byte offsets

Rust exposes sample pointers. In JavaScript they become numeric offsets into Wasm linear memory:

```typescript
new Float32Array(memory.buffer, kernel.left_ptr(), maximumFrames)
```

This creates a **view**, not a copy.

- The offset is measured in bytes.
- The length is measured in `f32` elements.
- The samples remain in Wasm memory.

### `u64` becomes `bigint`

Source identifiers, epochs, and counters use Rust `u64`.

The generated interface uses JavaScript `bigint` for these values. That is why the bridge uses:

```typescript
BigInt(message.epoch)
BigInt(message.sourceFrameStart)
```

Diagnostic snapshots convert counters back to ordinary numbers; those snapshots are not a full-range exact `u64` interface.

---

## 10. The browser path, end to end

The browser has three distinct execution environments:

```text
Main thread                 Dedicated worker            AudioWorklet
───────────                 ────────────────            ────────────
UI and lifecycle            generate PCM                receive/admit blocks
fetch/compile Wasm          own transfer pool            execute Wasm renderer
create context/node         pace production              fill browser outputs
      │                           │                           │
      └── bootstrap/control ──────┴───────────────────────────┘
                                  │                           │
                                  └── direct MessageChannel ──┘
```

Bun builds and tests this code. **The browser**, not Bun, executes the AudioWorklet.

### `main.ts`: prepare first, activate separately

[`prepareProof`](../web/src/main.ts#L212):

1. Creates an `AudioContext` and ensures it is suspended.
2. Fetches and compiles Wasm on the main thread.
3. Loads the worklet module.
4. Creates a dedicated worker and `MessageChannel`.
5. Transfers one channel port to each side.
6. Creates the disconnected `AudioWorkletNode`.
7. Waits for worker and worklet readiness.
8. Returns a `PreparedProof`.

The default proof uses:

- Four transferable slots.
- 256 frames per slot.
- Source ID 3.
- Epoch 1.
- The context’s sample rate.
- Stereo and a 1,024-frame callback maximum from the UI.

Readiness means setup succeeded. It does not prove all initial PCM blocks have already been admitted or guarantee starvation-free activation.

### `protocol.ts`: explicit control states

[`InitializationGate`](../web/src/protocol.ts#L37) tracks:

```text
pending → ready
        → failed
```

It rejects malformed or duplicate initialization messages and records coded failures.

Separate runtime-failure messages let the worklet report transport failures after initialization.

### `preparation-lifecycle.ts`: avoid overlapping proof instances

[`PreparationLifecycle`](../web/src/preparation-lifecycle.ts#L5):

- Rejects concurrent preparation.
- Closes an old proof before replacing it.
- Tracks the active proof.

This is resource-lifecycle coordination, not audio DSP.

### `pcm-worker-pool.ts`: transferable ownership

The worker owns four ordinary `ArrayBuffer`s.

For stereo, each holds:

```text
256 left floats + 256 right floats
= 512 × 4 bytes
= 2,048 bytes
```

Worker slot states are:

```text
FREE → IN_FLIGHT → FREE
                → RETRY → IN_FLIGHT
```

Sending with a transfer list:

```typescript
port.postMessage(block, [block.buffer]);
```

detaches the sender’s buffer and transfers usable ownership to the receiver.

The worker cannot keep writing the sent buffer.

### Two different pools

This is easy to miss:

1. The worker has **four transferable buffers**.
2. Wasm has **four separate fixed PCM slots**.

They are not the same allocations.

The worklet:

1. Receives a transferable buffer.
2. Reserves the corresponding Wasm slot.
3. Copies valid samples into Wasm.
4. Admits metadata.
5. Immediately transfers the worker buffer back with an admission result.

**Admission acknowledgment is not playback completion.**

The worker may already own its returned buffer while the earlier copied samples are still queued or being read in Wasm.

If it sends another block for a busy Wasm slot, admission is rejected and the same pending source block is retained for retry.

### Producer pacing

[`FixedPcmProducer`](../web/src/pcm-worker-pool.ts#L110):

- Prefills four blocks while suspended.
- Deliberately probes exhaustion.
- Does not continue producing merely because buffers return before activation.
- After activation, schedules at most one pending timer.
- Sends at most one block per timer.
- Fails after 64 consecutive admission rejections.

At 48 kHz, its 256-frame pacing delay rounds up to 6 ms.

This is a bounded proof producer—not a production decoder or sample-accurate scheduler.

[`pcm-worker.ts`](../web/src/pcm-worker.ts) connects that producer to actual worker messages and ports.

### `pcm-protocol.ts`: validate messages at runtime

TypeScript types disappear at runtime, so incoming messages are checked explicitly.

[`pcm-protocol.ts`](../web/src/pcm-protocol.ts) validates:

- Slot IDs and frame counts.
- Safe integer metadata.
- Boolean flags.
- Actual `ArrayBuffer` storage.
- Exact full-capacity byte length.

Even a partially valid block must carry the full-sized reusable buffer.

### `worklet-processor.ts`: keep the callback small

[`KkbPreparedKernelProcessor`](../web/src/worklet-processor.ts#L28) performs setup in its constructor:

- Validates options.
- Instantiates the precompiled Wasm module.
- Creates `WorkletKernel`.
- Creates cached memory views through the adapter.
- Installs the transport handler.
- Reports ready or failed.

Its `process()` method either delegates to the adapter or fills silence.

PCM messaging happens in the worklet’s **message handler**, not inside `process()`.

However, that handler is still in the AudioWorklet environment. “Outside `process()`” does not mean “on a completely separate worker thread.”

### `render-adapter.ts`: map Wasm into browser output

[`PreparedPlanarAdapter`](../web/src/render-adapter.ts#L49) constructs all output and slot views during preparation.

Each callback:

1. Checks the cached Wasm memory identity and size.
2. Validates output/channel shape.
3. Reads the actual channel-array length.
4. Checks capacity.
5. Calls `kernel.render(actualFrameCount)`.
6. Copies Wasm output into browser-owned channel arrays.

It never assumes a 128-frame callback.

On failure, it latches a code and permanently silences later output instead of trying to repair memory or resize buffers during rendering.

### The real copy boundaries

This path is **not end-to-end zero-copy**:

```text
worker ArrayBuffer
    │ transfer ownership
    ▼
worklet message handler
    │ COPY
    ▼
Wasm PCM slot
    │ COPY during Rust render
    ▼
Wasm output plane
    │ COPY
    ▼
browser-owned output channel
```

The key properties are bounded storage and explicit ownership—not zero copies everywhere.

### Activation and the muted analyser

[`PreparedProof.activate`](../web/src/main.ts#L107) connects:

```text
worklet
   ↓
channel splitter: select left channel
   ↓
analyser
   ↓
gain = 0
   ↓
audio destination
```

The splitter avoids cancellation from opposite-polarity stereo samples.

After approximately 300 ms, the main thread:

- Checks whether the analyser saw any nonzero sample.
- Requests a worklet snapshot.
- Returns diagnostic results.

It is intentionally muted.

### Failure and cleanup

Important distinctions:

- **Well-formed but busy admission:** return the buffer and retry.
- **Malformed transferred PCM:** terminal worklet transport failure.
- **Malformed admission return:** terminal worker failure.
- **Starvation:** output silence and count it; do not terminalize.
- **Output/memory/render failure:** latch adapter silence.

Main-thread runtime cleanup disconnects the node, terminates the worker, and suspends the context. `close()` closes resources idempotently.

### No live browser seek/reset yet

The Rust wrapper exposes `set_epoch`, but the TypeScript path does not call it or define a corresponding live-control message.

Preparing again means:

```text
close old proof → create a new context/worker/node/state
```

It is not an in-place seek or epoch transition.

### The page

[`web/proof.html`](../web/proof.html) contains only:

- Prepare stereo proof.
- Activate muted proof.
- Inject preparation failure.
- Close.
- A diagnostic result panel.

It is a proof interface, not a player UI.

---

## 11. Build and validation tooling

### `tools/build-worklet.ts`

The build pipeline is:

```text
Rust
  ↓ cargo build for wasm32
raw Wasm
  ↓ wasm-bindgen
Wasm + generated JS bindings
  ↓ Bun.build
main.js + pcm-worker.js + worklet-processor.js
```

The script:

- Requires exact expected tool versions.
- Builds release Wasm.
- Recreates generated/output directories.
- Generates bindings.
- Applies a narrow, checked transform to generated glue.
- Bundles the three browser entry points.
- Copies HTML and Wasm into `web/dist`.

The transform removes worklet-inappropriate error-string decoding and console-warning behavior from the pinned generated glue.

It deliberately fails if the expected generated source changes, forcing a new audit.

### `.cargo/config.toml`

Wasm initial and maximum memory are both:

```text
16,777,216 bytes = 16 MiB = 256 Wasm pages
```

One Wasm page is 65,536 bytes.

Equal initial and maximum sizes prevent this artifact from growing its linear memory beyond preparation.

### `tools/check-wasm-memory.ts`

Parses the emitted Wasm memory section and verifies:

- One defined memory.
- Unshared memory.
- Minimum and maximum of 256 pages.
- One exported memory named `memory`.

This checks the artifact, rather than merely trusting linker configuration.

### `tools/check-worklet-kernel.ts`

Exercises real generated bindings and Wasm directly under Bun:

- Reserves and admits blocks.
- Rejects duplicate reservation.
- Renders partitions of 3 and 5 frames.
- Checks expected sample values.
- Checks stale rejection and starvation.
- Checks capacity/terminal behavior.

This bridges a gap left by tests using fake Wasm bindings.

### `tools/audit-worklet.ts`

Inspects built JavaScript for forbidden facilities and callback-local construction.

It checks for things such as:

- Networking and logging.
- Shared memory and atomics.
- Worker/context creation.
- Callback-local arrays/views.
- Callback messaging or scheduling.

This is a targeted source-pattern audit, not a formal proof that the JavaScript engine allocates nothing.

### `tools/serve-proof.ts`

A small Bun static server serves only the known proof assets with correct content types and `no-store`.

It defaults to port 4173 and is development proof tooling, not a production backend.

### Package scripts

[`package.json`](../package.json) combines the browser checks:

```sh
bun run check
```

runs:

```text
build → typecheck → tests → memory check → direct Wasm check → source audit
```

The `node:` imports in tool scripts are compatibility APIs used under Bun; they do not imply that Node runs the browser audio path.

---

## 12. Tests: what they establish, and what they do not

### Rust tests

The current macOS test build has:

| Area | Passing non-device tests |
|---|---:|
| Oscillator kernel | 14 |
| Prepared PCM | 9 |
| Native adapter/worker | 6 |
| Total | **29** |

One additional test opens the audio device and is ignored by default.

Rust unit tests live beside implementation code inside `#[cfg(test)]` modules. This lets them inspect private state without creating a public API just for testing.

### Bun tests

All six files have distinct roles:

| File | Coverage |
|---|---|
| `web/test/protocol.test.ts` | Initialization and runtime-message validation |
| `web/test/preparation-lifecycle.test.ts` | Exclusive preparation and close-before-replace |
| `web/test/pcm-transport.test.ts` | Pool capacity, transfers, recycling, retries, deterministic samples |
| `web/test/render-adapter.test.ts` | Output mapping, capacity, memory identity, failure silence |
| `web/test/worklet-transport.test.ts` | Malformed transferred PCM terminal handling |
| `web/test/main.test.ts` | Activation, startup/runtime failures, timeout and cleanup |

Several use mocked browser or Wasm objects. Some use real Bun `MessageChannel` transfers. These are useful but are not equivalent to executing in a real browser AudioWorklet.

### The allocator probe

[`src/lib.rs`](../src/lib.rs#L190) installs a test-only allocator wrapper around Rust’s system allocator.

It counts:

- Allocations.
- Zeroed allocations.
- Reallocations.
- Deallocations.

Tests prepare and warm state, enable counting on the measured thread, execute selected paths, disable counting, and inspect results.

A mutex serializes the probes **outside the render function**.

This is the principal `unsafe` implementation in the inspected Rust source: wrapping the allocator requires following raw-pointer and layout contracts. The ordinary render loops use safe Rust.

The evidence is:

> No allocator calls were observed in the specific warmed paths measured.

It does not establish that:

- Arbitrary `PreparedBlockSource` implementations cannot allocate.
- JavaScript engines or host libraries never allocate.
- Every possible error path has been measured.
- OS scheduling meets every deadline.
- The system is hard-real-time safe.

### Checks I ran

All passed:

- `cargo fmt --check`
- Debug Rust tests: **29 passed, 1 ignored**
- Release Rust tests: **29 passed, 1 ignored**
- Strict native Clippy
- Strict Wasm-target Clippy
- Bun tests: **29 passed**
- TypeScript checking

**Environment limitation:** installed Bun is **1.4.1**, while the full build requires **1.4.0**. I did not change tooling or rerun the complete pinned `bun run check` artifact pipeline.

I also did not open a device or rerun browser observations.

---

## 13. How the documentation fits together

The documentation has three different purposes.

### Foundations: learn the subject

- [`2026-08-27-digital-audio-from-first-principles.md`](./2026-08-27-digital-audio-from-first-principles.md)\
  Samples, frames, PCM, buffers, codecs, and rendering. Best first read if audio terminology is unfamiliar.

- [`2026-08-27-psychoacoustics.md`](./2026-08-27-psychoacoustics.md)\
  What measurements do—and do not—say about perception. Background for future metering, processing, and listening claims; not an implemented analysis subsystem.

### Architecture and sequencing

- [`2026-08-28-kkb-audio-system-architecture.md`](./2026-08-28-kkb-audio-system-architecture.md)\
  Canonical architecture, terminology, invariants, future product boundaries, and unresolved decisions.

- [`2026-08-29-initial-render-engine-validation-plan.md`](./2026-08-29-initial-render-engine-validation-plan.md)\
  The implementation sequence and evidence required at each stage.

- [`2026-07-31-audio-engine-runtime-architecture.md`](./2026-07-31-audio-engine-runtime-architecture.md)\
  Superseded historical pointer. Not active architecture guidance.

- [`NOTES.md`](./NOTES.md)\
  Early vision and dependency ideas, not the current dependency list.

### Recorded evidence

- [`2026-08-29-milestone-2-dual-host-kernel-evidence.md`](./2026-08-29-milestone-2-dual-host-kernel-evidence.md)\
  Historical oscillator-based native/browser observations.

- [`2026-09-01-milestone-3-bounded-pcm-transport-evidence.md`](./2026-09-01-milestone-3-bounded-pcm-transport-evidence.md)\
  Current bounded PCM claim, ownership behavior, tests, exact observed configurations, and limitations.

Milestone 3 records:

- A five-second macOS CPAL run.
- A short muted managed headless Chrome run.
- Configuration-specific results—not broad compatibility or sustained-performance certification.

It also explicitly notes that the final malformed admission-return correction was automatically validated **after** the recorded browser observation.

Finally, `docs/agents/domain.md`, `issue-tracker.md`, and `triage-labels.md` govern agent/documentation/GitHub workflow. They are not runtime components.

---

## 14. The best order to read the code yourself

I would use this sequence:

1. **`src/lib.rs:11–162`**\
   Learn the smallest renderer: types, borrowing, preparation, state, samples.

2. **The analytic and partition tests in `src/lib.rs`**\
   See exactly what “correct” means.

3. **`src/prepared_pcm.rs:19–147`**\
   Learn the stream/block/source vocabulary.

4. **`src/prepared_pcm.rs:186–333`**\
   Follow the consumption and retirement loop.

5. **`OwnedPcmBlock` and `FixedSlotSource`**\
   Understand ownership, `.take()`, fixed arrays, and recycling.

6. **`src/cpal_host.rs:279–400` and `490–535`**\
   See how a host owns and invokes the shared renderer.

7. **`src/worklet_wasm.rs`**\
   Understand how Rust becomes a callable Wasm component.

8. **`web/src/render-adapter.ts` and `worklet-processor.ts`**\
   Follow pointers, views, copies, and actual browser callbacks.

9. **`web/src/pcm-worker-pool.ts` and `pcm-worker.ts`**\
   Trace transferable-buffer ownership.

10. **`web/src/main.ts` and `tools/`**\
    Finish with lifecycle and build integration.

The next planned milestone is the private compiled-plan proof: two oscillators, gains, mixing, observations, and sample-timed automation, followed by integrating this PCM input boundary. **None of that compiled-plan machinery exists yet.**

## The mental model to keep

The repository is exploring three responsibilities:

```text
Producer:
prepare samples without real-time callback restrictions

Transport:
move bounded ownership without losing or duplicating buffers

Renderer:
fill whatever valid output size the host requests, without waiting
```

Rust’s role is particularly visible in the middle:

> **Who owns this buffer now, who may borrow it, and where will its memory eventually be freed?**

Once that question is clear, most of the structs, traits, `Option`s, queue operations, and lifecycle code stop looking like ceremony. They are concrete ways to keep the audio callback’s work predictable.
