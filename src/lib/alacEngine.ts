/**
 * Copyright 2026 Atemukesu
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { AlacDecoder } from "./alacDecoder";

/**
 * WebAudio playback engine for ALAC tracks, shaped like the `HTMLAudioElement`
 * surface `audio.ts` uses so the rest of the player is unchanged.
 *
 * `.m4a` containers may hold AAC (native in every WebView) or ALAC (native
 * nowhere). This engine probes the container through the wasm decoder; when
 * the track is not ALAC it transparently hands playback to an internal
 * `<audio>` element, so the player code neither knows nor cares which codec
 * it is talking to.
 *
 * Flow for ALAC:
 *  1. `src` set → discover file size with a tiny Range request, open session.
 *  2. Feed downloaded bytes (at explicit offsets) into the wasm decoder.
 *  3. The demuxer reports which byte region it wants next (`needOffset`);
 *     a loop fetches that region, feeds it, and polls decoded PCM packets.
 *  4. Interleaved i32 PCM is converted to planar f32 ring buffers drained by
 *     a ScriptProcessorNode (universally supported; AudioWorklet is not).
 */

/** Seconds of PCM to buffer ahead of the playhead. */
const RING_SECONDS = 2.0;
/** Chunk size for Range fetches. */
const FETCH_CHUNK = 256 * 1024;
/** i32 sample capacity requested per poll (frames * channels). */
const POLL_CAP = 65536;
/** Timeupdate cadence (matches HTMLMediaElement's ~4 Hz). */
const TIMEUPDATE_MS = 250;

function isAlacCandidate(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "m4a" || ext === "mp4" || ext === "alac" || ext === "m4b";
}

/** Media element events that must be re-emitted by the fallback audio. */
const NATIVE_EVENTS = [
  "loadedmetadata",
  "durationchange",
  "timeupdate",
  "progress",
  "play",
  "pause",
  "ended",
  "error",
] as const;

export class AlacEngine {
  private decoder = new AlacDecoder();
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private streamUrl = "";
  private totalBytes = 0;
  private closed = true;
  private generation = 0;
  private pumpRunning = false;
  private decodeFailed = false;

  /** Set once the track is known to be non-ALAC; playback goes through this. */
  private native: HTMLAudioElement | null = null;

  // Media-element-shaped state.
  private _src = "";
  private _currentTime = 0;
  private _duration = 0;
  private _volume = 1;
  private _muted = false;
  private _paused = true;
  private _endedFlag = false;
  private metadataReady = false;

  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private ringCh0 = new Float32Array(0);
  private ringCh1 = new Float32Array(0);
  private ringHead = 0;
  private ringTail = 0;
  private samplesPerChannel = 0;
  private sampleRate = 44100;
  private channels = 2;
  /** Playhead seconds at the last seek, before decoded frames accrue. */
  private seekBase = 0;
  /** Frames decoded since the last seek — drives the playhead clock. */
  private decodedFrames = 0;
  private lastTimeupdateAt = 0;

  // ---- media-element shaped accessors ------------------------------------

  get paused(): boolean {
    return this.native?.paused ?? this._paused;
  }
  get ended(): boolean {
    return this.native?.ended ?? this._endedFlag;
  }
  get seeking(): boolean {
    return this.native?.seeking ?? false;
  }
  get duration(): number {
    if (this.native) {
      const d = this.native.duration;
      return Number.isFinite(d) && d > 0 ? d : 0;
    }
    return this._duration;
  }
  get currentTime(): number {
    if (this.native) return this.native.currentTime;
    return this._currentTime;
  }
  set currentTime(seconds: number) {
    if (this.native) {
      this.native.currentTime = seconds;
      return;
    }
    void this.seekTo(seconds);
  }
  get volume(): number {
    return this.native?.volume ?? this._volume;
  }
  set volume(value: number) {
    this._volume = Math.min(1, Math.max(0, value));
    if (this.native) {
      this.native.volume = this._volume;
      return;
    }
    if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume;
  }
  get muted(): boolean {
    return this.native?.muted ?? this._muted;
  }
  set muted(value: boolean) {
    this._muted = value;
    if (this.native) {
      this.native.muted = value;
      return;
    }
    if (this.gain) this.gain.gain.value = value ? 0 : this._volume;
  }
  get error(): MediaError | null {
    if (this.native) return this.native.error;
    if (!this.decodeFailed) return null;
    const code = MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
    return { code } as MediaError;
  }
  get readyState(): number {
    if (this.native) return this.native.readyState;
    if (!this.metadataReady) return HTMLMediaElement.HAVE_NOTHING;
    if (this.ringHead !== this.ringTail) return HTMLMediaElement.HAVE_FUTURE_DATA;
    return HTMLMediaElement.HAVE_METADATA;
  }

  get src(): string {
    return this._src;
  }
  set src(value: string) {
    if (value === this._src) return;
    this._src = value;
    this.streamUrl = value;
    void this.start();
  }

  // ---- media-element shaped methods --------------------------------------

  load(): void {
    if (!this._src) {
      this.stop();
      return;
    }
    if (this.native) {
      this.native.load();
      return;
    }
    void this.start();
  }

  removeAttribute(_name: string): void {
    this.stop();
    this._src = "";
    this.streamUrl = "";
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent?.(event);
      }
    }
  }

  play(): Promise<void> {
    if (this.native) return this.native.play();
    this._paused = false;
    this._endedFlag = false;
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.dispatch("play");
    return Promise.resolve();
  }

  pause(): void {
    if (this.native) {
      this.native.pause();
      return;
    }
    this._paused = true;
    this.dispatch("pause");
  }

  // ---- non-ALAC fallback ----------------------------------------------------

  /**
   * Hand the track to an internal `<audio>` element. Emits a `loadedmetadata`
   * after the native element reports it, so callers see a consistent flow.
   */
  private fallbackToNative(): void {
    if (this.native || !this.streamUrl) return;
    const native = new Audio();
    native.preload = "metadata";
    native.volume = this._volume;
    native.muted = this._muted;
    for (const type of NATIVE_EVENTS) {
      native.addEventListener(type, () => this.dispatch(type));
    }
    native.addEventListener("loadedmetadata", () => {
      this._duration = Number.isFinite(native.duration) && native.duration > 0 ? native.duration : 0;
    });
    this.native = native;
    native.src = this.streamUrl;
    native.load();
  }

  // ---- pipeline ------------------------------------------------------------

  private async start(): Promise<void> {
    if (!this.streamUrl) return;
    this.closed = false;
    const generation = ++this.generation;

    try {
      await this.decoder.load("alac.wasm");
    } catch (error) {
      console.error("[alac] wasm load failed, falling back to native audio", error);
      this.fallbackToNative();
      return;
    }
    if (generation !== this.generation || this.closed) return;

    this.totalBytes = await this.probeFileSize();
    if (generation !== this.generation || this.closed) return;
    if (this.totalBytes <= 0) {
      console.warn("[alac] could not determine file size, falling back to native audio");
      this.fallbackToNative();
      return;
    }

    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._muted ? 0 : this._volume;
      this.gain.connect(this.ctx.destination);
      this.processor = this.ctx.createScriptProcessor(4096, 0, this.channels);
      this.processor.onaudioprocess = (event) => this.onAudioProcess(event);
      this.processor.connect(this.gain);
    }

    this.decoder.open(this.totalBytes);
    this.metadataReady = false;
    this._duration = 0;
    this._endedFlag = false;
    this.ringHead = 0;
    this.ringTail = 0;
    this.seekBase = 0;
    this.decodedFrames = 0;

    this.pump(generation);
    this.pumpRunning = true;
  }

  private stop(): void {
    this.closed = true;
    this.generation += 1;
    this.pumpRunning = false;
    this.ringHead = 0;
    this.ringTail = 0;
    this.decoder.close();
    this.metadataReady = false;
    this._endedFlag = false;
    this._paused = true;
    this.decodeFailed = false;
    if (this.native) {
      this.native.pause();
      this.native.removeAttribute("src");
      this.native.load();
      this.native = null;
    }
  }

  /** Discover the file size with `Range: bytes=0-0` through the Rust proxy. */
  private async probeFileSize(): Promise<number> {
    try {
      const response = await fetch(this.streamUrl, {
        headers: { Range: "bytes=0-0" },
      });
      if (!response.ok) return 0;
      const contentRange = response.headers.get("content-range");
      const match = contentRange?.match(/\/(\d+)\s*$/);
      if (match) return Number(match[1]);
      const length = response.headers.get("content-length");
      return length ? Number(length) : 0;
    } catch {
      return 0;
    }
  }

  /** Fetch bytes [start, start+chunk) and feed them to the decoder. */
  private async fetchAndFeed(start: number, chunk: number): Promise<boolean> {
    const end = Math.min(start + chunk, this.totalBytes);
    if (start >= end) return false;
    try {
      const response = await fetch(this.streamUrl, {
        headers: { Range: `bytes=${start}-${end - 1}` },
      });
      if (!response.ok) return false;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) return false;
      this.decoder.feed(start, new Uint8Array(buffer));
      return true;
    } catch (error) {
      console.warn("[alac] fetch failed", error);
      return false;
    }
  }

  /** Download + decode loop; runs until the ring is full, the track ends,
   *  the source changes, or a non-ALAC container forces a native fallback. */
  private async pump(generation: number): Promise<void> {
    const pcm = new Int32Array(POLL_CAP);

    while (generation === this.generation && !this.closed) {
      const result = this.decoder.pollOnce(pcm);

      if (result > 0) {
        if (!this.metadataReady) {
          this.metadataReady = true;
          const info = this.decoder.metadata;
          if (info) {
            this.sampleRate = info.sampleRate;
            this.channels = info.channels;
            this._duration = info.duration > 0 ? info.duration : 0;
            this.allocRing();
          }
          this.dispatch("loadedmetadata");
          this.dispatch("durationchange");
        }
        this.pushPcm(pcm, result);
        this.decodedFrames += result;
        this._currentTime = this.seekBase + this.decodedFrames / this.sampleRate;
        this.maybeTimeupdate();
      } else if (result === AlacPoll.NeedMoreBytes) {
        const need = this.decoder.needOffset();
        const start = Math.min(Math.max(need, 0), this.totalBytes);
        const ok = await this.fetchAndFeed(start, FETCH_CHUNK);
        if (!ok) {
          if (this.decoder.isComplete) {
            this._endedFlag = true;
            this.pumpRunning = false;
            this.dispatch("ended");
            return;
          }
          await sleep(250);
          continue;
        }
      } else if (result === AlacPoll.Ended) {
        this._endedFlag = true;
        this.pumpRunning = false;
        this.dispatch("ended");
        return;
      } else if (result === AlacPoll.NotAlac) {
        // The container is not ALAC (e.g. AAC in m4a): switch to native audio.
        this.pumpRunning = false;
        this.fallbackToNative();
        return;
      } else {
        this.decodeFailed = true;
        this.pumpRunning = false;
        this.dispatch("error");
        return;
      }

      // Keep download roughly in sync with playback: throttle once the ring is
      // full. `_currentTime` is driven by decoded frames, which is fine for a
      // continuous stream.
      if (this.ringFull()) {
        await sleep(30);
      }
    }
  }

  private allocRing(): void {
    const capacity = Math.max(4096, Math.ceil(RING_SECONDS * this.sampleRate));
    this.samplesPerChannel = capacity;
    this.ringCh0 = new Float32Array(capacity);
    this.ringCh1 = new Float32Array(capacity);
    this.ringHead = 0;
    this.ringTail = 0;
  }

  /** Convert one interleaved i32 packet into planar f32 and push to the ring. */
  private pushPcm(pcm: Int32Array, frames: number): void {
    if (this.samplesPerChannel === 0) this.allocRing();
    const writeFrames = Math.min(frames, this.availableWrite());
    const ch = this.channels >= 2 ? 2 : 1;
    for (let index = 0; index < writeFrames; index += 1) {
      const base = index * this.channels;
      const target = (this.ringHead + index) % this.samplesPerChannel;
      this.ringCh0[target] = pcm[base] / 2147483648;
      this.ringCh1[target] = ch > 1 ? pcm[base + 1] / 2147483648 : pcm[base] / 2147483648;
    }
    this.ringHead = (this.ringHead + writeFrames) % this.samplesPerChannel;
  }

  private availableWrite(): number {
    if (this.samplesPerChannel === 0) return 0;
    let available = this.ringTail - this.ringHead;
    if (available <= 0) available += this.samplesPerChannel;
    return Math.min(available, this.samplesPerChannel);
  }

  private ringFull(): boolean {
    return this.availableWrite() < this.sampleRate / 2;
  }

  private onAudioProcess(event: AudioProcessingEvent): void {
    const outL = event.outputBuffer.getChannelData(0);
    const outR = event.outputBuffer.getChannelData(1);
    const n = Math.min(outL.length, outR.length);
    for (let index = 0; index < n; index += 1) {
      if (this.ringHead === this.ringTail) {
        outL[index] = 0;
        outR[index] = 0;
        continue;
      }
      outL[index] = this.ringCh0[this.ringTail];
      outR[index] = this.ringCh1[this.ringTail];
      this.ringTail = (this.ringTail + 1) % this.samplesPerChannel;
    }
  }

  private maybeTimeupdate(): void {
    const now = performance.now();
    if (now - this.lastTimeupdateAt < TIMEUPDATE_MS) return;
    this.lastTimeupdateAt = now;
    this.dispatch("timeupdate");
  }

  async seekTo(seconds: number): Promise<void> {
    if (this.native) {
      this.native.currentTime = seconds;
      return;
    }
    if (!this.metadataReady || !this._duration) return;
    const clamped = Math.min(Math.max(0, seconds), this._duration);
    this.ringHead = 0;
    this.ringTail = 0;
    this.seekBase = clamped;
    this.decodedFrames = 0;
    this._currentTime = clamped;
    this.decoder.seek(clamped);
    this._endedFlag = false;
    if (!this.pumpRunning && !this.closed && this._src) {
      const generation = ++this.generation;
      this.pump(generation);
      this.pumpRunning = true;
    }
  }
}

/** Poll result codes shared with the decoder wrapper. */
export const enum AlacPoll {
  NeedMoreBytes = 0,
  Ended = -1,
  Failed = -2,
  BufferTooSmall = -3,
  /** "not an ALAC track" — the container holds a different codec. */
  NotAlac = -4,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decide whether a track path might contain ALAC and needs this engine. */
export function wantsAlacEngine(path: string): boolean {
  return isAlacCandidate(path);
}