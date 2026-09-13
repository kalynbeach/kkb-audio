# Codex app task: Wave Player image mockups

Related issue: [kkb-audio #21](https://github.com/kalynbeach/kkb-audio/issues/21).
Status: **prepared, not launched**. This file is a task prompt, not generation evidence.

## Launch from the Codex app

Use a new **Codex app task** associated with the local `kkb-audio` checkout on `design/21-wave-player`. Do not substitute a Codex CLI task or ordinary ChatGPT image conversation. If the app uses a separate checkout, supply the following files explicitly; they are not yet on `main`:

1. This task prompt.
2. [Design brief and reference captions](2026-09-13-wave-player-design-brief.md).
3. The images in [2026-09-13-wave-player-design-assets/](2026-09-13-wave-player-design-assets/).

Core image inputs are the four `research-foundations-*` / `research-selection-*` captures and `phosphor-signal.jpg`. The sphere and artifact captures are secondary inspiration. The two `kkb-audio-cached-sept4-*` images are **historical anti-references**, not target designs. Keep those roles explicit if attaching files manually.

Paste the task below. Launching it does not approve a design or authorize prototype code.

---

## Task prompt

Generate image mockups for Kalyn Beach's **wave-player**, grounded in the supplied KKB design-system/component references. This is the image-exploration phase of kkb-audio issue #21, before coded prototyping. Work only on image generation and its handoff. **Do not implement or modify UI, application code, dependencies, PRODUCT.md or DESIGN.md; do not commit, push, create a PR, run audio, start a live app or touch production/daily-driver channels.**

### First: verify the required image capability

Use this actual Codex app task and the **latest GPT image-generation model available here at execution time**. Inspect the available image-generation tool/model information; record the exact image model, run date, and the evidence that identifies it as the latest available option. The task's coding/reasoning model is not the image model.

If that model/capability is unavailable or cannot be verified, report the specific blocker and stop before substitution. Do not silently use a CLI, text-only sketches, hand-coded SVG/HTML screenshots, a different provider, or a guessed model name. A prepared prompt or incomplete task is not a completed image-generation run.

### Read and inspect the inputs

Read `docs/2026-09-13-wave-player-design-brief.md`, including its reference captions and authority hierarchy. Open the supplied images, not just their filenames. Use the pinned primary-source links if a material conflict needs clarification, but do not restart broad research.

Inspect the real component screenshots as controls, not page templates. Current starting constraints are **Inter for content/control labels and TX-02 for time/precise metadata**, square structural geometry, semantic light/dark roles, existing research Base UI/shadcn controls and Lucide utility icons. KKB's broader Phosphor/Geist lineage and the artifact's Instrument Serif title are not approved migrations. Image lettering can only approximate the actual faces: report fidelity limits rather than claiming exact font/component implementation.

### Product direction — already agreed

A compact, track-first music player that Kalyn keeps alongside other work. Track identity, a meaningful visual/artwork surface, full-track navigation and transport are one coherent object. Little surrounding chrome. The title is the strongest text, not the product name or an engine label.

On desktop, a session library expands **beside** the player without stretching the player into a dashboard. On mobile, browsing becomes an internal library view, preserving track identity and access to transport. Browsing and view changes do not interrupt playback. Collection scope is multi-file local selection for this session, not a database, watched folders, uploads or cloud catalog.

The full-track amplitude waveform is for navigation. A phosphor-green live oscilloscope is the historical starting direction for the separate visual surface. These are different jobs: keep both intelligible rather than replacing the visual identity with a waveform editor or treating live traces as full-track data. One adjustable A/B region defaults to the whole track, initially disabled; show its editing/active states without making ordinary listening look like a DAW.

### Composition and craft

- Build one coherent KKB direction across the requested views, not six unrelated skins.
- Compactness comes from useful hierarchy and removing redundant labels, not microscopic text or tiny touch targets. Propose dimensions; do not force a 5:7 ratio.
- Retain stable player scale between compact and expanded desktop views. Keep transport visible and practical, with clear play/pause, navigation, seek, volume/mute and library access.
- Use deliberate light and dark counterparts with the same anatomy and an intended System/Light/Dark control. Start from the brief's research neutral tokens. The phosphor signal should read well in both modes and stay inside its visual role; it is not a mandate for neon chrome.
- Honor sharp structural geometry, fine rules and typography roles. Do not copy the artifact shell's giant serif title, background grid, sidebar or editorial whitespace. Do not copy the historical audio screenshot's beveled blue shell, gradients or codec-first identity.
- No marketing hero, file-input-first demo, decorative hardware chassis, collectible-card ornament, generic SaaS dashboard, nested card wall, redundant “WEBGPU / LIVE SIGNAL” labels, scene editor or gratuitous controls.
- Distinguish selected/focused, loaded, playing and unavailable library entries without relying only on color. Keep long metadata and filename fallbacks credible. Do not invent retrieved artwork or unknown metadata.
- Seeking shows draft preview separately from the acknowledged cursor; release commits, cancellation does not seek. Loading/replacement do not autoplay. A/B boundaries must look different from the playhead, with understandable values and enable/reset affordances.

### Use the same controlled content

Use the synthetic collection in the brief: Low Tide / North Window / Tidal Studies (04:32), Glass Current / Static Bloom / Afterimage (06:18), the long-title track, filename-only WAV and failed Night Transit MP3. The loaded track is Low Tide at 01:24. A/B example: 00:48–01:36.

Put “Design fixture — simulated waveform and playback” in the output caption/board margin, **outside** the player UI. This does not describe Kalyn's real collection. Waveform/loop/live-visual states anticipate later implementation issues; do not label them as shipped capabilities.

### Generate a bounded first set

Produce **six individual primary images** with consistent framing and legible controls:

1. `compact-light`: compact player, visual surface and usable full-track timeline, library closed; normal listening with loop off.
2. `compact-dark`: the same anatomy, content and state in dark mode.
3. `desktop-library-light`: same-size player with companion session library open; show A/B editing/region feedback and distinguish loaded/playing from browsing selection.
4. `desktop-library-dark`: the same expanded composition and state in dark mode.
5. `mobile-library-light`: internal session library at a narrow phone proportion, persistent identity/transport, clear return to visual view; long/fallback/error entries represented.
6. `mobile-library-dark`: the same narrow composition and state in dark mode.

Use approximately 1440 × 1000 desktop and 390 × 844 mobile **viewport proportions**, adapting image dimensions to the generator's supported sizes. State the intended viewport and proposed player dimensions separately from image pixel dimensions. Do not stretch a desktop render to stand in for mobile. Keep the complete composition visible. If a contact sheet is useful, supply it in addition to the individual images, not instead of them.

One first set only. Do not spin through unbounded variants or start refining without Kalyn's feedback. Briefly describe how the direction handles empty/loading/error, seek-preview/cancel, paused/ended, A/B preparing/failed and static/reduced-motion visual states; these are proposals for later interactive review, not proof that images implement behavior.

### Preserve and return the evidence, then stop

Save outputs in a task-owned artifact directory without overwriting reference inputs or unrelated files. Return a reopenable Codex app task reference, and make these files accessible to Kalyn/Pi:

- the six original generated images, with stable filenames;
- exact image-generation prompts, including any follow-up/edit prompts;
- the reference filenames actually supplied to each generation;
- exact image model, execution date and verification evidence (including any limitation in model/version visibility);
- image dimensions, intended viewport/player dimensions and a concise rationale for the composition;
- material deviations, approximated fonts/icons/components, remaining interaction decisions, and one recommended direction for Kalyn to review.

Do not state that this design has been approved. **Stop for Kalyn's mockup approval. No HTML/React prototype or shipping implementation may begin in this task.**

---

## After the task returns

Bring its task reference, model evidence, prompts and images back to the #21 branch. Update the gate table in the brief with actual evidence, not anticipated results. Record Kalyn's selected image(s), requested changes and explicit visual-direction approval before starting coded prototyping. The later interactive-prototype approval remains a separate prerequisite for #22.
