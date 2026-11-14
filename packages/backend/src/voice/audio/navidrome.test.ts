import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { buildAuthParams, normalizeBaseUrl } from './navidrome.js';

describe('navidrome client helpers', () => {
  it('builds Subsonic token auth (md5(password + salt)), never sends the password', () => {
    const p = buildAuthParams('alice', 'secret', 'abc123');
    expect(p.get('u')).toBe('alice');
    expect(p.get('s')).toBe('abc123');
    expect(p.get('t')).toBe(createHash('md5').update('secretabc123').digest('hex'));
    expect(p.get('p')).toBeNull();
    expect(p.get('f')).toBe('json');
  });

  it('normalizes the base URL and rejects other schemes', () => {
    expect(normalizeBaseUrl(' http://navidrome:4533/ ')).toBe('http://navidrome:4533');
    expect(normalizeBaseUrl('https://music.example.org/nd/?x=1#y')).toBe('https://music.example.org/nd');
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeBaseUrl('nonsense')).toThrow();
  });
});

import { vi, afterEach } from 'vitest';
import { validateSearchQuery, searchTracks, MAX_SEARCH_QUERY_LENGTH, MAX_SEARCH_RESULTS } from './navidrome.js';

describe('navidrome search input', () => {
  const cfg = { url: 'http://navidrome:4533', username: 'u', password: 'p' };
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an empty search term', () => {
    expect(() => validateSearchQuery('')).toThrow('Enter a search term');
  });
  it('rejects a term made only of whitespace', () => {
    expect(() => validateSearchQuery('   \t \n')).toThrow('Enter a search term');
  });
  it('rejects non-text input', () => {
    expect(() => validateSearchQuery(undefined)).toThrow();
    expect(() => validateSearchQuery({ a: 1 })).toThrow();
  });
  it('trims a normal term', () => {
    expect(validateSearchQuery('  tone  ')).toBe('tone');
  });
  it('rejects an overlong term but accepts the limit', () => {
    expect(validateSearchQuery('a'.repeat(MAX_SEARCH_QUERY_LENGTH))).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(() => validateSearchQuery('a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toThrow('too long');
  });
  it('never calls Navidrome for an empty term', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(searchTracks(cfg, '  ')).rejects.toThrow('Enter a search term');
    expect(f).not.toHaveBeenCalled();
  });
  it('sends a trimmed term and caps the result count', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', searchResult3: { song: [{ id: '1', title: 'T' }] } } })));
    vi.stubGlobal('fetch', f);
    const r = await searchTracks(cfg, ' tone ', 9999);
    expect(r).toHaveLength(1);
    const url = new URL((f.mock.calls[0] as any)[0]);
    expect(url.searchParams.get('query')).toBe('tone');
    expect(url.searchParams.get('songCount')).toBe(String(MAX_SEARCH_RESULTS));
    expect(url.searchParams.get('artistCount')).toBe('0');
    expect(url.searchParams.get('albumCount')).toBe('0');
  });
});

import http from 'node:http';
import { describeNetworkError, MSG_UNREACHABLE, MSG_TIMEOUT, getTrack } from './navidrome.js';

describe('navidrome network errors', () => {
  const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  afterEach(() => vi.unstubAllGlobals());

  it('maps refused, unknown host and other connection errors to "not reachable"', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN']) {
      expect(describeNetworkError(fetchFailed(code))).toBe(MSG_UNREACHABLE);
    }
    expect(describeNetworkError(new TypeError('fetch failed'))).toBe(MSG_UNREACHABLE);
  });
  it('maps timeouts and aborts to "did not answer in time"', () => {
    expect(describeNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(MSG_TIMEOUT);
    expect(describeNetworkError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(MSG_TIMEOUT);
    expect(describeNetworkError(fetchFailed('ETIMEDOUT'))).toBe(MSG_TIMEOUT);
    expect(describeNetworkError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe(MSG_TIMEOUT);
  });
  it('does not leak host, url or credentials into the message', () => {
    const msg = describeNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', address: '10.1.2.3', port: 4533 } }));
    expect(msg).not.toMatch(/10\.1\.2\.3|4533|secret/);
  });
  it('searchTracks reports the readable message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw fetchFailed('ECONNREFUSED'); }));
    await expect(searchTracks({ url: 'http://nd.example:4533', username: 'u', password: 'secret' }, 'tone')).rejects.toThrow(MSG_UNREACHABLE);
  });
  it('keeps the existing HTTP error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(getTrack({ url: 'http://nd.example:4533', username: 'u', password: 'p' }, '1')).rejects.toThrow('Navidrome answered HTTP 404');
  });
  it('real network: closed port is "not reachable", silent server is a timeout', async () => {
    await expect(getTrack({ url: 'http://127.0.0.1:1', username: 'u', password: 'p' }, '1')).rejects.toThrow(MSG_UNREACHABLE);
    await expect(getTrack({ url: 'http://nonexistent.invalid', username: 'u', password: 'p' }, '1')).rejects.toThrow(MSG_UNREACHABLE);
    const silent = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as any).port;
    try {
      await expect(getTrack({ url: `http://127.0.0.1:${port}`, username: 'u', password: 'p', requestTimeoutMs: 300 }, '1')).rejects.toThrow(MSG_TIMEOUT);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });
});

describe('navidrome non-Subsonic answers', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a 200 answer that is not JSON (for example an HTML page) says to check the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(getTrack({ url: 'http://nd.example:4533', username: 'u', password: 'p' }, '1')).rejects.toThrow('Not a Subsonic response (check the URL)');
  });
  it('JSON without a subsonic-response is the same error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"hello":1}', { status: 200 })));
    await expect(getTrack({ url: 'http://nd.example:4533', username: 'u', password: 'p' }, '1')).rejects.toThrow('Not a Subsonic response (check the URL)');
  });
});
