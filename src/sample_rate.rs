//! Private finite, worker-owned conversion. Transport coordinates are output-rate PCM frames.
use audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Fft, FixedSync, Resampler};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const INVALID_CONVERSION: u32 = 71;

#[derive(Clone, Copy, Debug)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct PcmTimeline {
    source_rate: u32,
    output_rate: u32,
    source_frames: u64,
    pcm_frames: u64,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl PcmTimeline {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(source_rate: u32, output_rate: u32, source_frames: u64) -> Result<Self, u32> {
        if source_frames == 0
            || source_rate == 0
            || output_rate == 0
            || (source_rate != output_rate
                && !matches!((source_rate, output_rate), (44100, 48000) | (48000, 44100)))
        {
            return Err(INVALID_CONVERSION);
        }
        let frames =
            (u128::from(source_frames) * u128::from(output_rate)).div_ceil(u128::from(source_rate));
        Ok(Self {
            source_rate,
            output_rate,
            source_frames,
            pcm_frames: u64::try_from(frames).map_err(|_| INVALID_CONVERSION)?,
        })
    }
    pub fn total_pcm_frames(&self) -> u64 {
        self.pcm_frames
    }
    /// Floor-rounded media cursor, not filter provenance or audible presentation time.
    pub fn source_position(&self, pcm_position: u64) -> u64 {
        if pcm_position >= self.pcm_frames {
            return self.source_frames;
        }
        ((u128::from(pcm_position) * u128::from(self.source_rate)) / u128::from(self.output_rate))
            as u64
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct PreparedRateConverter {
    timeline: PcmTimeline,
    resampler: Option<Fft<f32>>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    input_filled: usize,
    source_read: u64,
    pcm_consumed: u64,
    skip_delay: usize,
    output_offset: usize,
    output_end: usize,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl PreparedRateConverter {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(
        source_rate: u32,
        output_rate: u32,
        channels: usize,
        source_frames: u64,
    ) -> Result<Self, u32> {
        let timeline = PcmTimeline::new(source_rate, output_rate, source_frames)?;
        if !matches!(channels, 1 | 2) {
            return Err(INVALID_CONVERSION);
        }
        let resampler = if source_rate == output_rate {
            None
        } else {
            // Eight rational units keep both FFT lengths even, hence delay integral.
            Some(
                Fft::<f32>::new(
                    source_rate as usize,
                    output_rate as usize,
                    (source_rate / 300 * 8) as usize,
                    channels,
                    FixedSync::Both,
                )
                .map_err(|_| INVALID_CONVERSION)?,
            )
        };
        let input_frames = resampler
            .as_ref()
            .map_or(1024, Resampler::input_frames_next);
        let output_frames = resampler
            .as_ref()
            .map_or(1024, Resampler::output_frames_next);
        let skip_delay = resampler.as_ref().map_or(0, Resampler::output_delay);
        Ok(Self {
            timeline,
            resampler,
            input: vec![vec![0.0; input_frames]; channels],
            output: vec![vec![0.0; output_frames]; channels],
            input_filled: 0,
            source_read: 0,
            pcm_consumed: 0,
            skip_delay,
            output_offset: 0,
            output_end: 0,
        })
    }
    pub fn total_pcm_frames(&self) -> u64 {
        self.timeline.total_pcm_frames()
    }
    pub fn source_frames_read(&self) -> u64 {
        self.source_read
    }
    pub fn input_frames_needed(&self) -> usize {
        if self.available_frames() != 0 {
            return 0;
        }
        (self.timeline.source_frames - self.source_read)
            .min((self.input[0].len() - self.input_filled) as u64) as usize
    }
    pub fn available_frames(&self) -> usize {
        self.output_end - self.output_offset
    }
    pub fn output_ptr(&self, channel: usize) -> *const f32 {
        self.output.get(channel).map_or(std::ptr::null(), |plane| {
            plane[self.output_offset..].as_ptr()
        })
    }
    /// Accept one bounded planar decode window, independent of converter chunk boundaries.
    pub fn push(&mut self, planar: &[f32]) -> Result<(), u32> {
        let channels = self.input.len();
        let frames = planar.len() / channels;
        if frames == 0
            || !planar.len().is_multiple_of(channels)
            || frames > self.input_frames_needed()
        {
            return Err(INVALID_CONVERSION);
        }
        for (channel, input) in self.input.iter_mut().enumerate() {
            input[self.input_filled..self.input_filled + frames]
                .copy_from_slice(&planar[channel * frames..(channel + 1) * frames]);
        }
        self.input_filled += frames;
        self.source_read += frames as u64;
        if self.resampler.is_none()
            || self.input_filled == self.input[0].len()
            || self.source_read == self.timeline.source_frames
        {
            self.process_chunk()?;
        }
        Ok(())
    }
    pub fn consume(&mut self, frames: usize) -> Result<(), u32> {
        if frames > self.available_frames() {
            return Err(INVALID_CONVERSION);
        }
        if frames == 0 {
            return Ok(());
        }
        self.output_offset += frames;
        self.pcm_consumed += frames as u64;
        if self.available_frames() == 0
            && self.source_read == self.timeline.source_frames
            && self.pcm_consumed < self.total_pcm_frames()
        {
            self.process_chunk()?;
        }
        Ok(())
    }
    /// Reload/reset starts a new finite stream; pause does not call this.
    pub fn reset(&mut self) {
        if let Some(resampler) = &mut self.resampler {
            resampler.reset();
        }
        for plane in &mut self.input {
            plane.fill(0.0);
        }
        for plane in &mut self.output {
            plane.fill(0.0);
        }
        self.input_filled = 0;
        self.source_read = 0;
        self.pcm_consumed = 0;
        self.output_offset = 0;
        self.output_end = 0;
        self.skip_delay = self.resampler.as_ref().map_or(0, Resampler::output_delay);
    }
}

impl PreparedRateConverter {
    pub(crate) fn output(&self, channel: usize) -> &[f32] {
        &self.output[channel][self.output_offset..self.output_end]
    }
    fn process_chunk(&mut self) -> Result<(), u32> {
        for plane in &mut self.input {
            plane[self.input_filled..].fill(0.0);
        }
        if let Some(resampler) = &mut self.resampler {
            let input =
                SequentialSliceOfVecs::new(&self.input, self.input.len(), self.input[0].len())
                    .map_err(|_| INVALID_CONVERSION)?;
            let channels = self.output.len();
            let frames = self.output[0].len();
            let mut output = SequentialSliceOfVecs::new_mut(&mut self.output, channels, frames)
                .map_err(|_| INVALID_CONVERSION)?;
            resampler
                .process_into_buffer(&input, &mut output, None)
                .map_err(|_| INVALID_CONVERSION)?;
        } else {
            for (output, input) in self.output.iter_mut().zip(&self.input) {
                output.copy_from_slice(input);
            }
        }
        let output_frames = if self.resampler.is_none() {
            self.input_filled
        } else {
            self.output[0].len()
        };
        self.input_filled = 0;
        self.output_offset = self.skip_delay;
        self.skip_delay = 0;
        let valid = (self.total_pcm_frames() - self.pcm_consumed)
            .min((output_frames - self.output_offset) as u64) as usize;
        self.output_end = self.output_offset + valid;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests;
