// Copyright 2026 Atemukesu
// SPDX-License-Identifier: GPL-3.0-only

//! ALAC (Apple Lossless Audio Codec) detection and lossless transcoding.
//!
//! WebViews (Chromium on Windows/Android, WebKit on Linux) do not natively support
//! ALAC playback in the HTML5 `<audio>` element. This module detects ALAC in
//! `.m4a` / `.mp4` containers and transcodes the audio losslessly to PCM WAV,
//! which every browser and WebView supports natively with full Range seeking.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_ALAC};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::AppHandle;

/// Directory where transcoded lossless WAV caches are stored.
pub fn alac_cache_dir(app: &AppHandle) -> PathBuf {
    crate::commands::media::resolve_cache_dir(app).join("alac")
}

/// Cache file path for a transcoded ALAC track.
pub fn alac_wav_path(app: &AppHandle, key: &str) -> PathBuf {
    let dir = alac_cache_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{key}.wav"))
}

/// Check if a local file contains an ALAC audio track.
pub fn is_alac_file(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("m4a");

    let probe_res = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    );

    match probe_res {
        Ok(probed) => probed
            .format
            .tracks()
            .iter()
            .any(|t| t.codec_params.codec == CODEC_TYPE_ALAC),
        Err(_) => false,
    }
}

/// Losslessly transcode an ALAC file to a standard 16-bit PCM WAV file.
pub fn transcode_alac_to_wav(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let file = File::open(input_path).map_err(|e| format!("cannot open source audio: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("m4a");

    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe failed: {e}"))?;

    let track = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_ALAC)
        .ok_or_else(|| "no ALAC track found in container".to_string())?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    let bits_per_sample: u16 = 16;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder init failed: {e}"))?;

    // Create temporary file first, then atomically rename to avoid serving half-decoded files
    let tmp_path = output_path.with_extension("wav.tmp");
    let out_file = File::create(&tmp_path).map_err(|e| format!("cannot create output file: {e}"))?;
    let mut writer = BufWriter::new(out_file);

    // Placeholder 44-byte WAV header
    let placeholder_header = [0u8; 44];
    writer
        .write_all(&placeholder_header)
        .map_err(|e| format!("write header placeholder failed: {e}"))?;

    let mut sample_buf: Option<SampleBuffer<i16>> = None;
    let mut total_pcm_bytes: u32 = 0;

    loop {
        let packet = match probed.format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => continue,
            Err(e) => {
                log::debug!("end of packets or error: {e}");
                break;
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sample_buf.is_none() {
                    let spec = *decoded.spec();
                    let duration = decoded.capacity() as u64;
                    sample_buf = Some(SampleBuffer::new(duration, spec));
                }

                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    for &sample in buf.samples() {
                        writer
                            .write_all(&sample.to_le_bytes())
                            .map_err(|e| format!("sample write failed: {e}"))?;
                        total_pcm_bytes = total_pcm_bytes.saturating_add(2);
                    }
                }
            }
            Err(Error::IoError(_)) => break,
            Err(Error::DecodeError(e)) => {
                log::warn!("decode frame error: {e}");
                continue;
            }
            Err(e) => {
                log::warn!("decoder error: {e}");
                break;
            }
        }
    }

    writer
        .flush()
        .map_err(|e| format!("flush writer failed: {e}"))?;
    let mut out_file = writer
        .into_inner()
        .map_err(|e| format!("finalize writer failed: {e}"))?;

    // Overwrite with real WAV header
    let header = make_wav_header(channels, sample_rate, bits_per_sample, total_pcm_bytes);
    out_file
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("seek start failed: {e}"))?;
    out_file
        .write_all(&header)
        .map_err(|e| format!("write header failed: {e}"))?;
    out_file
        .flush()
        .map_err(|e| format!("flush header failed: {e}"))?;
    drop(out_file);

    // Atomically rename temporary file to destination file
    std::fs::rename(&tmp_path, output_path)
        .map_err(|e| format!("rename temporary wav file failed: {e}"))?;

    log::info!(
        "successfully transcoded ALAC to WAV: {} (channels: {}, rate: {}Hz, bytes: {})",
        output_path.display(),
        channels,
        sample_rate,
        total_pcm_bytes
    );

    Ok(())
}

fn make_wav_header(
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    data_len: u32,
) -> [u8; 44] {
    let mut header = [0u8; 44];
    let byte_rate = sample_rate * (channels as u32) * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let total_chunk_size = 36u32.saturating_add(data_len);

    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&total_chunk_size.to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes()); // subchunk1 size
    header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM format (1)
    header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    header[32..34].copy_from_slice(&block_align.to_le_bytes());
    header[34..36].copy_from_slice(&bits_per_sample.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_len.to_le_bytes());
    header
}
