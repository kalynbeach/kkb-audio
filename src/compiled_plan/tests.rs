use super::*;
use crate::tests::{
    ALLOCATOR_PROBE_LOCK, MEASURE_ALLOCATIONS, allocator_counts, reset_allocator_counts,
};
use std::hint::black_box;

fn fixture(layout: OutputLayout, automated: bool) -> RenderInstance {
    let plan = CompiledPlan::proof(48_000.0, layout).unwrap();
    let mut instance = RenderInstance::prepare(&plan);
    if automated {
        for event in proof_events() {
            instance.schedule(event).unwrap();
        }
    }
    instance
}

fn reference(frame: usize, automated: bool) -> f32 {
    let a = if !automated || frame < 17 {
        0.25
    } else if frame < 400 {
        0.5
    } else {
        0.3
    };
    let b = if !automated || frame < 31 {
        0.125
    } else if frame >= 257 {
        0.375
    } else {
        (0.125 + 0.25 * (frame - 31) as f64 / 226.0) as f32
    };
    let oscillator_a = (TAU * 997.0 * frame as f64 / 48_000.0).sin() as f32;
    let oscillator_b = (TAU * 1499.0 * frame as f64 / 48_000.0).sin() as f32;
    oscillator_a * a + oscillator_b * b
}

fn close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1.0e-6,
        "expected {expected}, got {actual}"
    );
}

fn partitioned(partitions: &[usize], automated: bool) -> (Vec<f32>, RenderInstance) {
    let mut instance = fixture(OutputLayout::Mono, automated);
    let mut result = Vec::with_capacity(partitions.iter().sum());
    for &frames in partitions {
        let offset = result.len();
        result.resize(offset + frames, f32::NAN);
        assert_eq!(
            instance.render(Output::Mono(&mut result[offset..])),
            RenderStatus::Rendered
        );
    }
    (result, instance)
}

#[test]
fn two_tone_mix_and_automated_mix_match_independent_direct_reference() {
    for automated in [false, true] {
        let (samples, instance) = partitioned(&[1_000], automated);
        for (frame, sample) in samples.into_iter().enumerate() {
            close(sample, reference(frame, automated));
        }
        assert_eq!(instance.next_frame(), 1_000);
    }
    let mut stereo = fixture(OutputLayout::Stereo, true);
    let mut left = [f32::NAN; 512];
    let mut right = [f32::NAN; 512];
    assert_ne!(left.as_ptr(), right.as_ptr());
    assert_eq!(
        stereo.render(Output::Stereo {
            left: &mut left,
            right: &mut right
        }),
        RenderStatus::Rendered
    );
    assert_eq!(left, right);
    for (frame, sample) in left.into_iter().enumerate() {
        close(sample, reference(frame, true));
    }
}

#[test]
fn topology_sort_is_stable_and_preserves_processor_and_parameter_addresses() {
    let original = proof_description(48_000.0, OutputLayout::Stereo);
    let expected = CompiledPlan::compile(&original).unwrap();
    let mut shuffled = original;
    shuffled.nodes.reverse();
    assert_eq!(CompiledPlan::compile(&shuffled).unwrap(), expected);
    shuffled.nodes.rotate_left(3);
    assert_eq!(CompiledPlan::compile(&shuffled).unwrap(), expected);
    assert_eq!(expected.ids, [10, 20, 30, 40, 50, 60, 70]);
    assert_eq!(
        expected.parameter_slot(Address {
            processor: 20,
            parameter: 1
        }),
        Some(1)
    );
    assert_eq!(
        expected.parameter_slot(Address {
            processor: 40,
            parameter: 1
        }),
        Some(3)
    );
    assert_eq!(
        expected.parameter_slot(Address {
            processor: 10,
            parameter: 1
        }),
        None
    );
}

#[test]
fn invalid_topology_ports_layouts_identifiers_values_and_capacities_fail_compilation() {
    let original = proof_description(48_000.0, OutputLayout::Mono);
    let mut invalid = original;
    // Two gain nodes depend on one another, forming a zero-delay cycle.
    invalid.nodes[1].kind = NodeKind::Gain {
        input: Port {
            processor: 40,
            port: 0,
        },
        parameter: 1,
        value: 0.25,
    };
    invalid.nodes[3].kind = NodeKind::Gain {
        input: Port {
            processor: 20,
            port: 0,
        },
        parameter: 1,
        value: 0.125,
    };
    assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Topology));
    invalid = original;
    invalid.nodes[4].kind = NodeKind::Mix {
        inputs: [Port {
            processor: 20,
            port: 0,
        }; 2],
    };
    assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Topology));
    invalid = original;
    invalid.nodes[6].kind = NodeKind::Output {
        input: Port {
            processor: 50,
            port: 0,
        },
    };
    assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Topology));
    for source in [
        Port {
            processor: 10,
            port: 1,
        },
        Port {
            processor: 70,
            port: 0,
        },
    ] {
        invalid = original;
        invalid.nodes[1].kind = NodeKind::Gain {
            input: source,
            parameter: 1,
            value: 0.25,
        };
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Port));
    }
    for id in [0, 10] {
        invalid = original;
        invalid.nodes[1].id = id;
        assert_eq!(
            CompiledPlan::compile(&invalid),
            Err(CompileError::Identifier)
        );
    }
    invalid = original;
    invalid.nodes[1].kind = NodeKind::Gain {
        input: Port {
            processor: 999,
            port: 0,
        },
        parameter: 1,
        value: 0.25,
    };
    assert_eq!(
        CompiledPlan::compile(&invalid),
        Err(CompileError::Identifier)
    );
    invalid = original;
    invalid.nodes[1].kind = NodeKind::Gain {
        input: Port {
            processor: 10,
            port: 0,
        },
        parameter: 0,
        value: 0.25,
    };
    assert_eq!(
        CompiledPlan::compile(&invalid),
        Err(CompileError::Identifier)
    );
    invalid = original;
    invalid.nodes[0].layout = OutputLayout::Stereo;
    assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Layout));
    for capacity in [0, MAXIMUM_FRAMES + 1, usize::MAX] {
        invalid = original;
        invalid.maximum_frames = capacity;
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Capacity));
        invalid = original;
        invalid.observation_frames = capacity;
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Capacity));
    }
    for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        invalid = original;
        invalid.sample_rate = rate;
        assert_eq!(
            CompiledPlan::compile(&invalid),
            Err(CompileError::SampleRate)
        );
    }
    for frequency in [-1.0, 24_000.0, f64::NAN, f64::INFINITY] {
        invalid = original;
        invalid.nodes[0].kind = NodeKind::Oscillator { frequency };
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Value));
    }
    for value in [-1.01, 1.01, f32::NAN, f32::INFINITY] {
        invalid = original;
        invalid.nodes[1].kind = NodeKind::Gain {
            input: Port {
                processor: 10,
                port: 0,
            },
            parameter: 1,
            value,
        };
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Value));
    }
}

#[test]
fn audio_automation_and_observation_windows_are_partition_independent() {
    for automated in [false, true] {
        let (expected, expected_instance) = partitioned(&[1_000], automated);
        // Boundaries include event start/end, zeros, and irregular callback sizes.
        let mut partitions = vec![0, 17, 0, 14, 1, 64, 128, 33, 0, 1, 142, 0, 1];
        partitions.push(1_000 - partitions.iter().sum::<usize>());
        for partitions in [partitions, vec![1; 1_000]] {
            let (actual, actual_instance) = partitioned(&partitions, automated);
            assert_eq!(
                expected.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                actual.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
            );
            assert_eq!(actual_instance.phases, expected_instance.phases);
            assert_eq!(actual_instance.parameters, expected_instance.parameters);
            assert_eq!(actual_instance.events, expected_instance.events);
            assert_eq!(actual_instance.next_frame, expected_instance.next_frame);
            assert_eq!(actual_instance.levels, expected_instance.levels);
        }
    }
}

#[test]
fn ramps_include_start_and_endpoint_and_same_frame_events_use_admission_order() {
    let mut instance = fixture(OutputLayout::Mono, true);
    let mut prefix = [0.0; 31];
    assert_eq!(
        instance.render(Output::Mono(&mut prefix)),
        RenderStatus::Rendered
    );
    assert_eq!(instance.parameters[3].value, 0.125);
    let mut sample = [0.0];
    instance.render(Output::Mono(&mut sample));
    close(sample[0], reference(31, true));
    assert_eq!(instance.parameters[3].value, 0.125);
    instance.render(Output::Mono(&mut [0.0; 225]));
    assert_eq!(instance.next_frame, 257);
    assert!(instance.parameters[3].ramp.is_some());
    instance.render(Output::Mono(&mut sample));
    close(sample[0], reference(257, true));
    assert_eq!(instance.parameters[3].value, 0.375);
    assert_eq!(instance.parameters[3].ramp, None);
    instance.render(Output::Mono(&mut [0.0; 142]));
    instance.render(Output::Mono(&mut sample));
    close(sample[0], reference(400, true));
    assert_eq!(instance.parameters[1].value, 0.3);

    let mut interrupted = fixture(OutputLayout::Mono, false);
    let address = Address {
        processor: 20,
        parameter: 1,
    };
    // Admission is deliberately out of timestamp order. At frame 5 the old
    // ramp is evaluated, Set overrides it, then the new ramp starts from Set.
    for event in [
        Event {
            frame: 5,
            address,
            action: Action::Set(-0.5),
        },
        Event {
            frame: 0,
            address,
            action: Action::LinearRamp {
                end_frame: 10,
                value: 0.75,
            },
        },
        Event {
            frame: 5,
            address,
            action: Action::LinearRamp {
                end_frame: 7,
                value: 0.5,
            },
        },
    ] {
        interrupted.schedule(event).unwrap();
    }
    interrupted.render(Output::Mono(&mut [0.0; 5]));
    assert_eq!(interrupted.parameters[1].value, 0.45);
    interrupted.render(Output::Mono(&mut sample));
    assert_eq!(interrupted.parameters[1].value, -0.5);
    interrupted.render(Output::Mono(&mut sample));
    assert_eq!(interrupted.parameters[1].value, 0.0);
    interrupted.render(Output::Mono(&mut sample));
    assert_eq!(interrupted.parameters[1].value, 0.5);
}

#[test]
fn ramp_uses_checked_integer_offsets_near_the_clock_limit() {
    let mut instance = fixture(OutputLayout::Mono, false);
    instance.next_frame = u64::MAX - 8;
    instance
        .schedule(Event {
            frame: u64::MAX - 8,
            address: Address {
                processor: 20,
                parameter: 1,
            },
            action: Action::LinearRamp {
                end_frame: u64::MAX - 4,
                value: 0.75,
            },
        })
        .unwrap();
    instance.render(Output::Mono(&mut [0.0; 3]));
    assert_eq!(instance.parameters[1].value, 0.5);
    instance.render(Output::Mono(&mut [0.0; 2]));
    assert_eq!(instance.parameters[1].value, 0.75);
}

#[test]
fn event_rejections_are_atomic_and_consumption_reclaims_fixed_capacity() {
    let mut instance = fixture(OutputLayout::Mono, false);
    let address = Address {
        processor: 20,
        parameter: 1,
    };
    instance.render(Output::Mono(&mut [0.0; 1]));
    for (event, error) in [
        (
            Event {
                frame: 1,
                address: Address {
                    processor: 30,
                    parameter: 1,
                },
                action: Action::Set(0.5),
            },
            EventError::Target,
        ),
        (
            Event {
                frame: 1,
                address,
                action: Action::Set(f32::NAN),
            },
            EventError::Value,
        ),
        (
            Event {
                frame: 1,
                address,
                action: Action::Set(1.1),
            },
            EventError::Value,
        ),
        (
            Event {
                frame: 0,
                address,
                action: Action::Set(0.5),
            },
            EventError::Time,
        ),
        (
            Event {
                frame: u64::MAX,
                address,
                action: Action::Set(0.5),
            },
            EventError::Time,
        ),
        (
            Event {
                frame: 1,
                address,
                action: Action::LinearRamp {
                    end_frame: 1,
                    value: 0.5,
                },
            },
            EventError::Time,
        ),
        (
            Event {
                frame: 2,
                address,
                action: Action::LinearRamp {
                    end_frame: 1,
                    value: 0.5,
                },
            },
            EventError::Time,
        ),
        (
            Event {
                frame: 1,
                address,
                action: Action::LinearRamp {
                    end_frame: u64::MAX,
                    value: 0.5,
                },
            },
            EventError::Time,
        ),
    ] {
        assert_eq!(instance.schedule(event), Err(error));
        assert_eq!(instance.event_count, 0);
        assert_eq!(instance.events, [None; EVENT_CAPACITY]);
    }
    let event = Event {
        frame: 1,
        address,
        action: Action::Set(0.5),
    };
    for _ in 0..EVENT_CAPACITY {
        instance.schedule(event).unwrap();
    }
    let before = instance.events;
    assert_eq!(instance.schedule(event), Err(EventError::Full));
    assert_eq!(instance.events, before);
    instance.render(Output::Mono(&mut [0.0; 1]));
    assert_eq!(instance.event_count, 0);
    instance.schedule(Event { frame: 2, ..event }).unwrap();
}

#[test]
fn observations_measure_final_output_and_report_overwritten_windows() {
    let mut instance = fixture(OutputLayout::Stereo, true);
    assert_eq!(instance.take_observation(), None);
    let mut left = [0.0; 64];
    let mut right = [0.0; 64];
    for sequence in 1..=3 {
        instance.render(Output::Stereo {
            left: &mut left,
            right: &mut right,
        });
        let observation = instance.take_observation().unwrap();
        assert_eq!(observation.location, 60);
        assert_eq!(observation.start, (sequence - 1) * 64);
        assert_eq!(observation.end, sequence * 64);
        assert_eq!(observation.sequence, sequence);
        assert_eq!(observation.dropped, 0);
        let peak = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        let rms = (left.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / 64.0).sqrt();
        assert_eq!(observation.peak, peak);
        assert!((observation.rms - rms).abs() <= 1.0e-12);
        assert_eq!(instance.take_observation(), None);
    }
    instance.render(Output::Stereo {
        left: &mut [0.0; 129],
        right: &mut [0.0; 129],
    });
    let observation = instance.take_observation().unwrap();
    assert_eq!(
        (
            observation.start,
            observation.end,
            observation.sequence,
            observation.dropped
        ),
        (256, 320, 5, 1)
    );
    assert_eq!(instance.levels.count, 1);
    instance.levels.sequence = u64::MAX;
    instance.levels.dropped = u64::MAX;
    instance.render(Output::Stereo {
        left: &mut [0.0; 128],
        right: &mut [0.0; 128],
    });
    let observation = instance.take_observation().unwrap();
    assert_eq!(observation.sequence, u64::MAX);
    assert_eq!(observation.dropped, u64::MAX);
}

#[test]
fn two_instances_from_one_plan_own_separate_dsp_clocks_events_and_storage() {
    let plan = CompiledPlan::proof(48_000.0, OutputLayout::Mono).unwrap();
    let mut first = RenderInstance::prepare(&plan);
    let mut second = RenderInstance::prepare(&plan);
    assert_ne!(first.buffers.as_ptr(), second.buffers.as_ptr());
    first.schedule(proof_events()[0]).unwrap();
    first.render(Output::Mono(&mut [0.0; 257]));
    assert_eq!(second.next_frame, 0);
    assert_eq!(second.phases, [0.0; OP_COUNT]);
    assert_eq!(second.event_count, 0);
    assert_eq!(second.take_observation(), None);
    let mut samples = [0.0; 128];
    second.render(Output::Mono(&mut samples));
    for (frame, sample) in samples.into_iter().enumerate() {
        close(sample, reference(frame, false));
    }
    assert_eq!(first.next_frame, 257);
}

#[derive(Debug, PartialEq)]
struct State {
    phases: [f64; OP_COUNT],
    parameters: [ParameterState; OP_COUNT],
    events: [Option<Event>; EVENT_CAPACITY],
    event_count: usize,
    next_frame: u64,
    levels: Levels,
    buffers: Vec<f32>,
}

fn state(instance: &RenderInstance) -> State {
    State {
        phases: instance.phases,
        parameters: instance.parameters,
        events: instance.events,
        event_count: instance.event_count,
        next_frame: instance.next_frame,
        levels: instance.levels,
        buffers: instance.buffers.to_vec(),
    }
}

#[test]
fn zero_invalid_layout_capacity_and_clock_failures_preserve_render_state() {
    for layout in [OutputLayout::Mono, OutputLayout::Stereo] {
        let mut instance = fixture(layout, true);
        let before = state(&instance);
        let mut guarded = [17.0, 23.0];
        let mut empty = [];
        let output = match layout {
            OutputLayout::Mono => Output::Mono(&mut guarded[1..1]),
            OutputLayout::Stereo => Output::Stereo {
                left: &mut guarded[1..1],
                right: &mut empty,
            },
        };
        assert_eq!(instance.render(output), RenderStatus::Rendered);
        assert_eq!(guarded, [17.0, 23.0]);
        assert_eq!(state(&instance), before);
        let mut left = [1.0; 1];
        let mut right = [1.0; 2];
        assert_eq!(
            instance.render(Output::Stereo {
                left: &mut left,
                right: &mut right
            }),
            RenderStatus::InvalidLayout
        );
        assert!(left.iter().chain(right.iter()).all(|s| s.to_bits() == 0));
        assert_eq!(state(&instance), before);

        let mut left = [1.0; MAXIMUM_FRAMES + 1];
        let mut right = [1.0; MAXIMUM_FRAMES + 1];
        let output = match layout {
            OutputLayout::Mono => Output::Mono(&mut left),
            OutputLayout::Stereo => Output::Stereo {
                left: &mut left,
                right: &mut right,
            },
        };
        assert_eq!(instance.render(output), RenderStatus::CapacityExceeded);
        assert!(left.iter().all(|s| s.to_bits() == 0));
        if layout == OutputLayout::Stereo {
            assert!(right.iter().all(|s| s.to_bits() == 0));
        }
        assert_eq!(state(&instance), before);
        assert!(instance.terminal);
        let output = match layout {
            OutputLayout::Mono => Output::Mono(&mut left[..1]),
            OutputLayout::Stereo => Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1],
            },
        };
        assert_eq!(instance.render(output), RenderStatus::Terminal);
        let output = match layout {
            OutputLayout::Mono => Output::Mono(&mut []),
            OutputLayout::Stereo => Output::Stereo {
                left: &mut [],
                right: &mut [],
            },
        };
        assert_eq!(instance.render(output), RenderStatus::Rendered);
        assert_eq!(state(&instance), before);
    }
    let mut instance = fixture(OutputLayout::Mono, false);
    instance.next_frame = u64::MAX - 1;
    let before = state(&instance);
    let mut output = [1.0; 2];
    assert_eq!(
        instance.render(Output::Mono(&mut output)),
        RenderStatus::ClockOverflow
    );
    assert_eq!(output, [0.0; 2]);
    assert_eq!(state(&instance), before);
    assert!(!instance.terminal);
    assert_eq!(
        instance.render(Output::Mono(&mut output[..1])),
        RenderStatus::Rendered
    );
    assert_eq!(instance.next_frame(), u64::MAX);
}

#[test]
fn versioned_description_round_trip_revalidates_program_and_event_limits() {
    let plan = CompiledPlan::proof(48_000.0, OutputLayout::Stereo).unwrap();
    let words = plan.encode(&proof_events()).unwrap();
    let (decoded, events) = CompiledPlan::decode(&words).unwrap();
    assert_eq!(decoded, plan);
    assert_eq!(events, proof_events());
    for end in 0..words.len() {
        assert!(CompiledPlan::decode(&words[..end]).is_err());
    }
    let mut extra = words.clone();
    extra.push(0);
    assert!(CompiledPlan::decode(&extra).is_err());
    let event_offset = HEADER_WORDS + OP_COUNT * OP_WORDS;
    for (offset, value) in [
        (0, 2),
        (3, 0),
        (3, u32::MAX),
        (4, 3),
        (5, 0),
        (6, 8),
        (7, 17),
        (HEADER_WORDS, 99),
        (HEADER_WORDS + 1, 0),
        (HEADER_WORDS + 7, 1),
        (HEADER_WORDS + OP_WORDS + 1, 10),
        (HEADER_WORDS + OP_WORDS + 2, 0),
        (HEADER_WORDS + OP_WORDS + 3, 6),
        (event_offset + 2, 999),
        (event_offset + 4, 99),
        (event_offset + 5, 1),
        (event_offset + 7, f32::NAN.to_bits()),
        (event_offset + EVENT_WORDS + 5, 30),
    ] {
        let mut invalid = words.clone();
        invalid[offset] = value;
        assert!(
            CompiledPlan::decode(&invalid).is_err(),
            "accepted word {offset} = {value}"
        );
    }
    assert_eq!(
        plan.encode(&[proof_events()[0]; EVENT_CAPACITY + 1]),
        Err(CompileError::Capacity)
    );
}

#[test]
fn repeated_rendering_retains_prepared_storage_and_has_no_observed_allocator_calls() {
    let _guard = ALLOCATOR_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    MEASURE_ALLOCATIONS.with(|active| active.set(false));
    // Warm the paths, then exercise the same paths with measurement enabled.
    for measured in [false, true] {
        let mut instance = fixture(OutputLayout::Mono, true);
        let mut clock_limit = fixture(OutputLayout::Mono, false);
        clock_limit.next_frame = u64::MAX;
        let pointer = instance.buffers.as_ptr();
        let length = instance.buffers.len();
        let mut output = [0.0; MAXIMUM_FRAMES];
        let mut oversized = [1.0; MAXIMUM_FRAMES + 1];
        let mut wrong = [1.0; 3];
        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(measured));
        for _ in 0..32 {
            black_box(instance.render(Output::Mono(black_box(&mut output))));
            black_box(instance.take_observation());
        }
        black_box(instance.render(Output::Mono(&mut [])));
        black_box(instance.render(Output::Stereo {
            left: &mut output[..2],
            right: &mut wrong,
        }));
        black_box(clock_limit.render(Output::Mono(&mut output[..1])));
        let event = Event {
            frame: instance.next_frame(),
            address: Address {
                processor: 20,
                parameter: 1,
            },
            action: Action::Set(0.5),
        };
        for _ in 0..EVENT_CAPACITY {
            black_box(instance.schedule(event)).unwrap();
        }
        let full = black_box(instance.schedule(event));
        black_box(instance.render(Output::Mono(&mut output[..1])));
        let capacity = black_box(instance.render(Output::Mono(&mut oversized)));
        let terminal = black_box(instance.render(Output::Mono(&mut output[..1])));
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        assert_eq!(allocator_counts(), [0; 4]);
        assert_eq!(full, Err(EventError::Full));
        assert_eq!(capacity, RenderStatus::CapacityExceeded);
        assert_eq!(terminal, RenderStatus::Terminal);
        assert_eq!(instance.buffers.as_ptr(), pointer);
        assert_eq!(instance.buffers.len(), length);
    }
}
