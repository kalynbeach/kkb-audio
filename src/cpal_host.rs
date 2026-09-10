use crate::compiled_plan::{CompiledPlan, RenderInstance};
use crate::prepared_kernel::{Output, RenderStatus};
use crate::prepared_pcm::{
    BlockMeta, ChannelLayout, OwnedPcmBlock, PreparedBlockSource, PreparedPcmInput, StreamSpec,
};
use crate::sample_rate::{PcmTimeline, PreparedRateConverter};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use rtrb::{Consumer, PopError, Producer, PushError, RingBuffer};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const OBSERVED_FRAME_SIZE_CAPACITY: usize = 8;
const PROOF_MAXIMUM_FRAMES: usize = 4_096;
const PROOF_DURATION: Duration = Duration::from_secs(5);
const PCM_SLOT_COUNT: usize = 4;
const PCM_SLOT_FRAMES: usize = 1_024;
const PROOF_SOURCE_ID: u64 = 3;
const PROOF_EPOCH: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdapterPrepareError {
    Channels,
    Stream,
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
    playback_command: AtomicU64,
    acknowledged_command: AtomicU64,
    source_position: AtomicU64,
    pcm_position: AtomicU64,
    render_frame: AtomicU64,
    ended: AtomicBool,
    callback_count: AtomicU64,
    minimum_frames: AtomicUsize,
    maximum_frames: AtomicUsize,
    deadline_overruns: AtomicU64,
    failure_code: AtomicU32,
    starvation_callbacks: AtomicU64,
    stale_blocks: AtomicU64,
    invalid_blocks: AtomicU64,
    retirement_backpressure: AtomicU64,
    observed_frame_sizes: [AtomicUsize; OBSERVED_FRAME_SIZE_CAPACITY],
    observed_frame_size_count: AtomicUsize,
    observed_frame_sizes_truncated: AtomicBool,
}

impl SharedObservation {
    fn new() -> Self {
        Self {
            host_failed: AtomicBool::new(false),
            playback_command: AtomicU64::new(0),
            acknowledged_command: AtomicU64::new(0),
            source_position: AtomicU64::new(0),
            pcm_position: AtomicU64::new(0),
            render_frame: AtomicU64::new(0),
            ended: AtomicBool::new(false),
            callback_count: AtomicU64::new(0),
            minimum_frames: AtomicUsize::new(usize::MAX),
            maximum_frames: AtomicUsize::new(0),
            deadline_overruns: AtomicU64::new(0),
            failure_code: AtomicU32::new(FailureCode::None as u32),
            starvation_callbacks: AtomicU64::new(0),
            stale_blocks: AtomicU64::new(0),
            invalid_blocks: AtomicU64::new(0),
            retirement_backpressure: AtomicU64::new(0),
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
            starvation_callbacks: self.starvation_callbacks.load(Ordering::Relaxed),
            stale_blocks: self.stale_blocks.load(Ordering::Relaxed),
            invalid_blocks: self.invalid_blocks.load(Ordering::Relaxed),
            retirement_backpressure: self.retirement_backpressure.load(Ordering::Relaxed),
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
    starvation_callbacks: u64,
    stale_blocks: u64,
    invalid_blocks: u64,
    retirement_backpressure: u64,
    observed_frame_sizes: Vec<usize>,
    observed_frame_sizes_truncated: bool,
}

struct NativeSource {
    ready: Consumer<OwnedPcmBlock>,
    retired: Producer<OwnedPcmBlock>,
}

impl PreparedBlockSource for NativeSource {
    type Block = OwnedPcmBlock;

    fn pop_ready(&mut self) -> Option<Self::Block> {
        self.ready.pop().ok()
    }

    fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block> {
        self.retired
            .push(block)
            .map_err(|PushError::Full(block)| block)
    }

    fn scan_limit(&self) -> usize {
        PCM_SLOT_COUNT
    }
}

struct WorkerControl {
    stop: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    backpressure: Arc<AtomicU64>,
    stalled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WorkerControl {
    fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WorkerControl {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_pcm_worker(layout: ChannelLayout) -> (NativeSource, WorkerControl) {
    spawn_worker(layout, None, 48_000)
}

fn spawn_worker(
    layout: ChannelLayout,
    mut wav_file: Option<(std::fs::File, crate::local_wav::LocalWav)>,
    output_rate: u32,
) -> (NativeSource, WorkerControl) {
    use std::io::{Read, Seek, SeekFrom};
    let (mut ready_producer, ready_consumer) = RingBuffer::new(PCM_SLOT_COUNT);
    let (retired_producer, mut retired_consumer) = RingBuffer::<OwnedPcmBlock>::new(PCM_SLOT_COUNT);
    let stop = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let backpressure = Arc::new(AtomicU64::new(0));
    let stalled = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let worker_stalled = Arc::clone(&stalled);
    let worker_failed = Arc::clone(&failed);
    let worker_stop = Arc::clone(&stop);
    let worker_ready = Arc::clone(&ready);
    let worker_backpressure = Arc::clone(&backpressure);
    let thread = std::thread::spawn(move || {
        let mut free: [Option<OwnedPcmBlock>; PCM_SLOT_COUNT] = std::array::from_fn(|slot| {
            Some(OwnedPcmBlock::new(slot as u32, layout, PCM_SLOT_FRAMES))
        });
        let mut next_frame = 0_u64;
        let mut exhausted = false;
        let mut bytes = [0_u8; PCM_SLOT_FRAMES * 6];
        let mut converter = match wav_file.as_ref() {
            Some((_, wav)) => match PreparedRateConverter::new(
                wav.sample_rate(),
                output_rate,
                layout.channels(),
                wav.total_frames(),
            ) {
                Ok(converter) => Some(converter),
                Err(_) => {
                    worker_failed.store(true, Ordering::Release);
                    return;
                }
            },
            None => None,
        };
        let total_frames = converter
            .as_ref()
            .map_or(u64::MAX, PreparedRateConverter::total_pcm_frames);
        while !worker_stop.load(Ordering::Acquire) {
            let mut made_progress = false;
            for free_slot in &mut free {
                if next_frame == total_frames || worker_stalled.load(Ordering::Acquire) {
                    break;
                }
                let Some(mut block) = free_slot.take() else {
                    continue;
                };
                block.meta = BlockMeta {
                    slot_id: block.meta.slot_id,
                    epoch: PROOF_EPOCH,
                    pcm_frame_start: next_frame,
                    valid_frames: (total_frames - next_frame).min(PCM_SLOT_FRAMES as u64) as usize,
                    discontinuity: next_frame == 0,
                    end_of_stream: total_frames - next_frame <= PCM_SLOT_FRAMES as u64,
                };
                if let (Some((file, wav)), Some(converter)) = (&mut wav_file, &mut converter) {
                    let mut written = 0;
                    while written < block.meta.valid_frames {
                        let needed = converter.input_frames_needed().min(PCM_SLOT_FRAMES);
                        if needed > 0 {
                            let length = needed * wav.block_align() as usize;
                            let offset = wav.data_offset()
                                + converter.source_frames_read() * u64::from(wav.block_align());
                            let decoded = file
                                .seek(SeekFrom::Start(offset))
                                .and_then(|_| file.read_exact(&mut bytes[..length]))
                                .ok()
                                .and_then(|_| wav.decode(&bytes[..length]).ok());
                            if decoded
                                .as_ref()
                                .is_none_or(|data| converter.push(data).is_err())
                            {
                                worker_failed.store(true, Ordering::Release);
                                return;
                            }
                        }
                        let copied = converter
                            .available_frames()
                            .min(block.meta.valid_frames - written);
                        block.left[written..written + copied]
                            .copy_from_slice(&converter.output(0)[..copied]);
                        if layout == ChannelLayout::Stereo {
                            block.right[written..written + copied]
                                .copy_from_slice(&converter.output(1)[..copied]);
                        }
                        if converter.consume(copied).is_err() {
                            worker_failed.store(true, Ordering::Release);
                            return;
                        }
                        written += copied;
                    }
                } else {
                    block.fill_deterministic();
                }
                let valid_frames = block.meta.valid_frames;
                match ready_producer.push(block) {
                    Ok(()) => {
                        next_frame = next_frame.saturating_add(valid_frames as u64);
                        made_progress = true;
                    }
                    Err(PushError::Full(block)) => {
                        *free_slot = Some(block);
                    }
                }
            }
            if free.iter().all(Option::is_none) || next_frame == total_frames {
                worker_ready.store(true, Ordering::Release);
            }
            match retired_consumer.pop() {
                Ok(block) => {
                    let slot_id = block.meta.slot_id as usize;
                    free[slot_id] = Some(block);
                    exhausted = false;
                    made_progress = true;
                }
                Err(PopError::Empty) => {
                    if !exhausted && free.iter().all(Option::is_none) {
                        worker_backpressure.fetch_add(1, Ordering::Relaxed);
                        exhausted = true;
                    }
                }
            }
            if !made_progress {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    });
    (
        NativeSource {
            ready: ready_consumer,
            retired: retired_producer,
        },
        WorkerControl {
            stop,
            ready,
            backpressure,
            stalled,
            failed,
            thread: Some(thread),
        },
    )
}

struct CallbackProcessor {
    input: PreparedPcmInput<NativeSource>,
    timeline: Option<PcmTimeline>,
    instance: RenderInstance,
    layout: ChannelLayout,
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
        maximum_frames: usize,
        source: NativeSource,
        shared: Arc<SharedObservation>,
    ) -> Result<Self, AdapterPrepareError> {
        let layout = match channels {
            1 => ChannelLayout::Mono,
            2 => ChannelLayout::Stereo,
            _ => return Err(AdapterPrepareError::Channels),
        };
        let input = PreparedPcmInput::new(
            StreamSpec {
                layout,
                sample_rate,
                source_id: PROOF_SOURCE_ID,
            },
            PROOF_EPOCH,
            maximum_frames,
            source,
        )
        .ok_or(AdapterPrepareError::Stream)?;
        let plan = CompiledPlan::pcm_proof(input.spec(), maximum_frames)
            .map_err(|_| AdapterPrepareError::Stream)?;
        let instance = RenderInstance::prepare(&plan);

        // Allocation and first writes happen before the processor enters a callback.
        let left = vec![0.0; maximum_frames].into_boxed_slice();
        let right = match layout {
            ChannelLayout::Mono => Box::default(),
            ChannelLayout::Stereo => vec![0.0; maximum_frames].into_boxed_slice(),
        };

        Ok(Self {
            input,
            timeline: None,
            instance,
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
        let command = self.shared.playback_command.load(Ordering::Acquire);
        if command & 1 != 0 {
            self.publish(started, frame_count, FailureCode::None);
            self.shared
                .acknowledged_command
                .store(command, Ordering::Release);
            return ProcessStatus::Rendered;
        }

        let render_status = match self.layout {
            ChannelLayout::Mono => {
                let Some(left) = self.left.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                self.instance
                    .render_pcm(&mut self.input, Output::Mono(left))
            }
            ChannelLayout::Stereo => {
                let Some(left) = self.left.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                let Some(right) = self.right.get_mut(..frame_count) else {
                    return self.finish_silent(FailureCode::CapacityExceeded, frame_count, started);
                };
                self.instance
                    .render_pcm(&mut self.input, Output::Stereo { left, right })
            }
        };

        if render_status != RenderStatus::Rendered {
            return self.finish_silent(FailureCode::Render, frame_count, started);
        }

        match self.layout {
            ChannelLayout::Mono => {
                for (destination, source) in output.iter_mut().zip(self.left.iter().copied()) {
                    *destination = T::from_sample(source);
                }
            }
            ChannelLayout::Stereo => {
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
        self.shared
            .acknowledged_command
            .store(command, Ordering::Release);
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
        self.shared.source_position.store(
            self.timeline
                .as_ref()
                .map_or(self.input.pcm_position(), |timeline| {
                    timeline.source_position(self.input.pcm_position())
                }),
            Ordering::Relaxed,
        );
        self.shared
            .pcm_position
            .store(self.input.pcm_position(), Ordering::Relaxed);
        self.shared
            .render_frame
            .store(self.instance.next_frame(), Ordering::Relaxed);
        self.shared
            .ended
            .store(self.input.ended(), Ordering::Relaxed);
        let counters = self.input.counters();
        self.shared
            .starvation_callbacks
            .store(counters.starvation_callbacks, Ordering::Relaxed);
        self.shared
            .stale_blocks
            .store(counters.stale_blocks, Ordering::Relaxed);
        self.shared
            .invalid_blocks
            .store(counters.invalid_blocks, Ordering::Relaxed);
        self.shared
            .retirement_backpressure
            .store(counters.retirement_backpressure, Ordering::Relaxed);
        if failure != FailureCode::None {
            self.shared
                .failure_code
                .store(failure as u32, Ordering::Relaxed);
        }
    }
}

fn validate_wav_host(
    wav: &crate::local_wav::LocalWav,
    rate: u32,
    channels: u16,
) -> Result<(), String> {
    if PcmTimeline::new(wav.sample_rate(), rate, wav.total_frames()).is_err()
        || wav.channels() != u32::from(channels)
    {
        return Err(format!(
            "source {} Hz / {} channels does not match active host {rate} Hz / {channels} channels; only same-rate or 44100 ↔ 48000 Hz conversion and exact channel match are supported",
            wav.sample_rate(),
            wav.channels()
        ));
    }
    Ok(())
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

    fn test_source(layout: ChannelLayout, block_frames: usize) -> NativeSource {
        let (mut ready_producer, ready) = RingBuffer::new(PCM_SLOT_COUNT);
        let (retired, _retired_consumer) = RingBuffer::<OwnedPcmBlock>::new(PCM_SLOT_COUNT);
        let mut pcm_frame = 0_u64;
        for slot_id in 0..PCM_SLOT_COUNT {
            let mut block = OwnedPcmBlock::new(slot_id as u32, layout, block_frames);
            block.meta = BlockMeta {
                slot_id: slot_id as u32,
                epoch: PROOF_EPOCH,
                pcm_frame_start: pcm_frame,
                valid_frames: block_frames,
                discontinuity: slot_id == 0,
                end_of_stream: slot_id + 1 == PCM_SLOT_COUNT,
            };
            block.fill_deterministic();
            assert!(ready_producer.push(block).is_ok());
            pcm_frame += block_frames as u64;
        }
        NativeSource { ready, retired }
    }

    fn prepared_processor(
        channels: usize,
        maximum_frames: usize,
    ) -> (CallbackProcessor, Arc<SharedObservation>) {
        let shared = Arc::new(SharedObservation::new());
        let layout = if channels == 2 {
            ChannelLayout::Stereo
        } else {
            ChannelLayout::Mono
        };
        let processor = CallbackProcessor::prepare(
            48_000,
            channels,
            maximum_frames,
            test_source(layout, maximum_frames.max(1)),
            Arc::clone(&shared),
        )
        .expect("valid test processor");
        (processor, shared)
    }

    fn assert_positive_zero(samples: &[f32]) {
        assert!(samples.iter().all(|sample| sample.to_bits() == 0));
    }

    #[test]
    fn native_worker_uses_fixed_slots_and_bounded_backpressure() {
        let (mut source, worker) = spawn_pcm_worker(ChannelLayout::Stereo);
        while !worker.ready.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
        while worker.backpressure.load(Ordering::Relaxed) == 0 {
            std::thread::yield_now();
        }
        assert_eq!(worker.backpressure.load(Ordering::Relaxed), 1);

        let mut blocks: [Option<OwnedPcmBlock>; PCM_SLOT_COUNT] = std::array::from_fn(|_| None);
        let mut addresses = [std::ptr::null(); PCM_SLOT_COUNT];
        for _ in 0..PCM_SLOT_COUNT {
            let block = source.pop_ready().expect("one block per fixed slot");
            let slot_id = block.meta.slot_id as usize;
            assert!(blocks[slot_id].is_none());
            addresses[slot_id] = block.left.as_ptr();
            blocks[slot_id] = Some(block);
        }
        assert!(source.pop_ready().is_none());
        let retired = blocks[0].take().expect("owned slot");
        let retired_id = retired.meta.slot_id as usize;
        assert!(source.retire(retired).is_ok());
        let recycled = loop {
            if let Some(block) = source.pop_ready() {
                break block;
            }
            std::thread::yield_now();
        };
        assert_eq!(recycled.meta.slot_id as usize, retired_id);
        assert_eq!(recycled.left.as_ptr(), addresses[retired_id]);
        assert_eq!(
            recycled.left[0],
            crate::prepared_pcm::deterministic_sample(recycled.meta.pcm_frame_start, 0)
        );
        worker.stop();
    }

    #[test]
    fn native_worker_pcm_runs_through_compiled_gain_and_observation() {
        for layout in [ChannelLayout::Mono, ChannelLayout::Stereo] {
            let (source, worker) = spawn_pcm_worker(layout);
            let ready_deadline = Instant::now() + Duration::from_secs(5);
            while !worker.ready.load(Ordering::Acquire) {
                assert!(
                    Instant::now() < ready_deadline,
                    "PCM worker readiness timed out"
                );
                std::thread::yield_now();
            }
            let mut processor = CallbackProcessor::prepare(
                48_000,
                layout.channels(),
                PROOF_MAXIMUM_FRAMES,
                source,
                Arc::new(SharedObservation::new()),
            )
            .unwrap();
            let mut start = 0;
            for frames in [17, 257, 1_024] {
                let mut output = vec![f32::NAN; frames * layout.channels()];
                assert_eq!(processor.process(&mut output), ProcessStatus::Rendered);
                for frame in 0..frames {
                    for channel in 0..layout.channels() {
                        assert_eq!(
                            output[frame * layout.channels() + channel],
                            crate::prepared_pcm::deterministic_sample(
                                (start + frame) as u64,
                                channel
                            ) * 0.5
                        );
                    }
                }
                start += frames;
            }
            assert_eq!(processor.instance.next_frame(), start as u64);
            let observation = processor.instance.take_observation().unwrap();
            assert_eq!((observation.start, observation.end), (1_216, 1_280));
            assert!(observation.peak > 0.0);
            assert_eq!(processor.input.counters().starvation_callbacks, 0);
            worker.stop();
        }
    }

    #[test]
    fn paused_start_records_callback_sizes_without_advancing_either_clock() {
        let (mut processor, shared) = prepared_processor(2, 128);
        shared.playback_command.store(1, Ordering::Release);
        let mut output = [1.0_f32; 256];
        assert_eq!(processor.process(&mut output), ProcessStatus::Rendered);
        assert_eq!(shared.acknowledged_command.load(Ordering::Acquire), 1);
        assert_positive_zero(&output);
        let snapshot = shared.snapshot();
        assert_eq!(snapshot.callback_count, 1);
        assert_eq!(snapshot.minimum_frames, 128);
        assert_eq!(snapshot.maximum_frames, 128);
        assert_eq!(snapshot.observed_frame_sizes, vec![128]);

        processor.process(&mut output[..34]);
        let snapshot = shared.snapshot();
        assert_eq!(snapshot.callback_count, 2);
        assert_eq!(snapshot.minimum_frames, 17);
        assert_eq!(snapshot.maximum_frames, 128);
        assert_eq!(snapshot.observed_frame_sizes, vec![128, 17]);
        assert_eq!(processor.instance.next_frame(), 0);
        assert_eq!(processor.input.pcm_position(), 0);
        assert_eq!(shared.render_frame.load(Ordering::Relaxed), 0);
        assert_eq!(shared.source_position.load(Ordering::Relaxed), 0);
        assert_eq!(snapshot.starvation_callbacks, 0);
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
            assert_eq!(frame[0], -frame[1]);
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
        for frame_count in 1..=10 {
            let mut output = vec![f32::NAN; frame_count * 2];
            assert_eq!(processor.process(&mut output), ProcessStatus::Rendered);
            assert!(output.iter().all(|sample| sample.is_finite()));
            for frame in output.as_chunks::<2>().0 {
                assert_eq!(frame[0], -frame[1]);
            }
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
        warm_valid.timeline = Some(PcmTimeline::new(44100, 48000, 100).unwrap());
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
        valid.timeline = Some(PcmTimeline::new(44100, 48000, 100).unwrap());
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
        valid.shared.playback_command.store(1, Ordering::Release);
        black_box(valid.process(black_box(&mut valid_output)));
        valid.shared.playback_command.store(2, Ordering::Release);
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
            CallbackProcessor::prepare(
                48_000,
                0,
                128,
                test_source(ChannelLayout::Mono, 128),
                Arc::clone(&shared)
            ),
            Err(AdapterPrepareError::Channels)
        ));
        assert!(matches!(
            CallbackProcessor::prepare(
                48_000,
                3,
                128,
                test_source(ChannelLayout::Mono, 128),
                shared
            ),
            Err(AdapterPrepareError::Channels)
        ));
    }

    fn wav_source(bits: u16, channels: u16, frames: usize) -> (NativeSource, WorkerControl) {
        wav_source_at_rates(bits, channels, frames, 48_000, 48_000)
    }

    fn wav_source_at_rates(
        bits: u16,
        channels: u16,
        frames: usize,
        source_rate: u32,
        output_rate: u32,
    ) -> (NativeSource, WorkerControl) {
        use std::io::Write;
        static FILE_ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "kkb-wav-test-{}-{}.wav",
            std::process::id(),
            FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        file.write_all(&crate::local_wav::tests::fixture(
            bits,
            channels,
            source_rate,
            frames,
        ))
        .unwrap();
        let wav = crate::local_wav::read_header(&mut file).unwrap();
        let result = spawn_worker(
            if channels == 1 {
                ChannelLayout::Mono
            } else {
                ChannelLayout::Stereo
            },
            Some((file, wav)),
            output_rate,
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !result.1.ready.load(Ordering::Acquire) {
            assert!(!result.1.failed.load(Ordering::Acquire));
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        result
    }

    #[test]
    fn local_wav_accepts_supported_conversion_and_rejects_layout_mismatch() {
        for channels in [1, 2] {
            for rate in [44_100, 48_000] {
                let bytes = crate::local_wav::tests::fixture(24, channels, rate, 17);
                let wav = crate::local_wav::tests::parse(&bytes).unwrap();
                assert!(validate_wav_host(&wav, rate, channels).is_ok());
                assert!(
                    validate_wav_host(&wav, if rate == 48_000 { 44_100 } else { 48_000 }, channels)
                        .is_ok()
                );
                for host_channels in [0, 1, 2, 3, 6] {
                    assert_eq!(
                        validate_wav_host(&wav, rate, host_channels).is_ok(),
                        host_channels == channels
                    );
                }
            }
        }
    }

    #[test]
    fn local_wav_worker_short_exact_partial_tails_pause_resume_and_consumed_eos() {
        for bits in [16, 24] {
            for channels in [1, 2] {
                for total in [1, 17, 1024, 1025, 4096, 5003] {
                    let (source, worker) = wav_source(bits, channels, total);
                    let shared = Arc::new(SharedObservation::new());
                    let mut processor = CallbackProcessor::prepare(
                        48_000,
                        channels as usize,
                        PROOF_MAXIMUM_FRAMES,
                        source,
                        Arc::clone(&shared),
                    )
                    .unwrap();
                    let mut position = 0;
                    let pattern = [1, 17, 257, 13, 1024];
                    let mut index = 0;
                    while position < total {
                        // Device-free host waits outside rendering for sufficient supply, then proves exact samples.
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while processor.input.source_mut().ready.slots() == 0
                            && processor.input.pcm_position().is_multiple_of(1024)
                        {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        let frames = pattern[index % pattern.len()]
                            .min(total - position)
                            .min(1024 - position % 1024);
                        let mut output = vec![f32::NAN; frames * channels as usize];
                        let clock = processor.instance.next_frame();
                        let command = (index as u64 + 1) * 2 + 1;
                        shared.playback_command.store(command, Ordering::Release);
                        assert_eq!(processor.process(&mut output), ProcessStatus::Rendered);
                        assert_eq!(shared.acknowledged_command.load(Ordering::Acquire), command);
                        assert_positive_zero(&output);
                        assert_eq!(processor.input.pcm_position(), position as u64);
                        assert_eq!(processor.instance.next_frame(), clock);
                        shared
                            .playback_command
                            .store(command + 1, Ordering::Release);
                        processor.process(&mut output);
                        for frame in 0..frames {
                            for channel in 0..channels as usize {
                                assert_eq!(
                                    output[frame * channels as usize + channel],
                                    crate::local_wav::tests::expected(
                                        position + frame,
                                        channel,
                                        bits
                                    ) * 0.5
                                );
                            }
                        }
                        position += frames;
                        index += 1;
                        assert_eq!(processor.input.pcm_position(), position as u64);
                        assert_eq!(processor.input.ended(), position == total);
                    }
                    let mut silence = [1.0_f32; 16];
                    for _ in 0..3 {
                        processor.process(&mut silence);
                        assert_positive_zero(&silence);
                    }
                    assert_eq!(processor.input.pcm_position(), total as u64);
                    assert!(processor.input.ended());
                    assert_eq!(processor.input.counters().starvation_callbacks, 0);
                    worker.stop();
                }
            }
        }
    }

    #[test]
    fn converted_wav_native_worker_samples_pause_starvation_and_media_cursor() {
        for (source_rate, output_rate) in [(44100, 48000), (48000, 44100)] {
            for bits in [16, 24] {
                for channels in [1, 2] {
                    for total in [1, 17, 1176, 1280, 1281, 10003] {
                        let input: Vec<Vec<f32>> = (0..channels as usize)
                            .map(|channel| {
                                (0..total)
                                    .map(|frame| {
                                        crate::local_wav::tests::expected(frame, channel, bits)
                                    })
                                    .collect()
                            })
                            .collect();
                        let expected = crate::sample_rate::tests::convert(
                            source_rate,
                            output_rate,
                            &input,
                            &[1, 17, 256],
                        );
                        let timeline =
                            PcmTimeline::new(source_rate, output_rate, total as u64).unwrap();
                        let (source, worker) =
                            wav_source_at_rates(bits, channels, total, source_rate, output_rate);
                        let shared = Arc::new(SharedObservation::new());
                        let mut processor = CallbackProcessor::prepare(
                            output_rate,
                            channels as usize,
                            PROOF_MAXIMUM_FRAMES,
                            source,
                            Arc::clone(&shared),
                        )
                        .unwrap();
                        processor.timeline = Some(timeline);
                        worker.stalled.store(true, Ordering::Release);
                        // Let already-started bounded worker production finish before the stall observation.
                        std::thread::sleep(Duration::from_millis(5));
                        let mut position = 0;
                        let mut turn = 0;
                        let mut stalled = false;
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while !processor.input.ended() {
                            assert!(Instant::now() < deadline);
                            let frames = [1, 17, 257, 1024, 13][turn % 5];
                            let mut output = vec![0.0_f32; frames * channels as usize];
                            let render_frame = processor.instance.next_frame();
                            shared.playback_command.store(1, Ordering::Release);
                            processor.process(&mut output);
                            assert_positive_zero(&output);
                            assert_eq!(processor.instance.next_frame(), render_frame);
                            assert_eq!(processor.input.pcm_position(), position as u64);
                            shared.playback_command.store(2, Ordering::Release);
                            processor.process(&mut output);
                            let next = processor.input.pcm_position() as usize;
                            for frame in 0..frames {
                                for channel in 0..channels as usize {
                                    assert_eq!(
                                        output[frame * channels as usize + channel],
                                        if frame < next - position {
                                            expected[channel][position + frame] * 0.5
                                        } else {
                                            0.0
                                        }
                                    );
                                }
                            }
                            assert_eq!(
                                shared.source_position.load(Ordering::Relaxed),
                                timeline.source_position(next as u64)
                            );
                            assert_eq!(shared.pcm_position.load(Ordering::Relaxed), next as u64);
                            if next == position && !processor.input.ended() {
                                stalled = true;
                                assert!(processor.instance.next_frame() > render_frame);
                                worker.stalled.store(false, Ordering::Release);
                                std::thread::sleep(Duration::from_millis(1));
                            }
                            position = next;
                            turn += 1;
                        }
                        assert_eq!(position, expected[0].len());
                        assert_eq!(shared.source_position.load(Ordering::Relaxed), total as u64);
                        if total == 10003 {
                            assert!(stalled);
                        }
                        let mut output = [1.0_f32; 34];
                        processor.process(&mut output);
                        assert_positive_zero(&output);
                        assert_eq!(processor.input.pcm_position(), position as u64);
                        worker.stop();
                    }
                }
            }
        }
    }

    #[test]
    fn local_wav_worker_starvation_freezes_media_not_render_clock_and_recovers() {
        let (source, worker) = wav_source(24, 2, 5000);
        worker.stalled.store(true, Ordering::Release);
        let shared = Arc::new(SharedObservation::new());
        let mut processor =
            CallbackProcessor::prepare(48_000, 2, PROOF_MAXIMUM_FRAMES, source, shared).unwrap();
        let mut first = [0.0_f32; 8192];
        processor.process(&mut first);
        assert_eq!(processor.input.pcm_position(), 4096);
        let mut silence = [1.0_f32; 34];
        processor.process(&mut silence);
        assert_positive_zero(&silence);
        assert_eq!(processor.input.pcm_position(), 4096);
        assert_eq!(processor.instance.next_frame(), 4113);
        assert_eq!(processor.input.counters().starvation_callbacks, 1);
        worker.stalled.store(false, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while processor.input.source_mut().ready.slots() == 0 {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut tail = [0.0_f32; 1808];
        processor.process(&mut tail);
        for frame in 0..904 {
            for channel in 0..2 {
                assert_eq!(
                    tail[frame * 2 + channel],
                    crate::local_wav::tests::expected(4096 + frame, channel, 24) * 0.5
                );
            }
        }
        assert_eq!(processor.input.pcm_position(), 5000);
        assert!(processor.input.ended());
        worker.stop();
    }

    #[test]
    #[ignore = "interactive local WAV proof: opens default output; explicit play emits sound"]
    fn local_wav_playback() -> Result<(), String> {
        use std::io::BufRead;
        let path = std::env::var("KKB_WAV").map_err(|_| "set KKB_WAV to a local WAV path")?;
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let wav = crate::local_wav::read_header(&mut file)?;
        let device = cpal::default_host()
            .default_output_device()
            .ok_or("no default output device")?;
        let mut supported = device.default_output_config().map_err(|e| e.to_string())?;
        // Explicit proof-only rate selection; ordinary playback retains the device default.
        if let Ok(rate) = std::env::var("KKB_OUTPUT_RATE") {
            let rate: u32 = rate.parse().map_err(|_| "invalid KKB_OUTPUT_RATE")?;
            if !matches!(rate, 44100 | 48000) {
                return Err("KKB_OUTPUT_RATE must be 44100 or 48000".into());
            }
            supported = device
                .supported_output_configs()
                .map_err(|e| e.to_string())?
                .filter(|config| {
                    config.channels() == supported.channels()
                        && config.sample_format() == supported.sample_format()
                })
                .find_map(|config| config.try_with_sample_rate(rate))
                .ok_or("requested output rate is not supported by the device")?;
        }
        validate_wav_host(&wav, supported.sample_rate(), supported.channels())?;
        let total = wav.total_frames();
        let source_rate = wav.sample_rate();
        let layout = if wav.channels() == 1 {
            ChannelLayout::Mono
        } else {
            ChannelLayout::Stereo
        };
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let timeline = PcmTimeline::new(wav.sample_rate(), supported.sample_rate(), total)
            .map_err(|_| "unsupported conversion")?;
        let (source, worker) = spawn_worker(layout, Some((file, wav)), supported.sample_rate());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !worker.ready.load(Ordering::Acquire) {
            if worker.failed.load(Ordering::Acquire) || Instant::now() > deadline {
                return Err("WAV worker preparation failed".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut processor = CallbackProcessor::prepare(
            supported.sample_rate(),
            layout.channels(),
            PROOF_MAXIMUM_FRAMES,
            source,
            Arc::clone(&shared),
        )
        .map_err(|e| format!("{e:?}"))?;
        processor.timeline = Some(timeline);
        let stream = build_stream_for_format(
            &device,
            supported.config(),
            supported.sample_format(),
            processor,
            Arc::clone(&shared),
        )?;
        stream.play().map_err(|e| e.to_string())?;
        println!(
            "device={} rate={} channels={} format={:?} sourceRate={source_rate} totalFrames={total} totalPcmFrames={}; prepared paused. Commands: play, pause, status, stall, feed, close. Play emits sound at compiled gain 0.5; lower system volume first.",
            device,
            supported.sample_rate(),
            supported.channels(),
            supported.sample_format(),
            timeline.total_pcm_frames()
        );
        for line in std::io::stdin().lock().lines() {
            match line.map_err(|e| e.to_string())?.trim() {
                action @ ("play" | "pause") => {
                    if action == "pause" || !shared.ended.load(Ordering::Relaxed) {
                        let command = ((shared.playback_command.load(Ordering::Relaxed) + 2) & !1)
                            | u64::from(action == "pause");
                        shared.playback_command.store(command, Ordering::Release);
                        let deadline = Instant::now() + Duration::from_secs(2);
                        while shared.acknowledged_command.load(Ordering::Acquire) != command {
                            if Instant::now() > deadline {
                                return Err("playback acknowledgment timed out".into());
                            }
                            std::thread::sleep(Duration::from_millis(1));
                        }
                    }
                }
                "stall" => worker.stalled.store(true, Ordering::Release),
                "feed" => worker.stalled.store(false, Ordering::Release),
                "close" => break,
                "status" => {}
                _ => println!("commands: play, pause, status, stall, feed, close"),
            }
            println!(
                "paused={} sourcePosition={}/{} pcmPosition={} renderFrame={} ended={} workerFailed={} observation={:?}",
                shared.acknowledged_command.load(Ordering::Acquire) & 1 != 0,
                shared.source_position.load(Ordering::Relaxed),
                total,
                shared.pcm_position.load(Ordering::Relaxed),
                shared.render_frame.load(Ordering::Relaxed),
                shared.ended.load(Ordering::Relaxed),
                worker.failed.load(Ordering::Acquire),
                shared.snapshot()
            );
            if worker.failed.load(Ordering::Acquire) || shared.host_failed.load(Ordering::Relaxed) {
                return Err("WAV playback failed".into());
            }
        }
        drop(stream);
        worker.stop();
        Ok(())
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
        let layout = if channels == 1 {
            ChannelLayout::Mono
        } else {
            ChannelLayout::Stereo
        };
        let (source, worker) = spawn_pcm_worker(layout);
        while !worker.ready.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
        let processor = CallbackProcessor::prepare(
            sample_rate,
            channels,
            PROOF_MAXIMUM_FRAMES,
            source,
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
        let worker_backpressure = worker.backpressure.load(Ordering::Relaxed);
        worker.stop();

        let snapshot = shared.snapshot();
        println!(
            "cpal_observation={{\"device\":{device_name:?},\"sample_rate\":{sample_rate},\"channels\":{channels},\"sample_format\":{sample_format:?},\"supported_buffer_size\":{supported_buffer_size:?},\"prepared_maximum_frames\":{PROOF_MAXIMUM_FRAMES},\"slot_count\":{PCM_SLOT_COUNT},\"slot_frames\":{PCM_SLOT_FRAMES},\"worker_backpressure\":{worker_backpressure},\"starvation_callbacks\":{},\"stale_blocks\":{},\"invalid_blocks\":{},\"retirement_backpressure\":{},\"duration_seconds\":{},\"callback_count\":{},\"observed_frame_sizes\":{:?},\"observed_frame_sizes_truncated\":{},\"minimum_frames\":{},\"maximum_frames\":{},\"processing_deadline_overruns\":{},\"host_failed\":{},\"failure_code\":{}}}",
            snapshot.starvation_callbacks,
            snapshot.stale_blocks,
            snapshot.invalid_blocks,
            snapshot.retirement_backpressure,
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
