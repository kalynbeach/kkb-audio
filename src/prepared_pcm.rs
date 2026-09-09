//! Private host-neutral prepared-PCM seam used by the Milestone 3 proofs.

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
    pub(crate) source_frame_start: u64,
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
    source_position: u64,
    terminal: bool,
    counters: PcmCounters,
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
            source_position: 0,
            terminal: false,
            counters: PcmCounters::default(),
        })
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

    pub(crate) fn source_position(&self) -> u64 {
        self.source_position
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
        self.source_position = 0;
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

        if !self.flush_pending_retirement() {
            self.count_starvation_unless_ended();
            return PcmRenderStatus::Rendered;
        }

        let mut written = 0;
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
                self.source_position =
                    meta.source_frame_start + (self.current_offset + copied) as u64;
                (copied, copied == available, meta.end_of_stream)
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
        }
        PcmRenderStatus::Rendered
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
                .source_frame_start
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
            self.left[frame] = deterministic_sample(self.meta.source_frame_start + frame as u64, 0);
            if self.layout == ChannelLayout::Stereo {
                self.right[frame] =
                    deterministic_sample(self.meta.source_frame_start + frame as u64, 1);
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
                .source_frame_start
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
pub(crate) fn deterministic_sample(source_frame: u64, channel: usize) -> f32 {
    let base = ((source_frame & 1_023) as f32 - 512.0) / 16_384.0;
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
                source_frame_start: start,
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
                source_frame_start: start,
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
    fn accepts_noncontiguous_source_frames_without_a_discontinuity() {
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
                    source_frame_start: 40,
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
            source_frame_start: 0,
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
        let mut backpressured = input([Some(block(0, 2, 0, 1, false)), None, None, None]);
        backpressured.source_mut().reject_retire = true;
        let mut left = [0.0; 9];
        let mut right = [0.0; 9];
        let mut blocked_left = [0.0; 2];
        let mut blocked_right = [0.0; 2];
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
        black_box(backpressured.render(PcmOutput::Stereo {
            left: black_box(&mut blocked_left),
            right: black_box(&mut blocked_right),
        }));
        MEASURE_ALLOCATIONS.with(|a| a.set(false));
        assert_eq!(allocator_counts(), [0, 0, 0, 0]);
    }
}
