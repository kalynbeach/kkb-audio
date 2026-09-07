use crate::compiled_plan::{CompiledPlan, Observation, RenderInstance, proof_events};
use crate::prepared_kernel::{Output, OutputLayout, RenderStatus};
use wasm_bindgen::prelude::*;

const INVALID_DESCRIPTION: u32 = 60;

/// The dedicated worker compiles the private fixture before transferring numeric words.
#[wasm_bindgen]
pub fn compile_plan_proof(sample_rate: f64, channels: u32) -> Vec<u32> {
    let Some(layout) = layout(channels) else {
        return Vec::new();
    };
    CompiledPlan::proof(sample_rate, layout)
        .and_then(|plan| plan.encode(&proof_events()))
        .unwrap_or_default()
}

fn layout(channels: u32) -> Option<OutputLayout> {
    match channels {
        1 => Some(OutputLayout::Mono),
        2 => Some(OutputLayout::Stereo),
        _ => None,
    }
}

/// Private browser binding; there is no PCM input or transport ownership in this adapter.
#[wasm_bindgen]
pub struct WorkletPlan {
    instance: Option<RenderInstance>,
    layout: OutputLayout,
    left: Box<[f32]>,
    right: Box<[f32]>,
    terminal: bool,
    observation: Observation,
}

#[wasm_bindgen]
impl WorkletPlan {
    #[wasm_bindgen(constructor)]
    pub fn new(description: &[u32], sample_rate: f64, channels: u32) -> Self {
        let prepared = CompiledPlan::decode(description).ok().filter(|(plan, _)| {
            // The negotiated host rate/layout must match the transferred program.
            layout(channels) == Some(plan.layout())
                && plan.sample_rate() == sample_rate
                && plan.pcm_spec().is_none()
        });
        let Some((plan, events)) = prepared else {
            return Self {
                instance: None,
                layout: OutputLayout::Mono,
                left: Box::default(),
                right: Box::default(),
                terminal: false,
                observation: Observation::default(),
            };
        };
        let mut instance = RenderInstance::prepare(&plan);
        for event in events {
            // Decode already validated every event against the same fresh plan.
            if instance.schedule(event).is_err() {
                return Self {
                    instance: None,
                    layout: plan.layout(),
                    left: Box::default(),
                    right: Box::default(),
                    terminal: false,
                    observation: Observation::default(),
                };
            }
        }
        Self {
            instance: Some(instance),
            layout: plan.layout(),
            left: vec![0.0; plan.maximum_frames()].into_boxed_slice(),
            right: if plan.layout() == OutputLayout::Stereo {
                vec![0.0; plan.maximum_frames()].into_boxed_slice()
            } else {
                Box::default()
            },
            terminal: false,
            observation: Observation::default(),
        }
    }

    pub fn preparation_status(&self) -> u32 {
        if self.instance.is_some() {
            0
        } else {
            INVALID_DESCRIPTION
        }
    }
    pub fn maximum_frames(&self) -> usize {
        self.left.len()
    }
    pub fn left_ptr(&self) -> *const f32 {
        self.left.as_ptr()
    }
    pub fn right_ptr(&self) -> *const f32 {
        self.right.as_ptr()
    }
    pub fn next_frame(&self) -> u64 {
        self.instance.as_ref().map_or(0, RenderInstance::next_frame)
    }

    pub fn render(&mut self, frame_count: usize) -> u32 {
        let Some(instance) = &mut self.instance else {
            return INVALID_DESCRIPTION;
        };
        if frame_count == 0 {
            return 0;
        }
        if self.terminal {
            self.left.fill(0.0);
            self.right.fill(0.0);
            return 3;
        }
        if frame_count > self.left.len() {
            self.terminal = true;
            self.left.fill(0.0);
            self.right.fill(0.0);
            return 2;
        }
        let status = match self.layout {
            OutputLayout::Mono => instance.render(Output::Mono(&mut self.left[..frame_count])),
            OutputLayout::Stereo => instance.render(Output::Stereo {
                left: &mut self.left[..frame_count],
                right: &mut self.right[..frame_count],
            }),
        };
        match status {
            RenderStatus::Rendered => 0,
            RenderStatus::InvalidLayout => 1,
            RenderStatus::CapacityExceeded => 2,
            RenderStatus::Terminal => 3,
            RenderStatus::ClockOverflow => 4,
            RenderStatus::InvalidInput => 6,
        }
    }

    pub fn take_observation(&mut self) -> bool {
        if let Some(observation) = self
            .instance
            .as_mut()
            .and_then(RenderInstance::take_observation)
        {
            self.observation = observation;
            true
        } else {
            false
        }
    }
    pub fn observation_start(&self) -> u64 {
        self.observation.start
    }
    pub fn observation_end(&self) -> u64 {
        self.observation.end
    }
    pub fn observation_sequence(&self) -> u64 {
        self.observation.sequence
    }
    pub fn observation_dropped(&self) -> u64 {
        self.observation.dropped
    }
    pub fn observation_location(&self) -> u32 {
        self.observation.location
    }
    pub fn observation_peak(&self) -> f32 {
        self.observation.peak
    }
    pub fn observation_rms(&self) -> f64 {
        self.observation.rms
    }
}
