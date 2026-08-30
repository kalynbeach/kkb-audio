use crate::prepared_kernel::{Output, OutputLayout, PrepareError, PreparedKernel, RenderStatus};
use wasm_bindgen::prelude::*;

const LAYOUT_MONO: u32 = 1;
const LAYOUT_STEREO: u32 = 2;

const STATUS_RENDERED: u32 = 0;
const STATUS_INVALID_LAYOUT: u32 = 1;
const STATUS_CAPACITY_EXCEEDED: u32 = 2;
const STATUS_TERMINAL: u32 = 3;
const STATUS_CLOCK_OVERFLOW: u32 = 4;

const ERROR_LAYOUT: u32 = 10;
const ERROR_SAMPLE_RATE: u32 = 11;
const ERROR_GAIN: u32 = 12;
const ERROR_FREQUENCY: u32 = 13;

/// Private proof adapter exported only in the Wasm artifact.
///
/// The host-facing ABI owns fixed planar storage. Rendering still enters the
/// unchanged Milestone 1 `PreparedKernel::render` seam.
#[wasm_bindgen]
pub struct WorkletKernel {
    kernel: Option<PreparedKernel>,
    layout: OutputLayout,
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
        sample_rate: f64,
        frequency: f64,
        gain: f32,
        maximum_frames: usize,
    ) -> WorkletKernel {
        let (layout, layout_status) = match layout {
            LAYOUT_MONO => (OutputLayout::Mono, STATUS_RENDERED),
            LAYOUT_STEREO => (OutputLayout::Stereo, STATUS_RENDERED),
            _ => (OutputLayout::Mono, ERROR_LAYOUT),
        };
        let prepared = if layout_status == STATUS_RENDERED {
            PreparedKernel::prepare(layout, sample_rate, frequency, gain, maximum_frames)
                .map_err(prepare_error_code)
        } else {
            Err(layout_status)
        };
        let (kernel, preparation_status) = match prepared {
            Ok(kernel) => (Some(kernel), STATUS_RENDERED),
            Err(status) => (None, status),
        };

        let left = vec![0.0; maximum_frames].into_boxed_slice();
        let right = match layout {
            OutputLayout::Mono => Box::default(),
            OutputLayout::Stereo => vec![0.0; maximum_frames].into_boxed_slice(),
        };

        Self {
            kernel,
            layout,
            left,
            right,
            preparation_status,
            terminal: false,
        }
    }

    pub fn preparation_status(&self) -> u32 {
        self.preparation_status
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
        let Some(kernel) = &mut self.kernel else {
            self.terminal = true;
            return STATUS_TERMINAL;
        };

        let status = match self.layout {
            OutputLayout::Mono => kernel.render(Output::Mono(&mut self.left[..frame_count])),
            OutputLayout::Stereo => kernel.render(Output::Stereo {
                left: &mut self.left[..frame_count],
                right: &mut self.right[..frame_count],
            }),
        };
        if matches!(
            status,
            RenderStatus::CapacityExceeded | RenderStatus::Terminal
        ) {
            self.terminal = true;
        }
        render_status_code(status)
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
}

fn prepare_error_code(error: PrepareError) -> u32 {
    match error {
        PrepareError::SampleRate => ERROR_SAMPLE_RATE,
        PrepareError::Gain => ERROR_GAIN,
        PrepareError::Frequency => ERROR_FREQUENCY,
    }
}

fn render_status_code(status: RenderStatus) -> u32 {
    match status {
        RenderStatus::Rendered => STATUS_RENDERED,
        RenderStatus::InvalidLayout => STATUS_INVALID_LAYOUT,
        RenderStatus::CapacityExceeded => STATUS_CAPACITY_EXCEEDED,
        RenderStatus::Terminal => STATUS_TERMINAL,
        RenderStatus::ClockOverflow => STATUS_CLOCK_OVERFLOW,
    }
}
