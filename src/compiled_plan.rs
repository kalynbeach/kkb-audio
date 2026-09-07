//! Private closed oscillator and prepared-PCM programs, compiled off-callback.

use crate::prepared_kernel::{Output, OutputLayout, RenderStatus};
use crate::prepared_pcm::{
    ChannelLayout, PcmOutput, PcmRenderStatus, PreparedBlockSource, PreparedPcmInput, StreamSpec,
};
use std::f64::consts::TAU;

const OP_COUNT: usize = 7;
pub(crate) const MAXIMUM_FRAMES: usize = 1_024;
const EVENT_CAPACITY: usize = 16;
const PCM_MAXIMUM_FRAMES: usize = 4_096;
const WIRE_VERSION: u32 = 2;
const HEADER_WORDS: usize = 8;
const OP_WORDS: usize = 8;
const EVENT_WORDS: usize = 8;

mod lab;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompileError {
    SampleRate,
    Topology,
    Port,
    Layout,
    Capacity,
    Identifier,
    Value,
    Description,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Address {
    pub processor: u32,
    pub parameter: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Port {
    processor: u32,
    port: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum NodeKind {
    PcmInput {
        spec: StreamSpec,
    },
    Oscillator {
        frequency: f64,
    },
    Gain {
        input: Port,
        parameter: u32,
        value: f32,
    },
    Mix {
        inputs: [Port; 2],
    },
    Observe {
        input: Port,
    },
    Output {
        input: Port,
    },
}

impl NodeKind {
    fn inputs(&self) -> [Option<Port>; 2] {
        match *self {
            Self::Oscillator { .. } | Self::PcmInput { .. } => [None, None],
            Self::Gain { input, .. } | Self::Observe { input } | Self::Output { input } => {
                [Some(input), None]
            }
            Self::Mix { inputs } => inputs.map(Some),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Node {
    id: u32,
    layout: OutputLayout,
    kind: NodeKind,
}

#[derive(Clone, Copy, Debug)]
struct Description {
    sample_rate: f64,
    maximum_frames: usize,
    observation_frames: usize,
    nodes: [Node; OP_COUNT],
    operation_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operation {
    PcmInput {
        spec: StreamSpec,
    },
    Oscillator {
        increment: f64,
        frequency: f64,
    },
    Gain {
        input: usize,
        address: Address,
        value: f32,
    },
    Mix {
        inputs: [usize; 2],
    },
    Observe {
        input: usize,
    },
    Output {
        input: usize,
    },
}

/// Immutable, fixed-size metadata. Instances copy this small table at preparation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CompiledPlan {
    sample_rate: f64,
    maximum_frames: usize,
    layout: OutputLayout,
    observation_frames: usize,
    observation_location: u32,
    ids: [u32; OP_COUNT],
    operations: [Operation; OP_COUNT],
    operation_count: usize,
}

impl CompiledPlan {
    fn compile(description: &Description) -> Result<Self, CompileError> {
        let rate = description.sample_rate;
        if !rate.is_finite() || rate <= 0.0 {
            return Err(CompileError::SampleRate);
        }
        if !matches!(description.operation_count, 4 | OP_COUNT) {
            return Err(CompileError::Topology);
        }
        let nodes = &description.nodes[..description.operation_count];
        let pcm_spec = nodes.iter().find_map(|node| match node.kind {
            NodeKind::PcmInput { spec } => Some(spec),
            _ => None,
        });
        let maximum_frames = if pcm_spec.is_some() {
            PCM_MAXIMUM_FRAMES
        } else {
            MAXIMUM_FRAMES
        };
        if !(1..=maximum_frames).contains(&description.maximum_frames)
            || !(1..=MAXIMUM_FRAMES).contains(&description.observation_frames)
        {
            return Err(CompileError::Capacity);
        }
        let mut counts = [0; 6];
        for (index, node) in nodes.iter().enumerate() {
            if node.id == 0 || nodes[..index].iter().any(|previous| previous.id == node.id) {
                return Err(CompileError::Identifier);
            }
            let internal_layout =
                pcm_spec.map_or(OutputLayout::Mono, |spec| pcm_layout(spec.layout));
            if (pcm_spec.is_some() || !matches!(node.kind, NodeKind::Output { .. }))
                && node.layout != internal_layout
            {
                return Err(CompileError::Layout);
            }
            match node.kind {
                NodeKind::PcmInput { spec } => {
                    counts[5] += 1;
                    if !spec.validate() || f64::from(spec.sample_rate) != rate {
                        return Err(CompileError::SampleRate);
                    }
                }
                NodeKind::Oscillator { frequency } => {
                    counts[0] += 1;
                    if !frequency.is_finite() || frequency < 0.0 || frequency >= rate - frequency {
                        return Err(CompileError::Value);
                    }
                }
                NodeKind::Gain {
                    parameter, value, ..
                } => {
                    counts[1] += 1;
                    if parameter == 0 {
                        return Err(CompileError::Identifier);
                    }
                    if !valid_gain(value) {
                        return Err(CompileError::Value);
                    }
                }
                NodeKind::Mix { .. } => counts[2] += 1,
                NodeKind::Observe { .. } => counts[3] += 1,
                NodeKind::Output { .. } => counts[4] += 1,
            }
            for port in node.kind.inputs().into_iter().flatten() {
                let source = nodes
                    .iter()
                    .find(|source| source.id == port.processor)
                    .ok_or(CompileError::Identifier)?;
                if port.port != 0 || matches!(source.kind, NodeKind::Output { .. }) {
                    return Err(CompileError::Port);
                }
                if source.layout != internal_layout {
                    return Err(CompileError::Layout);
                }
            }
        }
        if counts != [2, 2, 1, 1, 1, 0] && counts != [0, 1, 0, 1, 1, 1] {
            return Err(CompileError::Topology);
        }

        // A stable topological sort uses processor identity to break ties.
        let mut order = [0; OP_COUNT];
        let mut emitted = [false; OP_COUNT];
        for slot in &mut order[..nodes.len()] {
            let ready = nodes
                .iter()
                .enumerate()
                .filter(|(index, node)| {
                    !emitted[*index]
                        && node.kind.inputs().into_iter().flatten().all(|port| {
                            nodes.iter().enumerate().any(|(source_index, source)| {
                                source.id == port.processor && emitted[source_index]
                            })
                        })
                })
                .min_by_key(|(_, node)| node.id)
                .map(|(index, _)| index)
                .ok_or(CompileError::Topology)?;
            *slot = ready;
            emitted[ready] = true;
        }

        // Only two closed programs: oscillator/gain fan-in, or PCM/linked gain.
        // Both finish with post-master observation and output mapping.
        for node in nodes {
            let source_kind = |port: Port| {
                nodes
                    .iter()
                    .find(|n| n.id == port.processor)
                    .map(|n| n.kind)
            };
            let valid = match node.kind {
                NodeKind::Oscillator { .. } | NodeKind::PcmInput { .. } => true,
                NodeKind::Gain { input, .. } => matches!(
                    source_kind(input),
                    Some(NodeKind::Oscillator { .. } | NodeKind::PcmInput { .. })
                ) && nodes
                    .iter()
                    .filter(
                        |n| matches!(n.kind, NodeKind::Gain { input: other, .. } if other == input),
                    )
                    .count()
                    == 1,
                NodeKind::Mix { inputs } => {
                    inputs[0] != inputs[1]
                        && inputs
                            .iter()
                            .all(|&p| matches!(source_kind(p), Some(NodeKind::Gain { .. })))
                }
                NodeKind::Observe { input } => {
                    if pcm_spec.is_some() {
                        matches!(source_kind(input), Some(NodeKind::Gain { .. }))
                    } else {
                        matches!(source_kind(input), Some(NodeKind::Mix { .. }))
                    }
                }
                NodeKind::Output { input } => {
                    matches!(source_kind(input), Some(NodeKind::Observe { .. }))
                }
            };
            if !valid {
                return Err(CompileError::Topology);
            }
        }

        let mut plan = Self {
            sample_rate: rate,
            maximum_frames: description.maximum_frames,
            layout: OutputLayout::Mono,
            observation_frames: description.observation_frames,
            observation_location: 0,
            ids: [0; OP_COUNT],
            operations: [Operation::Output { input: 0 }; OP_COUNT],
            operation_count: nodes.len(),
        };
        for (slot, &index) in order[..nodes.len()].iter().enumerate() {
            plan.ids[slot] = nodes[index].id;
        }
        for (slot, &index) in order[..nodes.len()].iter().enumerate() {
            let node = nodes[index];
            let source_slot = |port: Port| {
                plan.ids
                    .iter()
                    .position(|&id| id == port.processor)
                    .ok_or(CompileError::Identifier)
            };
            plan.operations[slot] = match node.kind {
                NodeKind::PcmInput { spec } => Operation::PcmInput { spec },
                NodeKind::Oscillator { frequency } => Operation::Oscillator {
                    increment: TAU * (frequency / rate),
                    frequency,
                },
                NodeKind::Gain {
                    input,
                    parameter,
                    value,
                } => Operation::Gain {
                    input: source_slot(input)?,
                    address: Address {
                        processor: node.id,
                        parameter,
                    },
                    value,
                },
                NodeKind::Mix { inputs } => Operation::Mix {
                    inputs: [source_slot(inputs[0])?, source_slot(inputs[1])?],
                },
                NodeKind::Observe { input } => {
                    plan.observation_location = node.id;
                    Operation::Observe {
                        input: source_slot(input)?,
                    }
                }
                NodeKind::Output { input } => {
                    plan.layout = node.layout;
                    Operation::Output {
                        input: source_slot(input)?,
                    }
                }
            };
        }
        Ok(plan)
    }

    pub(crate) fn proof(sample_rate: f64, layout: OutputLayout) -> Result<Self, CompileError> {
        Self::compile(&proof_description(sample_rate, layout))
    }

    pub(crate) fn pcm_proof(spec: StreamSpec, maximum_frames: usize) -> Result<Self, CompileError> {
        Self::compile(&pcm_description(spec, maximum_frames))
    }

    pub(crate) fn pcm_spec(&self) -> Option<StreamSpec> {
        self.operations[..self.operation_count]
            .iter()
            .find_map(|op| match op {
                Operation::PcmInput { spec } => Some(*spec),
                _ => None,
            })
    }

    fn buffer_channels(&self) -> usize {
        self.pcm_spec().map_or(1, |spec| spec.layout.channels())
    }

    pub(crate) fn sample_rate(&self) -> f64 {
        self.sample_rate
    }
    pub(crate) fn maximum_frames(&self) -> usize {
        self.maximum_frames
    }
    pub(crate) fn layout(&self) -> OutputLayout {
        self.layout
    }

    fn parameter_slot(&self, address: Address) -> Option<usize> {
        self.operations
            .iter()
            .position(|op| matches!(op, Operation::Gain { address: a, .. } if *a == address))
    }

    fn validate_event(&self, event: Event, next_frame: u64) -> Result<(), EventError> {
        if self.parameter_slot(event.address).is_none() {
            return Err(EventError::Target);
        }
        let value = match event.action {
            Action::Set(value) | Action::LinearRamp { value, .. } => value,
        };
        if !valid_gain(value) {
            return Err(EventError::Value);
        }
        if event.frame < next_frame
            || event.frame == u64::MAX
            || matches!(event.action, Action::LinearRamp { end_frame, .. } if end_frame <= event.frame || end_frame == u64::MAX)
        {
            return Err(EventError::Time);
        }
        Ok(())
    }

    /// Versioned numeric words, with no pointers, Rust layout, or mutable DSP state.
    /// Operation inputs name earlier table slots; processor/parameter IDs remain stable.
    pub(crate) fn encode(&self, events: &[Event]) -> Result<Vec<u32>, CompileError> {
        if events.len() > EVENT_CAPACITY {
            return Err(CompileError::Capacity);
        }
        for &event in events {
            self.validate_event(event, 0)
                .map_err(|_| CompileError::Value)?;
        }
        let rate = self.sample_rate.to_bits();
        let mut words = Vec::with_capacity(
            HEADER_WORDS + self.operation_count * OP_WORDS + events.len() * EVENT_WORDS,
        );
        words.extend_from_slice(&[
            WIRE_VERSION,
            rate as u32,
            (rate >> 32) as u32,
            self.maximum_frames as u32,
            match self.layout {
                OutputLayout::Mono => 1,
                OutputLayout::Stereo => 2,
            },
            self.observation_frames as u32,
            self.operation_count as u32,
            events.len() as u32,
        ]);
        for (slot, operation) in self.operations[..self.operation_count].iter().enumerate() {
            let mut record = [0; OP_WORDS];
            record[1] = self.ids[slot];
            match *operation {
                Operation::PcmInput { spec } => {
                    record[0] = 6;
                    record[2] = spec.sample_rate;
                    record[3] = spec.source_id as u32;
                    record[4] = (spec.source_id >> 32) as u32;
                    record[5] = spec.layout.channels() as u32;
                }
                Operation::Oscillator { frequency, .. } => {
                    record[0] = 1;
                    let bits = frequency.to_bits();
                    record[5] = bits as u32;
                    record[6] = (bits >> 32) as u32;
                }
                Operation::Gain {
                    input,
                    address,
                    value,
                } => {
                    record[0] = 2;
                    record[2] = address.parameter;
                    record[3] = input as u32;
                    let bits = f64::from(value).to_bits();
                    record[5] = bits as u32;
                    record[6] = (bits >> 32) as u32;
                }
                Operation::Mix { inputs } => {
                    record[0] = 3;
                    record[3] = inputs[0] as u32;
                    record[4] = inputs[1] as u32;
                }
                Operation::Observe { input } => {
                    record[0] = 4;
                    record[3] = input as u32;
                }
                Operation::Output { input } => {
                    record[0] = 5;
                    record[3] = input as u32;
                }
            }
            words.extend_from_slice(&record);
        }
        for event in events {
            let (code, end, value) = match event.action {
                Action::Set(value) => (1, 0, value),
                Action::LinearRamp { end_frame, value } => (2, end_frame, value),
            };
            words.extend_from_slice(&[
                event.frame as u32,
                (event.frame >> 32) as u32,
                event.address.processor,
                event.address.parameter,
                code,
                end as u32,
                (end >> 32) as u32,
                value.to_bits(),
            ]);
        }
        Ok(words)
    }

    /// Bounded worklet-local validation. Recompilation verifies the closed graph;
    /// canonical comparison also rejects reserved fields and noncanonical slot order.
    pub(crate) fn decode(words: &[u32]) -> Result<(Self, Vec<Event>), CompileError> {
        if words.len() < HEADER_WORDS || words[0] != WIRE_VERSION || !matches!(words[6], 4 | 7) {
            return Err(CompileError::Description);
        }
        let event_count = words[7] as usize;
        let operation_count = words[6] as usize;
        if event_count > EVENT_CAPACITY {
            return Err(CompileError::Capacity);
        }
        if words.len() != HEADER_WORDS + operation_count * OP_WORDS + event_count * EVENT_WORDS {
            return Err(CompileError::Description);
        }
        let layout = match words[4] {
            1 => OutputLayout::Mono,
            2 => OutputLayout::Stereo,
            _ => return Err(CompileError::Layout),
        };
        let mut description =
            proof_description(f64::from_bits(join_words(words[1], words[2])), layout);
        description.maximum_frames = words[3] as usize;
        description.observation_frames = words[5] as usize;
        description.operation_count = operation_count;
        let is_pcm = operation_count == 4;
        for slot in 0..operation_count {
            let start = HEADER_WORDS + slot * OP_WORDS;
            let record = &words[start..start + OP_WORDS];
            let input = |index: u32| {
                let index = index as usize;
                if index >= slot {
                    return Err(CompileError::Topology);
                }
                Ok(Port {
                    processor: description.nodes[index].id,
                    port: 0,
                })
            };
            let value = f64::from_bits(join_words(record[5], record[6]));
            let kind = match record[0] {
                6 => NodeKind::PcmInput {
                    spec: StreamSpec {
                        sample_rate: record[2],
                        source_id: join_words(record[3], record[4]),
                        layout: match record[5] {
                            1 => ChannelLayout::Mono,
                            2 => ChannelLayout::Stereo,
                            _ => return Err(CompileError::Layout),
                        },
                    },
                },
                1 => NodeKind::Oscillator { frequency: value },
                2 => NodeKind::Gain {
                    input: input(record[3])?,
                    parameter: record[2],
                    value: value as f32,
                },
                3 => NodeKind::Mix {
                    inputs: [input(record[3])?, input(record[4])?],
                },
                4 => NodeKind::Observe {
                    input: input(record[3])?,
                },
                5 => NodeKind::Output {
                    input: input(record[3])?,
                },
                _ => return Err(CompileError::Description),
            };
            description.nodes[slot] = Node {
                id: record[1],
                layout: if record[0] == 5 || is_pcm {
                    layout
                } else {
                    OutputLayout::Mono
                },
                kind,
            };
        }
        let plan = Self::compile(&description)?;
        let mut events = Vec::with_capacity(event_count);
        for record in words[HEADER_WORDS + operation_count * OP_WORDS..]
            .as_chunks::<EVENT_WORDS>()
            .0
        {
            let value = f32::from_bits(record[7]);
            let action = match record[4] {
                1 => Action::Set(value),
                2 => Action::LinearRamp {
                    end_frame: join_words(record[5], record[6]),
                    value,
                },
                _ => return Err(CompileError::Description),
            };
            events.push(Event {
                frame: join_words(record[0], record[1]),
                address: Address {
                    processor: record[2],
                    parameter: record[3],
                },
                action,
            });
        }
        if plan.encode(&events)? != words {
            return Err(CompileError::Description);
        }
        Ok((plan, events))
    }
}

fn join_words(low: u32, high: u32) -> u64 {
    u64::from(low) | (u64::from(high) << 32)
}

fn pcm_layout(layout: ChannelLayout) -> OutputLayout {
    match layout {
        ChannelLayout::Mono => OutputLayout::Mono,
        ChannelLayout::Stereo => OutputLayout::Stereo,
    }
}

fn pcm_description(spec: StreamSpec, maximum_frames: usize) -> Description {
    let layout = pcm_layout(spec.layout);
    let port = |processor| Port { processor, port: 0 };
    let mut description = proof_description(f64::from(spec.sample_rate), layout);
    description.maximum_frames = maximum_frames;
    description.operation_count = 4;
    description.nodes[..4].copy_from_slice(&[
        Node {
            id: 10,
            layout,
            kind: NodeKind::PcmInput { spec },
        },
        Node {
            id: 20,
            layout,
            kind: NodeKind::Gain {
                input: port(10),
                parameter: 1,
                value: 0.5,
            },
        },
        Node {
            id: 60,
            layout,
            kind: NodeKind::Observe { input: port(20) },
        },
        Node {
            id: 70,
            layout,
            kind: NodeKind::Output { input: port(60) },
        },
    ]);
    description
}

fn proof_description(sample_rate: f64, layout: OutputLayout) -> Description {
    let port = |processor| Port { processor, port: 0 };
    Description {
        sample_rate,
        maximum_frames: MAXIMUM_FRAMES,
        observation_frames: 64,
        operation_count: OP_COUNT,
        nodes: [
            Node {
                id: 10,
                layout: OutputLayout::Mono,
                kind: NodeKind::Oscillator { frequency: 997.0 },
            },
            Node {
                id: 20,
                layout: OutputLayout::Mono,
                kind: NodeKind::Gain {
                    input: port(10),
                    parameter: 1,
                    value: 0.25,
                },
            },
            Node {
                id: 30,
                layout: OutputLayout::Mono,
                kind: NodeKind::Oscillator { frequency: 1499.0 },
            },
            Node {
                id: 40,
                layout: OutputLayout::Mono,
                kind: NodeKind::Gain {
                    input: port(30),
                    parameter: 1,
                    value: 0.125,
                },
            },
            Node {
                id: 50,
                layout: OutputLayout::Mono,
                kind: NodeKind::Mix {
                    inputs: [port(20), port(40)],
                },
            },
            Node {
                id: 60,
                layout: OutputLayout::Mono,
                kind: NodeKind::Observe { input: port(50) },
            },
            Node {
                id: 70,
                layout,
                kind: NodeKind::Output { input: port(60) },
            },
        ],
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Action {
    Set(f32),
    LinearRamp { end_frame: u64, value: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Event {
    pub frame: u64,
    pub address: Address,
    pub action: Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventError {
    Target,
    Value,
    Time,
    Full,
}

pub(crate) fn proof_events() -> [Event; 4] {
    let a = Address {
        processor: 20,
        parameter: 1,
    };
    let b = Address {
        processor: 40,
        parameter: 1,
    };
    [
        Event {
            frame: 17,
            address: a,
            action: Action::Set(0.5),
        },
        Event {
            frame: 31,
            address: b,
            action: Action::LinearRamp {
                end_frame: 257,
                value: 0.375,
            },
        },
        Event {
            frame: 400,
            address: a,
            action: Action::Set(0.2),
        },
        Event {
            frame: 400,
            address: a,
            action: Action::Set(0.3),
        },
    ]
}

fn valid_gain(value: f32) -> bool {
    value.is_finite() && (-1.0..=1.0).contains(&value)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ParameterState {
    value: f32,
    ramp: Option<Ramp>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Ramp {
    start: u64,
    end: u64,
    from: f32,
    to: f32,
}

impl ParameterState {
    fn at(&mut self, frame: u64) -> f32 {
        if let Some(ramp) = self.ramp {
            if frame >= ramp.end {
                self.value = ramp.to;
                self.ramp = None;
            } else {
                let fraction = (frame - ramp.start) as f64 / (ramp.end - ramp.start) as f64;
                self.value = (f64::from(ramp.from)
                    + (f64::from(ramp.to) - f64::from(ramp.from)) * fraction)
                    as f32;
            }
        }
        self.value
    }
}

/// One latest completed window. Intervals are [start, end); generators have no media coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Observation {
    pub start: u64,
    pub end: u64,
    pub location: u32,
    pub sequence: u64,
    pub dropped: u64,
    pub peak: f32,
    pub rms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Levels {
    count: usize,
    peak: f32,
    squares: f64,
    sequence: u64,
    dropped: u64,
    pending: Option<Observation>,
}

/// The sole mutable owner of phase, gain ramps, event progress, buffers, and clock.
#[derive(Debug)]
pub(crate) struct RenderInstance {
    plan: CompiledPlan,
    buffers: Box<[f32]>,
    phases: [f64; OP_COUNT],
    parameters: [ParameterState; OP_COUNT],
    events: [Option<Event>; EVENT_CAPACITY],
    event_count: usize,
    next_frame: u64,
    terminal: bool,
    levels: Levels,
}

impl RenderInstance {
    pub(crate) fn prepare(plan: &CompiledPlan) -> Self {
        let parameters = plan.operations.map(|op| ParameterState {
            value: match op {
                Operation::Gain { value, .. } => value,
                _ => 0.0,
            },
            ramp: None,
        });
        Self {
            plan: *plan,
            // Each operation has predetermined planes. PCM preserves semantic L/R.
            buffers: vec![0.0; plan.operation_count * plan.buffer_channels() * plan.maximum_frames]
                .into_boxed_slice(),
            phases: [0.0; OP_COUNT],
            parameters,
            events: [None; EVENT_CAPACITY],
            event_count: 0,
            next_frame: 0,
            terminal: false,
            levels: Levels::default(),
        }
    }

    pub(crate) fn next_frame(&self) -> u64 {
        self.next_frame
    }

    /// Fixed admission, ordered by frame then admission order. Rejection changes no state.
    pub(crate) fn schedule(&mut self, event: Event) -> Result<(), EventError> {
        self.plan.validate_event(event, self.next_frame)?;
        if self.event_count == EVENT_CAPACITY {
            return Err(EventError::Full);
        }
        let mut index = self.event_count;
        while index > 0
            && self.events[index - 1].is_some_and(|previous| previous.frame > event.frame)
        {
            self.events[index] = self.events[index - 1];
            index -= 1;
        }
        self.events[index] = Some(event);
        self.event_count += 1;
        Ok(())
    }

    pub(crate) fn take_observation(&mut self) -> Option<Observation> {
        self.levels.pending.take()
    }

    fn apply_events(&mut self, frame: u64) {
        while self.event_count > 0 {
            let Some(event) = self.events[0] else {
                break;
            };
            if event.frame != frame {
                break;
            }
            // Admission already resolved and validated this stable address.
            if let Some(slot) = self.plan.parameter_slot(event.address) {
                let state = &mut self.parameters[slot];
                let from = state.at(frame);
                match event.action {
                    Action::Set(value) => {
                        state.value = value;
                        state.ramp = None;
                    }
                    Action::LinearRamp { end_frame, value } => {
                        state.ramp = Some(Ramp {
                            start: frame,
                            end: end_frame,
                            from,
                            to: value,
                        });
                    }
                }
            }
            self.events.copy_within(1..self.event_count, 0);
            self.event_count -= 1;
            self.events[self.event_count] = None;
        }
    }

    fn observe(&mut self, sample: f32, right: Option<f32>, frame: u64) {
        let levels = &mut self.levels;
        levels.count += 1;
        levels.peak = levels.peak.max(sample.abs());
        levels.squares += f64::from(sample) * f64::from(sample);
        if let Some(right) = right {
            levels.peak = levels.peak.max(right.abs());
            levels.squares += f64::from(right) * f64::from(right);
        }
        if levels.count == self.plan.observation_frames {
            levels.sequence = levels.sequence.saturating_add(1);
            if levels.pending.is_some() {
                levels.dropped = levels.dropped.saturating_add(1);
            }
            levels.pending = Some(Observation {
                start: frame + 1 - levels.count as u64,
                end: frame + 1,
                location: self.plan.observation_location,
                sequence: levels.sequence,
                dropped: levels.dropped,
                peak: levels.peak,
                rms: (levels.squares / (levels.count * self.plan.buffer_channels()) as f64).sqrt(),
            });
            levels.count = 0;
            levels.peak = 0.0;
            levels.squares = 0.0;
        }
    }

    pub(crate) fn render(&mut self, mut output: Output<'_>) -> RenderStatus {
        let frames = match self.validate_output(&mut output) {
            Ok(0) => return RenderStatus::Rendered,
            Ok(frames) => frames,
            Err(status) => return status,
        };
        if self.plan.pcm_spec().is_some() {
            zero_output(&mut output);
            return RenderStatus::InvalidInput;
        }
        self.execute(output, frames)
    }

    /// Epoch checks and block ownership stay in PreparedPcmInput. Validate before
    /// pulling any samples, then fill the PCM operation's fixed planes once per call.
    pub(crate) fn render_pcm<S: PreparedBlockSource>(
        &mut self,
        input: &mut PreparedPcmInput<S>,
        mut output: Output<'_>,
    ) -> RenderStatus {
        let frames = match self.validate_output(&mut output) {
            Ok(0) => return RenderStatus::Rendered,
            Ok(frames) => frames,
            Err(status) => return status,
        };
        if self.plan.pcm_spec() != Some(input.spec())
            || input.maximum_frames() < self.plan.maximum_frames
        {
            zero_output(&mut output);
            return RenderStatus::InvalidInput;
        }
        // The closed PCM topology always places its sole source at slot zero.
        let (left, rest) = self.buffers.split_at_mut(self.plan.maximum_frames);
        let status = match self.plan.layout {
            OutputLayout::Mono => input.render(PcmOutput::Mono(&mut left[..frames])),
            OutputLayout::Stereo => input.render(PcmOutput::Stereo {
                left: &mut left[..frames],
                right: &mut rest[..frames],
            }),
        };
        if status != PcmRenderStatus::Rendered {
            zero_output(&mut output);
            return match status {
                PcmRenderStatus::InvalidLayout => RenderStatus::InvalidInput,
                PcmRenderStatus::CapacityExceeded => RenderStatus::CapacityExceeded,
                PcmRenderStatus::Terminal => RenderStatus::Terminal,
                PcmRenderStatus::Rendered => unreachable!(),
            };
        }
        self.execute(output, frames)
    }

    fn validate_output(&mut self, output: &mut Output<'_>) -> Result<usize, RenderStatus> {
        let frames = match (&output, self.plan.layout) {
            (Output::Mono(samples), OutputLayout::Mono) => samples.len(),
            (Output::Stereo { left, right }, OutputLayout::Stereo) if left.len() == right.len() => {
                left.len()
            }
            _ => {
                zero_output(output);
                return Err(RenderStatus::InvalidLayout);
            }
        };
        if frames == 0 {
            return Ok(0);
        }
        let failure = if self.terminal {
            Some(RenderStatus::Terminal)
        } else if frames > self.plan.maximum_frames {
            self.terminal = true;
            Some(RenderStatus::CapacityExceeded)
        } else if self.next_frame.checked_add(frames as u64).is_none() {
            Some(RenderStatus::ClockOverflow)
        } else {
            None
        };
        if let Some(status) = failure {
            zero_output(output);
            return Err(status);
        }

        Ok(frames)
    }

    fn execute(&mut self, mut output: Output<'_>, frames: usize) -> RenderStatus {
        let channels = self.plan.buffer_channels();
        let base = self.plan.maximum_frames;
        for offset in 0..frames {
            let frame = self.next_frame + offset as u64;
            self.apply_events(frame);
            for slot in 0..self.plan.operation_count {
                for channel in 0..channels {
                    let plane = |input: usize| (input * channels + channel) * base + offset;
                    let sample = match self.plan.operations[slot] {
                        Operation::PcmInput { .. } => self.buffers[plane(slot)],
                        Operation::Oscillator { increment, .. } => {
                            let sample = self.phases[slot].sin() as f32;
                            self.phases[slot] += increment;
                            if self.phases[slot] >= TAU {
                                self.phases[slot] -= TAU;
                            }
                            sample
                        }
                        Operation::Gain { input, .. } => {
                            self.buffers[plane(input)] * self.parameters[slot].at(frame)
                        }
                        Operation::Mix { inputs } => {
                            self.buffers[plane(inputs[0])] + self.buffers[plane(inputs[1])]
                        }
                        Operation::Observe { input } => {
                            let sample = self.buffers[plane(input)];
                            if channel == 0 {
                                let right =
                                    (channels == 2).then(|| self.buffers[plane(input) + base]);
                                self.observe(sample, right, frame);
                            }
                            sample
                        }
                        Operation::Output { input } => {
                            let sample = self.buffers[plane(input)];
                            match &mut output {
                                Output::Mono(samples) => samples[offset] = sample,
                                Output::Stereo { left, right } => {
                                    if channel == 0 {
                                        left[offset] = sample;
                                    }
                                    if channels == 1 || channel == 1 {
                                        right[offset] = sample;
                                    }
                                }
                            }
                            sample
                        }
                    };
                    self.buffers[plane(slot)] = sample;
                }
            }
        }
        self.next_frame += frames as u64;
        RenderStatus::Rendered
    }
}

fn zero_output(output: &mut Output<'_>) {
    match output {
        Output::Mono(samples) => samples.fill(0.0),
        Output::Stereo { left, right } => {
            left.fill(0.0);
            right.fill(0.0);
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod pcm_tests;
