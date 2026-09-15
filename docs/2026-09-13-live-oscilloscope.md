# First live oscilloscope (#23)

Date: 2026-09-13. **Parent accepted for stacked PR publication after independent review and correction.**
Inherits [#21's approved composition](2026-09-13-wave-player-prototype.md), #22 playback and
[#18's separate source waveform](2026-09-13-source-waveform.md). No loops, lab/prototype changes,
new decoder, fonts, audio callback work, deployment or audible verification.

## Approved signal and ownership contract

The parent approved this contract before dependent implementation:

- **Rendered, before listening gain/mute.** `PreparedProof` privately owns a lazy
  `ChannelSplitterNode → AnalyserNode(s) → zero-gain destination` branch of the actual worklet
  output. Fixed engine gain 0.5 and output-rate conversion are included. Listening volume and
  mute do not change the picture. The observation route cannot become another audible route.
- Mono is one solid trace; stereo is **left solid / right dashed**, independently observed and
  overlaid. Neither signed averaging nor accidental analyser downmix erases opposing/right-only
  signals. Silence is a flat line; amplitude is fixed full scale, visually clipped at ±1.
- Each analyser returns a **2048-sample trailing window**. Capture/draw is capped at 30 Hz,
  without catch-up. Three reusable two-channel windows retain **48 KiB of JS samples** total;
  no new sample allocation or worker transfer occurs per frame. Canvas draws at most 12,288
  signal vertices plus two baseline vertices, with alpha 1 / 0.24 / 0.10 from newest to oldest.
  DPR is capped at 2 and the backing image at 760 × 1000 (3.04 MB RGBA). Browser analyser history
  and compositor memory are browser-managed, not included in the JS sample bound. No custom FFT,
  callback queue, scene framework, extra decoder or worklet observation message is introduced.
- **Timing is approximate and untagged.** This private browser view does not implement the
  architecture's canonical timestamped observation API. Samples have no source/epoch/render-frame
  interval or presentation timestamp. A 2048-sample history spans 42.67 ms at 48 kHz or 46.44 ms
  at 44.1 kHz, plus browser buffering and scheduling/capture/paint latency. There is no guaranteed
  lag, speaker synchronization or association with the latest 100 ms transport snapshot.
- A current-epoch ready snapshot is only an **eligibility gate**, not a sample tag. Seek destroys
  the old analyser branch immediately. A new branch is created only while running and ready,
  then waits `(2048 + 1024) / contextRate` seconds of advancing AudioContext time (64 ms at 48 kHz).
  Ordinary resume restarts that warmup. This conservative freshness policy cannot be satisfied by
  wall time spent paused; it is not proof of exact source-to-image timing.
- The owner invalidates the consumer revision before seek/replay, replacement, close or runtime
  failure. Every rAF read rechecks that revision and playback state; synchronous owner updates
  clear retained frames. The visual never requests a status snapshot, seeks or starts audio.
  Existing command/status ordering, acknowledged pause/EOS and source-waveform identity remain.
- First listening-gain creation after **file** activation disconnects only the former direct
  destination, preserving a tap already present. Proof-only `activate()` retains its original
  channel-zero muted analyser route; setting listening gain must not replace that route.

## States and composition

| State | Visual behavior |
| --- | --- |
| Empty/loading/file error | Existing instructions, preparation/cancel and error recovery; no invented signal |
| Playing/warming | Wait for eligible rendered history, then actual traces and channel/pre-volume legend |
| Audio paused | Freeze last observed image, explicitly labelled; no ongoing reads/draws |
| Paused seek or paused remount | Clear old image; “Paused · Play to observe” |
| Seeking/replacement | Clear histories immediately; current revision and readiness gate all reads |
| Ended | Stable baseline, no live signal; existing terminal suspended transport and explicit Replay |
| Reduced motion | Stable baseline and explanation, no continuing capture/draw; never pauses audio |
| Settings Pause visual | Stable baseline and “audio unchanged”; independent from audio Pause |
| Hidden/narrow library | Stop rAF, clear retained history, detach analyser branch; returning waits for fresh data |
| Analyser/Canvas unavailable or failed | Clear/hide canvas, explanatory text on paired CSS surface; transport remains usable |

Theme changes only repaint existing observations. Desktop companion browsing does not rewire the
owned tap; narrow visual unmount, hidden view, reduced motion and manual visual pause do detach it.
Ordinary audio pause/ended can retain the tap while the context is suspended; analyser/browser graph
resources are still retained until release/close. There is no claim that stopping JS alone removes
all browser graph cost. Cleanup targets the observation branch only and cannot fail playback.

The existing 380 × 532 desktop card, ≥1212px companion, narrow internal library, full 40px waveform,
identity and transport remain stationary. Light green ink/pale sage and dark pale phosphor/green-black
are deliberate **signal and surface** pairs, with distinct solid/dashed channel semantics. Fine
persistence stays inside the field, not a neon chassis. [DESIGN.md](../DESIGN.md) records the exact
local palette. Transport position/status and keyboard seeking remain independently accessible.

## Validation and corrections

All builds/checks ran with **Bun 1.4.0** in one plain isolated copy:
`/tmp/kkb-audio-23-validation-WiYfgc` (macOS resolves it as `/private/tmp/...`). Installed dependencies
were symlinked; `.git`, `target`, `web/dist` and `web/src/generated` were excluded when copying.
Cargo only built that copy's Wasm through the existing build command. Rust/worklet sources did not
change; separate Rust test/clippy/device checks were not run. Physical/audible tests remain unrun.

Final parent full `bun run check`: **147 tests passed, zero failed** (96 web tests, 12 WAV/conversion/seek,
3 MP3, 3 source-waveform, 6 lab, 8 lab UI, 19 player UI), plus typecheck, compiled kernel/plan checks,
fixed 16 MiB Wasm verification and both callback audits with empty forbidden-pattern findings.
Focused observation/render/owner checks passed **25 tests / 186 assertions** before the UI repairs;
all are included in the final full suite. New coverage includes first gain creation before/after
activation with a tap, proof route regression, conservative seek/resume warmup, stale owner revisions,
setup/read failures, three-window storage and vertex bounds, manual visual pause, eventless
reduced-motion reconciliation and failure-caption precedence across preference changes.

The isolated built player ran only on owned loopback port 4239, through named `agent-browser`
Chromium sessions launched with `--mute-audio` **and player mute before Play**. Known authored WAVs
and repository MP3 frame fixtures, not user music, exercised actual rendering. The complete browser
batch passed **39 assertions**, with no page errors, before the final reduced-motion pixel repair.
That batch covers opposite-phase/right-only/distinct stereo, mono silence, 44.1→48 kHz conversion,
actual supported MP3, pause/seek/replacement/close, source-waveform stability, terminal/replay,
light/dark compact/companion/narrow layouts, manual visual pause and Canvas/analyser failure.
Injected `document.hidden` established lifecycle only, **not actual background throughput**.

Three distinct findings are retained, not erased by the passing checks:

1. First batch exposed repeated reduced-motion drawing: each status poll hid/unhid the canvas,
   triggering ResizeObserver. Removed that repeated visibility toggle; added stable visual-pause
   UI coverage. Initial log: `/tmp/kkb23-browser-initial.log`; original evidence remains
   `/tmp/kkb23-evidence/`.
2. After rebuilding, the owned proof server's startup filename allowlist no longer included new
   hashed assets (`tools/proof-assets.ts`). Confirmation failed before assertions with empty DOM /
   no Settings. Parent approved restarting only that isolated server. Exact setup log:
   `/tmp/kkb23-browser-rebuild-setup-failure.log`; `/tmp/kkb23-evidence-setup-failure/`.
3. Although the next batch's DOM/suppression assertions passed, its reduced-motion screenshot
   retained a signal. A parent-approved targeted diagnostic established a **real backing-pixel
   bug**, not a capture artifact: reduced preference/visible caption/no animations, but 9889
   non-surface pixels remained after two rAFs (`/tmp/kkb23-reduced-diagnostic.json`). Polling could
   observe a changed media preference without the event-driven forced redraw. The final fix
   includes reduced preference in update change detection; an eventless-preference UI regression
   now requires one baseline redraw and no later reads/draws. Diagnostic setup also retained an
   escaped-selector timeout and premature transition-click no-op; adding the established
   settled/focused interaction fixed that diagnostic harness, not application behavior.

After the final pixel repair the **entire 146-test check was rerun**, then one targeted real
media-emulation browser confirmation passed. [Backing-pixel evidence](2026-09-13-live-oscilloscope/reduced-motion.json)
shows 13,817 signal pixels before reduction and **zero non-baseline pixels afterward**, correct visible
caption, no animations, unchanged read/draw counts over the stable interval and running audio.
[Confirmed screenshot](2026-09-13-live-oscilloscope/reduced-motion-confirmed.png) was inspected.
The earlier suspect PNG remains `/tmp/kkb23-evidence-final/reduced-motion-dark.png`; it is not passing
final evidence. The full 39-assertion batch/workload was **not** rerun after this preference-only fix.
The main browser harness now also asserts reduced backing pixels for future runs.

### Independent review and parent correction

Fresh observation/ownership and UI/render reviewers independently passed the core implementation,
with the same P2: after Canvas/analyser failure, reduced-motion toggling could overwrite the failure
caption and leave it falsely blaming reduced motion after the preference was disabled. The parent
reproduced that exact sequence without remounting, then moved the terminal failure guard ahead of
preference-label handling. The unavailable explanation now takes precedence, with no reads or
playback interruption. This is a caption/lifecycle-order correction, not a signal/render-style change.

The regression first [failed on the original caption](2026-09-13-live-oscilloscope/parent-caption-red.log),
then all [19 player UI tests passed](2026-09-13-live-oscilloscope/parent-caption-green.log).
The parent also independently reran the original 146-test implementation suite before repairing,
and the [final full 147-test check](2026-09-13-live-oscilloscope/parent-final-check.log) after repairing.
The retained UI reviewer [passed this narrow correction](2026-09-13-live-oscilloscope/review-ui-recheck.md).
The [observation review](2026-09-13-live-oscilloscope/review-observation.md) found the same now-fixed P2.
Both the broad browser batch and the
later reduced-motion pixel capture precede this final failure-caption-only repair; neither is claimed
as a browser rerun of the final source. No additional browser/polish round was needed for the
DOM-caption defect exercised by the real React component test.

## Bounded foreground workload (pre-final preference-only fix)

[Exact summary](2026-09-13-live-oscilloscope/workload.json): macOS arm64/Bun 1.4.0;
HeadlessChrome/152.0.0.0 UA, 48 kHz context, 1440 × 1000 viewport. During **10.062 seconds** of
actual unheld foreground opposed-stereo playback: **222 draws, 444 channel reads**, approximately
22.1 draws/second. Instrumented fillRect-through-last-stroke wall time averaged **2.25 ms**,
p95 **5.0 ms**, maximum **5.6 ms**. Each full frame stayed within 12,290 vertices. This includes
probe overhead and excludes compositor/GPU completion; it is not an uninstrumented benchmark.
Process count advanced 598→4348, source/render frames 76,544→556,544; starvation count stayed
**0→0**, failure 0, memory 16,777,216 bytes. No universal background, GPU, device or browser
performance claim follows. Other fixture observations: right-only peak 0 / 0.299988; distinct
220/330 Hz channels had 9/14 positive crossings per window; mono silence peak 0; converted mono
peak 0.299996; actual MP3 nonzero stereo. The source WAV peak was 0.6 before engine gain.

## Screenshots and retained reproduction

The following full-player composition/fallback captures precede the preference-change redraw fix
and parent failure-caption correction; their live/library/failure surfaces were not subsequently restyled:

- Compact [light](2026-09-13-live-oscilloscope/compact-light.png) / [dark](2026-09-13-live-oscilloscope/compact-dark.png).
- Companion [light](2026-09-13-live-oscilloscope/desktop-library-light.png) / [dark](2026-09-13-live-oscilloscope/desktop-library-dark.png).
- Narrow library [light](2026-09-13-live-oscilloscope/mobile-library-light.png) / [dark](2026-09-13-live-oscilloscope/mobile-library-dark.png).
- Narrow visual [light](2026-09-13-live-oscilloscope/mobile-visual-light.png) / [dark](2026-09-13-live-oscilloscope/mobile-visual-dark.png).
- [Renderer failure](2026-09-13-live-oscilloscope/renderer-failure-light.png) / [unavailable](2026-09-13-live-oscilloscope/renderer-unavailable-light.png).

One batched inspection against the approved prototype, a necessary suppression repair, and targeted
correctness confirmation were performed; the parent separately authorized diagnosis/repair of the
pixel defect. No open-ended polish was done. Mechanical design detector advisories were the existing
scoped 22px title and new local palette values (now documented); no shared font/token migration.
Human visual judgment, screen-reader testing and browser coverage beyond this Chromium remain open.

Reproduction (only after creating/building a new isolated copy, never the daily-driver checkout):

```sh
# In the isolated copy, with repository Bun 1.4.0 first in PATH.
bun run check
PORT=4239 bun tools/serve-proof.ts
# Restart this owned server after a rebuild; its asset allowlist is captured at startup.
PLAYER_URL=http://127.0.0.1:4239/player.html PLAYER_EVIDENCE=/tmp/kkb23-new-evidence \
  bun tools/check-oscilloscope-browser.ts
PLAYER_URL=http://127.0.0.1:4239/player.html PLAYER_EVIDENCE=/tmp/kkb23-reduced-evidence \
  OSCILLOSCOPE_FIXTURE=/tmp/kkb23-new-evidence/fixtures/opposed.wav \
  bun tools/check-oscilloscope-reduced-browser.ts
```

Final parent check: [retained log](2026-09-13-live-oscilloscope/parent-final-check.log).
Prior implementation logs: `/tmp/kkb23-check-post-pixel-fix.log`, `/tmp/kkb23-typecheck-final.log`,
`/tmp/kkb23-browser-post-pixel-fix.log`. Full pre-final-fix browser log/data:
`/tmp/kkb23-browser-final.log`, `/tmp/kkb23-evidence-final/observations.json`.
All owned browser sessions and the owned proof server were closed. Daily `web/dist`,
`web/src/generated` and `target` were only read: **13,738 file hashes match before/after**,
manifest SHA256 `9e228882177116d2762f1d9f20de2a18b80593e8859ca2802c6fe797393e786f`.
The original worker source-copy/build identities and exact baseline diff (including new text,
excluding PNG bytes) accompany its handoff under `/tmp/kkb23-*`. The parent separately records final
[runtime/test/build-input identity](2026-09-13-live-oscilloscope/parent-validation-identity.json)
after the caption repair. The worker did not stage, commit, push,
change branches, mutate GitHub, deploy or build daily-driver outputs. Parent publication is separate
from those implementation checks; no merge, deployment or audible verification is authorized.
