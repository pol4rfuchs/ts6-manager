import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { musicBotRoutes } from './music-bots.routes.js';
import { AppError, errorHandler } from '../middleware/error-handler.js';
import { createNavidromeInputResolver } from '../voice/navidrome-input.js';
import { setNavidromeInputResolver } from '../voice/stream-source.js';

function makeApp(findSong = vi.fn().mockResolvedValue({ id: 5, title: 't', filePath: '/x.mp3', source: 'local' })) {
  const bot = {
    status: 'connected',
    queue: { add: vi.fn(), length: 1, playAt: vi.fn() },
    play: vi.fn(),
    seek: vi.fn(),
    currentConfig: {},
  };
  const app = express();
  app.use(express.json());
  app.locals.prisma = { song: { findUnique: findSong }, radioStation: { findUnique: vi.fn() } };
  app.locals.voiceBotManager = { getBot: () => bot };
  app.use((req: any, _res, next) => { req.user = { role: 'admin' }; next(); });
  app.use('/api/music-bots', musicBotRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err instanceof AppError ? err.statusCode : 500).json({ error: err.message }));
  return { app, findSong, bot };
}

async function post(app: express.Express, path: string, body?: unknown) {
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('music bot routes: ids in the request body', () => {
  it('queue: a missing or non-numeric songId is a 400, not a 500', async () => {
    const { app, findSong } = makeApp();
    expect((await post(app, '/api/music-bots/1/queue', {})).status).toBe(400);
    expect((await post(app, '/api/music-bots/1/queue')).status).toBe(400);
    const r = await post(app, '/api/music-bots/1/queue', { songId: 'abc' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/songId must be an integer/);
    expect(findSong).not.toHaveBeenCalled();
  });

  it('queue: a valid songId (number or numeric string) is looked up and queued', async () => {
    const { app, findSong, bot } = makeApp();
    expect((await post(app, '/api/music-bots/1/queue', { songId: 5 })).status).toBe(200);
    expect((await post(app, '/api/music-bots/1/queue', { songId: '5' })).status).toBe(200);
    expect(findSong).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(bot.queue.add).toHaveBeenCalledTimes(2);
  });

  it('a partly numeric or fractional id is a 400, not cut down to an integer', async () => {
    const { app, findSong } = makeApp();
    for (const songId of ['12abc', '1.5', 1.5, '', ' ', '-', '1e3']) {
      expect((await post(app, '/api/music-bots/1/queue', { songId })).status).toBe(400);
      expect((await post(app, '/api/music-bots/1/play', { songId })).status).toBe(400);
    }
    expect(findSong).not.toHaveBeenCalled();
  });

  it('queue: an unknown song is still a 404', async () => {
    const { app } = makeApp(vi.fn().mockResolvedValue(null));
    expect((await post(app, '/api/music-bots/1/queue', { songId: 99 })).status).toBe(404);
  });

  it('play and play-radio: a non-numeric id is a 400', async () => {
    const { app, findSong } = makeApp();
    expect((await post(app, '/api/music-bots/1/play', { songId: 'abc' })).status).toBe(400);
    expect((await post(app, '/api/music-bots/1/play-radio', { stationId: 'abc' })).status).toBe(400);
    expect(findSong).not.toHaveBeenCalled();
  });
});

describe('music bot routes: seek', () => {
  it('seeks to a number or numeric string of 0 or more', async () => {
    const { app, bot } = makeApp();
    expect((await post(app, '/api/music-bots/1/seek', { seconds: 45 })).status).toBe(200);
    expect((await post(app, '/api/music-bots/1/seek', { seconds: '12.5' })).status).toBe(200);
    expect((await post(app, '/api/music-bots/1/seek', { seconds: 0 })).status).toBe(200);
    expect(bot.seek.mock.calls.map((c: any[]) => c[0])).toEqual([45, 12.5, 0]);
  });

  it('a wrong or missing field is a 400 with a readable message and does not seek', async () => {
    const { app, bot } = makeApp();
    for (const body of [{ position: 45 }, {}, { seconds: 'abc' }, { seconds: -1 }, { seconds: null }, { seconds: '' }, { seconds: [1] }]) {
      const r = await post(app, '/api/music-bots/1/seek', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(/seconds must be a number/);
    }
    expect((await post(app, '/api/music-bots/1/seek')).status).toBe(400);
    expect(bot.seek).not.toHaveBeenCalled();
  });
});

describe('music bot routes: play a Navidrome track that cannot be started', () => {
  // the real error handler: it turns a PlaybackStartError into the 502 answer
  function makeAppWithRealErrors(song: any) {
    const { app, bot } = makeApp(vi.fn().mockResolvedValue(song));
    (app as any)._router.stack = (app as any)._router.stack.filter((l: any) => l.handle?.length !== 4);
    app.use(errorHandler);
    return { app, bot };
  }
  const song = { id: 5, title: 'T', filePath: 'navidrome:T1', source: 'navidrome', sourceUrl: 'navidrome:T1', navidromePath: null };
  afterEach(() => setNavidromeInputResolver(null));

  it('path not stored and Navidrome not reachable: 502 with the readable text, queue and bot untouched', async () => {
    setNavidromeInputResolver(createNavidromeInputResolver({
      loadConfig: async () => ({ url: 'http://nd.example:4533', username: 'alice', password: 'pw', musicFolder: '/media/music' }),
      findReportedPath: async () => null,
      learnReportedPath: async () => { throw new Error('Navidrome is not reachable. Check the URL and port.'); },
    }));
    const { app, bot } = makeAppWithRealErrors(song);
    const r = await post(app, '/api/music-bots/1/play', { songId: 5 });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('Navidrome is not reachable. Check the URL and port.');
    expect(bot.queue.add).not.toHaveBeenCalled();
    expect(bot.queue.playAt).not.toHaveBeenCalled();
    expect(bot.play).not.toHaveBeenCalled();
  });

  it('Navidrome not configured at all: 502 with a readable text, nothing is started', async () => {
    const { app, bot } = makeAppWithRealErrors(song);
    const r = await post(app, '/api/music-bots/1/play', { songId: 5 });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Navidrome is not configured/);
    expect(bot.play).not.toHaveBeenCalled();
  });

  it('a start error from the bot is answered with 502 and the same readable text', async () => {
    const { PlaybackStartError } = await import('../voice/playback-error.js');
    setNavidromeInputResolver(async () => ({ input: 'http://nd.example/x', remote: true }));
    const { app, bot } = makeAppWithRealErrors(song);
    bot.play.mockRejectedValue(new PlaybackStartError('Navidrome did not deliver the track. Check that Navidrome is running and its settings are correct.'));
    const r = await post(app, '/api/music-bots/1/play', { songId: 5 });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/^Navidrome did not deliver the track/);
    expect(JSON.stringify(r.body)).not.toMatch(/nd\.example|rest\/download/);
  });

  it('a local song plays as before (no Navidrome involved)', async () => {
    const { app, bot } = makeAppWithRealErrors({ id: 5, title: 't', filePath: '/data/music/a.mp3', source: 'local' });
    const r = await post(app, '/api/music-bots/1/play', { songId: 5 });
    expect(r.status).toBe(200);
    expect(bot.queue.add).toHaveBeenCalledTimes(1);
    expect(bot.play).toHaveBeenCalledTimes(1);
  });

  it('a streamed song plays as before when Navidrome is configured', async () => {
    setNavidromeInputResolver(async () => ({ input: 'http://nd.example/x', remote: true }));
    const { app, bot } = makeAppWithRealErrors(song);
    const r = await post(app, '/api/music-bots/1/play', { songId: 5 });
    expect(r.status).toBe(200);
    expect(bot.play).toHaveBeenCalledTimes(1);
    expect(bot.play.mock.calls[0][1]).toEqual({ input: 'http://nd.example/x', remote: true });
  });
});
