# Wave Player first image set

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21).

Status: six images generated and inspected; Kalyn rejected the visual direction. No mockup or prototype approval. No further generation, UI implementation, commit, push, or app launch occurred.

[Reopen the Codex app task](codex://threads/01a09c32-3f86-7b63-a39f-4f74c62cff21). Task ID: `01a09c32-3f86-7b63-a39f-4f74c62cff21`.

## Kalyn's corrections take precedence

- Restore the established Trading Card Game card layout and feel from earlier Wave Player designs. This set reads as a conventional media panel and loses that identity.
- Rework playback control composition. The playback buttons crowded against the oversized volume slider were explicitly rejected. Volume should be secondary to a compact playback group with clear spacing.
- Remove the oversized, isolated Library button from the corner. Integrate browsing access into the card's navigation grammar.
- Remove System/Light/Dark from the player. Theme selection belongs in broader app settings or a Settings view.

The previous [Player Card Interface](/Users/kalynbeach/dev/apps/wave-player-next/docs/player-card-interface.md) explicitly establishes TCG structure: track identity, dominant art/visual field, persistent transport, and internal views. Its [July 19 notes](/Users/kalynbeach/dev/apps/wave-player-next/docs/NOTES.md) ask for a smaller player, "like an actual TCG card." These sources were read after the rejected first set; they were not supplied to image generation. The earlier brief's prohibition on collectible ornament was over-interpreted. Structural TCG identity does not require fantasy ornament, rarity badges, or foil. Kalyn's correction does not itself approve adding any of those.

The companion desktop library and internal mobile library remain the current collection direction unless Kalyn changes them. Old directory indexing, scene editors, and playback architecture do not carry over from historical card docs.

Recommended next direction for review: a compact portrait card grounded in those previous designs, identity above a dominant art field, a deliberate bottom transport zone, integrated browsing access, and secondary volume access. Settings absorbs theme choice. No new image set has been generated for this correction.

## Originals and exact prompts

| View | Original generated image | Exact tool prompt and supplied references | Pixel dimensions |
| --- | --- | --- | --- |
| Compact light | [Image](compact-light.png) | [Prompt](prompts/compact-light.json) | 1505 × 1045 |
| Compact dark | [Image](compact-dark.png) | [Prompt](prompts/compact-dark.json) | 1505 × 1045 |
| Desktop library light | [Image](desktop-library-light.png) | [Prompt](prompts/desktop-library-light.json) | 1505 × 1045 |
| Desktop library dark | [Image](desktop-library-dark.png) | [Prompt](prompts/desktop-library-dark.json) | 1505 × 1045 |
| Mobile library light | [Image](mobile-library-light.png) | [Prompt](prompts/mobile-library-light.json) | 977 × 1610 |
| Mobile library dark | [Image](mobile-library-dark.png) | [Prompt](prompts/mobile-library-dark.json) | 978 × 1609 |

The six PNGs are unchanged copies of the tool outputs. No crops, retouching, rescaling, or contact-sheet substitution. [Manifest](manifest.json) records original paths, stable copies, full prompts, reference order and task identity. [Image evidence](image-evidence.json) records PNG dimensions, SHA-256 and embedded model metadata excerpts. Prompts retain the actual absolute input paths; generated references can also be found under the stable filenames above.

All ten input images in the brief were opened. Actual generation inputs are enumerated per call in the prompt files. The first call supplied all four research component captures and phosphor-signal.jpg. Subsequent calls supplied generated anatomy controls and relevant original component references; some also supplied the signal reference. Sphere/artifact inspiration and historical anti-references were inspected but not passed to the generator. Six calls total, one per primary image. Paired/edit instructions are preserved verbatim, with no unrecorded refinement calls.

## Tool and model evidence

Used the built-in `image_gen.imagegen` tool in this Codex app task on September 13, 2026. The interface has no model-selection or model-discovery field. Kalyn explicitly waived the pre-generation exact/latest-model verification requirement and authorized the available built-in tool.

All six PNGs contain embedded C2PA `softwareAgent` data identifying name `gpt-image` and version `2.0`. The corresponding CBOR byte excerpt is saved in image-evidence.json. This is output metadata evidence, not a cryptographically validated provenance claim or proof of the latest account-available model. The tool did not expose an exact dated routing snapshot. No CLI, alternate provider, or hand-coded image substitute was used.

## Composition intent and deviations

Requested desktop viewport proportions were 1440 × 1000; proposed player dimensions were 440 × 592 CSS pixels, with a companion library approximately 360 pixels wide. Generated desktop boards magnify the player to about 760 × 848 image pixels. The player retains roughly the same rendered dimensions when the library opens, but its outer proportions do not match the proposed CSS dimensions. The proposals are not dimensionally faithful screenshots.

Requested mobile viewport was 390 × 844 CSS pixels with a full-width player and 16-pixel inner gutters. The output ratio is about 0.607 rather than the requested 0.462, and both add outer margins. They do not establish fit at 390 × 844. Mobile dark also inserts an unrequested signal strip absent from mobile light. This breaks paired anatomy and consumes library space. The mobile close button duplicates the Visual return path. These are first-set defects, not accepted direction.

The visual and full-track amplitude waveform remain separate. The desktop A/B markers differ from the round-topped acknowledged cursor, but their geometry is not time-accurate. The dashed Preview 01:30 is drawn beyond B 01:36, which is incorrect. The timeline must be recalculated in any later approved prototype. The generator also introduces blue selection and green Playing badges beyond the requested neutral control treatment. Normal-listening views show A/B off; desktop-library views show A 00:48, B 01:36 and Loop active.

Inter, TX-02, Lucide, Base UI/shadcn, exact theme colors, focus states, and hit areas are approximations. The images do not prove use of the actual fonts/components, keyboard access, accessible contrast, 44-pixel touch targets, responsive behavior, or audio capabilities. Transport icons are ambiguous double-arrow approximations and need actual previous/next semantics. The copied signal-style image is illustrative, not measured Low Tide data or retrieved art. All content is the synthetic fixture from the brief.

## State proposals for later interactive review

- Empty: preserve the card frame and show Add files in the internal content area; unavailable transport remains understandable. Loading: identify the pending file and show preparation status; loading/replacement never autoplays.
- Error: retain filename/known metadata with explicit failure text and Retry. An unavailable library row stays distinct from selection and the loaded/playing row.
- Seek: a dashed draft preview and draft time remain separate from acknowledged position. Release commits once; Escape, blur and pointer cancellation discard the draft. No image implements this behavior.
- Paused/ended: change Pause to Play; keep identity and a stable visual representation. Exact end remains paused; replay requires an explicit action.
- A/B: default to the whole track and off. Preparing shows the requested boundaries with pending status; Active requires acknowledgement; Failed shows failure and retry/reset without pretending the region is active. Behavior for seeking outside an armed loop and changing a pending region remains unresolved.
- Static/reduced motion: retain a still signal-derived composition; stop decorative trace motion. Browsing/view changes preserve playback. Visual failure uses a static fallback and concise status, without claiming source-derived motion.

Remaining decisions include the corrected card proportions, transport spacing, secondary volume interaction, integrated Library access, Settings entry, density and exact mobile fitting. Re-ground the next exploration in the established card design before requesting approval. Kalyn's mockup selection and explicit visual-direction approval are still required before coded prototyping; prototype approval remains a separate gate before #22.
