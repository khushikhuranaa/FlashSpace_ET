import { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { SearchCategory } from '@flashspace/shared';
import type { DashboardService } from '../services/dashboard.service.js';
import type { SearchService } from '../services/search.service.js';
import { asyncHandler } from '../middleware/auth.js';

const CATEGORIES: SearchCategory[] = ['all', 'spaces', 'files', 'folders'];

/**
 * Dashboard + global search (Module 2).
 *
 * Both endpoints sit behind `requireAuth`, so `req.user` is a verified identity
 * and no endpoint accepts a user id. Authorization for every row returned is
 * enforced by the services (they start from the caller's accessible Spaces).
 */
export function dashboardRoutes(dashboard: DashboardService, search: SearchService): Router {
  const router = Router();

  router.get(
    '/dashboard/summary',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await dashboard.summary(req.user!));
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const category = typeof req.query.category === 'string' ? req.query.category : 'all';
      if (!CATEGORIES.includes(category as SearchCategory)) {
        throw new AppError('VALIDATION_ERROR', 'category must be all, spaces, files or folders');
      }
      const spaceId = typeof req.query.spaceId === 'string' && req.query.spaceId ? req.query.spaceId : undefined;
      const fileType = typeof req.query.type === 'string' && req.query.type ? req.query.type.slice(0, 100) : undefined;
      let limit: number | undefined;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new AppError('VALIDATION_ERROR', 'limit must be a positive number');
        }
        limit = Math.min(25, Math.trunc(parsed));
      }
      res.json(
        await search.search(req.user!, {
          q: q.slice(0, 120),
          category: category as SearchCategory,
          spaceId,
          fileType,
          limit,
        }),
      );
    }),
  );

  return router;
}
