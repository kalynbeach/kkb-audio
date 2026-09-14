---
name: Learning lab and local player
description: KKB's inspectable workshop and approved compact track-first listening object.
colors:
  pi-ground: "#f4f4f0"
  pi-ground-dark: "#080807"
  pi-ground-deep: "#ecece6"
  pi-ground-deep-dark: "#030303"
  pi-surface-solid: "#fffffc"
  pi-surface-solid-dark: "#0c0c0b"
  pi-ink: "#171714"
  pi-ink-dark: "#f2f2ed"
  pi-ink-soft: "#363632"
  pi-ink-soft-dark: "#d0d0c9"
  pi-muted-ink: "#6a6a64"
  pi-muted-ink-dark: "#92928a"
  pi-line: "#d6d6ce"
  pi-line-dark: "#292925"
  pi-line-strong: "#a9a9a0"
  pi-line-strong-dark: "#54544e"
  scope-surface: "#edf1e8"
  scope-surface-dark: "#0b140e"
  scope-left: "#27633d"
  scope-left-dark: "#97d979"
  scope-right: "#466c28"
  scope-right-dark: "#cee9a0"
  scope-baseline: "#b5c3ad"
  scope-baseline-dark: "#33452e"
  scope-caption: "#36533d"
  scope-caption-dark: "#b5c6ae"
typography:
  body:
    fontFamily: '"InterVariable", Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: '"InterVariable", Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
  mono:
    fontFamily: '"TX-02", monospace'
    fontSize: "12px"
    fontWeight: 400
  meta:
    fontFamily: '"TX-02", monospace'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  state:
    fontFamily: '"Departure Mono", monospace'
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0"
rounded:
  square: "0rem"
spacing:
  rhythm: "4px"
  compact: "8px"
  inset: "12px"
  section: "16px"
  stage: "24px"
components:
  button-ghost:
    textColor: "{colors.pi-ink}"
    rounded: "{rounded.square}"
    padding: "0"
  button-ghost-hover:
    backgroundColor: "{colors.pi-ground-deep}"
    textColor: "{colors.pi-ink}"
  button-outline:
    backgroundColor: "{colors.pi-ground}"
    textColor: "{colors.pi-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 10px"
  button-outline-hover:
    backgroundColor: "{colors.pi-ground-deep}"
    textColor: "{colors.pi-ink}"
  button-secondary:
    backgroundColor: "{colors.pi-ground-deep}"
    textColor: "{colors.pi-ink-soft}"
    rounded: "{rounded.square}"
    padding: "0"
  appearance-option:
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 10px"
  player-surface:
    backgroundColor: "{colors.pi-surface-solid}"
    textColor: "{colors.pi-ink}"
    rounded: "{rounded.square}"
  playback-row:
    textColor: "{colors.pi-ink}"
    height: "68px"
  playback-row-selected:
    backgroundColor: "{colors.pi-ground-deep}"
    textColor: "{colors.pi-ink}"
    height: "68px"
  seek-range:
    rounded: "{rounded.square}"
    height: "40px"
---

# Design System: Learning lab and local player

## Overview

**Creative North Star: "a compact track-first listening object"**

For `/player.html`, this is the user-pinned [#21 interactive prototype](docs/2026-09-13-wave-player-prototype.md), not a generated seed or a new visual world. Its compact, square listening object pairs restrained surfaces with precise identity, honest media state and persistent transport. #22 replaces the historical demo composition only; it does not redesign the lab.

KKB is a technical and creative workshop. The lab should make its work inspectable, using precise
labels, visible state and useful controls. Typography, symbol meaning and information hierarchy
stay stable across light and dark modes. Theme changes come through semantic tokens.

**Key Characteristics:**
- Paired warm neutral modes, ruled divisions and flat resting surfaces.
- Inter identity and instructions, TX-02 technical values, player-only Departure Mono states.
- A centered player with an adjacent or internal library, never displaced transport.
- Honest unavailable media, explicit state and keyboard-reachable controls.

### Sources and precedence

This lab follows the KKB design-system baseline from [`kkb/DESIGN.md`](https://github.com/kalynbeach/kkb/blob/c30c935932ff5a7c245454491cef2591a55fece4/DESIGN.md)
and [`@kkb/ui`](https://github.com/kalynbeach/kkb/tree/c30c935932ff5a7c245454491cef2591a55fece4/packages/ui).
The surfaces are `/lab.html` and `/player.html`; the engine's architecture remains in [the canonical architecture](docs/2026-08-28-kkb-audio-system-architecture.md).

Kalyn's September 7 direction specifies the research repository's shadcn theme and component
styles, with **Inter for sans and TX-02 for mono**. These choices override the baseline's font,
icon and theme selections. They do not change its accessibility or product principles.

- Theme: [`research/design/pi-one-tool-shadcn-theme.css`](https://github.com/kalynbeach/research/blob/ce52029a5989fa5b5ca1ccb0020bc066cf99e218/design/pi-one-tool-shadcn-theme.css), copied unchanged to [`web/styles/theme.css`](web/styles/theme.css).
- Controls: research's Base UI `base-nova` shadcn sources at the same revision, copied into [`web/src/components/ui`](web/src/components/ui). The research component styles and Lucide utility icons remain intact.
- Typography: research's Inter/TX-02 token roles, with self-hosted Inter variable Latin and the TX-02 variable asset from KKB. No Geist face or fallback is used.
- Layout: [`web/lab.css`](web/lab.css) owns the graph, plots and page composition. Ordinary buttons, fields, sliders, checkboxes, selection groups and status elements use the copied shadcn components.

Player extraction is grounded in [`web/player.css`](web/player.css), [`web/src/player-app.tsx`](web/src/player-app.tsx), shared controls and the emitted [direction contract](web/player.html). The frontmatter records the reused player palette/type/spacing subset; it is not a replacement theme or a lab typography migration. Unsuffixed colors are light values; `-dark` records the same source primitive under `.dark`. Component tokens describe light defaults; semantic mode mapping below and live-bound sidecar snippets preserve dark behavior. [`.impeccable/design.json`](.impeccable/design.json) holds extensions only. Its synthesized tonal strips are panel previews, not additional application colors.

[Dated implementation evidence](docs/2026-09-13-compact-player.md) distinguishes original checks from the repair's current screenshots and 47-assertion muted browser run. The repair mobile compact screenshot includes a transient Settings exit snapshot, not a settled-state rule. Documentation is not parent acceptance, publication or device/accessibility certification.

## WAV loop interaction (#19, implemented for review)

The repeat utility discloses an editor independently of enabling looping. Its opaque absolute overlay
sits above the visual's bottom edge without resizing that visual or the 40px full-track waveform.
It persists across replacement while the new track resets whole/off. MP3 controls explicitly do not
offer loops. One hatched interval and labelled A/B handles remain distinct from the consumed playhead.
Exact fields accept fractional mm:ss or source frames suffixed `f` (Enter/blur commit, Escape restores);
arrow handles use 1 second / Shift 5 seconds and Shift-drag creates a region. Invalid or too-short
requests retain the accepted interval with feedback, rather than a prototype one-second floor.

Preparation/failure and exact requested-versus-realized coordinates share that opaque surface. Fixed
output-grid periods and accumulated conversion quantization are disclosed, not hidden behind rounded
times. Enable and edit inclusion use the renderer-acknowledged cursor, not a stale visual snapshot.
Normal wraps retain the untagged live visual; explicit control/recovery discontinuities clear it.
Review repair keeps the single actual oscilloscope caption above the editor, including reduced,
paused/warming, channel and failure explanations. The overlay is bounded by the actual visual area,
reserving 64px above it; expanded details scroll internally instead of covering track identity.
An initially too-short WAV can disclose its exact loop rejection reason while retaining linear Play.
The closed editor trigger retains its enabled/off cue; hatching/handles remain editing-only.

**Parent-approved smallest-width exception:** at viewport widths ≤360px, only Volume and Loop use
34×44px targets. Their order/placement, the 56px transport height, central 44/40/44px faces and 44px
Library target are unchanged. At 320px, the utility-to-playback gap is 2px and transport remains exactly
card-centered with disjoint hitboxes; at 361px utility targets return to 44×44px. This is not a claim
that every target is 44×44px at the smallest width. Canvas, visual, waveform and identity bounds do
not resize with disclosure. No font, asset, theme or entitlement change is implied. [Dated evidence](docs/2026-09-14-wav-loops.md)
separates runtime verification from still-pending human listening and parent acceptance.

## Colors

Warm paper and ink in light mode become near-black surfaces and pale ink in dark mode; hierarchy comes from semantic pairing rather than a new brand accent.

### Primary

The source `primary` role uses **pi-ink** against **pi-ground**, inverted through the paired dark primitives. Player transport actually uses secondary and ghost variants, not a newly invented primary-colored call to action.

### Neutral

| Semantic roles | Source primitive | Use |
| --- | --- | --- |
| background; primary-foreground | pi-ground | Page and inverse text |
| foreground; card-foreground; popover-foreground; accent-foreground | pi-ink | Identity, controls and readable error text |
| card; popover | pi-surface-solid | Player, companion, Settings and opaque Volume |
| secondary | pi-ground-deep | Selected rows and central playback button |
| secondary-foreground | pi-ink-soft | Secondary button ink |
| muted; accent | pi-ground-deep in light; pi-line in dark | Unavailable visual and hover/expanded surfaces |
| muted-foreground | pi-muted-ink | Metadata, phase context and seek rail |
| border; input | pi-line | Ruled divisions and control strokes |
| ring | pi-line-strong | Shared control focus treatment |

Each mapping uses its mode's primitive. Dark outline buttons additionally use `input` at 30% opacity, 50% on hover; dark ghost hover uses `muted` at 50%. These source variants are not new palette primitives.

Lab signal colors retain the theme's `chart-1`, `chart-2` and `chart-3` roles with text labels; they are not player signal decoration. Current player errors use foreground ink plus alert text, not the earlier low-contrast red treatment.

**The Paired Modes Rule.** Change semantic pairs, not typography, symbol meaning or control placement, when changing appearance.

## Typography

**Body Font:** InterVariable / Inter with the source sans fallback stack.
**Label/Mono Font:** TX-02 for filenames, metadata and tabular values; Departure Mono for short player states.

The player has a compact role-based hierarchy, not a display scale. The recurring frontmatter roles cover instructions, button labels, filenames, metadata and states. Row metadata and time use the meta role's 16px line box; filename rows use an 18px line box. Values use tabular numerals. Loaded identity remains a scoped Inter heading (22px/27px, weight 500, tracking −0.025em), not a global display token. Library and Settings headings remain local to those surfaces.

Inter carries instructions and control labels. TX-02 carries sample coordinates, values, process
names and technical metadata. Use tabular numeric presentation. Compact labels must remain readable
in both modes, and selected controls must expose their state beyond color.

Player icons are the actual regular Phosphor SVG subset in [`web/src/player-icons.tsx`](web/src/player-icons.tsx); lab Lucide utilities remain unchanged. Self-hosted Inter, TX-02 and Departure Mono assets are loaded by the player stylesheet. [Font/icon notices](THIRD_PARTY_NOTICES.md) accompany the build; Departure Mono uses the verified font OFL, not its website's MIT notice. Existing TX-02 entitlement remains unverified; this document grants no new use or distribution rights.

**The Technical Type Rule.** Use mono for filename rows and values, Inter for the identity heading, instructions and controls, and short player state text rather than decorative eyebrows.

## Layout

### Local player composition

The desktop listening object is centered independently of its library: 380 × 532px, with a fixed 64px identity header, flexible visual region, functional navigation and independently centered transport. At ≥1212px the 380px right companion opens across a 12px gap without shifting identity, seek or transport. Below that threshold the library replaces only the visual region.

At ≤760px, the card width is `min(380px, 100%)`, with 12px page insets. Height is `min(640px, calc(100svh - 140px))`, minimum 440px. Short screens scroll vertically. The document has a 320px minimum width. Library overflow is local and keyboard reachable. Names stay single-line with ellipsis and full native/accessibility naming rather than changing row or header geometry.

The shared 4px rhythm remains the baseline; repeated compact insets and section spacing are in the frontmatter. The approved player has optical exceptions, not a mandate that every value be a multiple of four.

**The Stationary Transport Rule.** Library disclosure changes the companion or visual region only; identity, navigation and transport remain available and the actual playback owner survives browsing, theme and viewport changes.

### Lab responsive and accessible behavior

The document must fit the viewport. The graph has a labeled, keyboard-reachable local scroll region
and execution-step shortcuts that bring selected nodes into view. The inspector moves below the
graph as space narrows; source controls and event fields reflow. Peak/RMS remains available beneath
the microscope when the transport cannot fit it.

## Elevation & Depth

Use the 4px spacing rhythm, ruled divisions and flat resting surfaces. The research theme maps all
radius tokens to zero. Signal colors use its `chart-1`, `chart-2` and `chart-3` roles and always have
text labels. Focus uses the theme's ring token. Resting hierarchy comes from spacing, borders and
paired foreground/background roles, without decorative shadows or gradients.

Player focus adds a high-contrast foreground outline (2px, normally offset 2px) alongside inherited shared-control focus rings; focus rings are interaction feedback, not ambient elevation. Settings uses a dimmed scrim. Volume is an opaque bordered surface, never a translucent snapshot over moving content. The theme shadow scale resolves to transparent zero shadows; the sidecar records this and disclosure timing without inventing elevations.

**The Single Disclosure Owner Rule.** Base UI alone owns Volume's live mount/fade. React 19.3 stable ViewTransition owns appropriate library and Settings disclosures, not transport, clocks, selection or theme updates.

Volume fades as one surface (140ms ease-out). Native disclosures use exit/enter/move timing (120/180/220ms), a short blur fade and transparent exit fill. Root cross-fading is disabled; fixed Settings/scrim stacking is preserved. Reduced motion removes transitions and snapshot timing; absence of native ViewTransition support does not remove functionality.

## Shapes

Square surfaces, controls, range thumbs and ruled rows follow the source zero-radius theme. This is not a universal ban on circles: the tiny resting current-track cue is a functional dot. Borders are thin structural rules (1px), not decorative card elevation. The selected row has a tonal fill and an inset border, preserving stable row dimensions.

## Components

### Shared foundation and buttons

Reusable controls belong to the shared UI foundation. This standalone repository vendors the
requested research implementations because `@kkb/ui` is a workspace package in another repository.
Engine sessions, workers, audio contexts and the complete instrument composition remain lab-owned.

Player buttons are square and restrained: ghost for utilities and row playback, secondary for central Play/Pause/Replay, outline for session actions. Shared disabled opacity is 50%, with pointer actions blocked. Shared active buttons move down 1px except popup triggers. Hover and expanded states use semantic tonal fills; focus must remain visible. Settings actions and empty-state actions have a 44px minimum height. Narrow transport targets are 44px; the 40px central play face has a 2px invisible extension on each side. Desktop transport remains compact rather than inheriting a fictitious universal 44px button width.

### Player and library surfaces

The player and companion share card background, foreground and border. Settings and Volume use popover pairs. Identity → honest visual → position → transport is the player hierarchy. The library header and scroll body remain separate from transport.

Playback-only rows keep their frontmatter height and a reserved leading 44px Play/Pause target. Fine-pointer desktop (>760px) reveals that target on hover or focus within; narrow/coarse-pointer controls remain visible. Selection has a tonal fill, inset rule and `aria-pressed`; active identity has `aria-current` and a resting speaker/dot cue. Selection is not playback. Rows do not gain import/delete controls, a Load step or LOADED/SELECTED badges.

### Navigation and volume inputs

The seek range retains its 40px target, elapsed/duration and textual phase. #18 replaces the thin rail with an actual source-amplitude min/max envelope: at most 160 columns combine every overlapping source bin, with fixed full-scale height (no per-file normalization). Remaining amplitude uses muted foreground; consumed amplitude and the straight, dotted-head cursor use foreground. A separate dashed preview cursor never recolors consumed progress. Silence has only a half-pixel baseline mark; MP3 overshoot clips visually at full scale but remains intact in the summary. Preparing/unavailable waveform text keeps a functional rail, never a synthetic signal. The independent #23 oscilloscope occupies the existing visual region without navigation semantics. Pointer preview commits once on release; Escape, blur, window blur, pointer cancel and lost capture abandon drafts. Keyboard steps are ±5 seconds, Page keys ±30 seconds, Home/End exact endpoints. Entry identity cancels stale drafts, including same-named files. Busy seeks remain focusable and guarded. Time is not live-announced; phase text is.

Volume opens left-aligned above navigation as a slim opaque strip with Mute, slider and tabular percentage. Its controls retain a 44px interaction height. Muting preserves the level. Appearance is an explicit System/Light/Dark toggle group in Settings, with tonal pressed state and keyboard focus; no preferences are saved.

### Live oscilloscope

The phosphor fine-signal/persistence reference stays inside the existing visual field. Canvas2D paints
paired surfaces and traces, not a neon shell or a new scene system. The `scope-*` palette above is
local to the player: light uses green ink on pale sage; dark uses pale phosphor on deep green-black.
Both independently painted signal and surface change with appearance. The caption uses its own
readable mode pair. Left/mono is solid and right is dashed with a visible channel legend; meaning
never relies only on their green shades. Fixed full-scale amplitude preserves quiet/silent signals,
rather than normalizing every track to fill the field. Three actual observation windows fade by
age (1 / 0.24 / 0.10), not fabricated animation or a decorative glow.

The lower inset caption names live, waiting, paused, ended, reduced or unavailable state, separately
from transport state. Audio pause freezes the last eligible observation. A paused seek/remount says
Play to observe rather than showing old samples. Ended, reduced motion and Settings Pause visual
use a stable surface/baseline and explanation; unavailable Canvas2D uses the CSS surface and text.
Reduced motion and visual pause never pause audio. Empty/loading/file errors retain existing actions.
Read [the timing/storage contract and evidence](docs/2026-09-13-live-oscilloscope.md); these are
approximate untagged rendered histories, not a source/speaker clock. No geometry, font, library,
Volume or disclosure animation owner changes are part of #23.

### Honest states and Settings

Unavailable metadata, artwork and duration are stated, never invented. Unknown time uses an em dash; a genuinely prepared sub-second duration may read `0:00`. Prepared playback uses the actual #23 oscilloscope, never the prototype study image or synthetic signal; unsupported/failed rendering retains “Visual unavailable” with independent playback controls. Empty state gives instructions and Open files without a decorative eyebrow. PREPARING/UNAVAILABLE are meaningful feedback, not a reusable kicker style.

Errors stay visible outside the visual/library swap and keep alert semantics. Settings holds Add files, Remove selected, Clear session and Close track/Cancel loading; the loading visual also offers Cancel. Original files remain untouched. Keep codec limits and session policy in [PRODUCT.md](PRODUCT.md) and the dated evidence, not in visual tokens.

**The Honest Media Rule.** Unavailable media is explicit; never portray invented artwork, metadata, elapsed time or decorative bars as actual source analysis.

### Lab instrument composition

The graph, compiled sequence, inspector, waveform and event timeline share one selected processor
and integer sample cursor. A short introduction and three guided experiments lead into the actual
instrument. Graph connections come from compiled input slots.

Miniature traces display recorded engine samples with individual autoscaling. The microscope uses
a common labeled amplitude scale. Wide views retain min/max extrema; detailed views show individual
samples. Block boundaries and event annotations use actual render frames. Ramp brackets communicate
duration, not a separately simulated parameter curve.

Audio starts through an explicit Play action. Listening volume starts at 15%, with adjacent Stop and
Mute controls. The cursor follows an estimated Web Audio replay clock; the Rust/Wasm render has
already completed. There is no ambient animation.

Every action has a keyboard path. Native numeric fields support drafts, commit on Enter or blur,
and cancel on Escape. Event selection preserves focus; markers support arrow keys. A selector
reaches coincident markers. Guided actions focus their resulting inspection or comparison region.

Light, Dark and System are explicit options. Dynamic views provide textual values and stable
stopped states. Reduced-motion preferences remove control transitions. Neither theme nor viewport
changes engine behavior. Browser verification and its limits are recorded in the [lab guide](docs/2026-09-06-audio-engine-learning-lab.md).

## Do's and Don'ts

### Do:
- **Do** keep semantic color pairs and typography roles stable across modes.
- **Do** preserve stationary player transport and the lab's independent instrument composition.
- **Do** keep selection, current playback, focus and errors explicit beyond color or hover alone.
- **Do** retain real fonts, regular SVG icons, honest media states and source-linked evidence.

### Don't:
- **Don't** promote prototype study imagery, synthetic signals or dead future controls into the current player.
- **Don't** turn functional state labels into decorative eyebrows or invent a global display scale.
- **Don't** add ambient shadows, gradients or a second animation owner to the approved player.
- **Don't** treat muted Chromium evidence or sidecar samples as listening, device or accessibility certification.

Intentionally not canonized: one-off heading sizes, footer microtype, optical offsets, scrim colors, popup width, seek-thumb dimensions and snapshot stacking numbers remain local source details, not reusable tokens. Unused theme serif/sidebar/chart extensions are not promoted into player roles. The removed “YOUR MUSIC” eyebrow and superseded red error ink are not system precedents. Sidecar tonal ramps are synthesized preview metadata only; component samples describe appearance, not a second playback implementation.
