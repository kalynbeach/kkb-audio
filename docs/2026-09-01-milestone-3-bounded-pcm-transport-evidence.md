# Milestone 3 bounded PCM transport evidence

Date: 2026-09-01
Status: Complete for the bounded PCM ownership and delivery claim in the exact native and browser proofs recorded below
Issue: [#3](https://github.com/kalynbeach/kkb-audio/issues/3)

## Claim boundary

This private proof establishes one host-neutral prepared-PCM contract and bounded native and browser
transport implementations in the exact configurations recorded below. It does not establish a public
API, production decoding, sample-rate conversion, sustained performance, a final production browser
transport, branded-browser compatibility, minimum-version support, deadline safety, or broad host
support.

## Prepared PCM seam

A stream fixes semantic mono or stereo layout, sample rate, and source identity. Every fixed-capacity
planar block carries a slot ID, epoch, source-frame start, valid frame count, discontinuity flag, and
end-of-stream flag. `PreparedPcmInput` adapts those blocks to variable callback partitions, validates
layout and frame-range metadata, rejects stale and future epochs, zero-fills starvation, and uses
saturating fixed-width counters. It scans at most the source's fixed slot capacity per callback.

A callback can own one current block and one backpressured retirement. If retirement cannot be
published, ownership remains in the prepared input and later callbacks retry; the callback never
releases the final block owner. End-of-stream silence is distinct from starvation.

## Native ownership

The macOS proof uses exactly one worker and two `rtrb` 0.4.0 SPSC rings with four slots. `rtrb` is
exact-pinned and scoped to macOS alongside CPAL. Each slot owns fixed planar storage allocated before
activation. Ownership moves through:

```text
worker free -> worker filling -> ready SPSC -> callback current
callback current -> retired SPSC -> worker free
```

A full push returns the owned value. The worker retains a value when the ready ring is full, and the
callback retains a value when retirement is backpressured. The worker allocates no replacement slot.
The existing CPAL callback shell still derives actual frames, starts with equilibrium silence,
interleaves only a successful render, and latches malformed host failures.

## Browser ownership

While the `AudioContext` is suspended, the main thread creates a dedicated worker and a
`MessageChannel`, transfers one port to the worker, and transfers the other through the worklet's
existing control port. PCM then travels directly between worker and worklet; initialization and
snapshots remain on the node control port.

The worker owns four transferable `ArrayBuffer` slots and allocates no replacement on exhaustion.
Each transfer follows:

```text
worker free -> worker filling -> in flight to worklet -> validating/copying
-> in flight to worker -> worker free
```

The worklet message handler validates metadata and exact byte length, copies into one of four fixed
Wasm slots, attempts admission, and immediately returns the transferable plus that admission result
outside `process()`. A fixed four-block prefill is allowed while the context is suspended, but returned
ownership does not trigger more production until `PreparedProof.activate()` explicitly starts it.
After activation the worker schedules at most one one-block pump at a time; rejected admission retains
and retries the same source block with a fixed limit of 64 paced rejections, approximately 384 ms for
the proof's 48 kHz, 256-frame configuration. The callback reads only fixed Wasm storage. Wasm memory
remains unshared with equal 256-page minimum and maximum. The source audit checks the processor,
generated `WorkletKernel.render(frame_count)` wrapper, adapter `process()` body, and their
callback-reachable failure and silence helpers for collection or view construction and messaging or
scheduling.

## Automated evidence

Rust tests cover deterministic planar PCM across one-shot, one-frame, irregular, split-block, and
cross-block partitions; invalid metadata; stale and future epochs; starvation and EOS; saturating
counters; fixed-slot legal, invalid, and duplicate transitions; retirement backpressure retention;
fixed native worker slot addresses; deterministic native pool exhaustion; and allocator probes around
valid, cross-block, stale, starvation, successful retirement, and backpressured retirement paths.

Bun tests cover exact PCM message validation, fixed transferable capacity, distinct buffers,
deterministic exhaustion, duplicate return rejection, quiescence while suspended, one positively
paced one-block pump, exact metadata and buffer preservation across rejected-block retries, bounded
terminal retry failure, a real Bun `MessageChannel` round trip with sender detachment and
returned-buffer reuse, and deterministic planar sample generation. Prepared-proof tests also verify
dedicated-worker termination for runtime failure and snapshot timeout and idempotent close. The
direct Wasm check admits two blocks, rejects duplicate reservation, renders partitions of 3 and 5
frames across a block boundary, rejects a stale block, checks starvation/stale counters, and checks
terminal capacity behavior.

The built worklet audit reports one synchronous Wasm initialization and processor registration, no
forbidden worklet-wide host facilities, and no forbidden construction in every audited
callback-reachable project body. The Wasm memory check reports 16,777,216 bytes, 256 minimum pages,
256 maximum pages, and no sharing.

## Recorded toolchain and artifacts

The recorded toolchain was:

- `rustc 1.98.0 (88d9e12ae 2026-08-18)`
- `cargo 1.98.0 (797e8a9bc 2026-08-05)`
- Bun 1.4.0
- `wasm-bindgen` 0.2.127
- `rtrb` 0.4.0
- CPAL 0.18.2

The final successful browser run used the corrected source and build with these SHA-256 hashes:

- `kkb_audio_bg.wasm`: `f49ea76c1ad7bbd63c2158fa816a71342c4784e68618b33c5d793ad8bdece2fd`
- `main.js`: `30e88ce85044675caa783b7753822ef432c787e364aca1b85b88ec82c9d3353c`
- `pcm-worker.js`: `d102821bddd389f1563ef36cad80d6457d0d2fef71a9c4880e3d28e6abee4734`
- `worklet-processor.js`: `fcb9b971566791d8ac32201d0868efadb5693ea6eac36ee4c3357d7c55d413d7`
- `index.html`: `e52bab89d9d043dbabb421290a0030c4735fc16306f2eb5269826ef64f438475`

## Recorded CPAL host observation

The optimized ignored CPAL observation command passed for five seconds on macOS 26.6.2 build 25G83,
a MacBookPro18,2 with an Apple M1 Max and 64 GiB of memory. The default device was MacBook Pro
Speakers, negotiated at 48 kHz, two channels, and F32, with a supported buffer range of 15 through
4096 frames. The prepared maximum was 4096 frames, using four slots of 1024 frames.

The result reported `worker_backpressure = 235`, with starvation, stale, invalid, and
retirement-backpressure counts all zero. It recorded 469 callbacks, observed callback sizes `[512]`
without truncation, minimum and maximum callback sizes of 512, zero deadline overruns,
`host_failed = false`, and `failure_code = 0`.

This five-second observation establishes only the bounded ownership and delivery behavior observed on
that exact device and configuration. It is not sustained-load, deadline-safety, performance, or broad
macOS device evidence.

## Recorded browser host observation

The successful short muted observation used `agent-browser` 0.36.0 with its managed
HeadlessChrome/152.0.0.0 on the same macOS and hardware. Its exact user agent was:

```text
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36
```

The document was visible and focused. `crossOriginIsolated` was false and `SharedArrayBuffer` was
undefined. The context was 48 kHz stereo; `renderQuantumSize` was unavailable and reported as null.
The analyser observed semantic-left signal through a `ChannelSplitterNode` before the zero-gain sink.

Initialization reported fixed Wasm memory of 16,777,216 bytes and 256 pages, maximum frames of 1024,
four slots, and an initial worker exhaustion count of one. The snapshot reported failure code zero,
invalid-block count zero, last frame count 128, stable memory, process count two, four slots,
stale-block count zero, and starvation count zero. Console errors and page errors were empty. The
context, worker, browser, and server were closed after the run.

This is evidence for one managed headless Chrome configuration. It is not a declaration of branded
browser support, compatibility, sustained-load behavior, performance, or deadline safety.

## Corrections found during runtime observation

Runtime observation exposed three fixture defects before the final successful run:

- The proof server lacked the `/pcm-worker.js` static route, producing initialization failure code 21.
- A fixed rejection limit of 32 still terminalized with worker code 50 during headless Chrome
  `AudioWorklet` startup. A local generated-artifact diagnostic established that the final fixed limit
  of 64 completed active with failure code zero in this exact configuration; at 48 kHz and 256 frames,
  the bound is approximately 384 ms.
- The deterministic stereo planes are exact opposites, so analyser downmix cancelled them and yielded
  a false signal result. The corrected proof observes the semantic left/mono channel through a
  `ChannelSplitterNode` before the zero-gain sink without changing the planar fixture samples.

The failing attempts and local diagnostic are correction history, not successful evidence runs. The
browser evidence above is from the final successful run using the corrected source and build.

## Acceptance and limitations

Milestone 3 is complete only for bounded PCM ownership and delivery in the exact native and browser
proofs recorded here. The evidence does not establish a production transport, production performance,
sustained-load behavior, deadline safety, a public engine API, a playback application, branded-browser
compatibility, minimum-version support, or broad host and device support.
