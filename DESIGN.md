# Learning lab design

Scope: `/lab.html` only. The [product brief](PRODUCT.md) and
[engine guide](docs/2026-09-06-audio-engine-learning-lab.md) define behavior and claims.

## Instrument composition

This is a linked signal bench. The graph, compiled sequence, microscope and event timeline share
one selected processor and one integer sample cursor. A compact masthead and three experiment
controls introduce the instrument; they do not displace it with a marketing section.

The page inherits nearby KKB Geist typography and cool instrument colors. Dark blue grounds
support sustained waveform inspection. Cyan identifies source A, peach identifies source B, and
pale yellow-green identifies the mixed output. Every trace also has a text label. Numbers and
sample coordinates use a monospace system stack with tabular presentation.

## Tokens and controls

The page background is `#101820`, graph panel `#17232d`, text `#edf3f7`, secondary text `#a4b4c1`,
and dividers `#334450`. Source colors are `#70cadd`, `#f1b38e`, and `#dce8ac`.
Controls use 6px corners; instrument sections use 8–10px corners. The graph's dot grid describes
a signal canvas. Measurement and selection carry emphasis, with no decorative moving particles.

Geist body copy is 14px; main titles are 24px and section titles 16px. Labels and supporting
measurement text are smaller, with key sample values at 27px. Native range, numeric, select and
checkbox controls keep their keyboard behavior. Focus uses a visible cyan outline. Playback uses
the pale output color, and the stop control remains adjacent.

## Signal graphics

The graph is a fixed seven-node diagram with connections drawn from compiled input slots. Miniature
traces are actual recorded node samples, individually autoscaled. The microscope uses a common,
labeled scale for all visible lanes. Min/max bins retain extrema at wide zoom; detailed zoom adds
sample dots. Thin vertical lines mark real offline render-call boundaries. Gain event markers and
ramp duration brackets use source colors and exact sample labels.

Playback updates the cursor from the Web Audio clock at at most approximately 30 UI frames per
second. It is an estimated replay position; compilation and DSP have already completed. There is no
ambient animation. Reduced-motion preferences disable decorative control transitions.

## Responsive behavior

The desktop inspector sits beside the graph. Below 800px it moves beneath the graph, the execution
sequence wraps, and source controls use two columns. The graph scrolls internally to preserve legible
nodes. The document itself fits the viewport. Event editing wraps; a native selector makes coincident
markers individually reachable. The transport stays available near the viewport bottom and adapts
into two rows on narrow screens. No hover-only control is required.
