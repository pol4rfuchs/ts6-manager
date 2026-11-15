import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VoiceBot } from './voice-bot.js';
import { PlaybackStartError, MSG_TRACK_UNREADABLE, MSG_NAVIDROME_NO_AUDIO } from './playback-error.js';
import { setNavidromeInputResolver } from './stream-source.js';

type FakeFfmpeg = { stdout: PassThrough; process: EventEmitter; kill: () => void };

/** A fake decode process the test steers: it can deliver audio and then end with an exit code. */
function fakeFfmpeg(): FakeFfmpeg {
  return { stdout: new PassThrough(), process: new EventEmitter(), kill: vi.fn() };
}

function makeBot(ffmpeg: FakeFfmpeg) {
  const bot: any = new VoiceBot({
    id: 1, serverConfigId: 1, name: 'test', serverHost: 'ts.example', serverPort: 9987, nickname: 'bot', volume: 50,
  } as any);
  bot._status = 'connected';
  bot.pipeline = { toPcmFileStream: vi.fn(() => ffmpeg) };
  // no TeamSpeak connection in the test: sending audio is a no-op
  bot.client = Object.assign(new EventEmitter(), { sendVoiceStop: vi.fn(), sendVoice: vi.fn(), isConnected: true });
  bot.encodeAndSend = vi.fn(() => true);
  const statuses: string[] = [];
  bot.on('statusChange', (s: string) => statuses.push(s));
  const errors: Error[] = [];
  bot.on('error', (e: Error) => errors.push(e));
  return { bot, statuses, errors };
}

const item = (filePath: string) => ({ id: '7', title: 'T', filePath, source: 'local' as const });

afterEach(() => { setNavidromeInputResolver(null); vi.useRealTimers(); });

describe('starting a track', () => {
  it('ffmpeg ends with an error before any audio (local file): readable error, status back to connected', async () => {
    const ff = fakeFfmpeg();
    const { bot, statuses } = makeBot(ff);
    const playing = bot.play(item('/media/music/secret-dir/gone.flac'));
    setImmediate(() => ff.process.emit('close', 1));
    const err = await playing.catch((e: Error) => e);
    expect(err).toBeInstanceOf(PlaybackStartError);
    expect(err.message).toBe(MSG_TRACK_UNREADABLE);
    expect(err.message).not.toMatch(/secret-dir|gone\.flac|\/media/);
    expect(bot.status).toBe('connected');
    expect(bot.nowPlaying).toBeNull();
    expect(statuses).toEqual(['playing', 'connected']);
  });

  it('ffmpeg ends with an error before any audio (Navidrome stream): readable error without URL or login', async () => {
    setNavidromeInputResolver(async () => ({ input: 'http://nd.example/rest/download?id=T1&u=alice&t=tok&s=salt', remote: true }));
    const ff = fakeFfmpeg();
    const { bot } = makeBot(ff);
    const playing = bot.play(item('navidrome:T1'));
    setImmediate(() => ff.process.emit('close', 183));
    const err = await playing.catch((e: Error) => e);
    expect(err).toBeInstanceOf(PlaybackStartError);
    expect(err.message).toBe(MSG_NAVIDROME_NO_AUDIO);
    expect(err.message).not.toMatch(/nd\.example|alice|tok|salt|T1|rest\/download/);
    expect(bot.status).toBe('connected');
  });

  it('ffmpeg cannot even be started (spawn error): same readable error, no crash', async () => {
    const ff = fakeFfmpeg();
    const { bot, errors } = makeBot(ff);
    const playing = bot.play(item('/media/music/a.flac'));
    setImmediate(() => ff.process.emit('error', new Error('spawn ffmpeg ENOENT')));
    const err = await playing.catch((e: Error) => e);
    expect(err).toBeInstanceOf(PlaybackStartError);
    expect(err.message).not.toMatch(/ENOENT/);
    expect(bot.status).toBe('connected');
    expect(errors).toEqual([]); // reported to the caller, not as a second event
  });

  it('a failed start leaves nothing behind: the next track can start normally', async () => {
    const bad = fakeFfmpeg();
    const { bot } = makeBot(bad);
    const first = bot.play(item('/a.flac'));
    setImmediate(() => bad.process.emit('close', 1));
    await first.catch(() => undefined);
    const good = fakeFfmpeg();
    bot.pipeline.toPcmFileStream = vi.fn(() => good);
    const second = bot.play(item('/b.flac'));
    setImmediate(() => good.stdout.write(Buffer.alloc(3840)));
    await second;
    expect(bot.status).toBe('playing');
    bot.stopPlayback();
  });

  it('normal case, local file: the call returns with the first audio and the bot plays', async () => {
    const ff = fakeFfmpeg();
    const { bot, statuses } = makeBot(ff);
    const playing = bot.play(item('/media/music/a.flac'));
    setImmediate(() => ff.stdout.write(Buffer.alloc(3840)));
    await playing;
    expect(bot.status).toBe('playing');
    expect(statuses).toEqual(['playing']);
    expect(bot.pipeline.toPcmFileStream).toHaveBeenCalledWith('/media/music/a.flac', 0, { remote: false });
    bot.stopPlayback();
  });

  it('normal case, HTTP stream: ffmpeg gets the stream URL as a remote input', async () => {
    setNavidromeInputResolver(async () => ({ input: 'http://nd.example/rest/download?id=T1', remote: true }));
    const ff = fakeFfmpeg();
    const { bot } = makeBot(ff);
    const playing = bot.play(item('navidrome:T1'));
    setImmediate(() => ff.stdout.write(Buffer.alloc(3840)));
    await playing;
    expect(bot.status).toBe('playing');
    expect(bot.pipeline.toPcmFileStream).toHaveBeenCalledWith('http://nd.example/rest/download?id=T1', 0, { remote: true });
    bot.stopPlayback();
  });

  it('a track that ends cleanly without audio is not an error', async () => {
    const ff = fakeFfmpeg();
    const { bot } = makeBot(ff);
    const playing = bot.play(item('/media/music/empty.flac'));
    setImmediate(() => ff.process.emit('close', 0));
    await expect(playing).resolves.toBeUndefined();
    bot.stopPlayback();
  });

  it('a decode that fails AFTER audio came is not a start error (the track just ends), and logs one line without the path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ff = fakeFfmpeg();
    const { bot } = makeBot(ff);
    const playing = bot.play(item('/media/music/long.flac'));
    setImmediate(() => ff.stdout.write(Buffer.alloc(3840)));
    await playing;
    ff.process.emit('close', 1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('track 7');
    expect(String(spy.mock.calls[0][0])).not.toMatch(/\/media|long\.flac/);
    spy.mockRestore();
    bot.stopPlayback();
  });

  it('a start that shows no news within the wait time is reported as started', async () => {
    vi.useFakeTimers();
    const ff = fakeFfmpeg();
    const { bot } = makeBot(ff);
    const playing = bot.play(item('/media/music/slow.flac'));
    await vi.advanceTimersByTimeAsync(3100);
    await expect(playing).resolves.toBeUndefined();
    bot.stopPlayback();
  });
});
