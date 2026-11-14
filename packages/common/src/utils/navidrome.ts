/** Value of `Song.sourceUrl` for a track that was copied from Navidrome. */
export function navidromeSourceUrl(trackId: string): string {
  return `navidrome:${trackId}`;
}

/** Navidrome track ids that are already in the song library. */
export function navidromeIdsInLibrary(songs: ReadonlyArray<{ sourceUrl?: string | null }>): Set<string> {
  const ids = new Set<string>();
  for (const song of songs) {
    const url = song.sourceUrl;
    if (typeof url === 'string' && url.startsWith('navidrome:')) ids.add(url.slice('navidrome:'.length));
  }
  return ids;
}
