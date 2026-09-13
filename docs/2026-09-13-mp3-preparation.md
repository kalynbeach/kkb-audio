# Local MP3 preparation: dependency and timeline findings

Date: 2026-09-13. Issue: [#17](https://github.com/kalynbeach/kkb-audio/issues/17).

**Status: preparation checkpoint, not MP3 playback delivery.** The application and its Cargo manifest/lockfile are unchanged. This work follows [prototype PR #24](https://github.com/kalynbeach/kkb-audio/pull/24) on `feat/17-local-mp3`; the eventual implementation PR targets `design/21-wave-player`. MP3 is independent of the final design-approval gate for #22. Nothing here authorizes audible output or merging.

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

This checkpoint contains evidence and identified obligations, not final dependency acceptance or a completed #17 implementation.
