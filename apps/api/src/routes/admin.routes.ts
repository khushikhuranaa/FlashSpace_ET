import { Router, type Request, type Response } from 'express';
import type { AdminService } from '../services/admin.service.js';
import { AppError } from '@flashspace/shared';
import { asyncHandler, requireAdmin } from '../middleware/auth.js';

export function adminRoutes(admin: AdminService): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get(
    '/admin/stats',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.stats(req.user!.id));
    }),
  );

  router.get(
    '/admin/users',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ users: await admin.listUsers(req.user!.id) });
    }),
  );

  router.post(
    '/admin/users/:userId/promote',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ user: await admin.promoteToAdmin(req.user!.id, req.params.userId!) });
    }),
  );

  router.get(
    '/admin/jobs',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ jobs: await admin.listJobs(req.user!.id) });
    }),
  );

  router.get(
    '/admin/extensions',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: await admin.listExtensions(req.user!.id) });
    }),
  );

  router.post(
    '/admin/archives/:archiveId/retry',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ archive: await admin.retryArchive(req.user!.id, req.params.archiveId!) });
    }),
  );

  return router;
}
