import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createNavidromeInputResolver } from './navidrome-input.js';

const base = { url: 'http://nd.example:4533', username: 'alice', password: 'topsecret' };

describe('local folder first, HTTP second', () => {
  let root: string; let music: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-input-'));
    music = path.join(root, 'music');
    fs.mkdirSync(path.join(music, 'Band'), { recursive: true });
    fs.writeFileSync(path.join(music, 'Band', '01.flac'), 'audio');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (cfg: any, reported: string | null, logs: string[] = [], learn?: any) =>
    createNavidromeInputResolver({
      loadConfig: async () => cfg,
      findReportedPath: async () => reported,
      learnReportedPath: learn,
      log: (m) => logs.push(m),
    });

  it('mode off (no folder): streams over HTTP as before', async () => {
    const r = await make({ ...base, musicFolder: null }, 'Band/01.flac')('T1');
    expect(r!.remote).toBe(true);
    expect(r!.input).toContain('/rest/download');
    expect(r!.input).toContain('id=T1');
  });
  it('folder set and file readable: reads the local file, no URL, no credentials', async () => {
    const r = await make({ ...base, musicFolder: music }, 'Band/01.flac')('T1');
    expect(r).toEqual({ input: fs.realpathSync(path.join(music, 'Band', '01.flac')), remote: false });
  });
  it('folder set but file missing: falls back to HTTP and logs without any path', async () => {
    const logs: string[] = [];
    const r = await make({ ...base, musicFolder: music }, 'Band/gone.flac', logs)('T1');
    expect(r!.remote).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('T1');
    expect(logs[0]).not.toContain('gone.flac');
    expect(logs[0]).not.toContain(music);
    expect(logs[0]).not.toContain('topsecret');
  });
  it('a path that tries to leave the folder falls back to HTTP', async () => {
    const r = await make({ ...base, musicFolder: music }, '../../../etc/passwd')('T1');
    expect(r!.remote).toBe(true);
  });
  it('no known path: asks Navidrome once and uses the answer', async () => {
    let asked = 0;
    const r = await make({ ...base, musicFolder: music }, null, [], async () => { asked++; return 'Band/01.flac'; })('T1');
    expect(asked).toBe(1);
    expect(r!.remote).toBe(false);
  });
  it('no known path and Navidrome cannot answer: HTTP', async () => {
    const r = await make({ ...base, musicFolder: music }, null, [], async () => null)('T1');
    expect(r!.remote).toBe(true);
  });
  it('Navidrome not configured: null (the caller reports a readable error)', async () => {
    expect(await make(null, 'Band/01.flac')('T1')).toBeNull();
  });
  it('never asks for the path when the mode is off', async () => {
    let asked = 0;
    await make({ ...base, musicFolder: null }, null, [], async () => { asked++; return null; })('T1');
    expect(asked).toBe(0);
  });
});
