import { isNavidromePath, navidromeTrackId } from './audio/navidrome.js';

/** Builds the playback URL for a Navidrome track id, or null when Navidrome is not configured. */
export type NavidromeUrlResolver = (trackId: string) => Promise<string | null>;

let navidromeResolver: NavidromeUrlResolver | null = null;

export function setNavidromeUrlResolver(fn: NavidromeUrlResolver | null): void {
  navidromeResolver = fn;
}

export interface PlaybackInput {
  /** Local file path or http(s) URL that ffmpeg reads. */
  input: string;
  /** True when `input` is a URL on a remote server. */
  remote: boolean;
}

/**
 * Turns the stored path of a song into what ffmpeg should read. Local files
 * stay as they are; `navidrome:<id>` becomes a stream URL of the configured
 * Navidrome server.
 */
export async function resolvePlaybackInput(filePath: string): Promise<PlaybackInput> {
  if (!isNavidromePath(filePath)) return { input: filePath, remote: false };
  const url = navidromeResolver ? await navidromeResolver(navidromeTrackId(filePath)) : null;
  if (!url) throw new Error('Navidrome is not configured, so this track cannot be played');
  return { input: url, remote: true };
}
