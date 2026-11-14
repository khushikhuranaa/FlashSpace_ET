import { Router, type Request, type Response } from 'express';
import { AppError, activityQuerySchema } from '@flashspace/shared';
import type { ActivityService } from '../services/activity.service.js';
import { asyncHandler } from '../middleware/auth.js';
import { activityFilters, sendCsv } from './activity-http.js';

/**
 * Personal activity (Module 12).
 *
 * There is deliberately no route parameter for "whose" activity: the actor is
 * always the authenticated caller, so one account cannot read another's private
 * history through this API.
 */
export function activityRoutes(activity: ActivityService): Router {
  const router = Router();

  const parse = (req: Request) => {
    const parsed = activityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid activity query');
    }
    return activityFilters(req.query, parsed.data);
  };

  router.get(
    '/me/activity',
    asyncHandler(async (req: Request, res: Response) => {
      const page = await activity.listMine(req.user!, parse(req));
      res.json(page);
    }),
  );

  router.get(
    '/me/activity/export',
    asyncHandler(async (req: Request, res: Response) => {
      const file = await activity.exportCsv(req.user!, { kind: 'self' }, parse(req));
      sendCsv(res, file);
    }),
  );

  return router;
}
