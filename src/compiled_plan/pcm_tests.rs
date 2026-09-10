use super::*;
use crate::prepared_pcm::{BlockMeta, OwnedPcmBlock, PcmCounters};
use crate::tests::{
    ALLOCATOR_PROBE_LOCK, MEASURE_ALLOCATIONS, allocator_counts, reset_allocator_counts,
};
use std::hint::black_box;

struct Source {
    ready: [Option<OwnedPcmBlock>; 4],
    retired: [Option<OwnedPcmBlock>; 4],
    backpressure: bool,
}

impl PreparedBlockSource for Source {
    type Block = OwnedPcmBlock;

    fn pop_ready(&mut self) -> Option<Self::Block> {
        self.ready.iter_mut().find(|block| block.is_some())?.take()
    }

    fn retire(&mut self, block: Self::Block) -> Result<(), Self::Block> {
        if self.backpressure {
            return Err(block);
        }
        let slot = block.meta.slot_id as usize;
        assert!(self.retired[slot].is_none());
        self.retired[slot] = Some(block);
        Ok(())
    }

    fn scan_limit(&self) -> usize {
        4
    }
}

fn spec(layout: ChannelLayout) -> StreamSpec {
    StreamSpec {
        layout,
        sample_rate: 48_000,
        source_id: u64::MAX - 1,
    }
}

fn block(
    slot_id: u32,
    layout: ChannelLayout,
    epoch: u64,
    start: u64,
    frames: usize,
) -> OwnedPcmBlock {
    let mut block = OwnedPcmBlock::new(slot_id, layout, frames);
    block.meta = BlockMeta {
        slot_id,
        epoch,
        pcm_frame_start: start,
        valid_frames: frames,
        discontinuity: slot_id == 0,
        end_of_stream: false,
    };
    for frame in 0..frames {
        // Different values and magnitudes detect channel duplication and RMS errors.
        block.left[frame] = (start + frame as u64 + 1) as f32 / 4_096.0;
        if layout == ChannelLayout::Stereo {
            block.right[frame] = -block.left[frame] * 0.25;
        }
    }
    block
}

fn input(
    layout: ChannelLayout,
    maximum: usize,
    blocks: [Option<OwnedPcmBlock>; 4],
) -> PreparedPcmInput<Source> {
    PreparedPcmInput::new(
        spec(layout),
        1,
        maximum,
        Source {
            ready: blocks,
            retired: std::array::from_fn(|_| None),
            backpressure: false,
        },
    )
    .unwrap()
}

fn render_partitioned(
    layout: ChannelLayout,
    partitions: &[usize],
) -> (Vec<f32>, Vec<f32>, RenderInstance, PcmCounters) {
    let plan = CompiledPlan::pcm_proof(spec(layout), 1_024).unwrap();
    let mut instance = RenderInstance::prepare(&plan);
    instance
        .schedule(Event {
            frame: 17,
            address: Address {
                processor: 20,
                parameter: 1,
            },
            action: Action::Set(0.25),
        })
        .unwrap();
    instance
        .schedule(Event {
            frame: 31,
            address: Address {
                processor: 20,
                parameter: 1,
            },
            action: Action::LinearRamp {
                end_frame: 257,
                value: 0.75,
            },
        })
        .unwrap();
    let mut pcm = input(
        layout,
        1_024,
        std::array::from_fn(|slot| Some(block(slot as u32, layout, 1, slot as u64 * 257, 257))),
    );
    let mut left = vec![f32::NAN; 1_000];
    let mut right = vec![f32::NAN; 1_000];
    let mut start = 0;
    for &frames in partitions {
        let output = match layout {
            ChannelLayout::Mono => Output::Mono(&mut left[start..start + frames]),
            ChannelLayout::Stereo => Output::Stereo {
                left: &mut left[start..start + frames],
                right: &mut right[start..start + frames],
            },
        };
        assert_eq!(
            instance.render_pcm(&mut pcm, output),
            RenderStatus::Rendered
        );
        start += frames;
    }
    assert_eq!(start, 1_000);
    (left, right, instance, pcm.counters())
}

#[test]
fn pcm_gain_automation_channels_and_observations_are_partition_independent() {
    for layout in [ChannelLayout::Mono, ChannelLayout::Stereo] {
        let (left, right, mut whole, counters) = render_partitioned(layout, &[1_000]);
        for partitions in [vec![1; 1_000], vec![0, 17, 14, 225, 1, 0, 257, 128, 358]] {
            let (other_left, other_right, other, other_counters) =
                render_partitioned(layout, &partitions);
            assert_eq!(other_left, left);
            if layout == ChannelLayout::Stereo {
                assert_eq!(other_right, right);
            }
            assert_eq!(other.next_frame, whole.next_frame);
            assert_eq!(other.parameters, whole.parameters);
            assert_eq!(other.levels, whole.levels);
            assert_eq!(other_counters, counters);
        }
        for frame in 0..1_000 {
            let gain = if frame < 17 {
                0.5
            } else if frame < 31 {
                0.25
            } else if frame < 257 {
                (0.25 + 0.5 * (frame - 31) as f64 / 226.0) as f32
            } else {
                0.75
            };
            let expected = (frame + 1) as f32 / 4_096.0 * gain;
            assert_eq!(left[frame], expected);
            if layout == ChannelLayout::Stereo {
                assert_eq!(right[frame], -expected * 0.25);
            }
        }
        let observation = whole.take_observation().unwrap();
        assert_eq!(
            (observation.start, observation.end, observation.sequence),
            (896, 960, 15)
        );
        let planes = if layout == ChannelLayout::Stereo {
            vec![&left, &right]
        } else {
            vec![&left]
        };
        let samples: Vec<_> = (896..960)
            .flat_map(|frame| planes.iter().map(move |plane| plane[frame]))
            .collect();
        let squares: f64 = samples
            .iter()
            .map(|&sample| f64::from(sample).powi(2))
            .sum();
        assert_eq!(
            observation.peak,
            samples
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
        );
        assert_eq!(observation.rms, (squares / samples.len() as f64).sqrt());
        assert_eq!(whole.next_frame(), 1_000);
    }
}

#[test]
fn pcm_compilation_and_wire_reject_incompatible_streams_and_preserve_identity() {
    for layout in [ChannelLayout::Mono, ChannelLayout::Stereo] {
        let original = pcm_description(spec(layout), 4_096);
        let plan = CompiledPlan::compile(&original).unwrap();
        let mut shuffled = original;
        shuffled.nodes[..4].rotate_left(2);
        assert_eq!(CompiledPlan::compile(&shuffled).unwrap(), plan);
        let words = plan.encode(&[]).unwrap();
        assert_eq!(words.len(), HEADER_WORDS + 4 * OP_WORDS);
        assert_eq!(CompiledPlan::decode(&words).unwrap().0, plan);
        assert_eq!(plan.pcm_spec(), Some(spec(layout)));
        for (offset, value) in [
            (0, 1),
            (6, 7),
            (HEADER_WORDS + 2, 44_100),
            (HEADER_WORDS + 5, 3),
            (HEADER_WORDS + 7, 1),
            (HEADER_WORDS + OP_WORDS + 3, 2),
        ] {
            let mut invalid = words.clone();
            invalid[offset] = value;
            assert!(CompiledPlan::decode(&invalid).is_err());
        }
        for end in 0..words.len() {
            assert!(CompiledPlan::decode(&words[..end]).is_err());
        }
        let mut invalid = original;
        invalid.nodes[1].layout = if layout == ChannelLayout::Mono {
            OutputLayout::Stereo
        } else {
            OutputLayout::Mono
        };
        assert_eq!(CompiledPlan::compile(&invalid), Err(CompileError::Layout));
        invalid = original;
        invalid.sample_rate = 44_100.0;
        assert_eq!(
            CompiledPlan::compile(&invalid),
            Err(CompileError::SampleRate)
        );
        for maximum in [0, PCM_MAXIMUM_FRAMES + 1, usize::MAX] {
            assert_eq!(
                CompiledPlan::pcm_proof(spec(layout), maximum),
                Err(CompileError::Capacity)
            );
        }
    }
}

#[test]
fn rejected_and_zero_calls_do_not_consume_pcm_or_advance_plan_state() {
    let layout = ChannelLayout::Stereo;
    let plan = CompiledPlan::pcm_proof(spec(layout), 64).unwrap();
    let mut instance = RenderInstance::prepare(&plan);
    let mut pcm = input(
        layout,
        64,
        [Some(block(0, layout, 1, 0, 64)), None, None, None],
    );
    let mut left = [1.0; 65];
    let mut right = [1.0; 65];
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut [],
                right: &mut []
            }
        ),
        RenderStatus::Rendered
    );
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..2],
                right: &mut right[..1]
            }
        ),
        RenderStatus::InvalidLayout
    );
    assert_eq!(&left[..2], &[0.0; 2]);
    assert_eq!(right[0], 0.0);
    instance.next_frame = u64::MAX;
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1]
            }
        ),
        RenderStatus::ClockOverflow
    );
    instance.next_frame = 0;
    // Omitting the seam cannot replay a previous input plane.
    assert_eq!(
        instance.render(Output::Stereo {
            left: &mut left[..1],
            right: &mut right[..1]
        }),
        RenderStatus::InvalidInput
    );
    for bad_spec in [
        StreamSpec {
            source_id: 7,
            ..spec(layout)
        },
        StreamSpec {
            sample_rate: 44_100,
            ..spec(layout)
        },
        spec(ChannelLayout::Mono),
    ] {
        let mut mismatch = RenderInstance::prepare(&CompiledPlan::pcm_proof(bad_spec, 64).unwrap());
        let output = if bad_spec.layout == ChannelLayout::Mono {
            Output::Mono(&mut left[..1])
        } else {
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1],
            }
        };
        assert_eq!(
            mismatch.render_pcm(&mut pcm, output),
            RenderStatus::InvalidInput
        );
    }
    assert!(pcm.source_mut().ready[0].is_some());
    assert_eq!(pcm.counters(), PcmCounters::default());
    assert_eq!(instance.next_frame(), 0);
    assert_eq!(instance.levels, Levels::default());
    let mut too_small = input(
        layout,
        63,
        [Some(block(0, layout, 1, 0, 8)), None, None, None],
    );
    assert_eq!(
        instance.render_pcm(
            &mut too_small,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1],
            }
        ),
        RenderStatus::InvalidInput
    );
    assert!(too_small.source_mut().ready[0].is_some());
    // An independently terminal input also cannot advance the plan.
    assert_eq!(
        too_small.render(PcmOutput::Stereo {
            left: &mut left,
            right: &mut right
        }),
        PcmRenderStatus::CapacityExceeded
    );
    let mut smaller_plan =
        RenderInstance::prepare(&CompiledPlan::pcm_proof(spec(layout), 63).unwrap());
    assert_eq!(
        smaller_plan.render_pcm(
            &mut too_small,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1],
            }
        ),
        RenderStatus::Terminal
    );
    assert_eq!(smaller_plan.next_frame(), 0);
    assert!(too_small.source_mut().ready[0].is_some());
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left,
                right: &mut right
            }
        ),
        RenderStatus::CapacityExceeded
    );
    assert!(
        left.iter()
            .chain(&right)
            .all(|sample| sample.to_bits() == 0)
    );
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1]
            }
        ),
        RenderStatus::Terminal
    );
    assert!(pcm.source_mut().ready[0].is_some());
    assert_eq!(pcm.counters(), PcmCounters::default());
}

#[test]
fn epoch_changes_retire_partial_blocks_and_starvation_recovers_without_replaying_pcm() {
    let layout = ChannelLayout::Stereo;
    let mut instance = RenderInstance::prepare(&CompiledPlan::pcm_proof(spec(layout), 64).unwrap());
    let mut pcm = input(
        layout,
        64,
        [Some(block(0, layout, 1, 0, 8)), None, None, None],
    );
    let mut left = [0.0; 4];
    let mut right = [0.0; 4];
    assert_eq!(
        instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1]
            }
        ),
        RenderStatus::Rendered
    );
    pcm.set_active_epoch(2);
    pcm.source_mut().ready[1] = Some(block(1, layout, 1, 8, 4));
    pcm.source_mut().ready[2] = Some(block(2, layout, 3, 12, 4));
    pcm.source_mut().ready[3] = Some(block(3, layout, 2, 16, 2));
    instance.render_pcm(
        &mut pcm,
        Output::Stereo {
            left: &mut left,
            right: &mut right,
        },
    );
    assert_eq!(left, [17.0 / 8_192.0, 18.0 / 8_192.0, 0.0, 0.0]);
    assert_eq!(right[..2], [-17.0 / 32_768.0, -18.0 / 32_768.0]);
    assert_eq!(pcm.counters().stale_blocks, 2);
    assert_eq!(pcm.counters().invalid_blocks, 1);
    assert_eq!(pcm.counters().starvation_callbacks, 1);
    assert!(pcm.source_mut().retired.iter().all(Option::is_some));
    instance.render_pcm(
        &mut pcm,
        Output::Stereo {
            left: &mut left,
            right: &mut right,
        },
    );
    assert!(
        left.iter()
            .chain(&right)
            .all(|sample| sample.to_bits() == 0)
    );
    let mut recycled = pcm.source_mut().retired[0].take().unwrap();
    recycled.meta.epoch = 2;
    recycled.meta.end_of_stream = true;
    pcm.source_mut().ready[0] = Some(recycled);
    instance.render_pcm(
        &mut pcm,
        Output::Stereo {
            left: &mut left,
            right: &mut right,
        },
    );
    assert_eq!(left[0], 1.0 / 8_192.0);
    assert_eq!(instance.next_frame(), 13);
    instance.render_pcm(
        &mut pcm,
        Output::Stereo {
            left: &mut left,
            right: &mut right,
        },
    );
    instance.render_pcm(
        &mut pcm,
        Output::Stereo {
            left: &mut left,
            right: &mut right,
        },
    );
    assert!(
        left.iter()
            .chain(&right)
            .all(|sample| sample.to_bits() == 0)
    );
    assert_eq!(
        pcm.counters().starvation_callbacks,
        2,
        "EOS silence is not starvation"
    );
}

#[test]
fn pcm_render_retains_ownership_under_retirement_backpressure_without_allocator_calls() {
    let _guard = ALLOCATOR_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    MEASURE_ALLOCATIONS.with(|active| active.set(false));
    for measured in [false, true] {
        let layout = ChannelLayout::Stereo;
        let mut instance =
            RenderInstance::prepare(&CompiledPlan::pcm_proof(spec(layout), 64).unwrap());
        let mut pcm = input(
            layout,
            64,
            [
                Some(block(0, layout, 1, 0, 1)),
                Some(block(1, layout, 1, 1, 64)),
                None,
                None,
            ],
        );
        let address = pcm.source_mut().ready[0].as_ref().unwrap().left.as_ptr();
        let buffers = instance.buffers.as_ptr();
        pcm.source_mut().backpressure = true;
        let mut left = [0.0; 65];
        let mut right = [0.0; 65];
        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(measured));
        for _ in 0..2 {
            black_box(instance.render_pcm(
                &mut pcm,
                Output::Stereo {
                    left: &mut left[..64],
                    right: &mut right[..64],
                },
            ));
        }
        pcm.source_mut().backpressure = false;
        black_box(instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..64],
                right: &mut right[..64],
            },
        ));
        black_box(instance.take_observation());
        black_box(instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut [],
                right: &mut [],
            },
        ));
        black_box(instance.render_pcm(&mut pcm, Output::Mono(&mut left[..1])));
        black_box(instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left,
                right: &mut right,
            },
        ));
        black_box(instance.render_pcm(
            &mut pcm,
            Output::Stereo {
                left: &mut left[..1],
                right: &mut right[..1],
            },
        ));
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        assert_eq!(allocator_counts(), [0; 4]);
        assert_eq!(
            pcm.source_mut().retired[0].as_ref().unwrap().left.as_ptr(),
            address
        );
        assert_eq!(instance.buffers.as_ptr(), buffers);
        assert_eq!(pcm.counters().retirement_backpressure, 2);
        assert_eq!(pcm.counters().starvation_callbacks, 2);
        assert_eq!(instance.next_frame(), 192);
    }
}
