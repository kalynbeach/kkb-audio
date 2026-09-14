# Full-track source waveform — implementation evidence

Date: 2026-09-13. Issue #18, above #22/#17. **Accepted for stacked publication after isolated
verification, independent media/UI review and the targeted UI repair recheck.** Current review order: **#18 → #23 → #19 → #20**.
No live visualization, loops, metadata, cache, new codec, public API or lab/prototype change is included.

## Source model and ownership

`WaveformAccumulator` consumes the compact planar Float32 PCM returned by the unchanged Rust
`LocalMedia.take`, before converter or gain. Symphonia remains unmodified/pinned at 0.6.1; its actual
decoded-frame and validated trim rules, not packet duration, determine the MP3 timeline. The
waveform worker inspects independently and requires its source rate/frame count to equal playback.
All established WAV/MP3 constraints remain; no new format/duration restriction is added.

- For N valid source frames, span S = ceil(N / 4096), bin count B = ceil(N / S).
  Bin i covers [i*S, min((i+1)*S, N)); the final partial bin is never padded.
- Each bin retains minimum and maximum across **all channels**, not a signed average. Opposite-phase
  stereo, isolated impulses and asymmetric peaks survive at this declared time resolution.
- Storage is one interleaved min/max Float32Array, at most **4096 × 2 × 4 = 32768 bytes**.
  Completion transfers its backing buffer, rather than cloning it. Only the active summary survives.
- At most 160 display columns cover equal source-time intervals. Each combines extrema from **every
  intersecting bin**, including boundary overlaps; it does not sample every nth bin. Coarse boundary
  bins may contribute to two columns. This overview does not claim sample-level navigation detail.
- Fixed full-scale height, no per-track normalization. Values outside ±1 (possible MP3 overshoot)
  remain intact in summary storage and clip only in presentation. Silence is a half-pixel baseline
  mark, not fabricated amplitude. Display reduction is memoized per completed summary, not per poll.

`PlaybackOwner` starts one dedicated analysis worker **after** playback preparation/status readiness.
The analysis worker has its own LocalMedia and no rate converter, playback transport, callback or
AudioContext. It never steals/restores playback decoder state. Adding/selecting library rows performs
no analysis; file identity is the owner's generation, not name. Replacement/close abort immediately,
terminate the worker even across File awaits, clear the summary, and reject late success **and** late
failure. Completion/failure also terminates the worker. Seek, volume, mute, theme and disclosure
changes do not restart analysis. Analysis failure only changes the waveform label, not playback phase.

This deliberately pays additional decoding/I/O: MP3 analysis repeats the strict full decode inspection
and then a sequential decoded/trimmed source pass, on top of playback's existing inspection/refills.
WAV repeats bounded RIFF inspection plus one PCM scan. There is no full-track PCM cache or encoded
index. The inexpensive model is intentionally not an analysis framework or seek accelerator.

## Working budget and scheduling

**32 KiB is the summary cap, not total analysis memory.** The separate analysis Wasm instance has fixed
unshared min=max=256 pages, **16777216 bytes**, as does each existing playback-decoder/worklet instance.
During scanning, these three linear memories total 48 MiB. The linked module is **516720 encoded bytes**
in this build; fetch/compilation and engine code/object/GC overhead are additional and not measured as
process RSS. This is not a 48 MiB total-process claim.

Within the analysis instance, Rust retains its existing one-packet MP3 state (2304 Float32 samples,
2048-byte reservoir plus decoder internals) or bounded WAV decode allocation. Takes are <=1024 frames,
<=8192 bytes of JS planar PCM. One 64 KiB encoded window is retained (up to two windows/128 KiB live
while replacing it), plus the <=32 KiB accumulator. No JS decoded-track array or collection summary
map exists. Rust allocations stay inside its fixed 16 MiB memory. Tests assert window/take/summary
limits and actual completed-worker memory; fixed-memory and callback audits remain intact.

The worker yields for at least 4 ms after <=32 read/aggregation steps or >=8 ms elapsed work, whichever
comes first. A Rust accept decodes at most one MP3 packet; one take handles <=1024 frames. This is a
cooperative throttle, not a real-time 8 ms latency guarantee. Playback owns a different worker/refill
pool. File reads have 30-second deadlines; scan steps guard 30 seconds without progress. There is
**no 30-second whole-analysis deadline**: a finite large WAV or throttled supported MP3 may take longer.
Startup fetch/compile is explicitly raced against 30 seconds and caller abort. Compilation itself
cannot be interrupted, but a late compiled result cannot launch a worker. Tests hold compilation
through deadline/replacement and verify settlement/no late worker with listener cleanup.

## Interaction and visual evidence

The original Input/range gesture handling remains authoritative: pointer preview, one release seek,
Escape/element blur/window blur/pointercancel/lostcapture cancellation, Arrow ±5 seconds, Page ±30,
Home/End endpoints. A solid dot-headed cursor and foreground envelope mark acknowledged consumed
media; a **separate dashed preview cursor** does not recolor that consumed envelope or change elapsed
time. A realized adjusted seek is reconciled from the owner's acknowledged snapshot. Accessible
Position labels, value text/help, elapsed/duration and playback controls remain available. Preparing
and failure labels retain a functional rail and Play; there is no synthetic pending waveform.

Compared against the approved #21 screenshots/source, the actual composition preserves the centered
380×532 desktop card, 40px navigation, >=1212px companion and narrow library replacing only the
visual. The visual/artwork remains honestly unavailable for #23. No shell, animation, font or palette
redesign. The six-state light/dark compact/expanded/mobile batch was inspected, with a final targeted
confirmation of mid-track consumed contrast and fixed focus. Independent review subsequently found
a status-label/cursor overlap; the narrow correction and current captures are recorded below.

Screenshots: [compact light](2026-09-13-source-waveform/compact-light.png),
[dark](2026-09-13-source-waveform/compact-dark.png),
[desktop library light](2026-09-13-source-waveform/desktop-library-light.png),
[dark](2026-09-13-source-waveform/desktop-library-dark.png),
[mobile library light](2026-09-13-source-waveform/mobile-library-light.png),
[dark](2026-09-13-source-waveform/mobile-library-dark.png),
[pending WAV](2026-09-13-source-waveform/wav-pending-light.png).
Native focus outline and reduced-motion behavior were also asserted in the built browser.

## Muted bounded workloads

`tools/check-waveform-browser.ts` is opt-in and refuses a non-#18-copy cwd/non-loopback URL. It uses
agent-browser, a named private session, `--mute-audio` **and player mute before Play**. No user music,
native physical output, daily-driver server, audible listening or background certification.
Chromium 152 on macOS, 48000 Hz output, existing 128-frame worklet callbacks:

| Actual authored workload | Source frames / encoded bytes | Overview wall time | Observed starvation |
| --- | --- | --- | --- |
| 180s PCM16 stereo WAV, variable envelope/opposite-phase channels | 8640000 / 34560044 | 3823 ms | 0 in 43 snapshots, consumed through 175360 |
| 600s MPEG packet-repetition storage/work bound | 28800000 / 9600000 | 33604 ms | 0 in 338 snapshots, consumed through 1603840 |
| Established trimmed 44100-Hz stereo MP3 fixture | 6042 / existing fixture | 6.6 ms | no runtime failure |

Both long workloads actually played while analysis was pending; neither uses held analysis messages
for throughput evidence. The MP3 maximum is a repeated independently decodable authored packet, not
complex real-music or universal throughput certification. A first run measured 3317/29851 ms for
WAV/MP3 with zero observed starvation; the final slower result above is retained, not hidden.
Each completed analysis reported fixed 16 MiB Wasm memory; the long summaries used 32760/32768 bytes.

The harness exercised seek preview/cancellation/release, paused seeks, Home/End, consumed EOS/replay,
volume/theme/library/reduced-motion stability, MP3→WAV/MP3 replacement and close. A fresh long MP3 scan
was cancelled after ~322 ms of its worker lifetime; Close-click capture to termination was **4.9 ms**
(~188 ms including opening Settings and automation). Another active long scan was replaced after
~289 ms; only the successor's 6042-frame summary appeared. All 12 created playback/analysis workers
were disposed at the end. Analysis-only error injection separately verified Play/pause/seek recovery;
this controlled case is lifecycle evidence, **not** a performance observation.

Raw snapshots/worker events/commands: `/tmp/kkb18-browser-final/observations.json`;
[concise retained workload summary](2026-09-13-source-waveform/workload-summary.json).
Logs: `/tmp/kkb18-browser-final.log`, earlier `/tmp/kkb18-browser.log`. Both owned browser sessions and
loopback server processes were closed. Zero browser page errors; no observed worklet failure or
memory change. No broad platform, listening quality, background or difficult-content guarantee follows.

## Checks, recovery and isolation

Source: `/Users/kalynbeach/dev/kb/kkb-audio`, branch `feat/18-full-track-waveform`, base HEAD
`6a969096cd2a264ec39bb9b506af1db622bcfa4e` unchanged. One plain source copy (not worktree):
`/tmp/kkb-audio-18-validation-smZ2aL`, excluding `.git`, `node_modules`, `target`, `web/dist`,
`web/src/generated`; only installed deps are symlinked. All Cargo builds/tests and emitted assets
ran there. PATH begins `/Users/kalynbeach/dev/kb/kkb-audio/node_modules/.bin` (Bun **1.4.0**).

```sh
cd /tmp/kkb-audio-18-validation-smZ2aL
cargo fmt --check
cargo test --lib
bun run check
PORT=42978 bun tools/serve-proof.ts
PLAYER_URL=http://127.0.0.1:42978/player.html \
  PLAYER_EVIDENCE=/tmp/kkb18-browser-final bun tools/check-waveform-browser.ts
# Close only the owned server after browser harness cleans up its own session.
```

Results: fmt passed; **71 Rust passed, 2 physical-output tests left ignored**. Rust was unchanged;
Clippy was not rerun. Final full Bun check passed **135 tests** across its invocations, plus compiled
kernel/plan checks, fixed Wasm memory, and both callback/source audits. New coverage includes independent
PCM16/24 mono/stereo/rate/partial fixtures, silence/impulses/opposite phase, all eleven MP3 FFmpeg f32
references (1e-5 tolerance and exact trimmed duration), display peak reduction, bounds, stale jobs,
compile deadline, playback independence and adjusted consumed-cursor reconciliation. Existing owner,
converter, scheduling, seek, library and lab suites were retained. No render callback changed.
Logs: `/tmp/kkb18-rust.log`, `/tmp/kkb18-final-check-2.log`.

Intermediate issues were corrected, not counted as passes: Happy DOM UI fixtures initially attempted
an unavailable localhost Wasm fetch; explicit analysis-only mocks removed that noise. A new deadline
test invoked Bun's eager rejection matcher *before* aborting its held promise, timing out and hanging
the first final check (tool stopped at 180s, `/tmp/kkb18-final-check.log`). Triggering abort before the
matcher fixed the test; focused and full reruns passed. Initial Python hashing emitted unrelated
blake2 availability warnings but successfully hashed SHA-256; final hashing uses pinned Bun.

Daily-driver `web/dist`, `web/src/generated` and the entire existing `target` tree were hashed before
and after: **13738 files unchanged**. Final changed-source/copy SHA-256 identity and daily-output
comparison are recorded in `/tmp/kkb18-source-copy.json` and `/tmp/kkb18-daily-comparison.json`.
Documentation/screenshots were synced after runtime validation without changing built source.
At worker handoff there were no staged files, commit, push, branch change, GitHub write or deployment.
Independent acceptance remains parent/reviewer-owned.

## Parent verification and review repair

The fresh media/lifecycle reviewer passed with no findings. The UI reviewer passed with one P2:
at source zero, the pending/failure label's line box overlapped the cursor dot. Parent accepted the
finding and changed only `.player-wave-status` from `top: -10px` to `-14px`, using the existing
navigation inset without moving the waveform or transport. The original pending capture above
predates this correction. Parent also removed the new browser harness's explicit `any` return,
using an unknown result, typed CLI envelope/rectangle and guarded error payload; application logic
is unchanged.

Before that repair, parent independently compared all **319** tracked/new source and evidence files
with the isolated copy (zero mismatches) and reran [the complete check](2026-09-13-source-waveform/full-check.txt):
**135 tests passed**, plus build/typecheck, fixed-memory checks and callback audits. After the repair,
isolated build/typecheck and **16 UI tests** passed again ([checks](2026-09-13-source-waveform/repair/checks.txt)).
The full suite is explicitly pre-spacing-repair evidence; playback/analysis code did not change.
The original [built-browser log](2026-09-13-source-waveform/browser-check.txt) is retained with the
workload summary; its timings were not rerun for a four-pixel label move.

A single targeted muted browser confirmation used a held analysis message to inspect pending and
failed states at source zero, not to measure throughput. In desktop light and narrow dark, label
bottom and dot top coincide without overlap (627px desktop, 599px narrow); the waveform stays 40px
and Play/seek remain enabled. Page errors were empty. [Results](2026-09-13-source-waveform/repair/status-check.txt)
and current captures: [pending light](2026-09-13-source-waveform/repair/pending-light.png),
[pending dark](2026-09-13-source-waveform/repair/pending-dark.png),
[failed light](2026-09-13-source-waveform/repair/failed-light.png),
[failed dark](2026-09-13-source-waveform/repair/failed-dark.png).
The owned server at `127.0.0.1:42979` and named browser were closed. The targeted layout scan
returned `[]`. The final [source detector](2026-09-13-source-waveform/repair/detector.json) reported
one advisory for the incumbent 22px track heading, unchanged by #18 and explicitly documented as a
scoped heading in DESIGN.md rather than a reusable type-ramp token. Parent retained that approved
heading; no unexplained findings or further polish loop.
The retained UI reviewer confirmed the P2 resolved, with no introduced defect; final disposition
**PASS**. The media/lifecycle pass remains applicable because playback/analysis code did not change.
Parent accepts this bounded delivery for stacked publication, not merge or deployment.

Parent's final [SHA-256 manifest](2026-09-13-source-waveform/validation-source.sha256) verifies all
**150 runtime/test/fixture/build-input files** against the final isolated copy. The
[identity record](2026-09-13-source-waveform/validation-identity.json) also records an independent
rehash of all **13738 unchanged daily-driver files** after the repair build. The affected UI suite
passed **124 assertions**. Device/listening/background and total-process memory limitations above
remain; publication does not certify excluded behavior.
