// Copyright 2026 Atemukesu
// SPDX-License-Identifier: GPL-3.0-only

//! ALAC streaming decoder compiled to `wasm32-unknown-unknown`.
//!
//! The webview cannot decode ALAC natively, so the frontend drives this
//! module through a small C ABI: it feeds downloaded bytes in arbitrary order
//! and pulls decoded interleaved i32 PCM packets out.
//!
//! Architecture note: symphonia's *container* layer is pull-based
//! (`next_packet` advances the sample pointer before reading bytes), so a
//! stream that stalls mid-packet permanently skips that packet. To stream
//! ALAC reliably we do NOT drive symphonia's format reader for playback.
//! Instead we use symphonia only to probe the container (validating ALAC and
//! obtaining the codec magic cookie), then parse the MP4 sample table
//! (`stsz`/`stco`/`stsc`) ourselves, fetch each packet's bytes whole, and
//! hand each packet to symphonia's raw `Decoder`. This is push-based: zero
//! lost packets, true progressive playback, and exact sample seeking.

use std::alloc::Layout;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_ALAC};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Byte pool shared by every `MediaSourceStream` of a session. JS appends
/// chunks at explicit offsets; reads report `WouldBlock` when the requested
/// range has not been fed yet.
#[derive(Default)]
struct BytePool {
    total: u64,
    chunks: Vec<(u64, Vec<u8>)>,
}

impl BytePool {
    fn feed(&mut self, offset: u64, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let new_end = offset.saturating_add(bytes.len() as u64);
        // Merge instead of replace: a probe fetch (e.g. a trailing moov) and a
        // later sequential fetch may overlap. Naively deleting the old chunk
        // drops the non-overlapping part (probe coverage beyond the new fetch),
        // which the demuxer still needs. Keep untouched prefixes/suffixes.
        let mut merged = Vec::with_capacity(self.chunks.len() + 1);
        for (start, data) in std::mem::take(&mut self.chunks) {
            let end = start.saturating_add(data.len() as u64);
            if end <= offset || start >= new_end {
                merged.push((start, data));
                continue;
            }
            if start < offset {
                let keep = (offset - start) as usize;
                merged.push((start, data[..keep].to_vec()));
            }
            if end > new_end {
                let cut = (new_end - start) as usize;
                merged.push((new_end, data[cut..].to_vec()));
            }
        }
        merged.push((offset, bytes.to_vec()));
        merged.sort_by_key(|(start, _)| *start);
        self.chunks = merged;
    }

    /// True when the chunk list exactly covers [0, total).
    fn complete(&self) -> bool {
        self.chunks
            .iter()
            .try_fold(0u64, |pos, (start, data)| {
                if *start != pos {
                    return None;
                }
                Some(pos + data.len() as u64)
            })
            .is_some_and(|end| end == self.total)
    }

    /// Drop packet bytes that lie wholly before the next sample. Keep a range
    /// that overlaps the boundary intact: Range fetches are already bounded,
    /// and retaining the remaining suffix avoids copying a large chunk once
    /// per decoded packet.
    fn discard_before(&mut self, offset: u64) {
        self.chunks
            .retain(|(start, data)| start.saturating_add(data.len() as u64) > offset);
    }

    /// Copy `len` bytes at `offset`; `Ok(())` only when the full range is
    /// present, else `Err(WouldBlock)`.
    fn read_exact(&self, offset: u64, buf: &mut [u8]) -> std::io::Result<()> {
        let mut got = 0usize;
        let mut need = offset;
        let mut want = offset;
        for (start, data) in &self.chunks {
            if *start + data.len() as u64 <= need {
                continue;
            }
            if *start > want {
                break;
            }
            let copy_start = (need - *start) as usize;
            let copy_len = (buf.len() - got).min(data.len() - copy_start);
            buf[got..got + copy_len].copy_from_slice(&data[copy_start..copy_start + copy_len]);
            got += copy_len;
            need += copy_len as u64;
            want = need;
            if got == buf.len() {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "byte range not fed yet",
        ))
    }
}

/// `MediaSource` used only for symphonia's *probe* (never for playback).
struct PoolSource {
    pool: Arc<Mutex<BytePool>>,
    /// Latest requested read offset, shared with the session so JS can learn
    /// which file region the demuxer wants next.
    need: Arc<Mutex<u64>>,
    pos: u64,
}

impl Read for PoolSource {
    fn read(&mut self, mut buf: &mut [u8]) -> std::io::Result<usize> {
        if let Ok(mut need) = self.need.lock() {
            *need = self.pos;
        }
        let (n, done) = {
            let pool = match self.pool.lock() {
                Ok(p) => p,
                Err(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "pool poisoned",
                    ))
                }
            };
            let end = self.pos.saturating_add(buf.len() as u64);
            if end > pool.total {
                buf = &mut buf[..(pool.total - self.pos) as usize];
            }
            match pool.read_exact(self.pos, buf) {
                Ok(()) => (buf.len(), true),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if buf.is_empty() {
                        (0, true)
                    } else {
                        (0, false)
                    }
                }
                Err(e) => return Err(e),
            }
        };
        self.pos += n as u64;
        if done {
            Ok(n)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "byte range not fed yet",
            ))
        }
    }
}

impl Seek for PoolSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::Current(d) => (self.pos as i64 + d).max(0) as u64,
            SeekFrom::End(d) => {
                let total = self.pool.lock().map(|p| p.total).unwrap_or(0);
                (total as i64 + d).max(0) as u64
            }
        };
        if let Ok(mut need) = self.need.lock() {
            *need = self.pos;
        }
        Ok(self.pos)
    }
}

impl MediaSource for PoolSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.pool.lock().ok().map(|p| p.total)
    }
}

/// One encoded ALAC packet: byte range in the file.
#[derive(Clone, Copy)]
struct Sample {
    offset: u64,
    size: u32,
}

enum SessionState {
    /// Container not parsed yet.
    Probing,
    /// Symphonia probe succeeded; codec params captured, samples parsed.
    Ready {
        decoder: Box<dyn Decoder>,
        samples: Vec<Sample>,
        next_sample: usize,
    },
    Failed,
}

pub struct Session {
    pool: Arc<Mutex<BytePool>>,
    need: Arc<Mutex<u64>>,
    state: SessionState,
    host_sample_rate: u32,
    host_channels: u16,
    host_n_frames: Option<u64>,
    sample_buf: Option<SampleBuffer<i32>>,
    last_error: String,
}

// ---- minimal MP4 box helpers ---------------------------------------------

fn be_u32(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// Find a child box of `want` inside `container` (container includes its own
/// 8-byte header; children start at byte 8).
fn find_box<'a>(container: &'a [u8], want: &[u8]) -> Option<&'a [u8]> {
    if container.len() < 8 {
        return None;
    }
    let mut off = 8usize;
    while off + 8 <= container.len() {
        let size = be_u32(container, off) as usize;
        if size < 8 || off + size > container.len() {
            return None;
        }
        if &container[off + 4..off + 8] == want {
            return Some(&container[off..off + size]);
        }
        off += size;
    }
    None
}

impl Session {
    fn new(total: u64) -> Self {
        let mut pool = BytePool::default();
        pool.total = total;
        Session {
            pool: Arc::new(Mutex::new(pool)),
            need: Arc::new(Mutex::new(0)),
            state: SessionState::Probing,
            host_sample_rate: 44100,
            host_channels: 2,
            host_n_frames: None,
            sample_buf: None,
            last_error: String::new(),
        }
    }

    fn feed(&mut self, offset: u64, bytes: &[u8]) {
        self.pool.lock().unwrap().feed(offset, bytes);
    }

    fn pool_complete(&self) -> bool {
        self.pool.lock().unwrap().complete()
    }

    /// Parse `stbl` sample table: stsz + stco + stsc.
    fn parse_samples(stbl: &[u8]) -> Option<Vec<Sample>> {
        // stsz/stco/stsc are children of the stbl box (content starts at 8).
        let stsz = find_box(stbl, b"stsz")?;
        let stco = find_box(stbl, b"stco").or_else(|| find_box(stbl, b"co64"))?;
        let stsc = find_box(stbl, b"stsc")?;

        // sample sizes
        let fixed = be_u32(stsz, 8 + 4);
        let count = be_u32(stsz, 8 + 8) as usize;
        let mut sizes = Vec::with_capacity(count);
        if fixed > 0 {
            sizes.resize(count, fixed as u32);
        } else {
            for i in 0..count {
                sizes.push(be_u32(stsz, 8 + 12 + i * 4));
            }
        }

        // chunk offsets (stco: u32; co64: u64)
        let entries = be_u32(stco, 8 + 4) as usize;
        let mut chunks = Vec::with_capacity(entries);
        let is_co64 = &stco[4..8] == b"co64";
        let base = if is_co64 { 8usize } else { 8usize };
        for i in 0..entries {
            if is_co64 {
                let off = 8 + 8 + i * 8;
                chunks.push(u64::from_be_bytes(stco[off..off + 8].try_into().ok()?));
            } else {
                chunks.push(u64::from(be_u32(stco, base + 8 + i * 4)));
            }
        }

        // sample->chunk mapping (first_chunk is 1-based)
        let sc_entries = be_u32(stsc, 8 + 4) as usize;
        struct Sc {
            first_chunk: usize,
            per_chunk: usize,
        }
        let mut sc = Vec::with_capacity(sc_entries);
        for i in 0..sc_entries {
            let base = 8 + 8 + i * 12;
            sc.push(Sc {
                first_chunk: be_u32(stsc, base) as usize,
                per_chunk: be_u32(stsc, base + 4) as usize,
            });
        }
        fn per_chunk(sc: &[Sc], chunk_1based: usize) -> usize {
            sc.iter()
                .rev()
                .find(|e| e.first_chunk <= chunk_1based)
                .map(|e| e.per_chunk)
                .unwrap_or(1)
        }

        // Walk samples assigning file offsets. A chunk holds a quota of
        // samples; once the quota is used, move to the next chunk offset.
        let mut samples = Vec::with_capacity(sizes.len());
        let mut chunk_idx = 1usize; // 1-based
        let mut quota = per_chunk(&sc, chunk_idx);
        let mut left = quota;
        let mut cursor = *chunks.first()?;
        for (i, &size) in sizes.iter().enumerate() {
            samples.push(Sample {
                offset: cursor,
                size,
            });
            cursor += u64::from(size);
            left -= 1;
            // Only advance to the next chunk when there are more samples left;
            // a trailing quota overflow must not walk past the chunk table.
            if left == 0 && i + 1 < sizes.len() {
                chunk_idx += 1;
                quota = per_chunk(&sc, chunk_idx);
                left = quota;
                cursor = *chunks.get(chunk_idx - 1)?;
            }
        }
        Some(samples)
    }

    /// Run symphonia's probe on the pool (needs ftyp + moov), validate ALAC,
    /// capture codec params, and parse the sample table.
    fn probe(&mut self) -> ProbeResult {
        let hint = Hint::new();
        let mss = MediaSourceStream::new(
            Box::new(PoolSource {
                pool: self.pool.clone(),
                need: self.need.clone(),
                pos: 0,
            }),
            Default::default(),
        );
        let probed = match symphonia::default::get_probe().format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        ) {
            Ok(p) => p,
            Err(e) => {
                self.last_error = format!("symphonia probe: {e}");
                if !self.pool_complete() {
                    // Missing bytes (ftyp or the trailing moov). `PoolSource`
                    // already pointed `need` at the first gap; the caller
                    // fetches that region and retries.
                    return ProbeResult::NeedMoreBytes;
                }
                return ProbeResult::Failed;
            }
        };
        let format = probed.format;
        let Some(track) = format.default_track().cloned() else {
            self.last_error = "no audio track".into();
            return ProbeResult::Failed;
        };
        if track.codec_params.codec != CODEC_TYPE_ALAC {
            self.last_error = "codec is not ALAC".into();
            return ProbeResult::NotAlac;
        }
        self.host_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        self.host_channels = track
            .codec_params
            .channels
            .map(|c| c.count() as u16)
            .unwrap_or(2);
        self.host_n_frames = track.codec_params.n_frames;

        let decoder = match symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
        {
            Ok(d) => d,
            Err(e) => {
                self.last_error = format!("decoder init: {e}");
                return ProbeResult::Failed;
            }
        };

        // Parse the sample table from the moov box found in the pool. It is
        // small (a few hundred bytes to a few KB) and, once symphonia probed
        // it, fully present — scoped reads keep the streaming premise intact
        // (no full-file download required to begin playback).
        let Some(moov) = self.find_moov_in_pool() else {
            return ProbeResult::NeedMoreBytes;
        };
        let Some(trak) = find_box(&moov, b"trak") else {
            self.last_error = "no trak atom".into();
            return ProbeResult::Failed;
        };
        let Some(mdia) = find_box(trak, b"mdia") else {
            self.last_error = "no mdia atom".into();
            return ProbeResult::Failed;
        };
        let Some(minf) = find_box(mdia, b"minf") else {
            self.last_error = "no minf atom".into();
            return ProbeResult::Failed;
        };
        let Some(stbl) = find_box(minf, b"stbl") else {
            self.last_error = "no stbl atom".into();
            return ProbeResult::Failed;
        };
        let samples = match Self::parse_samples(stbl) {
            Some(s) if !s.is_empty() => s,
            _ => {
                self.last_error = "empty sample table".into();
                return ProbeResult::Failed;
            }
        };

        self.state = SessionState::Ready {
            decoder,
            samples,
            next_sample: 0,
        };
        ProbeResult::Ready
    }

    /// Locate the `moov` box inside the pool without requiring the whole file.
    /// Scans each stored chunk for a `moov` type header, verifies the box size
    /// fits within the pool, and copies it out.
    fn find_moov_in_pool(&self) -> Option<Vec<u8>> {
        const HEADER: &[u8] = b"moov";
        let pool = self.pool.lock().unwrap();
        // (box file offset, declared size)
        let mut candidates: Vec<(u64, usize)> = Vec::new();
        for (chunk_start, chunk) in &pool.chunks {
            if chunk.len() < 8 {
                continue;
            }
            // Chunk bodies are appended at their file offset with no
            // alignment guarantee; scan for the moov marker anywhere.
            let mut i = 0usize;
            while i + 8 <= chunk.len() {
                if &chunk[i + 4..i + 8] == HEADER {
                    let size =
                        u32::from_be_bytes([chunk[i], chunk[i + 1], chunk[i + 2], chunk[i + 3]])
                            as usize;
                    let box_off = *chunk_start + i as u64;
                    // Accept a header seen mid-file too; box may span chunks.
                    candidates.push((box_off, size));
                    i += 4;
                } else {
                    i += 1;
                }
            }
        }
        candidates.sort_by_key(|(off, _)| *off);
        for (box_off, size) in candidates {
            if size < 8 {
                continue;
            }
            let mut buf = vec![0u8; size];
            let mut got = 0usize;
            for (chunk_start, chunk) in &pool.chunks {
                let chunk_end = *chunk_start + chunk.len() as u64;
                let box_end = box_off + size as u64;
                if chunk_end <= box_off || *chunk_start >= box_end {
                    continue;
                }
                let copy_begin = (*chunk_start).max(box_off);
                let copy_end = chunk_end.min(box_end);
                let src_from = (copy_begin - *chunk_start) as usize;
                let dst_from = (copy_begin - box_off) as usize;
                let n = (copy_end - copy_begin) as usize;
                buf[dst_from..dst_from + n].copy_from_slice(&chunk[src_from..src_from + n]);
                got += n;
            }
            if got == size {
                return Some(buf);
            }
        }
        None
    }

    /// Decode the next packet into `out` (interleaved, full-scale i32).
    fn poll(&mut self, out: &mut [i32]) -> Result<u32, PollOutcome> {
        loop {
            match &mut self.state {
                SessionState::Probing => match self.probe() {
                    ProbeResult::Ready => break,
                    ProbeResult::NeedMoreBytes => return Err(PollOutcome::NeedMoreBytes),
                    ProbeResult::NotAlac => return Err(PollOutcome::NotAlac),
                    ProbeResult::Failed => {
                        self.state = SessionState::Failed;
                        return Err(PollOutcome::Failed);
                    }
                },
                SessionState::Failed => return Err(PollOutcome::Failed),
                SessionState::Ready { .. } => break,
            }
        }

        let (decoder, samples, next_sample) = match &mut self.state {
            SessionState::Ready {
                decoder,
                samples,
                next_sample,
            } => (decoder, samples, next_sample),
            _ => unreachable!(),
        };

        if *next_sample >= samples.len() {
            return Err(PollOutcome::Ended);
        }
        let sample = samples[*next_sample];
        // Fetch the packet bytes into a reusable buffer; if not available,
        // surface the exact offset so JS can fetch it, then retry.
        let mut packet_bytes = vec![0u8; sample.size as usize];
        let ok = {
            let pool = self.pool.lock().unwrap();
            pool.read_exact(sample.offset, &mut packet_bytes).is_ok()
        };
        if !ok {
            if let Ok(mut need) = self.need.lock() {
                *need = sample.offset;
            }
            return Err(PollOutcome::NeedMoreBytes);
        }

        let packet = symphonia::core::formats::Packet::new_from_slice(
            0,
            *next_sample as u64,
            sample.size as u64,
            &packet_bytes,
        );
        // ts is packet index; dur in timebase units is not needed by ALAC.
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(e) => {
                self.last_error = format!(
                    "ALAC packet {} at byte {}: {e}",
                    *next_sample, sample.offset
                );
                return Err(PollOutcome::Failed);
            }
        };

        let spec = *decoded.spec();
        let frames = decoded.frames() as usize;
        let stale = !self
            .sample_buf
            .as_ref()
            .is_some_and(|b| b.capacity() >= frames * spec.channels.count());
        if stale {
            self.sample_buf = Some(SampleBuffer::new(frames as u64, spec));
        }
        let buf = self.sample_buf.as_mut().expect("sample buffer set");
        buf.copy_interleaved_ref(decoded);
        let written = buf.samples();
        if written.len() > out.len() {
            return Err(PollOutcome::NeedBiggerBuffer);
        }
        out[..written.len()].copy_from_slice(written);
        self.host_sample_rate = spec.rate;
        self.host_channels = spec.channels.count() as u16;
        *next_sample += 1;
        let discard_before = samples
            .get(*next_sample)
            .map(|next| next.offset)
            .unwrap_or_else(|| self.pool.lock().unwrap().total);
        self.pool.lock().unwrap().discard_before(discard_before);
        Ok(frames as u32)
    }

    fn info_json(&self) -> Option<String> {
        if !matches!(self.state, SessionState::Ready { .. }) {
            return None;
        }
        let duration = self
            .host_n_frames
            .map(|frames| frames as f64 / self.host_sample_rate as f64)
            .unwrap_or(0.0);
        Some(format!(
            r#"{{"sampleRate":{},"channels":{},"duration":{}}}"#,
            self.host_sample_rate, self.host_channels, duration
        ))
    }

    fn seek_secs(&mut self, secs: f64) -> bool {
        let (samples, next_sample) = match &mut self.state {
            SessionState::Ready {
                samples,
                next_sample,
                ..
            } => (samples.clone(), next_sample),
            _ => return false,
        };
        let rate = self.host_sample_rate.max(1) as f64;
        let target = (secs.max(0.0) * rate) as u64;
        // Samples contain roughly `frame_len` frames each; n_frames gives the
        // total. Find the sample whose cumulative frames contains `target`.
        let total_frames = self.host_n_frames.unwrap_or(0);
        let per_sample = if !samples.is_empty() {
            (total_frames as f64 / samples.len() as f64).ceil() as u64
        } else {
            return false;
        };
        let idx = ((target / per_sample.max(1)) as usize).min(samples.len().saturating_sub(1));
        *next_sample = idx;
        if let SessionState::Ready { decoder, .. } = &mut self.state {
            decoder.reset();
        }
        true
    }
}

enum ProbeResult {
    Ready,
    NeedMoreBytes,
    NotAlac,
    Failed,
}

enum PollOutcome {
    NeedMoreBytes,
    NeedBiggerBuffer,
    Ended,
    NotAlac,
    Failed,
}

// ---- C ABI exposed to the frontend ----------------------------------------

/// Alignment used for every JS-facing allocation. JS builds `Int32Array`
/// and `Float32Array` views over these pointers, which REQUIRE the offset to
/// be a multiple of 4; `Vec<u8>` only guarantees byte alignment, so a
/// misaligned pointer would throw a RangeError when the view is constructed.
const JS_ALLOC_ALIGN: usize = 8;

fn js_layout(len: usize) -> Layout {
    // `from_size_align` can fail on overflow; fall back to a 1-byte request
    // that cannot overflow (the caller treats a 0 pointer as failure anyway).
    Layout::from_size_align(len.max(1), JS_ALLOC_ALIGN).unwrap_or(Layout::new::<u8>())
}

#[no_mangle]
pub extern "C" fn alac_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    unsafe { std::alloc::alloc(js_layout(len)) }
}

#[no_mangle]
pub extern "C" fn alac_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        std::alloc::dealloc(ptr, js_layout(len));
    }
}

/// Create a decoding session for a file of `total_len` bytes.
#[no_mangle]
pub extern "C" fn alac_open(total_len: u64) -> *mut Session {
    Box::into_raw(Box::new(Session::new(total_len)))
}

/// Append `len` bytes at file `offset`. Bytes may arrive in any order and
/// overlap; later feeds overwrite earlier ones.
#[no_mangle]
pub extern "C" fn alac_feed(sess: *mut Session, offset: u64, ptr: *const u8, len: usize) {
    if sess.is_null() {
        return;
    }
    let sess = unsafe { &mut *sess };
    if ptr.is_null() || len == 0 {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    sess.feed(offset, bytes);
}

/// Pull one decoded packet into `out` (interleaved full-scale i32 samples).
///
/// Returns:
/// - `>0`: number of frames decoded (samples = frames * channels)
/// - `0`: need more bytes; call again after `alac_feed`
/// - `-1`: end of stream
/// - `-2`: fatal error
/// - `-3`: `out` too small
/// - `-4`: container is not ALAC
#[no_mangle]
pub extern "C" fn alac_poll(sess: *mut Session, out: *mut i32, out_cap: usize) -> i32 {
    if sess.is_null() {
        return -2;
    }
    let sess = unsafe { &mut *sess };
    if out.is_null() || out_cap == 0 {
        return -3;
    }
    let slice = unsafe { std::slice::from_raw_parts_mut(out, out_cap) };
    match sess.poll(slice) {
        Ok(frames) => frames as i32,
        Err(PollOutcome::NeedMoreBytes) => 0,
        Err(PollOutcome::NeedBiggerBuffer) => -3,
        Err(PollOutcome::Ended) => -1,
        Err(PollOutcome::NotAlac) => -4,
        Err(PollOutcome::Failed) => -2,
    }
}

/// True when the underlying file has been fully fed (poll may return "ended").
#[no_mangle]
pub extern "C" fn alac_is_complete(sess: *const Session) -> i32 {
    if sess.is_null() {
        return 0;
    }
    let sess = unsafe { &*sess };
    sess.pool.lock().unwrap().complete() as i32
}

/// File offset the decoder wants to read next. JS uses this to decide which
/// byte range to fetch and `feed` after a `NeedMoreBytes` poll result, or
/// after a seek.
#[no_mangle]
pub extern "C" fn alac_need_offset(sess: *const Session) -> u64 {
    if sess.is_null() {
        return 0;
    }
    let sess = unsafe { &*sess };
    sess.need.lock().map(|n| *n).unwrap_or(0)
}

/// Write the session info JSON (sample rate / channels / duration) into `buf`.
/// Returns the JSON length (excluding NUL); `-1` if `buf` is too small.
#[no_mangle]
pub extern "C" fn alac_info(sess: *const Session, buf: *mut u8, cap: usize) -> i32 {
    if sess.is_null() {
        return -2;
    }
    let sess = unsafe { &*sess };
    let Some(json) = sess.info_json() else {
        // Metadata is not valid until the container probe has completed. In
        // particular, do not expose Session's 44.1 kHz defaults while a probe
        // is still waiting for the tail `moov` atom.
        return -2;
    };
    let bytes = json.as_bytes();
    if bytes.len() + 1 > cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, bytes.len());
        *buf.add(bytes.len()) = 0;
    }
    bytes.len() as i32
}

/// Seek by seconds. Returns 1 on success, 0 otherwise.
#[no_mangle]
pub extern "C" fn alac_seek(sess: *mut Session, secs: f64) -> i32 {
    if sess.is_null() {
        return 0;
    }
    let sess = unsafe { &mut *sess };
    sess.seek_secs(secs) as i32
}

/// Copy the last error message into `buf`; returns the string length.
#[no_mangle]
pub extern "C" fn alac_last_error(sess: *const Session, buf: *mut u8, cap: usize) -> i32 {
    if sess.is_null() {
        return 0;
    }
    let sess = unsafe { &*sess };
    let bytes = sess.last_error.as_bytes();
    if buf.is_null() || cap == 0 {
        return bytes.len() as i32;
    }
    let n = bytes.len().min(cap.saturating_sub(1));
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n);
        *buf.add(n) = 0;
    }
    n as i32
}

/// Close a session and free its memory.
#[no_mangle]
pub extern "C" fn alac_close(sess: *mut Session) {
    if !sess.is_null() {
        unsafe {
            drop(Box::from_raw(sess));
        }
    }
}
