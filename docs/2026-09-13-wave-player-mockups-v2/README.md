# Wave Player second mockup set

Superseded for current review by the [third set](../2026-09-13-wave-player-mockups-v3/README.md), which applies square controls and typography/header refinements across all six views. This set remains preserved as generation history.

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21). Status: six current images generated and visually inspected; awaiting Kalyn's feedback. No design approval inferred.

[Reopen this Codex app task](codex://threads/01a09c32-3f86-7b63-a39f-4f74c62cff21). Task ID: `01a09c32-3f86-7b63-a39f-4f74c62cff21`.

## Current images

| View | Image | Exact prompt | Pixels |
| --- | --- | --- | --- |
| Compact light | [Open](compact-light.png) | [Prompt](prompts/compact-light.json) | 1505 × 1045 |
| Compact dark | [Open](compact-dark.png) | [Prompt](prompts/compact-dark.json) | 1506 × 1045 |
| Desktop library light | [Open](desktop-library-light.png) | [Prompt](prompts/desktop-library-light.json) | 1505 × 1045 |
| Desktop library dark | [Open](desktop-library-dark.png) | [Prompt](prompts/desktop-library-dark.json) | 1505 × 1045 |
| Mobile library light | [Open](mobile-library-light.png) | [Prompt](prompts/mobile-library-light.json) | 853 × 1844 |
| Mobile library dark | [Open](mobile-library-dark.png) | [Prompt](prompts/mobile-library-dark.json) | 853 × 1844 |

These are unchanged copies of the generated originals. Start review with the compact pair, then compare the companion and mobile library compositions. The [research](../2026-09-13-wave-player-design-research.md) and [local primary sources](../2026-09-13-wave-player-local-design-research.md) explain the portrait-card, density and typography direction.

## Corrections applied during this set

- Kalyn rejected tabs outright. The current six images have no Visual/Library tab selector. Desktop browsing opens a companion panel; mobile browsing replaces the internal visual field and provides a back action.
- Kalyn rejected the central A/B text action and requested Phosphor icons for loop, Library, Settings and related utilities. Current images use Queue/Repeat-style icons at the lower left, independently centered playback, and a SpeakerHigh-style icon at the right. A/B lettering remains only in active boundary editing. Settings is outside the pictured player; no Settings screen or gear placement is established here.
- The permanent theme switch and exposed volume slider are absent. Theme selection belongs in app Settings. Volume access is secondary and would disclose its adjustment control.
- Inter remains for supporting text. TX-02 is intended for loaded identity and precise values, with selective Departure Mono labels and markers. The source library is Phosphor for the next design iteration; no dependency was changed.

The two initial tab images are preserved under `superseded-tabs/`. Four subsequent text-utility images are under `superseded-text-utilities/`. Their prompts are retained. One tab-based desktop prompt was prepared but never executed and is explicitly named `NOT-EXECUTED`. There were twelve actual image calls in this second exploration, including the six superseded images and the six current images. Each extra revision followed Kalyn's in-task corrections.

## Model and input evidence

The built-in `image_gen.imagegen` tool ran in this Codex app task on September 13, 2026. Exact routing/version selection is not exposed. PNG metadata records softwareAgent `gpt-image`, version `2.0`; the metadata signature was not validated and does not prove a latest-available or dated model snapshot. Kalyn waived exact-model verification before the first set and authorized the available tool.

[Manifest](manifest.json) records all current and superseded calls, full prompts, source paths and supplied-reference lists. [Image evidence](image-evidence.json) records dimensions, hashes and embedded model excerpts for all twelve originals. Reference order is preserved in the individual JSON prompt files. Inputs include the original phosphor and research component images and this set's generated anatomy controls. Stencil informed the prompts through the preceding rendered-browser research; no Stencil screenshot was supplied directly to generation. No discarded first-set player was supplied as a v2 anatomy reference.

## Intended dimensions and material limits

The desktop target remains a 1440 × 1000 viewport with a 380 × 532 CSS-pixel player and approximately 300px-wide companion. Generated compact cards measure roughly 510 × 770 image pixels; the expanded card keeps roughly the same width but grows to about 830px high. The companion is also wider than requested, nearly the player width. These are review-board approximations, not proof of exact 5:7 geometry, stable height, or CSS scale.

Mobile targets 390 × 844. The 853 × 1844 image ratio closely matches that viewport, unlike the first set. Outer board margin remains, so this is not a measured edge-to-edge app screenshot. The content is recomposed as an internal library with persistent identity, waveform and transport. No signal strip was accidentally inserted in the paired dark view.

Remaining defects and interaction choices:

- TX-02, Departure Mono, Inter and Phosphor are image approximations. Departure Mono's pixel character is weak or inconsistent, especially between modes. Exact type, icon weight and glyph fidelity need real assets after visual approval.
- The mobile Pause background becomes circular, while desktop Pause stays square. Loop's active background also becomes circular. This variation is generator output, not an approved component rule.
- Active A/B markers are correctly ordered around the playhead, but their screen coordinates do not faithfully encode 00:48, 01:24 and 01:36 against 04:32. Current elapsed position is also only approximate in ordinary views. Images cannot establish seeking accuracy.
- Icon-only Library and Loop need accessible names, focus states and discoverable tooltips. Repeat currently combines a proposed access/toggle role that must be resolved: for example, opening loop editing versus directly toggling an existing region. No behavior is proven by the image.
- Mobile keeps a Library icon even while inside Library, alongside the header back action. Its purpose or removal needs review. The full-height session footer and row density remain candidates for tightening.
- Loading a selected item, failed replacement behavior, volume disclosure geometry and Settings entry placement remain interaction decisions. Image rows distinguish playing, selected and unavailable entries with text/icons, not color alone.

State intentions remain those in the [first handoff](../2026-09-13-wave-player-mockups/README.md#state-proposals-for-later-interactive-review): no autoplay on load/replacement, draft seek distinct from acknowledged cursor, cancellation without seeking, explicit replay at end, separate loop preparing/active/failed feedback, and a static reduced-motion visual. They are proposals for the later approved interactive prototype.

No application code, dependencies, PRODUCT.md or DESIGN.md changed. No app/audio launch, commit, push, PR or production action occurred. Kalyn's explicit visual-direction approval is still required before coded prototyping, with a separate interactive-prototype gate before #22.
