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
      // Ownership is checked BEFORE the write: marking first lets any signed-in
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
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const sort = (typeof req.query.sort === 'string' ? req.query.sort : 'newest') as 'newest' | 'oldest' | 'size-asc' | 'size-desc';
      const int = (v: unknown): number | undefined => {
        if (typeof v !== 'string' || !v) return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
      };
      const filtered = await archives.listVaultFiltered(req.user!, { q, status, sort });
      const page = await archives.listVaultFiltered(req.user!, { q, status, sort, limit: int(req.query.limit), offset: int(req.query.offset) });
      res.json({ archives: page.archives, total: filtered.total });
    }),
  );

  router.get(
    '/vault/archives/:archiveId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.getArchive(req.user!, req.params.archiveId!));
    }),
  );

  router.get(
    '/vault/archives/:archiveId/files',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.getArchiveFiles(req.user!, req.params.archiveId!));
    }),
  );

  router.post(
    '/vault/archives/:archiveId/verify',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.verifyArchive(req.user!, req.params.archiveId!));
    }),
  );

  router.post(
    '/vault/archives/:archiveId/download',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.download(req.user!, req.params.archiveId!));
    }),
  );

  router.post(
    '/vault/archives/:archiveId/manifest',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await archives.downloadManifest(req.user!, req.params.archiveId!));
    }),
  );

  // -- Admin: CSV export of the current user's vault (filtered) -----------

  router.get(
    '/vault/archives/export-csv',
    asyncHandler(async (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const sort = (typeof req.query.sort === 'string' ? req.query.sort : 'newest') as 'newest' | 'oldest' | 'size-asc' | 'size-desc';
      const data = await archives.listVaultFiltered(req.user!, { q, status, sort, limit: 10000, offset: 0 });
      const header = ['Archive', 'Source Space', 'Status', 'Files', 'Size (bytes)', 'Created', 'Verified', 'Checksum'];
      const detailRecords = await Promise.all(data.archives.map(async (a) => ({
        archive: a,
        detail: await archives.getArchive(req.user!, a.id),
      })));
      const rows = [
        header,
        ...detailRecords.map(({ archive: a, detail }) => [
          CSVField(`${a.spaceId}.zip`),
          CSVField(detail.spaceName ?? 'Removed Space'),
          CSVField(a.status),
          String(a.fileCount),
          String(a.sizeBytes),
          CSVField(a.createdAt),
          CSVField(a.verifiedAt ?? ''),
          CSVField(a.checksum ?? ''),
        ]),
      ];
      const csv = rows.map((r) => r.join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv;charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="flashspace-vault-export.csv"');
      res.send(csv);
    }),
  );

  // -- Admin extension decisions ------------------------------------------

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

/** Escape a CSV field to prevent formula injection and cell-breaks. */
function CSVField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.startsWith('=')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
