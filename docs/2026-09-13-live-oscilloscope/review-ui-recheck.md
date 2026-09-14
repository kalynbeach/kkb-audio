## Review

- **Fixed:** Prior P2 resolved by the parent. The terminal failure guard now precedes preference-caption handling (`web/src/player-oscilloscope.tsx:59–60`). Failure already stops scheduling, clears history, hides the canvas and releases the tap; moving this guard preserves that cleanup and prevents the misleading caption.
- **Correct:** Regression coverage exercises failure → reduced on → off without remounting, asserting the unavailable explanation, hidden canvas, zero reads and continued playback (`tools/check-player-ui.test.tsx:288–315`).
- **Evidence:** `/tmp/kkb23-parent-caption-red.log` reproduces the original stale caption. `...-caption-green.log` records 19 passing UI tests; `/tmp/kkb23-parent-final-check.log` records all 147 tests passing and clean callback audits.

No issues found.

**Disposition: PASS. Merge verdict: OK** for this focused P2 recheck. No new lifecycle regression identified. Source/log inspection only; no writes or execution, and no broader review reopened.