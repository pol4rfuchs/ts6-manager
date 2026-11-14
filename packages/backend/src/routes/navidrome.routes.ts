import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { normalizeBaseUrl, ping, navidromeErrorText, type NavidromeConfig } from '../voice/audio/navidrome.js';
import { validateMusicFolder, isFolderReadable } from '../voice/audio/navidrome-local.js';

export const navidromeRoutes: Router = Router();

navidromeRoutes.use(requireRole('admin'));

async function getOrCreateSettings(prisma: any) {
  const existing = await prisma.navidromeSettings.findFirst();
  if (existing) return existing;
  return prisma.navidromeSettings.create({ data: {} });
}

/** Stored settings as a usable client config, or null when not configured. */
export async function loadNavidromeConfig(prisma: any): Promise<NavidromeConfig | null> {
  const s = await prisma.navidromeSettings.findFirst();
  if (!s || !s.enabled || !s.url || !s.username || !s.password) return null;
  return { url: s.url, username: s.username, password: decrypt(s.password), musicFolder: s.musicFolder || null };
}

// GET /api/navidrome/settings — password never returned
navidromeRoutes.get('/settings', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreateSettings(req.app.locals.prisma);
    res.json({ enabled: s.enabled, url: s.url, username: s.username, hasPassword: !!s.password, musicFolder: s.musicFolder ?? null });
  } catch (err) { next(err); }
});

// PUT /api/navidrome/settings
navidromeRoutes.put('/settings', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreateSettings(prisma);
    const { enabled, url, username, password, musicFolder } = req.body;
    const data: any = {};
    if (enabled !== undefined) data.enabled = !!enabled;
    if (url !== undefined) {
      if (url) {
        try { data.url = normalizeBaseUrl(String(url)); } catch (e: any) { throw new AppError(400, e.message); }
      } else {
        data.url = null;
      }
    }
    if (username !== undefined) data.username = username || null;
    if (musicFolder !== undefined) {
      try { data.musicFolder = validateMusicFolder(musicFolder); } catch (e: any) { throw new AppError(400, e.message); }
    }
    // Empty password means "unchanged" (same convention as the Spotify secret)
    if (password) data.password = encrypt(String(password));
    await prisma.navidromeSettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/navidrome/test — check the saved connection and, if set, the music folder
navidromeRoutes.post('/test', async (req: Request, res: Response, next) => {
  try {
    const s = await req.app.locals.prisma.navidromeSettings.findFirst();
    if (!s?.url || !s.username || !s.password) throw new AppError(400, 'Save URL, user name and password first');
    // null = no music folder set. No file names are listed, only whether the folder can be read.
    const folderReadable = s.musicFolder ? await isFolderReadable(s.musicFolder) : null;
    try {
      const info = await ping({ url: s.url, username: s.username, password: decrypt(s.password) });
      res.json({ ok: true, ...info, folderReadable });
    } catch (e: any) {
      throw new AppError(502, navidromeErrorText(e.message));
    }
  } catch (err) { next(err); }
});
