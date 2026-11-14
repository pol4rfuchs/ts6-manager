import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { musicBotRoutes } from './music-bots.routes.js';
import { AppError } from '../middleware/error-handler.js';

function makeApp(findSong = vi.fn().mockResolvedValue({ id: 5, title: 't', filePath: '/x.mp3', source: 'local' })) {
  const bot = {
    status: 'connected',
    queue: { add: vi.fn(), length: 1, playAt: vi.fn() },
    play: vi.fn(),
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
