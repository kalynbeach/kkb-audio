//! Private host-neutral prepared-PCM seam used by the Milestone 3 proofs.
use crate::wav_loop::LoopRegion;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChannelLayout {
    Mono,
    Stereo,
}

impl ChannelLayout {
    pub(crate) const fn channels(self) -> usize {
        match self {
            Self::Mono => 1,
            Self::Stereo => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StreamSpec {
    pub(crate) layout: ChannelLayout,
    pub(crate) sample_rate: u32,
    pub(crate) source_id: u64,
}

impl StreamSpec {
    pub(crate) fn validate(self) -> bool {
        self.sample_rate != 0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BlockMeta {
    pub(crate) slot_id: u32,
    pub(crate) epoch: u64,
    /// First media PCM coordinate at StreamSpec.sample_rate, after conversion.
    /// With an armed loop the following frames wrap inside the configured region;
    /// a block can contain several wraps, never unrelated PCM beyond its B.
    pub(crate) pcm_frame_start: u64,
    pub(crate) valid_frames: usize,
    pub(crate) discontinuity: bool,
    pub(crate) end_of_stream: bool,
}

pub(crate) enum PlanarBlock<'a> {
    Mono(&'a [f32]),
    Stereo { left: &'a [f32], right: &'a [f32] },
}

pub(crate) enum PcmOutput<'a> {
    Mono(&'a mut [f32]),
    Stereo {
        left: &'a mut [f32],
        right: &'a mut [f32],
    },
}

impl PcmOutput<'_> {
    fn frame_count(&self, layout: ChannelLayout) -> Option<usize> {
        match (self, layout) {
            (Self::Mono(output), ChannelLayout::Mono) => Some(output.len()),
            (Self::Stereo { left, right }, ChannelLayout::Stereo) if left.len() == right.len() => {
                Some(left.len())
            }
            _ => None,
        }
    }

    fn zero(&mut self) {
        match self {
            Self::Mono(output) => output.fill(0.0),
            Self::Stereo { left, right } => {
                left.fill(0.0);
                right.fill(0.0);
            }
        }
    }

    fn sample(&self, frame: usize) -> [f32; 2] {
        match self {
            Self::Mono(p) => [p[frame], 0.0],
            Self::Stereo { left, right } => [left[frame], right[frame]],
        }
    }
    fn set_sample(&mut self, frame: usize, value: [f32; 2]) {
        match self {
            Self::Mono(p) => p[frame] = value[0],
            Self::Stereo { left, right } => {
                left[frame] = value[0];
                right[frame] = value[1];
            }
        }
    }
    fn copy_from(
        &mut self,
        output_offset: usize,
        input_offset: usize,
        frames: usize,
        block: PlanarBlock<'_>,
    ) {
        match (self, block) {
            (Self::Mono(output), PlanarBlock::Mono(input)) => {
                output[output_offset..output_offset + frames]
                    .copy_from_slice(&input[input_offset..input_offset + frames]);
            }
            (
                Self::Stereo { left, right },
                PlanarBlock::Stereo {
                    left: input_left,
                    right: input_right,
                },
            ) => {
                left[output_offset..output_offset + frames]
                    .copy_from_slice(&input_left[input_offset..input_offset + frames]);
                right[output_offset..output_offset + frames]
                    .copy_from_slice(&input_right[input_offset..input_offset + frames]);
            }
            _ => unreachable!("validated block layout"),
        }
    }
}

pub(crate) trait PreparedBlock {
    fn meta(&self) -> BlockMeta;
    fn planes(&self) -> PlanarBlock<'_>;
}

pub(crate) trait PreparedBlockSource {
    type Block: PreparedBlock;

    fn pop_ready(&mut self) -> Option<Self::Block>;
    fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block>;
    fn scan_limit(&self) -> usize;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PcmRenderStatus {
    Rendered,
    InvalidLayout,
    CapacityExceeded,
    Terminal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PcmCounters {
    pub(crate) starvation_callbacks: u64,
    pub(crate) stale_blocks: u64,
    pub(crate) invalid_blocks: u64,
    pub(crate) retirement_backpressure: u64,
}

/// Partition adapter. It owns at most one current block and one block whose
/// retirement was backpressured; neither can be finally released in `render`.
pub(crate) struct PreparedPcmInput<S: PreparedBlockSource> {
    spec: StreamSpec,
    active_epoch: u64,
    maximum_frames: usize,
    source: S,
    current: Option<S::Block>,
    current_offset: usize,
    pending_retire: Option<S::Block>,
    ended: bool,
    preparing: bool,
    pcm_position: u64,
    terminal: bool,
    counters: PcmCounters,
    loop_region: Option<LoopRegion>,
    loop_head: [f32; 2],
    loop_iteration: u64,
    loop_last_media: u64,
    loop_consumed: bool,
    loop_extension_frames: u64,
    loop_lost_frames: u64,
    recovery_ready: bool,
    loop_underruns: u64,
    loop_recovering: bool,
    fade_out: usize,
    fade_in: usize,
    last_sample: [f32; 2],
    failure_sample: [f32; 2],
    /// Bounded contribution summary for the last render call. The source/epoch
    /// are spec/active_epoch; held head is loop_region.a, incoming iteration.
    seam_frames: usize,
    callback_first_iteration: u64,
}

impl<S: PreparedBlockSource> PreparedPcmInput<S> {
    pub(crate) fn new(
        spec: StreamSpec,
        active_epoch: u64,
        maximum_frames: usize,
        source: S,
    ) -> Option<Self> {
        spec.validate().then_some(Self {
            spec,
            active_epoch,
            maximum_frames,
            source,
            current: None,
            current_offset: 0,
            pending_retire: None,
            ended: false,
            preparing: false,
            pcm_position: 0,
            terminal: false,
            counters: PcmCounters::default(),
            loop_region: None,
            loop_head: [0.0; 2],
            loop_iteration: 0,
            loop_last_media: 0,
            loop_consumed: false,
            loop_extension_frames: 0,
            loop_lost_frames: 0,
            recovery_ready: false,
            loop_underruns: 0,
            loop_recovering: false,
            fade_out: 0,
            fade_in: 0,
            last_sample: [0.0; 2],
            failure_sample: [0.0; 2],
            seam_frames: 0,
            callback_first_iteration: 0,
        })
    }

    pub(crate) fn configure_loop(&mut self, region: Option<LoopRegion>, head: [f32; 2]) {
        self.loop_region = region;
        self.loop_head = head;
        self.loop_iteration = 0;
        self.loop_consumed = false;
        self.recovery_ready = false;
        self.loop_recovering = false;
        self.fade_out = 0;
        self.fade_in = 0;
    }
    pub(crate) fn loop_iteration(&self) -> u64 {
        self.loop_iteration
    }
    pub(crate) fn loop_underruns(&self) -> u64 {
        self.loop_underruns
    }
    pub(crate) fn loop_extension_frames(&self) -> u64 {
        self.loop_extension_frames
    }
    pub(crate) fn loop_lost_frames(&self) -> u64 {
        self.loop_lost_frames
    }
    pub(crate) fn loop_recovering(&self) -> bool {
        self.loop_recovering
    }
    pub(crate) fn loop_needs_recovery(&self) -> bool {
        self.loop_recovering && !self.recovery_ready && !self.preparing
    }
    pub(crate) fn seam_frames(&self) -> usize {
        self.seam_frames
    }
    pub(crate) fn callback_first_iteration(&self) -> u64 {
        self.callback_first_iteration
    }
    pub(crate) fn begin_loop_recovery(&mut self, epoch: u64) {
        let held = self.pcm_position;
        self.begin_seek(epoch, held, false);
    }
    pub(crate) fn source_mut(&mut self) -> &mut S {
        &mut self.source
    }

    pub(crate) fn spec(&self) -> StreamSpec {
        self.spec
    }

    pub(crate) fn maximum_frames(&self) -> usize {
        self.maximum_frames
    }

    pub(crate) fn counters(&self) -> PcmCounters {
        self.counters
    }

    pub(crate) fn pcm_position(&self) -> u64 {
        self.pcm_position
    }

    pub(crate) fn ended(&self) -> bool {
        self.ended
    }

    pub(crate) fn active_epoch(&self) -> u64 {
        self.active_epoch
    }

    pub(crate) fn set_active_epoch(&mut self, epoch: u64) {
        self.active_epoch = epoch;
        self.ended = false;
        self.pcm_position = 0;
    }

    pub(crate) fn begin_seek(&mut self, epoch: u64, pcm_frame: u64, ended: bool) {
        self.set_active_epoch(epoch);
        self.pcm_position = pcm_frame;
        self.ended = ended;
        self.preparing = true;
        self.reclaim_stale();
    }

    pub(crate) fn finish_seek(&mut self) {
        self.preparing = false;
        if self.loop_recovering {
            self.recovery_ready = true;
        }
    }
    pub(crate) fn preparing(&self) -> bool {
        self.preparing
    }

    /// Bounded ownership maintenance, also called while consumption is paused.
    pub(crate) fn reclaim_stale(&mut self) {
        if !self.flush_pending_retirement() {
            return;
        }
        for _ in 0..=self.source.scan_limit() {
            if self.current.is_none() {
                let Some(block) = self.source.pop_ready() else {
                    break;
                };
                if !self.accept_block(&block) {
                    if !self.retire(block) {
                        break;
                    }
                    continue;
                }
                self.current = Some(block);
                self.current_offset = 0;
            }
            let Some(block) = self.current.as_ref() else {
                break;
            };
            if block.meta().epoch == self.active_epoch {
                break;
            }
            let block = self.current.take().expect("current block");
            self.counters.stale_blocks = self.counters.stale_blocks.saturating_add(1);
            if !self.retire(block) {
                break;
            }
        }
    }

    pub(crate) fn render(&mut self, mut output: PcmOutput<'_>) -> PcmRenderStatus {
        let Some(frame_count) = output.frame_count(self.spec.layout) else {
            output.zero();
            return PcmRenderStatus::InvalidLayout;
        };
        if frame_count == 0 {
            return PcmRenderStatus::Rendered;
        }
        if self.terminal {
            output.zero();
            return PcmRenderStatus::Terminal;
        }
        if frame_count > self.maximum_frames {
            output.zero();
            self.terminal = true;
            return PcmRenderStatus::CapacityExceeded;
        }
        output.zero();
        self.seam_frames = 0;
        self.callback_first_iteration = self.loop_iteration;
        let mut written = 0;
        if self.preparing || self.loop_recovering {
            self.reclaim_stale();
            written = self.fade_out.min(frame_count);
            self.render_failure(&mut output, 0, frame_count);
            if self.loop_recovering {
                self.loop_extension_frames =
                    self.loop_extension_frames.saturating_add(if self.preparing
                        || !self.recovery_ready
                    {
                        frame_count
                    } else {
                        written
                    } as u64);
            }
            if self.preparing || !self.recovery_ready || written == frame_count {
                return PcmRenderStatus::Rendered;
            }
            if let Some(region) = self.loop_region {
                self.pcm_position = region.a;
                self.loop_iteration = self.loop_iteration.saturating_add(1);
                self.loop_consumed = false;
                self.fade_in = region.fade;
            }
            self.loop_recovering = false;
            self.recovery_ready = false;
        }

        if !self.flush_pending_retirement() {
            self.count_starvation_unless_ended();
            self.start_loop_failure();
            if self.loop_recovering {
                self.loop_extension_frames = self
                    .loop_extension_frames
                    .saturating_add((frame_count - written) as u64);
            }
            self.render_failure(&mut output, written, frame_count);
            return PcmRenderStatus::Rendered;
        }

        let mut scanned = 0;
        while written < frame_count {
            if self.current.is_none() {
                if self.ended || scanned >= self.source.scan_limit() {
                    break;
                }
                let Some(block) = self.source.pop_ready() else {
                    break;
                };
                scanned += 1;
                if !self.accept_block(&block) {
                    if !self.retire(block) {
                        break;
                    }
                    continue;
                }
                self.current = Some(block);
                self.current_offset = 0;
            }

            let current_epoch = self
                .current
                .as_ref()
                .expect("current block set")
                .meta()
                .epoch;
            if current_epoch != self.active_epoch {
                if current_epoch < self.active_epoch {
                    self.counters.stale_blocks = self.counters.stale_blocks.saturating_add(1);
                } else {
                    self.counters.invalid_blocks = self.counters.invalid_blocks.saturating_add(1);
                }
                let block = self.current.take().expect("current block set");
                self.current_offset = 0;
                if !self.retire(block) {
                    break;
                }
                continue;
            }

            let (copied, exhausted, end) = {
                let block = self.current.as_ref().expect("current block set");
                let meta = block.meta();
                let available = meta.valid_frames - self.current_offset;
                let copied = available.min(frame_count - written);
                output.copy_from(written, self.current_offset, copied, block.planes());
                let start = meta.pcm_frame_start + self.current_offset as u64;
                for frame in 0..copied {
                    let unfolded = start + frame as u64;
                    let mut value = output.sample(written + frame);
                    if let Some(region) = self.loop_region {
                        let media = region.position(unfolded);
                        if media == region.a
                            && self.loop_consumed
                            && self.loop_last_media == region.b - 1
                        {
                            self.loop_iteration = self.loop_iteration.saturating_add(1);
                        }
                        if written == 0 && frame == 0 {
                            self.callback_first_iteration = self.loop_iteration;
                        }
                        self.loop_last_media = media;
                        self.loop_consumed = true;
                        if media >= region.b - region.fade as u64 {
                            self.seam_frames += 1;
                        }
                        for (channel, sample) in value.iter_mut().enumerate() {
                            *sample = region.sample(media, *sample, self.loop_head[channel]);
                            if self.fade_in > 0 {
                                *sample *=
                                    (region.fade - self.fade_in + 1) as f32 / region.fade as f32;
                            }
                        }
                        self.fade_in = self.fade_in.saturating_sub(1);
                    }
                    output.set_sample(written + frame, value);
                    self.last_sample = value;
                }
                let next = start + copied as u64;
                self.pcm_position = self
                    .loop_region
                    .map_or(next, |region| region.position(next));
                (
                    copied,
                    copied == available,
                    meta.end_of_stream && self.loop_region.is_none(),
                )
            };
            written += copied;
            self.current_offset += copied;

            if exhausted {
                self.ended = end;
                let block = self.current.take().expect("current block set");
                self.current_offset = 0;
                if !self.retire(block) {
                    break;
                }
            }
        }

        if written < frame_count {
            self.count_starvation_unless_ended();
            self.start_loop_failure();
            if self.loop_recovering {
                self.loop_extension_frames = self
                    .loop_extension_frames
                    .saturating_add((frame_count - written) as u64);
            }
            self.render_failure(&mut output, written, frame_count);
        }
        PcmRenderStatus::Rendered
    }

    fn start_loop_failure(&mut self) {
        if let Some(region) = self.loop_region
            && !self.loop_recovering
        {
            self.loop_recovering = true;
            self.recovery_ready = false;
            self.loop_underruns = self.loop_underruns.saturating_add(1);
            self.fade_out = region.fade;
            self.failure_sample = self.last_sample;
            self.loop_lost_frames = if self.loop_consumed && self.loop_last_media == region.b - 1 {
                0
            } else {
                region.b - self.pcm_position
            };
        }
    }
    fn render_failure(&mut self, output: &mut PcmOutput<'_>, start: usize, end: usize) {
        let Some(region) = self.loop_region else {
            return;
        };
        for frame in start..end {
            if self.fade_out == 0 {
                break;
            }
            self.fade_out -= 1;
            let weight = self.fade_out as f32 / region.fade as f32;
            output.set_sample(frame, self.failure_sample.map(|v| v * weight));
        }
    }
    fn accept_block(&mut self, block: &S::Block) -> bool {
        let meta = block.meta();
        if meta.epoch != self.active_epoch {
            if meta.epoch < self.active_epoch {
                self.counters.stale_blocks = self.counters.stale_blocks.saturating_add(1);
            } else {
                self.counters.invalid_blocks = self.counters.invalid_blocks.saturating_add(1);
            }
            return false;
        }
        if self.loop_region.is_some_and(|region| {
            meta.pcm_frame_start < region.a
                || meta.pcm_frame_start >= region.b
                || meta.end_of_stream
        }) {
            self.counters.invalid_blocks = self.counters.invalid_blocks.saturating_add(1);
            return false;
        }
        let layout_valid = match (self.spec.layout, block.planes()) {
            (ChannelLayout::Mono, PlanarBlock::Mono(left)) => meta.valid_frames <= left.len(),
            (ChannelLayout::Stereo, PlanarBlock::Stereo { left, right }) => {
                meta.valid_frames <= left.len() && meta.valid_frames <= right.len()
            }
            _ => false,
        };
        if !layout_valid
            || meta.valid_frames == 0
            || meta
                .pcm_frame_start
                .checked_add(meta.valid_frames as u64)
                .is_none()
        {
            self.counters.invalid_blocks = self.counters.invalid_blocks.saturating_add(1);
            return false;
        }
        true
    }

    fn retire(&mut self, block: S::Block) -> bool {
        match self.source.retire(block) {
            Ok(()) => true,
            Err(block) => {
                self.pending_retire = Some(block);
                self.counters.retirement_backpressure =
                    self.counters.retirement_backpressure.saturating_add(1);
                false
            }
        }
    }

    fn flush_pending_retirement(&mut self) -> bool {
        let Some(block) = self.pending_retire.take() else {
            return true;
        };
        self.retire(block)
    }

    fn count_starvation_unless_ended(&mut self) {
        if !self.ended {
            self.counters.starvation_callbacks =
                self.counters.starvation_callbacks.saturating_add(1);
        }
    }
}

pub(crate) struct OwnedPcmBlock {
    pub(crate) meta: BlockMeta,
    pub(crate) left: Box<[f32]>,
    pub(crate) right: Box<[f32]>,
    layout: ChannelLayout,
}

impl OwnedPcmBlock {
    pub(crate) fn new(slot_id: u32, layout: ChannelLayout, capacity: usize) -> Self {
        Self {
            meta: BlockMeta {
                slot_id,
                ..BlockMeta::default()
            },
            left: vec![0.0; capacity].into_boxed_slice(),
            right: match layout {
                ChannelLayout::Mono => Box::default(),
                ChannelLayout::Stereo => vec![0.0; capacity].into_boxed_slice(),
            },
            layout,
        }
    }

    pub(crate) fn capacity(&self) -> usize {
        self.left.len()
    }

    pub(crate) fn fill_deterministic(&mut self) {
        for frame in 0..self.meta.valid_frames {
            self.left[frame] = deterministic_sample(self.meta.pcm_frame_start + frame as u64, 0);
            if self.layout == ChannelLayout::Stereo {
                self.right[frame] =
                    deterministic_sample(self.meta.pcm_frame_start + frame as u64, 1);
            }
        }
    }
}

impl PreparedBlock for OwnedPcmBlock {
    fn meta(&self) -> BlockMeta {
        self.meta
    }

    fn planes(&self) -> PlanarBlock<'_> {
        match self.layout {
            ChannelLayout::Mono => PlanarBlock::Mono(&self.left),
            ChannelLayout::Stereo => PlanarBlock::Stereo {
                left: &self.left,
                right: &self.right,
            },
        }
    }
}

const SLOT_FREE: u8 = 0;
const SLOT_RESERVED: u8 = 1;
const SLOT_QUEUED: u8 = 2;
const SLOT_READING: u8 = 3;

/// Fixed slot storage used by the browser's off-callback transferable copy.
pub(crate) struct FixedSlotSource<const N: usize> {
    slots: [Option<OwnedPcmBlock>; N],
    states: [u8; N],
    queue: [u32; N],
    queue_head: usize,
    queue_len: usize,
}

impl<const N: usize> FixedSlotSource<N> {
    pub(crate) fn new(layout: ChannelLayout, capacity: usize) -> Self {
        Self {
            slots: std::array::from_fn(|slot| {
                Some(OwnedPcmBlock::new(slot as u32, layout, capacity))
            }),
            states: [SLOT_FREE; N],
            queue: [0; N],
            queue_head: 0,
            queue_len: 0,
        }
    }

    pub(crate) fn reserve(&mut self, slot_id: u32) -> bool {
        let Some(state) = self.states.get_mut(slot_id as usize) else {
            return false;
        };
        if *state != SLOT_FREE {
            return false;
        }
        *state = SLOT_RESERVED;
        true
    }

    pub(crate) fn cancel_reservation(&mut self, slot_id: u32) {
        if let Some(state) = self.states.get_mut(slot_id as usize)
            && *state == SLOT_RESERVED
        {
            *state = SLOT_FREE;
        }
    }

    pub(crate) fn plane_ptrs(&self, slot_id: u32) -> Option<(*const f32, *const f32)> {
        let index = slot_id as usize;
        if self.states.get(index).copied()? != SLOT_RESERVED {
            return None;
        }
        let slot = self.slots.get(index)?.as_ref()?;
        Some((slot.left.as_ptr(), slot.right.as_ptr()))
    }

    pub(crate) fn admit_reserved(&mut self, meta: BlockMeta) -> bool {
        let index = meta.slot_id as usize;
        if self.states.get(index).copied() != Some(SLOT_RESERVED) || self.queue_len == N {
            return false;
        }
        let Some(slot) = self.slots.get_mut(index).and_then(Option::as_mut) else {
            return false;
        };
        if meta.valid_frames == 0
            || meta.valid_frames > slot.capacity()
            || meta
                .pcm_frame_start
                .checked_add(meta.valid_frames as u64)
                .is_none()
        {
            self.states[index] = SLOT_FREE;
            return false;
        }
        slot.meta = meta;
        let tail = (self.queue_head + self.queue_len) % N;
        self.queue[tail] = meta.slot_id;
        self.queue_len += 1;
        self.states[index] = SLOT_QUEUED;
        true
    }

    pub(crate) fn state(&self, slot_id: u32) -> Option<u8> {
        self.states.get(slot_id as usize).copied()
    }
}

impl<const N: usize> PreparedBlockSource for FixedSlotSource<N> {
    type Block = OwnedPcmBlock;

    fn pop_ready(&mut self) -> Option<Self::Block> {
        if self.queue_len == 0 {
            return None;
        }
        let slot_id = self.queue[self.queue_head];
        self.queue_head = (self.queue_head + 1) % N;
        self.queue_len -= 1;
        self.states[slot_id as usize] = SLOT_READING;
        self.slots[slot_id as usize].take()
    }

    fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block> {
        let index = block.meta.slot_id as usize;
        if self.states.get(index).copied() != Some(SLOT_READING) || self.slots[index].is_some() {
            return Err(block);
        }
        self.slots[index] = Some(block);
        self.states[index] = SLOT_FREE;
        Ok(())
    }

    fn scan_limit(&self) -> usize {
        N
    }
}

/// Exactly representable deterministic fixture sample shared by both hosts.
pub(crate) fn deterministic_sample(pcm_frame: u64, channel: usize) -> f32 {
    let base = ((pcm_frame & 1_023) as f32 - 512.0) / 16_384.0;
    if channel == 0 { base } else { -base }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        ALLOCATOR_PROBE_LOCK, MEASURE_ALLOCATIONS, allocator_counts, reset_allocator_counts,
    };
    use std::hint::black_box;

    #[derive(Clone)]
    struct TestBlock {
        meta: BlockMeta,
        left: [f32; 4],
        right: [f32; 4],
    }
    impl PreparedBlock for TestBlock {
        fn meta(&self) -> BlockMeta {
            self.meta
        }
        fn planes(&self) -> PlanarBlock<'_> {
            PlanarBlock::Stereo {
                left: &self.left,
                right: &self.right,
            }
        }
    }
    struct TestSource {
        ready: [Option<TestBlock>; 4],
        head: usize,
        retired: [Option<TestBlock>; 4],
        retired_len: usize,
        reject_retire: bool,
    }
    impl PreparedBlockSource for TestSource {
        type Block = TestBlock;
        fn pop_ready(&mut self) -> Option<Self::Block> {
            let index = self.head;
            self.head += usize::from(self.head < self.ready.len());
            self.ready.get_mut(index)?.take()
        }
        fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block> {
            if self.reject_retire || self.retired_len == self.retired.len() {
                return Err(block);
            }
            self.retired[self.retired_len] = Some(block);
            self.retired_len += 1;
            Ok(())
        }
        fn scan_limit(&self) -> usize {
            self.ready.len()
        }
    }
    fn block(slot: u32, epoch: u64, start: u64, valid: usize, end: bool) -> TestBlock {
        let mut left = [0.0; 4];
        let mut right = [0.0; 4];
        for frame in 0..valid.min(4) {
            left[frame] = deterministic_sample(start + frame as u64, 0);
            right[frame] = deterministic_sample(start + frame as u64, 1);
        }
        TestBlock {
            meta: BlockMeta {
                slot_id: slot,
                epoch,
                pcm_frame_start: start,
                valid_frames: valid,
                discontinuity: start == 0,
                end_of_stream: end,
            },
            left,
            right,
        }
    }
    fn source(blocks: [Option<TestBlock>; 4]) -> TestSource {
        TestSource {
            ready: blocks,
            head: 0,
            retired: std::array::from_fn(|_| None),
            retired_len: 0,
            reject_retire: false,
        }
    }
    fn input(blocks: [Option<TestBlock>; 4]) -> PreparedPcmInput<TestSource> {
        PreparedPcmInput::new(
            StreamSpec {
                layout: ChannelLayout::Stereo,
                sample_rate: 48_000,
                source_id: 7,
            },
            2,
            16,
            source(blocks),
        )
        .unwrap()
    }

    fn render_fixed_partitions(partitions: &[usize]) -> Vec<f32> {
        let mut source = FixedSlotSource::<4>::new(ChannelLayout::Mono, 250);
        for slot_id in 0..4_u32 {
            assert!(source.reserve(slot_id));
            let start = u64::from(slot_id) * 250;
            let meta = BlockMeta {
                slot_id,
                epoch: 2,
                pcm_frame_start: start,
                valid_frames: 250,
                discontinuity: slot_id == 0,
                end_of_stream: slot_id == 3,
            };
            {
                let slot = source.slots[slot_id as usize].as_mut().expect("fixed slot");
                slot.meta = meta;
                slot.fill_deterministic();
            }
            assert!(source.admit_reserved(meta));
        }
        let mut input = PreparedPcmInput::new(
            StreamSpec {
                layout: ChannelLayout::Mono,
                sample_rate: 48_000,
                source_id: 7,
            },
            2,
            1_000,
            source,
        )
        .unwrap();
        let mut output = Vec::with_capacity(1_000);
        for &frames in partitions {
            let start = output.len();
            output.resize(start + frames, f32::NAN);
            assert_eq!(
                input.render(PcmOutput::Mono(&mut output[start..])),
                PcmRenderStatus::Rendered
            );
        }
        output
    }

    fn render_loop_partitions(partitions: &[usize]) -> (Vec<f32>, u64, usize) {
        let region = LoopRegion::new(7, 24, 48000).unwrap();
        let raw = |p: u64| {
            if p == 7 {
                0.75
            } else if p == 23 {
                -0.5
            } else {
                p as f32 / 64.0
            }
        };
        let mut source = FixedSlotSource::<4>::new(ChannelLayout::Mono, 256);
        for slot in 0..4u32 {
            assert!(source.reserve(slot));
            let start = 7 + u64::from(slot) * 256 % 17;
            let block = source.slots[slot as usize].as_mut().unwrap();
            for (j, v) in block.left.iter_mut().enumerate() {
                *v = raw(region.position(start + j as u64));
            }
            assert!(source.admit_reserved(BlockMeta {
                slot_id: slot,
                epoch: 2,
                pcm_frame_start: start,
                valid_frames: 256,
                discontinuity: false,
                end_of_stream: false
            }));
        }
        let mut input = PreparedPcmInput::new(
            StreamSpec {
                layout: ChannelLayout::Mono,
                sample_rate: 48000,
                source_id: 7,
            },
            2,
            1024,
            source,
        )
        .unwrap();
        input.configure_loop(Some(region), [raw(7), 0.0]);
        let mut result = Vec::new();
        let mut contributions = 0;
        for &count in partitions {
            let at = result.len();
            result.resize(at + count, 0.0);
            input.render(PcmOutput::Mono(&mut result[at..]));
            contributions += input.seam_frames();
        }
        for (j, &v) in result.iter().enumerate() {
            let p = 7 + j as u64 % 17;
            let expected = if p < 20 {
                raw(p)
            } else {
                let weight = (p - 20) as f32 / 3.0;
                (1.0 - weight) * raw(p) + weight * raw(7)
            };
            assert_eq!(v, expected);
        }
        assert_eq!(input.pcm_position(), 7 + result.len() as u64 % 17);
        assert_eq!(input.counters().invalid_blocks, 0);
        (result, input.loop_iteration(), contributions)
    }
    #[test]
    fn wav_loop_partition_and_contribution_accounting_includes_many_wraps_per_block() {
        let all = render_loop_partitions(&[1000]);
        assert_eq!(all, render_loop_partitions(&[1; 1000]));
        assert_eq!(all, render_loop_partitions(&[17, 257, 1, 513, 212]));
        assert_eq!(all.1, 58);
    }
    #[test]
    fn wav_loop_underrun_fades_exactly_holds_cursor_and_reprimes_start() {
        let mut first = block(0, 2, 0, 4, false);
        first.left = [0.5; 4];
        first.right = [-0.25; 4];
        let mut i = input([Some(first), None, None, None]);
        i.configure_loop(Some(LoopRegion::new(0, 8, 48000).unwrap()), [0.5, -0.25]);
        let mut l = [0.0; 7];
        let mut r = [0.0; 7];
        i.render(PcmOutput::Stereo {
            left: &mut l,
            right: &mut r,
        });
        assert_eq!(l, [0.5, 0.5, 0.5, 0.5, 0.25, 0.0, 0.0]);
        assert_eq!(r, [-0.25, -0.25, -0.25, -0.25, -0.125, 0.0, 0.0]);
        assert_eq!(i.pcm_position(), 4);
        assert_eq!(i.loop_underruns(), 1);
        assert!(i.loop_needs_recovery());
        i.begin_loop_recovery(3);
        assert_eq!(i.pcm_position(), 4);
        let mut head = block(1, 3, 0, 4, false);
        head.left = [0.5; 4];
        head.right = [-0.25; 4];
        i.source_mut().ready = [Some(head), None, None, None];
        i.source_mut().head = 0;
        i.finish_seek();
        assert_eq!(i.pcm_position(), 4);
        i.render(PcmOutput::Stereo {
            left: &mut l[..2],
            right: &mut r[..2],
        });
        assert_eq!(&l[..2], &[0.25, 0.5]);
        assert_eq!(&r[..2], &[-0.125, -0.25]);
        assert_eq!(i.pcm_position(), 2);
        assert_eq!(i.loop_iteration(), 1);
        assert!(!i.loop_recovering());
    }

    #[test]
    fn deterministic_pcm_is_partition_independent_across_fixed_block_boundaries() {
        let single = render_fixed_partitions(&[1_000]);
        let one_frame = render_fixed_partitions(&[1; 1_000]);
        let pattern = [17, 64, 1, 128, 257, 3, 89];
        let mut partitions = Vec::new();
        let mut remaining = 1_000;
        let mut index = 0;
        while remaining > 0 {
            let frames = pattern[index % pattern.len()].min(remaining);
            partitions.push(frames);
            remaining -= frames;
            index += 1;
        }
        assert_eq!(single, one_frame);
        assert_eq!(single, render_fixed_partitions(&partitions));
    }

    #[test]
    fn adapts_blocks_across_arbitrary_callback_partitions() {
        let blocks = [
            Some(block(0, 2, 0, 4, false)),
            Some(block(1, 2, 4, 4, false)),
            Some(block(2, 2, 8, 2, true)),
            None,
        ];
        let mut one = input(blocks.clone());
        let mut left_one = [0.0; 10];
        let mut right_one = [0.0; 10];
        assert_eq!(
            one.render(PcmOutput::Stereo {
                left: &mut left_one,
                right: &mut right_one
            }),
            PcmRenderStatus::Rendered
        );
        let mut partitioned = input(blocks);
        let mut left = [0.0; 10];
        let mut right = [0.0; 10];
        for (start, count) in [(0, 1), (1, 3), (4, 5), (9, 1)] {
            partitioned.render(PcmOutput::Stereo {
                left: &mut left[start..start + count],
                right: &mut right[start..start + count],
            });
        }
        assert_eq!(left, left_one);
        assert_eq!(right, right_one);
    }

    #[test]
    fn accepts_noncontiguous_pcm_frames_without_a_discontinuity() {
        let mut input = input([
            Some(block(0, 2, 10, 4, false)),
            Some(block(1, 2, 30, 4, true)),
            None,
            None,
        ]);
        let mut left = [0.0; 8];
        let mut right = [0.0; 8];

        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });

        let expected_left =
            [10, 11, 12, 13, 30, 31, 32, 33].map(|frame| deterministic_sample(frame, 0));
        let expected_right =
            [10, 11, 12, 13, 30, 31, 32, 33].map(|frame| deterministic_sample(frame, 1));
        assert_eq!(left, expected_left);
        assert_eq!(right, expected_right);
        assert_eq!(input.counters().invalid_blocks, 0);
    }

    #[test]
    fn rejects_stale_future_invalid_and_counts_starvation_and_eos() {
        let invalid = block(2, 2, 99, 5, false);
        let blocks = [
            Some(block(0, 1, 0, 4, false)),
            Some(block(1, 3, 0, 4, false)),
            Some(invalid),
            Some(block(3, 2, 0, 2, true)),
        ];
        let mut input = input(blocks);
        let mut left = [1.0; 4];
        let mut right = [1.0; 4];
        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });
        assert_eq!(
            &left[..2],
            &[deterministic_sample(0, 0), deterministic_sample(1, 0)]
        );
        assert!(left[2..].iter().all(|v| v.to_bits() == 0));
        assert_eq!(input.counters().stale_blocks, 1);
        assert_eq!(input.counters().invalid_blocks, 2);
        assert_eq!(input.counters().starvation_callbacks, 0);
        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });
        assert_eq!(input.counters().starvation_callbacks, 0);
    }

    #[test]
    fn epoch_change_rejects_a_partially_consumed_current_block() {
        let blocks = [
            Some(block(0, 2, 0, 4, false)),
            Some(TestBlock {
                meta: BlockMeta {
                    slot_id: 1,
                    epoch: 3,
                    pcm_frame_start: 40,
                    valid_frames: 2,
                    discontinuity: true,
                    end_of_stream: true,
                },
                left: [
                    deterministic_sample(40, 0),
                    deterministic_sample(41, 0),
                    0.0,
                    0.0,
                ],
                right: [
                    deterministic_sample(40, 1),
                    deterministic_sample(41, 1),
                    0.0,
                    0.0,
                ],
            }),
            None,
            None,
        ];
        let mut input = input(blocks);
        let mut first_left = [0.0; 2];
        let mut first_right = [0.0; 2];
        input.render(PcmOutput::Stereo {
            left: &mut first_left,
            right: &mut first_right,
        });
        input.set_active_epoch(3);
        let mut next_left = [0.0; 2];
        let mut next_right = [0.0; 2];
        input.render(PcmOutput::Stereo {
            left: &mut next_left,
            right: &mut next_right,
        });
        assert_eq!(
            next_left,
            [deterministic_sample(40, 0), deterministic_sample(41, 0)]
        );
        assert_eq!(input.counters().stale_blocks, 1);
    }

    #[test]
    fn paused_reclamation_validates_blocks_before_retaining_them() {
        let mut overflow = block(1, 2, 0, 2, false);
        overflow.meta.pcm_frame_start = u64::MAX;
        let mut input = input([
            Some(block(0, 2, 0, 5, false)),
            Some(overflow),
            Some(block(2, 2, 10, 2, true)),
            None,
        ]);
        input.begin_seek(2, 10, false);
        input.finish_seek();
        let mut left = [0.0; 5];
        let mut right = [0.0; 5];
        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });
        assert_eq!(input.counters().invalid_blocks, 2);
        assert_eq!(
            left,
            [
                deterministic_sample(10, 0),
                deterministic_sample(11, 0),
                0.0,
                0.0,
                0.0
            ]
        );
        assert_eq!(input.source_mut().retired_len, 3);
    }

    #[test]
    fn starvation_recovers_and_counter_saturates() {
        let mut input = input([None, None, None, None]);
        let mut left = [1.0; 2];
        let mut right = [1.0; 2];
        input.counters.starvation_callbacks = u64::MAX;
        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });
        assert!(left.iter().all(|v| v.to_bits() == 0));
        assert_eq!(input.counters().starvation_callbacks, u64::MAX);
    }

    #[test]
    fn fixed_slot_source_rejects_invalid_and_duplicate_ownership_transitions() {
        let mut source = FixedSlotSource::<2>::new(ChannelLayout::Stereo, 4);
        assert!(!source.reserve(2));
        assert!(source.reserve(0));
        let pointers = source.plane_ptrs(0).expect("reserved storage");
        assert!(!source.reserve(0));
        assert!(source.admit_reserved(BlockMeta {
            slot_id: 0,
            epoch: 1,
            pcm_frame_start: 0,
            valid_frames: 4,
            discontinuity: true,
            end_of_stream: false,
        }));
        assert!(!source.admit_reserved(BlockMeta {
            slot_id: 0,
            ..BlockMeta::default()
        }));
        let block = source.pop_ready().expect("queued block");
        assert_eq!(block.left.as_ptr(), pointers.0);
        assert!(source.retire(block).is_ok());
        assert!(source.reserve(0));
        assert_eq!(source.plane_ptrs(0), Some(pointers));
        source.cancel_reservation(0);
        assert_eq!(source.state(0), Some(SLOT_FREE));
    }

    #[test]
    fn failed_retirement_is_retained_without_callback_deallocation() {
        let mut input = input([Some(block(0, 2, 0, 2, false)), None, None, None]);
        input.source_mut().reject_retire = true;
        let mut left = [0.0; 4];
        let mut right = [0.0; 4];
        input.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        });
        assert!(input.pending_retire.is_some());
        assert_eq!(input.counters().retirement_backpressure, 1);
    }

    #[test]
    fn exercised_callback_paths_have_no_observed_allocator_or_deallocator_calls() {
        let _guard = ALLOCATOR_PROBE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        MEASURE_ALLOCATIONS.with(|a| a.set(false));
        let make = || {
            input([
                Some(block(0, 1, 0, 1, false)),
                Some(block(1, 2, 0, 4, false)),
                Some(block(2, 2, 4, 4, false)),
                None,
            ])
        };
        let mut warm = make();
        let mut wl = [0.0; 9];
        let mut wr = [0.0; 9];
        black_box(warm.render(PcmOutput::Stereo {
            left: &mut wl,
            right: &mut wr,
        }));
        let mut measured = make();
        measured.configure_loop(Some(LoopRegion::new(0, 8, 48000).unwrap()), [0.25, -0.5]);
        let mut backpressured = input([Some(block(0, 2, 0, 1, false)), None, None, None]);
        backpressured.source_mut().reject_retire = true;
        let mut left = [0.0; 9];
        let mut right = [0.0; 9];
        let mut blocked_left = [0.0; 2];
        let mut blocked_right = [0.0; 2];
        let recovery = [
            Some(block(0, 3, 0, 4, false)),
            Some(block(1, 3, 4, 4, false)),
            None,
            None,
        ];
        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|a| a.set(true));
        black_box(measured.render(PcmOutput::Stereo {
            left: black_box(&mut left[..3]),
            right: black_box(&mut right[..3]),
        }));
        black_box(measured.render(PcmOutput::Stereo {
            left: black_box(&mut left[3..]),
            right: black_box(&mut right[3..]),
        }));
        measured.begin_loop_recovery(3);
        let source = measured.source_mut();
        source.ready = recovery;
        source.head = 0;
        source.retired = std::array::from_fn(|_| None);
        source.retired_len = 0;
        measured.finish_seek();
        black_box(measured.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right,
        }));
        black_box(backpressured.render(PcmOutput::Stereo {
            left: black_box(&mut blocked_left),
            right: black_box(&mut blocked_right),
        }));
        MEASURE_ALLOCATIONS.with(|a| a.set(false));
        assert_eq!(allocator_counts(), [0, 0, 0, 0]);
        assert!(!measured.loop_recovering());
        assert_eq!(left[0], 0.0); // Final fade-out frame.
        assert_eq!(left[1], deterministic_sample(0, 0) * 0.5); // First of two fade-in frames.
        assert_eq!(right[2], deterministic_sample(1, 1));
    }
}
