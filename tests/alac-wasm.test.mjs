// Integration test for the alac-wasm decoder: loads the built .wasm through
// the same C ABI the frontend uses, feeds a real ALAC .m4a file, and checks
// that the decoded PCM matches the expected duration/sample rate.
//
// Usage: node tests/alac-wasm.test.mjs <path-to.m4a> [expected-seconds] [expected-rate]
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(
  new URL("../src-tauri/alac-wasm/target/wasm32-unknown-unknown/release/alac_wasm.wasm", import.meta.url),
);

const [file, expectedSecs = "3", expectedRate = "44100"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tests/alac-wasm.test.mjs <input.m4a> [secs] [rate]");
  process.exit(2);
}

// NOTE: the module exports its own `memory` (it is not imported via env), so
// all JS-side views must be created against `instance.exports.memory`.
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const exp = instance.exports;
const memory = exp.memory;

console.log(`memory pages=${memory.buffer.byteLength / 65536} heap_base=${exp.__heap_base.value}`);

const fileBytes = readFileSync(file);
const total = fileBytes.length;

/** Copy a JS Uint8Array into wasm memory at ptr. */
function feedAt(ptr, bytes) {
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}: ${detail}`);
  }
}

// ---- drive the decoder like the frontend pump does ----
const sess = exp.alac_open(BigInt(total));
console.log(`session=${sess} total=${total} bytes`);

// Feed the whole file (the frontend feeds in chunks; whole-file proves the
// pool/read logic over the full range).
const buf = new Uint8Array(fileBytes);
const ptr = exp.alac_alloc(buf.length);
feedAt(ptr, buf);
exp.alac_feed(sess, 0n, ptr, buf.length);
exp.alac_free(ptr, buf.length);

console.log("complete:", exp.alac_is_complete(sess));

// Poll until we have PCM, need more bytes (shouldn't happen — whole file fed),
// end of stream, or failure.
const POLL_CAP = 65536;
const outPtr = exp.alac_alloc(POLL_CAP * 4);
const polled = new Int32Array(POLL_CAP);

let frames = 0;
let needMoreCount = 0;
let ended = false;
let info = null;
let iterations = 0;

while (iterations++ < 100000) {
  const r = exp.alac_poll(sess, outPtr, POLL_CAP);
  if (r > 0) {
    // NOTE: `memory.buffer` can detach/replace on wasm memory growth, so the
    // output view must be re-created (and copied) per poll, never persisted.
    const outView = new Int32Array(memory.buffer, outPtr, r * 2);
    polled.set(outView);
    frames += r;
    if (!info && iterations > 0) {
      // metadata is read via alac_info after the first frame
      const ip = exp.alac_alloc(128);
      const ilen = exp.alac_info(sess, ip, 128);
      if (ilen > 0) {
        info = JSON.parse(
          new TextDecoder().decode(new Uint8Array(memory.buffer, ip, ilen)),
        );
      }
      exp.alac_free(ip, 128);
    }
  } else if (r === 0) {
    needMoreCount += 1;
  } else if (r === -4) {
    console.error("FAIL not-alac result");
    failed += 1;
    break;
  } else if (r === -2) {
    console.error("FAIL fatal decode error");
    failed += 1;
    break;
  } else if (r === -1) {
    ended = true;
    break;
  }
}

console.log(`\ndecoded frames=${frames} ended=${ended} needMore=${needMoreCount}`);

if (!info) {
  console.error("FAIL: no metadata read");
  failed += 1;
} else {
  console.log(`metadata: ${JSON.stringify(info)}`);
  check("sample rate", info.sampleRate === Number(expectedRate),
    `expected ${expectedRate}, got ${info.sampleRate}`);
  const expectedFrames = Math.round(Number(expectedSecs) * info.sampleRate);
  check("duration (seconds)", Math.abs(frames / info.sampleRate - Number(expectedSecs)) < 0.1,
    `expected ~${expectedSecs}s, got ${(frames / info.sampleRate).toFixed(3)}s`);
  check("frame count within 1%", Math.abs(frames - expectedFrames) / expectedFrames < 0.01,
    `expected ~${expectedFrames}, got ${frames}`);
}

// ---- seek test: seek to 50% and confirm we can still decode onwards ----
const seekTo = Number(expectedSecs) / 2;
const seekOk = exp.alac_seek(sess, seekTo);
console.log(`\nseek(${seekTo}s) -> ${seekOk}`);
check("seek accepted", seekOk === 1);

let framesAfterSeek = 0;
let seekEnded = false;
let seekIters = 0;
if (seekOk === 1) {
  // Reset ring in our test: decode from seek position to end.
  while (seekIters++ < 100000) {
    const r = exp.alac_poll(sess, outPtr, POLL_CAP);
    if (r > 0) {
      framesAfterSeek += r;
    } else if (r === -1) {
      seekEnded = true;
      break;
    } else if (r === -2) {
      break;
    } else if (r === 0) {
      // whole file already fed — shouldn't need more
      break;
    }
  }
  check("decodes after seek", framesAfterSeek > 0, `frames=${framesAfterSeek}`);
}

exp.alac_free(outPtr, POLL_CAP * 4);
exp.alac_close(sess);

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} checks)`}`);
process.exit(failed === 0 ? 0 : 1);