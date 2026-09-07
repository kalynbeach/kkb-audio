# Learning lab design

This lab follows the KKB design-system baseline from [`kkb/DESIGN.md`](https://github.com/kalynbeach/kkb/blob/c30c935932ff5a7c245454491cef2591a55fece4/DESIGN.md)
and [`@kkb/ui`](https://github.com/kalynbeach/kkb/tree/c30c935932ff5a7c245454491cef2591a55fece4/packages/ui).
The scope is `/lab.html`; the engine's architecture remains in [the canonical architecture](docs/2026-08-28-kkb-audio-system-architecture.md).

## Sources and precedence

Kalyn's September 7 direction specifies the research repository's shadcn theme and component
styles, with **Inter for sans and TX-02 for mono**. These choices override the baseline's font,
icon and theme selections. They do not change its accessibility or product principles.

- Theme: [`research/design/pi-one-tool-shadcn-theme.css`](https://github.com/kalynbeach/research/blob/ce52029a5989fa5b5ca1ccb0020bc066cf99e218/design/pi-one-tool-shadcn-theme.css), copied unchanged to [`web/styles/theme.css`](web/styles/theme.css).
- Controls: research's Base UI `base-nova` shadcn sources at the same revision, copied into [`web/src/components/ui`](web/src/components/ui). The research component styles and Lucide utility icons remain intact.
- Typography: research's Inter/TX-02 token roles, with self-hosted Inter variable Latin and the TX-02 variable asset from KKB. No Geist face or fallback is used.
- Layout: [`web/lab.css`](web/lab.css) owns the graph, plots and page composition. Ordinary buttons, fields, sliders, checkboxes, selection groups and status elements use the copied shadcn components.

## KKB baseline

KKB is a technical and creative workshop. The lab should make its work inspectable, using precise
labels, visible state and useful controls. Typography, symbol meaning and information hierarchy
stay stable across light and dark modes. Theme changes come through semantic tokens.

Use the 4px spacing rhythm, ruled divisions and flat resting surfaces. The research theme maps all
radius tokens to zero. Signal colors use its `chart-1`, `chart-2` and `chart-3` roles and always have
text labels. Focus uses the theme's ring token. Resting hierarchy comes from spacing, borders and
paired foreground/background roles, without decorative shadows or gradients.

Inter carries instructions and control labels. TX-02 carries sample coordinates, values, process
names and technical metadata. Use tabular numeric presentation. Compact labels must remain readable
in both modes, and selected controls must expose their state beyond color.

Reusable controls belong to the shared UI foundation. This standalone repository vendors the
requested research implementations because `@kkb/ui` is a workspace package in another repository.
Engine sessions, workers, audio contexts and the complete instrument composition remain lab-owned.

## Instrument composition

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

## Responsive and accessible behavior

The document must fit the viewport. The graph has a labeled, keyboard-reachable local scroll region
and execution-step shortcuts that bring selected nodes into view. The inspector moves below the
graph as space narrows; source controls and event fields reflow. Peak/RMS remains available beneath
the microscope when the transport cannot fit it.

Every action has a keyboard path. Native numeric fields support drafts, commit on Enter or blur,
and cancel on Escape. Event selection preserves focus; markers support arrow keys. A selector
reaches coincident markers. Guided actions focus their resulting inspection or comparison region.

Light, Dark and System are explicit options. Dynamic views provide textual values and stable
stopped states. Reduced-motion preferences remove control transitions. Neither theme nor viewport
changes engine behavior. Browser verification and its limits are recorded in the [lab guide](docs/2026-09-06-audio-engine-learning-lab.md).
