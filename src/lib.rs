//! Focused validation kernels for the KKB audio render engine.

// Milestone 1 deliberately has no product-facing API. Its prepared kernel is
// exercised directly by this crate's tests until later milestones establish a
// reusable interface.
#[allow(dead_code)]
mod prepared_kernel {
    use std::f64::consts::TAU;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum OutputLayout {
        Mono,
        Stereo,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum PrepareError {
        SampleRate,
        Gain,
        Frequency,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum RenderStatus {
        Rendered,
        InvalidLayout,
        CapacityExceeded,
        Terminal,
        ClockOverflow,
    }

    pub(crate) enum Output<'a> {
        Mono(&'a mut [f32]),
        Stereo {
            left: &'a mut [f32],
            right: &'a mut [f32],
        },
    }

    impl Output<'_> {
        fn zero(&mut self) {
            match self {
                Self::Mono(output) => output.fill(0.0),
                Self::Stereo { left, right } => {
                    left.fill(0.0);
                    right.fill(0.0);
                }
            }
        }
    }

    #[derive(Clone, Debug, PartialEq)]
    pub(crate) struct PreparedKernel {
        layout: OutputLayout,
        gain: f32,
        pub(super) phase: f64,
        phase_increment: f64,
        pub(super) next_frame: u64,
        maximum_frames: usize,
        pub(super) terminal: bool,
    }

    impl PreparedKernel {
        pub(crate) fn prepare(
            layout: OutputLayout,
            sample_rate: f64,
            frequency: f64,
            gain: f32,
            maximum_frames: usize,
        ) -> Result<Self, PrepareError> {
            if !sample_rate.is_finite() || sample_rate <= 0.0 {
                return Err(PrepareError::SampleRate);
            }
            if !gain.is_finite() {
                return Err(PrepareError::Gain);
            }
            if !frequency.is_finite() || frequency < 0.0 || frequency >= sample_rate / 2.0 {
                return Err(PrepareError::Frequency);
            }

            Ok(Self {
                layout,
                gain,
                phase: 0.0,
                phase_increment: TAU * (frequency / sample_rate),
                next_frame: 0,
                maximum_frames,
                terminal: false,
            })
        }

        pub(crate) fn render(&mut self, mut output: Output<'_>) -> RenderStatus {
            let frame_count = match (&mut output, self.layout) {
                (Output::Mono(output), OutputLayout::Mono) => output.len(),
                (Output::Stereo { left, right }, OutputLayout::Stereo)
                    if left.len() == right.len() =>
                {
                    left.len()
                }
                _ => {
                    output.zero();
                    return RenderStatus::InvalidLayout;
                }
            };

            if frame_count == 0 {
                return RenderStatus::Rendered;
            }

            if self.terminal {
                output.zero();
                return RenderStatus::Terminal;
            }

            if frame_count > self.maximum_frames {
                output.zero();
                self.terminal = true;
                return RenderStatus::CapacityExceeded;
            }

            let Ok(frame_count_u64) = u64::try_from(frame_count) else {
                output.zero();
                return RenderStatus::ClockOverflow;
            };
            let Some(next_frame) = self.next_frame.checked_add(frame_count_u64) else {
                output.zero();
                return RenderStatus::ClockOverflow;
            };

            let gain = self.gain;
            let phase_increment = self.phase_increment;
            let mut phase = self.phase;

            match output {
                Output::Mono(output) => {
                    for sample in output {
                        *sample = phase.sin() as f32 * gain;
                        phase += phase_increment;
                        if phase >= TAU {
                            phase -= TAU;
                        }
                    }
                }
                Output::Stereo { left, right } => {
                    for (left_sample, right_sample) in left.iter_mut().zip(right) {
                        let sample = phase.sin() as f32 * gain;
                        *left_sample = sample;
                        *right_sample = sample;
                        phase += phase_increment;
                        if phase >= TAU {
                            phase -= TAU;
                        }
                    }
                }
            }

            self.phase = phase;
            self.next_frame = next_frame;
            RenderStatus::Rendered
        }
    }
}

#[cfg(test)]
mod tests {
    use super::prepared_kernel::{
        Output, OutputLayout, PrepareError, PreparedKernel, RenderStatus,
    };
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::f64::consts::TAU;
    use std::hint::black_box;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SAMPLE_RATE: f64 = 48_000.0;
    const MAXIMUM_FRAMES: usize = 1_024;

    struct CountingAllocator;

    thread_local! {
        static MEASURE_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    }

    static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    static ZEROED_ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    static REALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    static DEALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    static ALLOCATOR_PROBE_LOCK: Mutex<()> = Mutex::new(());

    fn measurement_is_active() -> bool {
        MEASURE_ALLOCATIONS.try_with(Cell::get).unwrap_or_default()
    }

    // SAFETY: Every operation delegates to `System` with the original pointer
    // and layout. The counters observe calls without changing allocation
    // behavior.
    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if measurement_is_active() {
                ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            // SAFETY: The caller provides the allocation layout required by
            // `GlobalAlloc::alloc`.
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            if measurement_is_active() {
                ZEROED_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            // SAFETY: The caller provides the allocation layout required by
            // `GlobalAlloc::alloc_zeroed`.
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            if measurement_is_active() {
                REALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            // SAFETY: The caller provides the pointer, its current layout, and
            // requested size required by `GlobalAlloc::realloc`.
            unsafe { System.realloc(pointer, layout, size) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            if measurement_is_active() {
                DEALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            // SAFETY: The caller provides the pointer and layout originally
            // returned by this allocator.
            unsafe { System.dealloc(pointer, layout) }
        }
    }

    #[global_allocator]
    static GLOBAL_ALLOCATOR: CountingAllocator = CountingAllocator;

    fn assert_samples_close(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
            assert!(
                (actual - expected).abs() <= 1.0e-6,
                "sample {index}: expected {expected}, got {actual}"
            );
        }
    }

    fn assert_positive_zero(samples: &[f32]) {
        assert!(samples.iter().all(|sample| sample.to_bits() == 0));
    }

    fn prepared_mono(frequency: f64, gain: f32) -> PreparedKernel {
        PreparedKernel::prepare(
            OutputLayout::Mono,
            SAMPLE_RATE,
            frequency,
            gain,
            MAXIMUM_FRAMES,
        )
        .unwrap()
    }

    fn render_partitioned(partitions: &[usize]) -> (Vec<f32>, PreparedKernel) {
        let mut kernel = prepared_mono(997.0, 0.375);
        let mut rendered = Vec::with_capacity(partitions.iter().sum());

        for &frames in partitions {
            let start = rendered.len();
            rendered.resize(start + frames, f32::NAN);
            assert_eq!(
                kernel.render(Output::Mono(&mut rendered[start..])),
                RenderStatus::Rendered
            );
        }

        (rendered, kernel)
    }

    #[test]
    fn analytic_mono_unity_gain_starts_at_zero_and_emits_before_advancing() {
        let mut kernel = PreparedKernel::prepare(OutputLayout::Mono, 8.0, 1.0, 1.0, 8).unwrap();
        let mut output = [f32::NAN; 5];

        assert_eq!(
            kernel.render(Output::Mono(&mut output)),
            RenderStatus::Rendered
        );

        let half_sqrt_two = std::f32::consts::FRAC_1_SQRT_2;
        assert_samples_close(&output, &[0.0, half_sqrt_two, 1.0, half_sqrt_two, 0.0]);
        assert_eq!(kernel.next_frame, 5);
        assert!((kernel.phase - 5.0 * TAU / 8.0).abs() <= f64::EPSILON);
    }

    #[test]
    fn analytic_stereo_non_unity_gain_duplicates_into_distinct_planes() {
        let mut kernel = PreparedKernel::prepare(OutputLayout::Stereo, 8.0, 1.0, 0.25, 8).unwrap();
        let mut left = [f32::NAN; 4];
        let mut right = [f32::NAN; 4];
        assert_ne!(left.as_ptr(), right.as_ptr());

        assert_eq!(
            kernel.render(Output::Stereo {
                left: &mut left,
                right: &mut right,
            }),
            RenderStatus::Rendered
        );

        let expected = [
            0.0,
            std::f32::consts::FRAC_1_SQRT_2 * 0.25,
            0.25,
            std::f32::consts::FRAC_1_SQRT_2 * 0.25,
        ];
        assert_samples_close(&left, &expected);
        assert_eq!(left, right);
        assert_eq!(kernel.next_frame, 4);
    }

    #[test]
    fn output_is_bit_identical_across_single_one_frame_and_irregular_partitions() {
        let (single, single_kernel) = render_partitioned(&[1_000]);
        let one_frame_partitions = [1; 1_000];
        let (one_frame, one_frame_kernel) = render_partitioned(&one_frame_partitions);

        let pattern = [17, 64, 1, 128, 257, 3, 89];
        let mut irregular_partitions = Vec::new();
        let mut remaining = 1_000;
        let mut pattern_index = 0;
        while remaining > 0 {
            let partition = pattern[pattern_index % pattern.len()].min(remaining);
            irregular_partitions.push(partition);
            remaining -= partition;
            pattern_index += 1;
        }
        let (irregular, irregular_kernel) = render_partitioned(&irregular_partitions);

        assert_eq!(single, one_frame);
        assert_eq!(single, irregular);
        assert_eq!(single_kernel.next_frame, 1_000);
        assert_eq!(single_kernel.next_frame, one_frame_kernel.next_frame);
        assert_eq!(single_kernel.next_frame, irregular_kernel.next_frame);
        assert_eq!(
            single_kernel.phase.to_bits(),
            one_frame_kernel.phase.to_bits()
        );
        assert_eq!(
            single_kernel.phase.to_bits(),
            irregular_kernel.phase.to_bits()
        );
    }

    #[test]
    fn boundary_partitions_and_zero_calls_adjacent_to_a_phase_wrap_are_supported() {
        for frames in [0, 1, 17, 64, 128, 257, MAXIMUM_FRAMES] {
            let mut kernel = prepared_mono(1_000.0, 1.0);
            let mut output = vec![f32::NAN; frames];
            assert_eq!(
                kernel.render(Output::Mono(&mut output)),
                RenderStatus::Rendered
            );
            assert_eq!(kernel.next_frame, frames as u64);
        }

        let mut kernel = PreparedKernel::prepare(OutputLayout::Mono, 8.0, 2.0, 1.0, 8).unwrap();
        let mut before_wrap = [f32::NAN; 3];
        assert_eq!(
            kernel.render(Output::Mono(&mut before_wrap)),
            RenderStatus::Rendered
        );

        let before_zero = kernel.clone();
        let mut empty: [f32; 0] = [];
        assert_eq!(
            kernel.render(Output::Mono(&mut empty)),
            RenderStatus::Rendered
        );
        assert_eq!(kernel, before_zero);

        let mut wrapping_frame = [f32::NAN; 1];
        assert_eq!(
            kernel.render(Output::Mono(&mut wrapping_frame)),
            RenderStatus::Rendered
        );
        assert_eq!(kernel.phase.to_bits(), 0.0f64.to_bits());

        let after_wrap = kernel.clone();
        assert_eq!(
            kernel.render(Output::Mono(&mut empty)),
            RenderStatus::Rendered
        );
        assert_eq!(kernel, after_wrap);
    }

    #[test]
    fn zero_frames_preserve_output_guards_and_all_owned_state() {
        let mut kernel = prepared_mono(440.0, 0.5);
        let mut guarded_output = [17.0, 23.0];
        let before = kernel.clone();

        assert_eq!(
            kernel.render(Output::Mono(&mut guarded_output[1..1])),
            RenderStatus::Rendered
        );

        assert_eq!(guarded_output, [17.0, 23.0]);
        assert_eq!(kernel, before);
    }

    #[test]
    fn malformed_stereo_layout_zeroes_both_planes_and_preserves_state() {
        let mut kernel =
            PreparedKernel::prepare(OutputLayout::Stereo, SAMPLE_RATE, 440.0, 0.5, 8).unwrap();
        let before = kernel.clone();
        let mut left = [1.0; 2];
        let mut right = [1.0; 3];

        assert_eq!(
            kernel.render(Output::Stereo {
                left: &mut left,
                right: &mut right,
            }),
            RenderStatus::InvalidLayout
        );

        assert_positive_zero(&left);
        assert_positive_zero(&right);
        assert_eq!(kernel, before);
    }

    #[test]
    fn output_layout_mismatch_zeroes_every_supplied_sample() {
        let mut kernel = prepared_mono(440.0, 0.5);
        let before = kernel.clone();
        let mut left = [1.0; 2];
        let mut right = [1.0; 2];

        assert_eq!(
            kernel.render(Output::Stereo {
                left: &mut left,
                right: &mut right,
            }),
            RenderStatus::InvalidLayout
        );

        assert_positive_zero(&left);
        assert_positive_zero(&right);
        assert_eq!(kernel, before);
    }

    #[test]
    fn over_capacity_mono_is_atomic_and_makes_the_instance_terminal() {
        let mut kernel =
            PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, 440.0, 0.5, 2).unwrap();
        let phase_before = kernel.phase;
        let clock_before = kernel.next_frame;
        let mut oversized = [1.0; 3];

        assert_eq!(
            kernel.render(Output::Mono(&mut oversized)),
            RenderStatus::CapacityExceeded
        );
        assert_positive_zero(&oversized);
        assert_eq!(kernel.phase.to_bits(), phase_before.to_bits());
        assert_eq!(kernel.next_frame, clock_before);
        assert!(kernel.terminal);

        let mut later = [1.0; 1];
        assert_eq!(
            kernel.render(Output::Mono(&mut later)),
            RenderStatus::Terminal
        );
        assert_positive_zero(&later);
        assert_eq!(kernel.phase.to_bits(), phase_before.to_bits());
        assert_eq!(kernel.next_frame, clock_before);
    }

    #[test]
    fn over_capacity_stereo_is_atomic_and_makes_the_instance_terminal() {
        let mut kernel =
            PreparedKernel::prepare(OutputLayout::Stereo, SAMPLE_RATE, 440.0, 0.5, 2).unwrap();
        let phase_before = kernel.phase;
        let clock_before = kernel.next_frame;
        let mut left = [1.0; 3];
        let mut right = [1.0; 3];

        assert_eq!(
            kernel.render(Output::Stereo {
                left: &mut left,
                right: &mut right,
            }),
            RenderStatus::CapacityExceeded
        );
        assert_positive_zero(&left);
        assert_positive_zero(&right);
        assert_eq!(kernel.phase.to_bits(), phase_before.to_bits());
        assert_eq!(kernel.next_frame, clock_before);
        assert!(kernel.terminal);
    }

    #[test]
    fn clock_overflow_is_atomic() {
        let mut kernel = prepared_mono(440.0, 0.5);
        kernel.next_frame = u64::MAX - 1;
        let phase_before = kernel.phase;
        let mut overflowing = [1.0; 2];

        assert_eq!(
            kernel.render(Output::Mono(&mut overflowing)),
            RenderStatus::ClockOverflow
        );
        assert_positive_zero(&overflowing);
        assert_eq!(kernel.phase.to_bits(), phase_before.to_bits());
        assert_eq!(kernel.next_frame, u64::MAX - 1);
        assert!(!kernel.terminal);

        let mut final_frame = [f32::NAN; 1];
        assert_eq!(
            kernel.render(Output::Mono(&mut final_frame)),
            RenderStatus::Rendered
        );
        assert_eq!(kernel.next_frame, u64::MAX);
    }

    #[test]
    fn large_finite_preparation_values_produce_finite_analytic_output() {
        let sample_rate = f64::MAX;
        let frequency = sample_rate / 4.0;
        let mut kernel =
            PreparedKernel::prepare(OutputLayout::Mono, sample_rate, frequency, 1.0, 4).unwrap();
        let mut output = [f32::NAN; 4];

        assert_eq!(
            kernel.render(Output::Mono(&mut output)),
            RenderStatus::Rendered
        );

        assert_samples_close(&output, &[0.0, 1.0, 0.0, -1.0]);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert_eq!(kernel.next_frame, 4);
        assert_eq!(kernel.phase.to_bits(), 0.0f64.to_bits());
    }

    #[test]
    fn preparation_rejects_invalid_values_and_half_open_frequency_boundary() {
        for sample_rate in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                PreparedKernel::prepare(OutputLayout::Mono, sample_rate, 0.0, 1.0, 8),
                Err(PrepareError::SampleRate)
            );
        }

        for gain in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, 0.0, gain, 8),
                Err(PrepareError::Gain)
            );
        }

        for frequency in [
            -1.0,
            SAMPLE_RATE / 2.0,
            SAMPLE_RATE,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert_eq!(
                PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, frequency, 1.0, 8),
                Err(PrepareError::Frequency)
            );
        }

        assert!(PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, 0.0, -1.0, 8).is_ok());
        assert!(
            PreparedKernel::prepare(
                OutputLayout::Mono,
                SAMPLE_RATE,
                SAMPLE_RATE / 2.0 - 1.0,
                1.0,
                8,
            )
            .is_ok()
        );
    }

    fn reset_allocator_counts() {
        ALLOCATIONS.store(0, Ordering::Relaxed);
        ZEROED_ALLOCATIONS.store(0, Ordering::Relaxed);
        REALLOCATIONS.store(0, Ordering::Relaxed);
        DEALLOCATIONS.store(0, Ordering::Relaxed);
    }

    fn allocator_counts() -> [usize; 4] {
        [
            ALLOCATIONS.load(Ordering::Relaxed),
            ZEROED_ALLOCATIONS.load(Ordering::Relaxed),
            REALLOCATIONS.load(Ordering::Relaxed),
            DEALLOCATIONS.load(Ordering::Relaxed),
        ]
    }

    #[test]
    fn warmed_render_paths_have_no_observed_allocator_calls() {
        let _probe_guard = ALLOCATOR_PROBE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Initialize thread-local measurement state and exercise every measured
        // branch before resetting counters and arming the probe.
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        let mut warm_kernel =
            PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, 440.0, 0.5, 2).unwrap();
        let mut warm_valid = [f32::NAN; 1];
        let mut warm_empty = [];
        let mut warm_left = [1.0; 1];
        let mut warm_right = [1.0; 2];
        let mut warm_oversized = [1.0; 3];
        let warm_valid_status =
            black_box(black_box(&mut warm_kernel).render(Output::Mono(black_box(&mut warm_valid))));
        let warm_zero_status =
            black_box(black_box(&mut warm_kernel).render(Output::Mono(black_box(&mut warm_empty))));
        let warm_invalid_status = black_box(black_box(&mut warm_kernel).render(Output::Stereo {
            left: black_box(&mut warm_left),
            right: black_box(&mut warm_right),
        }));
        let warm_over_capacity_status = black_box(
            black_box(&mut warm_kernel).render(Output::Mono(black_box(&mut warm_oversized))),
        );
        black_box((
            &warm_kernel,
            &warm_valid,
            &warm_empty,
            &warm_left,
            &warm_right,
            &warm_oversized,
        ));
        assert_eq!(warm_valid_status, RenderStatus::Rendered);
        assert_eq!(warm_zero_status, RenderStatus::Rendered);
        assert_eq!(warm_invalid_status, RenderStatus::InvalidLayout);
        assert_eq!(warm_over_capacity_status, RenderStatus::CapacityExceeded);

        let mut kernel =
            PreparedKernel::prepare(OutputLayout::Mono, SAMPLE_RATE, 440.0, 0.5, 2).unwrap();
        let mut valid = [f32::NAN; 1];
        let mut empty = [];
        let mut invalid_left = [1.0; 1];
        let mut invalid_right = [1.0; 2];
        let mut oversized = [1.0; 3];

        reset_allocator_counts();
        MEASURE_ALLOCATIONS.with(|active| active.set(true));
        let valid_status =
            black_box(black_box(&mut kernel).render(Output::Mono(black_box(&mut valid))));
        let zero_status =
            black_box(black_box(&mut kernel).render(Output::Mono(black_box(&mut empty))));
        let invalid_status = black_box(black_box(&mut kernel).render(Output::Stereo {
            left: black_box(&mut invalid_left),
            right: black_box(&mut invalid_right),
        }));
        let over_capacity_status =
            black_box(black_box(&mut kernel).render(Output::Mono(black_box(&mut oversized))));
        MEASURE_ALLOCATIONS.with(|active| active.set(false));
        let observed_counts = allocator_counts();

        black_box((
            &kernel,
            &valid,
            &empty,
            &invalid_left,
            &invalid_right,
            &oversized,
        ));
        assert_eq!(valid_status, RenderStatus::Rendered);
        assert_eq!(zero_status, RenderStatus::Rendered);
        assert_eq!(invalid_status, RenderStatus::InvalidLayout);
        assert_eq!(over_capacity_status, RenderStatus::CapacityExceeded);
        assert_eq!(observed_counts, [0, 0, 0, 0]);
    }
}
