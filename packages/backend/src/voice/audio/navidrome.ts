import { createHash, randomBytes } from 'crypto';

/**
 * Minimal Subsonic/OpenSubsonic client, enough for Navidrome: ping, search, track
 * details and the stream URL of the original file. Tracks are not copied: ffmpeg
 * reads them from Navidrome while they play.
 */

export interface NavidromeConfig {
  url: string;
  username: string;
  password: string;
  requestTimeoutMs?: number;
}

/** Prefix of `Song.filePath` / `QueueItem.filePath` for a track that is streamed from Navidrome. */
export const NAVIDROME_PATH_PREFIX = 'navidrome:';

export function navidromePath(trackId: string): string {
  return `${NAVIDROME_PATH_PREFIX}${trackId}`;
}

export function isNavidromePath(filePath: string): boolean {
  return typeof filePath === 'string' && filePath.startsWith(NAVIDROME_PATH_PREFIX);
}

export function navidromeTrackId(filePath: string): string {
  return filePath.slice(NAVIDROME_PATH_PREFIX.length);
}

export interface NavidromeTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  suffix: string | null;
  size: number | null;
}

const API_VERSION = '1.16.1';
const CLIENT_NAME = 'ts6-manager';

/**
 * Text for an error shown to the user: "Navidrome: <message>", unless the message
 * already starts with "Navidrome" (then a second prefix would only repeat it).
 */
export function navidromeErrorText(message: string): string {
  return /^navidrome\b/i.test(message) ? message : `Navidrome: ${message}`;
}

export function normalizeBaseUrl(raw: string): string {
  const u = new URL(String(raw || '').trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Navidrome URL must start with http:// or https://');
  }
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

export function buildAuthParams(username: string, password: string, salt = randomBytes(8).toString('hex')): URLSearchParams {
  const token = createHash('md5').update(password + salt).digest('hex');
  return new URLSearchParams({ u: username, t: token, s: salt, v: API_VERSION, c: CLIENT_NAME, f: 'json' });
}

function buildUrl(cfg: NavidromeConfig, endpoint: string, extra: Record<string, string> = {}): string {
  const params = buildAuthParams(cfg.username, cfg.password);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `${normalizeBaseUrl(cfg.url)}/rest/${endpoint}?${params.toString()}`;
}

export const MSG_UNREACHABLE = 'Navidrome is not reachable. Check the URL and port.';
export const MSG_TIMEOUT = 'Navidrome did not answer in time.';

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * Turns a network failure of fetch() ("fetch failed", ECONNREFUSED, ENOTFOUND,
 * timeout, abort) into a readable message. The message never contains the host,
 * the URL or any credential.
 */
export function describeNetworkError(err: unknown): string {
  const e: any = err;
  const code = String(e?.cause?.code ?? e?.code ?? '');
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || TIMEOUT_CODES.has(code)) return MSG_TIMEOUT;
  return MSG_UNREACHABLE;
}

async function request(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(describeNetworkError(err), { cause: err });
  }
}

async function call(cfg: NavidromeConfig, endpoint: string, extra: Record<string, string> = {}): Promise<any> {
  const res = await request(buildUrl(cfg, endpoint, extra), cfg.requestTimeoutMs ?? 15000);
  if (!res.ok) throw new Error(`Navidrome answered HTTP ${res.status}`);
  // A wrong path often answers 200 with an HTML page; that is not JSON
  const body: any = await res.json().catch(() => null);
  const sr = body?.['subsonic-response'];
  if (!sr) throw new Error('Not a Subsonic response (check the URL)');
  if (sr.status !== 'ok') throw new Error(sr.error?.message || `Subsonic error ${sr.error?.code ?? ''}`.trim());
  return sr;
}

export async function ping(cfg: NavidromeConfig): Promise<{ version: string; serverVersion: string | null }> {
  const sr = await call(cfg, 'ping');
  return { version: String(sr.version ?? ''), serverVersion: sr.serverVersion ? String(sr.serverVersion) : null };
}

export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_SEARCH_RESULTS = 50;

/**
 * Navidrome answers search3 with an empty query by returning the WHOLE library,
 * not "no hits". Reject empty/blank and overlong input before any request is made.
 */
export function validateSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Search term must be text');
  const query = raw.trim();
  if (!query) throw new Error('Enter a search term');
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search term is too long (at most ${MAX_SEARCH_QUERY_LENGTH} characters)`);
  }
  return query;
}

export async function searchTracks(cfg: NavidromeConfig, rawQuery: string, count = 20): Promise<NavidromeTrack[]> {
  const query = validateSearchQuery(rawQuery);
  const sr = await call(cfg, 'search3', {
    query,
    songCount: String(Math.min(Math.max(count, 1), MAX_SEARCH_RESULTS)),
    artistCount: '0',
    albumCount: '0',
  });
  const songs: any[] = sr.searchResult3?.song ?? [];
  return songs.map((s) => ({
    id: String(s.id),
    title: String(s.title ?? s.id),
    artist: s.artist ? String(s.artist) : null,
    album: s.album ? String(s.album) : null,
    duration: typeof s.duration === 'number' ? s.duration : null,
    suffix: s.suffix ? String(s.suffix) : null,
    size: typeof s.size === 'number' ? s.size : null,
  }));
}

export async function getTrack(cfg: NavidromeConfig, id: string): Promise<NavidromeTrack> {
  const sr = await call(cfg, 'getSong', { id });
  const s = sr.song;
  if (!s) throw new Error('Track not found');
  return {
    id: String(s.id),
    title: String(s.title ?? s.id),
    artist: s.artist ? String(s.artist) : null,
    album: s.album ? String(s.album) : null,
    duration: typeof s.duration === 'number' ? s.duration : null,
    suffix: s.suffix ? String(s.suffix) : null,
    size: typeof s.size === 'number' ? s.size : null,
  };
}

/**
 * URL that serves the original file of a track (supports HTTP range requests,
 * so ffmpeg can seek). It carries the user name and the Subsonic token, never
 * the password. Do not log it.
 */
export function buildStreamUrl(cfg: NavidromeConfig, trackId: string): string {
  return buildUrl(cfg, 'download', { id: trackId });
}
