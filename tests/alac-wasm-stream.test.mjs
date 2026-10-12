// Streaming-path test: feed the ALAC file in 16KB chunks exactly like the
// frontend pump does (poll → NeedMoreBytes → fetch region → feed → poll),
// using alac_need_offset to request the demuxer's next region. Verifies that
// playback can start before the whole file is downloaded.
//
// Usage: node tests/alac-wasm-stream.test.mjs <path-to.m4a> [chunk-size]
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(
  new URL("../src-tauri/alac-wasm/target/wasm32-unknown-unknown/release/alac_wasm.wasm", import.meta.url),
);

const [file, chunkArg = "262144"] = process.argv.slice(2);
// Note: default chunk is 256 KiB, matching the real engine's FETCH_CHUNK.
// Smaller chunks (e.g. 16 KiB) are BELOW symphonia's max read block
// (32 KiB), which stalls the probe — a hard constraint of the pull-based
// probe, not the decoder itself.
if (!file) {
  console.error("usage: node tests/alac-wasm-stream.test.mjs <input.m4a> [chunk-size]");
  process.exit(2);
}
const CHUNK = Number(chunkArg);

const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const exp = instance.exports;
const memory = exp.memory;

const fileBytes = readFileSync(file);
const total = fileBytes.length;

let session = 0;
function feedChunk(offset, bytes) {
  const ptr = exp.alac_alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  exp.alac_feed(session, BigInt(offset), ptr, bytes.length);
  exp.alac_free(ptr, bytes.length);
}

session = exp.alac_open(BigInt(total));
const outPtr = exp.alac_alloc(65536 * 4);
const outBuf = new Int32Array(memory.buffer, outPtr, 65536);

let frames = 0;
let ended = false;
let failed = false;
let info = null;
let decodeIterations = 0;
let fetchedRanges = 0;
/** Total bytes actually transferred (sum of fetch sizes, holes included). */
let bytesTransferred = 0;
/** Bytes fetched when the first PCM packet was produced (-1 = never). */
let firstAudioAtBytes = -1;
/**
 * Sparse fetches happen only while probing (the demuxer hops to a trailing
 * `moov`). Once the first packet decodes, the pool must be kept contiguous
 * from 0, because symphonia's `next_packet` advances the sample pointer
 * BEFORE reading the bytes — a WouldBlock mid-packet permanently loses it.
 * This flag switches the fetch strategy.
 */
let probing = true;
/** Highest contiguous byte covered from 0 (0..window). */
let contiguousEnd = 0;

while (decodeIterations++ < 200000) {
  const r = exp.alac_poll(session, outPtr, 65536);
  if (r > 0) {
    frames += r;
    if (firstAudioAtBytes < 0) {
      firstAudioAtBytes = bytesTransferred;
      // First PCM decoded: probing is over. From here the pool must stay
      // contiguous from 0 so no packet can be lost to a hole.
      probing = false;
    }
    if (!info) {
      const ip = exp.alac_alloc(128);
      const ilen = exp.alac_info(session, ip, 128);
      if (ilen > 0) {
        info = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ip, ilen)));
      }
      exp.alac_free(ip, 128);
    }
  } else if (r === 0) {
    const need = Number(exp.alac_need_offset(session));
    let start;
    if (probing) {
      // The demuxer may seek for a trailing moov: fetch exactly where it asks
      // (sparse). Holes are fine while probing — it re-runs on every poll.
      start = Math.min(need, total);
    } else {
      // Decoding: sample reads are sequential through mdat, so keep the pool
      // contiguous from 0 by always fetching from the sequential frontier.
      start = Math.min(contiguousEnd, total);
    }
    const end = Math.min(start + CHUNK, total);
    if (start >= end) {
      failed = true;
      console.error(`FAIL: decoder wants bytes at ${need} (contiguous=${contiguousEnd}, probing=${probing}) but file ends at ${total}`);
      break;
    }
    feedChunk(start, fileBytes.subarray(start, end));
    bytesTransferred += end - start;
    // `contiguousEnd` tracks the contiguous prefix from 0. A sparse fetch
    // beyond it (trailing moov during probing) does not extend it.
    if (start <= contiguousEnd) {
      contiguousEnd = Math.max(contiguousEnd, end);
    }
    fetchedRanges += 1;
  } else if (r === -4) {
    failed = true;
    console.error("FAIL: not-alac");
    break;
  } else if (r === -2) {
    failed = true;
    console.error("FAIL: fatal error");
    break;
  } else if (r === -1) {
    ended = true;
    break;
  }
}

exp.alac_free(outPtr, 65536 * 4);
exp.alac_close(session);

console.log(
  `streaming: frames=${frames} contiguous=${contiguousEnd}/${total} transferred=${bytesTransferred} ranges=${fetchedRanges} ended=${ended}`,
);
console.log(
  `first audio decoded after fetching ${firstAudioAtBytes} bytes ` +
    `(${((firstAudioAtBytes / total) * 100).toFixed(1)}% of the file)`,
);

let failures = 0;
const expectedFrames = Math.round(Number(info?.duration ?? 0) * (info?.sampleRate ?? 1));
console.log(`metadata: ${JSON.stringify(info)}`);
if (!failed && ended && frames > 0) {
  console.log(`  ok  decoded ${frames} frames (expected ~${expectedFrames})`);
  if (Math.abs(frames - expectedFrames) / Math.max(1, expectedFrames) > 0.02) {
    console.error(`FAIL: frame count off by ${Math.abs(frames - expectedFrames)}`);
    failures += 1;
  }
  // Progressive playback: the first PCM must arrive before the whole file is
  // fetched. A small tail-heavy proportion (moov + first mdat window) is fine.
  if (firstAudioAtBytes >= 0 && firstAudioAtBytes < total) {
    console.log(`  ok  progressive: started after ${((firstAudioAtBytes / total) * 100).toFixed(1)}% fetched`);
  } else {
    console.error("FAIL: audio only started after the whole file was fetched");
    failures += 1;
  }
} else {
  console.error(`FAIL: ended=${ended} failed=${failed} frames=${frames}`);
  failures += 1;
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);