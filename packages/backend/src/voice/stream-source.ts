import { isNavidromePath, navidromeTrackId } from './audio/navidrome.js';

/**
 * Decides how a Navidrome track is read: a local file when the music folder is
 * mounted (and the file is there), otherwise the stream URL. Null when Navidrome
 * is not configured.
 */
export type NavidromeInputResolver = (trackId: string) => Promise<PlaybackInput | null>;

let navidromeResolver: NavidromeInputResolver | null = null;

export function setNavidromeInputResolver(fn: NavidromeInputResolver | null): void {
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
  const resolved = navidromeResolver ? await navidromeResolver(navidromeTrackId(filePath)) : null;
  if (!resolved) throw new Error('Navidrome is not configured, so this track cannot be played');
  return resolved;
}
