# Local media measurements

See the [September 16 measured report](../../docs/2026-09-16-local-media-measurements.md) for the initial results and one proposed follow-up.

Run from the repository root with the installed Bun 1.4.0 and LAME encoder:

```sh
PATH="$PWD/node_modules/.bin:$PATH" bun run measure:media /tmp/local-media-measurements.json
```

Open the printed loopback URL in a desktop browser and click **Run measurements**. The server saves JSON to the requested path and exits. It refuses to overwrite an existing report and stops after ten minutes if no report arrives. Temporary build files and generated audio stay at the printed temporary path for inspection. The command needs the same Rust/Wasm toolchain as `build:worklet` and a `lame` executable.

The runner copies source and Cargo configuration into a temporary directory and uses the existing build script and Wasm memory audit there. It shares the repository's Cargo target cache and installed dependencies. It does not rebuild or serve the repository's `web/dist` or add measurement controls to the player. No network service other than loopback is used.

## Workload and boundaries

Six deterministic, authored tone files cover PCM16 mono WAV at 44.1 kHz, PCM24 stereo WAV at 48 kHz, and LAME CBR 128 kbit/s and VBR quality 2 MP3 at both rates. Short files last ten seconds. Longer WAV, CBR MP3, and VBR MP3 files last three minutes. These exercise the supported formats but are not a corpus of commercial recordings or a worst-case decoder workload. The JSON includes the fixture lengths, encoded sizes, SHA-256 hashes, toolchain, host, browser, source commit and Wasm hash.

Each file runs three times in fixed order with a fresh context and workers. The first run includes initial browser/JIT effects. There is no discarded warmup, cache flush, percentile claim or performance threshold. Files are fetched and turned into browser `File` objects before timing, so file-selection UI and disk/network loading are excluded.

- Preparation runs from `prepareProof` invocation to initial admitted PCM and worklet readiness.
- Waveform analysis starts immediately afterward, as in `PlaybackOwner`, and runs concurrently with the seek and loop measurements. Completion is reported both from readiness and from the original preparation call.
- A late seek requests 90% of the source timeline and waits for the production seek promise. A one-second loop at that position then waits for the production loop-arm promise.
- All contexts remain suspended and use zero listening gain. This measures paused interaction readiness, not audible latency, continuous playback, loop seams or underruns.
- The longer WAV and CBR MP3 each exercise preparation, seek, loop-arm and waveform cancellation. The probe announces the first worker `Blob.arrayBuffer()` call in that operation, then the owner aborts or closes. A rejection is required. The next case cannot begin until every created worker has received `terminate()` and every context is closed. This verifies API cleanup, not the OS thread-reclamation time.

Each timed operation has a 40-second harness deadline, capped by an eight-minute run budget, in addition to production timeouts. Failures save a partial report with an error and make the server exit with a failure code. A hidden document invalidates the run; visibility changes are recorded. There are no unbounded fixture-duration or repetition options.

## Resource instrumentation

A small probe is prepended to workers in the temporary measurement build. Production source and the AudioWorklet are unchanged. Worker resource snapshots are cumulative, so subtract preparation from seek, and seek from loop, to obtain phase deltas.

The probe counts completed Blob reads, returned bytes, largest read, read wait time, worker yield callbacks and their elapsed wait. Yield time includes scheduling delay; it is not CPU time. It observes the instantiated Wasm memory size. Waveform summary bytes and worklet memory/slot counts are recorded separately. The page records main-thread long tasks when the browser supports them.

These are allocation capacities and I/O/work counters, not total browser RSS, peak JavaScript heap, disk I/O or energy measurements. Generated fixture backing stores and browser copies are outside these counters. Instrumentation adds overhead, and OS scheduling or a background tab can change the timings. Use the same browser and workload for comparisons, retain all repetitions, and inspect phase counters before choosing an optimization.
