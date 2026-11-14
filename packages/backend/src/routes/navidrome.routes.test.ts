import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { navidromeRoutes } from './navidrome.routes.js';
import { AppError } from '../middleware/error-handler.js';
import { encrypt } from '../utils/crypto.js';

// the connection test stubs the global fetch (Navidrome); the test's own requests must not use the stub
const realFetch = globalThis.fetch;

function makeApp(initial: any = {}) {
  const row: any = { id: 1, enabled: true, url: 'http://nd.example:4533', username: 'alice', password: encrypt('pw'), musicFolder: null, ...initial };
  const app = express();
  app.use(express.json());
  app.locals.prisma = {
    navidromeSettings: {
      findFirst: async () => row,
      create: async () => row,
      update: async ({ data }: any) => Object.assign(row, data),
    },
  };
  app.use((req: any, _res, next) => { req.user = { role: 'admin' }; next(); });
  app.use('/api/navidrome', navidromeRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err instanceof AppError ? err.statusCode : 500).json({ error: err.message }));
  return { app, row };
}

async function call(app: express.Express, method: string, p: string, body?: unknown) {
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const r = await realFetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('navidrome settings: music folder', () => {
  it('saves a valid folder normalized and returns it, never the password', async () => {
    const { app, row } = makeApp();
    expect((await call(app, 'PUT', '/api/navidrome/settings', { musicFolder: ' /media/music/ ' })).status).toBe(200);
    expect(row.musicFolder).toBe('/media/music');
    const got = await call(app, 'GET', '/api/navidrome/settings');
    expect(got.body.musicFolder).toBe('/media/music');
    expect(got.body.hasPassword).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain('pw');
  });
  it('an empty value switches the mode off', async () => {
    const { app, row } = makeApp({ musicFolder: '/media/music' });
    await call(app, 'PUT', '/api/navidrome/settings', { musicFolder: '' });
    expect(row.musicFolder).toBeNull();
  });
  it('leaves the folder alone when the field is not sent', async () => {
    const { app, row } = makeApp({ musicFolder: '/media/music' });
    await call(app, 'PUT', '/api/navidrome/settings', { enabled: true });
    expect(row.musicFolder).toBe('/media/music');
  });
  it('refuses relative paths, "..", and overlong values with 400 and a readable message', async () => {
    const { app, row } = makeApp();
    for (const musicFolder of ['media/music', '/media/../etc', '/' + 'a'.repeat(600), 42]) {
      const r = await call(app, 'PUT', '/api/navidrome/settings', { musicFolder });
      expect(r.status, String(musicFolder)).toBe(400);
      expect(r.body.error).toMatch(/Music folder/);
    }
    expect(row.musicFolder).toBeNull();
  });
});

describe('navidrome connection test reports the folder', () => {
  afterEach(() => vi.unstubAllGlobals());
  const okPing = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', serverVersion: '0.64.2' } }))));

  it('folderReadable is null when no folder is set', async () => {
    okPing();
    const { app } = makeApp();
    expect((await call(app, 'POST', '/api/navidrome/test', {})).body.folderReadable).toBeNull();
  });
  it('folderReadable is true for a readable folder and false for a missing one, without file names', async () => {
    okPing();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-test-'));
    fs.writeFileSync(path.join(dir, 'secret-name.flac'), 'x');
    try {
      const yes = await call(makeApp({ musicFolder: dir }).app, 'POST', '/api/navidrome/test', {});
      expect(yes.body.folderReadable).toBe(true);
      expect(JSON.stringify(yes.body)).not.toContain('secret-name');
      const no = await call(makeApp({ musicFolder: path.join(dir, 'missing') }).app, 'POST', '/api/navidrome/test', {});
      expect(no.body.folderReadable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
