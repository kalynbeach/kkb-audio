use crate::compiled_plan::{CompiledPlan, RenderInstance};
use crate::prepared_kernel::{Output, RenderStatus};
use crate::prepared_pcm::{
    BlockMeta, ChannelLayout, FixedSlotSource, PreparedPcmInput, StreamSpec,
};
use crate::sample_rate::PcmTimeline;
use wasm_bindgen::prelude::*;

const LAYOUT_MONO: u32 = 1;
const LAYOUT_STEREO: u32 = 2;
const SLOT_COUNT: usize = 4;

const STATUS_RENDERED: u32 = 0;
const STATUS_INVALID_LAYOUT: u32 = 1;
const STATUS_CAPACITY_EXCEEDED: u32 = 2;
const STATUS_TERMINAL: u32 = 3;
const STATUS_CLOCK_OVERFLOW: u32 = 4;
const STATUS_REJECTED: u32 = 5;
const STATUS_INVALID_INPUT: u32 = 6;

const ERROR_LAYOUT: u32 = 10;
const ERROR_SAMPLE_RATE: u32 = 11;
const ERROR_PLAN: u32 = 60;

/// Private fixed-memory adapter. Browser slots end at PreparedPcmInput; the same
/// compiled PCM program used by the native adapter consumes that seam.
#[wasm_bindgen]
pub struct WorkletKernel {
    input: Option<PreparedPcmInput<FixedSlotSource<SLOT_COUNT>>>,
    instance: Option<RenderInstance>,
    layout: ChannelLayout,
    left: Box<[f32]>,
    right: Box<[f32]>,
    preparation_status: u32,
    terminal: bool,
    timeline: Option<PcmTimeline>,
    sample_rate: u32,
    loop_change_enabled: bool,
    loop_change_ended: bool,
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
        let instance = input.as_ref().and_then(|_| {
            CompiledPlan::pcm_proof(spec, maximum_frames)
                .ok()
                .map(|plan| RenderInstance::prepare(&plan))
        });
        let preparation_status = if preparation_status != STATUS_RENDERED {
            preparation_status
        } else if input.is_none() {
            ERROR_SAMPLE_RATE
        } else if instance.is_none() {
            ERROR_PLAN
        } else {
            STATUS_RENDERED
        };

        Self {
            input,
            instance,
            layout,
            left: vec![0.0; maximum_frames].into_boxed_slice(),
            right: match layout {
                ChannelLayout::Mono => Box::default(),
                ChannelLayout::Stereo => vec![0.0; maximum_frames].into_boxed_slice(),
            },
            preparation_status,
            terminal: false,
            timeline: None,
            sample_rate,
            loop_change_enabled: false,
            loop_change_ended: false,
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
        pcm_frame_start: u64,
        valid_frames: usize,
        discontinuity: bool,
        end_of_stream: bool,
    ) -> u32 {
        let Some(input) = &mut self.input else {
            return STATUS_TERMINAL;
        };
        if epoch != input.active_epoch() {
            input.source_mut().cancel_reservation(slot_id);
            return STATUS_REJECTED;
        }
        let accepted = input.source_mut().admit_reserved(BlockMeta {
            slot_id,
            epoch,
            pcm_frame_start,
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

    pub fn begin_seek(&mut self, epoch: u64, source_frame: u64) -> Result<u64, u32> {
        let timeline = self.timeline.as_ref().ok_or(71_u32)?;
        let pcm = timeline.seek_pcm_frame(source_frame)?;
        let input = self.input.as_mut().ok_or(71_u32)?;
        if epoch <= input.active_epoch() {
            return Err(71);
        }
        input.begin_seek(epoch, pcm, pcm == timeline.total_pcm_frames());
        if let Some(instance) = &mut self.instance {
            instance.clear_source_observations();
        }
        Ok(pcm)
    }
    pub fn finish_seek(&mut self, epoch: u64) -> bool {
        let Some(input) = &mut self.input else {
            return false;
        };
        if input.active_epoch() != epoch {
            return false;
        }
        input.finish_seek();
        true
    }
    pub fn begin_loop_change(
        &mut self,
        epoch: u64,
        a: u64,
        b: u64,
        enabled: bool,
        edit: bool,
    ) -> Result<u64, u32> {
        let timeline = self.timeline.as_ref().ok_or(73_u32)?;
        let region = crate::wav_loop::LoopRegion::new(
            timeline.seek_pcm_frame(a)?,
            timeline.seek_pcm_frame(b)?,
            self.sample_rate,
        )?;
        let input = self.input.as_mut().ok_or(73_u32)?;
        if epoch <= input.active_epoch() {
            return Err(73);
        }
        self.loop_change_ended = input.ended();
        let cursor = input.pcm_position();
        let inside = cursor >= region.a && cursor < region.b;
        self.loop_change_enabled = enabled && (!edit || inside);
        let pcm = if enabled && !edit && !inside {
            region.a
        } else {
            cursor
        };
        input.begin_seek(epoch, pcm, pcm == timeline.total_pcm_frames());
        input.configure_loop(self.loop_change_enabled.then_some(region), [0.0; 2]);
        if let Some(instance) = &mut self.instance {
            instance.clear_source_observations();
        }
        Ok(pcm)
    }
    pub fn loop_change_ended(&self) -> bool {
        self.loop_change_ended
    }
    pub fn loop_change_enabled(&self) -> bool {
        self.loop_change_enabled
    }
    pub fn configure_loop(
        &mut self,
        a: u64,
        b: u64,
        head_left: f32,
        head_right: f32,
        enabled: bool,
    ) -> Result<(), u32> {
        let region = if enabled {
            Some(crate::wav_loop::LoopRegion::new(a, b, self.sample_rate)?)
        } else {
            None
        };
        self.input
            .as_mut()
            .ok_or(73_u32)?
            .configure_loop(region, [head_left, head_right]);
        Ok(())
    }
    pub fn begin_loop_recovery(&mut self, epoch: u64) -> Result<u64, u32> {
        let input = self.input.as_mut().ok_or(73_u32)?;
        if epoch <= input.active_epoch() || !input.loop_recovering() {
            return Err(73);
        }
        input.begin_loop_recovery(epoch);
        if let Some(instance) = &mut self.instance {
            instance.clear_source_observations();
        }
        Ok(input.pcm_position())
    }
    pub fn loop_iteration(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::loop_iteration)
    }
    pub fn loop_extension_frames(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::loop_extension_frames)
    }
    pub fn loop_lost_frames(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::loop_lost_frames)
    }
    pub fn loop_underruns(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::loop_underruns)
    }
    pub fn loop_recovering(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(PreparedPcmInput::loop_recovering)
    }
    pub fn loop_seam_frames(&self) -> usize {
        self.input.as_ref().map_or(0, PreparedPcmInput::seam_frames)
    }
    pub fn loop_first_iteration(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::callback_first_iteration)
    }
    pub fn ready(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| !input.preparing() && !input.loop_recovering())
    }
    pub fn epoch(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::active_epoch)
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
        let (Some(input), Some(instance)) = (&mut self.input, &mut self.instance) else {
            self.terminal = true;
            return STATUS_TERMINAL;
        };
        let status = match self.layout {
            ChannelLayout::Mono => {
                instance.render_pcm(input, Output::Mono(&mut self.left[..frame_count]))
            }
            ChannelLayout::Stereo => instance.render_pcm(
                input,
                Output::Stereo {
                    left: &mut self.left[..frame_count],
                    right: &mut self.right[..frame_count],
                },
            ),
        };
        if matches!(
            status,
            RenderStatus::CapacityExceeded | RenderStatus::Terminal
        ) {
            self.terminal = true;
        }
        match status {
            RenderStatus::Rendered => STATUS_RENDERED,
            RenderStatus::InvalidLayout => STATUS_INVALID_LAYOUT,
            RenderStatus::CapacityExceeded => STATUS_CAPACITY_EXCEEDED,
            RenderStatus::Terminal => STATUS_TERMINAL,
            RenderStatus::ClockOverflow => STATUS_CLOCK_OVERFLOW,
            RenderStatus::InvalidInput => STATUS_INVALID_INPUT,
        }
    }

    pub fn set_media_timeline(&mut self, source_rate: u32, source_frames: u64) -> Result<(), u32> {
        self.timeline = Some(PcmTimeline::new(
            source_rate,
            self.sample_rate,
            source_frames,
        )?);
        Ok(())
    }

    pub fn source_position(&self) -> u64 {
        let pcm = self.pcm_position();
        self.timeline
            .as_ref()
            .map_or(pcm, |timeline| timeline.source_position(pcm))
    }

    pub fn pcm_position(&self) -> u64 {
        self.input
            .as_ref()
            .map_or(0, PreparedPcmInput::pcm_position)
    }

    pub fn ended(&self) -> bool {
        self.input.as_ref().is_some_and(PreparedPcmInput::ended)
    }

    pub fn slot_free(&mut self, slot_id: u32) -> bool {
        self.input
            .as_mut()
            .is_some_and(|input| input.source_mut().state(slot_id) == Some(0))
    }

    pub fn next_frame(&self) -> u64 {
        self.instance.as_ref().map_or(0, RenderInstance::next_frame)
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
