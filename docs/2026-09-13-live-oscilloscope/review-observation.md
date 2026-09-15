## Review

Scope: saved baseline diff against `8cfa28dc5002b043e40c2a6e77ff424bce64e26f`, issue snapshot, implementation source, documented approved contract, tests and retained runtime evidence. Read-only; no commands, browser execution or edits performed.

### Correct

- **Signal and routing:** Independent splitter outputs feed mono analysers before listening gain, through a zero-gain observation sink (`web/src/oscilloscope-tap.ts:14–28`). File gain creation disconnects only the former direct destination; proof activation remains separate (`web/src/prepared-playback.ts:223–247`). Tests cover both gain-creation orders and proof routing. Retained browser assertions corroborate phase-opposed/right-only channels and approximately 0.3 rendered peaks from 0.6 source amplitude despite mute.
- **Freshness and ownership:** Seek releases the old tap and resets readiness; current-epoch readiness gates recreation, followed by advancing-context-time warmup. Resume restarts warmup (`web/src/prepared-playback.ts:116,244–246,258–263,293–306`; `web/src/oscilloscope-tap.ts:31–46`). Owner revisions reject obsolete consumers across seek/replay, replacement, close and failure (`web/src/playback-owner.ts:60–65,79–80,116–117,163–166,214–216`).
- **Bounded consumer:** Three reusable two-channel windows retain 49,152 sample bytes. Sampling is throttled without catch-up; rendering bounds backing dimensions and signal vertices (`web/src/oscilloscope-render.ts:3–24,29–31,42–58`; `web/src/player-oscilloscope.tsx:36–49`). No extra decoder or callback sampling machinery appears in the diff.
- **Playback independence:** Hidden/unmounted visuals release their observation branch; paused playback stops reads and freezes labelled history. Transport and source-waveform integration remain separate (`web/src/player-oscilloscope.tsx:51–90`; `web/src/player-app.tsx:121–133`). The diff leaves Rust, worklet, renderer-adapter and source-waveform implementations unchanged.
- **Evidence:** Retained final check log reports 146 passing tests and empty callback-audit findings. Browser evidence records 39 passing assertions before the final preference-only repair. The finite foreground workload records 222 draws/444 reads over 10.062 seconds, continuing process counts, fixed 16 MiB memory and starvation delta zero.

### Finding: P2 — Failure explanation becomes permanently stale after reduced-motion toggling

**Location:** `web/src/player-oscilloscope.tsx:23–25,59–65`.

**Source-proven sequence:**
1. Canvas/analyser failure sets `failed = true`, hides the canvas and announces “Visual unavailable.”
2. Enabling reduced motion enters the preference branch **before** the failed guard, replacing that explanation with “Reduced motion · live visual off.”
3. Disabling reduced motion reaches `if (failed) return`, without restoring the unavailable explanation.

The mounted visual consequently continues claiming reduced motion is enabled when it is not. Further transport/status updates cannot correct that caption. Playback remains unaffected.

**Smallest fix:** Give the terminal failure explanation precedence over preference labels, or explicitly restore it in the failed branch. Add a failure → reduced-on → reduced-off UI regression checking the final unavailable caption, stopped reads and unchanged playback.

### Observation uncertainties and evidence gaps

- Analyser windows remain approximate, untagged browser histories. The readiness/warmup mechanism supports conservative freshness, not exact source-frame attribution or speaker synchronization; documentation states this accurately.
- Actual browser seek checks establish disposal and suppressed paused reads. Constant-frequency fixtures do not independently distinguish pre-seek samples from post-seek samples; freshness additionally rests on inspected gating code and focused tests.
- The broad browser/workload batch predates the final preference repair. Final reduced-motion pixel evidence separately shows 13,817 signal pixels becoming zero non-baseline pixels, with stable subsequent reads/draws.
- Hidden-state evidence is injected lifecycle testing, not real background throughput. No physical-device, audible, broad-browser or independent runtime verification was performed in this review.

### Merge verdict

**OK with notes — PASS, with one nonblocking P2 correction recommended.** No P0/P1 issue established in the observation or playback-routing target.