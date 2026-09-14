//! Shared fixed output-grid loop preparation. Workers own the converter and
//! bounded head; the renderer applies held-head smoothing before downstream DSP.
use crate::sample_rate::{PcmTimeline, PreparedRateConverter};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub(crate) const HEAD_FRAMES: usize = 4096;
const INVALID_LOOP: u32 = 73;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LoopRegion {
    pub(crate) a: u64,
    pub(crate) b: u64,
    pub(crate) fade: usize,
}
impl LoopRegion {
    pub(crate) fn new(a: u64, b: u64, rate: u32) -> Result<Self, u32> {
        let period = b.checked_sub(a).ok_or(INVALID_LOOP)?;
        let fade = u64::from(rate / 200).min(period / 4) as usize;
        if period < 8 || fade < 2 {
            return Err(INVALID_LOOP);
        }
        Ok(Self { a, b, fade })
    }
    pub(crate) fn period(self) -> u64 {
        self.b - self.a
    }
    pub(crate) fn position(self, unfolded: u64) -> u64 {
        if unfolded < self.b {
            unfolded
        } else {
            self.a + (unfolded - self.b) % self.period()
        }
    }
    pub(crate) fn iteration(self, unfolded: u64) -> u64 {
        if unfolded < self.b {
            0
        } else {
            1 + (unfolded - self.b) / self.period()
        }
    }
    pub(crate) fn sample(self, position: u64, sample: f32, head: f32) -> f32 {
        if position < self.b - self.fade as u64 {
            return sample;
        }
        let j = position - (self.b - self.fade as u64);
        if j == self.fade as u64 - 1 {
            return head;
        }
        let weight = j as f32 / (self.fade - 1) as f32;
        (1.0 - weight) * sample + weight * head
    }
}

/// Worker-only preparation for one decoded-media region. Creation does not imply readiness.
/// Call prepare_head after each bounded input push until head_ready, then start.
/// The existing finite converter reconstructs globally aligned history, including
/// source outside A/B used by its filter. Hosts prepare codec continuation history
/// before arming; the converter does not own or decode encoded history.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct PreparedMediaLoop {
    converter: PreparedRateConverter,
    region: LoopRegion,
    head: Vec<Vec<f32>>,
    head_filled: usize,
    head_length: usize,
    position: u64,
    reading_head: bool,
    read_revision: u64,
    continuation_source: Option<u64>,
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl PreparedMediaLoop {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(
        source_rate: u32,
        output_rate: u32,
        channels: usize,
        source_frames: u64,
        a: u64,
        b: u64,
    ) -> Result<Self, u32> {
        if a >= b || b > source_frames {
            return Err(INVALID_LOOP);
        }
        let timeline = PcmTimeline::new(source_rate, output_rate, source_frames)?;
        let region = LoopRegion::new(
            timeline.seek_pcm_frame(a)?,
            timeline.seek_pcm_frame(b)?,
            output_rate,
        )?;
        let mut converter =
            PreparedRateConverter::new(source_rate, output_rate, channels, source_frames)?;
        let head_length = region.period().min(HEAD_FRAMES as u64) as usize;
        let continuation_source = if region.period() > HEAD_FRAMES as u64 {
            converter.seek_output_frame(region.a + head_length as u64)?;
            Some(converter.source_frames_read())
        } else {
            None
        };
        converter.seek(a)?;
        Ok(Self {
            converter,
            region,
            head: vec![vec![0.0; head_length]; channels],
            head_filled: 0,
            head_length,
            position: region.a,
            reading_head: false,
            read_revision: 1,
            continuation_source,
        })
    }
    pub fn continuation_source_frame(&self) -> Option<u64> {
        self.continuation_source
    }
    pub fn pcm_a(&self) -> u64 {
        self.region.a
    }
    pub fn pcm_b(&self) -> u64 {
        self.region.b
    }
    pub fn fade_frames(&self) -> usize {
        self.region.fade
    }
    pub fn head_frames(&self) -> usize {
        self.head_length
    }
    pub fn head_ready(&self) -> bool {
        self.head_filled == self.head_length
    }
    pub fn head_sample(&self, channel: usize) -> f32 {
        self.head.get(channel).map_or(0.0, |p| p[0])
    }
    /// A changed revision requires the host reader to seek to source_frames_read
    /// before feeding the next input. Neither I/O nor callback scheduling lives here.
    pub fn read_revision(&self) -> u64 {
        self.read_revision
    }
    pub fn source_frames_read(&self) -> u64 {
        self.converter.source_frames_read()
    }
    pub fn input_frames_needed(&self) -> usize {
        if self.head_ready() && self.reading_head {
            0
        } else {
            self.converter.input_frames_needed()
        }
    }
    pub fn push(&mut self, planar: &[f32]) -> Result<(), u32> {
        self.converter.push(planar)
    }
    pub fn prepare_head(&mut self) -> Result<(), u32> {
        if self.head_ready() {
            return Ok(());
        }
        let count = self
            .converter
            .available_frames()
            .min(self.head_length - self.head_filled);
        for (channel, head) in self.head.iter_mut().enumerate() {
            head[self.head_filled..self.head_filled + count]
                .copy_from_slice(&self.converter.output(channel)[..count]);
        }
        self.converter.consume(count)?;
        self.head_filled += count;
        Ok(())
    }
    pub fn start(&mut self, pcm: u64) -> Result<(), u32> {
        if !self.head_ready() || pcm < self.region.a || pcm >= self.region.b {
            return Err(INVALID_LOOP);
        }
        self.position = pcm;
        self.reading_head = pcm < self.region.a + self.head_length as u64;
        if !self.reading_head {
            self.reset_converter(pcm)?;
        }
        Ok(())
    }
    pub fn available_frames(&self) -> usize {
        if !self.head_ready() {
            return 0;
        }
        if self.reading_head {
            (self.region.a + self.head_length as u64 - self.position) as usize
        } else {
            self.converter
                .available_frames()
                .min((self.region.b - self.position) as usize)
        }
    }
    pub fn output_ptr(&self, channel: usize) -> *const f32 {
        if self.reading_head {
            self.head.get(channel).map_or(std::ptr::null(), |head| {
                head[(self.position - self.region.a) as usize..].as_ptr()
            })
        } else {
            self.converter.output_ptr(channel)
        }
    }
    pub fn consume(&mut self, frames: usize) -> Result<(), u32> {
        if frames > self.available_frames() {
            return Err(INVALID_LOOP);
        }
        if !self.reading_head {
            self.converter.consume(frames)?;
        }
        self.position += frames as u64;
        if self.position == self.region.b {
            self.position = self.region.a;
            self.reading_head = true;
        } else if self.reading_head && self.position == self.region.a + self.head_length as u64 {
            self.reading_head = false;
            self.reset_converter(self.position)?;
        }
        Ok(())
    }
}
impl PreparedMediaLoop {
    fn reset_converter(&mut self, pcm: u64) -> Result<(), u32> {
        self.converter.seek_output_frame(pcm)?;
        self.read_revision = self.read_revision.checked_add(1).ok_or(INVALID_LOOP)?;
        Ok(())
    }
    pub(crate) fn output(&self, channel: usize) -> &[f32] {
        if self.reading_head {
            &self.head[channel][(self.position - self.region.a) as usize..]
                [..self.available_frames()]
        } else {
            &self.converter.output(channel)[..self.available_frames()]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn held_head_geometry_preserves_period_dc_bounds_and_matches_values_not_slopes() {
        let r = LoopRegion::new(7, 487, 48000).unwrap();
        assert_eq!(r.fade, 120);
        for p in r.a..r.b {
            assert!((r.sample(p, 0.375, 0.375) - 0.375).abs() < 3e-8);
            let y = r.sample(p, -0.6, 0.4);
            assert!((-0.6..=0.4).contains(&y));
            if p < r.b - r.fade as u64 {
                assert_eq!(y, -0.6);
            }
        }
        assert_eq!(r.sample(r.b - 1, -0.6, 0.4), 0.4);
        assert_ne!(
            r.sample(r.b - 1, -0.6, 0.4) - r.sample(r.b - 2, -0.6, 0.4),
            0.0
        );
        // Even an already periodic sine is transformed: matched values do not promise
        // preserved waveform shape or DC balance. An impulse at the final tail is dropped.
        let sine_region = LoopRegion::new(0, 48, 48000).unwrap();
        let sine: [f32; 48] =
            std::array::from_fn(|j| (std::f32::consts::TAU * j as f32 / 48.0).sin());
        let smoothed: [f32; 48] =
            std::array::from_fn(|j| sine_region.sample(j as u64, sine[j], sine[0]));
        for j in 0..48 {
            let expected = if j < 36 {
                sine[j]
            } else if j == 47 {
                sine[0]
            } else {
                let weight = (j - 36) as f32 / 11.0;
                (1.0 - weight) * sine[j] + weight * sine[0]
            };
            assert_eq!(smoothed[j], expected);
        }
        assert!(smoothed.iter().sum::<f32>().abs() > 0.001);
        assert_eq!(sine_region.sample(47, 1.0, 0.0), 0.0);
        for i in 0..10000 {
            assert_eq!(r.position(r.a + i * r.period()), r.a);
            assert_eq!(r.iteration(r.a + i * r.period()), i);
        }
        assert!(LoopRegion::new(0, 7, 48000).is_err());
        assert!(LoopRegion::new(0, 8, 399).is_err());
        assert_eq!(LoopRegion::new(0, 8, 400).unwrap().fade, 2);
    }
    fn convert(source: &[Vec<f32>], sr: u32, ro: u32) -> Vec<Vec<f32>> {
        let mut c =
            PreparedRateConverter::new(sr, ro, source.len(), source[0].len() as u64).unwrap();
        let mut out = vec![Vec::new(); source.len()];
        while out[0].len() < c.total_pcm_frames() as usize {
            let n = c.input_frames_needed().min(73);
            if n > 0 {
                let at = c.source_frames_read() as usize;
                let p = source
                    .iter()
                    .flat_map(|v| v[at..at + n].iter().copied())
                    .collect::<Vec<_>>();
                c.push(&p).unwrap();
            }
            let n = c.available_frames().min(97);
            for (ch, p) in out.iter_mut().enumerate() {
                p.extend_from_slice(&c.output(ch)[..n]);
            }
            c.consume(n).unwrap();
        }
        out
    }
    #[test]
    fn media_loop_head_and_repeated_pcm_match_independent_uninterrupted_conversion() {
        for (sr, ro) in [(48000, 48000), (44100, 48000), (48000, 44100)] {
            for (length, a, b) in [
                (8, 0, 8),
                (17, 0, 17),
                (19007, 7001, 17004),
                (19007, 0, 19007),
                (19007, 18000, 19007),
            ] {
                let source = vec![
                    (0..length)
                        .map(|i| {
                            if i % 997 == 0 {
                                0.75
                            } else {
                                (i as f32 * 0.031).sin() * 0.3
                            }
                        })
                        .collect::<Vec<_>>(),
                    (0..length)
                        .map(|i| if i % 131 == 0 { -0.5 } else { 0.125 })
                        .collect::<Vec<_>>(),
                ];
                let reference = convert(&source, sr, ro);
                let candidate = PreparedMediaLoop::new(sr, ro, 2, length as u64, a, b);
                let timeline = PcmTimeline::new(sr, ro, length as u64).unwrap();
                let pa = timeline.seek_pcm_frame(a).unwrap();
                let pb = timeline.seek_pcm_frame(b).unwrap();
                if pb - pa < 8 {
                    assert!(candidate.is_err());
                    continue;
                }
                let mut c = candidate.unwrap();
                let feed = |c: &mut PreparedMediaLoop| {
                    let n = c.input_frames_needed().min(311);
                    if n > 0 {
                        let at = c.source_frames_read() as usize;
                        let p = source
                            .iter()
                            .flat_map(|v| v[at..at + n].iter().copied())
                            .collect::<Vec<_>>();
                        c.push(&p).unwrap();
                    }
                };
                while !c.head_ready() {
                    feed(&mut c);
                    c.prepare_head().unwrap();
                }
                assert!(c.head_frames() <= 4096);
                assert_eq!(c.head_sample(0), reference[0][pa as usize]);
                c.start(pa).unwrap();
                let count = (pb - pa) * if pb - pa < 32 { 10_000 } else { 7 } + 3;
                let mut written = 0;
                while written < count {
                    feed(&mut c);
                    let n = c
                        .available_frames()
                        .min(509)
                        .min((count - written) as usize);
                    for (channel, plane) in reference.iter().enumerate() {
                        for (j, &sample) in c.output(channel)[..n].iter().enumerate() {
                            let at = pa + (written + j as u64) % (pb - pa);
                            assert_eq!(
                                sample, plane[at as usize],
                                "{sr}->{ro} a{a} b{b} frame{at}"
                            );
                        }
                    }
                    c.consume(n).unwrap();
                    written += n as u64;
                }
            }
        }
    }
}
