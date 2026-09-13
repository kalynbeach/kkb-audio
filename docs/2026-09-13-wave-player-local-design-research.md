# Wave Player local design sources

Date: 2026-09-13. Local source inspection only. No source repository was modified or launched; historical implementations are not assumed approved.

September 13 feedback overrides older documents: TCG composition, tighter padding, more TX-02 and Departure Mono alongside retained Inter, theme choice in settings, smaller integrated Library, playback distinct from volume. Retain the oscilloscope and waveform studies.

## Repository snapshots

These are local checked-out commits, not independently verified remote heads.

| Repository | Local HEAD and commit date | Working tree at inspection |
| --- | --- | --- |
| `/Users/kalynbeach/dev/apps/wave-player` | `63e6c8aac0dfb772fe390acf753f13ee77a5e7b0`, 2025-09-18 | Modified `bun.lock`; inspected player source is tracked and unmodified. |
| `/Users/kalynbeach/dev/apps/wave-player-next` | `739432459da90c53e5386ec9eee9aad1c36201ff`, 2026-07-30 | Clean. |
| `/Users/kalynbeach/dev/apps/wave-player-2024` | `e8d46d7f9180842c19e56f63ccd5d58454ec7d8f`, 2024-01-19 | Dirty, including staged and unstaged player/package changes. Current source is a mixed working snapshot. |
| `/Users/kalynbeach/dev/kb/kkb` | `aef73781b846769abc8a98f190dee8d6c152b7c9`, 2026-09-07 | Clean. |
| `/Users/kalynbeach/dev/research` | `ce52029a5989fa5b5ca1ccb0020bc066cf99e218`, 2026-09-04 | Clean. |

The 2024 tree includes staged and unstaged package changes, modified `page.tsx` and `wave-player.tsx`, staged-new `wave-player-audio.tsx`, and untracked `packages/`.

## Findings

### 1. The TCG reference already specifies composition explicitly

The July 15 interface document defines the inspiration as structural. Its order is persistent track identity, an artwork-like dominant central viewport, and persistent bottom transport. Library and visualization controls replace the internal viewport. The surrounding page is restrained. It explicitly describes the prototype's `5 / 7` portrait proportion.

Evidence: [player-card-interface.md:11](/Users/kalynbeach/dev/apps/wave-player-next/docs/player-card-interface.md:11), lines 11-21 and 25-44. This is documented intent, with the document marking Task 1 implemented. The corresponding component does mount the transport outside the tab contents: [player-card.tsx:129](/Users/kalynbeach/dev/apps/wave-player-next/src/client/app/player-card.tsx:129), lines 129-188.

Design consequence: one portrait object with track identity, central image field, and bottom actions. The card-game reference supplies hierarchy and proportion.

### 2. The older prototype is materially tighter than the later implementation

The 2025 player source uses `aspect-[5/7] w-[380px] gap-1 ... p-1`. Its header uses `p-2 gap-1`, with title, record, and artist. The visual region fills the remaining space. The transport uses `p-2 gap-2`, with time labels, a full-width timeline, and centered previous/play/next buttons beneath it.

Evidence: [wave-player.tsx:58](/Users/kalynbeach/dev/apps/wave-player/components/wave-player.tsx:58), [wave-player-track-info.tsx:17](/Users/kalynbeach/dev/apps/wave-player/components/wave-player-track-info.tsx:17), [wave-player-track-controls.tsx:47](/Users/kalynbeach/dev/apps/wave-player/components/wave-player-track-controls.tsx:47), lines 47-88. These are implemented class declarations. The visual is a placeholder, not a functioning oscilloscope: [wave-player-track-visual.tsx:7](/Users/kalynbeach/dev/apps/wave-player/components/wave-player-track-visual.tsx:7).

By comparison, the July implementation sets a card height up to `56rem` and derives width partly from viewport height. Header padding reaches 20px. Source: [styles.css:53](/Users/kalynbeach/dev/apps/wave-player-next/src/client/styles.css:53), lines 53-56, and [player-card.tsx:65](/Users/kalynbeach/dev/apps/wave-player-next/src/client/app/player-card.tsx:65).

Design consequence: start near the actual 380px prototype scale and its small internal spacing. Verify the next dimensions visually.

### 3. Kalyn had already rejected excess size and explanatory chrome in July

The July 19 notes say the desktop card is too large and should be smaller and more compact, like an actual TCG card. They call out unnecessary labels that take up space, specifically "Wave Player · local visual instrument" and "WEBGPU · LIVE SIGNAL". The notes also say Scene controls do not feel good.

Evidence: [NOTES.md:5](/Users/kalynbeach/dev/apps/wave-player-next/docs/NOTES.md:5), lines 5-11. Git history identifies the notes commit as `163587c`, 2026-07-19. The criticized header text remains in the inspected implementation: [player-card.tsx:68](/Users/kalynbeach/dev/apps/wave-player-next/src/client/app/player-card.tsx:68).

Design consequence: the July implementation remains unfinished. Remove repeated product labels and technical subtitles.

### 4. TX-02 and Departure Mono are implemented KKB typography, not speculative additions

The KKB web app loads actual local TX-02 and Departure Mono WOFF2 files. Shared styles map TX-02 to `font-mono` and Departure Mono to `font-mono-secondary`. The current catalog uses TX-02 for its instrument heading and explicitly provides a selective Departure Mono specimen. Shared buttons use `font-mono`.

Evidence: [layout.tsx:12](/Users/kalynbeach/dev/kb/kkb/apps/web/app/layout.tsx:12), lines 12-19; [globals.css:12](/Users/kalynbeach/dev/kb/kkb/packages/ui/src/styles/globals.css:12), lines 12-13; [design-system-surface.tsx:77](/Users/kalynbeach/dev/kb/kkb/apps/web/components/ui-catalog/design-system-surface.tsx:77), lines 77-88; [button-variants.ts:4](/Users/kalynbeach/dev/kb/kkb/packages/ui/src/components/button-variants.ts:4).

The recent research explainer independently defines TX-02 for technical text and Departure Mono for pixel labels. It uses 12px TX-02 navigation, Departure Mono section identifiers and toolbar metadata, and fine rules. Evidence: [kkb-explainer.css:13](/Users/kalynbeach/dev/research/src/artifacts/kkb-explainer/kkb-explainer.css:13), lines 13-18, 186-241. Commit `a18ea111fedbafc4676be3baccaa894d19c83f95`, dated 2026-08-27, refined contrast and heading tracking in this source.

Proposed allocation: TX-02 for loaded track identity, precise values, filename metadata and controls; Departure Mono for selected short mode labels and markers; Inter for readable supporting text, library titles and longer metadata. Kalyn explicitly confirmed that Inter remains alongside the two mono faces. See the [three-font proposal](2026-09-13-wave-player-design-research.md#three-font-composition). Current feedback supersedes the older all-Geist Mono direction.

### 5. Tight controls can retain usable targets

KKB's current design contract requires square structural geometry and explicitly allows compact visible controls with larger invisible hit regions. Its icon guidance uses 16px ordinary utility icons and 12px subordinate icons. Shared button variants already include 24px and 32px compact options. The research repository has 24px, 28px, and 32px button sizes.

Evidence: [kkb-design.md:24](/Users/kalynbeach/dev/kb/kkb/docs/design/kkb-design.md:24), lines 24-46; [kkb-design.md:94](/Users/kalynbeach/dev/kb/kkb/docs/design/kkb-design.md:94), lines 94-95; [kkb-design.md:146](/Users/kalynbeach/dev/kb/kkb/docs/design/kkb-design.md:146), lines 146-149; [button-variants.ts:17](/Users/kalynbeach/dev/kb/kkb/packages/ui/src/components/button-variants.ts:17), lines 17-25; [research button.tsx:22](/Users/kalynbeach/dev/research/src/components/ui/button.tsx:22), lines 22-33. The zero-radius token is implemented at [globals.css:106](/Users/kalynbeach/dev/kb/kkb/packages/ui/src/styles/globals.css:106).

Design consequence: reduce visible padding while preserving focus and larger touch areas. Override the generic `gap-6`, `py-6`, and `px-6` defaults in [card.tsx:9](/Users/kalynbeach/dev/kb/kkb/packages/ui/src/components/card.tsx:9), lines 9-22, for this composition.

### 6. There is an existing centered transport reference, but volume needs a fresh composition

The older prototype gives previous/play/next their own centered row below the seek strip, without a visible volume slider. The later implementation uses three grid columns: volume on the left, transport in the center, playback status on the right. Its volume track is capped at 96px, so that implementation should not be described as an enormous slider. Nevertheless, it shares the transport row, which the current feedback rejects in the new mocks.

Evidence: [wave-player-track-controls.tsx:49](/Users/kalynbeach/dev/apps/wave-player/components/wave-player-track-controls.tsx:49), lines 49-88; [transport.tsx:90](/Users/kalynbeach/dev/apps/wave-player-next/src/client/app/transport.tsx:90), lines 90-145.

Design consequence: preserve centered playback and full-width seeking. Secondary volume needs separate alignment or disclosure. The history does not establish a specific replacement control.

### 7. Library and theme controls have different scope

The July design's Library is an alternate internal card view; the implementation groups it with Visual and Scene. The 2025 prototype puts the theme button in the page footer outside the player. The July design table later allowed utilities in the card or a compact adjacent control, and July 19 notes requested light/dark support. None of that overrides the current explicit instruction to put theme choice in broader app settings or a Settings view.

Evidence: [player-card-interface.md:122](/Users/kalynbeach/dev/apps/wave-player-next/docs/player-card-interface.md:122), lines 122-133; [player-card.tsx:116](/Users/kalynbeach/dev/apps/wave-player-next/src/client/app/player-card.tsx:116), lines 116-125; [page.tsx:26](/Users/kalynbeach/dev/apps/wave-player/app/page.tsx:26), lines 26-28; [player-card-interface.md:44](/Users/kalynbeach/dev/apps/wave-player-next/docs/player-card-interface.md:44); [NOTES.md:7](/Users/kalynbeach/dev/apps/wave-player-next/docs/NOTES.md:7).

Design consequence: group a small Library affordance with related views. Keep theme selection out of the listening composition.

### 8. Stencil and phosphor-green visualizations are established cross-repository references

KKB's current stable design entrypoint directly lists Stencil, Prewalk, and Snapcompact, and records Kalyn's enthusiasm for their colors, typography, scale, spacing, and graphics. Its synthesis favors dense flat ruled layouts, coordinated interactive figures, sparse functional color, and hierarchy through borders, spacing, and tone.

Evidence: [kkb-design.md:153](/Users/kalynbeach/dev/kb/kkb/docs/design/kkb-design.md:153), lines 153-197. This is local evidence of the user's established reference, not a fresh inspection of those sites.

The July 19 Wave Player notes specifically request the phosphor green and overall style of KKB's WebGPU oscilloscope. The current KKB composite shader uses accumulated signal, a blur/halo, green phosphor tint, and a lighter hot core. Evidence: [NOTES.md:10](/Users/kalynbeach/dev/apps/wave-player-next/docs/NOTES.md:10); [composite.ts:48](/Users/kalynbeach/dev/kb/kkb/packages/audio/src/oscilloscope/renderer/shaders/composite.ts:48), lines 48-78.

Design consequence: retain the signal studies as the dominant image region. Reserve glow for signal rather than controls.

## Asset and inspection boundaries

- Actual font assets exist at [TX-02-VF.woff2](/Users/kalynbeach/dev/kb/kkb/apps/web/app/fonts/TX-02-VF.woff2) and [DepartureMono-Regular.woff2](/Users/kalynbeach/dev/kb/kkb/apps/web/app/fonts/DepartureMono-Regular.woff2). They were located and their imports inspected, not copied or redistributed.
- The July interface document cites `/Users/kalynbeach/Desktop/Screenshot 2026-07-15 at 11.04.56 AM.png`, with a narrow nonbreaking space before AM in the original path. That exact file was not present at inspection. No claim in this report depends on having viewed it.
- Tracked-file searches did not locate player screenshot assets in the three prototype repositories or the research source tree. This report therefore distinguishes source declarations from rendered visual observations.
- Existing standalone artifacts are [component specimens](/Users/kalynbeach/dev/research/dist/shadcn-example/index.html), [explainer foundation](/Users/kalynbeach/dev/research/dist/kkb-explainer/index.html), and [August 25 session review](/Users/kalynbeach/dev/research/docs/2026-08-25-agents-package-workstreams-session-review.html). Generated `dist` files may lag the inspected source. These were located, not rendered during this subtask.
- The 2024 working component uses `md:flex-row` and `md:max-w-3xl`: [wave-player-audio.tsx:89](/Users/kalynbeach/dev/apps/wave-player-2024/src/components/wave-player-audio.tsx:89). It is older, dirty, and a weaker layout reference than the later 380px portrait card.
- Research's [Pi theme CSS](/Users/kalynbeach/dev/research/design/pi-one-tool-shadcn-theme.css:66), lines 66-73, removes elevation shadows. Its [August 22 study](/Users/kalynbeach/dev/research/docs/2026-08-22-i-gave-pi-one-tool-design-system.md:34), lines 34-55, distinguishes spacious article rhythm from compact internal graphics. Article section spacing should not become player control padding.
