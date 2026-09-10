use super::*;

pub(crate) fn convert(
    source_rate: u32,
    output_rate: u32,
    input: &[Vec<f32>],
    partition: &[usize],
) -> Vec<Vec<f32>> {
    let mut converter =
        PreparedRateConverter::new(source_rate, output_rate, input.len(), input[0].len() as u64)
            .unwrap();
    drive(&mut converter, input, partition)
}
fn drive(
    converter: &mut PreparedRateConverter,
    input: &[Vec<f32>],
    partition: &[usize],
) -> Vec<Vec<f32>> {
    let mut output = vec![Vec::new(); input.len()];
    let mut turn = 0;
    let remaining = (converter.total_pcm_frames() - converter.pcm_consumed) as usize;
    while output[0].len() < remaining {
        let needed = converter
            .input_frames_needed()
            .min(partition[turn % partition.len()]);
        if needed > 0 {
            let start = converter.source_frames_read() as usize;
            let data: Vec<_> = input
                .iter()
                .flat_map(|plane| plane[start..start + needed].iter().copied())
                .collect();
            converter.push(&data).unwrap();
        }
        let available = converter
            .available_frames()
            .min(partition[(turn + 1) % partition.len()]);
        for (channel, plane) in output.iter_mut().enumerate() {
            plane.extend_from_slice(&converter.output(channel)[..available]);
        }
        converter.consume(available).unwrap();
        turn += 1;
        assert!(turn < input[0].len() * 4 + 10000);
    }
    assert_eq!(converter.source_frames_read(), input[0].len() as u64);
    assert_eq!(converter.available_frames(), 0);
    output
}

#[test]
fn finite_length_partition_independence_same_rate_bypass_and_reset() {
    for (source, target) in [
        (44100, 48000),
        (48000, 44100),
        (48000, 48000),
        (32000, 32000),
    ] {
        for total in [1, 2, 17, 256, 1024, 1176, 1280, 1281, 4096, 5003] {
            let input: Vec<Vec<f32>> = (0..2)
                .map(|ch| {
                    (0..total)
                        .map(|i| ((i * (ch + 1)) as f32 / 17.0).sin() * 0.1)
                        .collect()
                })
                .collect();
            let reference = convert(source, target, &input, &[4096]);
            assert_eq!(
                reference[0].len(),
                (total * target as usize).div_ceil(source as usize)
            );
            assert_eq!(
                reference,
                convert(source, target, &input, &[1, 17, 256, 7, 1024])
            );
            if source == target {
                assert_eq!(reference, input);
            }
            let mut converter =
                PreparedRateConverter::new(source, target, 2, total as u64).unwrap();
            assert_eq!(reference, drive(&mut converter, &input, &[257]));
            converter.reset();
            assert_eq!(reference, drive(&mut converter, &input, &[64, 3]));
        }
    }
}

#[test]
fn seeks_match_uninterrupted_output_including_fft_boundaries_and_finite_tails() {
    for (source, target) in [(44100, 48000), (48000, 44100), (48000, 48000)] {
        for total in [1_usize, 2, 17, 1176, 1280, 5003, 12001] {
            let input: Vec<Vec<f32>> = (0..2)
                .map(|ch| {
                    (0..total)
                        .map(|i| ((i * 7919 + ch * 13) % 32768) as f32 / 16384.0 - 1.0)
                        .collect()
                })
                .collect();
            let reference = convert(source, target, &input, &[257, 17]);
            let mut converter =
                PreparedRateConverter::new(source, target, 2, total as u64).unwrap();
            for seek in [
                0,
                total - 1,
                total,
                total / 2,
                1,
                587,
                588,
                639,
                640,
                1175,
                1176,
                1279,
                1280,
                7001,
                0,
            ] {
                if seek > total {
                    continue;
                }
                let pcm = converter.seek(seek as u64).unwrap() as usize;
                assert!(seek.saturating_sub(converter.source_frames_read() as usize) <= 2560);
                let actual = drive(&mut converter, &input, &[1, 1024, 37]);
                for ch in 0..2 {
                    assert_eq!(
                        actual[ch],
                        reference[ch][pcm..],
                        "{source}->{target} total={total} seek={seek}"
                    );
                }
            }
            assert_eq!(converter.seek(total as u64 + 1), Err(INVALID_CONVERSION));
        }
    }
}

#[test]
fn timeline_ceil_length_floor_cursor_and_checked_limits() {
    for (source, target) in [(44100, 48000), (48000, 44100)] {
        for total in [1, 17, 147, 160, 1280, u32::MAX as u64] {
            let timeline = PcmTimeline::new(source, target, total).unwrap();
            let end = timeline.total_pcm_frames();
            for p in [0, 1, end / 2, end - 1] {
                assert_eq!(
                    timeline.source_position(p),
                    ((u128::from(p) * u128::from(source)) / u128::from(target)) as u64
                );
            }
            assert_eq!(timeline.source_position(end), total);
            assert_eq!(timeline.source_position(u64::MAX), total);
        }
    }
    assert!(PcmTimeline::new(44100, 48000, u64::MAX).is_err());
    assert!(PcmTimeline::new(48000, 44100, u64::MAX).is_ok());
    for (source, target, frames) in [
        (0, 48000, 1),
        (44100, 0, 1),
        (32000, 48000, 1),
        (48000, 48000, 0),
    ] {
        assert!(PcmTimeline::new(source, target, frames).is_err());
    }
    assert!(PreparedRateConverter::new(44100, 48000, 3, 1).is_err());
}

#[test]
fn analytic_passband_and_downsampling_alias_rejection() {
    for (source, target) in [(44100, 48000), (48000, 44100)] {
        for frequency in [100.0, 1000.0, 10000.0, 18000.0] {
            let input = vec![
                (0..source)
                    .map(|i| {
                        (std::f64::consts::TAU * frequency * f64::from(i) / f64::from(source)).sin()
                            as f32
                            * 0.5
                    })
                    .collect(),
            ];
            let output = convert(source, target, &input, &[256]);
            let mut max_error = 0.0_f64;
            let mut energy = 0.0;
            let mut expected_energy = 0.0;
            for (i, &sample) in output[0]
                .iter()
                .enumerate()
                .take(target as usize - 2000)
                .skip(2000)
            {
                let expected =
                    (std::f64::consts::TAU * frequency * i as f64 / f64::from(target)).sin() * 0.5;
                max_error = max_error.max((f64::from(sample) - expected).abs());
                energy += f64::from(sample).powi(2);
                expected_energy += expected.powi(2);
            }
            let gain_db = 10.0 * (energy / expected_energy).log10();
            eprintln!("{source}->{target} {frequency}Hz max_error={max_error} gain_db={gain_db}");
            assert!(max_error <= 0.002, "{max_error}");
            assert!(gain_db.abs() <= 0.1);
        }
    }
    let input = vec![
        (0..48000)
            .map(|i| (std::f64::consts::TAU * 23000.0 * f64::from(i) / 48000.0).sin() as f32 * 0.5)
            .collect(),
    ];
    let output = convert(48000, 44100, &input, &[256]);
    let middle = &output[0][2000..42100];
    let rms =
        (middle.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>() / middle.len() as f64).sqrt();
    let attenuation_db = 20.0 * (rms / (0.5 / 2_f64.sqrt())).log10();
    eprintln!("23kHz alias attenuation={attenuation_db}dB");
    assert!(attenuation_db <= -70.0);
}

#[test]
fn integer_delay_compensation_aligns_impulses_and_channels() {
    for (source, target, delay) in [(44100, 48000, 640), (48000, 44100, 588)] {
        let converter = PreparedRateConverter::new(source, target, 2, 4000).unwrap();
        assert_eq!(converter.skip_delay, delay);
        for frame in [0, source as usize / 300 * 8] {
            let mut input = vec![vec![0.0; 4000]; 2];
            input[0][frame] = 0.5;
            let output = convert(source, target, &input, &[1, 256, 1024]);
            let peak = output[0]
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .unwrap()
                .0;
            assert_eq!(peak, frame * target as usize / source as usize);
            assert!(output[1].iter().all(|sample| *sample == 0.0));
        }
    }
}

#[test]
fn invalid_push_and_consume_are_atomic_and_worker_processing_storage_is_stable() {
    let mut converter = PreparedRateConverter::new(44100, 48000, 2, 44100).unwrap();
    assert!(converter.push(&[]).is_err());
    assert!(converter.push(&[1.0]).is_err());
    assert!(converter.consume(1).is_err());
    assert_eq!(converter.source_frames_read(), 0);
    let input_ptr = converter.input[0].as_ptr();
    let output_ptr = converter.output[0].as_ptr();
    let input = vec![vec![0.0; 44100]; 2];
    drive(&mut converter, &input, &[17, 1024]);
    assert_eq!(input_ptr, converter.input[0].as_ptr());
    assert_eq!(output_ptr, converter.output[0].as_ptr());
}

#[test]
fn prepared_worker_processing_flush_and_reset_have_no_observed_allocator_calls() {
    use crate::tests::{
        ALLOCATOR_PROBE_LOCK, MEASURE_ALLOCATIONS, allocator_counts, reset_allocator_counts,
    };
    let _guard = ALLOCATOR_PROBE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    MEASURE_ALLOCATIONS.with(|active| active.set(false));
    for (source, target) in [(44100, 48000), (48000, 44100), (48000, 48000)] {
        let mut converter = PreparedRateConverter::new(source, target, 2, 5003).unwrap();
        let input = vec![0.0; 2560];
        let run = |converter: &mut PreparedRateConverter| -> Result<(), u32> {
            while converter.pcm_consumed < converter.total_pcm_frames() {
                let needed = converter.input_frames_needed();
                if needed > 0 {
                    converter.push(&input[..needed * 2])?;
                }
                converter.consume(converter.available_frames())?;
            }
            converter.reset();
            Ok(())
        };
        run(&mut converter).unwrap();
        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(true));
        let result = std::hint::black_box(run(&mut converter));
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        let counts = allocator_counts();
        assert!(result.is_ok());
        assert_eq!(counts, [0, 0, 0, 0]);
    }
}
