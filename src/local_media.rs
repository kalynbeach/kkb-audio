//! Private WAV/MP3 preparation seam; no render callback owns this reader.
use crate::{local_mp3::LocalMp3, local_wav::LocalWav};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

enum Reader {
    Wav(LocalWav),
    Mp3(LocalMp3),
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct LocalMedia {
    reader: Reader,
    reading: bool,
    position: u64,
    wav_length: usize,
    wav_pcm: Vec<f32>,
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl LocalMedia {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(size: u64, mp3: bool) -> Result<Self, u32> {
        Ok(Self {
            reader: if mp3 {
                Reader::Mp3(LocalMp3::new(size)?)
            } else {
                Reader::Wav(LocalWav::new(size))
            },
            reading: false,
            position: 0,
            wav_length: 0,
            wav_pcm: Vec::new(),
        })
    }
    pub fn anchor_and_discard(&self) -> bool {
        matches!(self.reader, Reader::Mp3(_))
    }
    pub fn channels(&self) -> u32 {
        match &self.reader {
            Reader::Wav(r) => r.channels(),
            Reader::Mp3(r) => r.channels(),
        }
    }
    pub fn sample_rate(&self) -> u32 {
        match &self.reader {
            Reader::Wav(r) => r.sample_rate(),
            Reader::Mp3(r) => r.sample_rate(),
        }
    }
    pub fn total_frames(&self) -> u64 {
        match &self.reader {
            Reader::Wav(r) => r.total_frames(),
            Reader::Mp3(r) => r.total_frames(),
        }
    }
    pub fn offset(&self) -> u64 {
        match &self.reader {
            Reader::Wav(r) if self.reading => {
                r.data_offset() + self.position * u64::from(r.block_align())
            }
            Reader::Wav(r) => r.offset(),
            Reader::Mp3(r) => r.offset(),
        }
    }
    pub fn length(&self) -> usize {
        match &self.reader {
            Reader::Wav(_) if self.reading => self.wav_length,
            Reader::Wav(r) => r.length(),
            Reader::Mp3(r) => r.length(),
        }
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<(), u32> {
        match &mut self.reader {
            Reader::Wav(r) if self.reading => {
                if bytes.len() != self.wav_length {
                    return Err(70);
                }
                self.wav_pcm = r.decode(bytes)?;
                self.wav_length = 0;
                Ok(())
            }
            Reader::Wav(r) => r.accept(bytes),
            Reader::Mp3(r) => r.accept(bytes),
        }
    }
    pub fn seek(&mut self, anchor: u64) -> Result<(), u32> {
        if anchor > self.total_frames() {
            return Err(72);
        }
        if let Reader::Mp3(r) = &mut self.reader {
            r.seek(anchor)?;
        }
        self.reading = true;
        self.position = anchor;
        self.wav_pcm.clear();
        self.wav_length = 0;
        Ok(())
    }
    pub fn prepare_loop_anchor(&mut self, source: u64) -> Result<(), u32> {
        if let Reader::Mp3(r) = &mut self.reader {
            r.prepare_loop_anchor(source)?;
        }
        Ok(())
    }
    pub fn loop_anchor_ready(&self, source: u64) -> bool {
        match &self.reader {
            Reader::Wav(_) => true,
            Reader::Mp3(r) => r.loop_anchor_ready(source),
        }
    }
    pub fn cancel_loop_anchor(&mut self) {
        if let Reader::Mp3(r) = &mut self.reader {
            r.cancel_loop_anchor();
        }
    }
    pub fn clear_loop_anchor(&mut self) {
        if let Reader::Mp3(r) = &mut self.reader {
            r.clear_loop_anchor();
        }
    }
    pub fn loop_restore_packets(&self) -> u64 {
        match &self.reader {
            Reader::Wav(_) => 0,
            Reader::Mp3(r) => r.loop_restore_packets(),
        }
    }
    pub fn seek_loop(&mut self, source: u64) -> Result<(), u32> {
        if let Reader::Mp3(r) = &mut self.reader {
            r.seek_loop(source)?;
        } else {
            return self.seek(source);
        }
        self.reading = true;
        self.position = source;
        Ok(())
    }
    pub fn request(&mut self, maximum: usize) -> Result<(), u32> {
        if !self.reading || maximum == 0 || maximum > 1024 || self.position >= self.total_frames() {
            return Err(72);
        }
        if let Reader::Wav(r) = &self.reader {
            if !self.wav_pcm.is_empty() {
                return Err(70);
            }
            self.wav_length =
                maximum.min((r.total_frames() - self.position) as usize) * r.block_align() as usize;
        }
        Ok(())
    }
    pub fn available_frames(&self) -> usize {
        match &self.reader {
            Reader::Wav(r) => self.wav_pcm.len() / r.channels().max(1) as usize,
            Reader::Mp3(r) => r.available_frames(),
        }
    }
    pub fn take(&mut self, maximum: usize) -> Result<Vec<f32>, u32> {
        let pcm = match &mut self.reader {
            Reader::Wav(_) => std::mem::take(&mut self.wav_pcm),
            Reader::Mp3(r) => r.take(maximum)?,
        };
        self.position += (pcm.len() / self.channels() as usize) as u64;
        Ok(pcm)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn read_header(file: &mut std::fs::File) -> Result<LocalMedia, String> {
    read_header_cancellable(file, || false)
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn read_header_cancellable(
    file: &mut std::fs::File,
    cancelled: impl Fn() -> bool,
) -> Result<LocalMedia, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut magic = [0u8; 4];
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_exact(&mut magic))
        .map_err(|e| e.to_string())?;
    let mut media = LocalMedia::new(
        file.metadata().map_err(|e| e.to_string())?.len(),
        &magic != b"RIFF",
    )
    .map_err(|e| format!("unsupported local media ({e})"))?;
    let started = std::time::Instant::now();
    let mut bytes = [0u8; 6144];
    while media.length() != 0 {
        if cancelled() || (media.anchor_and_discard() && started.elapsed().as_secs() >= 30) {
            return Err("media inspection cancelled or timed out".into());
        }
        let n = media.length();
        file.seek(SeekFrom::Start(media.offset()))
            .and_then(|_| file.read_exact(&mut bytes[..n]))
            .map_err(|e| e.to_string())?;
        media
            .accept(&bytes[..n])
            .map_err(|e| format!("unsupported or malformed local media ({e})"))?;
    }
    media.seek(0).map_err(|e| format!("media reset ({e})"))?;
    Ok(media)
}
