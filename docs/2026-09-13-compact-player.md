# Compact local player — implementation and evidence

Date: 2026-09-13. Issue: #22. Branch: `feat/22-compact-player`, stacked on
`d5da0b02fcee38a2367506a67e8cb6b231b9b5a7` / `feat/17-local-mp3`.
**Status: implemented and accepted after final independent lifecycle/design rechecks and parent documentation inspection.**
Verification used isolated builds and muted Chromium. Deployment, physical output and listening
checks were not performed; acceptance does not authorize merging.

## Delivered slice

The [approved interactive prototype](2026-09-13-wave-player-prototype.md#approval-and-next-boundary)
is the visual authority, not the earlier one-file demo. The player now uses real local WAV/MP3
files and the existing Rust/Wasm `PlaybackOwner`. The silent prototype and lab/proof behavior
remain unchanged. No second playback owner, synthetic clock, waveform, decorative analyzed bars,
loop placeholders or reference-study artwork were introduced.

- **Collection:** maximum 100 File references, preserving picker order. Admission reads no bytes;
  it accepts `.wav`/`.mp3` case-insensitively and explicitly counts unsupported/over-limit files.
  Byte-level codec support is checked only when activated. Repeated/same-named files have distinct
  monotonically allocated identities. No deduplication by filename, persistence, directories,
  metadata extraction, eager inspection or decoded collection cache.
- **Truth:** filename is the identity; artist/album/artwork remain unavailable. Duration is unknown
  until actual preparation, then retained as bounded metadata. Errors do not disable browsing/retry.
- **Intent:** row selection is independent. Row Play explicitly prepares/plays; current row
  pauses/resumes/replays. Ordinary activation remains paused. Previous/next replace at zero,
  preserving playing/paused intent, including explicit intent during pending preparation. No wrap
  or automatic advance. EOS is terminal; seek-back stays paused; Replay explicitly starts at zero.
- **Management:** Settings contains Add files, Remove selected and Clear session. Empty player
  additionally offers Open files. Close track/Cancel loading in Settings retains the collection;
  the visual loading state also offers Cancel. Removing inactive does not interrupt. Removing
  active or Clear cancels/closes without a playback successor. Removed selection moves to the next
  remaining row, or previous at the end. Original files are never modified.
- **Ownership:** a small private `PlayerCollection` coordinates File identity and activation intent
  above the incumbent owner. Generation guards reject obsolete autoplay/completion. The owner
  still owns preparation, cancellation, one in-flight poll/command, acknowledged pause, seek,
  epoch/resource disposal and gain. Rust, codec/PCM transport, callbacks and preparation modules
  are unchanged. View/theme/responsive changes never replace the owner.

## Composition and accepted adaptations

The final source keeps the approved 380 × 532px desktop object, 64px identity, 330px visual area,
40px functional seek target, elapsed/duration and independently centered transport. At 1440 × 1000
its card is x=530, y=220, width=380, height=532. Opening a 380px companion at x=922 leaves the card,
identity, seek and transport stationary, including during native disclosure frames. The 12px gap
and ≥1212px companion threshold match the prototype. Below that threshold only the visual area
becomes the library. At 390 × 844 the card is 366 × 640 at x=12, y=88; at 320 × 568 it is 296 × 440
at x=12, y=60. Short pages can scroll vertically; no inspected width overflows horizontally.

Rows remain 68px with reserved 44px playback targets, desktop hover/focus reveal and persistent
narrow controls. Selection is exposed with `aria-pressed`, current identity with `aria-current`,
without LOADED/SELECTED badges or row-management controls. Long filename ellipsis preserves fixed
geometry and full accessible/native titles. Prepared sub-second MP3 fixtures truthfully round to
`0:00`; unknown durations instead show `—`.

Inter, TX-02, Departure Mono and regular Phosphor definitions actually load. The visual is a quiet,
semantic unavailable surface; the thin functional navigation rail is **not** an analyzed waveform.
The missing loop utility is omitted, not disabled. Those product-truth adaptations deliberately
replace the prototype's image and synthetic data while preserving its bounds and hierarchy.
Settings provides System/Light/Dark; preferences are not saved. Volume remains left-anchored,
opaque and above navigation, with mute/slider/percentage. The strip is 184px wide; its 44px-high
live controls plus border make its outer height 46px. Narrow transport uses practical 44px targets.

React 19.3 stable ViewTransition is limited to library and Settings disclosures. Transport,
selection, consumed clock and theme updates stay urgent. Exit fill remains transparent after the
fade ends; root cross-fading is disabled. Volume uses Base UI's live popup fade only, with no native
snapshot owner. Reduced-motion and no-native-API fallback preserve behavior.

### Comparison screenshots

The table below preserves the original captures. See [approved review repair](#approved-review-repair) for separately retained current captures and checks.
All retained screenshots are from the isolated **built** player, not generated mockups:

| State | Evidence |
| --- | --- |
| Desktop empty / compact light | [empty](2026-09-13-compact-player/desktop-empty-light.png), [real playing WAV](2026-09-13-compact-player/desktop-compact-light.png) |
| Desktop unprepared companion | [library light](2026-09-13-compact-player/desktop-library-unprepared-light.png) |
| Desktop Settings / dark companion behind | [Settings dark](2026-09-13-compact-player/desktop-settings-dark.png) |
| Narrow library | [light](2026-09-13-compact-player/mobile-library-light.png), [dark](2026-09-13-compact-player/mobile-library-dark.png) |
| Narrow compact / long filename | [compact light](2026-09-13-compact-player/mobile-compact-light.png), [long filename](2026-09-13-compact-player/mobile-long-filename-light.png) |
| Narrow Volume | [dark](2026-09-13-compact-player/mobile-volume-dark.png) |
| Narrow loading / error | [held preparation](2026-09-13-compact-player/mobile-loading-light.png), [malformed file](2026-09-13-compact-player/mobile-error-light.png) |
| 320px fit | [320 × 568](2026-09-13-compact-player/narrow-320-light.png) |

Compared at legible scale with approved [compact light](2026-09-13-wave-player-prototype/compact-light.png),
[desktop library light](2026-09-13-wave-player-prototype/desktop-library-light.png),
[mobile library dark](2026-09-13-wave-player-prototype/mobile-library-dark.png) and
[Volume mobile dark](2026-09-13-wave-player-prototype/volume-mobile-dark.png).
The batched first inspection found missing copied desktop geometry variables; the one batched fix
restored exact dimensions/centering before the confirmation captures above. No concept/research
workflow or further polish round was run.

**One explicitly approved accessibility correction postdates the original screenshots:** `.player-error` changed
only `color: var(--destructive)` → `color: var(--foreground)`. The error screenshot therefore shows
the old red text; current source/build uses foreground ink. Role=alert, wording, typography, layout
and palette are unchanged. [Numerical WCAG contrast evidence](2026-09-13-compact-player/kkb-audio-22-contrast.txt):
light improved **3.7289 → 16.2906:1**; dark **4.8730 → 17.8406:1**. Both final values exceed 4.5:1.
No screenshot or detector round was rerun for that color-only correction; full checks were rerun.

## Approved review repair

Parent approved one finishing batch after lifecycle review passed and design review requested two
narrow corrections. Removed only the empty-state `YOUR MUSIC` decoration; retained loading/error
feedback, instructions, Open files and all geometry. Added `approved #21 prototype` to FORM and its
quotation below. This is attribution clarification, not a new design direction: OWN-WORLD already
identified the approval. No CSS, owner, engine, collection or browser-harness changes in this batch.
Existing admission tests gained focused empty-state assertions; no new standalone decoration test.

Repair validation used Bun 1.4.0 and the new plain copy
`/tmp/kkb-audio-22-validation-repair-oJ1Iuj`, not the earlier validation copy or daily outputs.
`bun run build:worklet && bun run typecheck && bun run check:player-ui` passed:
**15 UI tests, zero fail, 113 assertions** ([log](2026-09-13-compact-player/repair/build-typecheck-ui.txt)).
The full 123-test check below remains pre-repair evidence; this batch reran the affected checks only.
[Emitted contract verification](2026-09-13-compact-player/repair/direction-contract.txt) matched source verbatim.

The corrected broad harness ran **once** against `http://127.0.0.1:42823/player.html`:

```sh
PLAYER_URL=http://127.0.0.1:42823/player.html \
PLAYER_EVIDENCE=/Users/kalynbeach/dev/kb/kkb-audio/docs/2026-09-13-compact-player/repair \
bun tools/check-compact-player-browser.ts
```

[Repair browser log](2026-09-13-compact-player/repair/browser-check.txt): **47 passing assertions**,
including real-pointer preview/cancel/single acknowledged commit; actual page errors `[]`, console
only React DevTools info. This closes the previous whole-harness evidence gap without erasing its
historical failures. Chromium launch used `--mute-audio` and player mute before playback. Actual
owner/context persistence, WAV/MP3 transport, removal/cancellation/recovery, fixed geometry,
40px navigation, 68px rows and no horizontal overflow passed. No failures or retries in this batch.
Owned browser session and server are closed; final session list was empty and port 42823 had no listener.

All twelve same-state screenshots were recaptured once and inspected together; originals remain
unchanged. These are current build evidence, including foreground error ink:

- Desktop 1440 × 1000: [empty](2026-09-13-compact-player/repair/desktop-empty-light.png),
  [compact](2026-09-13-compact-player/repair/desktop-compact-light.png),
  [unprepared library](2026-09-13-compact-player/repair/desktop-library-unprepared-light.png),
  [Settings dark](2026-09-13-compact-player/repair/desktop-settings-dark.png).
- Narrow 390 × 844: [library light](2026-09-13-compact-player/repair/mobile-library-light.png),
  [library dark](2026-09-13-compact-player/repair/mobile-library-dark.png),
  [compact light](2026-09-13-compact-player/repair/mobile-compact-light.png),
  [long filename](2026-09-13-compact-player/repair/mobile-long-filename-light.png),
  [Volume dark](2026-09-13-compact-player/repair/mobile-volume-dark.png),
  [loading](2026-09-13-compact-player/repair/mobile-loading-light.png),
  [error](2026-09-13-compact-player/repair/mobile-error-light.png).
- 320 × 568: [fit](2026-09-13-compact-player/repair/narrow-320-light.png).

The repaired empty state omits the decorative eyebrow; loading still shows PREPARING and Cancel.
The mobile compact capture includes a faint transient Settings exit snapshot: the existing harness
waits for popup DOM removal, not native exit completion at that capture. It is not a clean settled
visual capture; retain the qualification for reviewer inspection. No extra recapture or polish hunt.
No detector rerun: the original `[]` remains historical source-target evidence only.

[Repair identity](2026-09-13-compact-player/repair/validation-identity.txt) verifies the same **142**
source/test/fixture/build-input paths byte-identical to the repair copy.
[Manifest](2026-09-13-compact-player/repair/validation-source.sha256) SHA256:
`99cf67827a8eae58fc37bde214a68f6552678387d2d78d835ee7e70592af3722`.
Repair daily-output [before](2026-09-13-compact-player/repair/daily-output-before.sha256) and
[after](2026-09-13-compact-player/repair/daily-output-after.sha256) compare equal, both SHA256
`04b9a54f2c2d7c12e291ff0f05113708ede4b0190734f9ba6154b3e0ed5b4b96`.
`git diff --check` passed; no files were staged at the repair handoff. Final reviewer rechecks and
parent acceptance are recorded below. TX-02 entitlement and listening/device/cross-browser boundaries remain.

## Final parent acceptance

The retained lifecycle reviewer passed with no issues; the design reviewer returned **ship**, with
both finishing findings resolved and no introduced regressions identified in the targeted recheck.
Parent inspected the exact repair-only diff, independently verified all 142 final manifest paths
against both source and repair copy, and reran typecheck plus all 15 UI tests / 113 assertions.
The independent parent 123-test full-suite rerun remains pre-repair evidence, not a final-suite claim.

Parent also inspected the completed [design system](../DESIGN.md) and
[extensions-only sidecar](../.impeccable/design.json), then independently reran the documenter's
Bun validation: 16 exact source colors, token/component references, eight source-derived samples,
verbatim narrative, local links and all 13 incumbent lab paragraphs passed. This documentation-only
pass changed no runtime source or build output and grants no font rights.

The original worker's 1,800,000ms infrastructure timeout occurred after final checks but before its
handoff. Parent preserved the partial diff/archive; same-protocol recovery completed the handoff
without rerunning completed checks. The recovery/review/documentation workflow completed all seven
children. Historical failures and the transient repair capture remain qualified below. Parent
accepts this bounded #22 delivery for stacked publication; merging remains Kalyn's responsibility.

## Original executed validation

All TypeScript tooling used repository-local Bun 1.4.0. Build/check ran only in a new plain source
copy `/tmp/kkb-audio-22-validation` with installed dependencies linked, excluding `.git`, `target`,
`web/dist` and `web/src/generated` from copying. It was not a Git worktree. The only server was the
owned loopback `http://127.0.0.1:42822/player.html`, serving that copy's emitted assets.
Owned browser sessions and the owned server are closed.

```sh
export PATH=/Users/kalynbeach/dev/kb/kkb-audio/node_modules/.bin:$PATH
bun test web/test/player-collection.test.ts web/test/playback-owner.test.ts
bun run check:player-ui
# In /tmp/kkb-audio-22-validation only:
bun run check
PLAYER_URL=http://127.0.0.1:42822/player.html \
PLAYER_EVIDENCE=/Users/kalynbeach/dev/kb/kkb-audio/docs/2026-09-13-compact-player \
bun tools/check-compact-player-browser.ts
# Approved focused evidence-gap closure, not a second visual round:
PLAYER_POINTER_ONLY=1 PLAYER_URL=http://127.0.0.1:42822/player.html \
PLAYER_EVIDENCE=/Users/kalynbeach/dev/kb/kkb-audio/docs/2026-09-13-compact-player \
bun tools/check-compact-player-browser.ts
git diff --check
```

- [Targeted owner/collection](2026-09-13-compact-player/targeted-check.txt): **25 pass**, 167 assertions.
  New collection suite: nine cases covering limit/admission/no eager preparation, independent
  selection, same names, activation/navigation intent, removal/Clear/close, stale completion,
  cancellation and error recovery. Incumbent owner suite reused, not duplicated.
- [Final full check](2026-09-13-compact-player/full-check.txt): **123 tests pass, zero fail**:
  web/test 79; WAV 12; MP3 3; lab runtime 6; lab UI 8; player UI 15. Includes build/typecheck, Wasm
  fixed-memory/kernel/plan checks and both callback audits with empty forbidden-pattern arrays.
  Player UI has 107 assertions, retaining seek preview/commit/cancel/EOS coverage and adding real
  collection integration, same-name cancellation, Settings/library focus, theme/responsive owner
  persistence and error recovery. No ignored physical-output Rust tests were run.
- [Browser confirmation](2026-09-13-compact-player/kkb-audio-22-browser-confirmation-original.txt):
  **45 passing assertions** against built Chromium. Actual workers/AudioContexts were counted without
  changing application source. Addition made zero workers/contexts; explicit WAV Play made one;
  library/theme/responsive changes retained that same worker, context and seek node. WAV pause/seek,
  authored MP3 replacement/natural EOS/replay, previous/next intent, malformed recovery, active and
  inactive removal and Clear were exercised. Held startup messages delayed a **real** worker only
  for loading/cancel inspection; cancellation terminated all obsolete workers/closed contexts.
  Native exit snapshots, fixed disclosure geometry, narrow row targets, Volume hit testing/opaque
  backing/live fade, focus return, reduced motion and no-native fallback passed.
- [Focused real-pointer check](2026-09-13-compact-player/kkb-audio-22-pointer-check.txt): **three pass**.
  Documented real mouse move/down/up plus Escape verified preview without a seek, cancellation
  blocking subsequent move/release, and exactly one acknowledged worker seek on release. Actual
  page-error payload is `errors: []`; console contains only the React DevTools informational notice.
  This is the authoritative pointer/console evidence, not the earlier synthetic-event assertion.
- Detector ran **exactly once** after the batched UI fix:
  `bun /Users/kalynbeach/.agents/skills/impeccable/scripts/detect.mjs --json web/src/player-app.tsx web/player.css web/player.html`.
  [Output](2026-09-13-compact-player/detector.json): `[]`, exit 0; no warnings to disposition.
  It is source-target detection, not broad runtime accessibility certification. No rerun.

### Setup failures and evidence qualifications

- Initial UI volume test failed because Happy DOM has no layout and Base UI hides its edge-aligned
  thumb until measured. A test-only nonzero slider measurement shim fixed the test; real browser
  checks verified the visible named thumb and hit targets. Initial typecheck caught unsupported
  testing-library `exact` options and untyped Happy DOM access; those test issues were corrected.
- First confirmation invocation used unsupported `find role button focus`. Exact
  [command/error](2026-09-13-compact-player/kkb-audio-22-browser-setup-failure.txt) is preserved.
  `agent-browser doctor --offline --quick` reported 9 pass, 0 warn/fail. Retry used documented
  `focus <selector>`; it did not switch runners or start another polish round.
- The original full browser helper discarded non-eval payloads and printed `Browser console:
  undefined`; **that log does not establish console cleanliness**. Its synthetic pointer event
  may also have produced capture errors, but no cause is asserted without retained error evidence.
  The helper now preserves actual payloads and uses real mouse gestures. Parent approved focused
  pointer/error verification instead of another full visual run.
- The focused setup first [timed out waiting for Playing](2026-09-13-compact-player/kkb-audio-22-pointer-setup-timeout.txt)
  before pointer testing. A transition/click race is a hypothesis, not a proven cause. One approved
  retry waited for observable disclosure/animation completion, refreshed controls and verified
  actionability; the focused check then passed with empty actual page errors. No application code
  was changed for either browser invocation issue. The final whole browser harness was not rerun;
  broad assertions are from the preserved confirmation, the updated real-pointer path from its
  focused execution.
- An initial relative screenshot path was rejected by the daemon's different working directory;
  all retained captures use absolute paths. Python's environment emitted unrelated unavailable
  BLAKE2 constructor warnings during initial manifest generation; SHA256 identity was independently
  revalidated with Bun CryptoHasher and `shasum`.

### Isolation and source identity

[Manifest](2026-09-13-compact-player/validation-source.sha256) covers **142 source/test/fixture/build-input
files**, including fonts, decoder fixtures, notices and unchanged Rust. All are byte-identical between
main source and validation copy; [Bun verification](2026-09-13-compact-player/validation-identity.txt).
Manifest SHA256: `396cea47523bfdcc735f12abba10db64116e0d5b8140d07b557867e7e38513dd`.
The post-screenshot error-color correction is included in that final identity and full check.

Main checkout daily-driver outputs were hashed before/after and not built or modified.
[Before](2026-09-13-compact-player/daily-output-before.sha256) and
[after](2026-09-13-compact-player/daily-output-after.sha256) manifests compare equal, both SHA256
`04b9a54f2c2d7c12e291ff0f05113708ede4b0190734f9ba6154b3e0ed5b4b96`.
No staged files. Documentation/evidence copies are synchronized separately from generated outputs.

## Direction contract and asset provenance

The built HTML preserves this explicit `meta[name="direction-contract"]` contract:

> THESIS: a compact track-first listening object. OWN-WORLD: user-pinned approved #21 prototype,
> not a generated seed. STORY: identity, honest visual, position, transport, companion library.
> FIRST VIEWPORT: centered player; local files, this session only. FORM: approved #21 prototype;
> square 380 × 532 desktop object, Inter / TX-02 / Departure Mono, paired semantic modes.

Inter's existing notice, Phosphor MIT notice and actual Departure Mono OFL are emitted by the build.
The old prototype notice accidentally copied the upstream website MIT license. With parent approval,
it was replaced by the actual font OFL from immutable upstream commit
`75152a3f1e6dacdd248a6c397c97dbf27e33eea0`, `public/assets/LICENSE`. Font bytes are unchanged and
byte-identical to that upstream WOFF2 (SHA256 `5b4fed1daa90708aa9c6ee1190abca9dc22164a1c1def0020386e46b61038cfb`);
license SHA256 `b65e42750f3cb65437a97f4dfd781c58f199259949db2341012be60e32500e83`.
Built notice compares identical. See [notices](../THIRD_PARTY_NOTICES.md). Existing TX-02 entitlement
remains unverified; this work preserves its asset/use/distribution boundary without inventing a
license claim. The study's phosphor image is not shipped.

## Remaining boundaries

These are muted headless Chromium and device-free/synthetic-fixture checks, **not** listening,
physical touch-device, screen-reader, background-playback, cross-browser or click-free-seek
certification. The short MP3 fixtures certify frontend integration/EOS, not a music listening
experience. Dense small metadata, real long recordings and OS file-picker behavior still deserve
human review. No real artist/album/artwork data is claimed. Waveform (#18), visualization (#23),
loops (#19/#20), catalogs, playlists/queues, persistence and deployment remain separate work.
Final reviewer rechecks used the separately retained repair evidence, including its transient-capture
qualification and the TX-02 entitlement boundary. Parent acceptance preserves these limitations;
publication does not certify the excluded behavior.
