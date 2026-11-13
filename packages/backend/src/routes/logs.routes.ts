import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { TSApiError } from '../middleware/error-handler.js';

export const logRoutes: Router = Router({ mergeParams: true });

// Server logs carry connection IPs, so they are admin-only — matching the UI,
// which already places Server Logs in the admin section.
logRoutes.use(requireRole('admin'));

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));

logRoutes.get('/', async (req: Request, res: Response, next) => {
  const logview = (instance: unknown) => getClient(req).execute(getSid(req), 'logview', {
    lines: req.query.lines || 100,
    reverse: req.query.reverse || 1,
    instance,
    begin_pos: req.query.begin_pos,
  });
  try {
    res.json(await logview(req.query.instance || 0));
  } catch (err) {
    // TeamSpeak creates the log file of a virtual server with its first log
    // line, so right after a start of the server logview answers 2052 "file
    // input/output error". That is not a failure of this app: show the
    // instance log (which exists from the start) and say why.
    if (err instanceof TSApiError && err.code === 2052 && String(req.query.instance || 0) === '0') {
      try {
        const instanceLog = await logview(1);
        const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
        res.json([
          {
            l: `${stamp}|INFO    |ts6-manager  |   |TeamSpeak has not written a log for virtual server ${getSid(req)} since it started: it creates that file with the first event (for example a client joining). The instance log is shown instead.`,
          },
          ...(Array.isArray(instanceLog) ? instanceLog : []),
        ]);
        return;
      } catch { /* fall through to the original error */ }
    }
    next(err);
  }
});
