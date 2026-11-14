import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { setNavidromeUrlResolver, resolvePlaybackInput } from './stream-source.js';
import { buildStreamUrl, isNavidromePath, navidromePath, navidromeTrackId } from './audio/navidrome.js';
import { buildFileDecodeArgs } from './audio/pipeline.js';

describe('navidrome song paths', () => {
  it('round-trips a track id', () => {
    expect(navidromePath('abc')).toBe('navidrome:abc');
    expect(isNavidromePath('navidrome:abc')).toBe(true);
    expect(navidromeTrackId('navidrome:abc')).toBe('abc');
  });
  it('does not treat local files or other sources as Navidrome', () => {
    expect(isNavidromePath('/data/music/a.mp3')).toBe(false);
    expect(isNavidromePath('')).toBe(false);
    expect(isNavidromePath('https://example.org/navidrome:x')).toBe(false);
  });
});

describe('stream url', () => {
  const cfg = { url: 'http://nd.example:4533/', username: 'alice', password: 'topsecret' };
  it('points to the download endpoint with the track id and a token, never the password', () => {
    const url = new URL(buildStreamUrl(cfg, 'T1'));
    expect(url.origin + url.pathname).toBe('http://nd.example:4533/rest/download');
    expect(url.searchParams.get('id')).toBe('T1');
    expect(url.searchParams.get('u')).toBe('alice');
    const salt = url.searchParams.get('s')!;
    expect(url.searchParams.get('t')).toBe(createHash('md5').update('topsecret' + salt).digest('hex'));
    expect(url.toString()).not.toContain('topsecret');
  });
});

describe('playback input', () => {
  afterEach(() => setNavidromeUrlResolver(null));
  it('leaves a local file untouched', async () => {
    expect(await resolvePlaybackInput('/data/music/a.mp3')).toEqual({ input: '/data/music/a.mp3', remote: false });
  });
  it('turns a navidrome path into a remote url', async () => {
    setNavidromeUrlResolver(async (id) => `http://nd.example/rest/download?id=${id}`);
    expect(await resolvePlaybackInput('navidrome:T9')).toEqual({ input: 'http://nd.example/rest/download?id=T9', remote: true });
  });
  it('fails with a clear message when Navidrome is not configured', async () => {
    await expect(resolvePlaybackInput('navidrome:T9')).rejects.toThrow('Navidrome is not configured');
    setNavidromeUrlResolver(async () => null);
    await expect(resolvePlaybackInput('navidrome:T9')).rejects.toThrow('Navidrome is not configured');
  });
});

describe('ffmpeg arguments', () => {
  it('a local file gets no network options', () => {
    const a = buildFileDecodeArgs('/data/music/a.mp3', 0);
    expect(a).not.toContain('-protocol_whitelist');
    expect(a).not.toContain('-ss');
    expect(a[a.indexOf('-i') + 1]).toBe('/data/music/a.mp3');
  });
  it('a remote url is limited to http(s), reconnects and seeks before the input', () => {
    const a = buildFileDecodeArgs('http://nd.example/x', 12, { remote: true });
    expect(a[a.indexOf('-protocol_whitelist') + 1]).toBe('http,https,tcp,tls,crypto');
    expect(a).toContain('-reconnect');
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a[a.indexOf('-ss') + 1]).toBe('12');
  });
});
