import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateMusicFolder, mapNavidromePath, resolveLocalFile, isFolderReadable } from './navidrome-local.js';

describe('music folder setting', () => {
  it('empty or missing means the mode is off', () => {
    expect(validateMusicFolder('')).toBeNull();
    expect(validateMusicFolder('   ')).toBeNull();
    expect(validateMusicFolder(undefined)).toBeNull();
    expect(validateMusicFolder(null)).toBeNull();
  });
  it('accepts an absolute path and normalizes it', () => {
    expect(validateMusicFolder('/media/music')).toBe('/media/music');
    expect(validateMusicFolder(' /media/music/ ')).toBe('/media/music');
    expect(validateMusicFolder('/media//music/./rock')).toBe('/media/music/rock');
  });
  it('refuses relative paths, "..", the root, NUL, non-text and overlong values', () => {
    expect(() => validateMusicFolder('media/music')).toThrow('absolute');
    expect(() => validateMusicFolder('/media/../etc')).toThrow('..');
    expect(() => validateMusicFolder('/')).toThrow('root');
    expect(() => validateMusicFolder('/media/mu\0sic')).toThrow('invalid character');
    expect(() => validateMusicFolder(42)).toThrow('text');
    expect(() => validateMusicFolder('/' + 'a'.repeat(600))).toThrow('too long');
  });
});

describe('mapping the path Navidrome reports', () => {
  const folder = '/media/music';
  it('joins a relative path', () => {
    expect(mapNavidromePath(folder, 'Band/Album/01 Song.flac')).toBe('/media/music/Band/Album/01 Song.flac');
  });
  it('accepts an absolute path inside the folder (both apps see the same path)', () => {
    expect(mapNavidromePath(folder, '/media/music/Band/01.flac')).toBe('/media/music/Band/01.flac');
  });
  it('refuses an absolute path outside the folder, also one that only shares the prefix', () => {
    expect(mapNavidromePath(folder, '/etc/passwd')).toBeNull();
    expect(mapNavidromePath(folder, '/music/Band/01.flac')).toBeNull();
    expect(mapNavidromePath(folder, '/media/music-other/01.flac')).toBeNull();
    expect(mapNavidromePath(folder, '/media/music')).toBeNull();
  });
  it('refuses "../" in any form', () => {
    expect(mapNavidromePath(folder, '../etc/passwd')).toBeNull();
    expect(mapNavidromePath(folder, 'Band/../../etc/passwd')).toBeNull();
    expect(mapNavidromePath(folder, 'Band\\..\\..\\etc')).toBeNull();
    expect(mapNavidromePath(folder, '/media/music/../etc/passwd')).toBeNull();
  });
  it('refuses empty, missing and NUL values', () => {
    expect(mapNavidromePath(folder, '')).toBeNull();
    expect(mapNavidromePath(folder, null)).toBeNull();
    expect(mapNavidromePath(folder, undefined)).toBeNull();
    expect(mapNavidromePath(folder, 'a\0b')).toBeNull();
  });
});

describe('resolving a local file', () => {
  let root: string; let music: string; let outside: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-local-'));
    music = path.join(root, 'music');
    outside = path.join(root, 'secret');
    fs.mkdirSync(path.join(music, 'Band', 'Album'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(music, 'Band', 'Album', '01 Song.flac'), 'audio');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(music, 'link-out'));            // directory link out of the folder
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(music, 'file-out.txt')); // file link out
    fs.symlinkSync(path.join(music, 'Band'), path.join(music, 'link-in')); // link that stays inside
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns the real path of a readable file', async () => {
    expect(await resolveLocalFile(music, 'Band/Album/01 Song.flac')).toBe(fs.realpathSync(path.join(music, 'Band/Album/01 Song.flac')));
  });
  it('accepts an absolute path inside the folder', async () => {
    const abs = path.join(music, 'Band', 'Album', '01 Song.flac');
    expect(await resolveLocalFile(music, abs)).toBe(fs.realpathSync(abs));
  });
  it('a missing file is null (the caller falls back to HTTP)', async () => {
    expect(await resolveLocalFile(music, 'Band/Album/missing.flac')).toBeNull();
  });
  it('a directory is not a track', async () => {
    expect(await resolveLocalFile(music, 'Band/Album')).toBeNull();
  });
  it('refuses to leave the folder through "../"', async () => {
    expect(await resolveLocalFile(music, '../secret/secret.txt')).toBeNull();
  });
  it('refuses an absolute path outside the folder', async () => {
    expect(await resolveLocalFile(music, path.join(outside, 'secret.txt'))).toBeNull();
  });
  it('refuses to leave the folder through a symlink (directory or file)', async () => {
    expect(await resolveLocalFile(music, 'link-out/secret.txt')).toBeNull();
    expect(await resolveLocalFile(music, 'file-out.txt')).toBeNull();
  });
  it('allows a symlink that stays inside the folder', async () => {
    expect(await resolveLocalFile(music, 'link-in/Album/01 Song.flac')).not.toBeNull();
  });
  it('is null when the music folder itself does not exist', async () => {
    expect(await resolveLocalFile(path.join(root, 'nope'), 'Band/Album/01 Song.flac')).toBeNull();
  });
  it('reports whether a folder can be read, without listing it', async () => {
    expect(await isFolderReadable(music)).toBe(true);
    expect(await isFolderReadable(path.join(root, 'nope'))).toBe(false);
    expect(await isFolderReadable(path.join(music, 'Band', 'Album', '01 Song.flac'))).toBe(false); // a file
  });
});
