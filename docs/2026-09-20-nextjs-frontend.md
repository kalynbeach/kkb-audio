# Next.js frontend

Date: 2026-09-20

Next.js 16.3.5 App Router owns the web application. Bun 1.4.0 remains the package manager and
runtime tooling; Cargo and wasm-bindgen 0.2.127 remain the Rust/Wasm toolchain.

## Routes

| Previous entry | Current route | Disposition |
| --- | --- | --- |
| No overview | `/` | New overview and task navigation |
| `web/wave-player.html` | `/player` | WebGPU Wave Player and synthetic audio study, browser-only entry |
| `web/player.html` | `/developer/classic-player` | Original Canvas2D player proof, same transport |
| `web/lab.html` | `/lab` | Actual-Wasm engine lab, browser-only entry |
| `web/proof.html`, `/index.html` | `/developer/pcm` | PCM preparation, failure, WAV and starvation controls |
| `web/plan-proof.html`, `/plan.html` | `/developer/plan` | Compiled-plan preparation and muted observation |
| `web/player-prototype.html` | `/developer/player-study` | Retained simulated design study, explicitly labelled |

The HTML entries, React root bootstraps, and custom Bun page servers are removed. No active URL
contract requires redirects. Historical evidence retains the URLs used at the time; current run
instructions and active tools use the new routes.

## Runtime boundary

`bun run build:worklet` produces only `public/audio-runtime`. It retains the pinned binding patch
that removes worklet-unsafe TextDecoder initialization and error formatting. Worklets and workers
are separate Bun bundles. The Wasm module and required notices sit beside them. Next's compiler
never receives an AudioWorklet entry. Browser code uses absolute `/audio-runtime/` URLs; the lab
worker resolves Wasm relative to its own bundle within that directory.

`bun run dev` builds this runtime then starts Next. `bun run build` builds the runtime then Next's
production pages; `bun run start` serves that build. Ports are explicit through `--port`.
Runtime edits require rebuilding the audio assets. The measurement runner still builds an isolated
temporary copy and serves the same runtime URL prefix; it does not add controls to product pages.

The transport retains fixed, unshared Wasm memory and transferable buffers. COOP/COEP headers are
not required and are not added. This migration introduces no server audio processing or storage.

## Lifecycle and presentation

The player and lab use `next/dynamic` with `ssr: false` inside client boundaries. Browser APIs and
external-store subscriptions do not run during server prerendering. Overview and page framing
remain statically rendered. See [Next's lazy-loading guidance](https://nextjs.org/docs/app/guides/lazy-loading).

Playback ownership remains local to its route. Navigation and unmount release the owner,
contexts, workers, and visualization resources. Fast Refresh retains at most one playback owner.
Developer proof controllers now mount and clean up explicitly; controls stay disabled until their handlers are
ready. Pending preparation cannot become an active abandoned route. No persistent player is added.

One shared session-only Light/Dark/System choice controls the shell, player, study, and lab.
Reload returns to System. The compact player keeps its approved character, library behavior,
keyboard transport, and reduced-motion rules. Dense diagnostics remain in lab and proof routes.
Each route has a title; loading, retry, and missing-page states have explicit recovery paths.

## Verification

The migration includes Wave Player [PR #35](https://github.com/kalynbeach/kkb-audio/pull/35)
at `436cd5dcffa6d7dc164cfe7fd17a2cc9af8efd8b`, based on `main` at
`f38691dbe689fc1ac16379c1b1b1c92203ec8977`. PR #34 is excluded.

- `PATH="$PWD/node_modules/.bin:$PATH" bun run check` passed all 184 tests, type generation,
  TypeScript, fixed-memory checks, actual-Wasm media/loop gates, and both worklet audits.
- `cargo test --lib` passed 84 tests, with 2 ignored.
- `PATH="$PWD/node_modules/.bin:$PATH" bun run build` passed on the final implementation.
  Next statically generated all routes without evaluating the browser-only player or lab.
- After the final proof-listener cleanup and active-tool URL updates, `bun run typecheck` and
  `bun test web/test/main.test.ts tools/check-wave-player-scope.test.ts` passed, with 25 tests.
- Final production HTTP checks verified all eight app routes, their titles, missing-page 404s,
  six worker/worklet assets, and `application/wasm` for the module. See
  [HTTP results](2026-09-20-nextjs-frontend/http-verification.jsonl).

The Codex built-in browser exercised development and production builds on KB-M1-Max. Synthetic
PCM16, PCM24, and MP3 fixtures passed explicit muted play, pause, replacement, seeking and A/B loop
checks. Closing a track left the library available. An unsupported float32 WAV showed the existing
format error and a supported replacement recovered. The synthetic study used the actual playback
engine. The retained design study remained visibly labelled as simulated.

PCM and compiled-plan proof routes produced real analyser observations with a 48 kHz context,
128-frame quantum, 16 MiB fixed memory and zero render failure codes. Preparation-failure and
invalid-plan rejection controls remained usable. The lab rendered actual Wasm output. Navigation,
back/forward, reload, theme changes and mobile layouts were checked, including 320px width without
horizontal page overflow. Browser warnings and errors were absent in the checked flows.

A temporary verification-only bootstrap observed AudioContexts, workers and GPU devices. Leaving
the player or proof closed its contexts and terminated workers; leaving the player destroyed the
GPU device. Lab unmount terminated its worker. Confirmed Fast Refresh retained one playback owner,
and subsequent navigation released it. Controlled missing-WebGPU and JavaScript reduced-motion
conditions kept audio usable while disabling the visual. These are controlled checks, not device
coverage or an operating-system reduced-motion assessment. Selected observations are in
[browser results](2026-09-20-nextjs-frontend/browser-verification.json).

The bootstrap was removed before the final build. A final uninstrumented production check confirmed
explicit muted synthetic playback, pause, a live WebGPU visual and a clean browser console.
Both task-owned servers exited, and ports 4316 and 4317 no longer listened after verification.

The independent visual finish review returned `ship` after the mobile-height rule in `DESIGN.md`
was aligned with the shared header/footer. Captures contain only generated audio:

- [Overview, desktop](2026-09-20-nextjs-frontend/overview-desktop-light.png)
- [Overview, mobile](2026-09-20-nextjs-frontend/overview-mobile-light.png)
- [Overview, mobile destinations](2026-09-20-nextjs-frontend/overview-mobile-lower.png)
- [Wave Player, desktop dark](2026-09-20-nextjs-frontend/player-desktop-dark.png)
- [Wave Player, mobile light](2026-09-20-nextjs-frontend/player-mobile-light.png)

Muted runtime output is not an audible listening assessment, a speaker-latency measurement or broad
browser/device acceptance. These migration checks predate the float32 WAV support added by
[PR #37](https://github.com/kalynbeach/kkb-audio/pull/37), now above WaveCatalog in Stack #39.
This migration does not change the P31 preset's pending visual acceptance. No merge, deployment
or daily-preview update is included.
