//! Private incremental RIFF PCM16/24 and IEEE float32 reader.
//! Hosts supply only the requested header window.
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const INVALID_WAV: u32 = 70;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct LocalWav {
    size: u64,
    end: u64,
    offset: u64,
    length: usize,
    next_chunk: u64,
    stage: u8,
    channels: u32,
    rate: u32,
    format: u16,
    bits: u32,
    data_offset: u64,
    data_bytes: u64,
    has_data: bool,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl LocalWav {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(size: u64) -> Self {
        Self {
            size,
            end: 0,
            offset: 0,
            length: 12,
            next_chunk: 0,
            stage: 0,
            channels: 0,
            rate: 0,
            format: 0,
            bits: 0,
            data_offset: 0,
            data_bytes: 0,
            has_data: false,
        }
    }
    pub fn offset(&self) -> u64 {
        self.offset
    }
    pub fn length(&self) -> usize {
        self.length
    }
    pub fn channels(&self) -> u32 {
        self.channels
    }
    pub fn sample_rate(&self) -> u32 {
        self.rate
    }
    pub fn data_offset(&self) -> u64 {
        self.data_offset
    }
    pub fn block_align(&self) -> u32 {
        self.channels * (self.bits / 8)
    }
    pub fn total_frames(&self) -> u64 {
        self.data_bytes / u64::from(self.block_align().max(1))
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<(), u32> {
        if self.stage == 3
            || bytes.len() != self.length
            || self.offset + self.length as u64 > self.size
        {
            return Err(INVALID_WAV);
        }
        match self.stage {
            0 => {
                if &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
                    return Err(INVALID_WAV);
                }
                self.end = u64::from(le32(&bytes[4..8])) + 8;
                if self.end != self.size || self.end < 12 {
                    return Err(INVALID_WAV);
                }
                self.next_chunk = 12;
            }
            1 => {
                let size = u64::from(le32(&bytes[4..8]));
                let payload = self.offset + 8;
                self.next_chunk = payload + size + (size & 1);
                if self.next_chunk > self.end {
                    return Err(INVALID_WAV);
                }
                match &bytes[..4] {
                    b"fmt " => {
                        if self.channels != 0 || size < 16 {
                            return Err(INVALID_WAV);
                        }
                        self.offset = payload;
                        self.length = 16;
                        self.stage = 2;
                        return Ok(());
                    }
                    b"data" => {
                        if self.has_data || size == 0 {
                            return Err(INVALID_WAV);
                        }
                        self.has_data = true;
                        self.data_offset = payload;
                        self.data_bytes = size;
                    }
                    _ => {}
                }
            }
            2 => {
                self.format = le16(&bytes[..2]);
                self.channels = u32::from(le16(&bytes[2..4]));
                self.rate = le32(&bytes[4..8]);
                self.bits = u32::from(le16(&bytes[14..16]));
                if !matches!((self.format, self.bits), (1, 16 | 24) | (3, 32))
                    || !matches!(self.channels, 1 | 2)
                    || self.rate == 0
                    || u32::from(le16(&bytes[12..14])) != self.block_align()
                    || self.rate.checked_mul(self.block_align()) != Some(le32(&bytes[8..12]))
                {
                    return Err(INVALID_WAV);
                }
            }
            _ => return Err(INVALID_WAV),
        }
        if self.next_chunk == self.end {
            if self.channels == 0
                || !self.has_data
                || !self
                    .data_bytes
                    .is_multiple_of(u64::from(self.block_align()))
            {
                return Err(INVALID_WAV);
            }
            self.stage = 3;
            self.length = 0;
        } else {
            if self.end - self.next_chunk < 8 {
                return Err(INVALID_WAV);
            }
            self.offset = self.next_chunk;
            self.length = 8;
            self.stage = 1;
        }
        Ok(())
    }
    /// At most 1024 frames of planar output, with no padded source frames.
    /// Float32 samples retain their finite values, including values outside [-1, 1].
    /// Reject an entire block containing NaN/Inf; never normalize or clip samples.
    pub fn decode(&self, bytes: &[u8]) -> Result<Vec<f32>, u32> {
        if self.stage != 3
            || bytes.is_empty()
            || bytes.len() > 1024 * self.block_align() as usize
            || !bytes.len().is_multiple_of(self.block_align() as usize)
        {
            return Err(INVALID_WAV);
        }
        let frames = bytes.len() / self.block_align() as usize;
        let mut output = vec![0.0; frames * self.channels as usize];
        let width = (self.bits / 8) as usize;
        for frame in 0..frames {
            for channel in 0..self.channels as usize {
                let start = (frame * self.channels as usize + channel) * width;
                let sample = &bytes[start..start + width];
                output[channel * frames + frame] = if self.format == 3 {
                    let value = f32::from_bits(le32(sample));
                    if !value.is_finite() {
                        return Err(INVALID_WAV);
                    }
                    value
                } else if width == 2 {
                    i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0
                } else {
                    (i32::from_le_bytes([0, sample[0], sample[1], sample[2]]) >> 8) as f32
                        / 8388608.0
                };
            }
        }
        Ok(output)
    }
}
fn le16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}
fn le32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn read_header(file: &mut std::fs::File) -> Result<LocalWav, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut wav = LocalWav::new(file.metadata().map_err(|e| e.to_string())?.len());
    let mut window = [0_u8; 16];
    while wav.length() != 0 {
        file.seek(SeekFrom::Start(wav.offset()))
            .map_err(|e| e.to_string())?;
        let bytes = &mut window[..wav.length()];
        file.read_exact(bytes).map_err(|e| e.to_string())?;
        wav.accept(bytes).map_err(|_| {
            "unsupported or malformed WAV (expected nonempty RIFF PCM16/24 or IEEE float32 mono/stereo)".to_owned()
        })?;
    }
    Ok(wav)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn fixture(bits: u16, channels: u16, rate: u32, frames: usize) -> Vec<u8> {
        let align = channels * (bits / 8);
        let data_size = frames * usize::from(align);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size as u32 + (data_size as u32 & 1)).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0");
        if bits == 32 {
            bytes[20] = 3;
        }
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * u32::from(align)).to_le_bytes());
        bytes.extend_from_slice(&align.to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_size as u32).to_le_bytes());
        for frame in 0..frames {
            for channel in 0..channels {
                if bits == 32 {
                    bytes.extend_from_slice(&expected(frame, channel as usize, bits).to_le_bytes());
                    continue;
                }
                let value = fixture_integer(frame, channel as usize, bits);
                bytes.extend_from_slice(&value.to_le_bytes()[..usize::from(bits / 8)]);
            }
        }
        if data_size & 1 != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn fixture_integer(frame: usize, channel: usize, bits: u16) -> i32 {
        let scale = 1 << (bits - 1);
        match (frame + channel * 2) % 5 {
            0 => -scale,
            1 => scale - 1,
            2 => -1,
            3 => 0,
            _ => scale / 2,
        }
    }
    pub(crate) fn expected(frame: usize, channel: usize, bits: u16) -> f32 {
        if bits == 32 {
            return [-1.5, 1.25, -0.0, 0.0, 0.5][(frame + channel * 2) % 5];
        }
        fixture_integer(frame, channel, bits) as f32 / (1 << (bits - 1)) as f32
    }
    pub(crate) fn parse(bytes: &[u8]) -> Result<LocalWav, u32> {
        let mut wav = LocalWav::new(bytes.len() as u64);
        while wav.length() != 0 {
            let start = wav.offset() as usize;
            let end = start + wav.length();
            wav.accept(bytes.get(start..end).ok_or(INVALID_WAV)?)?;
        }
        Ok(wav)
    }
    #[test]
    fn pcm16_pcm24_normalize_extrema_and_preserve_channel_identity() {
        for bits in [16, 24] {
            for channels in [1, 2] {
                for rate in [44_100, 48_000] {
                    let bytes = fixture(bits, channels, rate, 17);
                    let wav = parse(&bytes).unwrap();
                    assert_eq!(wav.total_frames(), 17);
                    assert_eq!(wav.sample_rate(), rate);
                    let start = wav.data_offset() as usize;
                    let output = wav
                        .decode(&bytes[start..start + 17 * wav.block_align() as usize])
                        .unwrap();
                    for channel in 0..channels as usize {
                        for frame in 0..17 {
                            assert_eq!(
                                output[channel * 17 + frame],
                                expected(frame, channel, bits)
                            );
                        }
                    }
                    assert!(wav.decode(&[]).is_err());
                    assert!(wav.decode(&[0; 6145]).is_err());
                }
            }
        }
    }
    #[test]
    fn float32_preserves_independent_ieee_values_and_rejects_nonfinite_blocks() {
        // Independently specified wire bits include out-of-range values, signed
        // zero, the smallest subnormal, and the largest finite float32.
        let bits = [
            0x3fc00000_u32,
            0xc0100000,
            0x80000000,
            1,
            0x7f7fffff,
            0xff7fffff,
        ];
        let expected = [1.5_f32, -2.25, -0.0, f32::from_bits(1), f32::MAX, f32::MIN];
        for channels in [1, 2] {
            let mut bytes = fixture(32, channels, 48_000, 3 * 2 / channels as usize);
            for (slot, bits) in bytes[44..].as_chunks_mut::<4>().0.iter_mut().zip(bits) {
                slot.copy_from_slice(&bits.to_le_bytes());
            }
            let wav = parse(&bytes).unwrap();
            let frames = wav.total_frames() as usize;
            let output = wav.decode(&bytes[44..]).unwrap();
            for frame in 0..frames {
                for ch in 0..channels as usize {
                    assert_eq!(
                        output[ch * frames + frame].to_bits(),
                        expected[frame * channels as usize + ch].to_bits()
                    );
                }
            }
            for invalid in [0x7f800000_u32, 0xff800000, 0x7fc00000, 0x7f800001] {
                bytes[48..52].copy_from_slice(&invalid.to_le_bytes());
                assert_eq!(wav.decode(&bytes[44..]), Err(INVALID_WAV));
            }
        }
    }

    #[test]
    fn decode_cap_is_1024_frames_for_every_encoding_and_layout() {
        for bits in [16, 24, 32] {
            for channels in [1, 2] {
                let bytes = fixture(bits, channels, 44_100, 1025);
                let wav = parse(&bytes).unwrap();
                let align = wav.block_align() as usize;
                assert_eq!(
                    wav.decode(&bytes[44..44 + 1024 * align]).unwrap().len(),
                    1024 * channels as usize
                );
                assert!(wav.decode(&bytes[44..44 + 1025 * align]).is_err());
                assert!(wav.decode(&bytes[44..44 + align - 1]).is_err());
            }
        }
        let mut float = fixture(32, 2, 48_000, 1);
        for (tag, bits) in [(1_u16, 32_u16), (3, 16), (3, 24), (3, 64), (0xfffe, 32)] {
            float[20..22].copy_from_slice(&tag.to_le_bytes());
            float[34..36].copy_from_slice(&bits.to_le_bytes());
            assert!(parse(&float).is_err());
        }
    }
    #[test]
    fn rejects_truncation_empty_encoding_layout_and_inconsistent_format() {
        let good = fixture(24, 2, 48_000, 5);
        for length in 0..good.len() {
            assert!(parse(&good[..length]).is_err(), "length {length}");
        }
        assert!(parse(&fixture(16, 1, 48_000, 0)).is_err());
        for (offset, value) in [
            (0, b'X'),
            (8, b'X'),
            (20, 3),
            (20, 0xfe),
            (22, 3),
            (24, 0),
            (28, 1),
            (32, 1),
            (34, 32),
            (40, 1),
        ] {
            let mut bad = good.clone();
            bad[offset] = value;
            assert!(parse(&bad).is_err(), "offset {offset}");
        }
        let mut huge = good.clone();
        huge[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&huge).is_err());
    }
    #[test]
    fn skips_unknown_odd_chunks_but_rejects_duplicate_and_bad_chunk_bounds() {
        let good = fixture(16, 1, 44_100, 1);
        let mut odd = good[..12].to_vec();
        odd.extend_from_slice(b"JUNK\x01\0\0\0x\0");
        odd.extend_from_slice(&good[12..]);
        let size = (odd.len() - 8) as u32;
        odd[4..8].copy_from_slice(&size.to_le_bytes());
        assert_eq!(parse(&odd).unwrap().data_offset(), 54);
        for extra in [&good[12..36], &good[36..], &[1_u8][..]] {
            let mut duplicate = good.clone();
            duplicate.extend_from_slice(extra);
            let size = (duplicate.len() - 8) as u32;
            duplicate[4..8].copy_from_slice(&size.to_le_bytes());
            assert!(parse(&duplicate).is_err());
        }
        // Data before fmt is legal: bounded scanner validates the entire RIFF before preparation.
        let mut reordered = good[..12].to_vec();
        reordered.extend_from_slice(&good[36..]);
        reordered.extend_from_slice(&good[12..36]);
        assert_eq!(parse(&reordered).unwrap().total_frames(), 1);
    }
}
