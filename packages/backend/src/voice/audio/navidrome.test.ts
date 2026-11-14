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
