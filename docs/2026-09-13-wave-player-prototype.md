# Wave Player interactive prototype

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21). Surface mode: **Operate**.

**Status: working, non-shipping study; Kalyn’s interactive-prototype approval is pending.**

Kalyn explicitly approved moving from the six current [v3 mockups](2026-09-13-wave-player-mockups-v3/README.md) into this bounded prototype. That approves the direction and real-font, geometry, density and interaction refinements here—not a final design, engine integration, #22, or a replacement for the existing lab/player design rules.

The [design brief](2026-09-13-wave-player-design-brief.md), [design research](2026-09-13-wave-player-design-research.md) and [local source research](2026-09-13-wave-player-local-design-research.md) retain the image-stage provenance and corrections. Earlier images and prompts remain historical; prototype screenshots are browser evidence, not generated replacements for the v3 image set.

## Run and inspect

```sh
# Repository-local Bun 1.4.0; no worklet/Wasm build or engine server required.
./node_modules/.bin/bun run dev:player-prototype
```

Open `http://127.0.0.1:4199/`. Set `PORT` to choose another port. The server binds only to loopback and serves the prototype plus its static signal reference, not the lab, player or proof assets.

Useful entry states:

- `/?mode=light` or `/?mode=dark`: compact, paused at 01:24.
- `/?mode=light&view=library&loop=edit`: desktop companion library with enabled 00:48–01:36 example region.
- `/?mode=dark&view=library`: internal mobile library at a narrow viewport.
- Omit `mode` to follow System. Settings changes Light/Dark/System without resetting the interaction model.

**No audio will play.** The clock advances synthetically; the waveform is deterministic SVG, not decoded amplitude. The main visual is a static reference image, not audio-reactive. The library contains five authored fictional fixtures only. No file input, byte reading, decoding, uploading, object URLs, persistence or AudioContext. Duration/metadata remain simulated; reload restores the fixtures.

The review controls below the study expose empty, loading, paused, playing, ended, error, loop-preparing and loop-failed states; a fixture reset; an A/B example; and an Inter/TX-02 title comparison. They are test controls, not proposed shipping UI. Controlled loading recovery requires an explicit **Finish simulated load** action so a busy state can be inspected without racing a timer.

## What to judge

1. **Compact identity and object scale.** Is 380 × 532 on desktop useful alongside other work? Does the 22px Inter loaded title with 12px TX-02 context feel sufficiently quiet and clear? The TX-02 title study is available without regenerating images.
2. **Playback picker.** Kalyn clarified that selecting a row must leave playback untouched, while its play icon immediately starts that track. There is no manual Load step, LOADED/SELECTED badge, import, removal or Clear action. Desktop hover/keyboard focus reveals a play/pause control in a reserved leading column; touch/narrow screens show it continuously. Selection gets a subtle background/border, current playback a speaker cue (Pause on hover); paused current track gets a small dot on desktop. Multi-selection, metadata copying and collection management are future separate scope, not implemented here.
3. **Loop affordance.** Does the repeat utility opening an editor make sense? Opening the editor and enabling looping are separate actions. Exact fields, handles and a native checkbox expose that distinction.
4. **Anchored composition.** The player remains at the viewport center whether the library is open or closed. At 1212px and above, an empty left column balances the right-hand companion library. Below that threshold, the library replaces only the visual area. Identity, timeline and transport remain. Return navigation restores the visual and focuses the library utility.
5. **Utility disclosures.** Volume is a 184 × 44px anchored strip with mute icon, slider and percentage; no visible heading or Done action. Kalyn rejected the initial oversized stacked popup from its preview. Theme belongs in broader Settings, outside the player card. Neither changes the loaded track, position, loop or play/pause.

## Implemented geometry and type proposals

These describe the prototype, **not approved production tokens**. The existing [DESIGN.md](../DESIGN.md) remains authoritative for the unchanged lab/demo.

| Element | Current study |
| --- | --- |
| Desktop object | 380 × 532px, one-pixel rule, zero-radius geometry |
| Desktop companion | 380px wide, same height, 12px gap on the right; three columns with equal flexible outer columns and a fixed center player; appears externally at ≥1212px |
| Narrow object | Internal library below 1212px; player remains 380 × 532 down to 761px. At ≤760px, width fits up to 380px and height up to 640px, bounded by viewport height with a 440px minimum; short pages may scroll vertically |
| Loaded identity | 64px header; Inter 22px/27px at 500; single-line ellipsis with full accessible title and native title disclosure |
| Metadata | TX-02 12px in the header, 11px in library rows; one line each for title and context with ellipsis, full accessible track names and native title disclosures |
| Library track title | Inter 13px at 500; filename-only titles use TX-02 12px |
| Values | TX-02 11px, tabular elapsed/duration and exact region times |
| Short state/marker labels | Departure Mono 11px; not a replacement for body text |
| Playback | Independently centered group; Volume and loop utilities on the left, Library on the right beside its desktop companion |
| Library rows | Fixed 68px; reserved 44px play target and fixed duration column; no geometry changes on selection, hover, playback or track replacement; internal vertical scroll |
| Control shape and focus | Square surfaces and slider thumb; high-contrast two-pixel focus outline; round playhead dot is a functional marker, not a button background |
| Paired modes | Existing semantic theme values; the phosphor reference stays inside its visual field |

Inter, TX-02 and Departure Mono are actually loaded. Regular-weight Phosphor SVG definitions are used instead of generated glyphs. The application composes the existing shadcn Button/Input/Slider/ToggleGroup with Base UI Popover and Dialog; shared component and palette source remain unchanged. React/React DOM and their type packages are now pinned to stable 19.3.0, as requested.

The loop editor is an **opaque, absolutely positioned overlay** over the bottom of the visual area, not part of the sizing flow. Its fields and preparation/failure feedback share one surface. The visual keeps its full bounds; the waveform remains **40px high at the same x/y position and width** throughout the animation, rather than either surface shrinking to make room. Changing tracks keeps the editor disclosure open while resetting the new track’s loop. The open desktop library neither resizes nor shifts the centered player. These refinements follow Kalyn’s feedback; final prototype acceptance remains pending.

## Interaction model

| Action/state | Observable behavior |
| --- | --- |
| Select library row | Changes selection only; loaded identity, position and playback continue |
| Row play icon | Makes that track current and starts the silent clock immediately; replacement starts at zero and resets loop to whole-track/off; selection remains independent; mobile library stays open |
| Current row playback control | Pause while playing; Play resumes the paused position/region; Play after end restarts at zero |
| Previous / next | Replaces the current track at zero, preserving playing/paused intent and independent row selection |
| Collection management | Not part of the player library; no import, removal, Clear or replacement management UI |
| Seek pointer | Pointer cursor for ordinary seeking; crosshair only while the loop editor is open; default cursor when unavailable. Preview while dragging, one commit on release; Escape, cancellation, lost capture or blur cancels |
| Seek keyboard | Arrow ±5 seconds; Page ±30 seconds; Home/End endpoints |
| End / replay | Exact end is ended; seeking back pauses; Replay explicitly returns to zero and runs the silent clock |
| Open loop editor | Shows A/B fields, independent handles, hatched region, enable checkbox and Reset; does not enable looping or start playback |
| Edit boundaries | Pointer preview/commit; arrow ±1 second, Shift-arrow ±5; exact `mm:ss` fields commit on Enter/blur and restore on Escape; invalid values are rejected |
| Create region | Shift-drag in the waveform while editing; exact fields remain the keyboard/touch alternative |
| Region constraints | One-second prototype minimum, A before B, both in the track; **not** a sample-accurate engine constraint |
| Enable loop | If outside the region, position moves to A without starting playback; ended becomes paused |
| Seek/edit outside enabled region | Disables looping, retaining the new/stored boundaries and otherwise preserving playback; no hidden seek while editing |
| Loop preparation/failure | Explicit controlled message; not represented as effective looping; completion/retry is simulated |
| Volume / mute | Left-side trigger with start-aligned strip; pointer cursor across track/thumb; initial 15%; keyboard-adjustable slider; mute retains its value; Escape returns focus to the trigger |
| Settings | Light/Dark/System and visual fallback; Escape returns focus to Settings; preferences are not saved |
| Visual failure / reduced motion | Static fallback keeps navigation and transport; missing reference image also falls back; reduced motion disables control transitions and View Transition animations |

The loop policies above require Kalyn’s review before they become #19/#20 requirements. The clock and reducer are disposable demonstration logic, not a second playback owner or a proposed replacement engine architecture.

## React 19.3 and motion

Sources: [React 19.3 release notes, September 9](https://react.dev/blog/2026/09/09/react-19-3) and [`ViewTransition` reference](https://react.dev/reference/react/ViewTransition), read during this update. The npm registry reported React/React DOM 19.3.0 and matching 19.3.0 types as stable/latest. This uses the stable named export, not experimental aliases or canary dependencies.

React owns native snapshot scheduling through `ViewTransition` and `startTransition`; the application does not call `document.startViewTransition` itself. Boundaries are deliberately limited:

| UI change | Transition boundary |
| --- | --- |
| Desktop library open/close | Companion enters/exits on the right; player remains centered and outside that snapshot |
| Internal library ↔ visual | Keyed visual-area boundary cross-fades; header, waveform and transport persist |
| Loop editor disclosure | One opaque overlay snapshot, above the unchanged visual; opacity-only enter/exit, without blur or resize morphs; fields/status stay inside the same layer |
| Settings | Controlled Base UI portal with enter/exit boundary; existing Escape and focus-return behavior retained |
| Volume | Base UI alone owns the positioned popup lifecycle; one live opaque surface fades over 140ms using starting/ending styles, with no View Transition wrapper or nested snapshot names |
| Static visual fallback | Keyed visual-area cross-fade, not an automatic resize/update transition; no live signal or audio animation |
| Playback, seek, selection, clock | Urgent updates, not scheduled as visual transitions; no animation delay imposed on transport |

There are no routes, Suspense data reveals, reordered collections or shared detail pages in this study; no extra transition machinery was added for them. Theme changes remain immediate. Disclosure fades use 120ms exit / 180ms enter timing; native groups have a 220ms duration. Exit animations retain their transparent final frame until the entire transition finishes. The loop layer fades without blur, enter delay or group motion. Root cross-fading is disabled so unaffected controls and the clock remain live; reduced motion sets native animation duration/delay to zero. Browsers without the native API apply the same state changes without animation.

## Browser evidence and checks

[Evidence directory](2026-09-13-wave-player-prototype/):

- Compact [light](2026-09-13-wave-player-prototype/compact-light.png) / [dark](2026-09-13-wave-player-prototype/compact-dark.png).
- Desktop library and edited loop [light](2026-09-13-wave-player-prototype/desktop-library-light.png) / [dark](2026-09-13-wave-player-prototype/desktop-library-dark.png).
- Mobile library [light](2026-09-13-wave-player-prototype/mobile-library-light.png) / [dark](2026-09-13-wave-player-prototype/mobile-library-dark.png).
- [Independent playing/selected rows with hover play](2026-09-13-wave-player-prototype/library-playback-light.png). Library captures were refreshed after Kalyn’s playback-picker correction.
- Loop overlay: [mobile](2026-09-13-wave-player-prototype/loop-overlay-mobile-light.png) / [desktop at a held 90ms transition frame](2026-09-13-wave-player-prototype/loop-overlay-midtransition-light.png).
- Revised volume strip: [desktop light](2026-09-13-wave-player-prototype/volume-light.png) / [mobile dark](2026-09-13-wave-player-prototype/volume-mobile-dark.png); [Settings](2026-09-13-wave-player-prototype/settings-light.png).

Captured in Chromium through `agent-browser`: desktop 1440 × 1000, mobile 390 × 844; additional narrow interaction verification at 320 × 568. Browser assertions confirmed:

- actual InterVariable, TX-02 and Departure Mono font loading, 380 × 532 desktop geometry and no horizontal overflow;
- independent row selection while paused and playing; row play immediately starts the chosen track without altering selection; current row pause/resume and keyboard-triggered playback;
- desktop controls hidden at rest and revealed on hover/focus; continuously visible narrow-screen controls; measured row/text-column/card/visual/transport geometry unchanged across selection and track changes, including with the loop editor open;
- pointer seek preview/commit/cancel, independent A-handle drag, B-handle keyboard edits, outside-region policy and window-blur cancellation;
- exact boundary validation, Escape restoration, focus retained on Enter;
- volume keyboard input/mute, accessible slider name, Escape/focus return for volume and Settings, state preservation across theme changes;
- swapped Volume-left/Library-right placement with centered playback, left-aligned volume strip and mobile fit; pointer cursor for ordinary seeking, crosshair in the loop editor, pointer restored on closing it;
- internal narrow-library scrolling, return-to-visual focus, usable fallback transport, reduced-motion transitions;
- no browser console errors or media elements;
- React-owned native transitions reached ready/finished for library, loop and Settings; nonzero native animation timing observed while playback continued. Volume’s revised live-surface fade was sampled separately on desktop/mobile;
- exact player center and waveform bounds before/after disclosure, internal-library fit at 1024px and 390px, zero-duration reduced-motion transitions, and working library/loop fallback with the native API unavailable.

The first pass caught and corrected boundary-field remount/focus loss and an unnamed volume thumb. Kalyn subsequently rejected the selection/load workflow, status badges and collection-management controls; this revision replaces them with independent selection and explicit row playback, with fixed row geometry. The narrow check also caught and fixed a grid min-content overflow exposed by long metadata; the corrected 320px viewport fits without horizontal scrolling. The later motion report exposed gaps in settled-state checks: the library exit used `fill: none`, reverting to opacity 1 at 144ms while another snapshot was still running, and the loop UI resized the visual from 330px to 292px. Exit fill now retains transparency; the loop surface is out of flow and explicitly layered above the visual. Automatic visual-area update morphing was removed.

[Native motion regression check](../tools/check-player-prototype-motion.ts) samples actual Chromium snapshot opacity and surface bounds during transitions. It failed on the original library flash, then on visual resizing after the exit-only fix, and now passes desktop and mobile exit/open/close cases. It also checks the loop snapshot’s unblurred foreground layer and control containment, plus monotonic Volume entry/exit opacity with an opaque backing, no competing native snapshot transition, and hit testing that ensures player content cannot paint over the popup controls. Run against the isolated server:

```sh
PROTOTYPE_URL=http://127.0.0.1:4199 ./node_modules/.bin/bun tools/check-player-prototype-motion.ts
```

Volume required a separate correction: animating its positioner while independently naming its popup split the surface across snapshots, and Base UI’s positioning/focus lifecycle did not reliably produce an entry snapshot. A live pointer check also caught the raised navigation painting over Volume and intercepting Mute. The positioner now has an explicit foreground stack level; Settings/backdrop levels also stay above the navigation. Volume uses Base UI’s own mount/unmount-aware opacity transition on the popup itself. React View Transitions remain on the library, loop overlay and Settings; the popup no longer mixes animation owners.

The command requires `agent-browser` with native View Transition support; it creates and closes its own browser session. Its temporary browser instrumentation is not application code. Automated reducer checks cover eight focused interaction cases, with 25 assertions:

```sh
./node_modules/.bin/bun test web/test/player-prototype-state.test.ts
./node_modules/.bin/bun run typecheck
git diff --check
```

These passed. After upgrading React, the existing `bun test web/test` suite (70 tests), `check:player-ui` (11 tests) and `check:lab-ui` (8 tests) also passed using the repository-local Bun. An initial combined invocation of both UI files hit Happy DOM cross-file document ownership errors; the repository’s configured separate commands passed unchanged. No shipping test or application source was changed to accommodate the upgrade.

A fresh read-only finishing reviewer returned `disposition: ship` (meaning prototype review only, not product approval), but missed the oversized volume disclosure Kalyn subsequently rejected. That finding supersedes the review’s volume assessment. Kalyn’s later library correction also supersedes its library-state/density assessment; the reviewer’s original verdict does not approve this revised library. The popup was replaced with the slim strip and rechecked for named slider, keyboard input, mute, Escape/focus return and narrow dark-mode fit. The revised volume design still awaits Kalyn’s judgment. This evidence does **not** establish real audio behavior, engine timing, MP3 support, decoded waveform quality, live shader performance, actual touch-device behavior, screen-reader usability or browser coverage beyond the inspected Chromium surface. Dense touch targets, small metadata and long-title disclosure still deserve human judgment; the scrollable mobile library intentionally does not force every row above the fold. Long metadata is truncated visually to keep rows stable; richer metadata viewing/copying and multi-selection are not implemented.

## Files and asset provenance

- [HTML entry](../web/player-prototype.html), [isolated server](../tools/serve-player-prototype.ts), [stylesheet](../web/player-prototype.css).
- [Composition](../web/src/player-prototype.tsx), [timeline](../web/src/player-prototype-timeline.tsx), [silent state model](../web/src/player-prototype-state.ts), [focused tests](../web/test/player-prototype-state.test.ts).
- [Phosphor SVG subset](../web/src/player-prototype-icons.tsx): regular definitions from the locally installed `@phosphor-icons/react` 2.1.10 in the sibling KKB UI package; [MIT license copy](../web/assets/player-prototype/Phosphor-LICENSE.txt).
- Inter is supplied by existing `inter-ui`; TX-02 uses the existing repository asset. Departure Mono was copied from the sibling KKB app into [prototype assets](../web/assets/player-prototype/), with its upstream [OFL license copy](../web/assets/player-prototype/DepartureMono-LICENSE.txt). Source: [rektdeckard/departure-mono](https://github.com/rektdeckard/departure-mono).
- The main image is the already curated [phosphor signal](2026-09-13-wave-player-design-assets/phosphor-signal.jpg), used as a visible static reference. No generated scene, new reference-repository edits or product-shipping license claim.

Tooling changes are the optional prototype script plus the requested React/React DOM/types upgrade and corresponding lockfile/scheduler update. The lab server, shipping player source, shared component source, engine and source-reference repositories are untouched.

## Approval and next boundary

- Image-generation gate: complete; model-routing limitation and verification waiver remain in v3 evidence.
- Mockup-direction approval: **received**, specifically for this separate prototype and its refinements.
- Interactive-prototype/final design approval: **pending**.
- #22 and audio-engine integration: **not started or authorized by this prototype approval**.

After Kalyn reviews the working composition, record the exact accepted choices and remaining corrections before marking #21 complete or starting #22. The planned PR review order remains #21 → #17 → #22 → #18 → #23 → #19 → #20; this prototype does not change that dependency/stack plan or authorize merging.
