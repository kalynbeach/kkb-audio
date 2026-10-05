use crate::compiled_plan::{CompiledPlan, RenderInstance};
use crate::media_loop::{LoopRegion, PreparedMediaLoop};
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

/// Largest f32 below 1.0; the top of CPAL's integer conversion range.
const INTEGER_OUTPUT_MAX: f32 = 1.0 - f32::EPSILON / 2.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
enum FailureCode {
    None = 0,
    Host = 1,
    InvalidChannels = 2,
    InvalidInterleavedLength = 3,
    CapacityExceeded = 4,
    Render = 5,
    OutputRange = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessStatus {
    Rendered,
    Silent(FailureCode),
}

struct SharedObservation {
    host_failed: AtomicBool,
    playback_command: AtomicU64,
    seek_command: AtomicU64,
    command_sequence: AtomicU64,
    next_epoch: AtomicU64,
    loop_bounds: AtomicU64,
    loop_effective_bounds: AtomicU64,
    loop_change: AtomicU32,
    loop_state: AtomicU32,
    loop_extension_frames: AtomicU64,
    loop_lost_frames: AtomicU64,
    loop_iteration: AtomicU64,
    loop_underruns: AtomicU64,
    loop_recovering: AtomicBool,
    loop_seam_frames: AtomicUsize,
    loop_first_iteration: AtomicU64,
    snapshot_sequence: AtomicU64,
    epoch: AtomicU64,
    seek_ready: AtomicBool,
    paused: AtomicBool,
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
            seek_command: AtomicU64::new(PROOF_EPOCH << 32),
            command_sequence: AtomicU64::new(0),
            next_epoch: AtomicU64::new(PROOF_EPOCH + 1),
            loop_bounds: AtomicU64::new(0),
            loop_effective_bounds: AtomicU64::new(0),
            loop_change: AtomicU32::new(0),
            loop_state: AtomicU32::new(0),
            loop_extension_frames: AtomicU64::new(0),
            loop_lost_frames: AtomicU64::new(0),
            loop_iteration: AtomicU64::new(0),
            loop_underruns: AtomicU64::new(0),
            loop_recovering: AtomicBool::new(false),
            loop_seam_frames: AtomicUsize::new(0),
            loop_first_iteration: AtomicU64::new(0),
            snapshot_sequence: AtomicU64::new(0),
            epoch: AtomicU64::new(PROOF_EPOCH),
            seek_ready: AtomicBool::new(false),
            paused: AtomicBool::new(false),
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

    /// Supported RIFF formats limit the source coordinate to u32; pack one coherent request.
    fn request_seek(&self, target: u64, timeline: PcmTimeline) -> Result<u64, u32> {
        timeline.seek_pcm_frame(target)?;
        let target = u32::try_from(target).map_err(|_| 71_u32)?;
        let bounds = self.loop_effective_bounds.load(Ordering::Acquire);
        let bounds = if bounds != 0
            && (u64::from(target) < bounds >> 32 || u64::from(target) >= u64::from(bounds as u32))
        {
            0
        } else {
            bounds
        };
        self.request_position(target, bounds, 0)
    }
    fn request_position(&self, target: u32, bounds: u64, loop_change: u32) -> Result<u64, u32> {
        self.command_sequence.fetch_add(1, Ordering::SeqCst);
        let epoch = self.next_epoch.fetch_add(1, Ordering::SeqCst);
        if epoch > u64::from(u32::MAX) {
            self.command_sequence.fetch_add(1, Ordering::SeqCst);
            return Err(71);
        }
        self.loop_bounds.store(bounds, Ordering::SeqCst);
        self.loop_change.store(loop_change, Ordering::SeqCst);
        self.seek_command
            .store((epoch << 32) | u64::from(target), Ordering::SeqCst);
        self.command_sequence.fetch_add(1, Ordering::SeqCst);
        Ok(epoch)
    }
    fn request_loop(
        &self,
        a: u64,
        b: u64,
        enabled: bool,
        timeline: PcmTimeline,
        output_rate: u32,
        supported: bool,
    ) -> Result<u64, u32> {
        if !supported || a >= b || b > u64::from(u32::MAX) {
            return Err(73);
        }
        LoopRegion::new(
            timeline.seek_pcm_frame(a)?,
            timeline.seek_pcm_frame(b)?,
            output_rate,
        )?;
        self.request_position(0, (a << 32) | b, 1 | (u32::from(enabled) << 1))
    }

    fn request_region(
        &self,
        a: u64,
        b: u64,
        timeline: PcmTimeline,
        output_rate: u32,
        supported: bool,
    ) -> Result<Option<u64>, u32> {
        if !supported || a >= b || b > u64::from(u32::MAX) {
            return Err(73);
        }
        LoopRegion::new(
            timeline.seek_pcm_frame(a)?,
            timeline.seek_pcm_frame(b)?,
            output_rate,
        )?;
        let snapshot = self.playback_snapshot();
        let pending = self.seek_command.load(Ordering::SeqCst) >> 32 > snapshot.epoch;
        let change = self.loop_change.load(Ordering::SeqCst);
        let enabled = if pending {
            if change != 0 {
                change & 2 != 0
            } else {
                self.loop_bounds.load(Ordering::SeqCst) != 0
            }
        } else {
            snapshot.loop_enabled
        };
        if !enabled {
            return Ok(None);
        }
        // Before an enable is acknowledged, editing its bounds is still enable intent.
        let flags = if pending && change == 3 { 3 } else { 7 };
        self.request_position(0, (a << 32) | b, flags).map(Some)
    }

    // Control-side retries only. Callback publication is fixed stores, never a retry loop.
    fn playback_snapshot(&self) -> PlaybackSnapshot {
        loop {
            let before = self.snapshot_sequence.load(Ordering::SeqCst);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let snapshot = PlaybackSnapshot {
                loop_enabled: self.loop_effective_bounds.load(Ordering::SeqCst) != 0,
                loop_state: self.loop_state.load(Ordering::SeqCst),
                loop_extension_frames: self.loop_extension_frames.load(Ordering::SeqCst),
                loop_lost_frames: self.loop_lost_frames.load(Ordering::SeqCst),
                loop_iteration: self.loop_iteration.load(Ordering::SeqCst),
                loop_underruns: self.loop_underruns.load(Ordering::SeqCst),
                loop_recovering: self.loop_recovering.load(Ordering::SeqCst),
                loop_seam_frames: self.loop_seam_frames.load(Ordering::SeqCst),
                loop_first_iteration: self.loop_first_iteration.load(Ordering::SeqCst),
                epoch: self.epoch.load(Ordering::SeqCst),
                source_position: self.source_position.load(Ordering::SeqCst),
                pcm_position: self.pcm_position.load(Ordering::SeqCst),
                render_frame: self.render_frame.load(Ordering::SeqCst),
                ended: self.ended.load(Ordering::SeqCst),
                ready: self.seek_ready.load(Ordering::SeqCst),
                paused: self.paused.load(Ordering::SeqCst),
                presentation_time: None,
            };
            if before == self.snapshot_sequence.load(Ordering::SeqCst) {
                return snapshot;
            }
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

#[derive(Debug, PartialEq, Eq)]
struct PlaybackSnapshot {
    loop_enabled: bool,
    /// Disabled / Preparing / Armed / Active / Failed = 0 / 1 / 2 / 3 / 4.
    loop_state: u32,
    loop_extension_frames: u64,
    loop_lost_frames: u64,
    loop_iteration: u64,
    loop_underruns: u64,
    loop_recovering: bool,
    loop_seam_frames: usize,
    loop_first_iteration: u64,
    epoch: u64,
    source_position: u64,
    pcm_position: u64,
    render_frame: u64,
    ended: bool,
    ready: bool,
    paused: bool,
    presentation_time: Option<u64>,
}

struct NativeSource {
    failed: Arc<AtomicBool>,
    seek: Arc<AtomicU64>,
    command_sequence: Arc<AtomicU64>,
    loop_bounds: Arc<AtomicU64>,
    pcm_target: Arc<AtomicU64>,
    head: Arc<[AtomicU32; 2]>,
    ready_epoch: Arc<AtomicU64>,
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
    decoded_packets: Arc<AtomicU64>,
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

struct NativePcmPreparation {
    linear: PreparedRateConverter,
    loop_pcm: Option<PreparedMediaLoop>,
    start_pending: Option<u64>,
    read_revision: u64,
}
impl NativePcmPreparation {
    fn new(sr: u32, ro: u32, channels: usize, total: u64) -> Result<Self, u32> {
        Ok(Self {
            linear: PreparedRateConverter::new(sr, ro, channels, total)?,
            loop_pcm: None,
            start_pending: None,
            read_revision: 0,
        })
    }
    fn total_pcm_frames(&self) -> u64 {
        if self.loop_pcm.is_some() {
            u64::MAX
        } else {
            self.linear.total_pcm_frames()
        }
    }
    fn source_frames_read(&self) -> u64 {
        self.loop_pcm.as_ref().map_or_else(
            || self.linear.source_frames_read(),
            PreparedMediaLoop::source_frames_read,
        )
    }
    fn input_frames_needed(&self) -> usize {
        self.loop_pcm.as_ref().map_or_else(
            || self.linear.input_frames_needed(),
            PreparedMediaLoop::input_frames_needed,
        )
    }
    fn available_frames(&self) -> usize {
        self.loop_pcm.as_ref().map_or_else(
            || self.linear.available_frames(),
            PreparedMediaLoop::available_frames,
        )
    }
    fn output(&self, channel: usize) -> &[f32] {
        self.loop_pcm
            .as_ref()
            .map_or_else(|| self.linear.output(channel), |l| l.output(channel))
    }
    fn consume(&mut self, n: usize) -> Result<(), u32> {
        match &mut self.loop_pcm {
            Some(l) => l.consume(n),
            None => self.linear.consume(n),
        }
    }
    fn push(&mut self, pcm: &[f32]) -> Result<(), u32> {
        if let Some(l) = &mut self.loop_pcm {
            l.push(pcm)
        } else {
            self.linear.push(pcm)
        }
    }
    // Consuming the final conversion chunk can expose drain frames without a push.
    fn prepare_head(&mut self) -> Result<(), u32> {
        if let Some(l) = &mut self.loop_pcm
            && let Some(start) = self.start_pending
        {
            l.prepare_head()?;
            if l.head_ready() {
                l.start(start)?;
                self.start_pending = None;
            }
        }
        Ok(())
    }
    fn reader_anchor(&mut self) -> Option<u64> {
        let l = self.loop_pcm.as_ref()?;
        if l.read_revision() == self.read_revision {
            return None;
        }
        self.read_revision = l.read_revision();
        Some(l.source_frames_read())
    }
}

fn spawn_pcm_worker(layout: ChannelLayout) -> (NativeSource, WorkerControl) {
    spawn_worker(layout, None, 48_000)
}

fn spawn_worker(
    layout: ChannelLayout,
    mut wav_file: Option<(std::fs::File, crate::local_media::LocalMedia)>,
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
    let seek = Arc::new(AtomicU64::new(PROOF_EPOCH << 32));
    let ready_epoch = Arc::new(AtomicU64::new(0));
    let command_sequence = Arc::new(AtomicU64::new(0));
    let loop_bounds = Arc::new(AtomicU64::new(0));
    let pcm_target = Arc::new(AtomicU64::new(0));
    let worker_pcm_target = Arc::clone(&pcm_target);
    let head = Arc::new([AtomicU32::new(0), AtomicU32::new(0)]);
    let worker_sequence = Arc::clone(&command_sequence);
    let worker_bounds = Arc::clone(&loop_bounds);
    let worker_head = Arc::clone(&head);
    let decoded_packets = Arc::new(AtomicU64::new(0));
    let worker_decoded_packets = Arc::clone(&decoded_packets);
    let worker_seek = Arc::clone(&seek);
    let worker_ready_epoch = Arc::clone(&ready_epoch);
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
        let mut bytes = [0_u8; PCM_SLOT_FRAMES * 8];
        let mut converter = match wav_file.as_ref() {
            Some((_, wav)) => match NativePcmPreparation::new(
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
        let mut total_frames = converter
            .as_ref()
            .map_or(u64::MAX, NativePcmPreparation::total_pcm_frames);
        let mut active_seek = PROOF_EPOCH << 32;
        let mut admitted = 0;
        'worker: while !worker_stop.load(Ordering::Acquire) {
            let sequence = worker_sequence.load(Ordering::SeqCst);
            let requested = worker_seek.load(Ordering::SeqCst);
            let bounds = worker_bounds.load(Ordering::SeqCst);
            let pcm_target = worker_pcm_target.load(Ordering::SeqCst);
            if sequence & 1 != 0 || sequence != worker_sequence.load(Ordering::SeqCst) {
                continue;
            }
            if requested != active_seek {
                active_seek = requested;
                admitted = 0;
                worker_ready.store(false, Ordering::Release);
                if let Some(converter) = &mut converter {
                    match converter.linear.seek_output_frame(pcm_target) {
                        Ok(pcm) => {
                            next_frame = pcm;
                            converter.loop_pcm = if bounds == 0 {
                                None
                            } else {
                                let Some((_, media)) = &wav_file else {
                                    worker_failed.store(true, Ordering::Release);
                                    return;
                                };
                                match PreparedMediaLoop::new(
                                    media.sample_rate(),
                                    output_rate,
                                    layout.channels(),
                                    media.total_frames(),
                                    bounds >> 32,
                                    u64::from(bounds as u32),
                                ) {
                                    Ok(l) => Some(l),
                                    Err(_) => {
                                        worker_failed.store(true, Ordering::Release);
                                        return;
                                    }
                                }
                            };
                            converter.start_pending = converter.loop_pcm.as_ref().map(|_| pcm);
                            converter.read_revision = 0;
                            total_frames = converter.total_pcm_frames();
                            if let Some((file, media)) = &mut wav_file {
                                media.cancel_loop_anchor();
                                if let Some(anchor) = converter
                                    .loop_pcm
                                    .as_ref()
                                    .and_then(PreparedMediaLoop::continuation_source_frame)
                                {
                                    if media.prepare_loop_anchor(anchor).is_err() {
                                        worker_failed.store(true, Ordering::Release);
                                        return;
                                    }
                                    let started = std::time::Instant::now();
                                    while !media.loop_anchor_ready(anchor) {
                                        if worker_seek.load(Ordering::Acquire) != active_seek
                                            || worker_stop.load(Ordering::Acquire)
                                        {
                                            media.cancel_loop_anchor();
                                            continue 'worker;
                                        }
                                        let n = media.length();
                                        if n == 0
                                            || started.elapsed().as_secs() >= 30
                                            || file
                                                .seek(SeekFrom::Start(media.offset()))
                                                .and_then(|_| file.read_exact(&mut bytes[..n]))
                                                .is_err()
                                        {
                                            worker_failed.store(true, Ordering::Release);
                                            return;
                                        }
                                        if worker_seek.load(Ordering::Acquire) != active_seek
                                            || worker_stop.load(Ordering::Acquire)
                                        {
                                            media.cancel_loop_anchor();
                                            continue 'worker;
                                        }
                                        if media.accept(&bytes[..n]).is_err() {
                                            worker_failed.store(true, Ordering::Release);
                                            return;
                                        }
                                    }
                                } else {
                                    media.clear_loop_anchor();
                                }
                                if media.seek_loop(converter.source_frames_read()).is_err() {
                                    worker_failed.store(true, Ordering::Release);
                                    return;
                                }
                            }
                        }
                        Err(_) => {
                            worker_failed.store(true, Ordering::Release);
                            return;
                        }
                    }
                }
            }
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
                    epoch: active_seek >> 32,
                    pcm_frame_start: converter.as_ref().and_then(|c| c.loop_pcm.as_ref()).map_or(
                        next_frame,
                        |l| {
                            LoopRegion::new(l.pcm_a(), l.pcm_b(), output_rate)
                                .expect("prepared region")
                                .position(next_frame)
                        },
                    ),
                    valid_frames: (total_frames - next_frame).min(PCM_SLOT_FRAMES as u64) as usize,
                    discontinuity: admitted == 0,
                    end_of_stream: total_frames - next_frame <= PCM_SLOT_FRAMES as u64,
                };
                if let (Some((file, wav)), Some(converter)) = (&mut wav_file, &mut converter) {
                    let mut written = 0;
                    while written < block.meta.valid_frames {
                        if worker_seek.load(Ordering::Acquire) != active_seek
                            || worker_stop.load(Ordering::Acquire)
                        {
                            break;
                        }
                        if let Some(anchor) = converter.reader_anchor()
                            && wav.seek_loop(anchor).is_err()
                        {
                            worker_failed.store(true, Ordering::Release);
                            return;
                        }
                        let needed = converter.input_frames_needed().min(PCM_SLOT_FRAMES);
                        if needed > 0 {
                            let reconstruction_started = std::time::Instant::now();
                            if wav.request(needed).is_err() {
                                worker_failed.store(true, Ordering::Release);
                                return;
                            }
                            while wav.available_frames() == 0 {
                                if worker_seek.load(Ordering::Acquire) != active_seek
                                    || worker_stop.load(Ordering::Acquire)
                                {
                                    break;
                                }
                                if wav.anchor_and_discard()
                                    && reconstruction_started.elapsed().as_secs() >= 30
                                {
                                    worker_failed.store(true, Ordering::Release);
                                    return;
                                }
                                let length = wav.length();
                                if length == 0
                                    || file
                                        .seek(SeekFrom::Start(wav.offset()))
                                        .and_then(|_| file.read_exact(&mut bytes[..length]))
                                        .is_err()
                                    || wav.accept(&bytes[..length]).is_err()
                                {
                                    worker_failed.store(true, Ordering::Release);
                                    return;
                                }
                                if wav.anchor_and_discard() && length > 4 {
                                    worker_decoded_packets.fetch_add(1, Ordering::Release);
                                }
                            }
                            if worker_seek.load(Ordering::Acquire) != active_seek
                                || worker_stop.load(Ordering::Acquire)
                            {
                                break;
                            }
                            let decoded = wav.take(needed);
                            if decoded.as_ref().is_err()
                                || decoded
                                    .as_ref()
                                    .is_ok_and(|data| converter.push(data).is_err())
                            {
                                worker_failed.store(true, Ordering::Release);
                                return;
                            }
                        }
                        if converter.prepare_head().is_err() {
                            worker_failed.store(true, Ordering::Release);
                            return;
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
                if worker_seek.load(Ordering::Acquire) != active_seek
                    || worker_stop.load(Ordering::Acquire)
                {
                    *free_slot = Some(block);
                    break;
                }
                let valid_frames = block.meta.valid_frames;
                match ready_producer.push(block) {
                    Ok(()) => {
                        next_frame = next_frame.saturating_add(valid_frames as u64);
                        admitted += 1;
                        made_progress = true;
                    }
                    Err(PushError::Full(block)) => {
                        *free_slot = Some(block);
                    }
                }
            }
            if admitted >= PCM_SLOT_COUNT || next_frame == total_frames {
                if let Some(l) = converter.as_ref().and_then(|c| c.loop_pcm.as_ref()) {
                    for channel in 0..2 {
                        worker_head[channel]
                            .store(l.head_sample(channel).to_bits(), Ordering::Release);
                    }
                }
                worker_ready_epoch.store(active_seek >> 32, Ordering::Release);
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
            seek,
            command_sequence,
            loop_bounds,
            pcm_target,
            head,
            failed: Arc::clone(&failed),
            ready_epoch,
            ready: ready_consumer,
            retired: retired_producer,
        },
        WorkerControl {
            decoded_packets,
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
    paused: bool,
    loop_bounds: u64,
    configure_loop_pending: bool,
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
            paused: false,
            loop_bounds: 0,
            configure_loop_pending: false,
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
        T: SizedSample + FromSample<f32>,
    {
        let started = Instant::now();
        output.fill(T::EQUILIBRIUM);
        self.callback_count = self.callback_count.saturating_add(1);

        if self.input.source_mut().failed.load(Ordering::Acquire) {
            return self.finish_silent(FailureCode::Render, 0, started);
        }
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
        let mut command = self.shared.playback_command.load(Ordering::Acquire);
        self.paused = command & 1 != 0;
        let sequence = self.shared.command_sequence.load(Ordering::SeqCst);
        let seek = self.shared.seek_command.load(Ordering::SeqCst);
        let bounds = self.shared.loop_bounds.load(Ordering::SeqCst);
        let change = self.shared.loop_change.load(Ordering::SeqCst);
        let stable =
            sequence & 1 == 0 && sequence == self.shared.command_sequence.load(Ordering::SeqCst);
        if stable
            && seek >> 32 > self.input.active_epoch()
            && let Some(timeline) = self.timeline
        {
            let Ok(mut pcm) = timeline.seek_pcm_frame(u64::from(seek as u32)) else {
                return self.finish_silent(FailureCode::Render, frame_count, started);
            };
            self.loop_bounds = bounds;
            let mut region = if bounds == 0 {
                None
            } else {
                match LoopRegion::new(
                    timeline.seek_pcm_frame(bounds >> 32).unwrap_or(0),
                    timeline
                        .seek_pcm_frame(u64::from(bounds as u32))
                        .unwrap_or(0),
                    self.sample_rate,
                ) {
                    Ok(r) => Some(r),
                    Err(_) => return self.finish_silent(FailureCode::Render, frame_count, started),
                }
            };
            if change != 0
                && let Some(r) = region
            {
                let cursor = self.input.pcm_position();
                let inside = cursor >= r.a && cursor < r.b;
                let enabled = change & 2 != 0;
                let edit = change & 4 != 0;
                pcm = if enabled && !edit && !inside {
                    r.a
                } else {
                    cursor
                };
                if !enabled || (edit && !inside) {
                    region = None;
                    self.loop_bounds = 0;
                }
            }
            if change != 0 && region.is_some() && self.input.ended() {
                // Capture EOS with PCM, before begin_seek clears it. One bounded CAS;
                // a newer explicit transport command is left for the next callback.
                let paused_command = command | 1;
                let _ = self.shared.playback_command.compare_exchange(
                    command,
                    paused_command,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                command = paused_command;
                self.paused = true;
            }
            self.input
                .begin_seek(seek >> 32, pcm, pcm == timeline.total_pcm_frames());
            self.input.configure_loop(region, [0.0; 2]);
            self.configure_loop_pending = true;
            self.instance.clear_source_observations();
            self.publish_worker_request(seek, pcm);
        } else if stable
            && self.input.loop_needs_recovery()
            && let Some(timeline) = self.timeline
        {
            let epoch = self.shared.next_epoch.fetch_add(1, Ordering::SeqCst);
            if epoch > u64::from(u32::MAX) {
                return self.finish_silent(FailureCode::Render, frame_count, started);
            }
            if sequence == self.shared.command_sequence.load(Ordering::SeqCst) {
                let target = self.loop_bounds >> 32;
                if timeline.seek_pcm_frame(target).is_err() {
                    return self.finish_silent(FailureCode::Render, frame_count, started);
                }
                self.input.begin_loop_recovery(epoch);
                self.instance.clear_source_observations();
                self.publish_worker_request(
                    (epoch << 32) | target,
                    timeline
                        .seek_pcm_frame(target)
                        .expect("validated loop start"),
                );
            }
        }
        self.input.reclaim_stale();
        if self.input.preparing()
            && self.input.source_mut().ready_epoch.load(Ordering::Acquire)
                == self.input.active_epoch()
        {
            if self.configure_loop_pending {
                let head = std::array::from_fn(|c| {
                    f32::from_bits(self.input.source_mut().head[c].load(Ordering::Acquire))
                });
                let region = if self.loop_bounds == 0 {
                    None
                } else {
                    let t = self.timeline.expect("local timeline");
                    Some(
                        LoopRegion::new(
                            t.seek_pcm_frame(self.loop_bounds >> 32)
                                .expect("validated A"),
                            t.seek_pcm_frame(u64::from(self.loop_bounds as u32))
                                .expect("validated B"),
                            self.sample_rate,
                        )
                        .expect("validated loop"),
                    )
                };
                self.input.configure_loop(region, head);
                self.configure_loop_pending = false;
            }
            self.input.finish_seek();
        }
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

        // Nonfinite output is an engine fault. Reject the whole callback.
        let nonfinite = |sample: &f32| !sample.is_finite();
        if self.left[..frame_count].iter().any(nonfinite)
            || (self.layout == ChannelLayout::Stereo
                && self.right[..frame_count].iter().any(nonfinite))
        {
            return self.finish_silent(FailureCode::OutputRange, frame_count, started);
        }
        // CPAL's float-to-integer conversion requires [-1, 1) and wraps 24-bit
        // values outside it. Integer output clips there, like browser output.
        let clip = !T::FORMAT.is_float();
        let convert = |sample: f32| {
            T::from_sample(if clip {
                sample.clamp(-1.0, INTEGER_OUTPUT_MAX)
            } else {
                sample
            })
        };

        match self.layout {
            ChannelLayout::Mono => {
                for (destination, source) in output.iter_mut().zip(self.left.iter().copied()) {
                    *destination = convert(source);
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
                    *destination = convert(source);
                }
            }
        }

        self.publish(started, frame_count, FailureCode::None);
        self.shared
            .acknowledged_command
            .store(command, Ordering::Release);
        ProcessStatus::Rendered
    }

    fn publish_worker_request(&mut self, seek: u64, pcm: u64) {
        let source = self.input.source_mut();
        source.command_sequence.fetch_add(1, Ordering::SeqCst);
        source.loop_bounds.store(self.loop_bounds, Ordering::SeqCst);
        source.pcm_target.store(pcm, Ordering::SeqCst);
        source.seek.store(seek, Ordering::SeqCst);
        source.command_sequence.fetch_add(1, Ordering::SeqCst);
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
        self.shared.snapshot_sequence.fetch_add(1, Ordering::SeqCst);
        self.shared
            .epoch
            .store(self.input.active_epoch(), Ordering::SeqCst);
        let ready = failure == FailureCode::None
            && !self.input.preparing()
            && self.input.source_mut().ready_epoch.load(Ordering::Acquire)
                == self.input.active_epoch();
        let loop_state = if self.loop_bounds == 0 {
            0
        } else if failure != FailureCode::None || self.input.loop_recovering() {
            4
        } else if !ready {
            1
        } else if self.paused {
            2
        } else {
            3
        };
        self.shared.loop_state.store(loop_state, Ordering::SeqCst);
        self.shared
            .loop_effective_bounds
            .store(self.loop_bounds, Ordering::SeqCst);
        self.shared
            .loop_extension_frames
            .store(self.input.loop_extension_frames(), Ordering::SeqCst);
        self.shared
            .loop_lost_frames
            .store(self.input.loop_lost_frames(), Ordering::SeqCst);
        self.shared
            .loop_iteration
            .store(self.input.loop_iteration(), Ordering::SeqCst);
        self.shared
            .loop_underruns
            .store(self.input.loop_underruns(), Ordering::SeqCst);
        self.shared
            .loop_recovering
            .store(self.input.loop_recovering(), Ordering::SeqCst);
        self.shared
            .loop_seam_frames
            .store(self.input.seam_frames(), Ordering::SeqCst);
        self.shared
            .loop_first_iteration
            .store(self.input.callback_first_iteration(), Ordering::SeqCst);
        self.shared.seek_ready.store(ready, Ordering::SeqCst);
        self.shared.paused.store(self.paused, Ordering::SeqCst);
        self.shared.source_position.store(
            self.timeline
                .as_ref()
                .map_or(self.input.pcm_position(), |timeline| {
                    timeline.source_position(self.input.pcm_position())
                }),
            Ordering::SeqCst,
        );
        self.shared
            .pcm_position
            .store(self.input.pcm_position(), Ordering::SeqCst);
        self.shared
            .render_frame
            .store(self.instance.next_frame(), Ordering::SeqCst);
        self.shared
            .ended
            .store(self.input.ended(), Ordering::SeqCst);
        self.shared.snapshot_sequence.fetch_add(1, Ordering::SeqCst);
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
    wav: &crate::local_media::LocalMedia,
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
        NativeSource {
            failed: Arc::new(AtomicBool::new(false)),
            command_sequence: Arc::new(AtomicU64::new(0)),
            loop_bounds: Arc::new(AtomicU64::new(0)),
            pcm_target: Arc::new(AtomicU64::new(0)),
            head: Arc::new([AtomicU32::new(0), AtomicU32::new(0)]),
            ready,
            retired,
            seek: Arc::new(AtomicU64::new(PROOF_EPOCH << 32)),
            ready_epoch: Arc::new(AtomicU64::new(PROOF_EPOCH)),
        }
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
    fn native_output_preserves_float_extremes_and_clips_integer_overload() {
        let prepare = |sample: f32| {
            let mut source = test_source(ChannelLayout::Stereo, 2);
            let mut block = source.pop_ready().unwrap();
            block.left[..2].copy_from_slice(&[0.25, sample]);
            block.right[..2].copy_from_slice(&[-0.25, -sample]);
            let (mut producer, consumer) = RingBuffer::new(1);
            assert!(producer.push(block).is_ok());
            source.ready = consumer;
            CallbackProcessor::prepare(48000, 2, 2, source, Arc::new(SharedObservation::new()))
                .unwrap()
        };
        let mut float = prepare(f32::MAX);
        let mut output = [0.0_f32; 4];
        assert_eq!(float.process(&mut output), ProcessStatus::Rendered);
        assert_eq!(output, [0.125, -0.125, f32::MAX * 0.5, -f32::MAX * 0.5]);
        for (sample, high, low) in [(2.0, i16::MAX, i16::MIN), (-2.5, i16::MIN, i16::MAX)] {
            let mut integer = prepare(sample);
            let mut output = [123_i16; 4];
            assert_eq!(integer.process(&mut output), ProcessStatus::Rendered);
            assert_eq!(output, [4096, -4096, high, low]);
            assert_eq!(integer.shared.snapshot().failure_code, 0);
        }
        let mut unsigned = prepare(f32::MAX);
        let mut output = [123_u16; 4];
        assert_eq!(unsigned.process(&mut output), ProcessStatus::Rendered);
        assert_eq!(output, [36864, 28672, u16::MAX, 0]);
        let mut i24 = prepare(f32::MAX);
        let mut output = [cpal::I24::new_unchecked(0); 4];
        assert_eq!(i24.process(&mut output), ProcessStatus::Rendered);
        assert_eq!(
            output.map(|sample| sample.inner()),
            [1_048_576, -1_048_576, 8_388_607, -8_388_608]
        );
        let mut nonfinite = prepare(f32::NAN);
        let mut output = [123_i16; 4];
        assert_eq!(
            nonfinite.process(&mut output),
            ProcessStatus::Silent(FailureCode::OutputRange)
        );
        assert_eq!(output, [0; 4]);
        assert_eq!(nonfinite.shared.snapshot().failure_code, 6);
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
        let (mut looping, _) = prepared_processor(2, 8);
        let loop_timeline = PcmTimeline::new(48000, 48000, 100).unwrap();
        looping.timeline = Some(loop_timeline);
        let mut loop_output = [0.0; 8];
        let mut valid_output = [f32::NAN; 8];
        let mut malformed_output = [1.0; 3];
        let mut oversized = [1.0; 3];
        let mut host_output = [1.0; 2];
        let mut truncated_output = [f32::NAN; 18];
        host_shared.record_host_failure();

        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(true));
        looping
            .shared
            .request_loop(0, 32, true, loop_timeline, 48000, true)
            .unwrap();
        black_box(looping.process(&mut loop_output)); // Acknowledgment-time loop change, reclaim.
        looping
            .input
            .source_mut()
            .ready_epoch
            .store(2, Ordering::Release);
        black_box(looping.process(&mut loop_output)); // Arm, then deliberately underrun.
        black_box(looping.process(&mut loop_output)); // Fresh-epoch recovery publication.
        looping
            .input
            .source_mut()
            .ready_epoch
            .store(3, Ordering::Release);
        black_box(looping.process(&mut loop_output));
        let epoch = looping.input.active_epoch();
        looping.input.begin_seek(epoch, 100, true);
        looping.input.finish_seek();
        looping
            .shared
            .request_loop(0, 32, true, loop_timeline, 48000, true)
            .unwrap();
        black_box(looping.process(&mut loop_output)); // EOS acknowledgment's bounded pause CAS.
        black_box(valid.process(black_box(&mut valid_output)));
        valid.shared.playback_command.store(1, Ordering::Release);
        valid
            .shared
            .seek_command
            .store((2 << 32) | 17, Ordering::Release);
        black_box(valid.process(black_box(&mut valid_output)));
        valid.shared.playback_command.store(2, Ordering::Release);
        valid
            .input
            .source_mut()
            .ready_epoch
            .store(2, Ordering::Release);
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
        let wav = crate::local_media::read_header(&mut file).unwrap();
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
                let mut wav =
                    crate::local_media::LocalMedia::new(bytes.len() as u64, false).unwrap();
                while wav.length() != 0 {
                    let offset = wav.offset() as usize;
                    wav.accept(&bytes[offset..offset + wav.length()]).unwrap();
                }
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
        for bits in [16, 24, 32] {
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
            for bits in [16, 24, 32] {
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
    fn media_loop_native_region_command_respects_disabled_and_pending_intent() {
        let (source, worker) = wav_source_at_rates(24, 2, 10003, 48000, 48000);
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let timeline = PcmTimeline::new(48000, 48000, 10003).unwrap();
        let mut p =
            CallbackProcessor::prepare(48000, 2, 1024, source, Arc::clone(&shared)).unwrap();
        p.timeline = Some(timeline);
        let wait = |p: &mut CallbackProcessor, epoch: u64| {
            let deadline = Instant::now() + Duration::from_secs(2);
            while p.input.active_epoch() != epoch || p.input.preparing() {
                p.process(&mut [0f32; 34]);
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        };
        let off = shared
            .request_loop(0, 10003, false, timeline, 48000, true)
            .unwrap();
        wait(&mut p, off);
        let edit = shared
            .request_region(0, 9000, timeline, 48000, true)
            .unwrap();
        if let Some(epoch) = edit {
            wait(&mut p, epoch);
        }
        assert_eq!(
            shared.playback_snapshot().loop_state,
            0,
            "including edit after acknowledged off must stay off"
        );
        let on = shared
            .request_loop(0, 9000, true, timeline, 48000, true)
            .unwrap();
        wait(&mut p, on);
        let off = shared
            .request_loop(0, 9000, false, timeline, 48000, true)
            .unwrap();
        assert_eq!(
            shared
                .request_region(0, 8000, timeline, 48000, true)
                .unwrap(),
            None
        );
        wait(&mut p, off);
        assert_eq!(shared.playback_snapshot().loop_state, 0);
        shared
            .request_loop(1000, 9000, true, timeline, 48000, true)
            .unwrap();
        let edit = shared
            .request_region(2000, 8000, timeline, 48000, true)
            .unwrap()
            .unwrap();
        wait(&mut p, edit);
        assert_eq!(p.input.pcm_position(), 2000);
        assert_eq!(shared.playback_snapshot().loop_state, 2);
        let excluded = shared
            .request_region(3000, 7000, timeline, 48000, true)
            .unwrap()
            .unwrap();
        wait(&mut p, excluded);
        assert_eq!(p.input.pcm_position(), 2000);
        assert_eq!(shared.playback_snapshot().loop_state, 0);
        assert_eq!(
            shared
                .request_region(1000, 9000, timeline, 48000, true)
                .unwrap(),
            None
        );
        assert!(
            shared
                .request_region(0, 9000, timeline, 48000, false)
                .is_err()
        );
        worker.stop();
    }

    #[test]
    fn media_loop_native_eof_drain_head_matches_reference_and_remains_cancellable() {
        for (sr, ro) in [(44100, 48000), (48000, 44100)] {
            let total = 10003;
            let timeline = PcmTimeline::new(sr, ro, total as u64).unwrap();
            let a = timeline.seek_pcm_frame(9000).unwrap();
            let b = timeline.seek_pcm_frame(total as u64).unwrap();
            let fade = ((ro / 200) as usize).min((b - a) as usize / 4);
            let original: Vec<Vec<f32>> = (0..2)
                .map(|ch| {
                    (0..total)
                        .map(|f| crate::local_wav::tests::expected(f, ch, 24))
                        .collect()
                })
                .collect();
            let reference = crate::sample_rate::tests::convert(sr, ro, &original, &[73, 311]);
            let (source, worker) = wav_source_at_rates(24, 2, total, sr, ro);
            let shared = Arc::new(SharedObservation::new());
            shared.playback_command.store(1, Ordering::Release);
            let mut p =
                CallbackProcessor::prepare(ro, 2, 1024, source, Arc::clone(&shared)).unwrap();
            p.timeline = Some(timeline);
            let epoch = shared
                .request_loop(9000, 10003, true, timeline, ro, true)
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while p.input.active_epoch() != epoch || p.input.preparing() {
                p.process(&mut [0f32; 34]);
                assert!(!worker.failed.load(Ordering::Acquire));
                assert!(
                    Instant::now() < deadline,
                    "EOF loop head did not become ready {sr}->{ro}; WorkerControl drop cancels the worker"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(p.input.pcm_position(), a);
            shared.playback_command.store(0, Ordering::Release);
            let mut consumed = 0;
            while consumed < 2 * (b - a) + 7 {
                let count = (2 * (b - a) + 7 - consumed).min(511) as usize;
                let mut out = vec![0f32; count * 2];
                p.process(&mut out);
                assert!(!p.input.loop_recovering());
                for j in 0..count {
                    for ch in 0..2 {
                        let at = a + (consumed + j as u64) % (b - a);
                        let raw = reference[ch][at as usize];
                        let expected = if at < b - fade as u64 {
                            raw
                        } else if at == b - 1 {
                            reference[ch][a as usize]
                        } else {
                            let w = (at - (b - fade as u64)) as f32 / (fade - 1) as f32;
                            (1.0 - w) * raw + w * reference[ch][a as usize]
                        };
                        assert_eq!(out[j * 2 + ch], expected * 0.5);
                    }
                }
                consumed += count as u64;
                std::thread::sleep(Duration::from_millis(1));
            }
            worker.stop();
        }
    }

    #[test]
    fn media_loop_native_acknowledged_eos_pauses_before_head_consumption() {
        let (source, worker) = wav_source_at_rates(24, 2, 17, 48000, 48000);
        let shared = Arc::new(SharedObservation::new());
        let timeline = PcmTimeline::new(48000, 48000, 17).unwrap();
        let mut p =
            CallbackProcessor::prepare(48000, 2, 1024, source, Arc::clone(&shared)).unwrap();
        p.timeline = Some(timeline);
        p.process(&mut [0f32; 34]);
        assert!(p.input.ended());
        shared.ended.store(false, Ordering::Release); // Deliberately stale control observation.
        let clock = p.instance.next_frame();
        let epoch = shared
            .request_loop(0, 16, true, timeline, 48000, true)
            .unwrap();
        let mut out = [1f32; 34];
        p.process(&mut out);
        assert!(
            shared.playback_snapshot().paused,
            "EOS must be captured at acknowledgment"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while p.input.preparing() {
            p.process(&mut out);
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(p.input.active_epoch(), epoch);
        assert_eq!(p.input.pcm_position(), 0);
        assert_eq!(p.instance.next_frame(), clock);
        assert_positive_zero(&out);
        assert_eq!(shared.playback_snapshot().loop_state, 2);
        shared.playback_command.store(2, Ordering::Release);
        p.process(&mut out);
        assert_eq!(p.instance.next_frame(), clock + 17);
        assert!(!shared.playback_snapshot().paused);
        worker.stop();
    }

    #[test]
    fn media_loop_native_terminal_read_failure_and_close_before_head_readiness() {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("kkb-loop-read-failure-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        file.write_all(&crate::local_wav::tests::fixture(24, 2, 44100, 10003))
            .unwrap();
        let media = crate::local_media::read_header(&mut file).unwrap();
        let fault = file.try_clone().unwrap();
        let (source, worker) = spawn_worker(ChannelLayout::Stereo, Some((file, media)), 48000);
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let timeline = PcmTimeline::new(44100, 48000, 10003).unwrap();
        let mut p =
            CallbackProcessor::prepare(48000, 2, 1024, source, Arc::clone(&shared)).unwrap();
        p.timeline = Some(timeline);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !worker.ready.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        fault.set_len(0).unwrap();
        shared
            .request_loop(9000, 10003, true, timeline, 48000, true)
            .unwrap();
        let mut out = [1f32; 34];
        let deadline = Instant::now() + Duration::from_secs(3);
        while !worker.failed.load(Ordering::Acquire) {
            p.process(&mut out);
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            p.process(&mut out),
            ProcessStatus::Silent(FailureCode::Render)
        );
        assert_positive_zero(&out);
        assert_eq!(shared.playback_snapshot().loop_state, 4);
        assert!(!shared.playback_snapshot().ready);
        assert_eq!(p.input.loop_underruns(), 0);
        worker.stop();
        let (source, worker) = wav_source_at_rates(24, 2, 10003, 44100, 48000);
        worker.stalled.store(true, Ordering::Release);
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let timeline = PcmTimeline::new(44100, 48000, 10003).unwrap();
        let mut p =
            CallbackProcessor::prepare(48000, 2, 1024, source, Arc::clone(&shared)).unwrap();
        p.timeline = Some(timeline);
        shared
            .request_loop(9000, 10003, true, timeline, 48000, true)
            .unwrap();
        p.process(&mut out);
        assert!(p.input.preparing());
        assert_eq!(p.input.loop_underruns(), 0);
        assert_eq!(shared.playback_snapshot().loop_state, 1);
        worker.stop();
    }

    #[test]
    fn media_loop_native_worker_rings_callback_reference_controls_and_underrun() {
        let mut cases = vec![
            (48000, 48000, None),
            (44100, 48000, None),
            (48000, 44100, None),
        ];
        for name in [
            "cbr-44100-1",
            "cbr-44100-2",
            "cbr-48000-1",
            "cbr-48000-2",
            "vbr-44100-1",
            "vbr-44100-2",
            "vbr-48000-1",
            "vbr-48000-2",
            "crc",
            "vbri",
            "loop-crc-44100-1",
            "loop-crc-44100-2",
            "loop-crc-48000-1",
            "loop-crc-48000-2",
            "loop-dual-48000-2",
        ] {
            for ro in [44100, 48000] {
                let (sr, _) = crate::local_mp3::tests::planar_fixture(name);
                cases.push((sr, ro, Some(name)));
            }
        }
        for (sr, ro, name) in cases {
            let mp3 = name.map(crate::local_mp3::tests::planar_fixture);
            let total = mp3.as_ref().map_or(10003, |(_, p)| p[0].len());
            let late = total as u64 - 5000;
            let end = late + (4097 * u64::from(sr)).div_ceil(u64::from(ro));
            let regions = if name.is_none() {
                [(7001, 7018), (137, 9503)] // Retain both original WAV control/reference cases.
            } else {
                [(137, 154), (late, end)]
            };
            for (a, b) in regions {
                let input: Vec<Vec<f32>> = (0..2)
                    .map(|ch| {
                        (0..total)
                            .map(|f| crate::local_wav::tests::expected(f, ch, 24))
                            .collect()
                    })
                    .collect();
                let input = mp3.as_ref().map_or(input, |(_, p)| {
                    if p.len() == 1 {
                        vec![p[0].clone(), p[0].clone()]
                    } else {
                        p.clone()
                    }
                });
                let reference = crate::sample_rate::tests::convert(sr, ro, &input, &[73, 311]);
                let timeline = PcmTimeline::new(sr, ro, total as u64).unwrap();
                let r = LoopRegion::new(
                    (a * u64::from(ro)).div_ceil(u64::from(sr)),
                    (b * u64::from(ro)).div_ceil(u64::from(sr)),
                    ro,
                )
                .unwrap();
                let channels = mp3.as_ref().map_or(2, |(_, p)| p.len());
                let (source, worker) = if let Some(name) = name {
                    let mut file =
                        std::fs::File::open(format!("tools/fixtures/mp3/{name}.mp3")).unwrap();
                    let media = crate::local_media::read_header(&mut file).unwrap();
                    spawn_worker(
                        if channels == 1 {
                            ChannelLayout::Mono
                        } else {
                            ChannelLayout::Stereo
                        },
                        Some((file, media)),
                        ro,
                    )
                } else {
                    wav_source_at_rates(24, 2, total, sr, ro)
                };
                let shared = Arc::new(SharedObservation::new());
                shared.playback_command.store(1, Ordering::Release);
                let mut p =
                    CallbackProcessor::prepare(ro, channels, 4096, source, Arc::clone(&shared))
                        .unwrap();
                p.timeline = Some(timeline);
                let mut small = vec![0.0f32; 17 * channels];
                let epoch = shared.request_loop(a, b, true, timeline, ro, true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while p.input.active_epoch() != epoch || p.input.preparing() {
                    p.process(&mut small);
                    assert!(!worker.failed.load(Ordering::Acquire));
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert_eq!(p.instance.next_frame(), 0);
                assert_eq!(p.input.pcm_position(), r.a);
                shared.playback_command.store(0, Ordering::Release);
                let mut consumed = 0u64;
                for count in [1, 17, 257, 1024, 3, 997, 37, 1024, 1023].repeat(4) {
                    // Device-free pacing gives the real bounded worker time to return slots.
                    std::thread::sleep(Duration::from_millis(15));
                    let mut out = vec![0.0; count * channels];
                    p.process(&mut out);
                    assert!(!p.input.loop_recovering());
                    for f in 0..count {
                        let at = r.a + (consumed + f as u64) % r.period();
                        for ch in 0..channels {
                            let raw = reference[ch][at as usize];
                            let expected = if at < r.b - r.fade as u64 {
                                raw
                            } else {
                                let j = (at - (r.b - r.fade as u64)) as usize;
                                if j == r.fade - 1 {
                                    reference[ch][r.a as usize]
                                } else {
                                    let w = j as f32 / (r.fade - 1) as f32;
                                    (1.0 - w) * raw + w * reference[ch][r.a as usize]
                                }
                            };
                            assert_eq!(
                                out[f * channels + ch],
                                expected * 0.5,
                                "{sr}->{ro} frame{at}"
                            );
                        }
                    }
                    consumed += count as u64;
                    assert_eq!(p.input.pcm_position(), r.a + consumed % r.period());
                    assert_eq!(p.input.loop_iteration(), (consumed - 1) / r.period());
                }
                let clock = p.instance.next_frame();
                let cursor = p.input.pcm_position();
                shared.playback_command.store(1, Ordering::Release);
                p.process(&mut small);
                assert_eq!(p.instance.next_frame(), clock);
                assert_eq!(p.input.pcm_position(), cursor);
                shared.playback_command.store(0, Ordering::Release);
                worker.stalled.store(true, Ordering::Release);
                for _ in 0..12 {
                    p.process(&mut vec![0f32; 1024 * channels]);
                    if p.input.loop_recovering() {
                        break;
                    }
                }
                assert!(p.input.loop_recovering());
                let held = p.input.pcm_position();
                for _ in 0..4 {
                    p.process(&mut vec![0f32; 1024 * channels]);
                    assert_eq!(p.input.pcm_position(), held);
                }
                let before = p.instance.next_frame();
                worker.stalled.store(false, Ordering::Release);
                let deadline = Instant::now() + Duration::from_secs(3);
                while p.input.loop_recovering() {
                    p.process(&mut small);
                    assert!(Instant::now() < deadline);
                    assert!(!worker.failed.load(Ordering::Acquire));
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert!(p.instance.next_frame() > before);
                assert_eq!(p.input.loop_underruns(), 1);
                assert!(p.input.active_epoch() > epoch);
                assert!(!p.input.ended());
                if sr < ro {
                    for _ in 0..20 {
                        let pcm = p.input.pcm_position();
                        if timeline
                            .seek_pcm_frame(timeline.source_position(pcm))
                            .unwrap()
                            != pcm
                        {
                            break;
                        }
                        p.process(&mut vec![0f32; channels]);
                    }
                    let pcm = p.input.pcm_position();
                    assert_ne!(
                        timeline
                            .seek_pcm_frame(timeline.source_position(pcm))
                            .unwrap(),
                        pcm
                    );
                }
                // Disable at the acknowledged cursor, not a stale source snapshot or B.
                shared.playback_command.store(1, Ordering::Release);
                p.process(&mut small);
                let exact_pcm_cursor = p.input.pcm_position();
                let disabled = shared
                    .request_loop(a, b, false, timeline, ro, true)
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while p.input.active_epoch() != disabled || p.input.preparing() {
                    p.process(&mut small);
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert_eq!(p.input.pcm_position(), exact_pcm_cursor);
                // An edit can exclude the acknowledgment-time cursor; never relocate it.
                let edited = shared
                    .request_position(0, (4000u64 << 32) | 5000, 7)
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while p.input.active_epoch() != edited || p.input.preparing() {
                    p.process(&mut small);
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert_eq!(p.input.pcm_position(), exact_pcm_cursor);
                assert_eq!(shared.playback_snapshot().loop_state, 0);
                assert!(
                    shared
                        .request_loop(a, b, true, timeline, ro, false)
                        .is_err()
                );
                worker.stop();
            }
        }
    }

    #[test]
    fn mp3_late_over_head_native_worker_has_bounded_normal_replenishment() {
        use std::io::{Read, Seek, SeekFrom};
        let fixture = std::fs::read("tools/fixtures/mp3/cbr-48000-2.mp3").unwrap();
        let mut bytes = Vec::with_capacity(25000 * 384);
        for _ in 0..25000 {
            bytes.extend_from_slice(&fixture[384..768]);
        }
        let path =
            std::env::temp_dir().join(format!("kkb-mp3-loop-bound-{}.mp3", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        let mut reader = crate::local_media::read_header(&mut file).unwrap();
        let total = reader.total_frames();
        let ro = 44100;
        let sr = 48000;
        let a = total - 6000;
        let b = a + (4097 * u64::from(sr)).div_ceil(u64::from(ro));
        let pa = (a * u64::from(ro)).div_ceil(u64::from(sr));
        let pb = (b * u64::from(ro)).div_ceil(u64::from(sr));
        let mut converter = PreparedRateConverter::new(sr, ro, 2, total).unwrap();
        let mut reference = [Vec::new(), Vec::new()];
        let mut position = 0;
        // Uninterrupted oracle from zero, retain only the independent realized region.
        while position < pb {
            let n = converter.input_frames_needed().min(73);
            if n > 0 {
                reader.request(n).unwrap();
                while reader.available_frames() == 0 {
                    let at = reader.offset() as usize;
                    reader.accept(&bytes[at..at + reader.length()]).unwrap();
                }
                converter.push(&reader.take(n).unwrap()).unwrap();
            }
            let n = converter.available_frames().min(97);
            for (ch, out) in reference.iter_mut().enumerate() {
                for j in 0..n {
                    let at = position + j as u64;
                    if at >= pa && at < pb {
                        out.push(converter.output(ch)[j]);
                    }
                }
            }
            converter.consume(n).unwrap();
            position += n as u64;
        }
        reader.seek(0).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut magic = [0; 4];
        file.read_exact(&mut magic).unwrap();
        let (source, worker) = spawn_worker(ChannelLayout::Stereo, Some((file, reader)), ro);
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let timeline = PcmTimeline::new(sr, ro, total).unwrap();
        let mut p = CallbackProcessor::prepare(ro, 2, 1024, source, Arc::clone(&shared)).unwrap();
        p.timeline = Some(timeline);
        let epoch = shared.request_loop(a, b, true, timeline, ro, true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while p.input.active_epoch() != epoch || p.input.preparing() {
            p.process(&mut [0.; 34]);
            assert!(!worker.failed.load(Ordering::Acquire));
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let initial = worker.decoded_packets.load(Ordering::Acquire);
        shared.playback_command.store(0, Ordering::Release);
        let period = pb - pa;
        let fade = (ro / 200) as usize;
        let mut consumed = 0;
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(15));
            let mut out = [0.; 2048];
            p.process(&mut out);
            assert!(!p.input.loop_recovering());
            for j in 0..1024 {
                let at = (consumed + j) % period as usize;
                for ch in 0..2 {
                    let x = reference[ch][at];
                    let y = if at < period as usize - fade {
                        x
                    } else {
                        let f = at - (period as usize - fade);
                        if f == fade - 1 {
                            reference[ch][0]
                        } else {
                            let w = f as f32 / (fade - 1) as f32;
                            (1. - w) * x + w * reference[ch][0]
                        }
                    };
                    assert_eq!(out[j * 2 + ch], y * 0.5);
                }
            }
            consumed += 1024;
        }
        let packets = worker.decoded_packets.load(Ordering::Acquire) - initial;
        assert!(
            packets < 100,
            "normal replenishment replayed {packets} source packets"
        );
        assert_eq!(p.input.loop_underruns(), 0);
        assert_eq!(p.input.active_epoch(), epoch);
        assert!(p.input.loop_iteration() >= 4);
        worker.stop();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn wav_seek_lifecycle_preserves_instance_clock_and_reclaims_paused_slots() {
        for (source_rate, output_rate, bits, channels) in [
            (44100, 48000, 24, 2),
            (48000, 44100, 16, 1),
            (48000, 48000, 24, 2),
            (44100, 48000, 32, 2),
            (48000, 44100, 32, 1),
            (48000, 48000, 32, 2),
        ] {
            for total in [1_usize, 17, 10003] {
                let input: Vec<Vec<f32>> = (0..channels as usize)
                    .map(|ch| {
                        (0..total)
                            .map(|frame| crate::local_wav::tests::expected(frame, ch, bits))
                            .collect()
                    })
                    .collect();
                let reference = crate::sample_rate::tests::convert(
                    source_rate,
                    output_rate,
                    &input,
                    &[17, 239],
                );
                let timeline = PcmTimeline::new(source_rate, output_rate, total as u64).unwrap();
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
                let mut small = vec![0.0_f32; 17 * channels as usize];
                processor.process(&mut small); // Retain a partial block on long fixtures.
                for target in [total / 2, 0, total - 1, total, 1, 0] {
                    let before = processor.instance.next_frame();
                    shared.playback_command.store(1, Ordering::Release);
                    shared.request_seek(total as u64, timeline).unwrap();
                    let epoch = shared.request_seek(target as u64, timeline).unwrap(); // Latest wins without a queue.
                    let start = timeline.seek_pcm_frame(target as u64).unwrap();
                    let deadline = Instant::now() + Duration::from_secs(2);
                    loop {
                        processor.process(&mut small);
                        assert_positive_zero(&small);
                        let snapshot = shared.playback_snapshot();
                        assert_eq!(snapshot.epoch, epoch);
                        assert_eq!(snapshot.render_frame, before);
                        assert_eq!(snapshot.pcm_position, start);
                        assert!(snapshot.paused);
                        assert_eq!(snapshot.presentation_time, None);
                        if snapshot.ready {
                            break;
                        }
                        assert!(Instant::now() < deadline, "paused readiness deadlock");
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    shared.playback_command.store(2, Ordering::Release);
                    let mut position = start as usize;
                    let mut turn = 0;
                    while !processor.input.ended() {
                        let frames = [1, 17, 257, 1024][turn % 4];
                        let mut output = vec![0.0_f32; frames * channels as usize];
                        processor.process(&mut output);
                        let next = processor.input.pcm_position() as usize;
                        for frame in 0..frames {
                            for ch in 0..channels as usize {
                                assert_eq!(
                                    output[frame * channels as usize + ch],
                                    if frame < next - position {
                                        reference[ch][position + frame] * 0.5
                                    } else {
                                        0.0
                                    }
                                );
                            }
                        }
                        if next == position {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        position = next;
                        turn += 1;
                        assert!(Instant::now() < deadline);
                    }
                    assert_eq!(position, reference[0].len());
                    assert_eq!(shared.playback_snapshot().source_position, total as u64);
                    assert_eq!(processor.input.counters().invalid_blocks, 0);
                    assert_eq!(processor.input.counters().retirement_backpressure, 0);
                }
                assert!(shared.request_seek(total as u64 + 1, timeline).is_err());
                // Preparation while playing emits silence and advances this same clock.
                worker.stalled.store(true, Ordering::Release);
                shared.request_seek(0, timeline).unwrap();
                let before = processor.instance.next_frame();
                processor.process(&mut small);
                assert_positive_zero(&small);
                assert_eq!(processor.instance.next_frame(), before + 17);
                // Close during preparation joins the bounded worker; no device was opened.
                worker.stop();
            }
        }
    }

    #[test]
    fn mp3_native_worker_rings_callback_seek_eos_replay_and_stop() {
        for name in [
            "cbr-44100-1",
            "vbr-44100-2",
            "cbr-48000-2",
            "vbr-48000-1",
            "crc",
            "vbri",
            "short",
        ] {
            let (rate, input) = crate::local_mp3::tests::planar_fixture(name);
            for output_rate in [44100, 48000] {
                let channels = input.len();
                let total = input[0].len() as u64;
                let reference =
                    crate::sample_rate::tests::convert(rate, output_rate, &input, &[17, 239]);
                let timeline = PcmTimeline::new(rate, output_rate, total).unwrap();
                let mut file =
                    std::fs::File::open(format!("tools/fixtures/mp3/{name}.mp3")).unwrap();
                let media = crate::local_media::read_header(&mut file).unwrap();
                assert!(media.anchor_and_discard());
                let (source, worker) = spawn_worker(
                    if channels == 1 {
                        ChannelLayout::Mono
                    } else {
                        ChannelLayout::Stereo
                    },
                    Some((file, media)),
                    output_rate,
                );
                let shared = Arc::new(SharedObservation::new());
                let mut processor = CallbackProcessor::prepare(
                    output_rate,
                    channels,
                    PROOF_MAXIMUM_FRAMES,
                    source,
                    Arc::clone(&shared),
                )
                .unwrap();
                processor.timeline = Some(timeline);
                let mut small = vec![0f32; 17 * channels];
                for target in [0, total / 2, 1152.min(total), total - 1, total, 1, 0] {
                    shared.playback_command.store(1, Ordering::Release);
                    shared.request_seek(total, timeline).unwrap();
                    let epoch = shared.request_seek(target, timeline).unwrap();
                    let start = timeline.seek_pcm_frame(target).unwrap();
                    let clock = processor.instance.next_frame();
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        processor.process(&mut small);
                        assert_positive_zero(&small);
                        let snapshot = shared.playback_snapshot();
                        assert_eq!(snapshot.epoch, epoch);
                        assert_eq!(snapshot.render_frame, clock);
                        if snapshot.ready {
                            break;
                        }
                        assert!(!worker.failed.load(Ordering::Acquire));
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    shared.playback_command.store(2, Ordering::Release);
                    let mut position = start as usize;
                    while !processor.input.ended() {
                        let mut output = vec![0f32; 257 * channels];
                        processor.process(&mut output);
                        let next = processor.input.pcm_position() as usize;
                        for f in 0..257 {
                            for c in 0..channels {
                                assert_eq!(
                                    output[f * channels + c],
                                    if f < next - position {
                                        reference[c][position + f] * 0.5
                                    } else {
                                        0.0
                                    },
                                    "{name} target {target} position {position}"
                                );
                            }
                        }
                        if next == position {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        position = next;
                        assert!(Instant::now() < deadline);
                    }
                    assert_eq!(position, reference[0].len());
                    assert_eq!(shared.playback_snapshot().source_position, total);
                }
                shared.request_seek(total / 2, timeline).unwrap();
                processor.process(&mut small);
                worker.stop();
            }
        }
        let mut file = std::fs::File::open("tools/fixtures/mp3/crc.mp3").unwrap();
        let calls = std::cell::Cell::new(0);
        let error = crate::local_media::read_header_cancellable(&mut file, || {
            calls.set(calls.get() + 1);
            calls.get() > 8
        })
        .err()
        .unwrap();
        assert!(error.contains("cancelled"));
        assert_eq!(calls.get(), 9);
    }

    #[test]
    fn mp3_native_reconstruction_observes_supersession_and_stop_between_packets() {
        let fixture = std::fs::read("tools/fixtures/mp3/cbr-48000-2.mp3").unwrap();
        let mut bytes = Vec::with_capacity(384 * 10000);
        for _ in 0..10000 {
            bytes.extend_from_slice(&fixture[384..768]);
        }
        let path = std::env::temp_dir().join(format!("kkb-mp3-cancel-{}.mp3", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        let media = crate::local_media::read_header(&mut file).unwrap();
        let total = media.total_frames();
        let timeline = PcmTimeline::new(48000, 48000, total).unwrap();
        let (source, worker) = spawn_worker(ChannelLayout::Stereo, Some((file, media)), 48000);
        let shared = Arc::new(SharedObservation::new());
        shared.playback_command.store(1, Ordering::Release);
        let mut processor =
            CallbackProcessor::prepare(48000, 2, PROOF_MAXIMUM_FRAMES, source, Arc::clone(&shared))
                .unwrap();
        processor.timeline = Some(timeline);
        let mut output = [0f32; 34];
        let deadline = Instant::now() + Duration::from_secs(5);
        while !worker.ready.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        for stop in [false, true] {
            let before = worker.decoded_packets.load(Ordering::Acquire);
            shared.request_seek(total - 1000, timeline).unwrap();
            while worker.decoded_packets.load(Ordering::Acquire) < before + 64 {
                processor.process(&mut output);
                assert_positive_zero(&output);
                assert!(Instant::now() < deadline);
                assert!(!worker.failed.load(Ordering::Acquire));
                std::thread::sleep(Duration::from_millis(1));
            }
            // Actual reconstruction has decoded at least 64 packets, not just queued a command.
            if stop {
                break;
            }
            let epoch = shared.request_seek(0, timeline).unwrap();
            loop {
                processor.process(&mut output);
                assert_positive_zero(&output);
                if shared.playback_snapshot().ready && shared.playback_snapshot().epoch == epoch {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(shared.playback_snapshot().source_position, 0);
        }
        let stopped = Instant::now();
        worker.stop();
        assert!(stopped.elapsed() < Duration::from_secs(1));
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
        let wav = crate::local_media::read_header(&mut file)?;
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
        let anchor_and_discard = wav.anchor_and_discard();
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
            "device={} rate={} channels={} format={:?} sourceRate={source_rate} totalFrames={total} totalPcmFrames={}; prepared paused. Commands: play, pause, seek FRAME, status, stall, feed, close. Play emits sound at compiled gain 0.5; lower system volume first.",
            device,
            supported.sample_rate(),
            supported.channels(),
            supported.sample_format(),
            timeline.total_pcm_frames()
        );
        let mut region = (0, total);
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
                action if action.starts_with("seek ") => {
                    let target = action[5..].trim().parse::<u64>();
                    if let Ok(target) = target
                        && let Ok(epoch) = shared.request_seek(target, timeline)
                    {
                        let pcm = timeline
                            .seek_pcm_frame(target)
                            .map_err(|_| "invalid seek")?;
                        let actual = timeline.source_position(pcm);
                        let result =
                            if !anchor_and_discard && source_rate == supported.sample_rate() {
                                "Exact"
                            } else if actual == target {
                                "AnchorAndDiscard"
                            } else {
                                "Adjusted"
                            };
                        println!(
                            "seek requested epoch={epoch} target={target} pcmFrame={pcm} actualMediaFrame={actual} result={result}; completion is snapshot ready=true for this epoch"
                        );
                    } else {
                        println!("invalid source-frame target");
                    }
                }
                action @ ("loop on" | "loop off") => {
                    match shared.request_loop(
                        region.0,
                        region.1,
                        action == "loop on",
                        timeline,
                        supported.sample_rate(),
                        true,
                    ) {
                        Ok(epoch) => println!(
                            "loop request epoch={epoch}; source [{},{}), output [{},{}); fixed realized period, quantization accumulates",
                            region.0,
                            region.1,
                            timeline.seek_pcm_frame(region.0).unwrap(),
                            timeline.seek_pcm_frame(region.1).unwrap()
                        ),
                        Err(_) => println!("unsupported media loop interval"),
                    }
                }
                action if action.starts_with("region ") => {
                    let values = action[7..]
                        .split_whitespace()
                        .map(str::parse::<u64>)
                        .collect::<Result<Vec<_>, _>>();
                    if let Ok(values) = values
                        && values.len() == 2
                        && values[0] < values[1]
                        && timeline.seek_pcm_frame(values[1]).is_ok()
                        && LoopRegion::new(
                            timeline.seek_pcm_frame(values[0]).unwrap(),
                            timeline.seek_pcm_frame(values[1]).unwrap(),
                            supported.sample_rate(),
                        )
                        .is_ok()
                    {
                        region = (values[0], values[1]);
                        let _ = shared.request_region(
                            region.0,
                            region.1,
                            timeline,
                            supported.sample_rate(),
                            true,
                        );
                    } else {
                        println!("invalid media region");
                    }
                }
                "stall" => worker.stalled.store(true, Ordering::Release),
                "feed" => worker.stalled.store(false, Ordering::Release),
                "close" => break,
                "status" => {}
                _ => println!(
                    "commands: play, pause, seek FRAME, region A B, loop on, loop off, status, stall, feed, close"
                ),
            }
            println!(
                "playback={:?} totalFrames={} workerFailed={} observation={:?}",
                shared.playback_snapshot(),
                total,
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
