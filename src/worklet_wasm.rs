use crate::prepared_pcm::{
    BlockMeta, ChannelLayout, FixedSlotSource, PcmOutput, PcmRenderStatus, PreparedPcmInput,
    StreamSpec,
};
use wasm_bindgen::prelude::*;

const LAYOUT_MONO: u32 = 1;
const LAYOUT_STEREO: u32 = 2;
const SLOT_COUNT: usize = 4;

const STATUS_RENDERED: u32 = 0;
const STATUS_INVALID_LAYOUT: u32 = 1;
const STATUS_CAPACITY_EXCEEDED: u32 = 2;
const STATUS_TERMINAL: u32 = 3;
const STATUS_REJECTED: u32 = 5;

const ERROR_LAYOUT: u32 = 10;
const ERROR_SAMPLE_RATE: u32 = 11;

/// Private fixed-memory adapter for the browser PCM transport proof.
#[wasm_bindgen]
pub struct WorkletKernel {
    input: Option<PreparedPcmInput<FixedSlotSource<SLOT_COUNT>>>,
    layout: ChannelLayout,
    left: Box<[f32]>,
    right: Box<[f32]>,
    preparation_status: u32,
    terminal: bool,
}

#[wasm_bindgen]
impl WorkletKernel {
    #[wasm_bindgen(constructor)]
    pub fn new(
        layout: u32,
        sample_rate: u32,
        source_id: u64,
        epoch: u64,
        maximum_frames: usize,
        slot_frames: usize,
    ) -> WorkletKernel {
        let (layout, preparation_status) = match layout {
            LAYOUT_MONO => (ChannelLayout::Mono, STATUS_RENDERED),
            LAYOUT_STEREO => (ChannelLayout::Stereo, STATUS_RENDERED),
            _ => (ChannelLayout::Mono, ERROR_LAYOUT),
        };
        let spec = StreamSpec {
            layout,
            sample_rate,
            source_id,
        };
        let input = if preparation_status == STATUS_RENDERED && spec.validate() && slot_frames > 0 {
            PreparedPcmInput::new(
                spec,
                epoch,
                maximum_frames,
                FixedSlotSource::new(layout, slot_frames),
            )
        } else {
            None
        };
        let preparation_status = if preparation_status != STATUS_RENDERED {
            preparation_status
        } else if input.is_none() {
            ERROR_SAMPLE_RATE
        } else {
            STATUS_RENDERED
        };

        Self {
            input,
            layout,
            left: vec![0.0; maximum_frames].into_boxed_slice(),
            right: match layout {
                ChannelLayout::Mono => Box::default(),
                ChannelLayout::Stereo => vec![0.0; maximum_frames].into_boxed_slice(),
            },
            preparation_status,
            terminal: false,
        }
    }

    pub fn preparation_status(&self) -> u32 {
        self.preparation_status
    }

    pub fn reserve_slot(&mut self, slot_id: u32) -> bool {
        self.input
            .as_mut()
            .is_some_and(|input| input.source_mut().reserve(slot_id))
    }

    pub fn cancel_slot(&mut self, slot_id: u32) {
        if let Some(input) = &mut self.input {
            input.source_mut().cancel_reservation(slot_id);
        }
    }

    pub fn slot_left_ptr(&mut self, slot_id: u32) -> *const f32 {
        self.input
            .as_mut()
            .and_then(|input| input.source_mut().plane_ptrs(slot_id))
            .map_or(std::ptr::null(), |pointers| pointers.0)
    }

    pub fn slot_right_ptr(&mut self, slot_id: u32) -> *const f32 {
        self.input
            .as_mut()
            .and_then(|input| input.source_mut().plane_ptrs(slot_id))
            .map_or(std::ptr::null(), |pointers| pointers.1)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn admit(
        &mut self,
        slot_id: u32,
        epoch: u64,
        source_frame_start: u64,
        valid_frames: usize,
        discontinuity: bool,
        end_of_stream: bool,
    ) -> u32 {
        let Some(input) = &mut self.input else {
            return STATUS_TERMINAL;
        };
        let accepted = input.source_mut().admit_reserved(BlockMeta {
            slot_id,
            epoch,
            source_frame_start,
            valid_frames,
            discontinuity,
            end_of_stream,
        });
        if accepted {
            STATUS_RENDERED
        } else {
            STATUS_REJECTED
        }
    }

    pub fn set_epoch(&mut self, epoch: u64) {
        if let Some(input) = &mut self.input {
            input.set_active_epoch(epoch);
        }
    }

    pub fn render(&mut self, frame_count: usize) -> u32 {
        if self.preparation_status != STATUS_RENDERED {
            return self.preparation_status;
        }
        if frame_count == 0 {
            return STATUS_RENDERED;
        }
        if self.terminal {
            return STATUS_TERMINAL;
        }
        if frame_count > self.left.len() {
            self.terminal = true;
            return STATUS_CAPACITY_EXCEEDED;
        }
        let Some(input) = &mut self.input else {
            self.terminal = true;
            return STATUS_TERMINAL;
        };
        let status = match self.layout {
            ChannelLayout::Mono => input.render(PcmOutput::Mono(&mut self.left[..frame_count])),
            ChannelLayout::Stereo => input.render(PcmOutput::Stereo {
                left: &mut self.left[..frame_count],
                right: &mut self.right[..frame_count],
            }),
        };
        if matches!(
            status,
            PcmRenderStatus::CapacityExceeded | PcmRenderStatus::Terminal
        ) {
            self.terminal = true;
        }
        match status {
            PcmRenderStatus::Rendered => STATUS_RENDERED,
            PcmRenderStatus::InvalidLayout => STATUS_INVALID_LAYOUT,
            PcmRenderStatus::CapacityExceeded => STATUS_CAPACITY_EXCEEDED,
            PcmRenderStatus::Terminal => STATUS_TERMINAL,
        }
    }

    pub fn left_ptr(&self) -> *const f32 {
        self.left.as_ptr()
    }
    pub fn right_ptr(&self) -> *const f32 {
        self.right.as_ptr()
    }
    pub fn maximum_frames(&self) -> usize {
        self.left.len()
    }
    pub fn slot_count(&self) -> usize {
        SLOT_COUNT
    }
    pub fn starvation_count(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, |input| input.counters().starvation_callbacks)
    }
    pub fn stale_count(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, |input| input.counters().stale_blocks)
    }
    pub fn invalid_count(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, |input| input.counters().invalid_blocks)
    }
}
