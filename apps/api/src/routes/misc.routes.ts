import { Router, type Request, type Response } from 'express';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { ExtensionService } from '../services/extension.service.js';
import type { ArchiveService } from '../services/archive.service.js';
import type { StorageService } from '../services/storage.service.js';
import { AppError } from '@flashspace/shared';
import { asyncHandler, requireAdmin } from '../middleware/auth.js';

export function miscRoutes(
  db: DataLayer,
  extensions: ExtensionService,
  archives: ArchiveService,
  storage: StorageService,
): Router {
  const router = Router();

  // -- Storage accounting --------------------------------------------------

  router.get(
    '/storage/summary',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ storage: await storage.summary(req.user!) });
    }),
  );

  // -- Notifications -------------------------------------------------------

  router.get(
    '/notifications',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ notifications: await db.notifications.listForUser(req.user!.id) });
    }),
  );

  router.post(
    '/notifications/:notificationId/read',
    asyncHandler(async (req: Request, res: Response) => {
      // Ownership is checked BEFORE the write: marking first let any signed-in
      // user flip another user's notification to "read".
      const notificationId = req.params.notificationId!;
      const existing = await db.notifications.findById(notificationId);
      if (!existing || existing.userId !== req.user!.id) {
        throw new AppError('NOT_FOUND', 'Notification not found');
      }
      res.json({ notification: (await db.notifications.markRead(notificationId))! });
    }),
  );

  router.post(
    '/notifications/read-all',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ updated: await db.notifications.markAllRead(req.user!.id) });
    }),
  );

  router.get(
    '/notifications/unread',
    asyncHandler(async (req: Request, res: Response) => {
      const count = (await db.notifications.listForUser(req.user!.id)).filter((n) => !n.readAt).length;
      res.json({ unread: count });
    }),
  );

  // -- Vault ---------------------------------------------------------------

  router.get(
    '/vault/archives',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ archives: await archives.listVault(req.user!) });
    }),
  );

  router.post(
    '/vault/archives/:archiveId/download',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.download(req.user!, req.params.archiveId!));
    }),
  );

  // -- Admin extension decisions -------------------------------------------

  router.get(
    '/admin/extensions/pending',
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: await extensions.listPending(req.user!) });
    }),
  );

  router.post(
    '/admin/extensions/:requestId/decision',
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { decision } = req.body as Record<string, unknown>;
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        throw new AppError('VALIDATION_ERROR', 'decision must be APPROVED or REJECTED');
      }
      res.json({ request: await extensions.decide(req.user!, req.params.requestId!, decision) });
    }),
  );

  return router;
}
