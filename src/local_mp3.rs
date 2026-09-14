//! Strict, stepping MPEG-1 Layer III reader. I/O and cancellation belong to the
//! host; each accept decodes at most one packet. See the dated MP3 policy.
use symphonia::core::{
    codecs::audio::{
        AudioCodecParameters, AudioDecoder, AudioDecoderOptions, well_known::CODEC_ID_MP3,
    },
    packet::PacketBuilder,
    units::{Duration, Timestamp},
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const INVALID_MP3: u32 = 72;
const MAX_BYTES: u64 = 32 * 1024 * 1024;
const PACKET_FRAMES: u64 = 1152;
const MAX_PACKET_BYTES: usize = 1045;
const HISTORY_BYTES: usize = 511;

// One completed recipe and at most one replacement under construction. Encoded
// payload: 2*1556 + 511 rolling + 1044 carrier + 1045 packet copy <= 5712 bytes.
// Decoder buffers, host input buffers and scalar/allocator overhead are separate.
struct LoopAnchor {
    source: u64,
    raw: u64,
    offset: u64,
    unread: usize,
    predecessor_unread: usize,
    predecessor: [u8; MAX_PACKET_BYTES],
    predecessor_len: usize,
    history: [u8; HISTORY_BYTES],
    history_len: usize,
}
struct AnchorAcquisition {
    anchor: Box<LoopAnchor>,
    rolling: [u8; HISTORY_BYTES],
    rolling_len: usize,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct LocalMp3 {
    size: u64,
    end: u64,
    start: u64,
    audio_start: u64,
    offset: u64,
    length: usize,
    stage: u8,
    rate: u32,
    channels: u32,
    inspecting: bool,
    inspected: bool,
    count: u64,
    raw_position: u64,
    reservoir_bytes: usize,
    total: u64,
    delay: u64,
    padding: u64,
    declared_count: Option<u64>,
    declared_bytes: Option<u64>,
    decoder: Box<dyn AudioDecoder>,
    pcm: Vec<f32>,
    begin: usize,
    finish: usize,
    target: u64,
    loop_anchor: Option<Box<LoopAnchor>>,
    acquisition: Option<Box<AnchorAcquisition>>,
    loop_restore_packets: u64,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl LocalMp3 {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(size: u64) -> Result<Self, u32> {
        if !(10..=MAX_BYTES).contains(&size) {
            return Err(INVALID_MP3);
        }
        let mut params = AudioCodecParameters::new();
        params.for_codec(CODEC_ID_MP3);
        let mut opts = AudioDecoderOptions::default();
        opts.gapless = false;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &opts)
            .map_err(|_| INVALID_MP3)?;
        Ok(Self {
            size,
            end: size,
            start: 0,
            audio_start: 0,
            offset: 0,
            length: 10,
            stage: 0,
            rate: 0,
            channels: 0,
            inspecting: true,
            inspected: false,
            count: 0,
            raw_position: 0,
            reservoir_bytes: 0,
            total: 0,
            delay: 0,
            padding: 0,
            declared_count: None,
            declared_bytes: None,
            decoder,
            pcm: vec![0.0; 2304],
            begin: 0,
            finish: 0,
            target: 0,
            loop_anchor: None,
            acquisition: None,
            loop_restore_packets: 0,
        })
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
    pub fn total_frames(&self) -> u64 {
        self.total
    }
    pub fn available_frames(&self) -> usize {
        self.finish - self.begin
    }
    pub fn inspected(&self) -> bool {
        self.inspected
    }

    /// Reset all codec history. Hosts must step to the requested converter anchor
    /// before supplying PCM; an encoded seek is never a history proof.
    pub fn seek(&mut self, target: u64) -> Result<(), u32> {
        if !self.inspected || target > self.total {
            return Err(INVALID_MP3);
        }
        self.acquisition = None;
        self.decoder.reset();
        self.inspecting = false;
        self.raw_position = 0;
        self.reservoir_bytes = 0;
        self.target = target + self.delay;
        self.begin = 0;
        self.finish = 0;
        self.offset = if target == self.total {
            self.end
        } else {
            self.audio_start
        };
        self.next_header()
    }
    /// Preparation only: acquire one selected continuation recipe by the existing
    /// strict linear decode. Hosts must finish this before publishing loop readiness.
    pub fn prepare_loop_anchor(&mut self, source: u64) -> Result<(), u32> {
        self.acquisition = None;
        if self.loop_anchor_ready(source) {
            return Ok(());
        }
        self.seek(source)?;
        let anchor = Box::new(LoopAnchor {
            source,
            raw: (source + self.delay) / PACKET_FRAMES * PACKET_FRAMES,
            offset: self.end,
            unread: 0,
            predecessor_unread: 0,
            predecessor: [0; MAX_PACKET_BYTES],
            predecessor_len: 0,
            history: [0; HISTORY_BYTES],
            history_len: 0,
        });
        if source == self.total {
            self.loop_anchor = Some(anchor);
        } else {
            self.acquisition = Some(Box::new(AnchorAcquisition {
                anchor,
                rolling: [0; HISTORY_BYTES],
                rolling_len: 0,
            }));
        }
        Ok(())
    }
    pub fn loop_anchor_ready(&self, source: u64) -> bool {
        self.acquisition.is_none()
            && self
                .loop_anchor
                .as_ref()
                .is_some_and(|a| a.source == source)
    }
    pub fn cancel_loop_anchor(&mut self) {
        self.acquisition = None;
    }
    pub fn clear_loop_anchor(&mut self) {
        self.acquisition = None;
        self.loop_anchor = None;
    }
    pub fn loop_restore_packets(&self) -> u64 {
        self.loop_restore_packets
    }
    /// Private loop continuation, not public seeking. Never acquires an anchor.
    /// At most two discarded decodes; cancellation is checked by the host around it.
    pub fn seek_loop(&mut self, source: u64) -> Result<(), u32> {
        if source == self.total || !self.loop_anchor_ready(source) {
            return self.seek(source);
        }
        let a = self.loop_anchor.as_ref().ok_or(INVALID_MP3)?;
        let previous = &a.predecessor[..a.predecessor_len];
        if !previous.is_empty() {
            check_crc(previous, self.channels)?;
            let restored_unread = reservoir_after(previous, self.channels, a.predecessor_unread)?;
            if restored_unread != a.unread || main_data_begin(previous) > a.history_len {
                return Err(INVALID_MP3);
            }
        }
        self.decoder.reset();
        if a.raw > PACKET_FRAMES {
            // Genuine source suffix, carried by an internal zero-spectrum packet.
            // Neither this PCM nor the predecessor PCM is source/timeline output.
            let mut carrier = [0u8; 1044];
            let length = (144000 * 320 / self.rate) as usize;
            carrier[..4].copy_from_slice(&[
                255,
                251,
                224 | if self.rate == 48000 { 4 } else { 0 },
                if self.channels == 1 { 192 } else { 0 },
            ]);
            carrier[length - a.history_len..length].copy_from_slice(&a.history[..a.history_len]);
            decode_discard(&mut *self.decoder, &carrier[..length])?;
            self.loop_restore_packets = self.loop_restore_packets.saturating_add(1);
        }
        if !previous.is_empty() {
            decode_discard(&mut *self.decoder, previous)?;
            self.loop_restore_packets = self.loop_restore_packets.saturating_add(1);
        }
        self.inspecting = false;
        self.raw_position = a.raw;
        self.reservoir_bytes = a.unread; // Source history, NEVER carrier padding.
        self.target = source + self.delay;
        self.begin = 0;
        self.finish = 0;
        self.offset = a.offset;
        self.next_header()
    }
    pub fn take(&mut self, maximum: usize) -> Result<Vec<f32>, u32> {
        if self.inspecting || maximum == 0 || maximum > 1024 {
            return Err(INVALID_MP3);
        }
        let n = maximum.min(self.available_frames());
        let mut output = vec![0.0; n * self.channels as usize];
        for channel in 0..self.channels as usize {
            output[channel * n..(channel + 1) * n].copy_from_slice(
                &self.pcm[channel * 1152 + self.begin..channel * 1152 + self.begin + n],
            );
        }
        self.begin += n;
        Ok(output)
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<(), u32> {
        if bytes.len() != self.length
            || self.length == 0
            || self.offset + bytes.len() as u64 > self.size
            || self.available_frames() != 0
        {
            return Err(INVALID_MP3);
        }
        match self.stage {
            0 => {
                if &bytes[..3] == b"ID3" {
                    if !matches!(bytes[3], 3 | 4)
                        || bytes[4] == 255
                        || bytes[5] & 0x1f != 0
                        || bytes[6..10].iter().any(|b| b & 128 != 0)
                    {
                        return Err(INVALID_MP3);
                    }
                    let size = bytes[6..10]
                        .iter()
                        .fold(0u64, |n, b| (n << 7) | u64::from(*b));
                    if size > 1024 * 1024 || size + 10 >= self.size {
                        return Err(INVALID_MP3);
                    }
                    self.start = size + 10;
                }
                self.audio_start = self.start;
                if self.size >= 128 {
                    self.offset = self.size - 128;
                    self.length = 128;
                    self.stage = 1;
                    Ok(())
                } else {
                    self.offset = self.start;
                    self.next_header()
                }
            }
            1 => {
                if &bytes[..3] == b"TAG" {
                    self.end -= 128;
                }
                self.offset = self.start;
                self.next_header()
            }
            2 => {
                let (rate, channels, length) = header(bytes)?;
                if self.rate == 0 {
                    self.rate = rate;
                    self.channels = channels;
                }
                if self.rate != rate
                    || self.channels != channels
                    || self.offset + length as u64 > self.end
                {
                    return Err(INVALID_MP3);
                }
                self.length = length;
                self.stage = 3;
                Ok(())
            }
            3 => {
                let (rate, channels, length) = header(bytes)?;
                if rate != self.rate || channels != self.channels || length != bytes.len() {
                    return Err(INVALID_MP3);
                }
                check_crc(bytes, self.channels)?;
                let tag_offset = if self.channels == 1 { 21 } else { 36 };
                if self.offset != self.start
                    && (matches!(
                        bytes.get(tag_offset..tag_offset + 4),
                        Some(b"Xing" | b"Info")
                    ) || bytes.get(36..40) == Some(b"VBRI"))
                {
                    return Err(INVALID_MP3);
                }
                let tag = if self.inspecting && self.offset == self.start {
                    self.read_tag(bytes)?
                } else {
                    false
                };
                if tag {
                    self.audio_start = self.offset + bytes.len() as u64;
                } else {
                    let unread = self.reservoir_bytes;
                    let next_unread = reservoir_after(bytes, self.channels, unread)?;
                    self.capture_loop_anchor(bytes, unread);
                    self.reservoir_bytes = next_unread;
                    let packet = PacketBuilder::new()
                        .track_id(0)
                        .pts(Timestamp::new(0))
                        .dur(Duration::new(1152))
                        .data(bytes.to_vec())
                        .build();
                    let decoded = self.decoder.decode(&packet).map_err(|_| INVALID_MP3)?;
                    if decoded.samples_interleaved() != 1152 * self.channels as usize {
                        return Err(INVALID_MP3);
                    }
                    let (left, right) = self.pcm.split_at_mut(1152);
                    if self.channels == 1 {
                        decoded.copy_to_slice_planar(&mut [&mut left[..]]);
                    } else {
                        decoded.copy_to_slice_planar(&mut [&mut left[..], &mut right[..]]);
                    }
                    if self.pcm[..self.channels as usize * 1152]
                        .iter()
                        .any(|v| !v.is_finite())
                    {
                        return Err(INVALID_MP3);
                    }
                    if self.inspecting {
                        self.count += 1;
                        if self.count > 25_000 || self.count * 1152 > u64::from(self.rate) * 600 {
                            return Err(INVALID_MP3);
                        }
                    } else {
                        self.begin =
                            self.target.saturating_sub(self.raw_position).min(1152) as usize;
                        self.finish = (self.total + self.delay)
                            .saturating_sub(self.raw_position)
                            .min(1152) as usize;
                        self.begin = self.begin.min(self.finish);
                    }
                    self.raw_position += PACKET_FRAMES;
                }
                self.offset += bytes.len() as u64;
                self.next_header()
            }
            _ => Err(INVALID_MP3),
        }
    }
}

impl LocalMp3 {
    fn capture_loop_anchor(&mut self, bytes: &[u8], unread: usize) {
        let Some(pending) = &mut self.acquisition else {
            return;
        };
        if self.raw_position == pending.anchor.raw {
            pending.anchor.offset = self.offset;
            pending.anchor.unread = unread;
            self.loop_anchor = self.acquisition.take().map(|p| p.anchor);
            return;
        }
        let a = &mut pending.anchor;
        a.predecessor[..bytes.len()].copy_from_slice(bytes);
        a.predecessor_len = bytes.len();
        a.predecessor_unread = unread;
        a.history[..pending.rolling_len].copy_from_slice(&pending.rolling[..pending.rolling_len]);
        a.history_len = pending.rolling_len;
        let start = if bytes[1] & 1 == 0 { 6 } else { 4 };
        let main = &bytes[start + if self.channels == 1 { 17 } else { 32 }..];
        let keep = pending
            .rolling_len
            .min(HISTORY_BYTES.saturating_sub(main.len()));
        pending
            .rolling
            .copy_within(pending.rolling_len - keep..pending.rolling_len, 0);
        let suffix = &main[main.len().saturating_sub(HISTORY_BYTES)..];
        pending.rolling[keep..keep + suffix.len()].copy_from_slice(suffix);
        pending.rolling_len = keep + suffix.len();
    }
    fn next_header(&mut self) -> Result<(), u32> {
        if self.offset == self.end {
            self.length = 0;
            self.stage = 4;
            if self.inspecting {
                if self.count == 0
                    || self.declared_count.is_some_and(|n| n != self.count)
                    || self
                        .declared_bytes
                        .is_some_and(|n| n != self.end - self.start)
                    || self.delay + self.padding >= self.count * 1152
                {
                    return Err(INVALID_MP3);
                }
                self.total = self.count * 1152 - self.delay - self.padding;
                self.inspected = true;
            }
        } else {
            if self.offset > self.end || self.end - self.offset < 4 {
                return Err(INVALID_MP3);
            }
            self.stage = 2;
            self.length = 4;
        }
        Ok(())
    }
    fn read_tag(&mut self, bytes: &[u8]) -> Result<bool, u32> {
        if bytes.get(36..40) == Some(b"VBRI") {
            let tag = bytes.get(40..62).ok_or(INVALID_MP3)?;
            let word = |p: usize| u16::from_be_bytes([tag[p], tag[p + 1]]) as u64;
            if word(0) != 1 {
                return Err(INVALID_MP3);
            }
            // VBRI byte/count/TOC declarations are advisory: encoder byte origins
            // and scale rounding are not established by our constructed fixture.
            // Validate structure only; the bounded decode scan owns the timeline
            // and reset/decode/discard owns seeking, even for inconsistent tables.
            let entries = word(14);
            let scale = word(16);
            let width = word(18);
            let per_entry = word(20);
            if entries == 0 || scale == 0 || !(1..=4).contains(&width) || per_entry == 0 {
                return Err(INVALID_MP3);
            }
            bytes
                .get(62..62 + (entries * width) as usize)
                .ok_or(INVALID_MP3)?;
            return Ok(true);
        }
        let offset = if self.channels == 1 { 21 } else { 36 };
        if !matches!(bytes.get(offset..offset + 4), Some(b"Xing" | b"Info")) {
            return Ok(false);
        }
        let side_start = if bytes[1] & 1 == 0 { 6 } else { 4 };
        if bytes[side_start..offset].iter().any(|b| *b != 0) {
            return Err(INVALID_MP3);
        }
        let flags = be32(bytes, offset + 4)?;
        if flags & !15 != 0 {
            return Err(INVALID_MP3);
        }
        let mut p = offset + 8;
        if flags & 1 != 0 {
            self.declared_count = Some(u64::from(be32(bytes, p)?));
            p += 4;
        }
        if flags & 2 != 0 {
            self.declared_bytes = Some(u64::from(be32(bytes, p)?));
            p += 4;
        }
        if flags & 4 != 0 {
            let toc = bytes.get(p..p + 100).ok_or(INVALID_MP3)?;
            if toc.windows(2).any(|w| w[0] > w[1]) {
                return Err(INVALID_MP3);
            }
            p += 100;
        }
        if flags & 8 != 0 {
            be32(bytes, p)?;
            p += 4;
        }
        if matches!(bytes.get(p..p + 4), Some(b"LAME" | b"Lavf" | b"Lavc")) {
            let tag = bytes.get(p..p + 36).ok_or(INVALID_MP3)?;
            if tag[9] >> 4 != 0 {
                return Err(INVALID_MP3);
            }
            let trim = (u32::from(tag[21]) << 16) | (u32::from(tag[22]) << 8) | u32::from(tag[23]);
            let padding = u64::from(trim & 4095);
            if padding < 529 {
                return Err(INVALID_MP3);
            }
            self.delay = u64::from(trim >> 12) + 529;
            self.padding = padding - 529;
            let expected = u16::from_be_bytes([tag[34], tag[35]]);
            if expected != 0 && crc16(&bytes[..p + 34]) != expected {
                return Err(INVALID_MP3);
            }
        }
        Ok(true)
    }
}
fn header(b: &[u8]) -> Result<(u32, u32, usize), u32> {
    let h = be32(b, 0)?;
    if h >> 21 != 0x7ff || (h >> 19) & 3 != 3 || (h >> 17) & 3 != 1 || h & 3 == 2 {
        return Err(INVALID_MP3);
    }
    let rate = match (h >> 10) & 3 {
        0 => 44100,
        1 => 48000,
        _ => return Err(INVALID_MP3),
    };
    let index = ((h >> 12) & 15) as usize;
    let kbps = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ][index];
    if kbps == 0 {
        return Err(INVALID_MP3);
    }
    let channels = if (h >> 6) & 3 == 3 { 1 } else { 2 };
    Ok((
        rate,
        channels,
        (144000 * kbps / rate + ((h >> 9) & 1)) as usize,
    ))
}
fn main_data_begin(bytes: &[u8]) -> usize {
    let start = if bytes[1] & 1 == 0 { 6 } else { 4 };
    (usize::from(bytes[start]) << 1) | usize::from(bytes[start + 1] >> 7)
}
fn decode_discard(decoder: &mut dyn AudioDecoder, bytes: &[u8]) -> Result<(), u32> {
    let packet = PacketBuilder::new()
        .track_id(0)
        .pts(Timestamp::new(0))
        .dur(Duration::new(1152))
        .data(bytes.to_vec())
        .build();
    decoder.decode(&packet).map_err(|_| INVALID_MP3)?;
    Ok(())
}
fn be32(b: &[u8], p: usize) -> Result<u32, u32> {
    Ok(u32::from_be_bytes(
        b.get(p..p + 4)
            .ok_or(INVALID_MP3)?
            .try_into()
            .map_err(|_| INVALID_MP3)?,
    ))
}
fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for b in bytes {
        crc ^= u16::from(*b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xa001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

// Symphonia tolerates reservoir underflow by concealing missing granules. Local
// finite files must not silently accept a missing beginning or missing packet.
// MPEG-1 has two 59-bit granule/channel side-info records; each starts with the
// 12-bit part2_3_length. This checks availability, not Huffman decoding.
fn reservoir_after(bytes: &[u8], channels: u32, unread: usize) -> Result<usize, u32> {
    let start = if bytes[1] & 1 == 0 { 6 } else { 4 };
    let size = if channels == 1 { 17 } else { 32 };
    let side = bytes.get(start..start + size).ok_or(INVALID_MP3)?;
    let bits = |offset: usize, count: usize| -> usize {
        (offset..offset + count).fold(0, |n, p| {
            (n << 1) | usize::from((side[p / 8] >> (7 - p % 8)) & 1)
        })
    };
    let begin = bits(0, 9);
    if begin > unread {
        return Err(INVALID_MP3);
    }
    let first_record = if channels == 1 { 18 } else { 20 };
    let used_bits: usize = (0..channels as usize * 2)
        .map(|i| bits(first_record + i * 59, 12))
        .sum();
    let available = begin + bytes.len() - start - size;
    let used = used_bits.div_ceil(8);
    if used > available {
        return Err(INVALID_MP3);
    }
    Ok(available - used)
}

fn check_crc(bytes: &[u8], channels: u32) -> Result<(), u32> {
    if bytes[1] & 1 != 0 {
        return Ok(());
    }
    let side_end = if channels == 1 { 23 } else { 38 };
    let side = bytes.get(6..side_end).ok_or(INVALID_MP3)?;
    let mut crc = 0xffffu16;
    for b in bytes[2..4].iter().chain(side) {
        for shift in (0..8).rev() {
            let bit = ((crc >> 15) as u8) ^ ((b >> shift) & 1);
            crc <<= 1;
            if bit != 0 {
                crc ^= 0x8005;
            }
        }
    }
    if crc != u16::from_be_bytes([bytes[4], bytes[5]]) {
        return Err(INVALID_MP3);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn inspect(bytes: &[u8]) -> Result<LocalMp3, u32> {
        let mut reader = LocalMp3::new(bytes.len() as u64)?;
        while reader.length() != 0 {
            let offset = reader.offset() as usize;
            reader.accept(&bytes[offset..offset + reader.length()])?;
        }
        Ok(reader)
    }
    pub(crate) fn planar_fixture(name: &str) -> (u32, Vec<Vec<f32>>) {
        let bytes = std::fs::read(format!("tools/fixtures/mp3/{name}.mp3")).unwrap();
        let mut r = inspect(&bytes).unwrap();
        let rate = r.sample_rate();
        let mut output = vec![Vec::new(); r.channels() as usize];
        r.seek(0).unwrap();
        while r.length() != 0 || r.available_frames() != 0 {
            if r.available_frames() == 0 {
                let p = r.offset() as usize;
                r.accept(&bytes[p..p + r.length()]).unwrap();
            } else {
                let pcm = r.take(257).unwrap();
                let n = pcm.len() / output.len();
                for (c, plane) in output.iter_mut().enumerate() {
                    plane.extend_from_slice(&pcm[c * n..(c + 1) * n]);
                }
            }
        }
        (rate, output)
    }
    fn acquire(r: &mut LocalMp3, bytes: &[u8], source: u64) {
        r.prepare_loop_anchor(source).unwrap();
        while !r.loop_anchor_ready(source) {
            let at = r.offset() as usize;
            r.accept(&bytes[at..at + r.length()]).unwrap();
        }
    }
    #[test]
    fn mp3_loop_anchor_exact_suffixes_trim_and_bounded_carrier_work() {
        for name in [
            "cbr-44100-1",
            "cbr-44100-2",
            "cbr-48000-1",
            "cbr-48000-2",
            "vbr-44100-1",
            "vbr-44100-2",
            "vbr-48000-1",
            "vbr-48000-2",
            "crc",
            "vbri",
            "short",
        ] {
            let tagged = std::fs::read(format!("tools/fixtures/mp3/{name}.mp3")).unwrap();
            let first = header(&tagged[..4]).unwrap().2;
            for bytes in [&tagged[..], &tagged[first..]] {
                let mut r = inspect(bytes).unwrap();
                let mut reference = vec![Vec::new(); r.channels() as usize];
                r.seek(0).unwrap();
                while r.length() != 0 || r.available_frames() != 0 {
                    if r.available_frames() == 0 {
                        let at = r.offset() as usize;
                        r.accept(&bytes[at..at + r.length()]).unwrap();
                    } else {
                        let pcm = r.take(73).unwrap();
                        let n = pcm.len() / reference.len();
                        for (ch, p) in reference.iter_mut().enumerate() {
                            p.extend_from_slice(&pcm[ch * n..(ch + 1) * n]);
                        }
                    }
                }
                let total = r.total_frames();
                for source in [
                    0,
                    1,
                    1152u64.saturating_sub(r.delay),
                    2304u64.saturating_sub(r.delay),
                    4000,
                    total - 1,
                    total,
                ] {
                    if source > total {
                        continue;
                    }
                    acquire(&mut r, bytes, source);
                    let anchor = r.loop_anchor.as_ref().unwrap();
                    assert_eq!(anchor.predecessor.len() + anchor.history.len(), 1556);
                    for _ in 0..32 {
                        let count = r.loop_restore_packets();
                        r.seek_loop(source).unwrap();
                        assert!(r.loop_restore_packets() - count <= 2);
                        let mut at = source as usize;
                        while at < total as usize {
                            if r.available_frames() == 0 {
                                let p = r.offset() as usize;
                                r.accept(&bytes[p..p + r.length()]).unwrap();
                            } else {
                                let pcm = r.take(311).unwrap();
                                let n = pcm.len() / reference.len();
                                for (ch, p) in reference.iter().enumerate() {
                                    assert_eq!(
                                        &pcm[ch * n..(ch + 1) * n],
                                        &p[at..at + n],
                                        "{name} source {source}"
                                    );
                                }
                                at += n;
                            }
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn mp3_loop_anchor_never_uses_carrier_padding_as_source_validation() {
        let bytes = std::fs::read("tools/fixtures/mp3/cbr-48000-2.mp3").unwrap();
        let mut r = inspect(&bytes).unwrap();
        acquire(&mut r, &bytes, 4000);
        let a = r.loop_anchor.as_mut().unwrap();
        assert!(main_data_begin(&a.predecessor[..a.predecessor_len]) > 0);
        a.predecessor_unread = 0;
        assert_eq!(r.seek_loop(4000), Err(INVALID_MP3));
        r.clear_loop_anchor();
        acquire(&mut r, &bytes, 4000);
        r.seek_loop(4000).unwrap();
        let p = r.offset() as usize;
        r.accept(&bytes[p..p + 4]).unwrap();
        let p = r.offset() as usize;
        let mut bad = bytes[p..p + r.length()].to_vec();
        bad[4] = 255;
        bad[5] |= 128;
        r.reservoir_bytes = 0;
        assert_eq!(r.accept(&bad), Err(INVALID_MP3));
        let crc = std::fs::read("tools/fixtures/mp3/crc.mp3").unwrap();
        let mut r = inspect(&crc).unwrap();
        acquire(&mut r, &crc, 4000);
        r.loop_anchor.as_mut().unwrap().predecessor[6] ^= 1;
        assert_eq!(r.seek_loop(4000), Err(INVALID_MP3));
        r.clear_loop_anchor();
        acquire(&mut r, &crc, 4000);
        r.seek_loop(4000).unwrap();
        let p = r.offset() as usize;
        r.accept(&crc[p..p + 4]).unwrap();
        let p = r.offset() as usize;
        let mut bad = crc[p..p + r.length()].to_vec();
        bad[6] ^= 1;
        assert_eq!(r.accept(&bad), Err(INVALID_MP3));
    }
    #[test]
    fn mp3_loop_anchor_cancelled_replacement_cannot_install() {
        let bytes = std::fs::read("tools/fixtures/mp3/cbr-48000-2.mp3").unwrap();
        let mut r = inspect(&bytes).unwrap();
        acquire(&mut r, &bytes, 1);
        r.prepare_loop_anchor(4000).unwrap();
        assert!(r.acquisition.is_some());
        assert!(r.loop_anchor.is_some());
        r.cancel_loop_anchor();
        assert!(!r.loop_anchor_ready(4000));
        assert!(r.loop_anchor_ready(1));
        r.seek(0).unwrap();
        while r.available_frames() == 0 {
            let p = r.offset() as usize;
            r.accept(&bytes[p..p + r.length()]).unwrap();
        }
        assert!(!r.loop_anchor_ready(4000));
        r.clear_loop_anchor();
        assert!(r.loop_anchor.is_none());
        assert!(r.acquisition.is_none());
    }
    #[test]
    fn mp3_strict_metadata_missing_trim_and_malformed_inputs() {
        let good = std::fs::read("tools/fixtures/mp3/cbr-48000-2.mp3").unwrap();
        for n in [0, 1, 9, 127, 383, good.len() - 1] {
            assert!(inspect(&good[..n]).is_err(), "length {n}");
        }
        // Strip optional metadata: count actual audio, keep codec delay/padding.
        let no_tag = &good[384..];
        let plain = inspect(no_tag).unwrap();
        let mut missing_history = no_tag.to_vec();
        missing_history[4] = 255;
        assert!(inspect(&missing_history).is_err());
        assert_eq!(plain.total_frames(), 7 * 1152);
        // Xing without optional count/seek/trim fields remains finite by scan.
        let mut missing = good.clone();
        missing[40..384].fill(0);
        assert_eq!(inspect(&missing).unwrap().total_frames(), 7 * 1152);
        for (offset, value) in [
            (1, 0xf3),
            (2, 0x98),
            (3, 0xc4),
            (43, 255),
            (47, 8),
            (51, 1),
            (60, 255),
            (61, 0),
            (384, 0),
            (386, 0x90),
            (387, 0xc4),
            (177, 0xf0),
            (191, 0xff),
            (178, 0xff),
            (179, 0xff),
            (190, 1),
        ] {
            let mut bad = good.clone();
            bad[offset] = value;
            assert!(inspect(&bad).is_err(), "mutation {offset}={value}");
        }
        let mut vbri = std::fs::read("tools/fixtures/mp3/vbri.mp3").unwrap();
        for offset in [41, 55, 59] {
            let old = vbri[offset];
            vbri[offset] = 255;
            assert!(inspect(&vbri).is_err(), "VBRI {offset}");
            vbri[offset] = old;
        }
        let mut crc = std::fs::read("tools/fixtures/mp3/crc.mp3").unwrap();
        crc[390] ^= 1;
        assert!(inspect(&crc).is_err());
        let mut id3 = b"ID3\x04\0\0\0\0\0\0".to_vec();
        id3.extend_from_slice(&good);
        assert_eq!(inspect(&id3).unwrap().total_frames(), 6576);
        id3[6] = 128;
        assert!(inspect(&id3).is_err());
        let mut trailing = good.clone();
        trailing.extend_from_slice(b"TAG");
        trailing.resize(good.len() + 128, 0);
        assert_eq!(inspect(&trailing).unwrap().total_frames(), 6576);
        assert!(LocalMp3::new(MAX_BYTES + 1).is_err());
    }
    #[test]
    fn mp3_vbri_advisory_declarations_do_not_control_pcm_or_seeks() {
        fn tail(bytes: &[u8], target: u64) -> Vec<Vec<f32>> {
            let mut reader = inspect(bytes).unwrap();
            assert_eq!(reader.total_frames(), 8064);
            reader.seek(target).unwrap();
            let mut output = vec![Vec::new(); reader.channels() as usize];
            while reader.length() != 0 || reader.available_frames() != 0 {
                if reader.available_frames() == 0 {
                    let offset = reader.offset() as usize;
                    reader
                        .accept(&bytes[offset..offset + reader.length()])
                        .unwrap();
                } else {
                    let pcm = reader.take(257).unwrap();
                    let frames = pcm.len() / output.len();
                    for (channel, plane) in output.iter_mut().enumerate() {
                        plane.extend_from_slice(&pcm[channel * frames..(channel + 1) * frames]);
                    }
                }
            }
            output
        }
        let good = std::fs::read("tools/fixtures/mp3/vbri.mp3").unwrap();
        let expected = tail(&good, 0);
        let mut variants = Vec::new();
        // Includes the review reproduction: one table byte for all audio packets.
        for offset in [46, 50, 62] {
            for value in [0u32, 1, u32::MAX] {
                let mut bytes = good.clone();
                bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
                variants.push(bytes);
            }
        }
        // Two scaled groups, including a partial final group and integer
        // down-quantization. Advisory values are never decoded seek anchors.
        let mut scaled = good.clone();
        scaled[54..56].copy_from_slice(&2u16.to_be_bytes());
        scaled[56..58].copy_from_slice(&5u16.to_be_bytes());
        scaled[60..62].copy_from_slice(&4u16.to_be_bytes());
        scaled[62..66].copy_from_slice(&(4u32 * 384 / 5).to_be_bytes());
        scaled[66..70].copy_from_slice(&(3u32 * 384 / 5).to_be_bytes());
        variants.push(scaled);
        for bytes in variants {
            for target in [0, 1, 1151, 1152, 4000, 8063, 8064] {
                let actual = tail(&bytes, target);
                for (channel, plane) in actual.iter().enumerate() {
                    assert_eq!(plane, &expected[channel][target as usize..]);
                }
            }
        }
        // Unsupported/invalid structure still rejects, as does malformed audio.
        for (offset, value) in [
            (40, 2u16),
            (54, 0),
            (54, 300),
            (56, 0),
            (58, 0),
            (58, 5),
            (60, 0),
        ] {
            let mut bad = good.clone();
            bad[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
            assert!(inspect(&bad).is_err(), "VBRI structure {offset}={value}");
        }
        assert!(inspect(&good[..good.len() - 1]).is_err());
        let mut bad = good;
        bad[384] = 0;
        assert!(inspect(&bad).is_err());
    }
    #[test]
    fn mp3_fixtures_independent_ffmpeg_length_and_pcm() {
        for name in [
            "cbr-44100-1",
            "cbr-44100-2",
            "vbr-44100-1",
            "vbr-44100-2",
            "cbr-48000-1",
            "cbr-48000-2",
            "vbr-48000-1",
            "vbr-48000-2",
            "short",
            "crc",
            "vbri",
        ] {
            let bytes = std::fs::read(format!("tools/fixtures/mp3/{name}.mp3")).unwrap();
            let reference = std::fs::read(format!("tools/fixtures/mp3/{name}.f32")).unwrap();
            let mut reader = inspect(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
            let channels = reader.channels() as usize;
            assert_eq!(
                reader.total_frames() as usize * channels * 4,
                reference.len(),
                "{name}"
            );
            reader.seek(0).unwrap();
            let mut position = 0;
            let mut max_error = 0f32;
            while reader.length() != 0 || reader.available_frames() != 0 {
                if reader.available_frames() == 0 {
                    let offset = reader.offset() as usize;
                    reader
                        .accept(&bytes[offset..offset + reader.length()])
                        .unwrap();
                } else {
                    let pcm = reader.take(257).unwrap();
                    let frames = pcm.len() / channels;
                    for c in 0..channels {
                        for f in 0..frames {
                            let index = ((position + f) * channels + c) * 4;
                            let expected =
                                f32::from_le_bytes(reference[index..index + 4].try_into().unwrap());
                            max_error = max_error.max((pcm[c * frames + f] - expected).abs());
                        }
                    }
                    position += frames;
                }
            }
            assert!(max_error <= 0.00001, "{name}: {max_error}");
            eprintln!("{name}: {position} frames max FFmpeg absolute error {max_error}");
        }
    }
}
