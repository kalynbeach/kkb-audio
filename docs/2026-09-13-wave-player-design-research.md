# Wave Player design research after the first mockup review

Date: 2026-09-13. Issue: [#21](https://github.com/kalynbeach/kkb-audio/issues/21). Status: research and proposed direction, not visual approval.

Subsequent image review: Kalyn authorized [the second mockup set](2026-09-13-wave-player-mockups-v2/README.md), rejected tabs and the central A/B text action, and directed Phosphor icons for loop, Library, Settings and related utilities. These explicit corrections override any tab-like interpretation of view navigation below. The current images are proposals awaiting feedback.

The first mockups lost the established card composition and applied generic, padded component styling. Kalyn retained only the oscilloscope and waveform studies as useful direction. The next exploration must start from the earlier Wave Player card and the actual KKB design language, with Stencil as a major inspiration.

## What the primary sources establish

The older [Wave Player component](/Users/kalynbeach/dev/apps/wave-player/components/wave-player.tsx:58) uses a 380px-wide, 5:7 card, 4px frame padding and gaps, and an 8px header inset. Its [transport](/Users/kalynbeach/dev/apps/wave-player/components/wave-player-track-controls.tsx:49) centers previous/play/next on their own row beneath full-width seeking. These are much closer starting proportions and spacing than the rejected images. They are source declarations, not a fresh runtime measurement.

The [July card document](/Users/kalynbeach/dev/apps/wave-player-next/docs/player-card-interface.md:11) makes TCG structure explicit: identity, a dominant artwork-like field, and persistent bottom transport. [Kalyn's July 19 notes](/Users/kalynbeach/dev/apps/wave-player-next/docs/NOTES.md:5) already reject the later implementation's oversized card and surplus labels. Neither fantasy decoration nor a generic media panel follows from this structure.

[KKB's current design foundation](/Users/kalynbeach/dev/kb/kkb/docs/design/kkb-design.md:153) already names Stencil and praises its typography, scale, spacing, graphics and interactive figures. It also distinguishes spacious article composition from compact internal graphics. The first run gave the component-gallery screenshots too much authority and underweighted this broader source material.

Current KKB loads actual TX-02 and Departure Mono and uses mono styles in shared controls. Research defines Inter, TX-02 and Departure Mono roles, with tight technical labels and thin rules. [The local source report](2026-09-13-wave-player-local-design-research.md) records commit snapshots, source lines, concrete control sizes and historical conflicts across five repositories.

## Stencil, inspected in the rendered browser

All four supplied pages were opened. The article text was also retrieved through the web tool. The observations below concern design, not validation of the articles' technical claims.

| Source | Visual evidence | Application to Wave Player |
| --- | --- | --- |
| [Home](https://stencil.so/) | A large cyan/violet, dithered orbital form on black; the identity and compact outlined utilities occupy a small corner. The graphic carries most of the visual character. | Let the central signal field carry identity. Keep utilities subordinate. The orbital scene and colors are inspiration, not a request for another visualization. |
| [Prewalk](https://stencil.so/blog/prewalk) | Fine rules, small square plot markers, tightly aligned mono metrics, textured chart fills and dense trace ribbons. The donut graphic has a dithered rather than smooth fill. | Use precise labels, ruled alignment and texture deliberately. Keep waveform geometry meaningful. Avoid adding unrelated charts or imitating article-scale headings inside a card. |
| [Harness Playbook](https://stencil.so/blog/harness-playbook) | Compact share controls; numbered lesson strips with a dithered lower edge; the runtime chapter also includes looser hand-drawn explanations. The graphics share a restrained frame while varying their visual treatment. | Build a coherent frame without making every region visually identical. Do not flatten the reference into black boxes or copy every illustration style. |
| [Snapcompact](https://stencil.so/blog/snapcompact) | Dense aligned comparison rows, mono value columns, hairline dividers, scoped cyan/green emphasis and very compact annotations. | Compose controls and values around common alignments. Small labels can carry hierarchy without large button boxes or excess padding. |

Rendered style inspection found Inter stacks on article headings and prose. Dates, captions and graph annotations used `BerkeleyMono Nerd Font` / `Berkeley Mono` stacks. Example body text was 16px with 27.2px line height; dates were 11px; sampled captions were 10px with 0.6px tracking. These are CSS assignments, not proof of which font file resolved for every glyph. Stencil does not establish TX-02 or Departure Mono usage; those choices come from Kalyn and the local repositories.

The sampled article share controls measured 28 × 28 CSS pixels, with zero padding and zero border radius. This explains their compact appearance but is not a mobile touch-target specification for Wave Player. Tight visible controls and usable interaction regions must be designed separately.

The inspection covered the homepage, article openings, Prewalk's donut and ribbons, the Harness runtime lesson/illustration section, and Snapcompact comparison graphics. It was a focused visual review, not an exhaustive audit of every figure or interaction. No claim is made that dark screenshots establish the intended light-mode design.

## Updated direction to test

The following is a research-backed proposal for the next image exploration, not a selected design.

1. Start with the earlier 380 × 532 portrait card as the scale/proportion reference. Keep identity compact at the top, give the visual field most of the card, and compose seeking and transport as the bottom zone. Resize responsively rather than scaling text as an image.
2. Begin with 4-8px structural spacing and 8-12px content insets, adjusting to the actual content. Shared component defaults such as 24px card padding are not product requirements. Current KKB and research already have 24-32px compact visible button variants.
3. Give previous/play/pause/next a centered, compact group with clear surrounding space. Volume is secondary, using a separate aligned utility position or disclosure. A giant visible slider beside playback is rejected; the exact replacement remains open.
4. Integrate a small Library affordance with the card's view navigation. Keep the companion desktop library and internal mobile library from the current brief; do not restore old directory-indexing or scene-editor scope. Theme selection belongs in broader app Settings or a Settings view, never a permanent three-way player toggle.
5. Keep the oscilloscope and full-track waveform as separate, useful visual elements. Retain their character from the first study while fixing false time geometry. The card itself needs the typography, density and graphic precision present in KKB and Stencil.

## Three-font composition

Kalyn explicitly reaffirmed that **Inter remains alongside TX-02 and Departure Mono**. Increased mono presence is not an all-monospace conversion.

| Face | Proposed player roles | Constraint |
| --- | --- | --- |
| Inter | Artist/album context, library track titles, longer metadata, explanatory settings/error text | Keep comfortable reading and natural wrapping; avoid making every label a large generic sans heading. |
| TX-02 | Strong candidate for the loaded track title; transport/control labels, times, A/B values, durations and filename fallback | Give it a substantial visible role. Exact title weight and size need visual review; it is not confined to tiny timestamps. |
| Departure Mono | Selected short view labels, small state identifiers, A/B or sequence markers and occasional compact captions | Use selectively at crisp, legible sizes. Do not set long track names or error paragraphs in it, and do not invent labels just to display the font. |

Actual KKB font assets and source usage are linked in the local report. Image generation can only approximate their glyphs and spacing. The next review should explicitly assess the three-font hierarchy; a later approved coded prototype must use the real files. No font migration or UI implementation occurred during this research.

## Evidence limits and next review

The July prototype screenshot referenced in its docs is missing. Local source and existing supplied captures were inspected; source declarations were not presented as fresh screenshots. The in-app browser blocked opening an existing local research HTML file under its URL policy. No alternate server or browser workaround was attempted. The earlier research screenshots remain useful visual evidence but do not prove that later source changes are rendered or that TX-02/Departure Mono resolved there.

Before a second set, review the proposed card composition and font roles against these sources. A new set should preserve one shared anatomy, use the corrected density and utility placement, and state any image-font limitations. No new generation was started in this research pass. The [first-set originals and prompts](2026-09-13-wave-player-mockups/README.md) remain unchanged as rejected evidence. Visual-direction and interactive-prototype approvals remain separate prerequisites.
