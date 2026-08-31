use crate::prepared_kernel::{Output, OutputLayout, PrepareError, PreparedKernel, RenderStatus};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const OBSERVED_FRAME_SIZE_CAPACITY: usize = 8;
const PROOF_MAXIMUM_FRAMES: usize = 4_096;
const PROOF_FREQUENCY_HZ: f64 = 440.0;
const PROOF_GAIN: f32 = 0.02;
const PROOF_DURATION: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdapterPrepareError {
    Channels,
    Kernel(PrepareError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
enum FailureCode {
    None = 0,
    Host = 1,
    InvalidChannels = 2,
    InvalidInterleavedLength = 3,
    CapacityExceeded = 4,
    Render = 5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessStatus {
    Rendered,
    Silent(FailureCode),
}

struct SharedObservation {
    host_failed: AtomicBool,
    callback_count: AtomicU64,
    minimum_frames: AtomicUsize,
    maximum_frames: AtomicUsize,
    deadline_overruns: AtomicU64,
    failure_code: AtomicU32,
    observed_frame_sizes: [AtomicUsize; OBSERVED_FRAME_SIZE_CAPACITY],
    observed_frame_size_count: AtomicUsize,
    observed_frame_sizes_truncated: AtomicBool,
}

impl SharedObservation {
    fn new() -> Self {
        Self {
            host_failed: AtomicBool::new(false),
            callback_count: AtomicU64::new(0),
            minimum_frames: AtomicUsize::new(usize::MAX),
            maximum_frames: AtomicUsize::new(0),
            deadline_overruns: AtomicU64::new(0),
            failure_code: AtomicU32::new(FailureCode::None as u32),
            observed_frame_sizes: std::array::from_fn(|_| AtomicUsize::new(0)),
            observed_frame_size_count: AtomicUsize::new(0),
            observed_frame_sizes_truncated: AtomicBool::new(false),
        }
    }

    fn record_host_failure(&self) {
        self.host_failed.store(true, Ordering::Relaxed);
        self.failure_code
            .store(FailureCode::Host as u32, Ordering::Relaxed);
    }

    fn snapshot(&self) -> ObservationSnapshot {
        let count = self
            .observed_frame_size_count
            .load(Ordering::Relaxed)
            .min(OBSERVED_FRAME_SIZE_CAPACITY);
        let observed_frame_sizes = self.observed_frame_sizes[..count]
            .iter()
            .map(|value| value.load(Ordering::Relaxed))
            .collect();
        let callback_count = self.callback_count.load(Ordering::Relaxed);
        let minimum_frames = if callback_count == 0 {
            0
        } else {
            self.minimum_frames.load(Ordering::Relaxed)
        };

        ObservationSnapshot {
            callback_count,
            minimum_frames,
            maximum_frames: self.maximum_frames.load(Ordering::Relaxed),
            deadline_overruns: self.deadline_overruns.load(Ordering::Relaxed),
            failure_code: self.failure_code.load(Ordering::Relaxed),
            host_failed: self.host_failed.load(Ordering::Relaxed),
            observed_frame_sizes,
            observed_frame_sizes_truncated: self
                .observed_frame_sizes_truncated
                .load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ObservationSnapshot {
    callback_count: u64,
    minimum_frames: usize,
    maximum_frames: usize,
    deadline_overruns: u64,
    failure_code: u32,
    host_failed: bool,
    observed_frame_sizes: Vec<usize>,
    observed_frame_sizes_truncated: bool,
}

struct CallbackProcessor {
    kernel: PreparedKernel,
    layout: OutputLayout,
    channels: usize,
    sample_rate: u32,
    maximum_frames: usize,
    left: Box<[f32]>,
    right: Box<[f32]>,
    failed: FailureCode,
    callback_count: u64,
    minimum_frames: usize,
    maximum_observed_frames: usize,
    deadline_overruns: u64,
    observed_frame_sizes: [usize; OBSERVED_FRAME_SIZE_CAPACITY],
    observed_frame_size_count: usize,
    shared: Arc<SharedObservation>,
}

impl CallbackProcessor {
    fn prepare(
        sample_rate: u32,
        channels: usize,
        frequency: f64,
        gain: f32,
        maximum_frames: usize,
        shared: Arc<SharedObservation>,
    ) -> Result<Self, AdapterPrepareError> {
        let layout = match channels {
            1 => OutputLayout::Mono,
            2 => OutputLayout::Stereo,
            _ => return Err(AdapterPrepareError::Channels),
        };
        let kernel = PreparedKernel::prepare(
            layout,
            f64::from(sample_rate),
            frequency,
            gain,
            maximum_frames,
        )
        .map_err(AdapterPrepareError::Kernel)?;

        // Allocation and first writes happen before the processor enters a callback.
        let left = vec![0.0; maximum_frames].into_boxed_slice();
        let right = match layout {
            OutputLayout::Mono => Box::default(),
            OutputLayout::Stereo => vec![0.0; maximum_frames].into_boxed_slice(),
        };

        Ok(Self {
            kernel,
            layout,
            channels,
            sample_rate,
            maximum_frames,
            left,
            right,
            failed: FailureCode::None,
            callback_count: 0,
            minimum_frames: usize::MAX,
            maximum_observed_frames: 0,
            deadline_overruns: 0,
            observed_frame_sizes: [0; OBSERVED_FRAME_SIZE_CAPACITY],
            observed_frame_size_count: 0,
            shared,
        })
    }

    fn process<T>(&mut self, output: &mut [T]) -> ProcessStatus
    where
        T: Sample + FromSample<f32>,
    {
        let started = Instant::now();
        output.fill(T::EQUILIBRIUM);
        self.callback_count = self.callback_count.saturating_add(1);

        if self.shared.host_failed.load(Ordering::Relaxed) {
            return self.finish_silent(FailureCode::Host, 0, started);
        }
        if self.failed != FailureCode::None {
            return self.finish_silent(self.failed, 0, started);
        }
        if !matches!(self.channels, 1 | 2) {
            return self.finish_silent(FailureCode::InvalidChannels, 0, started);
        }
        if !output.len().is_multiple_of(self.channels) {
            return self.finish_silent(FailureCode::InvalidInterleavedLength, 0, started);
        }

        let frame_count = output.len() / self.channels;
        if frame_count > self.maximum_frames {
            return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
        }
        self.record_frame_count(frame_count);

        let render_status = match self.layout {
            OutputLayout::Mono => {
                let Some(left) = self.left.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                self.kernel.render(Output::Mono(left))
            }
            OutputLayout::Stereo => {
                let Some(left) = self.left.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                let Some(right) = self.right.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                self.kernel.render(Output::Stereo { left, right })
            }
        };

        if render_status != RenderStatus::Rendered {
            return self.finish_silent(FailureCode::Render, frame_count, started);
        }

        match self.layout {
            OutputLayout::Mono => {
                for (destination, source) in output.iter_mut().zip(self.left.iter().copied()) {
                    *destination = T::from_sample(source);
                }
            }
            OutputLayout::Stereo => {
                let planar_samples = self
                    .left
                    .iter()
                    .copied()
                    .zip(self.right.iter().copied())
                    .flat_map(|(left, right)| [left, right]);
                for (destination, source) in output.iter_mut().zip(planar_samples) {
                    *destination = T::from_sample(source);
                }
            }
        }

        self.publish(started, frame_count, FailureCode::None);
        ProcessStatus::Rendered
    }

    fn record_frame_count(&mut self, frame_count: usize) {
        self.minimum_frames = self.minimum_frames.min(frame_count);
        self.maximum_observed_frames = self.maximum_observed_frames.max(frame_count);

        if self
            .observed_frame_sizes
            .iter()
            .take(self.observed_frame_size_count)
            .any(|observed| *observed == frame_count)
        {
            return;
        }
        let Some((slot, shared_slot)) = self
            .observed_frame_sizes
            .get_mut(self.observed_frame_size_count)
            .zip(
                self.shared
                    .observed_frame_sizes
                    .get(self.observed_frame_size_count),
            )
        else {
            self.shared
                .observed_frame_sizes_truncated
                .store(true, Ordering::Relaxed);
            return;
        };
        *slot = frame_count;
        shared_slot.store(frame_count, Ordering::Relaxed);
        self.observed_frame_size_count += 1;
        self.shared
            .observed_frame_size_count
            .store(self.observed_frame_size_count, Ordering::Relaxed);
    }

    fn finish_silent(
        &mut self,
        failure: FailureCode,
        frame_count: usize,
        started: Instant,
    ) -> ProcessStatus {
        self.failed = failure;
        self.publish(started, frame_count, failure);
        ProcessStatus::Silent(failure)
    }

    fn publish(&mut self, started: Instant, frame_count: usize, failure: FailureCode) {
        let elapsed = started.elapsed();
        let budget_nanos = (frame_count as u128)
            .saturating_mul(1_000_000_000)
            .checked_div(u128::from(self.sample_rate))
            .unwrap_or(0);
        if frame_count > 0 && elapsed.as_nanos() > budget_nanos {
            self.deadline_overruns = self.deadline_overruns.saturating_add(1);
        }

        self.shared
            .callback_count
            .store(self.callback_count, Ordering::Relaxed);
        self.shared
            .minimum_frames
            .store(self.minimum_frames, Ordering::Relaxed);
        self.shared
            .maximum_frames
            .store(self.maximum_observed_frames, Ordering::Relaxed);
        self.shared
            .deadline_overruns
            .store(self.deadline_overruns, Ordering::Relaxed);
        if failure != FailureCode::None {
            self.shared
                .failure_code
                .store(failure as u32, Ordering::Relaxed);
        }
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    processor: CallbackProcessor,
    shared: Arc<SharedObservation>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample + FromSample<f32>,
{
    let error_observation = Arc::clone(&shared);
    let mut processor = processor;
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                processor.process(output);
            },
            move |_| error_observation.record_host_failure(),
            None,
        )
        .map_err(|error| error.to_string())
}

fn build_stream_for_format(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    sample_format: SampleFormat,
    processor: CallbackProcessor,
    shared: Arc<SharedObservation>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::I8 => build_stream::<i8>(device, config, processor, shared),
        SampleFormat::I16 => build_stream::<i16>(device, config, processor, shared),
        SampleFormat::I24 => build_stream::<cpal::I24>(device, config, processor, shared),
        SampleFormat::I32 => build_stream::<i32>(device, config, processor, shared),
        SampleFormat::I64 => build_stream::<i64>(device, config, processor, shared),
        SampleFormat::U8 => build_stream::<u8>(device, config, processor, shared),
        SampleFormat::U16 => build_stream::<u16>(device, config, processor, shared),
        SampleFormat::U24 => build_stream::<cpal::U24>(device, config, processor, shared),
        SampleFormat::U32 => build_stream::<u32>(device, config, processor, shared),
        SampleFormat::U64 => build_stream::<u64>(device, config, processor, shared),
        SampleFormat::F32 => build_stream::<f32>(device, config, processor, shared),
        SampleFormat::F64 => build_stream::<f64>(device, config, processor, shared),
        _ => Err("the default device uses an unsupported DSD sample format".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        ALLOCATOR_PROBE_LOCK, MEASURE_ALLOCATIONS, allocator_counts, reset_allocator_counts,
    };
    use std::hint::black_box;

    fn prepared_processor(
        channels: usize,
        maximum_frames: usize,
    ) -> (CallbackProcessor, Arc<SharedObservation>) {
        let shared = Arc::new(SharedObservation::new());
        let processor = CallbackProcessor::prepare(
            48_000,
            channels,
            1_000.0,
            0.5,
            maximum_frames,
            Arc::clone(&shared),
        )
        .expect("valid test processor");
        (processor, shared)
    }

    fn assert_positive_zero(samples: &[f32]) {
        assert!(samples.iter().all(|sample| sample.to_bits() == 0));
    }

    #[test]
    fn mono_and_stereo_mapping_derive_actual_variable_frame_counts() {
        let (mut mono, mono_shared) = prepared_processor(1, 257);
        let mut mono_output = [f32::NAN; 17];
        assert_eq!(mono.process(&mut mono_output), ProcessStatus::Rendered);
        assert!(mono_output.iter().any(|sample| *sample != 0.0));
        assert_eq!(mono_shared.snapshot().observed_frame_sizes, vec![17]);

        let (mut stereo, stereo_shared) = prepared_processor(2, 257);
        let mut first = [f32::NAN; 34];
        let mut second = [f32::NAN; 514];
        assert_eq!(stereo.process(&mut first), ProcessStatus::Rendered);
        assert_eq!(stereo.process(&mut second), ProcessStatus::Rendered);
        for frame in first
            .as_chunks::<2>()
            .0
            .iter()
            .chain(second.as_chunks::<2>().0)
        {
            assert_eq!(frame[0], frame[1]);
        }
        let snapshot = stereo_shared.snapshot();
        assert_eq!(snapshot.callback_count, 2);
        assert_eq!(snapshot.minimum_frames, 17);
        assert_eq!(snapshot.maximum_frames, 257);
        assert_eq!(snapshot.observed_frame_sizes, vec![17, 257]);
        assert!(!snapshot.observed_frame_sizes_truncated);
    }

    #[test]
    fn frame_size_observation_truncation_does_not_interrupt_rendering() {
        let (mut processor, shared) = prepared_processor(2, 64);
        let mut expected_next_frame = 0_u64;

        for frame_count in 1..=10 {
            let mut output = vec![f32::NAN; frame_count * 2];
            assert_eq!(processor.process(&mut output), ProcessStatus::Rendered);
            assert!(output.iter().all(|sample| sample.is_finite()));
            for frame in output.as_chunks::<2>().0 {
                assert_eq!(frame[0], frame[1]);
            }
            expected_next_frame += frame_count as u64;
            assert_eq!(processor.kernel.next_frame, expected_next_frame);
        }

        let snapshot = shared.snapshot();
        assert_eq!(snapshot.callback_count, 10);
        assert_eq!(snapshot.minimum_frames, 1);
        assert_eq!(snapshot.maximum_frames, 10);
        assert_eq!(snapshot.observed_frame_sizes, (1..=8).collect::<Vec<_>>());
        assert!(snapshot.observed_frame_sizes_truncated);
        assert_eq!(snapshot.failure_code, FailureCode::None as u32);
    }

    #[test]
    fn malformed_capacity_and_host_failures_latch_positive_zero_silence() {
        let (mut malformed, _) = prepared_processor(2, 8);
        let mut malformed_output = [1.0; 3];
        assert_eq!(
            malformed.process(&mut malformed_output),
            ProcessStatus::Silent(FailureCode::InvalidInterleavedLength)
        );
        assert_positive_zero(&malformed_output);
        let mut malformed_later = [1.0; 4];
        assert_eq!(
            malformed.process(&mut malformed_later),
            ProcessStatus::Silent(FailureCode::InvalidInterleavedLength)
        );
        assert_positive_zero(&malformed_later);

        let (mut capacity, _) = prepared_processor(2, 2);
        let mut oversized = [1.0; 6];
        assert_eq!(
            capacity.process(&mut oversized),
            ProcessStatus::Silent(FailureCode::CapacityExceeded)
        );
        assert_positive_zero(&oversized);

        let (mut host_failed, host_shared) = prepared_processor(1, 8);
        host_shared.record_host_failure();
        let mut host_output = [1.0; 4];
        assert_eq!(
            host_failed.process(&mut host_output),
            ProcessStatus::Silent(FailureCode::Host)
        );
        assert_positive_zero(&host_output);
    }

    #[test]
    fn callback_processor_has_no_observed_allocator_calls() {
        let _probe_guard = ALLOCATOR_PROBE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        MEASURE_ALLOCATIONS.with(|active| active.set(false));

        let (mut warm_valid, _) = prepared_processor(2, 8);
        let (mut warm_malformed, _) = prepared_processor(2, 8);
        let (mut warm_capacity, _) = prepared_processor(2, 2);
        let (mut warm_host, warm_host_shared) = prepared_processor(1, 8);
        let (mut warm_truncated, _) = prepared_processor(2, 16);
        let mut warm_valid_output = [f32::NAN; 8];
        let mut warm_malformed_output = [1.0; 3];
        let mut warm_oversized = [1.0; 3];
        let mut warm_host_output = [1.0; 2];
        let mut warm_truncated_output = [f32::NAN; 18];
        warm_host_shared.record_host_failure();
        black_box(warm_valid.process(black_box(&mut warm_valid_output)));
        black_box(warm_malformed.process(black_box(&mut warm_malformed_output)));
        black_box(warm_capacity.process(black_box(&mut warm_oversized)));
        black_box(warm_host.process(black_box(&mut warm_host_output)));
        for frame_count in 1..=9 {
            black_box(
                warm_truncated.process(black_box(&mut warm_truncated_output[..frame_count * 2])),
            );
        }

        let (mut valid, _) = prepared_processor(2, 8);
        let (mut malformed, _) = prepared_processor(2, 8);
        let (mut capacity, _) = prepared_processor(2, 2);
        let (mut host, host_shared) = prepared_processor(1, 8);
        let (mut truncated, _) = prepared_processor(2, 16);
        let mut valid_output = [f32::NAN; 8];
        let mut malformed_output = [1.0; 3];
        let mut oversized = [1.0; 3];
        let mut host_output = [1.0; 2];
        let mut truncated_output = [f32::NAN; 18];
        host_shared.record_host_failure();

        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(true));
        black_box(valid.process(black_box(&mut valid_output)));
        black_box(malformed.process(black_box(&mut malformed_output)));
        black_box(capacity.process(black_box(&mut oversized)));
        black_box(host.process(black_box(&mut host_output)));
        for frame_count in 1..=9 {
            black_box(truncated.process(black_box(&mut truncated_output[..frame_count * 2])));
        }
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        let counts = allocator_counts();

        assert_eq!(counts, [0, 0, 0, 0]);
    }

    #[test]
    fn preparation_rejects_unsupported_channel_counts() {
        let shared = Arc::new(SharedObservation::new());
        assert!(matches!(
            CallbackProcessor::prepare(48_000, 0, 440.0, 0.02, 128, Arc::clone(&shared)),
            Err(AdapterPrepareError::Channels)
        ));
        assert!(matches!(
            CallbackProcessor::prepare(48_000, 3, 440.0, 0.02, 128, shared),
            Err(AdapterPrepareError::Channels)
        ));
    }

    #[test]
    #[ignore = "opens the default macOS output device for five seconds"]
    fn observe_default_macos_output_for_five_seconds() -> Result<(), String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "no default output device is available".to_owned())?;
        let supported = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let channels = usize::from(supported.channels());
        if !matches!(channels, 1 | 2) {
            return Err(format!(
                "default output has unsupported channel count {channels}"
            ));
        }
        let sample_rate = supported.sample_rate();
        let sample_format = supported.sample_format();
        let config = supported.config();
        let device_name = device.to_string();
        let supported_buffer_size = format!("{:?}", supported.buffer_size());
        let shared = Arc::new(SharedObservation::new());
        let processor = CallbackProcessor::prepare(
            sample_rate,
            channels,
            PROOF_FREQUENCY_HZ,
            PROOF_GAIN,
            PROOF_MAXIMUM_FRAMES,
            Arc::clone(&shared),
        )
        .map_err(|error| format!("processor preparation failed: {error:?}"))?;
        let stream = build_stream_for_format(
            &device,
            config,
            sample_format,
            processor,
            Arc::clone(&shared),
        )?;

        stream.play().map_err(|error| error.to_string())?;
        std::thread::sleep(PROOF_DURATION);
        stream.pause().map_err(|error| error.to_string())?;
        drop(stream);

        let snapshot = shared.snapshot();
        println!(
            "cpal_observation={{\"device\":{device_name:?},\"sample_rate\":{sample_rate},\"channels\":{channels},\"sample_format\":{sample_format:?},\"supported_buffer_size\":{supported_buffer_size:?},\"prepared_maximum_frames\":{PROOF_MAXIMUM_FRAMES},\"frequency_hz\":{PROOF_FREQUENCY_HZ},\"gain\":{PROOF_GAIN},\"duration_seconds\":{},\"callback_count\":{},\"observed_frame_sizes\":{:?},\"observed_frame_sizes_truncated\":{},\"minimum_frames\":{},\"maximum_frames\":{},\"processing_deadline_overruns\":{},\"host_failed\":{},\"failure_code\":{}}}",
            PROOF_DURATION.as_secs(),
            snapshot.callback_count,
            snapshot.observed_frame_sizes,
            snapshot.observed_frame_sizes_truncated,
            snapshot.minimum_frames,
            snapshot.maximum_frames,
            snapshot.deadline_overruns,
            snapshot.host_failed,
            snapshot.failure_code,
        );

        if snapshot.callback_count == 0 {
            return Err("the output stream produced no callbacks".to_owned());
        }
        if snapshot.host_failed || snapshot.failure_code != FailureCode::None as u32 {
            return Err(format!("the output stream failed: {snapshot:?}"));
        }
        if snapshot.deadline_overruns != 0 {
            return Err(format!(
                "project processing exceeded the callback budget: {snapshot:?}"
            ));
        }
        if snapshot.maximum_frames > PROOF_MAXIMUM_FRAMES {
            return Err(format!(
                "the callback exceeded prepared capacity: {snapshot:?}"
            ));
        }

        Ok(())
    }
}
