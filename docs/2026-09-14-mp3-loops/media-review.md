## Review

**Result: PASS — engine/media implementation review.**
**No issues found.** Parent acceptance remains separate.

### Correct

- **Approved mechanism, not guard removal:** `src/local_mp3.rs:205–245` implements candidate B through the pinned decoder’s public packet API: reset, optional carrier, unchanged predecessor, then source decoding. The previously reviewed 511-byte reservoir / one-granule overlap / 16-step synthesis argument remains applicable. Candidate A, guessed preroll, decoder cloning and dependency changes were not introduced.

- **Strict source history remains authoritative:** predecessor CRC and genuine unread-reservoir accounting are checked before restoration (`src/local_mp3.rs:211–216`). Target decoding resumes with `a.unread`, not carrier capacity (`:240`), and original packets still pass CRC/reservoir validation (`:319–348`). Regressions reject fabricated predecessor availability, missing target history and corrupted predecessor/target CRC (`:749–783`).

- **Bounded, source-local ownership:** fixed predecessor/history arrays total 1556 bytes per anchor; one completed anchor and one boxed acquisition are owned by the reader (`src/local_mp3.rs:22–36,65–66`). Rolling history is 511 bytes; carrier scratch is 1044 bytes; packet copies are confined to off-callback decoding. The documented **5712-byte additional encoded-payload ceiling** is consistent with this representation—not a total-process-memory claim.

- **Continuation acquired before readiness:** `PreparedMediaLoop` computes the actual converter continuation source anchor before restoring initial preparation position (`src/media_loop.rs:92–114`). Browser acquisition finishes before head preparation/publication (`web/src/pcm-worker.ts:93–120`); native acquisition precedes slot filling (`src/cpal_host.rs:572–619`). Normal head exits restore the retained anchor instead of scanning from zero.

- **Cancellation and stale work:** browser requests cancel acquisition and check supersession across asynchronous reads (`web/src/pcm-worker.ts:101–109,166–174`). Native acquisition checks stop/superseding requests before and after reads; publication remains epoch-guarded (`src/cpal_host.rs:585–607,650–655,734–741`). Completed anchors cannot transfer between reader owners.

### Previous P2 — closed

The focused correction now targets packets **0 through 6** in original/stripped CRC and VBRI inputs. `evidence/p2.rs:35–40` selects the current packet, independently compares uninterrupted decoder PCM and asserts zero errors/mismatches.

`docs/2026-09-14-mp3-loops/p2-history.jsonl` records the required zero/one/two warm-up paths, including one carrier for targets ≥2. Production restored-reader tests additionally exercise nonzero targets. The original **22/41 packet-zero-only** limitation remains explicitly preserved in the dated document rather than rewritten.

### Independent output and runtime evidence

- Native tests use uninterrupted decoded/trimmed PCM, ordinary conversion, independently calculated ceil coordinates and an explicitly calculated held-head transformation through real worker/rings/callback output (`src/cpal_host.rs:2199–2416`).
- The native 600-second test retains only its independently located reference interval, crosses at least four late wraps at one epoch, requires zero underruns and fewer than 100 ordinary source-packet decodes after readiness (`:2419–2521`). Warm-up work is separately bounded.
- `tools/check-mp3-loop.test.ts:7–25,55–80` compares actual built worker/MessageChannel/compiled-Wasm output against uninterrupted reference conversion and independently calculated grid/seam samples. It covers whole/short/late intervals, both conversions/layouts, original/missing metadata, CRC/VBRI, recovery, acquisition supersession/read failure and paused-EOS acknowledgment.
- The final Chrome record, `evidence/browser-bound-identity.json`, shows late iteration **0→16**, stable epoch 2, zero starvation/underruns/invalid blocks, 36 discarded warm-up decodes and fixed 16 MiB memory. Separate retained records cover converted whole-track looping, recovery and replacement.

The shared seam/downstream callback implementation changed only module names. Original WAV control/reference intervals and both cancelled-intent regressions remain retained. Ordinary MP3 seeks still report reader-derived `AnchorAndDiscard`; trim/grid rules are unchanged.

### Checks, identity and limitations

Inspected the actual immutable-baseline text diff, seven-entry binary manifest, identity-generation script and final identity results: **390 matching source/copy paths**, no recorded baseline/runtime mismatches. Final served Wasm:

`106d4161c39c03204a23d589f8ab5dd062a045993b9815621378b82cb3862c99`

Retained logs report **84 Rust passes per debug/release configuration**, two physical tests ignored, **160 Bun passes**, native/Wasm Clippy, formatting, fixed-memory and callback allocation/deallocation audits passing.

I did not execute tests, recompute hashes or independently derive a Git diff. Numerical built-worker comparisons run under Bun; Chrome records establish actual scheduling/cursor behavior, not a separate sample-by-sample Chrome oracle. Mixed-block empirical coverage, human listening and broad host/load/process-memory certification remain explicitly unclaimed. The missed initial browser field commit remains honestly unresolved, not presented as a repaired engine defect.

**Merge verdict: OK with notes.** No engine/media repair requested; parent owns final Git verification and acceptance.