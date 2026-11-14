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
