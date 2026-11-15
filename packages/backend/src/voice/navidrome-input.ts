import { buildStreamUrl, type NavidromeConfig } from './audio/navidrome.js';
import { resolveLocalFile } from './audio/navidrome-local.js';
import type { NavidromeInputResolver } from './stream-source.js';
import { PlaybackStartError } from './playback-error.js';

export interface NavidromeInputDeps {
  /** Saved Navidrome settings, or null when Navidrome is off or incomplete. */
  loadConfig(): Promise<NavidromeConfig | null>;
  /** The path Navidrome reported for the track when it was added, if known. */
  findReportedPath(trackId: string): Promise<string | null>;
  /**
   * Asks Navidrome for the path of a track added before it was stored (and remembers it).
   * Throws an Error with a readable message when Navidrome cannot be asked.
   */
  learnReportedPath?(cfg: NavidromeConfig, trackId: string): Promise<string | null>;
  log?(message: string): void;
}

/**
 * Local file first, HTTP stream second. With a music folder set and the file
 * readable inside it, the track is read from disk: no network, no credentials in
 * a URL, and Navidrome may be off. Otherwise (no folder, no known path, file
 * missing or outside the folder) the track is streamed from Navidrome as before.
 */
export function createNavidromeInputResolver(deps: NavidromeInputDeps): NavidromeInputResolver {
  return async (trackId) => {
    const cfg = await deps.loadConfig();
    if (!cfg) return null;

    if (cfg.musicFolder) {
      let reported = await deps.findReportedPath(trackId);
      if (!reported && deps.learnReportedPath) {
        try {
          reported = await deps.learnReportedPath(cfg, trackId);
        } catch (err) {
          // The path is not stored and Navidrome cannot give it: the HTTP stream would fail as
          // well, so report it now instead of starting a decode that ends in silence.
          throw new PlaybackStartError((err as Error).message, { cause: err });
        }
      }
      const local = await resolveLocalFile(cfg.musicFolder, reported);
      if (local) return { input: local, remote: false };
      // No paths in the log: the reported one is data from a remote server
      deps.log?.(`[Navidrome] track ${trackId}: not readable in the music folder, streaming over HTTP`);
    }
    return { input: buildStreamUrl(cfg, trackId), remote: true };
  };
}
