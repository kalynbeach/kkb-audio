# Local MP3: preparation policies and implementation evidence

Date: 2026-09-13. Issue: [#17](https://github.com/kalynbeach/kkb-audio/issues/17).

**Status: implementation delivered; independent review and parent acceptance checks passed.** The original a6fe684 preparation checkpoint below left the application and Cargo manifest/lockfile unchanged. The implementation section records subsequent delivery. This work follows [prototype PR #24](https://github.com/kalynbeach/kkb-audio/pull/24) on `feat/17-local-mp3`; the eventual implementation PR targets `design/21-wave-player`. MP3 is independent of the final design-approval gate for #22. Nothing here authorizes audible output or merging.

## Dependency evidence

[Crates.io metadata](https://crates.io/api/v1/crates/symphonia) reported `default_version`, `max_version`, `newest_version` and `max_stable_version` as **0.6.1**. Cargo downloaded that exact release and its corresponding core, metadata and MP3-bundle crates. The released [manifest](https://docs.rs/crate/symphonia/0.6.1/source/Cargo.toml) declares Rust 1.85 and MPL-2.0; the repository uses Rust 1.98.0.

An isolated package under `/tmp/kkb-audio-mp3-preparation` used:

```toml
symphonia = { version = "=0.6.1", default-features = false, features = ["mp3"] }
```

Both `cargo check` and `cargo build --lib` passed for `aarch64-apple-darwin` and `wasm32-unknown-unknown`. This establishes compilation/linking of the minimal dependency configuration, **not** browser execution, worker I/O suitability or the repository's worklet-memory gate. No changes were made to downloaded dependency sources. MPL identification is not a completed distribution/license-obligation audit.

`mp3` enables the Layer III decoder/demuxer without unrelated codecs or default SIMD features. ID3v1, ID3v2 and APE metadata have separate features; ordinary tagged-file support still needs a bounded metadata policy. Xing/LAME handling is inside the MP3 bundle.

## Reproduced packet-duration bug

Released [`symphonia-core/src/packet.rs`](https://docs.rs/crate/symphonia-core/0.6.1/source/src/packet.rs), `PacketBuilder::trimmed_dur` (lines 318–342), computes new local trim values but calculates duration using the old builder fields. The MP3 demuxer calls it on a fresh builder with zero old trims.

A native reproduction against the unmodified release:

```rust
use symphonia::core::{packet::PacketBuilder, units::{Duration, Timestamp}};

let packet = PacketBuilder::new()
    .track_id(0)
    .pts(Timestamp::new(-100))
    .trimmed_dur(Duration::new(1152), None)
    .data(Vec::<u8>::new())
    .build();
assert_eq!(packet.trim_start, Duration::new(100));
assert_eq!(packet.dur, Duration::new(1052)); // Fails: actual duration is 1152.
```

The second assertion failed at runtime. This contradicts the documented invariant that packet duration excludes trim. It blocks using `packet.dur` or its sum as valid PCM length; it does not by itself prove the decoder unusable. Use actual decoded buffer lengths and independently validated finite timeline data, not this broken bookkeeping. No fork, downgrade or dependency patch has been selected.

## Native decoded-length probe

Two authored, one-second stereo fixtures at 44100 Hz were encoded outside the repository. Source synthesis and encoding used FFmpeg **9.0.1** and LAME **4.0**, with no physical output:

```sh
ffmpeg -hide_banner -loglevel error -n -f lavfi \
  -i 'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*659*t):s=44100:d=1' \
  -c:a pcm_s16le source-stereo.wav
lame --silent -b 128 source-stereo.wav cbr.mp3
lame --silent -V 2 source-stereo.wav vbr.mp3
```

A native probe used the released format registry and audio decoder, decoded one packet at a time, and counted `samples_interleaved() / 2` without retaining track PCM. The fixture is explicitly stereo; a real reader must derive and validate channel count.

| Fixture | Decoder gapless | Actual decoded frames | Sum of packet durations | Maximum decoded samples in one packet |
| --- | --- | --- | --- | --- |
| CBR 128 kbit/s | true | 44100 | 46080 | 2304 |
| CBR 128 kbit/s | false | 46080 | 46080 | 2304 |
| VBR quality 2 | true | 44100 | 46080 | 2304 |
| VBR quality 2 | false | 46080 | 46080 | 2304 |

FFmpeg decoding each MP3 to stereo f32 produced **352800 bytes**, independently agreeing with 44100 valid frames (`352800 / 8`). This is a length check only: no sample-level comparison, seek conformance, malformed metadata behavior, mono/48000 Hz coverage or Wasm runtime claim follows from it. Actual decoded-frame counting is viable for these valid tagged files; broader trim policy remains unproven.

## Timeline and input hazards

Sources: released [audio decoder options](https://docs.rs/crate/symphonia-core/0.6.1/source/src/codecs/audio.rs), [MP3 demuxer](https://docs.rs/crate/symphonia-bundle-mp3/0.6.1/source/src/demuxer.rs), [decoder](https://docs.rs/crate/symphonia-bundle-mp3/0.6.1/source/src/decoder.rs), and [Layer III state](https://docs.rs/crate/symphonia-bundle-mp3/0.6.1/source/src/layer3/mod.rs).

- In 0.6.1, `AudioDecoderOptions::default().gapless` is **true**. Demuxed packets carry negative leading timestamps and trim fields. Do not reuse older format-option guidance or apply trim twice.
- Recognized LAME/Lavf/Lavc fields become delay = encoded delay + 529 and padding = encoded padding saturating-subtracted by 529. This describes the pinned implementation, not recovery of an encoder's original input.
- Tag or estimated `num_frames` drives **end trimming**, not merely display duration. An inconsistent Xing count can therefore discard actual audio. Missing trustworthy duration requires a structural scan, not a bitrate estimate promoted into the finite timeline.
- Optional tag parsing is tolerant: malformed/truncated tag data can fall back, later tags can be skipped, and truncated frame EOF can be reported as normal EOS. Decoder success is not complete-file validation. Explicitly validate/reject inconsistent counts, malformed metadata, truncated frames and changing configurations.
- Built-in `Accurate` seeks position encoded packets; resetting the decoder also resets bit reservoir, overlap and synthesis history. Its limited prior-frame bookkeeping does not establish waveform-equivalent recovery. A reset/linear-decode/discard reference is the conservative history baseline; accelerated anchors need comparison against it. No fixed codec preroll or acceptable replay latency has been proven.
- Original MPEG/Xing/LAME/VBRI specifications were not independently audited in this pass. Source claims above describe the released implementation; the independent FFmpeg evidence establishes only the two fixture lengths.

## Bounded integration requirements

The [media-reader responsibility and seek contract](2026-08-28-kkb-audio-system-architecture.md#media-readers) remain unchanged: off-callback reading/decoding, a declared decoded-and-trimmed timeline, truthful `Exact` / `AnchorAndDiscard` / `Adjusted(actual_media_frame)`, and new-epoch readiness before seek completion.

- [`MediaSource`](https://docs.rs/crate/symphonia-core/0.6.1/source/src/io/mod.rs) is synchronous `Read + Seek + Send + Sync`. Browser `File.slice().arrayBuffer()` is asynchronous. Validate a bounded stepping/window bridge or worker-local byte adapter before integration; fake EOF and whole-file PCM caching are not substitutes.
- Decoder capacity is 1152 frames with a 2048-byte reservoir. The scoped MPEG-1 Layer III maximum encoded frame is 1045 bytes at 44100 Hz and 961 at 48000 Hz, derived from the released header formula and bitrate table. These are not total worker-memory bounds. The default input stream ring alone is 64 KiB; scan work, metadata, encoded staging and indexes also need caps and cancellation.
- Preserve `src/local_wav.rs` and its parser. The smallest shared reader boundary must adapt packet remainder to `PreparedRateConverter::input_frames_needed()` rather than pushing whole 1152-frame packets into smaller converter windows.
- Codec reconstruction must reach the converter's earlier source read anchor after `PreparedRateConverter::seek`, before the converter handles its own pre-roll. This applies to both `web/src/pcm-worker.ts` and the native worker in `src/cpal_host.rs`.
- `web/src/prepared-playback.ts` currently infers seek capability from sample-rate equality. That is insufficient for MP3; reader evidence must determine the completion result without making React codec-aware.
- Keep existing producer ownership, quiesce/reset, stale-epoch rejection, acknowledged pause, consumed EOS, replay and replacement disposal. Native scan/seek work must observe stop/superseding commands; browser work must yield between bounded steps. Existing preparation timeout and finite native seek-coordinate limits need explicit treatment.
- The actual file render path uses `src/worklet_wasm.rs`; `compiled_plan_wasm.rs` is a separate proof. No decoding belongs in either render callback. The shared Wasm artifact still needs the existing fixed-memory and callback/source audits after integration.

## Next acceptance boundary

Before changing playback behavior, settle and record the strict supported-subset/metadata policy, reliable duration inspection and resource limits, browser I/O adapter, and measured history-restoring seek strategy. Then prove native and built browser-worker behavior using reproducible CBR/VBR, mono/stereo, both rates, missing/bad metadata, truncated/corrupt inputs, converter pre-roll, cancellation and replacement cases. The [issue](https://github.com/kalynbeach/kkb-audio/issues/17) and [validation sequence](2026-08-29-initial-render-engine-validation-plan.md#playback-validation-after-the-four-milestones) retain the full delivery requirements.

The preceding historical checkpoint contained evidence and identified obligations, not final dependency acceptance or a completed #17 implementation.

## Implementation policy (resolved before dependent code)

The private reader will use Symphonia's **packet audio decoder**, not its tolerant demuxer. A small strict incremental MPEG frame inspector supplies complete packets. This avoids synchronous `MediaSource` adaptation, estimated duration, demuxer resynchronization, and the released packet-duration bug without modifying a dependency. WAV's existing parser is retained.

- Accept MPEG-1 Layer III, mono or two-channel stereo/joint-stereo/dual-channel, 44100/48000 Hz, indexed 32–320 kbit/s CBR/VBR. Reject free-format, MPEG-2/2.5, other layers/rates, reserved emphasis, configuration changes, junk between frames, incomplete frames and decoder errors. Reject missing reservoir history and side-information lengths exceeding available main data: Symphonia otherwise conceals reservoir underflow instead of failing. A bounded inspector tracks the 9-bit `main_data_begin` and summed 12-bit `part2_3_length` fields of the MPEG-1 59-bit granule/channel records; no Huffman or synthesis implementation is duplicated. CRC-protected audio is accepted with a header/side-information CRC-16 check (polynomial 0x8005, initial 0xffff, header bytes 2–3 plus side information after the stored CRC), independently sourced from LAME `bitstream.c::CRC_writeheader`; this does not cover all audio payload bits.
- One leading ID3v2.3/2.4 tag (synchsafe size, no footer), at most 1 MiB, and optional trailing 128-byte ID3v1 are skipped; tag content is not exposed. Other wrappers/trailing bytes are rejected. Header-bounded skipped metadata is not a metadata-content validator.
- Xing/Info is a non-audio first frame. Validate flags, field bounds, monotone TOC, declared byte and frame counts against the full structural scan. Missing count/TOC is fine: neither determines duration or seek anchors. Recognized LAME/Lavf/Lavc extensions require all 36 bytes; nonzero tag CRC must match, unknown revision or impossible trim rejects. Apply encoded delay + 529 and encoded padding − 529 exactly once; padding below 529 rejects rather than silently saturating. Missing/unknown encoder extension means **no trim**, not claimed original-input recovery. Nonzero malformed optional fields reject, not silent fallback.
- **VBRI version 1 uses explicit scan fallback (review correction below).** It is a non-audio first frame, with no recovered trim. Validate version, nonzero entry count/scale/frames-per-entry, supported entry width (1–4 bytes), and the entire table's extent within that frame. Byte/frame totals and individual table values are untrusted advisory metadata, even if zero or inconsistent: they never control duration, input offsets or seek anchors. The full bounded structural decode scan counts actual PCM; reset/decode/discard restores seek history. Unsupported versions, invalid structural fields, incomplete tables and malformed MPEG audio reject. No byte-origin, group-coverage or scale-rounding convention is inferred from a constructed fixture. FFmpeg n9.0.1 `libavformat/mp3dec.c::mp3_parse_vbri_tag` and `mp3_parse_vbr_tags` skip the metadata frame and ignore its delay/quality fields. The constructed VBRI fixture over unmodified LAME packets is compared to FFmpeg actual PCM, not promoted to an original-input claim.
- Inspection strictly scans **and decodes** all audio frames, counting actual 1152-frame outputs independently of metadata; only after EOF and count/trim consistency is finite duration published. Scan is O(encoded frames), constant storage; no per-frame index and no full decoded PCM cache. Measured engineering input cap (boundary evidence below): 32 MiB, 25,000 audio packets and 600 seconds of untrimmed source frames. These explicit limits reject, never truncate.
- Each Rust step consumes at most one encoded frame (1045 bytes) and retains at most one 1152-frame planar decoded packet. The browser uses one 64 KiB encoded cache (up to two windows transiently during replacement); native I/O uses a 6 KiB scratch array without an encoded index/cache. Browser loops yield at least every 32 packets and native loops check cancellation between every packet, and enforce 30-second inspection/reconstruction deadlines (browser outer MP3 preparation/seek deadline 35 seconds; existing WAV deadlines remain 5 seconds. The worker announces its bounded inspection budget after content detection; filename/MIME never determine acceptance or the deadline). File replacement/close terminates the dedicated browser worker, including outstanding reads. Native reconstruction checks stop and superseding epoch between every packet; ordinary filesystem read completion itself is not interruptible.
- Seeking always resets the codec, decodes/discards from the first audio packet through the converter's `source_frames_read()` anchor, then lets the existing converter perform its own history pre-roll. Report `AnchorAndDiscard` for MP3, even at equal rates; output-grid rounding may report `Adjusted`. Never infer codec exactness from rate equality. This O(target) baseline is intentionally not an accelerated random-seek index. Endpoint/replay use the existing epoch/consumed-EOS contract.

Dependency distribution: pin unmodified Symphonia 0.6.1 with `default-features = false, features = ["mp3"]`; its MPL-2.0 source and license must remain discoverable in distribution notices. No dependency source edits, decoder fork, alternate runtime decode or public API are introduced. Subsequent evidence below must distinguish implemented/tested behavior from these policy decisions.


## Delivered implementation and validation

The implementation retains `LocalWav` unchanged. `LocalMedia` is a private two-reader enum, not
a source framework. `LocalMp3` supplies strict complete MPEG packets to the unmodified pinned
decoder, counts actual decoded frames, applies validated trim once, and slices/replanarizes the
remaining packet into at most 1024-frame converter inputs. Packet `dur`, demuxer estimates and
`SeekMode::Accurate` are not timeline/history authorities. A seek resets both codec reservoir and
synthesis history at the first audio packet, reconstructs through the converter's earlier read
anchor, and preserves the existing converter/output transport geometry. The worker sends the
actual seek result; `PreparedProof` no longer guesses it from sample-rate equality.

Native and browser production preparation stay outside callbacks. Native initial inspection exposes
an explicit cancellation predicate; the historical interactive native proof still inspects
synchronously before it offers commands. Its worker observes stop/superseding seek between every
packet. Browser replacement/close terminates the dedicated worker; bounded File reads also have
30-second timeouts. The current file, converter, transport and owner remain the only active stream.
React changes are limited to supported-file selection and capability/error wording. No prototype,
lab design, waveform, loop, library, visualization, public API or physical-output change is included.

### Reproducible fixtures and numerical oracles

`tools/generate-mp3-fixtures.ts` produces the 11 small authored fixtures and FFmpeg interleaved f32
references under `tools/fixtures/mp3/`; the adjacent README records provenance. The matrix covers
CBR/VBR × mono/stereo × 44100/48000 Hz, plus a 17-frame tail, CRC protection and constructed VBRI.
Finite counts are exact: 6042 (44100 matrix), 6576 (48000 matrix/CRC), 17 (short), 8064 (VBRI without
recovered trim). Native and Wasm independent PCM comparison tolerance is maximum absolute error
**1e-5**; observed native maximum **2.30968e-7**. Original pre-encode PCM is not the lossy oracle.

Same-decoder/converter uninterrupted-versus-seek PCM is **bit-identical**, including converter
pre-roll, start/end, backward/forward, MPEG/FFT boundaries, partial tails and near-EOS targets at
both output rates. Native tests use the actual worker/rings and compiled gain callback. Built worker
checks use real transferable MessageChannels and the actual Wasm decoder/converter/kernel. Tests
hold read/admission completion while superseding epochs, verify paused reclamation and finite
ownership, and replay after consumed EOS. A native test observes at least 64 decoded reconstruction
packets before superseding, then again before stop; shutdown completes within its one-second guard.

Malformed rejection coverage includes unsupported MPEG version/rate/layout, configuration changes,
incomplete headers/frames, corrupt side information, missing reservoir history, inconsistent
Xing counts/byte sizes, bad trim/tag CRC/Xing TOC, VBRI structural fields/table extents and ID3
bounds. VBRI advisory counts/table values instead use the explicit scan fallback above.
Missing metadata explicitly retains untrimmed output.
Header/side-info CRC does not cover every audio bit; syntactically decodable payload alteration is
not generally detectable and is not claimed to be. VBRI construction validates the implemented
policy, not every encoder's VBRI dialect or recovered encoder input.

### Bounds and measurements

`tools/check-mp3-bounds.ts` repeats an independently decodable authored MPEG packet **25,000** times
(9,600,000 encoded bytes, 28,800,000 source frames, 600 seconds at 48000 Hz), inspects and seeks to
the last sample without retaining track PCM, then requires 25,001 packets to reject. This is a
synthetic storage/work-limit probe, not a difficult-content throughput certification.

| Configuration | Inspection | Reconstruction | Memory |
| --- | ---: | ---: | --- |
| Bun 1.4.0 actual release Wasm, 600-second synthetic bound | 822 ms | 801 ms | fixed 16,777,216 bytes |
| Muted Chromium 152 worker, same bound | 762 ms | 752 ms to frame 28,560,000 | fixed worklet 16,777,216 bytes |

These observations justify a conservative 600-second/25,000-packet engineering bound with a
30-second rejection deadline on the tested machine, not a universal latency promise. The 32 MiB
encoded cap covers the maximum accepted duration at 320 kbit/s plus bounded leading/trailing tags;
all accepted source coordinates fit the existing native u32 seek field. Storage has no frame index
or whole-track decoded cache: one decoder packet, one planar packet remainder, existing bounded
converter state and four existing transport slots. Worklet memory remains unshared min=max=256
pages; decoder allocation is confined to the separate worker instance.

### Isolated muted browser workflow

Agent-browser session `kkb-mp3-17` launched with `--args '--mute-audio'`, with the player also muted.
It used a separate static server process rooted in `/tmp/kkb-audio-17-validation/web/dist`, never
repository `web/dist` or the hot-reload driver. Chromium reported `HeadlessChrome/152.0.0.0` on
macOS, 48000 Hz stereo output and 128-frame callbacks. Five-second authored 48000-Hz VBR playback
loaded paused, advanced the consumed cursor, paused with retention, reached **240000 / 240000**
with zero observed starvation, sought Home/End, replayed and paused again. Equal-rate MP3 seeks
reported `AnchorAndDiscard`, including replay, rather than `Exact`.

Replacement MP3 → WAV → malformed MP3 → 44100-Hz VBR MP3 → CRC MP3 recovered cleanly. The converted
fixture declared **6042 source frames**, retained the fixed worklet memory, and loaded paused.
During the 600-second synthetic file, Cancel loading terminated the worker after **51.3 ms** and
close during an active near-end reconstruction after **51.8 ms**; neither late result revived UI.
All seven observed worker lifetimes were terminated on replacement/close. Instrumented snapshot
requests had maximum outstanding count **1**, including playback, seek and recovery. Browser and
owned server processes were closed afterward. Raw concise observation: `/tmp/kkb-audio-17-browser-evidence.json`.
No audible listening, physical native output, background certification or daily-driver artifact
replacement follows from these observations.

### Check commands and isolation

Repository commands (Rust 1.98.0):

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

Bun/build commands were run in a plain isolated source copy at `/tmp/kkb-audio-17-validation`,
with `node_modules` pointing at the repository's pinned dependencies and PATH preferring its
`node_modules/.bin`. This is not a Git worktree. Before the build, its destructive cleanup was
identified: `tools/build-worklet.ts` recursively removes **that copy's** `web/src/generated` and
`web/dist`. Repository/daily-driver generated and served artifacts were left unchanged.

```sh
PATH=/Users/kalynbeach/dev/kb/kkb-audio/node_modules/.bin:$PATH ./node_modules/.bin/bun run check
./node_modules/.bin/bun tools/check-mp3-bounds.ts
```

The full check includes Wasm build with wasm-bindgen 0.2.127, typecheck, owner/lifecycle tests, WAV
and MP3 compiled worker checks, converter/kernel/plan checks, player UI, lab regressions, fixed
memory checks and both source/callback audits. Existing warmed callback allocator probes report
zero allocation/reallocation/deallocation operations. No `--ignored` test was run. Notices and the
MPL-2.0 text accompany built assets; corresponding exact covered source is linked in the notices.

Intermediate failures were corrected before final validation: no-op fixture byte mutations were
replaced with actual invalid fields; old WAV-only UI selectors were updated; an expanded real
worker test's default 5-second test-runner limit was raised to 20 seconds (not a WAV runtime timeout);
TypeScript's typed-array buffer generic was made precise; one clippy nested-if warning was fixed.
Final acceptance still belongs to the parent and independent reviewer; no commit, staging, push,
PR publication or GitHub write was performed by this implementation step.

Final validation: **70 Rust tests passed, 2 physical-output tests left ignored**; fmt and clippy
passed. Full Bun check passed (**110 tests** across its test invocations, plus compiled kernel/plan,
fixed-memory and audit scripts). The final boundary rerun measured 822 ms inspection / 801 ms
last-sample reconstruction. A final isolated `kkb-mp3-17-final` session on localhost:42971 confirmed
content-selected MP3 inspection budgeting, VBRI load, five-second consumed EOS with zero starvation,
Home/End and replay/pause at the same fixed memory. A programmatic DOM `click()` did not count as
browser activation in an intermediate smoke attempt; real agent-browser clicks then passed. Both
final session/server lifetimes were closed. The original repository `web/dist` and generated tree
were not rebuilt. No staged files remain.

### Review correction: VBRI advisory-data fallback

The codec review correctly reproduced a gap in the original strict-rejection claim: changing the
single VBRI table entry at byte 62 to one still accepted 8064 frames. The old check rejected only
excessive scaled byte sums, not undersized coverage. The lifecycle review found no blocker.
The parent explicitly approved **scan fallback** under #17's rejection/fallback policy rather than
inventing a quantization validator or expanding the reader into a seek index. This supersedes the
original VBRI semantic-validation claim, not the decoded-PCM or seek-history contract.

Why not require table equality or an inferred rounding envelope? Current
[AndroidX VbriSeeker](https://raw.githubusercontent.com/androidx/media/release/libraries/extractor/src/main/java/androidx/media3/extractor/mp3/VbriSeeker.java)
(observed 2026-09-13, lines 54–56 and 70–94) computes both declared end and cumulative table positions
from **after** the metadata frame. Historical
[ExoPlayer r2.19.1](https://raw.githubusercontent.com/google/ExoPlayer/r2.19.1/library/extractor/src/main/java/com/google/android/exoplayer2/extractor/mp3/VbriSeeker.java)
(lines 60–103) ignores the declared byte count and accumulates table bytes from the metadata-frame
start, only clamping seek positions out of that first frame. Neither establishes an encoder's
per-group quantization rule. FFmpeg and the pinned Symphonia parser do not validate these tables.
A constructed example cannot resolve that ambiguity. Byte/frame/TOC declarations therefore have
**no authority at all**, including zero, undersized or excessive values. Only supported structural
fields and bounded table extent are validated; full structural MPEG scan/decode establishes finite
length and reset/decode/discard restores history. Xing/LAME count and trim validation is unchanged.
No browser decoder, hidden byte seek, extra cache or public API was introduced.

Fixture generation now uses AndroidX's post-metadata convention: 2688 declared/table bytes for seven
384-byte audio packets, excluding the 384-byte metadata frame. Only `vbri.mp3` changed on regeneration;
all eleven FFmpeg f32 references and the other MP3s were byte-identical. This remains constructed
metadata, not a Fraunhofer-encoder compatibility claim. Tests additionally construct two scale-5
entries (four then three audio packets, floor-quantized lengths 307 and 230), without claiming that
this rounding convention is normative. They accept this structure without a naive sum-equality test.

New native and built-Wasm regressions mutate advisory byte counts, frame counts and table entries to
0, 1 and u32::MAX, and require unchanged **8064-frame, bit-identical PCM**. Native seeks compare exact
suffixes at 0, 1, 1151, 1152, 4000, 8063 and 8064; the built worker exercises advisory/scaled variants
at both output rates through the existing converter/kernel/epoch test, including independent FFmpeg
1e-5 comparison, endpoints, replay and delayed-admission supersession. Invalid version, zero
structural counts/scale, unsupported width, table extent beyond the frame and malformed/truncated
MPEG audio still reject. Semantic table validation and real-encoder VBRI dialect coverage are
intentionally **not claimed**, not missing timeline checks.

Repair checks (same pinned toolchain and isolated source-copy build as above):

```sh
./node_modules/.bin/bun tools/generate-mp3-fixtures.ts
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
cd /tmp/kkb-audio-17-validation
PATH=/Users/kalynbeach/dev/kb/kkb-audio/node_modules/.bin:$PATH ./node_modules/.bin/bun run check
./node_modules/.bin/bun tools/check-mp3-bounds.ts
```

Results: **71 Rust passed, 2 physical-output tests ignored; 111 Bun passed** plus the compiled
kernel/plan checks. Fixed unshared 16 MiB memory, callback allocator probes and both source audits
passed. Boundary timing remains approximately 0.8 seconds each for inspection/reconstruction;
raw rerun is `/tmp/kkb-audio-17-repairs-bounds.json`. Logs:
`/tmp/kkb-audio-17-repairs-{rust,bun}-check.log`. No failing code/test iteration occurred in this
repair pass. Fixture before/after SHA-256 lists are `/tmp/kkb-mp3-fixtures-{before,after}-repairs.sha256`.

An additional isolated agent-browser session `kkb-mp3-17-repairs` used `--args '--mute-audio'` and
player mute on localhost:42972, served only from the rebuilt copy. A VBRI mutation declaring just
one byte, one frame and a one-byte table loaded paused at **8064 frames**, played to consumed EOS
**8064 / 8064** with zero starvation, sought Home/End with `AnchorAndDiscard`, replayed to EOS, then
replaced with the corrected fixture and closed. Both workers terminated; no worker-failed message
occurred; worklet memory stayed 16777216 bytes. Saved metadata, seek completions and full UI states:
`/tmp/kkb-audio-17-repairs-browser-evidence.json`. Initial unsupported text/ARIA selector attempts
were replaced with current snapshot refs before the intended interactions. The session and owned
server (including its shell wrapper) were closed; no physical output was used. This focused repair
smoke supplements, not reclaims, the earlier broad workflow evidence.

The page's stale WAV-only meta description and no-script wording now match the existing local-audio
title. Repository generated/dist content hashes remained identical before/after the repair build;
all rebuilding was isolated. The repair worker performed no Git mutations or GitHub writes.

### Final acceptance

The independent final reviewer passed the corrected contract with no findings; the original
lifecycle pass remains applicable. Parent inspection confirmed source/isolated-copy checksum
identity and independently reran formatting, warning-denied clippy, all 71 Rust tests (two
physical-output tests ignored), the full 111-test Bun check and MP3 boundary checks. Fixed 16 MiB
memory and callback/source audits passed. Parent logs are
`/tmp/kkb-audio-17-parent-{clippy,rust,bun}.log` and
`/tmp/kkb-audio-17-parent-bounds.json`.

Acceptance covers this declared local-MP3 subset, not listening quality, broad encoder/browser
compatibility or background operation. Native initial proof inspection remains synchronous;
MP3 reconstruction remains O(target). Final prototype approval for #22 is still pending.
Commits, pushes and stacked PR publication remain parent-owned; merging remains Kalyn's decision.
