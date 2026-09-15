# Wave Player third mockup set

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21). Six revised images, visually inspected. Awaiting visual feedback; no approval inferred.

[Codex task](codex://threads/01a09c32-3f86-7b63-a39f-4f74c62cff21) · [Previous set](../2026-09-13-wave-player-mockups-v2/README.md) · [Design research](../2026-09-13-wave-player-design-research.md).

## Review images

| View | Light | Dark |
| --- | --- | --- |
| Compact | [Image](compact-light.png) | [Image](compact-dark.png) |
| Desktop companion library, active loop editor | [Image](desktop-library-light.png) | [Image](desktop-library-dark.png) |
| Mobile internal library | [Image](mobile-library-light.png) | [Image](mobile-library-dark.png) |

## Changes and feedback

Kalyn explicitly clarified that typography and top-info spacing feedback applies to **all six latest mocks**, not just the annotated mobile image. The circular Pause was rejected as inconsistent with the zero-radius aesthetic. Positive feedback on the waveform A/B selection treatment is preserved without implying approval of the whole design.

- Pause has a square background in all six views. Active Repeat uses a square only in the desktop loop-editing pair. Compact and mobile Repeat remain unfilled/off.
- Loaded titles now explore a smaller Inter hierarchy. The title and artist/album group is more compact, with a middle-dot separator.
- Library headings put the file count inline. Mobile rows and session footer are modestly tightened.
- TX-02 is requested for metadata, filenames, counts and times; Departure Mono for short status labels and A/B markers. Inter remains for titles and readable actions.
- Desktop A/B readouts, hatched waveform selection, boundary markers and separate playhead remain. No tabs or central A/B text button were introduced. Phosphor utility direction, centered transport and secondary volume access remain.

## Inspection limits

The square controls and revised header composition are visible in all six outputs. Font fidelity remains unresolved: desktop dark has more convincing mono metadata than desktop light; mobile library metadata and filenames still often render as proportional sans; Departure Mono remains inconsistent. This set does **not** establish exact font assets, weights, sizes, or identical typography between modes. The light loaded title also appears heavier than the requested Medium in places.

Spacing is improved incrementally, not settled: mobile Library toolbar and session footer remain fairly tall, the desktop companion retains unused space beneath the rows, and compact versus expanded player heights still differ. The requested 380 × 532 CSS-pixel card is not proven by these raster images. Timeline coordinates remain approximate rather than faithfully encoding the times. Existing interaction questions from the previous handoff remain open.

## Generation evidence

Eight built-in image-generation calls produced six current images and two superseded mode counterparts. The compact-dark and mobile-light counterparts initially gained incorrect active Repeat fills; a targeted edit removed those fills. Their originals and exact prompts are retained under `superseded-active-repeat/`.

[Manifest](manifest.json) records full prompts, reference paths, original output paths and local copies for all eight calls. Individual current prompts are in `prompts/`. [Image evidence](image-evidence.json) records dimensions, SHA-256 hashes and embedded model excerpts. Compact images are 1506 × 1045, desktop library images 1505 × 1045, mobile images 853 × 1844. Copies preserve original bytes.

Built-in `image_gen.imagegen` routing is not exposed. All eight PNGs include embedded softwareAgent `gpt-image`, version `2.0`; metadata signatures were not validated, and this does not verify a latest or dated model snapshot. Kalyn previously waived exact-model verification and authorized the available built-in tool.

Only mockup images, exact generation records and related design documentation changed. No coded prototype, application/dependency edits, audio launch, commit, push or PR. Visual-direction approval is still required before coded prototyping; prototype approval remains separate.
