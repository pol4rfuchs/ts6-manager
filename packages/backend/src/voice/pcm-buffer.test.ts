import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { PcmBuffer, resolveWaterMarks, BYTES_PER_SECOND } from './pcm-buffer.js';
import { BYTES_PER_FRAME } from './audio/pipeline.js';

const marks = { highBytes: 1000, lowBytes: 400, liveMaxBytes: 1200 };

function make(mode: 'hold' | 'drop' = 'hold', m = marks) {
  const calls: string[] = [];
  const buf = new PcmBuffer(m, mode, { hold: () => calls.push('hold'), release: () => calls.push('release') });
  return { buf, calls };
}
const chunk = (n: number, fill = 1) => Buffer.alloc(n, fill);

describe('water marks', () => {
  it('defaults to 20 s high and 10 s low', () => {
    const m = resolveWaterMarks({});
    expect(m.highBytes).toBe(20 * BYTES_PER_SECOND);
    expect(m.lowBytes).toBe(10 * BYTES_PER_SECOND);
  });
  it('accepts overrides and ignores invalid values', () => {
    expect(resolveWaterMarks({ PCM_BUFFER_HIGH_SECONDS: '8', PCM_BUFFER_LOW_SECONDS: '3' })).toMatchObject({ highBytes: 8 * BYTES_PER_SECOND, lowBytes: 3 * BYTES_PER_SECOND });
    expect(resolveWaterMarks({ PCM_BUFFER_HIGH_SECONDS: 'abc' }).highBytes).toBe(20 * BYTES_PER_SECOND);
    expect(resolveWaterMarks({ PCM_BUFFER_HIGH_SECONDS: '100000' }).highBytes).toBe(20 * BYTES_PER_SECOND);
    expect(resolveWaterMarks({ PCM_BUFFER_HIGH_SECONDS: '10', PCM_BUFFER_LOW_SECONDS: '50' }).lowBytes).toBe(5 * BYTES_PER_SECOND);
  });
});

describe('PcmBuffer (hold mode)', () => {
  it('holds the decoder at the high mark and releases it at the low mark', () => {
    const { buf, calls } = make();
    buf.push(chunk(600));
    expect(calls).toEqual([]);
    buf.push(chunk(500)); // 1100 >= 1000
    expect(calls).toEqual(['hold']);
    expect(buf.held).toBe(true);
    buf.take(500); // 600 left, still above low
    expect(calls).toEqual(['hold']);
    buf.take(250); // 350 <= 400
    expect(calls).toEqual(['hold', 'release']);
    expect(buf.held).toBe(false);
  });
  it('holds again after a release and does not release twice', () => {
    const { buf, calls } = make();
    buf.push(chunk(1000)); buf.take(700); buf.push(chunk(800)); buf.take(1000);
    expect(calls).toEqual(['hold', 'release', 'hold', 'release']);
  });
  it('repeats hold on every push above the mark, so a stray resume cannot let it grow', () => {
    const { buf, calls } = make();
    buf.push(chunk(1000)); buf.push(chunk(100));
    expect(calls).toEqual(['hold', 'hold']);
  });
  it('wantsData is false only while held above the low mark', () => {
    const { buf } = make();
    expect(buf.wantsData).toBe(true);
    buf.push(chunk(1000));
    expect(buf.wantsData).toBe(false);
    buf.take(700);
    expect(buf.wantsData).toBe(true);
  });
  it('takes exact byte counts across chunk boundaries and keeps the order', () => {
    const { buf } = make();
    buf.push(Buffer.from([1, 2, 3])); buf.push(Buffer.from([4, 5])); buf.push(Buffer.from([6, 7, 8, 9]));
    expect([...buf.take(4)!]).toEqual([1, 2, 3, 4]);
    expect(buf.take(6)).toBeNull();
    expect([...buf.take(5)!]).toEqual([5, 6, 7, 8, 9]);
    expect(buf.size).toBe(0);
  });
  it('clear() resets everything including the hold state (stop, skip, seek, error)', () => {
    const { buf } = make();
    buf.push(chunk(1200));
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.held).toBe(false);
    expect(buf.take(1)).toBeNull();
  });
  it('flushes the last partial frame zero-padded and empties the buffer', () => {
    const { buf } = make();
    buf.push(Buffer.from([9, 9, 9]));
    const out = buf.takeRemainderPadded(8)!;
    expect([...out]).toEqual([9, 9, 9, 0, 0, 0, 0, 0]);
    expect(buf.size).toBe(0);
    expect(buf.takeRemainderPadded(8)).toBeNull();
  });
});

describe('PcmBuffer (drop mode, live radio)', () => {
  it('never grows beyond the live maximum and drops the oldest audio', () => {
    const { buf, calls } = make('drop');
    for (let i = 0; i < 50; i++) buf.push(chunk(100, i));
    expect(buf.size).toBeLessThanOrEqual(1200);
    expect(calls).toEqual([]); // never pauses a live stream
    const first = buf.take(4)!;
    expect(first[0]).toBeGreaterThan(30); // the oldest chunks are gone
  });
  it('drops in whole samples so the channels stay aligned', () => {
    const { buf } = make('drop', { highBytes: 10, lowBytes: 5, liveMaxBytes: 1001 });
    buf.push(chunk(2003));
    expect((2003 - buf.size) % 4).toBe(0);
  });
});

describe('backpressure with a real stream (no deadlock, bounded memory)', () => {
  it('a fast producer cannot fill the buffer beyond the high mark plus one chunk', async () => {
    const m = { highBytes: BYTES_PER_FRAME * 50, lowBytes: BYTES_PER_FRAME * 20, liveMaxBytes: 0 };
    const src = new PassThrough({ highWaterMark: 4096 });
    const buf = new PcmBuffer(m, 'hold', { hold: () => src.pause(), release: () => src.resume() });
    src.on('data', (c: Buffer) => buf.push(c));

    const CHUNK = 4096; const TOTAL = CHUNK * 2000; // ~8 MB, far above the high mark
    let produced = 0; let maxSeen = 0;
    const producer = (async () => {
      while (produced < TOTAL) {
        if (!src.write(Buffer.alloc(CHUNK, 7))) await new Promise((r) => src.once('drain', r));
        produced += CHUNK;
        maxSeen = Math.max(maxSeen, buf.size);
        await new Promise((r) => setImmediate(r));
      }
      src.end();
    })();

    // The player takes one frame at a time, like the 20 ms tick, only faster here
    let played = 0; let ended = false; src.on('end', () => (ended = true));
    const deadline = Date.now() + 15000;
    while (!(ended && buf.size < BYTES_PER_FRAME) && Date.now() < deadline) {
      if (buf.take(BYTES_PER_FRAME)) played += BYTES_PER_FRAME;
      await new Promise((r) => setImmediate(r));
    }
    await producer;
    expect(ended).toBe(true);
    expect(played).toBeGreaterThan(TOTAL * 0.99);
    expect(maxSeen).toBeLessThanOrEqual(m.highBytes + CHUNK * 4);
  });

  it('a paused player keeps the decoder held, and playing on releases it', async () => {
    const m = { highBytes: 2000, lowBytes: 800, liveMaxBytes: 0 };
    const src = new PassThrough();
    const buf = new PcmBuffer(m, 'hold', { hold: () => src.pause(), release: () => src.resume() });
    src.on('data', (c: Buffer) => buf.push(c));
    for (let i = 0; i < 20; i++) src.write(Buffer.alloc(500));
    await new Promise((r) => setTimeout(r, 30));
    const frozen = buf.size;
    expect(frozen).toBeLessThanOrEqual(2000 + 500);
    await new Promise((r) => setTimeout(r, 30));
    expect(buf.size).toBe(frozen); // no growth while nobody takes audio
    while (buf.take(100)) { /* drain like the player */ }
    await new Promise((r) => setTimeout(r, 30));
    expect(buf.size).toBeGreaterThan(0); // the released decoder delivered more
  });
});
