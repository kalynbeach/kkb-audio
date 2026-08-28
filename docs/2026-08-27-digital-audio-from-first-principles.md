# Digital audio from first principles

Date: 2026-08-27

## 1. Sound is changing air pressure

A speaker pushes and pulls air. Your eardrum responds to those pressure changes.

We can describe the pressure at one position as a value changing over time:

```text
pressure
   ^
   |      /‾\      /‾\
   |     /   \    /   \
 0 +----/-----\--/-----\----> time
   |   /       \/       \
```

A microphone converts this pressure into a changing electrical voltage. Digital audio represents that changing voltage as numbers.

## 2. Sampling turns a continuous signal into numbers

An analog signal has a value at every possible instant. A computer records its value at regular intervals:

```text
analog signal:  smooth continuous curve
samples:         •  •  •  •  •  •
```

Each recorded value is an audio sample.

At a sample rate of 48,000 Hz, the system records 48,000 values per second, per channel.

```text
time       0        1/48000    2/48000    3/48000
sample     0.00       0.31       0.58       0.79
```

A sample is not a tiny piece of sound with duration. It is one amplitude value at one instant.

### Sample rate

The sample rate determines how frequently the signal is measured:

- 44,100 Hz is common for music
- 48,000 Hz is common for video and professional audio
- 96,000 Hz is sometimes used during production

According to the Nyquist theorem, a sample rate can represent frequencies below half that rate. A 48 kHz signal can represent frequencies below 24 kHz.

Humans generally hear up to about 20 kHz, often less depending on age and hearing.

### Bit depth

Each sample must also be represented with finite numerical precision.

Common formats include:

- 16-bit signed integer
- 24-bit signed integer
- 32-bit floating point

A signed 16-bit sample has 65,536 possible values:

```text
-32768 ... 0 ... 32767
```

Floating-point audio usually uses a normalized range:

```text
-1.0 = maximum negative amplitude
 0.0 = silence
+1.0 = maximum positive amplitude
```

Values outside the supported output range clip:

```text
wanted waveform:     /\
output limit:    ----  ----
clipped result:      ‾‾
```

Bit depth mostly affects noise floor and dynamic range. Sample rate mostly affects the highest representable frequency.

## 3. Channels, samples, and frames

Consider stereo audio. It has a left channel and a right channel.

At each sampling instant, you need one value for each channel:

```text
time 0: left = 0.25, right = 0.18
time 1: left = 0.31, right = 0.22
time 2: left = 0.36, right = 0.27
```

One value for one channel is a sample.

One value for every channel at the same instant is usually called a frame or sample frame:

```text
stereo frame = [left sample, right sample]
```

Therefore:

```text
1 mono frame   = 1 sample
1 stereo frame = 2 samples
1 5.1 frame    = 6 samples
```

At 48 kHz, one second of stereo audio contains:

```text
48,000 frames
96,000 individual samples
```

The word "frame" is overloaded. In most playback and DSP APIs, it means one time position across every channel. Audio codecs may use "frame" for a larger encoded block containing hundreds or thousands of sample frames.

## 4. Buffers are blocks of frames stored in memory

Computers usually do not process one frame at a time. That would require too much scheduling overhead.

Instead, they process a group of frames called a buffer:

```text
buffer
┌─────────┬─────────┬─────────┬─────────┐
│ frame 0 │ frame 1 │ frame 2 │   ...   │
└─────────┴─────────┴─────────┴─────────┘
```

A stereo buffer might be stored in interleaved form:

```text
L0, R0, L1, R1, L2, R2, ...
```

Or planar form:

```text
left:  L0, L1, L2, ...
right: R0, R1, R2, ...
```

Suppose you have:

- 48 kHz sample rate
- stereo audio
- 256 frames per buffer
- 32-bit float samples

The buffer represents:

```text
256 / 48,000 = 5.33 milliseconds
```

It contains:

```text
256 frames × 2 channels = 512 samples
512 samples × 4 bytes   = 2,048 bytes
```

Smaller buffers reduce latency but force the CPU to wake up more often. Larger buffers are easier to process reliably but add latency.

If the program fails to fill the next playback buffer before the audio device needs it, you hear a click or dropout. This is why real-time audio code avoids unpredictable work such as memory allocation, disk access, and waiting on locks.

## 5. PCM is the basic digital representation

A sequence of sample frames is called pulse-code modulation, or PCM.

PCM is conceptually simple:

```text
frame 0: [ 0.00,  0.00]
frame 1: [ 0.08,  0.07]
frame 2: [ 0.16,  0.14]
frame 3: [ 0.23,  0.20]
```

PCM describes the waveform directly.

Most audio processing operates on PCM:

- changing volume
- mixing tracks
- filtering frequencies
- adding reverb
- generating synthesizer output
- sending audio to a sound device

A WAV file often stores PCM, though WAV is a container and can hold other formats too.

## 6. Encoding and decoding

Files such as MP3, AAC, FLAC, and Opus do not usually store raw PCM samples directly.

Encoding converts audio into some storage or transmission format:

```text
PCM samples -> encoder -> encoded data
```

Decoding reverses that process:

```text
encoded data -> decoder -> PCM samples
```

### Lossless encoding

FLAC compresses audio without changing the decoded PCM values:

```text
original PCM == decoded PCM
```

It is similar in spirit to compressing a text file with ZIP.

### Lossy encoding

MP3, AAC, and Opus discard information that their psychoacoustic models predict humans are unlikely to notice:

```text
original PCM != decoded PCM
```

Higher bitrates generally preserve more information.

### Codec versus container

A codec defines how audio is encoded:

- PCM
- FLAC
- MP3
- AAC
- Opus

A container organizes one or more encoded streams plus metadata:

- WAV
- MP4
- Ogg
- Matroska

For example:

```text
MP4 container
├── AAC audio stream
├── H.264 video stream
└── timestamps and metadata
```

People often call writing PCM into a WAV file "encoding," but strictly speaking it may only involve formatting and wrapping uncompressed PCM in a container.

## 7. Rendering audio

"Render" is a broad term. It generally means producing the PCM frames that represent the final audio signal.

For a synthesizer:

```text
notes -> oscillator -> filter -> volume -> PCM frames
```

For a music project:

```text
recorded tracks
    + instruments
    + volume automation
    + effects
    + mixing
    = final PCM output
```

There are two common kinds of rendering.

### Real-time rendering

The program continuously produces buffers while audio plays:

```text
audio device asks for 256 frames
            ↓
program fills the buffer
            ↓
device plays it
            ↓
repeat about 188 times per second
```

At 48 kHz with 256-frame buffers:

```text
48,000 / 256 = 187.5 buffers per second
```

Each buffer must be ready within about 5.33 milliseconds.

### Offline rendering

The program produces audio without playing it immediately:

```text
project -> render -> final PCM -> encode -> output file
```

Offline rendering does not have to keep pace with a sound device. It may run faster or slower than real time.

Rendering is not necessarily encoding:

- rendering produces the waveform
- encoding stores or transmits that waveform in a chosen format

Exporting an MP3 usually performs both:

```text
project
  -> render PCM
  -> encode MP3
  -> write file
```

## 8. Playback from end to end

A typical playback pipeline looks like this:

```text
MP3 file
   ↓
read encoded bytes
   ↓
MP3 decoder
   ↓
PCM frames
   ↓
volume, mixing, effects
   ↓
rendered output buffers
   ↓
digital-to-analog converter
   ↓
electrical signal
   ↓
speaker
   ↓
changing air pressure
```

Recording runs in the other direction:

```text
changing air pressure
   ↓
microphone
   ↓
electrical signal
   ↓
analog-to-digital converter
   ↓
PCM frames
   ↓
optional encoder
   ↓
audio file
```

The digital-to-analog converter does more than connect sample points with a staircase. It reconstructs a smooth, band-limited signal using filtering.

## 9. A compact mental model

Keep these definitions straight:

- **Sample:** one amplitude number for one channel at one instant
- **Frame:** one sample for every channel at one instant
- **Buffer:** a finite block of frames held in memory
- **PCM:** a sequence of frames representing a waveform
- **Decode:** turn encoded data into PCM
- **Encode:** turn PCM into a file or transmission representation
- **Render:** calculate the PCM output produced by sources, mixing, and effects
- **Sample rate:** frames per second
- **Bit depth or sample format:** how precisely each sample value is stored

The central idea is simple:

```text
Digital audio is a timed sequence of numbers.

Everything else is about:
1. producing those numbers
2. transforming those numbers
3. storing those numbers
4. turning those numbers back into sound
```
