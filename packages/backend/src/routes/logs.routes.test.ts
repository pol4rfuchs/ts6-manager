import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { logRoutes } from './logs.routes.js';
import { TSApiError } from '../middleware/error-handler.js';

async function get(execute: any, query = '') {
  const app = express();
  app.locals.connectionPool = { getClient: () => ({ execute }) };
  app.use((req: any, _res, next) => { req.user = { role: 'admin' }; next(); });
  app.use('/api/servers/:configId/vs/:sid/logs', logRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err instanceof TSApiError ? 502 : 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/api/servers/1/vs/1/logs${query}`);
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

describe('server logs route', () => {
  it('returns the log of the virtual server when TeamSpeak has one', async () => {
    const execute = vi.fn().mockResolvedValue([{ l: 'x' }]);
    const r = await get(execute, '?lines=100&reverse=1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ l: 'x' }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('shows the instance log with an explanation when the virtual server has no log file yet (error 2052)', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new TSApiError(2052, 'file input/output error'))
      .mockResolvedValueOnce([{ l: 'instance line' }]);
    const r = await get(execute);
    expect(r.status).toBe(200);
    expect(execute.mock.calls[1][2].instance).toBe(1);
    expect(r.body[0].l).toMatch(/has not written a log for virtual server 1/);
    expect(r.body[1]).toEqual({ l: 'instance line' });
  });

  it('keeps other TeamSpeak errors as they are', async () => {
    const execute = vi.fn().mockRejectedValue(new TSApiError(2568, 'insufficient client permissions'));
    const r = await get(execute);
    expect(r.status).toBe(502);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the instance log itself was asked for', async () => {
    const execute = vi.fn().mockRejectedValue(new TSApiError(2052, 'file input/output error'));
    const r = await get(execute, '?instance=1');
    expect(r.status).toBe(502);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
