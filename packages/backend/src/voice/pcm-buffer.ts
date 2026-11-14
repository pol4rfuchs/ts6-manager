import { SAMPLE_RATE, CHANNELS } from './audio/pipeline.js';

/** Raw PCM from the decode ffmpeg: s16le, 48 kHz, 2 channels. */
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * 2;
const FRAME_ALIGN = CHANNELS * 2; // one sample of all channels

export interface WaterMarks {
  highBytes: number;
  lowBytes: number;
  /** Live streams may buffer at most this much; older audio is dropped. */
  liveMaxBytes: number;
}

const DEFAULT_HIGH_SECONDS = 20;
const DEFAULT_LIVE_MAX_SECONDS = 30;

function envSeconds(raw: string | undefined, min: number, max: number): number | null {
  const n = parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * How much decoded audio the bot may hold. The decode ffmpeg is paused at the
 * high mark and resumed at the low mark, so memory stays constant however long
 * a track is. `PCM_BUFFER_HIGH_SECONDS` / `PCM_BUFFER_LOW_SECONDS` override the
 * defaults (20 s and half of the high mark); invalid values are ignored.
 */
export function resolveWaterMarks(env: Record<string, string | undefined> = process.env): WaterMarks {
  const high = envSeconds(env.PCM_BUFFER_HIGH_SECONDS, 2, 120) ?? DEFAULT_HIGH_SECONDS;
  let low = envSeconds(env.PCM_BUFFER_LOW_SECONDS, 1, 119) ?? high / 2;
  if (low >= high) low = high / 2;
  return {
    highBytes: Math.round(high * BYTES_PER_SECOND),
    lowBytes: Math.round(low * BYTES_PER_SECOND),
    liveMaxBytes: Math.round(DEFAULT_LIVE_MAX_SECONDS * BYTES_PER_SECOND),
  };
}

export interface PcmBufferHooks {
  /** Stop reading from the decoder (the buffer reached the high mark). */
  hold(): void;
  /** Read from the decoder again (the buffer fell to the low mark). */
  release(): void;
}

/**
 * FIFO of decoded PCM with backpressure.
 *
 * `hold` mode (files and tracks streamed from a server): once the buffer
 * reaches the high mark `hooks.hold()` is called on every push, and when
 * playback has drained it to the low mark `hooks.release()` is called once.
 * `drop` mode (live radio, which cannot be paused): the buffer never grows
 * beyond the live maximum, the oldest audio is discarded instead.
 */
export class PcmBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private holding = false;

  constructor(
    private readonly marks: WaterMarks,
    private readonly mode: 'hold' | 'drop',
    private readonly hooks: PcmBufferHooks,
  ) {}

  get size(): number {
    return this.bytes;
  }

  /** True while the decoder is held back because the buffer is full. */
  get held(): boolean {
    return this.holding;
  }

  /** True when the decoder may run: not held, or already drained to the low mark. */
  get wantsData(): boolean {
    return !this.holding || this.bytes <= this.marks.lowBytes;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.mode === 'drop') {
      this.dropOldest(this.bytes - this.marks.liveMaxBytes);
    } else if (this.bytes >= this.marks.highBytes) {
      this.holding = true;
      this.hooks.hold(); // repeated on purpose: a stray resume() must not let the buffer grow
    }
  }

  /** Remove exactly `n` bytes from the front, or null if fewer are buffered. */
  take(n: number): Buffer | null {
    if (this.bytes < n) return null;

    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const need = n - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        this.chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    this.bytes -= n;

    if (this.holding && this.bytes <= this.marks.lowBytes) {
      this.holding = false;
      this.hooks.release();
    }
    return out;
  }

  /** Everything that is left (less than a frame), zero-padded to `frameBytes`. */
  takeRemainderPadded(frameBytes: number): Buffer | null {
    if (this.bytes === 0) return null;
    const out = Buffer.alloc(frameBytes, 0);
    let offset = 0;
    for (const chunk of this.chunks) {
      const len = Math.min(chunk.length, frameBytes - offset);
      chunk.copy(out, offset, 0, len);
      offset += len;
      if (offset >= frameBytes) break;
    }
    this.clear();
    return out;
  }

  /** Forget everything (stop, skip, seek, error, end of track). */
  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.holding = false;
  }

  /** Drop the oldest audio, in whole samples so the channels stay in step. */
  private dropOldest(excess: number): void {
    let remaining = excess - (excess % FRAME_ALIGN);
    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.length <= remaining) {
        remaining -= head.length;
        this.bytes -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(remaining);
        this.bytes -= remaining;
        remaining = 0;
      }
    }
  }
}
