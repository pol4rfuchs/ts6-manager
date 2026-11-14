import api from './client';

export interface NavidromeSettings {
  enabled: boolean;
  url: string | null;
  username: string | null;
  hasPassword: boolean;
  musicFolder: string | null;
}

export const navidromeApi = {
  settings: (): Promise<NavidromeSettings> => api.get('/navidrome/settings').then((r) => r.data),
  updateSettings: (data: Partial<NavidromeSettings> & { password?: string }) =>
    api.put('/navidrome/settings', data).then((r) => r.data),
  test: (): Promise<{ ok: boolean; version: string; serverVersion: string | null; folderReadable: boolean | null }> =>
    api.post('/navidrome/test', {}, { timeout: 30000 }).then((r) => r.data),
};
