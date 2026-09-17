# Local media preparation measurements

Measured September 16, 2026, on Apple M1 Max, Darwin 27.0.0, Codex's Chromium 152 browser, with a 48 kHz AudioContext. The document stayed visible. Production source was unchanged at `bb578a6aa5ae02afc9ae933f958626ec82d51770`. The [raw report](2026-09-16-local-media-measurements/results.json) records the toolchain, fixture hashes, Wasm hash, every repetition, resource counters and cancellation results.

The next change worth testing is the waveform worker's yield cadence. The three-minute CBR MP3 waveform took a median **7.86 seconds after playback readiness**, including **6.93 seconds waiting across 1,406 yields**. About 88% of that interval was yield wait. Preparation took 284 ms, the late seek 237 ms, and loop arming 469 ms. Waveform completion dominated the measured wait.

## Scope and reproduction

Run the [separate measurement harness](../tools/measure-local-media/README.md):

```sh
PATH="$PWD/node_modules/.bin:$PATH" bun run measure:media /tmp/local-media-measurements.json
```

The harness uses the production preparation, seek, loop and waveform code in an isolated temporary build. It never changes product UI or the repository's daily `web/dist`. Its six generated tone files cover PCM16/24, mono/stereo, 44.1/48 kHz, CBR/VBR MP3 and 10/180-second durations. LAME encodes complete streams; these are not repeated-frame MP3 fixtures. They represent supported formats, not the complexity of a recording library or the maximum supported duration.

Each file ran three times with fresh workers and contexts, in fixed order. No warmup was discarded. A 90%-position seek and one-second loop arm ran while waveform analysis progressed, matching the owner's independent analysis workflow. Timings include browser preparation overhead but exclude fetching the fixture into a `File`. All audio stayed paused with zero listening gain. These observations do not measure audible latency or sustained playback.

## Timings

Milliseconds, median [minimum-maximum] across three repetitions. Waveform time starts after playback readiness; the raw report also records time from the original preparation call.

| Fixture | Preparation | Seek at 90% | Loop arm at 90% | Waveform completion |
| --- | ---: | ---: | ---: | ---: |
| WAV, 10 s, PCM16 mono, 44.1 kHz | 16.3 [16.0-19.2] | 3.2 [3.1-3.5] | 2.6 [2.5-3.0] | 151.2 [150.3-151.5] |
| WAV, 180 s, PCM24 stereo, 48 kHz | 16.2 [13.1-18.7] | 2.8 [2.5-3.0] | 2.2 [2.1-2.3] | 3331.8 [3245.1-3334.6] |
| CBR MP3, 10 s, mono, 44.1 kHz | 27.7 [25.8-29.6] | 9.7 [9.7-10.2] | 17.7 [17.3-17.7] | 395.3 [393.6-395.9] |
| VBR MP3, 10 s, stereo, 48 kHz | 60.9 [59.8-62.6] | 41.0 [40.9-41.6] | 106.0 [105.1-106.3] | 429.1 [428.3-429.7] |
| CBR MP3, 180 s, stereo, 48 kHz | 283.8 [281.2-289.4] | 237.1 [235.1-239.1] | 468.6 [466.1-471.7] | 7861.1 [7856.6-7986.9] |
| VBR MP3, 180 s, stereo, 44.1 kHz | 782.4 [775.8-823.7] | 705.3 [683.3-714.8] | 1416.4 [1393.8-1418.0] | 7146.2 [7101.7-7158.1] |

The longer CBR MP3's median waveform completion from the original preparation call was 8.15 seconds. VBR and CBR rows differ in rate and content encoding, so this matrix does not isolate bitrate mode as a cause.

## Cancellation and resource observations

All eight active-read cancellation cases passed: preparation, late seeking, loop arming and waveform analysis on the 180-second WAV and CBR MP3. Each cancelled promise rejected within 0.4 ms of the main-thread abort/close request. Cleanup also completed within 0.4 ms. Zero-valued readings mean below timer resolution. These are API acknowledgments after an observed read begins, not worst-case cancellation latency or OS thread-reclamation measurements.

All 46 created workers received `terminate()` and all 26 contexts closed. Cleanup was required before the next case, not only at the end. No main-thread long tasks were reported during this run.

Every sampled playback worker, waveform worker and worklet had a 16 MiB Wasm memory. During analysis that totals 48 MiB of Wasm addressable memory across three instances. The worklet retained four slots. The largest waveform summary was 32,768 bytes. WAV playback reads peaked at 6,144 bytes and MP3/analysis reads at 65,536 bytes.

The long WAV waveform read 55,292,932 bytes through 845 Blob reads. The long CBR MP3 waveform read 5,849,348 bytes through 93 reads; its median read wait was about 19 ms. The long VBR MP3 waveform read 2,238,926 bytes through 37 reads. These count returned bytes, including rereads, not physical disk I/O. Browser RSS, JavaScript heap peaks, fixture backing stores, CPU utilization and energy were not measured.

## One next bottleneck

The [waveform worker](../web/src/waveform-worker.ts) yields after 32 work checks or eight milliseconds and requests a four-millisecond delay every time. The final CBR run spent 6.92-6.97 seconds at those yield points; the VBR waveform spent a median 6.38 seconds there, about 89% of completion time. The long WAV also spent 2.59 seconds yielding out of 3.33 seconds.

Test a less frequent, time-budgeted waveform yield policy with a finite step cap. Preserve bounded reads, the independent worker, cancellation, and the eight-millisecond work-slice budget. Use this same matrix to compare waveform completion, cancellation and main-thread long tasks before accepting the change. The measurements identify where elapsed time went; they do not establish an achievable speedup or justify changing playback transport, memory limits or codec history behavior.

## Verification

The final run completed all 18 timed cases and eight cancellation cases with no error, then stopped its server. TypeScript checking, 43 targeted lifecycle/seek/loop/waveform tests, the production release Wasm build, fixed-memory audit and `git diff --check` passed. Earlier setup runs that omitted Cargo configuration failed the fixed-memory assertion and were excluded; the harness now copies that configuration and runs the Wasm memory audit before serving.
