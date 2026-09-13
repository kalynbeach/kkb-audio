# Wave Player: mockup reference bundle

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21).
Status: **v3 direction approved for a separate, non-shipping interactive prototype; final design approval remains pending**.

Kalyn explicitly approved proceeding in Pi after the six current v3 images were inspected. This approval carries forward the stated v3 composition and permits real-font, geometry, density and interaction refinements in the prototype only. It does not approve engine integration or #22. See the [prototype handoff](2026-09-13-wave-player-prototype.md).

Prototype follow-up: Kalyn clarified that row selection must not issue a playback command, while the row’s play icon immediately starts that track. Reveal play on desktop hover/keyboard focus and keep it visible on touch. Reserve its column so selection/playback never rearranges rows. Remove manual Load actions, LOADED/SELECTED badges, import, deletion and Clear from the player library; catalog/playlist/track management belongs to a separate experience and is not added by this prototype. This correction supersedes conflicting image-stage interactions below, not the remaining final-approval gate.

Latest mockups: [third-set images, exact prompts and evidence](2026-09-13-wave-player-mockups-v3/README.md). Kalyn clarified that typography and top-info spacing corrections apply across all six views, and rejected circular control backgrounds. All button surfaces use zero-radius geometry. The third set explores smaller Inter loaded titles, TX-02 metadata/values and selective Departure Mono labels; exact font rendering remains inconsistent. Preserve the waveform A/B selection direction Kalyn liked. The bounded prototype is now authorized; shipping UI is not.

Earlier corrections: [second set](2026-09-13-wave-player-mockups-v2/README.md). Kalyn explicitly rejected Visual/Library tabs and the central A/B text action. Use Phosphor icons for Library, loop, Settings and related utilities. These corrections supersede older tab-navigation or Lucide starting assumptions.

September 13 review update: [six originals, exact prompts, model evidence and corrections](2026-09-13-wave-player-mockups/README.md). Kalyn reaffirmed the established TCG card layout and feel, rejected the isolated Library button and crowded playback/volume arrangement, and moved theme selection out of the player into app Settings. These corrections supersede conflicting composition instructions below. Exact/latest model verification was explicitly waived in the Codex task; built-in image generation was authorized. This historical image-stage restriction is superseded only by the bounded prototype approval above.

Follow-up research: [Stencil and corrected design direction](2026-09-13-wave-player-design-research.md), with [local source evidence](2026-09-13-wave-player-local-design-research.md). Kalyn identifies Stencil as a major inspiration, asks for tighter component composition and more TX-02/Departure Mono, and explicitly retains Inter. The original 380px-wide, 5:7 Wave Player card is the starting scale reference for the next exploration. Exact dimensions and font-role assignments remain proposals for visual review. Keep the oscilloscope and waveform studies; the surrounding first-set design is rejected.

This is the starting packet for the [Codex app task](2026-09-13-wave-player-codex-task.md), not an approved design or coded prototype. No product UI changes are included. Existing [PRODUCT.md](../PRODUCT.md) and [DESIGN.md](../DESIGN.md) describe the lab/demo; their player composition is not the target design.

## Product and approval boundary

Wave Player is first a personal music-collection player with visualizations. Creative tools grow from that foundation later. Design is a first-class product responsibility, not decoration attached to engine milestones.

The agreed composition is a **compact, track-first player object** with a library that can expand alongside it on desktop. On narrow screens the library becomes an internal view, with transport accessible. Opening the library must not inflate the player into a dashboard or interrupt playback.

Track identity, the visual/artwork surface, full-track navigation and transport belong together. The full-track amplitude waveform is a navigation surface; the live oscilloscope is a separate visual experience. Neither should erase the other. A/B looping is one adjustable region, defaulting to the whole track and initially disabled.

Required gates:

1. At least one **actual Codex app image-generation task**. Completed with the built-in image tool; Kalyn waived exact/latest-model verification. Output metadata and its limitations are preserved in the handoff.
2. Kalyn approves the generated visual direction **before any coded design/prototype**.
3. Build the separate interactive prototype with actual shadcn/Base UI composition and controlled states, without engine integration.
4. Kalyn approves that working composition and interaction handoff **before #22**.

Generated images are proposals, not evidence of working components, accurate font rendering, accessibility, decoded waveform data or audible loop quality.

## Authority: what to inherit, what not to copy

| Source | Carry forward | Do not infer |
| --- | --- | --- |
| Current direction in #21 and the September 11–13 planning conversation | Compact player; companion desktop library; internal narrow library; persistent transport; deliberate paired modes | A fixed portrait ratio, chosen pixel dimensions or approved finished composition |
| September 13 typography and icon corrections, grounded in current KKB and research sources | Retain Inter, give TX-02 and Departure Mono deliberate roles, and use Phosphor utility icons; compose existing Base UI controls compactly | Final font-role approval, accurate image-generated glyphs, or a changed component preset |
| KKB application foundation, `@kkb/ui` and `@kkb/web` | Square structural geometry, semantic states, meaningful functional shape exceptions, component/app ownership, accessible paired modes | The old `/audio` shell as product authority; a universal dashboard layout |
| Research and `@kkb/agents` artifact foundation | Precise linework, type-role separation, signal-derived imagery, intentional spacing | Giant serif titles, page-wide grids, editorial navigation or report proportions in the player |
| Earlier Wave Player iterations, read with July 19 corrections | Identity → visual surface → persistent transport; compact object; phosphor-green oscilloscope | Oversized/dark-only execution, unnecessary labels, scene editors, old playback architecture or A/B behavior that never existed |

The specific repo choices outrank differences in the wider KKB family. Typography/icon/palette alternatives may be proposed explicitly, not silently treated as approved migrations.

### High-signal primary sources

These revisions still match the local source repositories at preparation time:

- **KKB — `aef73781b846769abc8a98f190dee8d6c152b7c9`:** [application design foundation](https://github.com/kalynbeach/kkb/blob/aef73781b846769abc8a98f190dee8d6c152b7c9/docs/design/kkb-design.md), [UI package](https://github.com/kalynbeach/kkb/tree/aef73781b846769abc8a98f190dee8d6c152b7c9/packages/ui), [web app](https://github.com/kalynbeach/kkb/tree/aef73781b846769abc8a98f190dee8d6c152b7c9/apps/web), [agents artifact shell](https://github.com/kalynbeach/kkb/blob/aef73781b846769abc8a98f190dee8d6c152b7c9/packages/agents/skills/html-communication/assets/artifact-shell.html).
- **Research — `ce52029a5989fa5b5ca1ccb0020bc066cf99e218`:** [theme](https://github.com/kalynbeach/research/blob/ce52029a5989fa5b5ca1ccb0020bc066cf99e218/design/pi-one-tool-shadcn-theme.css), [component study](https://github.com/kalynbeach/research/tree/ce52029a5989fa5b5ca1ccb0020bc066cf99e218/src/artifacts/shadcn-example), [KKB visual language](https://github.com/kalynbeach/research/blob/ce52029a5989fa5b5ca1ccb0020bc066cf99e218/docs/kkb/KKB-VISUAL-LANGUAGE.md).
- **Wave Player Next — `739432459da90c53e5386ec9eee9aad1c36201ff`:** [card anatomy](https://github.com/kalynbeach/wave-player-next/blob/739432459da90c53e5386ec9eee9aad1c36201ff/docs/player-card-interface.md), [July 19 authored corrections](https://github.com/kalynbeach/wave-player-next/blob/739432459da90c53e5386ec9eee9aad1c36201ff/docs/NOTES.md). The later corrections override the implementation report's apparent approval.
- **Current implementation:** [theme](../web/styles/theme.css), [component configuration](../components.json), [vendored controls](../web/src/components/ui). Preserve playback semantics, not the demo's hierarchy.

The completed September 11 lineage investigation also covered `kalynbeach-net`, standalone players and experimental players. Its consolidated findings are reused here; this task does not restart that investigation. Local reports remain under:

```text
/Users/kalynbeach/.pi/agent/sessions/--Users-kalynbeach-dev-kb-kkb-audio--/
  subagent-artifacts/outputs/316939fe-ef89-4a76-9fa4-3d148703cb12/
    kkb-design-lineage.md
    research-design-lineage.md
    wave-player-lineage.md
```

Those reports contain historical proposals as well as evidence. The subsequently agreed companion library, Inter/TX-02 starting constraints and #21 approval gates take precedence.

## Curated image inputs

All images are in [2026-09-13-wave-player-design-assets/](2026-09-13-wave-player-design-assets/). Read the captions before supplying images to the task. These are **references**, not newly generated Wave Player mockups.

### Primary component references

- [Research foundations — light](2026-09-13-wave-player-design-assets/research-foundations-light.png) / [dark](2026-09-13-wave-player-design-assets/research-foundations-dark.png): actual rendered buttons, toggles, alerts and structured rows. Transfer control grammar and restrained boundaries, not the gallery navigation, nested specimen layout or small uppercase specimen labels.
- [Research selection — light](2026-09-13-wave-player-design-assets/research-selection-light.png) / [dark](2026-09-13-wave-player-design-assets/research-selection-dark.png): actual rendered selection controls, range slider and toggle group. The two-thumb range is **not an implemented A/B loop control**. Calendar and questionnaire content are incidental, not proposed player features.

These four images come from the existing research component build, not a fresh `@kkb/ui` catalog build. InterVariable was reported loaded. TX-02 is not embedded in this artifact; the resolved local mono face was not verified. Use the repo's self-hosted TX-02 when coding later rather than copying glyphs from these screenshots. Some faint metadata and disabled controls in the studies are not readability targets.

### Signal and geometric identity

- [Phosphor signal](2026-09-13-wave-player-design-assets/phosphor-signal.jpg): the actual green repeated-trace reference named by the visual-language document. Use its fine signal/persistence character **inside the visualization**; not a neon frame around every control, a full-page backdrop, or evidence of this track's waveform. Source: `/Users/kalynbeach/Pictures/KKB/x93-y1149.png`; despite the original extension, its bytes are JPEG. The bundle copy has the matching extension, without transcoding.
- [KKB sphere](2026-09-13-wave-player-design-assets/kkb-sphere.png): the actual white wireframe reference from `/Users/kalynbeach/Pictures/KKB/kkb-sphere.png`. Precision and geometric relationships are the useful lesson. It is not mandatory album art or authorization for another visualization scene.

These local image references are for this design exploration, not a claim of third-party licensing or approval to ship them as product assets.

### Secondary inspiration and anti-references

- [Artifact foundation — light](2026-09-13-wave-player-design-assets/artifact-inspiration-light.png) / [dark](2026-09-13-wave-player-design-assets/artifact-inspiration-dark.png): expressive linework and intentionally paired atmospheres from the research explainer. **Do not copy its giant Instrument Serif title, global grid, navigation rail, microcopy or generous report-scale whitespace.** KKB's shipped artifact foundation does not establish a replacement product-UI specification.
- [Historical KKB audio — light-class capture](2026-09-13-wave-player-design-assets/kkb-audio-cached-sept4-light.png) / [dark-class capture](2026-09-13-wave-player-design-assets/kkb-audio-cached-sept4-dark.png): retained September 11 screenshots of a saved September 4 `/audio` HTML/CSS build. They illustrate an earlier compact audio composition, **not today's component catalog or approved visual design**. Their bevels, gradients, blue frame, large clock, codec-heavy identity and weak light-mode treatment are not the target. “Light” in the filename describes the capture's document-class state, not verified light-mode quality.

The current `kkb-audio/player.html` is an explicit anti-reference: no large explanatory introduction, file-input-first hierarchy, engine labels or generic demo shell. The historical July 15 player screenshot remains unavailable; its absence is not permission to invent a substitute “approved” reference.

## Visual and interaction brief

**Usage scene:** Kalyn keeps a small player alongside other work, opens the collection when choosing music, and returns attention to the track and visual. Design for ordinary bright and dim environments equally; mode choice must not move controls.

- Title is the strongest text. Artist/album provide quieter context. Filename is an honest fallback. Do not lead with product branding, codec data or status telemetry.
- One coherent bounded object, precise structural corners and a useful visual field. No nested card wall, ornamental hardware chassis, faux CRT housing, glossy buttons or mandatory collectible-card ratio.
- Base neutrals come from the current theme: light ground `#f4f4f0`, surface `#fffffc`, ink `#171714`, border `#d6d6ce`; dark ground `#080807`, surface `#0c0c0b`, ink `#f2f2ed`, border `#292925`. These are starting references, not a substitute for judging the composition. Propose a readable paired phosphor signal treatment; do not make every state green or silently change the global theme.
- Use Inter, TX-02 and Departure Mono together. The third set tests smaller Inter loaded titles and library track names, TX-02 metadata and precise values, and Departure Mono short state labels and markers. These roles are proposed, not approved, and image rendering remains inconsistent. Do not import the artifact's editorial serif voice by default. Reduce redundant copy before shrinking text.
- The player stays compact and centered when the desktop library opens to its right: equal outer columns balance the center player rather than centering the combined pair. Use the internal library when there is not enough room for that layout, retaining identity/transport and an explicit return path. Keep the page within the viewport; scroll the collection locally.
- The waveform is a full-track amplitude overview with separate playhead, seek preview and A/B boundary/region treatments. Its height and position stay fixed when opening the loop editor. Layer the loop controls on an opaque overlay above the visual; do not resize, squish or warp either underlying surface to make space. A live oscilloscope has no time-axis seeking semantics. The visual surface must retain a meaningful static/unavailable/reduced-motion representation.
- Use familiar, labelled transport, clear focus and practical touch targets. Place Volume on the left and Library on the right, near its desktop companion, with playback independently centered. Use a pointer cursor for ordinary waveform seeking; reserve the crosshair for the loop editor. A small visible icon may have a larger hit area; a screenshot cannot prove that area exists.
- The player library is a playback picker, not collection management. No file import, deletion, Clear, playlist editing, uploads, persistent indexing, watched folders, auto-advance, shuffle, search infrastructure or artwork discovery in this prototype. Future management is a separate scope/UI.
- Clicking a row selects it without changing the current track, position or playback. Its play icon explicitly starts that track immediately; on the currently playing row it becomes Pause. Desktop hover/focus reveals controls in reserved space; touch keeps them visible. Selection uses a subtle background/border, current playback a restrained icon cue—not LOADED/SELECTED badges or a manual Load step. Browsing/view changes never issue playback commands.
- Seeking previews during drag, commits once on release and cancels on Escape/blur/pointer cancellation. Preserve the distinction between preview and acknowledged consumed position. Exact EOS stays paused; replay is explicit.
- Use stable React 19.3 and React View Transitions for UI disclosures, including library open/close, with reduced-motion and unsupported-browser fallbacks. Keep playback/seek updates immediate and the waveform out of scaling snapshots. The volume slider uses a pointer cursor across its track and thumb. Its popup fades as one opaque live surface under Base UI’s lifecycle; do not nest independently named popup snapshots inside another animated wrapper.
- A/B enable, boundary entry/adjustment, reset and Preparing/Active/Failed feedback must be legible without overwhelming normal listening. Product choices about seeking outside an armed loop and editing pending regions remain decisions for the prototype/engine gate, not assumptions to hide in an image.

### Controlled content for the mockups

Use this **synthetic design fixture**, not claims about Kalyn's collection or real artist releases. It avoids uploading personal audio and keeps comparisons consistent. Mark boards outside the UI as “design fixture; simulated waveform and playback.”

| Title / filename | Artist | Album | Duration | Format / state |
| --- | --- | --- | --- | --- |
| Low Tide | North Window | Tidal Studies | 04:32 | WAV; loaded, playing at 01:24 |
| Glass Current | Static Bloom | Afterimage | 06:18 | MP3; available |
| A Map of the Room After Everyone Has Left | North Window | Tidal Studies — Late Sessions | 08:47 | WAV; long metadata |
| field-recording_2026-08-19_take-07.wav | unknown | unknown | unknown until prepared | WAV; filename fallback |
| Night Transit | Static Bloom | Afterimage | unknown | MP3; could not load |

Use a neutral artwork fallback or explicitly illustrative signal art; do not invent retrieved covers. In the A/B state example use A = 00:48, B = 01:36 on Low Tide. These are mockup values, not approved loop minimums, smoothing geometry or decoded frame coordinates.

## Task outputs and unresolved decisions

Generate one coherent proposed direction in six primary views: compact light/dark, desktop companion-library light/dark, and narrow internal-library light/dark. Show the same compact player scale between the desktop states. Include an A/B edit example and selected/playing/unavailable library distinctions; use a short accompanying note for other state intentions rather than turning each screenshot into a documentation poster.

The task must preserve its reopenable reference, actual image-model identity/date/evidence, full generation prompts, supplied reference list and image outputs. If the app does not expose enough evidence to verify the required model, report that limitation; do not fill the record from an assumption.

Still to be approved: exact density/dimensions, visual/waveform proportions, mode-safe signal treatment, final library density and affordance treatment, A/B interaction details and the bounded first visualization. None requires reopening the agreed product scope.

## Preparation evidence and current gate

- Created native stack `main ← design/21-wave-player` from `cff190c2d91cfac0debcb7dbf38b36cfe6e2a6e4`. #21 is assigned to Kalyn. No PR yet; the issue's design deliverables are not complete.
- Reference repositories above were clean when inspected. No edits, rebuilds or app launches there.
- New research captures: isolated `agent-browser` session, Chrome 152.0.7977.83, 1440 × 1000, light/dark system emulation and reduced motion. Served only the two existing HTML artifacts over an ephemeral loopback server with outbound connections/media/workers blocked by CSP. No audio or daily-driver server used. Browser and server closed afterward.
- Element-crop capture returned blank images; those were discarded. The retained viewport captures were individually opened and inspected. No UI was rewritten to obtain them.
- Source artifact SHA-256: component guide `726748071c50f36dbe4ba3cc0627ad7b17bc4e4dd1d9c5abd67c2b750eb96ec5`; explainer `5ab2dac03791780388410283f6cfde42d88ffb31ef4e9ab2c1d11667a08713fe`. Existing builds were not regenerated; hashes identify the inspected outputs, not proof of source/build equivalence.
- Historical KKB screenshots were copied unchanged from the prior session's `/tmp/kkb-wave-design.MI3E90/` artifacts and visually inspected again. They were originally captured with application scripts/API/audio disabled; the dark class was applied for comparison. No new KKB runtime inspection is claimed.
- Bun 1.4.0 is available through `./node_modules/.bin/bun`. Global Bun is 1.4.2 and is not the execution version for repo checks.
- Codex app processes are present inside ChatGPT. This Pi session has no exposed Codex app task/image connector; a bounded check of those app processes found no TCP listening automation endpoint. The running app was not restarted, reconfigured or attached to. This does **not** establish that image generation is unavailable to Kalyn in the app.

| Gate | State |
| --- | --- |
| Curated references and task prompt | Prepared |
| Codex app task URL/ID | `01a09c32-3f86-7b63-a39f-4f74c62cff21`; [reopen](codex://threads/01a09c32-3f86-7b63-a39f-4f74c62cff21) |
| Latest available GPT image model / verification evidence | Pre-generation verification waived by Kalyn; built-in tool used; PNG softwareAgent metadata reports gpt-image 2.0; exact routing/latest availability not exposed |
| Generated images / exact generation prompts | [Third set](2026-09-13-wave-player-mockups-v3/README.md): six current images plus two superseded state corrections with prompts; earlier sets retained |
| Kalyn's mockup selection and approval | Six current root-level v3 images approved as the direction for a separate prototype; real-font, spacing, stable geometry and interaction refinements explicitly in scope. Not final design acceptance. |
| Interactive prototype and final design approval | Pending; #22 remains gated |

## Stack continuation

Review/merge order remains **#21 → #17 → #22 → #18 → #23 → #19 → #20**, one issue per PR, each targeting the branch below it. This is not a change to native issue dependencies: #17 is independent of design, #18 needs #17/#22, and #23 only needs #22. MP3 preparation can proceed while visual review is pending; it must not bypass the frontend approval gates. Keep lower-layer fixes in their owning PR and leave merging to Kalyn.
