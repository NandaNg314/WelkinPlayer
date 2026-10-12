/**
 * Copyright 2026 Atemukesu
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Thin wrapper around the `alac-wasm` decoder (see `src-tauri/alac-wasm`).
 *
 * The wasm module exposes a C ABI over a byte pool: JS feeds downloaded chunks
 * at explicit file offsets (`feed`), then pulls decoded interleaved i32 PCM
 * packets out (`poll`). `poll` returns:
 *   >0  frames decoded (samples = frames * channels)
 *    0  need more bytes — call feed() again then retry
 *   -1  end of stream
 *   -2  fatal error
 *   -3  output buffer too small
 */

export interface AlacInfo {
  sampleRate: number;
  channels: number;
  duration: number;
}

const enum PollResult {
  NeedMoreBytes = 0,
  Ended = -1,
  Failed = -2,
  BufferTooSmall = -3,
  /** Container probed successfully but the audio codec is not ALAC. */
  NotAlac = -4,
}

export class AlacDecoder {
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private session = 0;
  private info: AlacInfo | null = null;

  private get exports(): Record<string, unknown> {
    if (!this.instance) throw new Error("alac: not loaded");
    return this.instance.exports as Record<string, unknown>;
  }

  private call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name] as ((...a: Array<number | bigint>) => number) | undefined;
    if (!fn) throw new Error(`alac: missing export ${name}`);
    return fn(...args);
  }

  async load(wasmUrl: string): Promise<void> {
    if (this.instance) return;
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`alac: failed to load ${wasmUrl} (${response.status})`);
    const bytes = await response.arrayBuffer();
    // The module does NOT import a memory; it exports its own. Passing an
    // `env.memory` would be silently ignored and every JS-side view would be
    // built against an unrelated buffer, so all fed bytes would go nowhere.
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const memory = (instance.exports as { memory?: WebAssembly.Memory }).memory;
    if (!memory) throw new Error("alac: module did not export memory");
    this.instance = instance;
    this.memory = memory;
  }

  /** Start a decoding session for a file of `totalBytes`. */
  open(totalBytes: number): void {
    this.close();
    this.session = this.call("alac_open", totalBytes);
    if (!this.session) throw new Error("alac: open failed");
    this.info = null;
  }

  close(): void {
    if (this.session) {
      this.call("alac_close", this.session);
      this.session = 0;
    }
    this.info = null;
  }

  /** Append `bytes` at file `offset`. */
  feed(offset: number, bytes: Uint8Array): void {
    if (!this.session) return;
    if (bytes.byteLength === 0) return;
    const ptr = this.call("alac_alloc", bytes.byteLength);
    if (!ptr) throw new Error("alac: alloc failed");
    new Uint8Array(this.memory!.buffer, ptr, bytes.byteLength).set(bytes);
    this.call("alac_feed", this.session, offset, ptr, bytes.byteLength);
    this.call("alac_free", ptr, bytes.byteLength);
  }

  /**
   * Decode one packet into `out` (interleaved full-scale i32).
   * Returns frame count (>0) when a packet was written to `out`.
   */
  poll(out: Int32Array): number {
    if (!this.session) return PollResult.Failed;
    const ptr = this.call("alac_alloc", out.byteLength);
    if (!ptr) return PollResult.Failed;
    const result = this.call("alac_poll", this.session, ptr, out.length);
    if (result > 0) {
      const u8 = new Uint8Array(this.memory!.buffer, ptr, out.byteLength);
      out.set(new Int32Array(u8.buffer, u8.byteOffset, out.length));
    }
    this.call("alac_free", ptr, out.byteLength);
    return result;
  }

  /** True when the whole file has been fed (poll may return Ended next). */
  get isComplete(): boolean {
    return this.session > 0 && this.call("alac_is_complete", this.session) === 1;
  }

  /** Sample rate / channel count / duration, known after the first poll. */
  get metadata(): AlacInfo | null {
    return this.info;
  }

  /** Refresh metadata from wasm (call after probe succeeds). */
  private readInfo(): AlacInfo | null {
    if (!this.session) return null;
    const cap = 128;
    const ptr = this.call("alac_alloc", cap);
    if (!ptr) return null;
    const len = this.call("alac_info", this.session, ptr, cap);
    if (len < 0) {
      this.call("alac_free", ptr, cap);
      return null;
    }
    const bytes = new Uint8Array(this.memory!.buffer, ptr, len);
    const text = new TextDecoder().decode(bytes);
    this.call("alac_free", ptr, cap);
    try {
      this.info = JSON.parse(text) as AlacInfo;
    } catch {
      this.info = null;
    }
    return this.info;
  }

  /**
   * Pull one packet, refreshing metadata once the format header has been read.
   * Returns the frame count written to `out`, or a negative PollResult code.
   */
  pollOnce(out: Int32Array): number {
    const result = this.poll(out);
    if (!this.info) this.readInfo();
    return result;
  }

  /** Seek by seconds; returns true on success. */
  seek(secs: number): boolean {
    return this.session > 0 && this.call("alac_seek", this.session, secs) === 1;
  }

  /** File offset the demuxer wants to read next (for seek/preload staging). */
  needOffset(): number {
    return this.session > 0 ? this.call("alac_need_offset", this.session) : 0;
  }

  get channels(): number {
    return this.info?.channels ?? 2;
  }

  get sampleRate(): number {
    return this.info?.sampleRate ?? 44100;
  }
}