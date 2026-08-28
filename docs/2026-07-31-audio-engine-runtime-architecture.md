# Audio engine and runtime architecture

Date: 2026-07-31
Link: https://t3.chat/share/egrgp1acd7

This note records the foundational architecture for a reusable core audio library that can power
web audio applications, native applications, and CLIs. The intended consumers include an audio or
music player, an audio analyzer or processor, and an audio visualizer. The system needs to handle
both files and streams while sharing as much implementation as possible across hosts.

## Engine vs. runtime

- **Audio engine**: the thing that *does* audio—decoding, mixing, processing, scheduling, and
  output. Think of it as a library with a graph of nodes and a clock.
- **Audio runtime**: the engine plus the environment it runs in—thread management, device
  abstraction, plugin loading, and lifecycle management.

One core powering players, analyzers, and visualizers across web and native hosts is closer to a
runtime. The engine is its heart; the runtime is everything that lets it live in different hosts.
In practice, the terms are often used loosely. The important design boundary is a
**platform-agnostic engine core** surrounded by **thin platform adapters**.

## Core components

1. **Sources and inputs**: file decoders for formats such as MP3, FLAC, WAV, and OGG; stream
   readers for network streams, microphones, and line-in; and generators such as oscillators and
   test tones. All sources emit the same representation: buffers of PCM samples.
2. **The graph**: nodes such as sources, effects, mixers, and analyzers connected by edges. Each
   node pulls or receives fixed-size blocks of audio, typically 128–512 frames. This is the model
   used by the Web Audio API and, in related forms, JUCE, SuperCollider, and most DAW internals.
3. **The clock and scheduler**: audio is fundamentally time-driven. A render callback fires every
   N frames, and all work must finish before its deadline or the output glitches. Lookahead
   scheduling computes events ahead of device time to provide sample-accurate timing.
4. **Processing and DSP**: gain, filters, EQ, compression, resampling, pitch shifting, and time
   stretching. These are ideally pure operations over sample blocks.
5. **Analysis taps**: FFT, level metering, loudness measurement in LUFS, and onset detection.
   These observe the graph without modifying it. First-class tap points let a visualizer or
   analyzer see exactly what the listener hears.
6. **Mixer and bus system**: channels, sends, submixes, and a master bus.
7. **Outputs and sinks**: an audio device, file writer for bounce or export, network stream, or a
   null sink for offline and batch processing. A CLI analyzer can use a null sink.
8. **Transport and application state**: play, pause, seek, position, looping, and playlists. This
   sits above the engine; the engine itself should not know what a song is.

## Canonical data flow

For each render quantum, the canonical signal flow is:

```text
Sources -> decode/resample -> graph processing block by block
        -> mixer/buses -> analysis taps -> sink: device, file, network, or null
```

There are two principal execution models:

- **Pull or callback-driven**: the output device asks for N frames, and the request propagates
  backward through the graph. Real-time output must work this way. Examples include Web Audio
  `AudioWorklet`, Core Audio, WASAPI, and PortAudio.
- **Push**: sources push data forward. This works for streams and offline processing but is
  awkward for device output.

Most engines are pull-based at the output and accept push-like stream inputs. A lock-free
single-producer, single-consumer ring buffer bridges the two models and moves audio between threads
without locking the real-time callback.

## Target architecture

```text
┌─────────────────────────────────────────────┐
│  Apps: player UI, visualizer, CLI analyzer  │
├─────────────────────────────────────────────┤
│  Runtime API: transport, sessions, events   │
├─────────────────────────────────────────────┤
│  Engine core (pure, platform-agnostic):     │
│  graph, DSP nodes, mixer, scheduler, taps   │
├─────────────────────────────────────────────┤
│  Adapters:                                  │
│  decode:  ffmpeg / symphonia / WebCodecs    │
│  output:  cpal|PortAudio / Web AudioWorklet │
│  streams: HTTP, Icecast, mic                │
└─────────────────────────────────────────────┘
```

The architecture depends on several rules:

- **The core never touches a device or file format directly.** It speaks one language: interleaved
  or planar `Float32` PCM blocks at a known sample rate. Everything else is an adapter.
- **The render callback never allocates, locks, or performs I/O.** Decoding and streaming happen
  on worker threads that feed ring buffers.
- **Sample-rate conversion happens at the boundaries.** The engine runs at one internal rate;
  adapters convert to and from external rates.
- **Analysis is implemented as first-class tap points, not as a separate pipeline.** This ensures
  the visualizer sees exactly what the player outputs.
- **Offline mode uses the same graph.** A null or file sink replaces the device, and the engine
  renders as fast as possible. This lets the CLI analyzer and player share nearly all engine code.

## Reference points

- **Web Audio API**: the node-graph model and `AudioWorklet` render-thread execution.
- **JUCE**: the classic cross-platform engine archetype, especially `AudioProcessorGraph` and its
  device abstraction.
- **cpal + Symphonia + rubato + fundsp**: a composable Rust stack for device I/O, decoding,
  resampling, and DSP respectively.
- **SuperCollider**: separates the language/runtime, `sclang`, from the real-time server,
  `scsynth`, over OSC. This is a useful model for one engine serving many frontends.

## Suggested implementation direction

A strong implementation path is to write the engine core in Rust, using components such as cpal,
Symphonia, rubato, and fundsp. The same core can be linked natively for CLIs and compiled to
WebAssembly for web applications, where it runs inside an `AudioWorklet` and is exposed through
TypeScript bindings. This provides one actual core across both environments. A pure TypeScript
core can work well for the web, but it is likely to require a rewrite or substantial bridging for
native applications.

## Architecture diagrams

### 1. Engine, runtime, and applications

```mermaid
flowchart TB
    Apps["Applications<br/>Music player · Analyzer · Processor · Visualizer"]

    subgraph Runtime["Audio runtime"]
        API["Runtime API<br/>Sessions · Lifecycle · Events · Transport"]
        Hosts["Runtime services<br/>Threads · Devices · Plugins · Platform integration"]

        subgraph Engine["Platform-agnostic audio engine"]
            Graph["Audio graph"]
            DSP["DSP processing"]
            Mixer["Mixer and buses"]
            Clock["Clock and scheduler"]
            Taps["Analysis taps"]
        end

        Adapters["Thin platform adapters<br/>Decoders · Streams · Devices · File writers"]
    end

    Apps --> API
    API --> Engine
    Hosts --> Engine
    Adapters --> Engine

    Transport["Application-level state<br/>Play · Pause · Seek · Loop · Playlist"]
    Transport -. controls .-> API

    Song["The engine does not know what a song is"]
    Song -. boundary .-> Engine
```

### 2. Layered cross-platform architecture

```mermaid
flowchart TB
    subgraph Frontends["Applications and frontends"]
        Player["Audio / music player"]
        Analyzer["CLI analyzer / processor"]
        Visualizer["Audio visualizer"]
        Other["Future audio applications"]
    end

    Runtime["Runtime API<br/>Transport · Sessions · Events · Lifecycle"]

    subgraph Core["Shared engine core"]
        Scheduler["Clock and scheduler"]
        Graph["Node graph"]
        DSP["DSP nodes"]
        Mixer["Mixer and bus system"]
        Analysis["Analysis taps"]
    end

    PCM["Canonical internal format<br/>Planar or interleaved Float32 PCM<br/>Known channel layout and sample rate<br/>Fixed blocks, typically 128–512 frames"]

    subgraph Boundary["Platform adapters"]
        Decode["Decode<br/>FFmpeg · Symphonia · WebCodecs"]
        Streams["Streams and capture<br/>HTTP · Icecast · Microphone · Line-in"]
        Output["Output<br/>cpal · PortAudio · AudioWorklet"]
        Writers["Non-device sinks<br/>File writer · Network · Null sink"]
        SRC["Boundary resampling<br/>External rate ↔ engine rate"]
    end

    Frontends --> Runtime
    Runtime --> Core
    Core <--> PCM
    Boundary <--> PCM

    Rule["Core never accesses devices,<br/>files, codecs, or networks directly"]
    Rule -. architectural boundary .-> PCM
```

### 3. Unified signal graph and data flow

```mermaid
flowchart LR
    subgraph Sources["Sources"]
        Files["Audio files<br/>MP3 · FLAC · WAV · OGG"]
        Network["Network streams"]
        Input["Mic / line-in"]
        Generators["Oscillators / test tones"]
    end

    Boundary["Decode · Buffer · Resample<br/>Convert everything to PCM blocks"]

    subgraph Graph["Block-processing graph"]
        SourceNodes["Source nodes"]
        Effects["DSP nodes<br/>Gain · Filters · EQ · Compression<br/>Pitch / time stretch · Resampling"]
        Buses["Channels · Sends · Submixes"]
        Master["Master bus"]
    end

    subgraph Observers["Read-only analysis taps"]
        FFT["FFT / spectrum"]
        Levels["Peak and RMS meters"]
        Loudness["LUFS loudness"]
        Onsets["Onset detection"]
    end

    subgraph Sinks["Sinks"]
        Device["Audio device"]
        File["File export / bounce"]
        Stream["Network output"]
        Null["Null sink<br/>CLI / batch analysis"]
    end

    Files --> Boundary
    Network --> Boundary
    Input --> Boundary
    Generators --> Boundary

    Boundary --> SourceNodes
    SourceNodes --> Effects
    Effects --> Buses
    Buses --> Master

    Master --> FFT
    Master --> Levels
    Master --> Loudness
    Master --> Onsets

    Master --> Device
    Master --> File
    Master --> Stream
    Master --> Null

    Exact["Taps observe the same final signal<br/>that reaches the selected sink"]
    Observers -. guarantees .-> Exact
```

### 4. Real-time pull rendering with push-fed inputs

```mermaid
sequenceDiagram
    participant IO as Decode / network worker
    participant Ring as Lock-free SPSC ring buffer
    participant Device as Output device
    participant Engine as Engine scheduler
    participant Graph as Audio graph
    participant Tap as Analysis tap

    loop Ahead of playback
        IO->>IO: Read, decode, and resample
        IO->>Ring: Push PCM blocks
    end

    loop Every render quantum
        Device->>Engine: Request N output frames
        Note over Device,Engine: Pull begins at the sink
        Engine->>Graph: Render N frames at device time
        Graph->>Ring: Pull source frames
        Ring-->>Graph: Return buffered PCM
        Graph->>Graph: Process nodes, buses, and master
        Graph->>Tap: Copy or expose analysis data
        Graph-->>Engine: Return completed output block
        Engine-->>Device: Deliver before deadline
    end
```

### 5. Clock, scheduling, and real-time discipline

```mermaid
flowchart TB
    Clock["Monotonic audio clock"]
    Lookahead["Lookahead scheduler<br/>Resolve events before device time"]
    Quantum["Render quantum<br/>N frames at an exact sample position"]
    Deadline{"Block ready<br/>before deadline?"}
    Output["Continuous, sample-accurate output"]
    Glitch["Underrun, click, or dropout"]

    Clock --> Lookahead
    Lookahead --> Quantum
    Quantum --> Deadline
    Deadline -->|Yes| Output
    Deadline -->|No| Glitch

    subgraph RT["Render callback: permitted"]
        Preallocated["Preallocated buffers"]
        Arithmetic["Bounded DSP work"]
        LockFree["Lock-free buffer access"]
    end

    subgraph Workers["Worker threads: moved off callback"]
        Allocation["Allocation and cleanup"]
        Locks["Locks and blocking synchronization"]
        IO["File and network I/O"]
        Decode["Decoding and expensive preparation"]
    end

    RT --> Quantum
    Workers --> Ring["Ring buffers / prepared state"]
    Ring --> Quantum
```

### 6. One graph, two execution modes

```mermaid
flowchart LR
    Definition["One graph definition<br/>Sources · DSP · Mixer · Taps"]

    subgraph Realtime["Real-time mode"]
        Callback["Device callback drives rendering"]
        Sized["Render exactly N requested frames"]
        Pace["Run at wall-clock pace"]
        Device["Device sink"]
    end

    subgraph Offline["Offline mode"]
        Loop["Runtime drives render loop"]
        Fast["Render as fast as compute allows"]
        Outputs["File or null sink"]
        Results["Exported audio or analysis results"]
    end

    Definition --> Callback
    Callback --> Sized --> Pace --> Device

    Definition --> Loop
    Loop --> Fast --> Outputs --> Results

    Shared["Same processing and analysis behavior<br/>Player and CLI share nearly all engine code"]
    Realtime --> Shared
    Offline --> Shared
```

### 7. Shared Rust core across native and web hosts

```mermaid
flowchart TB
    Rust["Rust engine core<br/>Graph · Scheduler · DSP · Mixer · Analysis"]

    subgraph Native["Native applications and CLIs"]
        NativeBindings["Native Rust API"]
        Symphonia["Symphonia<br/>Decoding"]
        Cpal["cpal / PortAudio<br/>Device I/O"]
        Rubato["rubato<br/>Resampling"]
        Fundsp["fundsp<br/>DSP building blocks"]
        CLI["Player · Analyzer · Processor"]
    end

    subgraph Web["Web applications"]
        Wasm["Compile core to Wasm"]
        TS["TypeScript bindings"]
        Worklet["AudioWorklet<br/>Real-time render thread"]
        WebCodecs["WebCodecs / browser adapters"]
        WebApps["Web player · Analyzer · Visualizer"]
    end

    Rust --> NativeBindings --> CLI
    Symphonia --> NativeBindings
    Cpal --> NativeBindings
    Rubato --> NativeBindings
    Fundsp --> Rust

    Rust --> Wasm --> TS --> Worklet --> WebApps
    WebCodecs --> Worklet
```

### 8. Architectural reference map

```mermaid
flowchart LR
    Design["Proposed runtime"]

    WebAudio["Web Audio API<br/>Node graph and AudioWorklet"]
    JUCE["JUCE<br/>Processor graph and device abstraction"]
    RustStack["cpal + Symphonia + rubato + fundsp<br/>Composable native implementation"]
    SuperCollider["SuperCollider<br/>One real-time server, many frontends"]
    DAWs["DAW architecture<br/>Block graphs, buses, scheduling"]

    WebAudio -->|"graph and web execution model"| Design
    JUCE -->|"cross-platform engine structure"| Design
    RustStack -->|"implementation components"| Design
    SuperCollider -->|"engine / frontend separation"| Design
    DAWs -->|"real-time processing conventions"| Design
```
