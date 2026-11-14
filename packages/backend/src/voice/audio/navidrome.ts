import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Minimal Subsonic/OpenSubsonic client, enough for Navidrome: ping, search and
 * download of the original file. Tracks are copied into the music directory so
 * the existing playback pipeline (ffmpeg on a local file) is reused unchanged.
 */

export interface NavidromeConfig {
  url: string;
  username: string;
  password: string;
  requestTimeoutMs?: number;
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

async function call(cfg: NavidromeConfig, endpoint: string, extra: Record<string, string> = {}): Promise<any> {
  const res = await fetch(buildUrl(cfg, endpoint, extra), { signal: AbortSignal.timeout(cfg.requestTimeoutMs ?? 15000) });
  if (!res.ok) throw new Error(`Navidrome answered HTTP ${res.status}`);
  const body: any = await res.json();
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

/** Downloads the original file into outputDir; returns the path. */
export async function downloadTrack(cfg: NavidromeConfig, track: NavidromeTrack, outputDir: string): Promise<string> {
  const ext = (track.suffix || 'mp3').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp3';
  const safeId = track.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const dest = path.join(outputDir, `navidrome-${safeId}.${ext}`);
  const res = await fetch(buildUrl(cfg, 'download', { id: track.id }), { signal: AbortSignal.timeout(cfg.requestTimeoutMs ? cfg.requestTimeoutMs * 8 : 120000) });
  if (!res.ok || !res.body) throw new Error(`Navidrome download failed: HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('json')) {
    // Subsonic reports errors as JSON with HTTP 200
    const body: any = await res.json().catch(() => null);
    throw new Error(body?.['subsonic-response']?.error?.message || 'Navidrome download failed');
  }
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return dest;
}
