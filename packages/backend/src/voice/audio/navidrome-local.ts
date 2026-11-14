import fs from 'fs';
import path from 'path';

/**
 * Local folder mode for Navidrome tracks. When the Navidrome music folder is
 * mounted into the manager (read only), a track is read straight from that
 * folder instead of being streamed over HTTP.
 *
 * Everything here is about not trusting the path: it comes from a remote
 * server, so it is only used if it stays inside the configured folder.
 */

export const MAX_MUSIC_FOLDER_LENGTH = 500;

/** Validates the "Music folder" setting; returns the normalized path or null for "off". */
export function validateMusicFolder(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new Error('Music folder must be text');
  const raw = input.trim();
  if (!raw) return null;
  if (raw.length > MAX_MUSIC_FOLDER_LENGTH) {
    throw new Error(`Music folder is too long (at most ${MAX_MUSIC_FOLDER_LENGTH} characters)`);
  }
  if (raw.includes('\0')) throw new Error('Music folder contains an invalid character');
  if (!path.posix.isAbsolute(raw)) throw new Error('Music folder must be an absolute path, for example /media/music');
  if (raw.split('/').includes('..')) throw new Error('Music folder must not contain ".."');
  const normalized = path.posix.normalize(raw).replace(/\/+$/, '');
  if (!normalized) throw new Error('Music folder must not be the root of the file system');
  return normalized;
}

/**
 * Maps the path Navidrome reports for a track to a candidate path in the
 * manager's music folder, or null if it cannot belong there.
 *
 * Navidrome reports either a path relative to its library (rare) or, when the
 * player has "Report Real Path" switched on, the absolute path as Navidrome
 * sees it. An absolute path is used only if it lies inside the folder (that
 * is the case when both apps see the music under the same path, such as
 * /media/music). Without "Report Real Path" Navidrome reports a made-up path
 * built from the tags, which simply does not exist here.
 */
export function mapNavidromePath(folder: string, reported: string | null | undefined): string | null {
  if (typeof reported !== 'string') return null;
  const value = reported.trim();
  if (!value || value.includes('\0')) return null;
  if (path.posix.isAbsolute(value)) {
    const normalized = path.posix.normalize(value);
    return normalized.startsWith(folder + '/') ? normalized : null;
  }
  if (value.split(/[\\/]/).includes('..')) return null;
  return path.posix.join(folder, value);
}

/**
 * Returns the real path of a readable regular file for the track, or null.
 * The real path (symlinks resolved) has to stay inside the real music folder.
 */
export async function resolveLocalFile(folder: string, reported: string | null | undefined): Promise<string | null> {
  const candidate = mapNavidromePath(folder, reported);
  if (!candidate) return null;
  try {
    const realFolder = await fs.promises.realpath(folder);
    const realFile = await fs.promises.realpath(candidate);
    if (!realFile.startsWith(realFolder + path.sep)) return null;
    const stat = await fs.promises.stat(realFile);
    if (!stat.isFile()) return null;
    await fs.promises.access(realFile, fs.constants.R_OK);
    return realFile;
  } catch {
    return null;
  }
}

/** Whether the folder exists and can be read (no file names are listed). */
export async function isFolderReadable(folder: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(folder);
    if (!stat.isDirectory()) return false;
    await fs.promises.access(folder, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
