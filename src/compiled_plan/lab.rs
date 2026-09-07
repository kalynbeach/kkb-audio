//! Bounded offline inspection of the same closed program used by the worklet.
//! Allocation and trace copying here are deliberately outside real-time rendering.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct LabSession {
    instance: RenderInstance,
    description: Vec<u32>,
    output: Box<[f32]>,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl LabSession {
    /// Settings are frequency A/B and gain A/B. Each event is
    /// [processor, frame, action (1=set, 2=ramp), value, inclusive end].
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(settings: &[f64], events: &[f64]) -> Result<LabSession, u32> {
        if settings.len() != 4 || !events.len().is_multiple_of(5) || events.len() > 80 {
            return Err(60);
        }
        let mut description = proof_description(48_000.0, OutputLayout::Mono);
        for node in &mut description.nodes {
            match &mut node.kind {
                NodeKind::Oscillator { frequency } => {
                    *frequency = settings[usize::from(node.id == 30)];
                }
                NodeKind::Gain { value, .. } => {
                    let gain = settings[2 + usize::from(node.id == 40)];
                    if !gain.is_finite() || !(-1.0..=1.0).contains(&gain) {
                        return Err(60);
                    }
                    *value = gain as f32;
                }
                _ => {}
            }
        }
        let plan = CompiledPlan::compile(&description).map_err(|_| 60u32)?;
        let mut admitted = Vec::with_capacity(events.len() / 5);
        for fields in events.as_chunks::<5>().0 {
            let integer =
                |n: f64| n.is_finite() && n.fract() == 0.0 && (0.0..96_000.0).contains(&n);
            if !matches!(fields[0], 20.0 | 40.0)
                || !integer(fields[1])
                || !integer(fields[4])
                || !fields[3].is_finite()
                || !(-1.0..=1.0).contains(&fields[3])
            {
                return Err(60);
            }
            let value = fields[3] as f32;
            let action = match fields[2] {
                1.0 if fields[4] == 0.0 => Action::Set(value),
                2.0 => Action::LinearRamp {
                    end_frame: fields[4] as u64,
                    value,
                },
                _ => return Err(60),
            };
            admitted.push(Event {
                frame: fields[1] as u64,
                address: Address {
                    processor: fields[0] as u32,
                    parameter: 1,
                },
                action,
            });
        }
        let words = plan.encode(&admitted).map_err(|_| 60u32)?;
        // The inspected instance is prepared from the very description shown in the lab.
        let (plan, events) = CompiledPlan::decode(&words).map_err(|_| 60u32)?;
        let mut instance = RenderInstance::prepare(&plan);
        for event in events {
            instance.schedule(event).map_err(|_| 60u32)?;
        }
        Ok(Self {
            instance,
            description: words,
            output: vec![0.0; MAXIMUM_FRAMES].into_boxed_slice(),
        })
    }

    pub fn description(&self) -> Vec<u32> {
        self.description.clone()
    }

    /// Returns seven consecutive mono traces in compiled slot order. Empty means failure.
    /// This allocating API is for offline workers only, never an audio callback.
    pub fn render(&mut self, frames: usize) -> Vec<f32> {
        if frames == 0
            || frames > MAXIMUM_FRAMES
            || self.instance.next_frame() + frames as u64 > 96_000
        {
            return Vec::new();
        }
        if self
            .instance
            .render(Output::Mono(&mut self.output[..frames]))
            != RenderStatus::Rendered
        {
            return Vec::new();
        }
        let mut traces = Vec::with_capacity(OP_COUNT * frames);
        for slot in 0..OP_COUNT {
            let start = slot * MAXIMUM_FRAMES;
            traces.extend_from_slice(&self.instance.buffers[start..start + frames]);
        }
        traces
    }

    /// Latest completed engine observation; larger render calls can overwrite windows.
    pub fn observation(&mut self) -> Vec<f64> {
        self.instance.take_observation().map_or_else(Vec::new, |o| {
            vec![
                o.start as f64,
                o.end as f64,
                f64::from(o.peak),
                o.rms,
                o.sequence as f64,
                o.dropped as f64,
                f64::from(o.location),
            ]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tape(partition: usize) -> Vec<Vec<f32>> {
        let mut session = LabSession::new(
            &[220.0, 223.0, 0.25, 0.2],
            &[20.0, 127.0, 1.0, 0.5, 0.0, 40.0, 131.0, 2.0, -0.25, 257.0],
        )
        .unwrap();
        let words = session.description();
        assert_eq!(
            (0..7).map(|i| words[8 + i * 8 + 1]).collect::<Vec<_>>(),
            [10, 20, 30, 40, 50, 60, 70]
        );
        let mut result = vec![Vec::new(); 7];
        let mut frame = 0;
        while frame < 1000 {
            let count = partition.min(1000 - frame);
            let block = session.render(count);
            for slot in 0..7 {
                result[slot].extend_from_slice(&block[slot * count..(slot + 1) * count]);
            }
            frame += count;
        }
        result
    }

    #[test]
    fn traces_are_same_instance_samples_and_partition_invariant() {
        let traces = tape(128);
        for size in [1, 17, 257, 1024] {
            assert_eq!(traces, tape(size));
        }
        for (frame, _) in traces[0].iter().enumerate() {
            assert_eq!(
                traces[1][frame],
                traces[0][frame] * if frame < 127 { 0.25 } else { 0.5 }
            );
            assert_eq!(traces[4][frame], traces[1][frame] + traces[3][frame]);
            assert_eq!(traces[4][frame], traces[5][frame]);
            assert_eq!(traces[5][frame], traces[6][frame]);
        }
        assert_eq!(traces[3][131], traces[2][131] * 0.2);
        assert_eq!(traces[3][257], traces[2][257] * -0.25);
    }

    #[test]
    fn rejects_invalid_lab_inputs_and_preserves_clock_on_bad_render() {
        for settings in [
            [24_000.0, 220.0, 0.2, 0.2],
            [220.0, f64::NAN, 0.2, 0.2],
            [220.0, 222.0, 1.000000001, 0.2],
        ] {
            assert!(LabSession::new(&settings, &[]).is_err());
        }
        for event in [
            [20.5, 5.0, 1.0, 0.5, 0.0],
            [20.0, 5.5, 1.0, 0.5, 0.0],
            [20.0, 5.0, 2.0, 0.5, 5.0],
            [20.0, 96_000.0, 1.0, 0.5, 0.0],
        ] {
            assert!(LabSession::new(&[220.0, 222.0, 0.2, 0.2], &event).is_err());
        }
        let mut session = LabSession::new(&[220.0, 222.0, 0.2, 0.2], &[]).unwrap();
        assert!(session.render(1025).is_empty());
        assert!(session.render(0).is_empty());
        assert_eq!(session.instance.next_frame(), 0);
        assert_eq!(session.render(128).len(), 896);
        let observation = session.observation();
        assert_eq!(&observation[..2], &[64.0, 128.0]);
        assert_eq!(&observation[4..], &[2.0, 1.0, 60.0]);
    }
}
