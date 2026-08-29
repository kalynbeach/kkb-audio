# Psychoacoustics for digital audio and audio-engine software

Date: 2026-08-27

## Scope and source boundary

This is a practical foundation for engineers building playback, DSP, metering, codecs, spatial
renderers, and audio-engine interfaces. It complements
[Digital audio from first principles](./2026-08-27-digital-audio-from-first-principles.md), which explains
samples and real-time processing, and the canonical
[KKB audio system architecture](./2026-08-28-kkb-audio-system-architecture.md), which defines graphs,
clocks, and host seams. Here the concern is what a listener may perceive from
the resulting pressure waveform—and why that cannot be read directly from samples alone.

The evidence boundary is original peer-reviewed work, official standards and specifications, and
first-party institutional guidance. ISO and IEC standards cited below are paywalled; claims are
limited to public catalog metadata rather than normative text. ISO catalog URLs also rejected
automated retrieval in this environment. The accessible ITU, EBU, W3C, NIDCD, and WHO materials
were inspected directly. Linked DOI records identify the primary studies; access to full articles
varies.

## The working model

> A signal has measurable properties. Hearing transforms that signal through frequency-selective,
> level-dependent, nonlinear, binaural, and time-dependent processes. Perception is the result, not
> another name for the measurement.

| Signal or system quantity | Perceptual correlate | Why they are not interchangeable |
| --- | --- | --- |
| Frequency in hertz | Pitch, timbre, audibility | A complex sound can retain pitch without energy at its fundamental; pitch is not an FFT-bin label ([Plomp, 1967](https://doi.org/10.1121/1.1910515)). |
| Amplitude, pressure, or digital level | Loudness, audibility | Loudness depends on spectrum, duration, and level; dBFS says nothing about acoustic playback level ([ISO 532-1 catalog](https://www.iso.org/standard/63077.html)). |
| Spectrum | Timbre, pitch, source identity | The ear analyzes overlapping bands rather than ideal FFT bins, and time structure matters ([Moore and Glasberg, 1983](https://doi.org/10.1121/1.389861)). |
| Waveform phase and delay | Timbre, localization, spaciousness, transients | Relative and interaural phase can matter even when spectra match ([Plomp and Steeneken, 1969](https://doi.org/10.1121/1.1911705)). |
| Channel samples | Apparent direction and extent | Localization arises from the pressure rendered at two ears, including head and pinna filtering—not from a pan value itself ([Wightman and Kistler, 1989](https://doi.org/10.1121/1.397558)). |
| Peak, RMS, or LUFS | Technical headroom or estimated programme loudness | Each meter answers a different defined question; none directly measures an individual's sensation ([ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)). |

This distinction is operationally important: an engine can prove that two files have the same sample
peak, integrated LUFS, or spectrum and still not prove that a particular listener will find them
equally loud, equally clear, or colocated.

## 1. Hearing range and thresholds

### There is a threshold surface, not one universal range

The familiar “20 Hz to 20 kHz” phrase is a useful nominal design shorthand, not a pass/fail boundary
shared by all humans. Audibility is a threshold over frequency under specified conditions. It changes
with presentation field and transducer, signal duration, background noise, level-estimation method,
and the listener. The original minimum-audible-field measurements already treated threshold as a
frequency-dependent curve, and modern standards separately define free-field and diffuse-field
reference thresholds
([Sivian and White, 1933](https://doi.org/10.1121/1.1915608);
[ISO 389-7:2019 catalog](https://www.iso.org/standard/77384.html)).

Population averages must not be universalized. Age-related hearing loss commonly affects higher
frequencies first, but people and ears differ; medical hearing status, noise exposure, medication,
and genetics also matter
([NIDCD, age-related hearing loss](https://www.nidcd.nih.gov/health/age-related-hearing-loss)).
ISO 7029 provides statistical distributions of hearing thresholds by age and sex for defined
otologically normal populations; it is a population model, not a prediction for an individual
([ISO 7029:2017 catalog](https://www.iso.org/standard/42916.html)).

### Keep threshold units straight

For sound in air, sound-pressure level is a physical ratio:

$$
L_p = 20\log_{10}\!\left(\frac{p_\mathrm{rms}}{20\ \mu\mathrm{Pa}}\right)\ \mathrm{dB\ SPL}.
$$

The reference pressure is not “the quietest possible sound.” A listener can detect some stimuli
below 0 dB SPL, while another stimulus at a positive SPL can be inaudible because threshold varies
with frequency and conditions. A-weighted dB, hearing level (dB HL), sensation level (dB SL),
full-scale digital level (dBFS), and SPL are different references and must not be substituted for one
another. IEC 61672 defines sound-level-meter performance and frequency/time weightings; ISO 389-7
defines reference hearing thresholds under particular acoustic fields
([IEC 61672-1:2013 catalog](https://webstore.iec.ch/en/publication/5708);
[ISO 389-7 catalog](https://www.iso.org/standard/77384.html)).

Threshold of audibility, discomfort, damage risk, and acceptable listening level are also different
questions. Safe exposure depends on both level and duration; the WHO/ITU personal-audio guidance
therefore treats dose and exposure management rather than declaring one universally safe volume
setting
([ITU-T H.870](https://www.itu.int/rec/T-REC-H.870);
[WHO safe-listening devices and systems standard](https://www.who.int/publications/i/item/9789241515276)).

**Engineering consequences**

- Specify acoustic claims with a calibrated transducer, position, room or coupler, weighting,
  bandwidth, and listener cohort. `-20 dBFS` alone is not an acoustic level.
- Do not place an essential alert only at a spectral extreme. Offer redundant visual or haptic cues
  and test alerts over representative masking noise and output devices.
- Treat an inaudible ultrasonic component as an implementation concern anyway: it can consume
  headroom or enter nonlinear stages, whose products require their own bandwidth control
  ([W3C `WaveShaperNode`](https://www.w3.org/TR/webaudio-1.1/#WaveShaperNode)).

## 2. Equal-loudness contours

Equal-loudness contours answer a controlled comparison question: what SPLs of pure tones at
different frequencies are judged equally loud under the stated listening conditions? Fletcher and
Munson's foundational experiments established the strong dependence on both frequency and level;
ISO 226 standardizes normal equal-loudness-level contours for a defined population and method
([Fletcher and Munson, 1933](https://doi.org/10.1002/j.1538-7305.1933.tb00403.x);
[ISO 226:2023 catalog](https://www.iso.org/standard/83117.html)). A loudness level in **phons** is
indexed to the SPL of an equally loud 1 kHz tone under that definition. It is not the SPL of every
spectral component and not a direct reading of arbitrary programme material.

The practical result is robust: sensitivity is frequency- and level-dependent, so reducing playback
level can change perceived tonal balance even when the signal's spectrum is unchanged. The exact
compensation is not robust across programme spectra, rooms, transducers, levels, or listeners.
Consequently a “loudness” control should not be a fixed smile-shaped EQ presented as a law of
hearing. If implemented, it needs a calibrated reference level, a stated target use, bounded gain,
and a bypass.

A- or K-weighting is not “the human hearing curve.” These are standardized filters for specified
measurements. ISO 226 concerns equal loudness of tones, ISO 532 specifies methods for calculating
loudness of stationary or time-varying sounds, IEC 61672 concerns sound-level meters, and ITU-R
BS.1770 defines programme-loudness and true-peak algorithms; their outputs are not interchangeable
([ISO 532-1 catalog](https://www.iso.org/standard/63077.html);
[ISO 532-2 catalog](https://www.iso.org/standard/63078.html);
[ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).

## 3. Pitch and frequency perception

For a sufficiently long isolated sinusoid, frequency is the dominant pitch cue, but **pitch is a
perceptual organization**, not frequency with a different unit. Harmonic complex tones can evoke a
pitch corresponding to a fundamental that is physically absent; systematic experiments on complex
tones show that pitch cannot be reduced to the largest FFT bin
([Plomp, 1967](https://doi.org/10.1121/1.1910515)). This means a practical pitch detector must
state which spectral or temporal model it uses rather than treating one model as the definition of
pitch.

Frequency discrimination is likewise not a fixed hertz or percentage constant. Thresholds vary
with base frequency and sensation level, as the original controlled measurements explicitly show
([Wier, Jesteadt, and Green, 1977](https://doi.org/10.1121/1.381251)). Musical equal temperament's
logarithmic mapping is a useful interface convention; it does not turn the measured discrimination
thresholds into one fixed hertz value.

The slogan “humans cannot hear phase” is too broad. Absolute starting phase of a sustained isolated
sinusoid is usually not a useful monaural control, but relative phase can change a complex waveform's
timbre or transient envelope, and interaural phase/time differences are localization cues. Controlled
work found phase-dependent timbral judgments for some complex tones
([Plomp and Steeneken, 1969](https://doi.org/10.1121/1.1911705)).

**Engineering consequences**

- A tuner, pitch shifter, or synthesizer needs an explicit pitch model; an FFT maximum is not enough
  for missing-fundamental, polyphonic, noisy, or transient material.
- Smooth frequency in ratios or cents for musical controls, but perform listening tests for the
  actual oscillator, register, duration, and level.
- Preserve relative phase where it carries stereo localization or transient shape. Test mono sums;
  “phase-inverted but sample-peak-identical” does not imply perceptual equivalence.

## 4. Critical bands and auditory filters

Masking experiments support a bank of overlapping, level- and frequency-dependent auditory filters.
A signal is most strongly affected by masker energy admitted through filters near its frequency.
Zwicker's **critical bands** are an influential coarse partition derived from perceptual tasks;
modern work often models continuous auditory-filter shapes and equivalent rectangular bandwidth
(ERB) instead
([Zwicker, 1961](https://doi.org/10.1121/1.1908630);
[Moore and Glasberg, 1983](https://doi.org/10.1121/1.389861)).

A common normal-hearing ERB approximation derived from notched-noise data is

$$
\operatorname{ERB}(f) \approx 24.7\left(4.37\frac{f}{1000}+1\right)\ \mathrm{Hz},
$$

with $f$ in hertz
([Glasberg and Moore, 1990](https://doi.org/10.1016/0378-5955%2890%2990170-T)). It is a useful analysis
scale, not an anatomical set of brick-wall filters. Estimated bandwidths depend on listener, level,
method, and hearing status; adjacent filters overlap.

**Engineering consequences**

- A linear-frequency FFT is an excellent signal measurement but a poor picture of equal perceptual
  spacing. Add log-frequency or ERB-band views when the question is likely audibility or timbre.
- Avoid treating one “critical-band table” as exact codec truth. Masking models need margins and
  validation on their intended listener population and material.
- EQ bands narrower than an auditory filter can still matter through level, beating, temporal
  structure, and interactions with nearby components. Auditory bandwidth is not an editing
  resolution limit.

## 5. Simultaneous and temporal masking

### Simultaneous masking

A masker can elevate detection threshold for a signal presented at the same time. The effect depends
on frequency separation, masker bandwidth and level, signal duration, and listener. Masking patterns
are not symmetric: as masker level changes, masking can spread differently above and below masker
frequency
([Egan and Hake, 1950](https://doi.org/10.1121/1.1906661)). This is the basis for perceptual coding
and many noise-shaping decisions, but it is statistical and stimulus-specific—not permission to
place arbitrary error “under a curve.”

### Temporal masking

A masker can also affect a nearby signal without temporal overlap. In **forward masking**, the probe
follows the masker; in **backward masking**, the probe precedes it
([Elliott, 1962](https://doi.org/10.1121/1.1918254)). Forward-masking thresholds vary strongly with
masker frequency and level and with the delay to the signal
([Jesteadt, Bacon, and Lehman, 1982](https://doi.org/10.1121/1.387576)). Short transients therefore
need time-local analysis: a long FFT or programme-average meter can hide pre-echo, smeared attacks,
or brief noise even when its aggregate spectrum looks acceptable.

Masking is not always reducible to energy in one filter. Listeners organize components into
perceptual streams: classic rapid-tone experiments showed that stream segregation changes perceived
order even though the presented sequence is unchanged
([Bregman and Campbell, 1971](https://doi.org/10.1037/h0031163)). Thus audibility of a component,
ability to identify it, and ability to assign it to a source are different tasks; an auditory
filterbank alone does not predict every mixture judgment.

**Engineering consequences**

- Perceptual encoders should allocate error in both frequency and time. Protect transients from
  coarse blocks and pre-echo, and verify with codec-sensitive material rather than average spectra.
- Gates, denoisers, and spectral editors should smooth decisions enough to avoid musical noise but
  not so much that they blur onsets. There is no universally inaudible attack/release pair.
- In a dense mix, separation can improve through timing, register, modulation, or location—not only
  by increasing level or carving static EQ holes.

## 6. Loudness and metering

Loudness is a judgment. Meters are reproducible signal estimators with defined references and time
windows. Use multiple meters because they answer different questions.

| Measure | What it establishes | What it does not establish |
| --- | --- | --- |
| Sample peak, dBFS | Largest stored sample relative to digital full scale | Reconstructed peak, SPL, loudness, or safety |
| True peak, dBTP | Estimate of continuous-time peaks between samples | Perceived loudness or immunity from later codec overshoot |
| RMS / mean square | Average signal energy over a chosen window | Equal loudness across spectra or durations |
| SPL, dB SPL | Calibrated acoustic pressure at a stated point | Digital headroom or an individual's loudness |
| Integrated LUFS/LKFS | Gated, K-weighted programme-level estimate under ITU-R BS.1770 | Exact loudness for each listener or every excerpt |
| Momentary / short-term loudness | Recent loudness estimate using specified windows | Programme-wide normalization by itself |
| Loudness range, LRA | EBU-defined distributional descriptor of programme variation | Peak headroom or a compressor prescription |

ITU-R BS.1770-5 defines K-weighting, channel weights, 400 ms overlapping gating blocks, an absolute
gate, and a relative gate for integrated programme loudness. It also specifies oversampled
true-peak estimation because the reconstructed waveform can peak between stored samples
([ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).
EBU R 128 applies that algorithm to a broadcast workflow, generally recommending programme
normalization to −23 LUFS and a production maximum of −1 dBTP for linear audio while warning that
distribution systems may require lower true-peak limits
([EBU R 128-2023](https://tech.ebu.ch/docs/r/r128.pdf)). Those are workflow targets, not biological
constants or universal streaming requirements.

Two programmes at the same integrated LUFS can differ in short-term loudness, spectrum, dialogue
balance, dynamics, and listener judgment. A limiter can preserve LUFS while damaging transients;
a peak-normalized file can be much louder than another; and a normalized file can still clip after
lossy coding or sample-rate conversion. Keep programme loudness, dynamics, sample peak, and true
peak as separate state in the engine.

## 7. Spatial hearing and localization

Horizontal localization uses interaural time differences (ITDs), interaural level differences
(ILDs), and frequency-dependent head shadow in combinations that change with frequency and source
angle. Controlled cue-weighting measurements support the duplex account while also showing that
listeners combine cues rather than obey one hard crossover
([Macpherson and Middlebrooks, 2002](https://doi.org/10.1121/1.1471898)).

Front/back and vertical judgments depend strongly on direction-dependent filtering by the torso,
head, and pinnae—the head-related transfer function (HRTF). Median-plane experiments identified
spectral cues, and individualized headphone simulations demonstrated that measured free-field cues
can be synthesized and perceptually validated
([Hebrank and Wright, 1974](https://doi.org/10.1121/1.1903520);
[Wightman and Kistler, 1989, synthesis](https://doi.org/10.1121/1.397557);
[Wightman and Kistler, 1989, validation](https://doi.org/10.1121/1.397558)). Because anatomy and
headphone fit vary, a generic HRTF is not guaranteed to externalize or localize accurately for every
listener.

When similar sounds arrive from different directions in close succession, the first arrival can
dominate apparent direction. The original precedence-effect work showed that the relationship
depends on delay and stimulus; it did not establish one universal “Haas delay”
([Wallach, Newman, and Rosenzweig, 1949](https://doi.org/10.2307/1418275)).

**Engineering consequences**

- Store channel layout and speaker geometry explicitly. Channel index is not spatial meaning;
  follow a declared rendering convention such as ITU-R BS.775 for loudspeaker layouts
  ([ITU-R BS.775](https://www.itu.int/rec/R-REC-BS.775)).
- Distinguish simple stereo balance, loudspeaker panning, binaural HRTF rendering, and ambisonic or
  object rendering in the API. W3C Web Audio does this by specifying separate equal-power and HRTF
  panning models
  ([Web Audio API 1.1, spatialization](https://www.w3.org/TR/webaudio-1.1/#Spatialization-section)).
- For binaural output, test individualized variation, headphone transfer, head tracking, front/back
  confusions, and mono/downmix behavior. “3D audio” is not established by moving two gain sliders.
- Do not infer source distance from attenuation alone. Controlled virtual-acoustic experiments show
  systematic but condition-dependent distance judgments, including compression of perceived range
  ([Zahorik, 2002](https://doi.org/10.1121/1.1458027)).

## 8. Temporal perception

The auditory system is not an instantaneous spectrum analyzer. Detection improves as a short tone's
duration increases over a limited range, demonstrating temporal integration; the relationship is
frequency- and condition-dependent
([Plomp and Bouman, 1959](https://doi.org/10.1121/1.1907781)). Sensitivity to amplitude modulation
also falls with modulation rate in a stimulus-dependent way
([Viemeister, 1979](https://doi.org/10.1121/1.383531)). Onsets, offsets, gaps, rhythm, modulation,
and interaural delays therefore expose different temporal limits.

There is no single “human time resolution” suitable for setting every engine latency. A gap in
noise, a flammed drum hit, an echo, audiovisual lip sync, musical input-to-sound latency, and timing
jitter are different tasks with different stimuli and expectations. Buffer size is a system choice:
measure round-trip/device latency and jitter, then test the target interaction. The sample period is
also not a perceptual event grid; the sampling theorem concerns recoverable bandwidth, and
band-limited reconstruction can represent timing between sample instants
([Shannon, 1949](https://doi.org/10.1109/JRPROC.1949.232969)).

**Engineering consequences**

- Keep automation and event scheduling sample-accurate even if control input is slower. Repeated
  timing errors and jitter can be more revealing than one isolated offset.
- Choose compressor, limiter, envelope, and reverb times from programme intent and listening tests,
  not from one threshold quoted without task and level.
- Analyze transients with short windows or multiresolution methods and sustained tonal content with
  longer windows. One FFT size cannot maximize both temporal and frequency resolution.
- Treat end-to-end latency as a budget across input, buffering, scheduling, DSP lookahead,
  conversion, device, and acoustic path; psychoacoustics does not erase a missed real-time deadline.

## 9. Nonlinearities and limits

Hearing is nonlinear. Basilar-membrane response near a characteristic frequency grows
compressively over important level ranges in living mammalian cochleae; invasive measurements also
show strong level-dependent tuning
([Rhode, 1971](https://doi.org/10.1121/1.1912485);
[Ruggero et al., 1997](https://doi.org/10.1121/1.418265)). The cochlea can generate measurable
otoacoustic emissions, direct evidence that it is not a passive linear spectrum analyzer
([Kemp, 1978](https://doi.org/10.1121/1.382104)). These findings explain why linear changes in
pressure do not map to linear changes in sensation; they do not license one universal compressor
curve that “matches the ear.”

System nonlinearities remain measurable even when partly masked. Clipping, saturation, dynamics,
loudspeaker distortion, and hearing all create different products and should not be conflated.
Nonlinear DSP can create harmonics above Nyquist that alias into the audible band, so oversampling
and filtering decisions belong inside nonlinear processors rather than being justified by the
listener's upper threshold. The Web Audio specification makes this relationship explicit in the
`WaveShaperNode` oversampling modes
([W3C Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/#WaveShaperNode)).

Human performance limits are distributions, not constants. Thresholds and discrimination depend on
age, hearing status, exposure, level, duration, training, attention, and test method. A result from
trained young normal-hearing listeners in a calibrated room is evidence for that condition, not a
promise for consumers on speakers, earbuds, hearing aids, or noisy transport.

## 10. Practical design rules

| Engine or product area | Apply this principle | Failure to avoid |
| --- | --- | --- |
| Gain controls | Use dB for ratios, a usable taper, zipper-free ramps, and explicit acoustic calibration when SPL matters. | Calling a linear sample multiplier a linear loudness control. |
| EQ and analyzers | Offer frequency/log/ERB views; audition at realistic playback levels and on representative transducers. | Treating FFT-bin height or one equal-loudness contour as perceived balance. |
| Mixing | Preserve headroom; meter buses with peak, true peak, short-term, and integrated views as appropriate. | Normalizing every source by peak or LUFS and expecting a finished balance. |
| Dynamics | Expose time constants and gain reduction; protect transients; verify codec/SRC stages after limiting. | Equating compression with cochlear compression or relying only on integrated LUFS. |
| Perceptual codecs | Model masking conservatively in time and frequency; test transients, tonal signals, stereo images, and low bitrates. | Declaring an error inaudible because one generic masking model predicts it. |
| Spatial rendering | Carry layout metadata, select panning/rendering model explicitly, and support head tracking or personalization where required. | Treating pan as azimuth or a generic HRTF as universally accurate. |
| Scheduling | Maintain a monotonic sample timeline; bound jitter; measure full-path latency for each host. | Using one decontextualized “audible milliseconds” number. |
| Alerts/accessibility | Use redundant bands/modalities, adjustable level, and representative-noise testing. | Assuming nominal hearing range means universal audibility. |
| Listening tests | Level-match, randomize, blind where possible, define cohort and task, and report uncertainty. | Debugging preference with unblinded A/B or a spectrum screenshot. |

For small impairments near transparency, use the controlled double-blind framework in ITU-R
BS.1116; for intermediate-quality systems, use the multi-stimulus method in ITU-R BS.1534 rather
than inventing an informal score
([ITU-R BS.1116](https://www.itu.int/rec/R-REC-BS.1116);
[ITU-R BS.1534, MUSHRA](https://www.itu.int/rec/R-REC-BS.1534)). A test result remains conditional on
its programme material, anchors, reproduction chain, listeners, training, and statistics.

## 11. What is settled and what remains conditional

### Stable enough to design around

- Hearing is frequency-selective and can be usefully modeled by overlapping auditory filters
  ([Moore and Glasberg, 1983](https://doi.org/10.1121/1.389861)).
- Audibility and loudness depend on frequency and level; one amplitude number is insufficient
  ([ISO 226 catalog](https://www.iso.org/standard/83117.html)).
- Simultaneous and non-simultaneous masking exist and are frequency-, level-, and time-dependent
  ([Egan and Hake, 1950](https://doi.org/10.1121/1.1906661);
  [Elliott, 1962](https://doi.org/10.1121/1.1918254)).
- Pitch is not identical to a spectral line; complex tones can support missing-fundamental pitch
  ([Plomp, 1967](https://doi.org/10.1121/1.1910515)).
- Binaural time/level cues and direction-dependent spectral filtering support localization
  ([Macpherson and Middlebrooks, 2002](https://doi.org/10.1121/1.1471898);
  [Hebrank and Wright, 1974](https://doi.org/10.1121/1.1903520)).
- Cochlear mechanics are active and nonlinear
  ([Kemp, 1978](https://doi.org/10.1121/1.382104)).
- Standardized meters are valuable because they make one operational definition reproducible—not
  because they directly read subjective experience
  ([ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).

### Conditional; state the test boundary

- A listener's lower and upper audible frequencies and detection thresholds.
- Exact auditory-filter bandwidth, masking margin, frequency or level JND, gap threshold, and echo
  threshold.
- Whether two equal-LUFS programmes sound equally loud.
- Whether an encoder artifact, phase change, or timing error is audible.
- Whether a generic HRTF produces a stable externalized direction.
- Preferred loudness, dynamics, EQ, and spatial width.
- Acceptable latency for a particular musical, conversational, game, or audiovisual task.

The correct engineering response is not “everything is subjective.” Use the stable mechanisms to
choose representations and algorithms, standards to make measurements repeatable, and controlled
listening tests to resolve claims whose outcome depends on context.

## 12. Common misconceptions

1. **“Everyone hears 20 Hz–20 kHz.”** It is a nominal shorthand; measured thresholds vary with
   frequency, listener, and test conditions
   ([ISO 389-7 catalog](https://www.iso.org/standard/77384.html)).
2. **“0 dB means silence.”** Decibels express a ratio. 0 dB SPL and digital full scale use different
   references; neither phrase means silence
   ([IEC 61672-1 catalog](https://webstore.iec.ch/en/publication/5708);
   [ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).
3. **“A fixed dB increase is a fixed loudness multiplication.”** Physical level and perceived
   loudness are different; spectrum and starting level matter
   ([ISO 226 catalog](https://www.iso.org/standard/83117.html)).
4. **“Equal-loudness contours are a mastering EQ.”** They describe judgments of tones under stated
   conditions, not a universal correction for complex playback
   ([Fletcher and Munson, 1933](https://doi.org/10.1002/j.1538-7305.1933.tb00403.x)).
5. **“Critical bands are fixed bins.”** Auditory filters overlap; their estimated bandwidth changes
   with frequency and method
   ([Moore and Glasberg, 1983](https://doi.org/10.1121/1.389861)).
6. **“Masked means inaudible.”** Masking describes an elevated threshold under a model or test
   condition, and changes with frequency, level, and timing
   ([Egan and Hake, 1950](https://doi.org/10.1121/1.1906661);
   [Jesteadt, Bacon, and Lehman, 1982](https://doi.org/10.1121/1.387576)).
7. **“Humans cannot hear phase.”** Relative and interaural phase can affect timbre and localization
   ([Plomp and Steeneken, 1969](https://doi.org/10.1121/1.1911705)).
8. **“Same LUFS means same loudness.”** LUFS is a standardized programme estimator, not a direct
   sensation reading
   ([ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).
9. **“A sample peak below 0 dBFS cannot clip.”** The reconstructed signal can have higher
   inter-sample/true peaks
   ([ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)).
10. **“Stereo pan is physical location.”** It controls channel gains; apparent location depends on
    the complete rendering and listening geometry
    ([W3C Web Audio spatialization](https://www.w3.org/TR/webaudio-1.1/#Spatialization-section)).
11. **“There is one perceptual latency threshold.”** Temporal integration, modulation, and echo
    judgments are different experimental tasks
    ([Plomp and Bouman, 1959](https://doi.org/10.1121/1.1907781);
    [Wallach, Newman, and Rosenzweig, 1949](https://doi.org/10.2307/1418275)).
12. **“More sample rate means finer audible event timing.”** Band-limited reconstruction does not
    constrain events to sample instants; sample rate determines recoverable bandwidth
    ([Shannon, 1949](https://doi.org/10.1109/JRPROC.1949.232969)).

## Primary sources

### Standards, recommendations, and specifications

- [ISO 226:2023, *Acoustics—Normal equal-loudness-level contours* (official catalog)](https://www.iso.org/standard/83117.html)
- [ISO 389-7:2019, *Reference threshold of hearing under free-field and diffuse-field listening conditions* (official catalog)](https://www.iso.org/standard/77384.html)
- [ISO 532-1:2017, Zwicker method (official catalog)](https://www.iso.org/standard/63077.html) and
  [ISO 532-2:2017, Moore-Glasberg method (official catalog)](https://www.iso.org/standard/63078.html)
- [ISO 7029:2017, statistical distribution of hearing thresholds related to age and sex (official catalog)](https://www.iso.org/standard/42916.html)
- [IEC 61672-1:2013, sound-level meter specifications (official catalog)](https://webstore.iec.ch/en/publication/5708)
- [ITU-R BS.1770-5, programme loudness and true-peak algorithms (accessible official PDF)](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf)
- [EBU R 128-2023, loudness normalization and permitted maximum level (accessible official PDF)](https://tech.ebu.ch/docs/r/r128.pdf)
- [ITU-R BS.1116, subjective assessment of small impairments](https://www.itu.int/rec/R-REC-BS.1116) and
  [ITU-R BS.1534, MUSHRA assessment of intermediate quality](https://www.itu.int/rec/R-REC-BS.1534)
- [ITU-R BS.775, multichannel stereophonic sound-system layouts](https://www.itu.int/rec/R-REC-BS.775)
- [ITU-T H.870, safe listening systems and devices](https://www.itu.int/rec/T-REC-H.870)
- [W3C Web Audio API 1.1, spatialization and panning models](https://www.w3.org/TR/webaudio-1.1/#Spatialization-section)

### Original psychoacoustic and physiological studies

- Threshold and loudness: [Sivian and White (1933), minimum audible sound fields](https://doi.org/10.1121/1.1915608);
  [Fletcher and Munson (1933), equal loudness](https://doi.org/10.1002/j.1538-7305.1933.tb00403.x)
- Pitch and phase: [Plomp (1967), complex-tone pitch](https://doi.org/10.1121/1.1910515);
  [Wier, Jesteadt, and Green (1977), frequency discrimination](https://doi.org/10.1121/1.381251);
  [Plomp and Steeneken (1969), phase and timbre](https://doi.org/10.1121/1.1911705)
- Frequency selectivity: [Zwicker (1961), critical bands](https://doi.org/10.1121/1.1908630);
  [Moore and Glasberg (1983), auditory-filter formulae](https://doi.org/10.1121/1.389861);
  [Glasberg and Moore (1990), notched-noise auditory filters](https://doi.org/10.1016/0378-5955%2890%2990170-T)
- Masking and time: [Egan and Hake (1950), simultaneous masking pattern](https://doi.org/10.1121/1.1906661);
  [Elliott (1962), backward and forward masking](https://doi.org/10.1121/1.1918254);
  [Jesteadt, Bacon, and Lehman (1982), forward masking](https://doi.org/10.1121/1.387576);
  [Plomp and Bouman (1959), threshold and tone duration](https://doi.org/10.1121/1.1907781);
  [Viemeister (1979), temporal modulation transfer](https://doi.org/10.1121/1.383531);
  [Bregman and Campbell (1971), primary auditory stream segregation](https://doi.org/10.1037/h0031163)
- Spatial hearing: [Wallach, Newman, and Rosenzweig (1949), precedence effect](https://doi.org/10.2307/1418275);
  [Hebrank and Wright (1974), median-plane spectral cues](https://doi.org/10.1121/1.1903520);
  [Wightman and Kistler (1989), HRTF synthesis](https://doi.org/10.1121/1.397557) and
  [validation](https://doi.org/10.1121/1.397558);
  [Macpherson and Middlebrooks (2002), ITD/ILD cue weighting](https://doi.org/10.1121/1.1471898);
  [Zahorik (2002), auditory distance in virtual acoustics](https://doi.org/10.1121/1.1458027)
- Sampling and timing: [Shannon (1949), communication in the presence of noise](https://doi.org/10.1109/JRPROC.1949.232969)
- Cochlear nonlinearity: [Rhode (1971), basilar-membrane vibration](https://doi.org/10.1121/1.1912485);
  [Kemp (1978), stimulated otoacoustic emissions](https://doi.org/10.1121/1.382104);
  [Ruggero et al. (1997), level-dependent basilar-membrane responses](https://doi.org/10.1121/1.418265)

### Official institutional material

- [US NIDCD, *How Do We Hear?*](https://www.nidcd.nih.gov/health/how-do-we-hear)
- [US NIDCD, *Age-Related Hearing Loss*](https://www.nidcd.nih.gov/health/age-related-hearing-loss)
- [WHO, *Safe listening devices and systems: a WHO-ITU standard*](https://www.who.int/publications/i/item/9789241515276)
