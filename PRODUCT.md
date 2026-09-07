# Audio-engine learning lab

<!-- impeccable:product-schema 1 -->

This file describes the learning lab only. The [system architecture](docs/2026-08-28-kkb-audio-system-architecture.md) remains authoritative for the engine.

## Platform

web

## Users and purpose

Kalyn wants to explore how a signal graph becomes a compiled execution plan and samples, with direct visual and audible cause and effect.

## Stack

The existing Bun 1.4, TypeScript, Rust and Wasm build. A dedicated lab page preserves both existing proof pages.

## Capabilities and constraints

Two oscillators, per-source gain, mixing, observation and output use the private closed engine program. Gain sets and linear ramps use absolute render frames. Frequency changes prepare a new plan. Waveforms are engine-generated offline in a worker; playback replays those samples. No general graph editing, deployment, backend or real-time visualization work in the audio callback.

## Design authority

The user delegated visual and interaction choices. Nearby KKB code establishes Geist typography, cool blue instrument colors and precise numeric displays. The lab may expand these into its own interactive composition.

## Success

Graph selection, execution order, event positions and waveform inspection agree. The user can hear nearby tones, inspect an exact gain event, and compare render partitions. Audio begins only after an explicit action. Keyboard, narrow layouts and reduced motion are supported.
