import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import { createRequire } from "module";
import OpusScript from "opusscript";
import { validateUrl } from "../../utils/url-validator.js";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960; // 20ms at 48kHz
export const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 16-bit = 2 bytes per sample
export const FRAME_MS = 20;
const BITRATE = 96000;

// Both encoders wrap libopus, so the CTL constants are shared
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_VBR = 4006;
const OPUS_SET_VBR_CONSTRAINT = 4020;
const OPUS_SET_SIGNAL = 4024;
const OPUS_SIGNAL_MUSIC = 3002;

// Encoder complexity (10 = best quality / most CPU … 0 = cheapest). This is the
// dominant CPU lever for real-time encoding: on a small or contended VM, a high
// complexity makes the 20ms pacing loop fall behind, producing choppy/distorted
// audio. Default 5 roughly halves the CPU vs 10 with no audible loss on music.
// Drop it further (e.g. OPUS_COMPLEXITY=2) if the host is still struggling.
const OPUS_COMPLEXITY = ((): number => {
  const n = parseInt(process.env.OPUS_COMPLEXITY ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 5;
})();

// ffmpeg thread count, left on auto. Audio decoding to PCM is effectively
// single-threaded (audio codecs barely parallelize) and already runs in its own
// child process on its own core, so this has little effect — the real real-time
// bottleneck is the single Node event loop encoding+sending each 20ms frame, not
// ffmpeg. Override with FFMPEG_THREADS only if you have a reason to.
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || '0';

// Native libopus bindings encode ~5-10x faster than the opusscript WASM
// build — that matters at one frame every 20ms on a small VM. Optional:
// platforms without a prebuild fall back to WASM below.
const require = createRequire(import.meta.url);
let NativeOpusEncoder: any = null;
try {
  NativeOpusEncoder = require("@discordjs/opus").OpusEncoder;
} catch {
  NativeOpusEncoder = null;
}

/**
 * ffmpeg arguments that decode a local file or a remote URL to raw PCM.
 * A remote input (for example a track streamed from Navidrome) may only use
 * HTTP(S) and reconnects after a dropped connection; seeking uses range
 * requests, so the server has to support them.
 */
export function buildFileDecodeArgs(input: string, startSeconds: number = 0, opts: { remote?: boolean } = {}): string[] {
  return [
    "-nostdin",
    "-threads", FFMPEG_THREADS,
    ...(opts.remote
      ? [
          "-protocol_whitelist", "http,https,tcp,tls,crypto",
          "-reconnect", "1",
          "-reconnect_streamed", "1",
          "-reconnect_delay_max", "5",
        ]
      : []),
    // -ss before -i: ffmpeg seeks in the container without decoding what precedes
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", input,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-loglevel", "error",
    "pipe:1",
  ];
}

export class AudioPipeline {
  private encodeFn: (pcm: Buffer) => Buffer;
  private opusPeak = 0;
  private lastOpusPeakLog = 0;

  constructor() {
    this.encodeFn = this.createEncoder();
  }

  private createEncoder(): (pcm: Buffer) => Buffer {
    if (NativeOpusEncoder) {
      try {
        const encoder = new NativeOpusEncoder(SAMPLE_RATE, CHANNELS);
        encoder.setBitrate(BITRATE);
        // Hard CBR (reduces spikes); constraint harmless under CBR
        encoder.applyEncoderCTL(OPUS_SET_VBR, 0);
        encoder.applyEncoderCTL(OPUS_SET_VBR_CONSTRAINT, 1);
        // Tell encoder it's music (helps tuning)
        encoder.applyEncoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
        // Lower complexity to keep real-time pacing on small/contended VMs
        encoder.applyEncoderCTL(OPUS_SET_COMPLEXITY, OPUS_COMPLEXITY);
        console.log(`[audio] Using native opus encoder (@discordjs/opus), complexity=${OPUS_COMPLEXITY}`);
        return (pcm) => encoder.encode(pcm);
      } catch (err: any) {
        console.warn(`[audio] Native opus encoder failed to initialize (${err.message}), falling back to WASM`);
      }
    } else {
      console.warn("[audio] @discordjs/opus unavailable, using opusscript (WASM) — higher CPU usage");
    }

    const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    encoder.setBitrate(BITRATE);
    encoder.encoderCTL(OPUS_SET_VBR, 0);
    encoder.encoderCTL(OPUS_SET_VBR_CONSTRAINT, 1);
    encoder.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
    encoder.encoderCTL(OPUS_SET_COMPLEXITY, OPUS_COMPLEXITY);
    console.log(`[audio] Using opusscript (WASM) encoder — higher CPU; complexity=${OPUS_COMPLEXITY}`);
    return (pcm) => {
      const encoded = encoder.encode(pcm, FRAME_SIZE);
      return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
    };
  }

  /**
   * Encode a single PCM frame to Opus, applying volume scaling in real-time.
   */
  encodeFrame(pcmFrame: Buffer, volume: number): Buffer {
    let input = pcmFrame;
    if (volume !== 100) {
      const scaled = Buffer.alloc(pcmFrame.length);
      const factor = volume / 100;
      for (let i = 0; i < pcmFrame.length; i += 2) {
        const sample = pcmFrame.readInt16LE(i);
        const v = Math.round(sample * factor);
        scaled.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
      }
      input = scaled;
    }
    const opusFrame = this.encodeFn(input);

    this.opusPeak = Math.max(this.opusPeak, opusFrame.length);

    //const now = Date.now();
    //if (now - this.lastOpusPeakLog > 1000) {
    //  console.log(`[voice] opus peak (1s): ${this.opusPeak} bytes`);
    //  this.opusPeak = 0;
    //  this.lastOpusPeakLog = now;
    //}

    return opusFrame;
  }

  /**
   * Stream a local audio file to raw PCM, starting at an optional offset.
   * Returns a readable stdout stream + kill function. Constant memory:
   * the file is decoded as it is consumed (pipe backpressure).
   */
  toPcmFileStream(input: string, startSeconds: number = 0, opts: { remote?: boolean } = {}): { stdout: Readable; process: ChildProcess; kill: () => void } {
    const args = buildFileDecodeArgs(input, startSeconds, opts);

    const ffmpeg = spawn("ffmpeg", args, { shell: false });
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill("SIGKILL"); } catch { }
      },
    };
  }

  /**
   * Stream audio from a URL to raw PCM (for live radio streams).
   * Returns a readable stdout stream + kill function. Does NOT buffer the entire stream.
   */
  async toPcmStream(url: string): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void }> {
    // C4: Validate URL before passing to ffmpeg
    const urlCheck = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
    if (!urlCheck.valid) {
      throw new Error(`Stream URL blocked: ${urlCheck.error}`);
    }

    const args = [
      "-nostdin",
      "-threads", FFMPEG_THREADS,
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", url,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-loglevel", "error",
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", args, { shell: false });
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill("SIGKILL"); } catch { }
      },
    };
  }

}
