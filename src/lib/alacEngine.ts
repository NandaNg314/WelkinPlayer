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
const RING_SECONDS = 20.0;
/** Chunk size for Range fetches. Lossless (24-bit/96k) runs ~500-600 KB/s, so
 *  a small chunk means one loopback Range round-trip every few hundred ms. */
const FETCH_CHUNK = 1024 * 1024;
/** i32 sample capacity requested per poll (frames * channels). */
const POLL_CAP = 65536;
/** Timeupdate cadence (matches HTMLMediaElement's ~4 Hz). */
const TIMEUPDATE_MS = 250;
/** Consecutive fetch failures before surfacing a hard error in the pump. */
const MAX_FETCH_RETRIES = 5;
/** Bound a stalled loopback Range request so it can be retried and reported. */
const RANGE_FETCH_TIMEOUT_MS = 12_000;
/** PCM seconds that must be queued before playback may start/resume consuming.
 *  Gate the audio thread on a real reserve so a momentary main-thread stall
 *  (Vue render, GC) cannot drain the ring to zero and write silence. */
const PREBUFFER_SECONDS = 1.5;
/** Once playing, keep at least this much queued; below it we re-arm the gate. */
const REBUFFER_SECONDS = 0.75;
/** Recent pump activity used to report HAVE_CURRENT_DATA while a fetch is in
 *  progress. Playback stalls are detected from timeupdate events in audio.ts. */
const PIPELINE_ALIVE_MS = 2500;

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
  /** Invalidates a decoded packet if a seek happens while it is being queued. */
  private bufferGeneration = 0;
  /** The active Range request, cancelled when a track or seek supersedes it. */
  private rangeFetchController: AbortController | null = null;
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
  /** Decoder EOF is separate from playback EOF while queued PCM remains. */
  private inputEnded = false;
  /** True while an ALAC seek is rebuilding its buffer. */
  private _seeking = false;
  private metadataReady = false;

  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private ringCh0 = new Float32Array(0);
  private ringCh1 = new Float32Array(0);
  private ringHead = 0;
  private ringTail = 0;
  private ringCount = 0;
  private samplesPerChannel = 0;
  private sampleRate = 44100;
  private channels = 2;
  /** Playhead seconds at the last seek, before decoded frames accrue. */
  private seekBase = 0;
  /** Frames decoded since the last seek — drives the playhead clock. */
  private decodedFrames = 0;
  /** Fractional source-frame position retained while converting to device rate. */
  private resamplePhase = 0;
  private lastTimeupdateAt = 0;
  /**
   * Timestamp of the last sign of pipeline life (a packet decoded, or bytes
   * being pulled). It keeps readyState representative while a fetch is in
   * progress; the stall watchdog checks actual playhead movement.
   */
  private lastPipelineAt = 0;
  private lastProcessLogAt = 0;
  /** True while the pre-buffer gate is holding consumption back. */
  private priming = true;

  // ---- media-element shaped accessors ------------------------------------

  get paused(): boolean {
    return this.native?.paused ?? this._paused;
  }
  get ended(): boolean {
    return this.native?.ended ?? this._endedFlag;
  }
  /** True while an ALAC byte range is being read from the proxy. */
  get waitingForData(): boolean {
    return this.rangeFetchController !== null;
  }
  get seeking(): boolean {
    return this.native?.seeking ?? this._seeking;
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
    // Keep this accessor representative of the actual PCM reserve. Playback
    // progress, rather than this value, is what the stall watchdog measures.
    if (this.bufferedSeconds() >= 0.25) return HTMLMediaElement.HAVE_FUTURE_DATA;
    if (this.bufferedSeconds() > 0 || this.pipelineAlive()) {
      return HTMLMediaElement.HAVE_CURRENT_DATA;
    }
    return HTMLMediaElement.HAVE_METADATA;
  }

  /** Whether the download/decode loop has shown activity inside the stall window. */
  private pipelineAlive(): boolean {
    if (this._endedFlag || this.decodeFailed || this.closed) return false;
    if (!this.pumpRunning) return false;
    return performance.now() - this.lastPipelineAt < PIPELINE_ALIVE_MS;
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
    // Create and resume Web Audio synchronously in the play gesture. Creating
    // the context later, after the decoder's async fetches, can be blocked by
    // Android WebView's autoplay policy even though play() came from a tap.
    this.ensureAudioContext();
    this.resumeContext();
    this.dispatch("play");
    return Promise.resolve();
  }

  /**
   * Resume the AudioContext if it exists.
   *
   * Android's WebView (like every Chromium) starts an AudioContext
   * `suspended` and only allows it to run after a user gesture. `play()` can
   * be called before `start()` has finished its async setup, so the resume
   * must ALSO run right after the context is created — otherwise it stays
   * suspended forever and `onaudioprocess` never fires (silent playback).
   */
  private resumeContext(): void {
    if (this.ctx && this.ctx.state !== "running") {
      // A rejected resume means the call happened outside a user gesture
      // (Android WebView enforces the autoplay policy; the desktop-only
      // `additionalBrowserArgs` flags do not apply there). The next real tap
      // routes through play() -> resumeContext() again, so just report it.
      this.ctx.resume().catch((error) => {
        console.warn("[alac] AudioContext resume deferred (needs a user gesture)", error);
      });
    }
  }

  pause(): void {
    this._paused = true;
    if (this.native) {
      this.native.pause();
      return;
    }
    this.dispatch("pause");
  }

  private cleanupAudioContext(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private ensureAudioContext(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._muted ? 0 : this._volume;
    this.gain.connect(this.ctx.destination);
    // The ring is always converted to stereo, including mono ALAC sources.
    this.processor = this.ctx.createScriptProcessor(4096, 0, 2);
    this.processor.onaudioprocess = (event) => this.onAudioProcess(event);
    this.processor.connect(this.gain);
  }

  // ---- non-ALAC fallback ----------------------------------------------------

  /**
   * Hand the track to an internal `<audio>` element. Emits a `loadedmetadata`
   * after the native element reports it, so callers see a consistent flow.
   */
  private fallbackToNative(reason = "unknown"): void {
    console.log("[alac] fallbackToNative called, reason=", reason);
    if (this.native || !this.streamUrl) return;
    this.cleanupAudioContext();

    const native = new Audio();
    native.preload = "metadata";
    native.volume = this._volume;
    native.muted = this._muted;
    for (const type of NATIVE_EVENTS) {
      native.addEventListener(type, () => {
        if (this.native === native) {
          if (type === "ended") {
            console.log("[alac] native fallback fired ended!");
          }
          this.dispatch(type);
        }
      });
    }
    native.addEventListener("loadedmetadata", () => {
      if (this.native === native) {
        this._duration = Number.isFinite(native.duration) && native.duration > 0 ? native.duration : 0;
      }
    });
    this.native = native;
    native.src = this.streamUrl;
    native.load();

    if (!this._paused) {
      native.play().catch((error) => {
        console.warn("[alac] native fallback play failed", error);
      });
    }
  }

  // ---- pipeline ------------------------------------------------------------

  private async start(): Promise<void> {
    if (!this.streamUrl) return;
    this.abortRangeFetch();
    this.closed = false;
    const generation = ++this.generation;
    this.bufferGeneration += 1;
    this.pumpRunning = false;
    this.totalBytes = 0;
    this.metadataReady = false;
    this.decodeFailed = false;
    this.fetchFailures = 0;
    this._duration = 0;
    this._currentTime = 0;
    this._endedFlag = false;
    this.inputEnded = false;
    this._seeking = false;
    this.ringHead = 0;
    this.ringTail = 0;
    this.ringCount = 0;
    this.resamplePhase = 0;
    this.priming = true;
    this.decoder.close();

    // A new src invalidates any previous native fallback element: if a
    // previous track was AAC (played via the internal <audio>), that element
    // still targets the OLD url. The re-probe below may fall back again for
    // this track, and it must then create a fresh native bound to the NEW
    // url — otherwise switching tracks keeps replaying the previous song.
    if (this.native) {
      const old = this.native;
      this.native = null;
      old.pause();
      old.removeAttribute("src");
      old.load();
    }

    try {
      await this.decoder.load("alac.wasm");
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      console.error("[alac] wasm load failed, falling back to native audio", error);
      this.fallbackToNative();
      return;
    }
    if (generation !== this.generation || this.closed) return;

    this.totalBytes = await this.probeFileSize();
    console.log("[alac] probeFileSize result: totalBytes=", this.totalBytes);
    if (generation !== this.generation || this.closed) return;
    if (this.totalBytes <= 0) {
      console.warn("[alac] could not determine file size, falling back to native audio");
      this.fallbackToNative("no-file-size");
      return;
    }

    this.ensureAudioContext();
    // If playback began before the context existed, retry after setup. When
    // started by a tap, play() already created it synchronously in that gesture.
    this.resumeContext();

    this.decoder.open(this.totalBytes);
    this.metadataReady = false;
    this._duration = 0;
    this._endedFlag = false;
    this.inputEnded = false;
    this.ringHead = 0;
    this.ringTail = 0;
    this.ringCount = 0;
    this.resamplePhase = 0;
    this.seekBase = 0;
    this.decodedFrames = 0;
    this.priming = true;
    this.lastPipelineAt = performance.now();

    // Set `pumpRunning` BEFORE the async pump starts its first await; a
    // `seekTo` arriving mid-startup would otherwise see it false and launch a
    // stray second pump sharing the same decoder.
    this.pumpRunning = true;
    this.pump(generation);
  }

  private stop(): void {
    this.abortRangeFetch();
    this.closed = true;
    this.generation += 1;
    this.bufferGeneration += 1;
    this.pumpRunning = false;
    this.ringHead = 0;
    this.ringTail = 0;
    this.ringCount = 0;
    this.priming = true;
    this.decoder.close();
    this.metadataReady = false;
    this._endedFlag = false;
    this.inputEnded = false;
    this._paused = true;
    this.decodeFailed = false;
    this.cleanupAudioContext();
    if (this.native) {
      const old = this.native;
      this.native = null;
      old.pause();
      old.removeAttribute("src");
      old.load();
    }
  }

  /** Discover the file size with `Range: bytes=0-0` through the Rust proxy. */
  private async probeFileSize(): Promise<number> {
    try {
      const response = await fetch(this.streamUrl, {
        headers: { Range: "bytes=0-0" },
      });
      if (response.status !== 206) return 0;
      const contentRange = response.headers.get("content-range");
      const match = contentRange?.match(/^bytes 0-0\/(\d+)$/i);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  /** Fetch bytes [start, start+chunk) and feed them to the decoder. */
  private async fetchAndFeed(
    start: number,
    chunk: number,
    generation: number,
    bufferGeneration: number,
  ): Promise<boolean> {
    const end = Math.min(start + chunk, this.totalBytes);
    if (start >= end) {
      console.log("[alac] fetchAndFeed EOF: start=", start, "end=", end, "totalBytes=", this.totalBytes);
      return false;
    }
    const controller = new AbortController();
    this.rangeFetchController = controller;
    const timeout = window.setTimeout(() => controller.abort(), RANGE_FETCH_TIMEOUT_MS);
    const isCurrent = () =>
      generation === this.generation &&
      bufferGeneration === this.bufferGeneration &&
      !this.closed;
    try {
      const response = await fetch(this.streamUrl, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal: controller.signal,
      });
      if (!isCurrent()) return false;
      const contentRange = response.headers.get("content-range");
      const match = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i);
      if (
        response.status !== 206 ||
        !match ||
        Number(match[1]) !== start ||
        Number(match[2]) !== end - 1 ||
        Number(match[3]) !== this.totalBytes
      ) {
        console.warn("[alac] invalid Range response:", {
          status: response.status,
          contentRange,
          expected: `bytes ${start}-${end - 1}/${this.totalBytes}`,
        });
        return false;
      }
      const buffer = await response.arrayBuffer();
      if (!isCurrent()) return false;
      if (buffer.byteLength !== end - start) {
        console.warn("[alac] incomplete Range response:", buffer.byteLength, contentRange);
        return false;
      }
      console.log("[alac] fetchAndFeed OK: bytes=", buffer.byteLength, `[${start}..${start + buffer.byteLength})`);
      this.decoder.feed(start, new Uint8Array(buffer));
      return true;
    } catch (error) {
      // A track switch or seek intentionally cancels the old request.
      if (!isCurrent()) return false;
      if (controller.signal.aborted) {
        console.warn("[alac] Range request timed out:", `bytes=${start}-${end - 1}`);
        return false;
      }
      console.warn("[alac] fetch failed", error);
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (this.rangeFetchController === controller) {
        this.rangeFetchController = null;
      }
    }
  }

  private abortRangeFetch(): void {
    this.rangeFetchController?.abort();
    this.rangeFetchController = null;
  }

  /** Download + decode loop; runs until the ring is full, the track ends,
   *  the source changes, or a non-ALAC container forces a native fallback. */
  /** Consecutive fetch failures in the pump loop; drives a hard error. */
  private fetchFailures = 0;

  private async pump(generation: number): Promise<void> {
    console.log("[alac] pump started: generation=", generation, "totalBytes=", this.totalBytes);
    const pcm = new Int32Array(POLL_CAP);

    while (generation === this.generation && !this.closed) {
      // Respect the play/pause state: when paused we stop making progress on
      // the playhead but keep the decoder warm (the ring stays refillable so
      // resume is instant). We still poll to keep the buffer filled.
      const bufferGeneration = this.bufferGeneration;
      const result = this.decoder.pollOnce(pcm);

      if (result > 0) {
        this.fetchFailures = 0;
        this.lastPipelineAt = performance.now();
        let metadataEvent = false;
        if (!this.metadataReady) {
          this.metadataReady = true;
          metadataEvent = true;
          const info = this.decoder.metadata;
          if (info) {
            this.sampleRate = info.sampleRate;
            this.resamplePhase = 0;
            this.channels = info.channels;
            this._duration = info.duration > 0 ? info.duration : 0;
            this.allocRing();
            console.log("[alac] metadata ready: sampleRate=", this.sampleRate, "channels=", this.channels, "duration=", this._duration);
          }
        }
        await this.pushPcm(pcm, result, generation, bufferGeneration);
        if (
          metadataEvent &&
          generation === this.generation &&
          bufferGeneration === this.bufferGeneration
        ) {
          // Dispatch after the first decoded packet is queued. A pending seek
          // from the loadedmetadata handler can now clear it without letting a
          // stale pre-seek packet play afterward.
          this.dispatch("loadedmetadata");
          this.dispatch("durationchange");
        }
      } else if (result === AlacPoll.NeedMoreBytes) {
        // Pull the region the demuxer wants. Once a comfortable reserve is
        // queued, stop fetching so a phone does not pull the whole lossless
        // file in one burst; the loop wakes when playback drains below the
        // reserve. (`ringFull()` below is the coarse brake; this one keeps the
        // buffer near the top instead of sawtoothing.)
        if (this.bufferedSeconds() >= RING_SECONDS * 0.8) {
          await sleep(150);
          continue;
        }
        const need = this.decoder.needOffset();
        const start = Math.min(Math.max(need, 0), this.totalBytes);
        console.log("[alac] NeedMoreBytes: needOffset=", need, "start=", start, "buffered=", this.bufferedSeconds().toFixed(2));
        const ok = await this.fetchAndFeed(start, FETCH_CHUNK, generation, bufferGeneration);
        if (generation !== this.generation || this.closed) return;
        if (bufferGeneration !== this.bufferGeneration) continue;
        if (!ok) {
          // A persistent failure (bad token after a proxy restart, a Range the
          // proxy rejects, network drop) must not retry forever: after a
          // budget, surface a real error instead of spinning silently.
          this.fetchFailures += 1;
          if (this.fetchFailures >= MAX_FETCH_RETRIES) {
            console.warn("[alac] pump fetch failed max retries, dispatching error");
            this.decodeFailed = true;
            this.pumpRunning = false;
            this.dispatch("error");
            return;
          }
          await sleep(250);
          continue;
        }
        this.lastPipelineAt = performance.now();
      } else if (result === AlacPoll.Ended) {
        // The demuxer can reach file EOF while the final decoded PCM is still
        // queued. Keep the pump closed, but report media `ended` only after the
        // audio callback has drained that tail so the playlist cannot cut it.
        console.log("[alac] decoder reached EOF; waiting for queued PCM:", "ringCount=", this.ringCount, "currentTime=", this._currentTime);
        this.inputEnded = true;
        this.pumpRunning = false;
        this.finishIfDrained();
        return;
      } else if (result === AlacPoll.NotAlac) {
        // The container is not ALAC (e.g. AAC in m4a): switch to native audio.
        console.log("[alac] container is NotAlac, falling back to native audio");
        this.pumpRunning = false;
        this.fallbackToNative("not-alac");
        return;
      } else {
        const diag = this.decoder.readError();
        if (diag) {
          console.warn("[alac] decoder error:", diag);
        }
        // Fatal decode/probe error. If we never even got metadata, the file
        // may simply be an m4a whose ALAC probe failed (a non-ALAC container
        // we could not classify) — give the native element a chance instead
        // of declaring the track unplayable.
        if (!this.metadataReady && this.streamUrl) {
          this.pumpRunning = false;
          this.fallbackToNative();
          return;
        }
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
    this.ringCount = 0;
    // A fresh (empty) ring has no reserve yet, so the gate must hold.
    this.priming = true;
  }

  /** Convert one interleaved i32 packet into planar f32 and push to the ring. */
  private async pushPcm(
    pcm: Int32Array,
    frames: number,
    generation: number,
    bufferGeneration: number,
  ): Promise<void> {
    if (this.samplesPerChannel === 0) this.allocRing();
    let written = 0;
    const ch = this.channels >= 2 ? 2 : 1;
    const capacity = this.samplesPerChannel;
    // Multiply by the reciprocal instead of dividing per sample: a phone decodes
    // 96k+ of these and the divide cost shows up on the main thread.
    const scale = 1 / 2147483648;

    while (
      written < frames &&
      generation === this.generation &&
      bufferGeneration === this.bufferGeneration &&
      !this.closed
    ) {
      const available = capacity - this.ringCount;
      if (available <= 0) {
        await sleep(20);
        continue;
      }
      const toWrite = Math.min(frames - written, available);
      // Split the write at the wrap point so the inner loops index contiguously
      // with no per-sample modulo.
      const untilWrap = capacity - this.ringHead;
      const first = Math.min(toWrite, untilWrap);
      let head = this.ringHead;
      for (let index = 0; index < first; index += 1) {
        const base = (written + index) * this.channels;
        this.ringCh0[head] = pcm[base] * scale;
        this.ringCh1[head] = ch > 1 ? pcm[base + 1] * scale : pcm[base] * scale;
        head += 1;
      }
      const second = toWrite - first;
      for (let index = 0; index < second; index += 1) {
        const base = (written + first + index) * this.channels;
        this.ringCh0[index] = pcm[base] * scale;
        this.ringCh1[index] = ch > 1 ? pcm[base + 1] * scale : pcm[base] * scale;
      }
      this.ringHead = (this.ringHead + toWrite) % capacity;
      this.ringCount += toWrite;
      written += toWrite;
    }
  }

  private ringFull(): boolean {
    if (this.samplesPerChannel === 0) return false;
    return (this.samplesPerChannel - this.ringCount) < this.sampleRate / 2;
  }

  /** Seconds of PCM currently queued in the ring (decoded but unplayed). */
  private bufferedSeconds(): number {
    if (this.samplesPerChannel === 0) return 0;
    return this.ringCount / this.sampleRate;
  }

  private onAudioProcess(event: AudioProcessingEvent): void {
    const outL = event.outputBuffer.getChannelData(0);
    const outR = event.outputBuffer.getChannelData(1);
    const n = Math.min(outL.length, outR.length);
    // A paused engine must be silent. ScriptProcessorNode keeps firing while
    // connected, so gating here (rather than suspending the context) is what
    // actually stops the sound; the ring is deliberately NOT drained so a
    // resume continues from the same sample.
    if (this._paused) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    // Pre-buffer gate: do not start consuming until a real reserve is queued,
    // and re-arm it after an underrun. Without this the audio thread begins
    // draining the instant one packet lands and then runs at the water line —
    // any main-thread hitch (Vue render, GC, a big pushPcm burst) drains the
    // ring to zero and we write silence, heard as "一卡一卡".
    const buffered = this.bufferedSeconds();
    if (!this.inputEnded) {
      if (this.priming) {
        if (buffered >= PREBUFFER_SECONDS) {
          this.priming = false;
        } else {
          outL.fill(0);
          outR.fill(0);
          return;
        }
      } else if (buffered < REBUFFER_SECONDS) {
        this.priming = true;
        outL.fill(0);
        outR.fill(0);
        return;
      }
    }
    // ALAC PCM is in the file's sample rate, while WebAudio's output rate is
    // fixed by the Android device (commonly 48 kHz). Writing 96 kHz samples
    // one-for-one into a 48 kHz context halves both pitch and playback speed.
    // Convert source frames to the device rate before writing the output.
    const outputRate = this.ctx?.sampleRate || this.sampleRate;
    const ratio = this.sampleRate / outputRate;
    let sourceFramesConsumed = 0;
    let outputFramesWritten = 0;
    const phase = this.resamplePhase;
    const ringSample = (channel: Float32Array, offset: number) => channel[(this.ringTail + offset) % this.samplesPerChannel];

    if (ratio >= 1) {
      // A weighted box filter averages each source interval. In the common
      // 96 kHz -> 48 kHz case this averages pairs, avoiding harsh aliasing.
      const available = Math.min(n, this.inputEnded
        ? Math.max(0, Math.ceil((this.ringCount - phase) / ratio))
        : Math.max(0, Math.floor((this.ringCount - phase) / ratio)));
      for (let index = 0; index < available; index += 1) {
        const start = phase + index * ratio;
        const end = this.inputEnded ? Math.min(start + ratio, this.ringCount) : start + ratio;
        const first = Math.floor(start);
        const last = Math.ceil(end);
        let sumL = 0;
        let sumR = 0;
        const interval = end - start;
        for (let source = first; source < last; source += 1) {
          const weight = Math.min(end, source + 1) - Math.max(start, source);
          if (weight <= 0) continue;
          sumL += ringSample(this.ringCh0, source) * weight;
          sumR += ringSample(this.ringCh1, source) * weight;
        }
        outL[index] = sumL / interval;
        outR[index] = sumR / interval;
      }
      outputFramesWritten = available;
      const advanced = phase + available * ratio;
      sourceFramesConsumed = this.inputEnded
        ? Math.min(this.ringCount, Math.floor(advanced))
        : Math.floor(advanced);
      this.resamplePhase = sourceFramesConsumed >= this.ringCount ? 0 : advanced - sourceFramesConsumed;
    } else {
      // Linear interpolation for upsampling; retain one look-ahead frame in
      // the ring so a packet boundary never produces a discontinuity.
      const available = Math.min(n, this.inputEnded
        ? Math.max(0, Math.ceil((this.ringCount - phase) / ratio))
        : Math.max(0, Math.floor((this.ringCount - 1 - phase) / ratio) + 1));
      for (let index = 0; index < available; index += 1) {
        const position = phase + index * ratio;
        const lower = this.inputEnded
          ? Math.min(this.ringCount - 1, Math.floor(position))
          : Math.floor(position);
        const upper = this.inputEnded ? Math.min(this.ringCount - 1, lower + 1) : lower + 1;
        const fraction = upper === lower ? 0 : position - lower;
        const left0 = ringSample(this.ringCh0, lower);
        const right0 = ringSample(this.ringCh1, lower);
        const left1 = ringSample(this.ringCh0, upper);
        const right1 = ringSample(this.ringCh1, upper);
        outL[index] = left0 + (left1 - left0) * fraction;
        outR[index] = right0 + (right1 - right0) * fraction;
      }
      outputFramesWritten = available;
      const advanced = phase + available * ratio;
      sourceFramesConsumed = this.inputEnded
        ? Math.min(this.ringCount, Math.floor(advanced))
        : Math.floor(advanced);
      this.resamplePhase = sourceFramesConsumed >= this.ringCount ? 0 : advanced - sourceFramesConsumed;
    }

    this.ringTail = (this.ringTail + sourceFramesConsumed) % this.samplesPerChannel;
    this.ringCount -= sourceFramesConsumed;
    if (outputFramesWritten < n) {
      outL.fill(0, outputFramesWritten);
      outR.fill(0, outputFramesWritten);
    }
    if (outputFramesWritten > 0) {
      // Advance by output time, not an integer-rounded count of source frames.
      this.decodedFrames += outputFramesWritten * ratio;
      this._currentTime = this.seekBase + this.decodedFrames / this.sampleRate;
      this.maybeTimeupdate();
      const now = performance.now();
      if (now - this.lastProcessLogAt > 2000) {
        this.lastProcessLogAt = now;
        console.log(`[alac] audioProcess: pos=${this._currentTime.toFixed(1)}/${this._duration.toFixed(1)}s, sourceRate=${this.sampleRate}, outputRate=${outputRate}, ringCount=${this.ringCount}, buffered=${buffered.toFixed(2)}s, priming=${this.priming}`);
      }
    }
    this.finishIfDrained();
  }

  /** Emit the media-element ended event only after the final PCM was rendered. */
  private finishIfDrained(): void {
    if (!this.inputEnded || this._endedFlag || this.ringCount > 0 || this._paused || this.closed) return;
    this._endedFlag = true;
    if (this._duration > 0) this._currentTime = this._duration;
    this.dispatch("timeupdate");
    this.dispatch("ended");
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
    this.abortRangeFetch();
    this.bufferGeneration += 1;
    this.ringHead = 0;
    this.ringTail = 0;
    this.ringCount = 0;
    this.resamplePhase = 0;
    this.seekBase = clamped;
    this.decodedFrames = 0;
    this._currentTime = clamped;
    this.inputEnded = false;
    // Re-prime: the ring was cleared, so rebuild the reserve before resuming.
    this.priming = true;
    if (!this.decoder.seek(clamped)) {
      this._seeking = false;
      this.decodeFailed = true;
      this.pumpRunning = false;
      this.dispatch("error");
      return;
    }
    this._endedFlag = false;
    // Mark seeking so audio.ts's stall watchdog does not mistake the refill
    // window for a stall and force a reload mid-seek.
    this._seeking = true;
    window.setTimeout(() => {
      this._seeking = false;
    }, 500);
    if (!this.pumpRunning && !this.closed && this._src) {
      const generation = ++this.generation;
      this.pumpRunning = true;
      this.pump(generation);
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
