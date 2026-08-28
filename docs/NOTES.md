# Notes: `kkb-audio`

## KKB Rust Audio Software Vision

I want to build a sound/audio/music software system.

These are the initial components of the system I'm envisioning:
- Audio Engine & Runtime
  - Sources / Inputs
  - Graph
  - Clock & Scheduler
  - Processing (DSP)
  - Analysis Taps
  - Mixer / Bus System
  - Sinks / Outputs
  - Transports & State
- Audio Player
- Audio Library (Catalog)
- Audio Visualizer(s)
- Musical Analyzer
- ...

## KKB Rust Audio Engine & Runtime

Potential initial core dependencies (currently researching):
- [FFmpeg](https://github.com/FFmpeg/FFmpeg)
- [cpal](https://github.com/RustAudio/cpal)
  - [Setting up a new CPAL WASM project](https://github.com/RustAudio/cpal/wiki/Setting-up-a-new-CPAL-WASM-project)
- [symphonia](https://github.com/pdeljanov/Symphonia)
- [rodio](https://github.com/rustaudio/rodio)
- [clap](https://github.com/clap-rs/clap)
