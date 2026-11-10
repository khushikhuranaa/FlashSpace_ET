import { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { ScanService } from '../services/scan.service.js';
import type { ArchivePlanService } from '../services/archive-plan.service.js';
import type { DuplicateService } from '../services/duplicate.service.js';
import { asyncHandler } from '../middleware/auth.js';

function param(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new AppError('VALIDATION_ERROR', `Missing ${name}`);
  return value;
}

/**
 * Smart Storage Insights API (PRD §4).
 *
 * Mounted behind `requireAuth`, so `req.user` is always present. Ownership and
 * role checks happen inside the services — never trusted from the client.
 */
export function scanRoutes(
  scans: ScanService,
  plans: ArchivePlanService,
  duplicates: DuplicateService,
): Router {
  const router = Router();

  // -- Scans ---------------------------------------------------------------

  // Run a storage scan (OWNER only).
  router.post(
    '/spaces/:spaceId/scans',
    asyncHandler(async (req: Request, res: Response) => {
      const insights = await scans.scan(req.user!, param(req, 'spaceId'));
      res.status(201).json({ insights });
    }),
  );

  // Latest insights for a Space (any active member may read).
  router.get(
    '/spaces/:spaceId/insights',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ insights: await scans.getInsights(req.user!, param(req, 'spaceId')) });
    }),
  );

  // -- Duplicates ----------------------------------------------------------

  router.get(
    '/spaces/:spaceId/duplicates',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await duplicates.getDuplicates(req.user!, param(req, 'spaceId')));
    }),
  );

  // Toggle a duplicate file's exclusion flag (OWNER only).
  router.post(
    '/spaces/:spaceId/duplicates/:fileId/exclusion',
    asyncHandler(async (req: Request, res: Response) => {
      const file = await duplicates.toggleExclusion(req.user!, param(req, 'spaceId'), param(req, 'fileId'));
      res.json({ file });
    }),
  );

  // -- Archive plans -------------------------------------------------------

  router.post(
    '/spaces/:spaceId/plans',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { scanId?: unknown; excludedFileIds?: unknown; explained?: unknown };
      if (body.excludedFileIds !== undefined && (!Array.isArray(body.excludedFileIds) || body.excludedFileIds.some((v) => typeof v !== 'string'))) {
        throw new AppError('VALIDATION_ERROR', 'excludedFileIds must be an array of file IDs');
      }
      const plan = await plans.createPlan(req.user!, param(req, 'spaceId'), {
        scanId: typeof body.scanId === 'string' ? body.scanId : undefined,
        excludedFileIds: (body.excludedFileIds as string[] | undefined) ?? [],
        explained: body.explained === true,
      });
      res.status(201).json({ plan });
    }),
  );

  router.get(
    '/spaces/:spaceId/plans',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ plans: await plans.getPlansForSpace(req.user!, param(req, 'spaceId')) });
    }),
  );

  router.get(
    '/plans/:planId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await plans.getPlanReview(req.user!, param(req, 'planId')));
    }),
  );

  // Confirm an archive plan: builds + verifies the ZIP, then archives.
  router.post(
    '/plans/:planId/confirm',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await plans.confirmPlan(req.user!, param(req, 'planId')));
    }),
  );

  router.post(
    '/plans/:planId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ plan: await plans.cancelPlan(req.user!, param(req, 'planId')) });
    }),
  );

  // Admin retry of a failed archive plan.
  router.post(
    '/plans/:planId/retry',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await plans.retryFailedPlan(req.user!, param(req, 'planId')));
    }),
  );

  return router;
}
