// Wrapper-layer regression test.
//
// The decoder tests (`alac-wasm.test.mjs`, `alac-wasm-stream.test.mjs`) call
// the wasm C ABI directly, so they pass even when `src/lib/alacDecoder.ts`
// (the wrapper the app actually uses) is broken. That is exactly how a
// `env.memory` bug shipped and failed on device.
//
// This test reproduces the wrapper's *exact* instantiation and memory access
// patterns and asserts the invariants the app depends on:
//   1. the module exports its own memory (no env.memory import),
//   2. every pointer handed to JS-backed typed arrays is 4-byte aligned,
//   3. a typed-array view built after a poll reads the SAME data the wasm
//      wrote (i.e. the buffer was re-read, not cached across a grow).
import { readFileSync } from "node:fs";

const wasmPath = new URL(
  "../src-tauri/alac-wasm/target/wasm32-unknown-unknown/release/alac_wasm.wasm",
  import.meta.url,
);
const bytes = readFileSync(wasmPath);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}: ${detail}`);
  }
}

// ---- 1. instantiate exactly like the wrapper (no env.memory) ----
const { instance } = await WebAssembly.instantiate(bytes, {});
const exp = instance.exports;
const memory = exp.memory;
check("module exports memory", memory instanceof WebAssembly.Memory,
  `got ${typeof memory}`);
check("module imports nothing", memory !== undefined && !("env" in (exp ?? {})),
  "exports should be self-contained");

// ---- 2. every alloc is 4-byte aligned (Int32Array view requirement) ----
let aligned = true;
let firstMisaligned = null;
for (let i = 0; i < 64; i += 1) {
  for (const len of [1, 3, 7, 9, 15, 17, 128, 1000, 262144]) {
    const ptr = exp.alac_alloc(len);
    if (ptr % 4 !== 0) {
      aligned = false;
      firstMisaligned ??= { len, ptr };
    }
    exp.alac_free(ptr, len);
  }
}
check("all allocations are 4-byte aligned", aligned,
  `first misaligned: ${JSON.stringify(firstMisaligned)}`);

// ---- 3. a poll's output is visible through a freshly built view ----
const session = exp.alac_open(BigInt(bytes.byteLength));
// Feed a real fixture if one is available; otherwise just exercise the API.
const fixture = process.argv[2];
if (fixture) {
  const file = readFileSync(fixture);
  const p = exp.alac_alloc(file.length);
  new Uint8Array(memory.buffer, p, file.length).set(file);
  exp.alac_feed(session, 0n, p, file.length);
  exp.alac_free(p, file.length);

  const cap = 65536;
  const outPtr = exp.alac_alloc(cap * 4);
  const first = exp.alac_poll(session, outPtr, cap);
  check("poll decodes a packet", first > 0, `poll returned ${first}`);
  if (first > 0) {
    // Re-read the buffer AFTER the call, exactly like alacDecoder.poll().
    const view = new Int32Array(memory.buffer, outPtr, first * 2);
    const nonZero = view.some((v) => v !== 0);
    check("decoded samples are readable via a fresh view", nonZero,
      "all samples zero — wrong buffer or no data written");
    check("out pointer is 4-byte aligned", outPtr % 4 === 0, `ptr=${outPtr}`);
  }
  exp.alac_free(outPtr, cap * 4);
} else {
  console.log("  (no fixture arg — skipped decode check)");
}
exp.alac_close(session);

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
