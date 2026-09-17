# Bounded waveform scheduling experiment

Issue [#32](https://github.com/kalynbeach/kkb-audio/issues/32), based on merged measurement baseline `f38691dbe689fc1ac16379c1b1b1c92203ec8977` from [PR #33](https://github.com/kalynbeach/kkb-audio/pull/33).

Keep the candidate. Raising the waveform worker's finite work-check cap from 32 to 256 reduced waveform completion by about 79-81% across the generated matrix. All output hashes and resource bounds matched. The eight-millisecond elapsed-time check and four-millisecond requested yield delay are unchanged. Each individual synchronous work unit can still overshoot the elapsed-time budget before the next check, as before.

## Configuration and evidence

Measured September 16, 2026 on Apple M1 Max, Darwin 27.0.0, Chromium 152, Bun 1.4.0, Rust 1.98.0, LAME 4.0 and a 48 kHz AudioContext. The isolated document stayed visible. No product UI, daily-driver build, decoder, transport, cache or memory structure changed.

The generated matrix uses the same six fixture hashes as the [published baseline](2026-09-16-local-media-measurements.md), three repetitions each, fresh contexts and workers, fixed order, no discarded warmup. The runner now hashes the returned Float32 extrema and records the bin layout and source timeline. Hashing happens after timed operations. The before runs use the original worker with the same measurement enhancements as the candidate.

Raw reports retain all repetitions and counters:

- [Before, generated paused matrix](2026-09-16-waveform-scheduling/before-paused.json).
- [After, generated paused matrix](2026-09-16-waveform-scheduling/after-paused.json).
- [Repeat original policy, generated paused matrix](2026-09-16-waveform-scheduling/repeat-paused.json).
- [Before, real files with muted rendering](2026-09-16-waveform-scheduling/before-render.json).
- [After, real files with muted rendering](2026-09-16-waveform-scheduling/after-render.json).
- [Initial rendering baseline](2026-09-16-waveform-scheduling/initial-before-render.json) and [initial rendering candidate](2026-09-16-waveform-scheduling/initial-after-render.json), retained from before strengthening the render-frame assertion.

The reports identify the base commit, actual production source diff, fixture hashes and Wasm hash. The candidate's comment was clarified after the first timing run; the executable policy did not change. The build's Wasm hash is identical across policies. The generated results use the initial hash-enabled runner. The final rendering results also require an increase in render frames between the initial and pre-seek snapshots and label the pre-analysis snapshot separately.

## Generated matrix

Waveform milliseconds from analysis invocation immediately after playback readiness, median [minimum-maximum]. Audio stays paused while analysis overlaps the seek and loop-arm operations.

| Fixture | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| WAV, 10 s, mono, 44.1 kHz | 153.0 [147.9-153.8] | 32.6 [30.3-32.9] | 78.7% |
| WAV, 180 s, stereo, 48 kHz | 3752.4 [3639.8-3786.8] | 781.2 [779.5-796.1] | 79.2% |
| CBR MP3, 10 s, mono, 44.1 kHz | 422.4 [414.8-422.9] | 85.3 [84.5-87.4] | 79.8% |
| VBR MP3, 10 s, stereo, 48 kHz | 476.9 [438.8-477.1] | 96.0 [90.7-96.1] | 79.9% |
| CBR MP3, 180 s, stereo, 48 kHz | 8993.6 [8905.0-9121.9] | 1752.2 [1736.3-1755.5] | 80.5% |
| VBR MP3, 180 s, stereo, 44.1 kHz | 7858.3 [7752.4-7901.1] | 1486.8 [1486.2-1494.6] | 81.1% |

The long CBR waveform's yield count fell from 1,406 to 175 and median yield wait from 7,149 to 1,011 ms. Long VBR fell from 1,292 to 161 yields and 6,528 to 937 ms waiting. Long WAV fell from 527 to 66 yields and 2,635 to 376 ms waiting. The finite step cap still triggers most yields on this host; this experiment does not establish that eight-millisecond slices are optimal.

## Interaction timing and drift check

The first candidate run had slower VBR interactions than the first baseline. Preparation also slowed before analysis started. To avoid attributing host drift to the policy, the complete original-policy paused matrix ran again after the candidate and initial rendering comparisons. All repetitions remain in the reports.

Median milliseconds, original baseline / candidate / repeated original policy:

| Operation | Baseline | Candidate | Repeat baseline |
| --- | ---: | ---: | ---: |
| Short VBR preparation | 74.3 | 67.2 | 76.4 |
| Short VBR seek | 42.0 | 45.7 | 50.9 |
| Short VBR loop arm | 108.8 | 120.2 | 130.4 |
| Long VBR preparation | 886.0 | 971.6 | 947.7 |
| Long VBR seek | 722.3 | 777.7 | 847.1 |
| Long VBR loop arm | 1531.6 | 1658.6 | 1696.9 |

The long VBR repeat preparation range was 890.7-1002.3 ms, which contains every candidate preparation result. Seek and loop timing moved farther in the same direction after restoring the original scheduler. These measurements do not show a repeatable policy-caused regression, but three repetitions per run cannot prove equivalence. The waveform gain remains much larger than this drift. Real-file rendering provides an additional interaction check below.

## Real files during muted rendering

The two inputs are WAV and MP3 exports of one real recording, both stereo at 44.1 kHz and about 238.89 seconds long. The WAV is PCM16; the MP3 is 320 kbit/s. The decoded timelines are 10,535,226 and 10,535,040 source frames respectively. This is real musical content, but only one recording in two formats, not a varied music library.

Listening gain was zero before `play()`. Each run observed a nonzero pre-gain sample and an increase of 5,888-7,168 rendered frames between the initial and pre-seek snapshots while waveform analysis was still pending. Then it sought to 90% and armed a one-second loop. Snapshots continued every 100 ms until analysis finished and at least 1.5 seconds had elapsed after loop arming.

Final rendering pair, median [minimum-maximum] in milliseconds. Waveform time starts at analysis invocation after `play()` acknowledges a running context; it excludes the short play acknowledgment itself.

| Operation | WAV before | WAV after | MP3 before | MP3 after |
| --- | ---: | ---: | ---: | ---: |
| Preparation | 29.5 [15.5-30.2] | 16.0 [14.6-20.9] | 441.9 [393.0-448.3] | 434.5 [426.6-462.7] |
| Seek | 6.0 [5.8-6.9] | 4.7 [3.3-4.8] | 347.8 [343.8-348.0] | 358.5 [351.7-358.9] |
| Loop arm | 5.8 [5.4-6.5] | 4.5 [4.1-5.2] | 683.1 [676.8-707.8] | 707.9 [704.9-710.4] |
| Waveform | 4754.0 [4729.7-4776.4] | 863.7 [853.8-870.6] | 12363.9 [12286.0-12510.6] | 2289.3 [2271.6-2289.6] |

The final MP3 seek and loop medians were about 11 and 25 ms slower with the candidate. The initial rendering pair showed the opposite direction, 360.8 to 354.5 ms for seeking and 706.9 to 702.0 ms for loop arming. That is further evidence of timing variation, not a repeatable interaction penalty. Both rendering pairs showed the large waveform reduction and identical output.

Every recorded snapshot reported zero starvation callbacks, loop underruns and lost loop frames, with no recovery state or runtime failure. The final baseline observed about 4.8 seconds of WAV rendering and 12.4 seconds of MP3 rendering per run; the candidate observed about 1.7 and 2.8 seconds respectively. These unequal windows cover the full analysis interval for each policy and at least one loop wrap, not equal-duration soak tests. They do not establish uninterrupted playback, audible seam quality, behavior on weaker devices, or browser-wide real-time guarantees.

The initial rendering reports used a nonzero-frame assertion rather than a frame-delta assertion. Their `playing` sample also incorrectly marks analysis active before invocation; only their `before-seek` and later samples demonstrate overlap. The final pair fixes that label and checks advancement explicitly. No run failed; both pairs are retained so the timing comparison is inspectable.

## Correctness, cancellation and resources

Every before/after waveform matched exactly by extrema SHA-256, total source frames, source rate and frames per bin. Waveform read counts, returned bytes and maximum read sizes matched for each fixture. No read exceeded 65,536 bytes. All sampled Wasm instances retained 16 MiB each, the worklet retained four slots, and summaries stayed within 32 KiB. These are capacities, not browser RSS or JavaScript heap peaks.

Each generated run passed all eight active-read cancellation cases. Initial before/after rejection and cleanup maxima were at most 0.3 ms; the repeat baseline reached 0.4 ms. This measures API acknowledgment after the first worker read starts, not worst-case OS thread reclamation. Existing lifecycle tests cover replacement, close and late-result disposal. No main-thread long tasks were observed.

Each generated run terminated all 46 created workers and closed all 26 contexts. Each rendering run terminated all 12 workers and closed all six contexts. Cleanup was checked between cases. All seven measurement servers exited and their ports stopped listening; the measurement browser tab was closed.

## Measurement helper follow-up

Review of #34 found that the single overlap sample at 150 ms could miss valid short analyses. The helper now samples immediately and then roughly every 16 ms before the same seek point, awaiting each status reply before polling again. New rendering rows distinguish `renderingOverlap.status: "observed"` from `"inconclusive"`. Inconclusive means analysis completed before advancing frames and nonzero pre-gain signal were observed together while it was pending. Those rows retain waveform measurements and allow the matrix to continue, but cannot support a positive overlap claim. Missing rendering evidence while analysis remains pending and genuine operation failures still fail the run. See the [measurement guide](../tools/measure-local-media/README.md#muted-rendering-comparison) for the report fields.

The seven raw reports above are unchanged and predate this helper fix. Their timing results and stated overlap evidence describe the original sampling procedure. The production waveform scheduler and transport are unchanged by the helper fix.

The follow-up browser check used a ten-second silent WAV and a ten-second tone MP3, three repetitions each, with zero listening gain. All six rows completed as inconclusive and retained waveform measurements. Analysis took 31.8-85.6 ms, the first poll arrived within 0.6 ms of the playing snapshot, and pre-seek samples remained at 150.6-151.8 ms. Signal appeared after analysis in this browser run, so it supplies no positive overlap evidence. All 12 workers terminated, all six contexts closed, and the server exited with its port closed.

TypeScript, the isolated release build and fixed-memory audit passed. All 42 existing targeted waveform, playback, seek and loop tests passed again. Eleven focused tests cover positive overlap, early completion and matrix continuation, delayed replies, sequential polls, missing signal or frame advancement, and analysis, status and deadline failures. Run them with `PATH="$PWD/node_modules/.bin:$PATH" bun test tools/measure-local-media/rendering-overlap.test.ts`.

## Reproduction

Use the [measurement guide](../tools/measure-local-media/README.md) for the normal paused matrix and the optional `--render WAV MP3` run. To measure the original policy with the new observations, retain this branch's runner and temporarily use `web/src/waveform-worker.ts` from `f38691d`; restore the candidate worker afterward. Keep every run's report. Each command creates a separate temporary build, serves only loopback, and stops its server after saving.

Real-file paths and audio are not published. The raw reports use aliases and content hashes. A reproducer needs their own supported recordings and should not expect identical timings or waveform hashes for different content.

## Validation

TypeScript passed in the worktree. The final candidate's isolated temporary copy rebuilt the release Wasm and uninstrumented workers, passed the fixed-memory audit, and passed all 42 targeted tests across nine files. These checks cover independent waveform references, seeking, loop recovery, cancellation, replacement and stale-result disposal.

```sh
PATH="$PWD/node_modules/.bin:$PATH" bun run typecheck
# Run these in the isolated copy printed by the measurement command after its server exits.
PATH="$PWD/node_modules/.bin:$PATH" bun run build:worklet
PATH="$PWD/node_modules/.bin:$PATH" bun run check:wasm
PATH="$PWD/node_modules/.bin:$PATH" bun test \
  web/test/preparation-lifecycle.test.ts web/test/playback-owner.test.ts \
  web/test/wav-loop.test.ts web/test/source-waveform.test.ts web/test/prepare-waveform.test.ts \
  tools/check-source-waveform.test.ts tools/check-wav-seek.test.ts \
  tools/check-wav-loop.test.ts tools/check-mp3-loop.test.ts
git diff --check
```

Before publication, the reports were compared programmatically for identical fixture and Wasm hashes, all waveform identity fields, and waveform read counters. Every final rendering row passed the frame-advancement and pre-gain signal checks; every final snapshot had zero starvation, underrun, loss and failure counters, and each run completed at least one loop wrap. The original-policy repeat also matched the initial waveform identities. This supports keeping the single scheduling change on the measured host, with the limitations above.
