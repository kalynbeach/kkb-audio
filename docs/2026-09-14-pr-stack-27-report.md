# PR Stack #27: delivery, agent-session history, and next priorities

- Date: 2026-09-14
- Snapshot: GitHub/code investigation through 19:35 UTC / 12:35 PDT
- Scope: [Stack #27](https://api.github.com/repos/kalynbeach/kkb-audio/stacks/27), ending at [PR #31](https://github.com/kalynbeach/kkb-audio/pull/31)
- Reviewed tip: `3184643aef81ffc8ade121cb60294fb89adb4381`
- Main: `cff190c2d91cfac0debcb7dbf38b36cfe6e2a6e4`

## Executive assessment

**This stack completes the planned local-player feature sequence. It does not complete production or listening acceptance.** It takes the previously merged, thin local-WAV player and delivers a deliberately designed compact WAV/MP3 player, a session library, real source-waveform navigation, an independent live oscilloscope, and shared whole-track/arbitrary A/B loops.

All seven PRs are open, non-draft, correctly registered in the native GitHub stack, and currently mergeable against their respective bases. All nine stack commits are remote; none is on `main`. The final source matches the retained 166-input acceptance manifest. There are **no GitHub-submitted reviews or CI checks on these heads**: the substantial review and verification record is local agent evidence, not green GitHub CI or human approval.

The development story is not “agents generated seven features overnight.” Kalyn redirected an initially engine-heavy plan toward a personal music player, repeatedly corrected the design and interaction model, approved a separate silent prototype, and then supervised serial implementation with specialist review. **Codex Desktop supplied image/design exploration and earlier foundation reviews; Pi implemented, repaired, validated, and published the stack.** Pi's `openai-codex` provider does not make those Pi runs Codex app sessions.

The remaining work is primarily:

1. Kalyn's stack review and merge decision.
2. Representative WAV/MP3 loop listening, explicitly still pending.
3. Resolving distribution rights before relying on the bundled TX-02 asset for wider delivery.
4. A bounded confidence pass for realistic browser/device/lifecycle behavior—not reopening every deferred capability as a merge prerequisite.

**Recommendation:** finish acceptance and integrate this stack before starting another large feature sequence. Then prioritize daily-use reliability and preparation/seek responsiveness; select the next collection-oriented capability from observed needs. Preserve the private engine/host boundaries rather than prematurely publishing a universal session API.

## 1. What the stack contains

### Actual order and checkpoints

`#27` is a GitHub `PullRequestStack` object, not a missing issue or PR. Its API identity is `1089695` / `PRS_kwDOUHleLs4AEKCf`. The dependency chain is:

```text
main
  └─ #24  design prototype          #21
      └─ #25  local MP3             #17
          └─ #26  compact player    #22
              └─ #28  waveform     #18
                  └─ #29  scope    #23
                      └─ #30  WAV loops  #19
                          └─ #31  MP3 loops  #20
```

| PR / issue | Branch | Head | Delivered change |
|---|---|---|---|
| [#24](https://github.com/kalynbeach/kkb-audio/pull/24) / [#21](https://github.com/kalynbeach/kkb-audio/issues/21) | `design/21-wave-player` | `e7952d0` | Research, generated mockups, approved interactive design prototype, React 19.3 upgrade |
| [#25](https://github.com/kalynbeach/kkb-audio/pull/25) / [#17](https://github.com/kalynbeach/kkb-audio/issues/17) | `feat/17-local-mp3` | `d5da0b0` | Shared bounded Rust MP3 preparation and real playback |
| [#26](https://github.com/kalynbeach/kkb-audio/pull/26) / [#22](https://github.com/kalynbeach/kkb-audio/issues/22) | `feat/22-compact-player` | `6a96909` | Approved compact composition and session-only local library |
| [#28](https://github.com/kalynbeach/kkb-audio/pull/28) / [#18](https://github.com/kalynbeach/kkb-audio/issues/18) | `feat/18-full-track-waveform` | `8cfa28d` | Actual-source full-track amplitude overview with seeking |
| [#29](https://github.com/kalynbeach/kkb-audio/pull/29) / [#23](https://github.com/kalynbeach/kkb-audio/issues/23) | `feat/23-live-visualization` | `4f36250` | Live pre-listening-volume oscilloscope |
| [#30](https://github.com/kalynbeach/kkb-audio/pull/30) / [#19](https://github.com/kalynbeach/kkb-audio/issues/19) | `feat/19-wav-loops` | `7269d19` | Bounded WAV A/B loop preparation, rendering, recovery, and controls |
| [#31](https://github.com/kalynbeach/kkb-audio/pull/31) / [#20](https://github.com/kalynbeach/kkb-audio/issues/20) | `feat/20-mp3-loops` | `3184643` | Same loop contract for MP3 with bounded decoder-history restoration |

PR #24 also contains preparation commit `a0d4e0b`; #25 also contains decoder-research commit `a6fe684`. Commit checkpoints span September 13, 12:14 PDT through September 14, 02:02 PDT. That is a publication window, not a measurement of agent or human working hours. Planning began earlier.

The stack order is the delivery/review order, not a claim that every feature inherently required the preceding one. MP3 could proceed independently of design approval; the live visual logically needed the compact player, not the source waveform. The [validation plan](2026-08-29-initial-render-engine-validation-plan.md#playback-validation-after-the-four-milestones) records those distinctions.

### PR #24: design became an explicit product gate

The silent prototype establishes the 380 × 532 desktop player, a right companion library at ≥1212px, an internal library below that threshold, independent row selection and playback, fixed transport/visual/waveform geometry, a slim Volume disclosure, Settings-owned appearance, square controls, and paired modes. It uses actual Inter/TX-02/Departure Mono fonts, Phosphor icons, shared controls, and bounded React/Base UI disclosure animation.

It is **not an audio implementation**. Its clock, waveform, track metadata, and loop behavior are controlled simulations; the main image is a static design reference. The prototype's one-second loop minimum was explicitly disposable, not an engine requirement. Kalyn subsequently approved the working composition as “the final design direction for now.” [Prototype evidence](2026-09-13-wave-player-prototype.md), [approval record](https://github.com/kalynbeach/kkb-audio/issues/21#issuecomment-5657329528).

### PR #25: real MP3 without a second playback engine

A private `LocalMedia` seam retains WAV's parser and adds pinned, unmodified Symphonia 0.6.1 packet decoding. Both native worker/rings and browser worker/Wasm preparation feed the existing compiled PCM path. React does not become a codec controller.

Support is deliberately strict: MPEG-1 Layer III, 44.1/48 kHz, mono/stereo, CBR/VBR, with CRC and bounded metadata policies. Limits include 32 MiB encoded bytes, 25,000 packets, and ten minutes including codec padding. Actual decoded frames establish duration; validated trim is applied once. Missing trim means untrimmed decoder output, not recovered encoder input. Structurally valid VBRI advisory counts/tables fall back to full scanning rather than being treated as authoritative.

The tradeoff is important: initial inspection decodes the complete bounded stream, and **ordinary MP3 seeking still reconstructs from the beginning to its target**. The truthful capability is `AnchorAndDiscard`, with output-grid adjustment disclosed when applicable. PR #31 fixes repeated loop continuation, not general seek latency. [MP3 evidence](2026-09-13-mp3-preparation.md), [`LocalMedia`](../src/local_media.rs), [`LocalMp3`](../src/local_mp3.rs).

### PR #26: a usable listening object, not a catalog

The real player adopts the approved composition while keeping one playback owner. Its library retains up to 100 local `File` references in picker order. Adding or selecting entries does not read/decode them or start audio; row Play explicitly activates playback. Same-named files remain distinct. Previous/next preserves playing or paused intent, without wrap or auto-advance.

Settings holds Add files, Remove selected, Clear session, and Close/Cancel; removing an inactive entry leaves audio alone, while removing the active entry closes without choosing a successor. Filename and preparation-derived duration are honest fallbacks. Reload ends the collection and preferences. This is not persistent indexing, playlist management, metadata extraction, or an account-backed library.

The Departure Mono license notice was corrected from the website's MIT notice to the font's OFL notice. TX-02 entitlement remains a separate unresolved matter. [Compact-player evidence](2026-09-13-compact-player.md), [`PlayerCollection`](../web/src/player-collection.ts), [notices](../THIRD_PARTY_NOTICES.md).

### PR #28: the waveform describes the source

An independent cancellable worker scans active decoded-and-trimmed source PCM after playback readiness. At most 4096 min/max bins occupy 32 KiB; combining extrema across channels preserves opposed stereo and impulses instead of averaging them away. Display columns include every intersecting bin. Fixed full-scale amplitude is independent of volume/mute and conversion.

Consumed progress and seek preview remain separate. Playback and seeking continue while analysis prepares or fails. Replacement/close terminate obsolete jobs; no collection-wide cache is added.

The memory and work costs are larger than the summary: analysis adds another fixed 16 MiB Wasm instance, for **48 MiB of linear memory across analysis, decoder, and worklet while scanning**, plus other browser memory. MP3 analysis repeats inspection and sequential decoding. A recorded synthetic ten-minute MP3 overview took 33.6 seconds; that is a bounded workload observation, not representative music throughput or an app-wide deadline violation. [Waveform evidence](2026-09-13-source-waveform.md).

### PR #29: the oscilloscope describes rendered audio

The separate visual samples actual worklet output after engine gain/conversion but before listening volume/mute. Mono uses one trace; stereo uses independent solid/dashed traces. Three 2048-sample windows per channel retain 48 KiB of JS sample history, at ≤30 Hz. Pausing freezes eligible history; seeking invalidates it. Hidden/internal-library views, reduced motion, and visual pause stop observation without pausing playback. Renderer failures remain visual-only.

This adds no decoding or Rust/worklet callback work. It is intentionally **approximate, untagged browser analyser history**, not the canonical timestamped observation API or measured speaker synchronization. Source waveform and live scope answer different questions and should remain separate. [Oscilloscope evidence](2026-09-13-live-oscilloscope.md), [`oscilloscope-tap.ts`](../web/src/oscilloscope-tap.ts).

### PR #30: WAV establishes loop geometry and lifecycle

The player gets one half-open region `[A,B)`, whole-track/off on load, with disclosure independent of enable, exact fields, handles, Shift-drag, and explicit readiness/failure states. Normal wraps retain the render instance, downstream state, and continuous render clock; they are not main-thread polling or public seeks at EOS.

The chosen seam is **held-head smoothing**, not a conventional moving-head crossfade. Converted boundaries are `a=ceil(A·Ro/Rs)`, `b=ceil(B·Ro/Rs)`. The fixed realized period is `P=b−a`; only the final `F=min(floor(Ro/200),floor(P/4))` frames blend toward the first head value. Legal loops require `P≥8` and `F≥2`. All period frames remain, but tail content/slopes change. Conversion quantization is less than one output frame per iteration; its cumulative source-duration difference is not bounded.

The worker prepares ≤4096 head frames alongside the existing four 1024-frame transport slots. An armed underrun produces a bounded fade/silence/re-prime interval under a fresh epoch while render time continues; that failed iteration lengthens. Terminal source failures instead require track retry. Exact acknowledgment-time cursor/EOS and latest-request ownership are central to correct controls. [WAV-loop evidence](2026-09-14-wav-loops.md), [canonical loop contract](2026-08-28-kkb-audio-system-architecture.md#loop-contract), [`media_loop.rs`](../src/media_loop.rs).

**Equal endpoint values are not proof of good sound.** The tests deliberately expose periodic-wave distortion and possible DC bias. Representative listening remains an acceptance item.

### PR #31: MP3 required a real mechanism, not guard removal

The first feasibility gate failed: reconstructing a late MP3 continuation took roughly 675–839 ms for an approximately 85–93 ms loop. A bounded head/slot pool could not hide that work indefinitely. The team did not silently restrict support to whole-track or cached tiny regions.

The approved replacement restores the pinned decoder's finite history using a private encoded recipe: genuine reservoir suffix plus an original predecessor packet, with an internal carrier when needed. Warm-up outputs are discarded and never become source PCM, waveform samples, trim, or media time. Acquisition happens before Armed; normal continuation no longer starts an O(target) reconstruction.

One completed anchor and at most one transient replacement retain 1556 encoded bytes each. Including specified acquisition/carrier/packet scratch, the conservative additional encoded-payload ceiling is 5712 bytes—not total process memory. The decoder, PCM head, slot count, and fixed Wasm memory remain unchanged. WAV and MP3 share controls, seams, coordinates, and recovery.

Final source-bound muted Chromium evidence records a late 4097-frame loop on an authored 590-second MP3 advancing **0→16 iterations at one epoch**, with zero starvation, loop underruns, or invalid blocks. Earlier observations cover 28 wraps and induced recovery. Mixed-block empirical coverage and arbitrary real-music/deadline behavior remain unclaimed. [MP3-loop evidence](2026-09-14-mp3-loops.md), [runtime record](2026-09-14-mp3-loops/runtime.json).

## 2. How the Pi and Codex sessions developed it

Session references below use the exact archive keys in the appendix. Dates in narrative are local PDT unless marked UTC. Session/tool evidence is distinguished from later summary claims.

### From engine milestones to a designed personal player

September 10 foundation sessions established seeking/lifecycle, then the initial local-WAV UI. Actual Codex Desktop sessions independently reviewed conversion PR #12, seeking PR #14, and player PR #16, running device-free Rust/Bun checks and returning no actionable findings. Those are **pre-stack reviews**, not authorship of stack features. A subsequent Pi repair fixed seek cancellation after blur; the earlier clean Codex review did not rule that bug out. [C-conversion, C-seek, C-player; P-review:L45–56]

In the September 11 planning conversation, Kalyn reported successfully trying a personal WAV and described the goal as, first and foremost, a player with visualizations for a music collection. When the initial backlog focused on codecs, waveform, and loops, Kalyn pointed out that it overlooked frontend design. Three design-lineage investigations and explicit #21/#22/#23 gates followed. The earlier demo became an anti-reference rather than an aesthetic authority. [P-plan:L40,78,88,234–244]

This was a necessary correction: engine readiness and product readiness were not interchangeable. The approved order still avoided premature catalog, network, and public-API work. [P-plan:L284–327]

### Codex Desktop: three image iterations and an explicit return handoff

Pi prepared the reference bundle and task prompt at `a0d4e0b`; it could not establish an app image-task connector, so it handed the task to Kalyn rather than substituting a CLI. In actual Codex Desktop session `01a09c32-3f86-7b63-a39f-4f74c62cff21`, the agent initially stopped because it could not verify the latest image-model routing. Kalyn explicitly waived that verification condition and authorized the available built-in image tool. Embedded output metadata says `gpt-image 2.0`; exact/latest routing was **not verified**. [P-build:L110–123; C-design:L30–37]

The archive records **26 image invocations across three sets**, not 26 final designs:

- **v1: six outputs.** Kalyn rejected generic composition, oversized Library/volume controls, and in-player theme selection; the TCG reference meant compact layout, not ornamental chrome.
- **Research reset and v2: twelve outputs, six superseded.** Codex researched prior Wave Player/KKB sources and Stencil. Kalyn retained Inter alongside stronger TX-02/Departure Mono roles, rejected Visual/Library tabs and central “A/B” text, and chose Phosphor utility icons.
- **v3: eight outputs, two superseded.** Typography/header corrections applied to all six views; circular control backgrounds and unintended active Repeat fills were corrected. Six root-level images became the handoff, with prompts and superseded variants preserved.

[C-design:L152–202,410–451,497–555,649–782; mockup [v1](2026-09-13-wave-player-mockups/README.md), [v2](2026-09-13-wave-player-mockups-v2/README.md), [v3](2026-09-13-wave-player-mockups-v3/README.md)]

Kalyn explicitly asked what to take back to Pi “where we're actually implementing.” Codex's final handoff identified uncommitted design artifacts, no application/dependency changes, and unfinished approval/real-font/interaction work. Pi inspected the actual six images and received separate permission to code a silent prototype. **Progress on images was not retroactive approval to ship the UI.** [C-design:L768–782; P-build:L123–146]

### Pi: real interaction changed the design again

The prototype exposed problems raster images and an early finishing reviewer had missed: oversized Volume, selection behaving like loading, status badges, layout shifts, crowded utilities, unstable waveform geometry, flashing library exit, and competing popup animation owners.

Kalyn's interventions established independent selection versus explicit row Play, playback-only library rows, Volume-left/Library-right placement, stationary centered transport, an opaque out-of-flow loop editor, and a single Base UI owner for Volume animation. Actual motion tests caught transient flash/resize failures that settled screenshots did not. [P-build:L312–563; prototype evidence]

Only after these iterations did Kalyn approve the working prototype as “the final design direction for now,” before #22 integration. Session-management actions were then explicitly assigned to Settings and the empty player. MP3 development could proceed during the design gate without bypassing it. [P-build:L866–867; approval record above]

### Pi implementation: serial writers, parallel reviewers, bounded repairs

The main pattern was:

```text
one feature writer → independent domain/UI or lifecycle reviews
                   → reproduced findings → bounded repair/recheck
                   → parent validation, commit, push, PR, stack verification
```

This was not seven concurrent writers. #17 used decoder research plus code-context exploration before implementation. #18–#20 used focused worker/native/render/owner/UI review boundaries. Retained reviewers checked repairs; “independent” generally means separate task/context, not another human or necessarily a different model. Parent and sampled child Pi records identify `gpt-6-astra` through `openai-codex`; actual Codex Desktop parent records also identify `gpt-6-astra`, but in a different harness. [P-build:L614–815,988–1060; P-overnight:L48–51,205–208,359–360,693–694]

Significant findings were caught **after initial tests passed**:

| Layer | What inspection or reproduction changed |
|---|---|
| MP3 | Corrected VBRI advisory-metadata policy; used bounded full scan rather than trusting inconsistent table/count fields or excluding all valid variants. |
| Compact player | Repaired interaction/visual evidence gaps, contrast/copy/target details, and the Departure Mono notice. |
| Waveform | Bounded startup compilation waiting and repaired pending/failed label overlap. |
| Oscilloscope | Pixel inspection contradicted DOM-only reduced-motion claims; stale traces and failure-caption precedence were repaired. |
| WAV loops | Reproduced converted EOF head stalls, EOS acknowledgment autoplay risk, native disabled-loop re-enabling, owner supersession/abandoned-intent races, hidden captions, unreachable short-file feedback, and narrow-layout displacement. |
| MP3 loops | Failed the original throughput gate; researched finite history; corrected CRC/VBRI tests that had exercised packet zero instead of nonzero restoration before production edits. |

The WAV-loop repair is especially consequential: initial 77-Rust/153-Bun passes did not establish correct cross-layer control ordering. Final retained reviews passed after red/green owner regressions and a 159-test integrated Bun suite. MP3 then reached 84 Rust tests and 160 Bun tests. [WAV repair](2026-09-14-wav-loops.md#bounded-review-repair-2026-09-14), [MP3 gate](2026-09-14-mp3-loops.md#gate-approval-and-corrected-research-coverage)]

During the overnight session, Kalyn explicitly authorized continuing until the stack was ready for review and merge approval, with judgment-dependent blockers recorded on PRs. This widened continuation authority, not permission to merge, deploy, play audible tests, or silently narrow arbitrary A/B support. [P-overnight:L606,627,637; PR30 follow-up]

## 3. What the development process got right—and where it cost us

### Keep these practices

- **Separate design approval, implementation, numerical correctness, listening, and merge authority.** The useful boundaries survived both the mockup handoff and the MP3 feasibility failure.
- **Use independent uninterrupted references.** Decode/convert/crop/seam comparisons and actual worker/ring/MessageChannel/Wasm paths are more meaningful than tests reusing the candidate's own loop algorithm.
- **Challenge asynchronous interleavings.** EOF, held status polls, superseded preparation, cancelled enable, and replacement were where important defects hid.
- **Preserve failed evidence.** Empty review files were treated as missing evidence, the slow MP3 strategy stayed recorded as failed, and incorrect browser assertions were not rewritten as product successes.
- **Protect the daily build.** Isolated plain copies kept validation away from daily `target`, `web/dist`, and generated assets. Historical tools verified 13,738 unchanged daily-output files; this investigation did not rerun that historical comparison.

### Specific process weaknesses

1. **The owner had to restore product intent repeatedly.** Design was initially omitted; generated images drifted into generic composition; prototype reviewers missed issues Kalyn immediately identified. Start the next feature with the approved interaction invariants and a few actual views, not another broad inspiration exercise. [P-plan:L78–88; P-build:L312–563]
2. **Passing tests and visible DOM text were overinterpreted.** Pixel visibility, accepted input values, and transition midpoint behavior needed direct checks. The final MP3 field-entry retry never established the cause of the first missed commit; it is unresolved evidence, not a diagnosed UI bug. Target those gaps rather than blindly repeating an entire screenshot matrix.
3. **Orchestration added recoverable friction.** MP3 review files were zero bytes; the parent recovered the original structured reports with matching hashes before repairs. A #22 worker handoff timeout required same-worker recovery, not another implementation. Capability-limited research and an unnecessary Python hashing attempt also needed explicit correction. Keep future task packets shorter and artifact paths reliable while retaining the evidence checks. [P-build:L623,777–799,973–988; P-overnight:L376–379]
4. **Git branch ancestry was mistaken for native stack registration.** PRs #24–26 initially had `stack:null`; Kalyn called it out, and `gh stack link` created #27. The next session repaired local tracking from the remote stack. Current registration is correct; this is not remaining work. [P-build:L1104–1123; P-overnight:L39–43]
5. **Publication and cleanup claims were sometimes too broad.** Kalyn pushed the prototype after the agent committed without pushing, prompting a workflow correction. Later, an overnight “all owned resources closed” claim was contradicted by an older prototype server still running. A separate September 14 session terminated it and verified both process exit and port closure. That server is resolved, not an open cleanup task. [P-build:L564–579; P-cleanup:L6–12]

### Review burden is mostly evidence, but the difficult code is concentrated

Against `main`, the stack changes **301 unique files, +18,236/−393 text lines**. Source/tests/tools account for 61 text files and +7,692/−283 lines; documentation/evidence/licenses account for 107 text files and +10,026/−95. There are 128 binary additions, about 44.2 MB of uncompressed Git blob content, overwhelmingly 100 documentation images. These are not bundle-size or runtime-memory figures.

Preserving design history explains much of the apparent size. The highest-risk review surface is narrower: MP3 validation/history, native/browser readiness and cancellation, `PreparedPcmInput`, loop continuation, and `PlaybackOwner` command ordering. Review those contracts and their independent tests first. Do not use line count alone to justify an unrelated refactor or discard the evidence history.

## 4. What the verification actually establishes

| Evidence | Strongest supported conclusion | Not established |
|---|---|---|
| Current GitHub/API and remote refs | Seven open non-draft PRs, native stack membership, correct bases and exact heads, currently mergeable | Human approval, inspected branch policy, or successful CI |
| Final recorded Rust checks | 84 passing tests in debug and release, with two physical-output tests ignored in each; formatting and native/Wasm Clippy recorded | 168 distinct tests; broad physical-device behavior |
| Final recorded Bun check | 160 tests plus build/typecheck, kernel/plan, fixed-memory, and callback audits | Browser execution of every assertion or universal real-time safety |
| Fresh source-manifest verification in this investigation | All 166 listed repository inputs match the committed final acceptance manifest | A new test run or verification of currently served daily artifacts |
| Actual muted worker/browser runs | Bounded playback, late loops, recovery, ownership, visuals, and fixed-memory behavior on the recorded configurations | Representative listening, background/mobile-device matrix, speaker timing, total process memory |
| Local reviewer dispositions | Earlier findings have recorded repairs and final passing dispositions | GitHub review approvals or a proof of no defects |

The parent historically reran final Rust **debug** and full Bun; release/Clippy and browser evidence include worker executions. Preserve that attribution. The final [check excerpts](2026-09-14-mp3-loops/parent-checks.txt), [input manifest](2026-09-14-mp3-loops/parent-input-sha256.json), and [local reviews](2026-09-14-mp3-loops/media-review.md) make the scope inspectable.

Some final narrow fixes postdate broad browser batches: waveform spacing, scope preference/caption behavior, and especially the last WAV owner-intent repairs. They have focused checks and later integrated automated coverage, but not a fresh complete browser matrix. Neither the final 160-test suite nor source hashes fill that gap automatically.

GitHub reports zero reviews, review threads, check runs, and commit-status contexts on every head. A combined status of `pending` with zero contexts is **not a pending CI job**. No tracked Actions workflows were found. Branch-rule/protection queries returned plan-limited 403 responses, so enforceable policy was not established. [GitHub handoff](https://github.com/kalynbeach/kkb-audio/pull/31#issuecomment-5661580053)

## 5. Work remaining for this stack

### Acceptance and integration checklist

| Priority | Work | Completion condition |
|---|---|---|
| Before claiming loop acceptance | Kalyn listens to representative WAV/MP3 material: whole track, short interior/late regions, both conversion directions, periodic and nonmatching endpoints, ordinary edits/disable/recovery | Record acceptable sound or concrete objection with source/region/rates. If merging first as explicitly experimental, preserve the listening caveat and do not mark it passed. Agent-operated audible/device tests need separate permission. |
| Before merge | Review the seven incremental PRs and integrated player; decide whether current bounded behavior and residual risks are acceptable | Explicit owner merge approval; no reliance on `CLEAN` as approval. Resolve actual findings in the owning layer and propagate/recheck affected descendants. |
| Recommended focused confidence check | Exercise final cancelled-enable→seek/Pause→disabled-edit sequences in the actual built player; deliberately commit exact MP3 A/B fields through keyboard and pointer paths | Confirm effective state/cursor and accepted bounds on the selected final build, or capture a reproducible failure. This addresses known evidence gaps, not a claim of an existing bug. |
| Before wider redistribution | Verify TX-02 use/distribution entitlement or choose an authorized replacement | Recorded rights decision and corresponding asset/notices action if needed. Departure Mono's corrected notice does not settle TX-02. |
| During integration | Merge in stack order and reconcile downstream bases if the chosen merge method rewrites ancestry | Verify intended content on remote `main`; revalidate changed source/build inputs when needed. No merge method is prescribed by this report. |
| After remote integration is verified | Reconcile issues #17–23 and stack state; keep still-pending acceptance explicit | Close completed work deliberately. #24 uses “Refs,” #30/#31 use “Implements,” and intermediate closing text is not proof that all issues will close automatically. |

**No confirmed current implementation blocker emerged from this investigation.** That is an evidence-based retrospective assessment, not a new exhaustive code audit or unconditional merge verdict. The slow MP3 continuation strategy, VBRI policy dispute, waveform label overlap, scope stale traces, WAV control races, missing native-stack registration, and leftover prototype server all have subsequent dispositions. They should not be listed as unfinished features.

The following are **not missing scope for this stack**: FLAC/AAC, HTTP, a persistent catalog, playlists/queues/auto-advance, metadata/artwork extraction, multiple saved regions, beat synchronization, creative crossfades, a general visualization framework, public engine/session APIs, a native UI, or deployment. Historical per-PR statements such as “MP3 loops unavailable” describe that layer; #31 supersedes them at the tip.

## 6. Recommended next development sequence

These are recommendations, not changes to the canonical plan or new implementation authorization. The existing [architecture](2026-08-28-kkb-audio-system-architecture.md) and [product brief](../PRODUCT.md) remain authoritative.

### 1. Establish a small daily-use confidence baseline

**Goal:** know whether this player behaves and sounds acceptably in Kalyn's real listening workflow.

Complete the listening gate, then exercise a bounded matrix of actual preferred desktop browsers and physical iOS Safari: loading, playing, seeking, loops, browsing, background/foreground, interruption, and resume. Test native output separately if native parity is the next product need. Record versions, devices, sample rates, duration, and observed failures; do not retroactively apply the early kernel browser matrix to this much richer player.

Prioritize audible glitches, unintended autoplay, unrecoverable state, and difficult controls over more visual effects. A new large certification framework is unnecessary. The outcome should be a short supported/observed-environment statement and a small list of reproduced issues.

### 2. Measure preparation and seek responsiveness before optimizing

**Goal:** make selecting and navigating real music feel responsive without weakening validation or ownership.

The current design deliberately pays for full MP3 inspection, O(target) ordinary seeks, and separate waveform inspection/decoding. Measure first-ready time, late seek time, loop-arm time, waveform completion, cancellation responsiveness, and resource use on representative supported files—not only packet-repetition fixtures.

Use those results to choose one bottleneck. A bounded seek accelerator, avoiding duplicate analysis work, or changing analysis scheduling may be justified; none is automatically justified by PR #31's private loop anchor. That anchor is proven for a particular continuation recipe, not a drop-in public seek index. Preserve strict source validation, decoded/trimmed coordinates, and cancellation in any optimization.

In parallel, make the existing device-free commands repeatable on clean inputs through a small CI path or equivalent recorded clean-copy check. Reuse `package.json` and Cargo commands; keep physical-output tests opt-in. This closes the current gap between substantial local evidence and absent hosted checks without inventing another test framework.

### 3. Choose the next collection capability from actual use

**Recommended default after the confidence pass:** a narrow real-library usability increment, not simultaneous codecs, catalog, and application migration.

- If Kalyn's collection is materially blocked by format coverage, **FLAC** is the next natural codec: it is already in the architecture's first decode set and exercises lossless media through the now-established reader/seek/waveform/loop boundaries.
- If remote collection access is the pressing need, begin **progressive HTTP against a deterministic local fixture server**, independently of Clerk, Convex, or production storage. Verify ranges, ignored ranges, validators, truncation, CORS, expiry/refresh, cancellation, and loop-head reads before selecting a provider.
- If ordinary local browsing is the pain point, consider one bounded **metadata/identity improvement** first. Keep the playback picker separate from catalog management; do not turn 100 ephemeral File references into an accidental persistence architecture.

The decisive question is what prevents useful daily listening—not which architecture box remains empty. FLAC and HTTP are alternatives for the next slice, not prerequisites to each other or retroactive requirements for this stack.

### 4. Establish the real application boundary only when needed

`kkb-audio` now contains the engine, proofs, lab, silent study, and a meaningful private player consumer. That has earned practical seams—`LocalMedia`, `PreparedMediaLoop`, `PreparedPcmInput`, and `PlaybackOwner`—but not a general public command framework.

When a second real consumer or the eventual `wave-player` application needs reuse, extract the smallest task-oriented interface and keep host lifecycle, media reading, and product policy outside the render core. Avoid an early crate/workspace proliferation or mandatory monorepo migration. Consolidate complex control code only around demonstrated duplication or repeated defects, retaining the ordering regressions that caught actual bugs.

### 5. Then build managed delivery and durable analysis incrementally

For the longer-term collection product, the architecture already distinguishes stable assets/revisions from locators, managed originals from renditions, Clerk identity from Convex authorization, and source analysis from live observations. Activate those decisions only as the product needs them.

After deterministic HTTP succeeds, select storage and prove provider/browser range, CORS, grant-expiry, and revision behavior. Only then grow imports/catalog/persistence and versioned waveform or musical-analysis artifacts. The current ephemeral waveform is not a durable `AnalysisJob`, and the current untagged scope is not the canonical provenance stream.

Defer additional visual scenes, DSP/plugin systems, synchronized sources, creative crossfades, and musical automation until the listening product needs them. The stack's most valuable result is a usable consumer of the engine—not permission to build every future subsystem at once.

## 7. Sources, session index, and investigation limits

### Public/repository evidence

- Live [native stack API](https://api.github.com/repos/kalynbeach/kkb-audio/stacks/27), all seven PR bodies/commits/comments/reviews/check states, and issues #17–23.
- [Final stack handoff](https://github.com/kalynbeach/kkb-audio/pull/31#issuecomment-5661580053) and [resolved MP3 gate follow-up](https://github.com/kalynbeach/kkb-audio/pull/30#issuecomment-5660467659).
- Per-feature evidence linked above, plus [canonical architecture](2026-08-28-kkb-audio-system-architecture.md), [validation plan](2026-08-29-initial-render-engine-validation-plan.md), [PRODUCT.md](../PRODUCT.md), and [DESIGN.md](../DESIGN.md).
- For immutable source context, use [the reviewed tip](https://github.com/kalynbeach/kkb-audio/tree/3184643aef81ffc8ade121cb60294fb89adb4381). Relative document links resolve to the current checkout and can evolve later.

### Private primary session records

`L` references above are physical JSONL lines. The UUID plus dated filename identifies the source; archives are local, not repository artifacts. Quotations are limited to relevant project decisions, not copied full transcripts.

Pi root: `~/.pi/agent/sessions/--Users-kalynbeach-dev-kb-kkb-audio--/`

| Key | Exact filename | Role |
|---|---|---|
| P-foundation-plan | `2026-09-10T07-52-37-716Z_01a08a4d-ec53-7367-b93b-32d904ede24f.jsonl` | Foundation/player ordering |
| P-seek | `2026-09-10T18-56-17-239Z_01a08cad-8556-77d8-936e-2ffcdedbeca1.jsonl` | #13 implementation |
| P-player-plan | `2026-09-10T20-11-57-037Z_01a08cf2-caed-7231-9f44-d7fd3223c209.jsonl` | #15 scope and repository placement |
| P-player | `2026-09-10T21-22-58-799Z_01a08d33-d26e-73c9-89cc-ef8387fcef7d.jsonl` | #15 implementation/review/publication |
| P-review | `2026-09-10T22-19-17-254Z_01a08d67-5f85-7188-b34c-d685cfca6daf.jsonl` | #16 cancellation repair and design-rule correction |
| P-plan | `2026-09-11T06-30-45-961Z_01a08f29-55c9-7270-81bd-40d53aba372b.jsonl` | Product/design backlog and stack plan |
| P-build | `2026-09-13T19-02-49-054Z_01a09c26-93de-7642-9588-d5b58d58a321.jsonl` | Design handoff/prototype; #17/#22; #24–26 publication |
| P-overnight | `2026-09-14T01-54-18-236Z_01a09d9f-4dfc-7227-8f0f-02521e415776.jsonl` | #18/#23/#19/#20; #28–31 publication |
| P-cleanup | `2026-09-14T18-07-19-556Z_01a0a11a-2203-7472-9868-7b3d5cfb44b9.jsonl` | Later prototype-server termination |

Codex root: `~/.codex/sessions/2026/09/`

| Key | Exact relative filename | Role |
|---|---|---|
| C-conversion | `09/rollout-2026-09-09T18-27-35-01a088ed-6791-73e0-8f19-3b8a033056f5.jsonl` | PR #12 review; September 10 UTC |
| C-seek | `10/rollout-2026-09-10T12-39-05-01a08cd4-b546-7c72-aeaa-063b04caf0a2.jsonl` | PR #14 review |
| C-player | `10/rollout-2026-09-10T15-09-34-01a08d5e-7c0d-7f33-9ce9-0952ba55d9df.jsonl` | PR #16 review before the later blur repair |
| C-design | `13/rollout-2026-09-13T12-15-33-01a09c32-3f86-7b63-a39f-4f74c62cff21.jsonl` | #21 image exploration; [reopen](codex://threads/01a09c32-3f86-7b63-a39f-4f74c62cff21) |

The Codex investigation screened 606 rollout metadata records, 55 matching repository/worktree cwd records, and inspected four relevant parents plus eight child/guardian records. It found no corresponding Codex app/CLI implementation sessions for #17–20/#22–23 in this period. That is a bounded local-archive finding, not proof against deleted, remote-machine, or differently rooted sessions. Inherited/quoted transcript content was not counted as new work.

### Method and confidence

Three read-only research agents separately investigated GitHub/code, Pi history, and Codex history; the parent reconciled them against architecture/product documents and representative source/evidence. Their retained briefs are under the Pi root above at:

```text
subagent-artifacts/outputs/afb981b1-a406-4301-a1ab-c3d70ea5e642/research/
  stack-evidence.md
  pi-history.md
  codex-history.md
```

Fresh work included API/ref/ancestry inspection, representative source and incremental-diff inspection, historical tool-result analysis, and recomputing all 166 input hashes. **No build, test suite, browser session, audible output, deployment, or GitHub mutation was performed for this report.** Historical validation is identified as historical; some full logs still live in temporary paths, so committed excerpts are not a complete portable replay archive.

Confidence is high in delivered scope, session attribution, recorded decisions/repairs, current stack state, and input identity. This report does not certify subjective sound, arbitrary media compatibility, broad host performance, legal entitlement, or absence of every defect. Its only repository change is this document.
