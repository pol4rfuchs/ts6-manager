import { describe, it, expect } from 'vitest';
import { navidromeIdsInLibrary, navidromeSourceUrl } from '@ts6/common';

describe('navidrome tracks already in the library', () => {
  it('builds the source url the server stores', () => {
    expect(navidromeSourceUrl('abc')).toBe('navidrome:abc');
  });
  it('lists only navidrome tracks', () => {
    const ids = navidromeIdsInLibrary([
      { sourceUrl: 'navidrome:abc' },
      { sourceUrl: 'navidrome:def' },
      { sourceUrl: 'https://www.youtube.com/watch?v=x' },
      { sourceUrl: null },
      {},
    ]);
    expect([...ids].sort()).toEqual(['abc', 'def']);
  });
  it('is empty for an empty library, so every hit shows "Add"', () => {
    expect(navidromeIdsInLibrary([]).size).toBe(0);
  });
  it('matches a hit id by exact value', () => {
    const ids = navidromeIdsInLibrary([{ sourceUrl: 'navidrome:abc' }]);
    expect(ids.has('abc')).toBe(true);
    expect(ids.has('ab')).toBe(false);
  });
});
