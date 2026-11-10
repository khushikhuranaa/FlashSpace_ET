import { Router, type Request, type Response } from 'express';
import type { LifecycleService } from '../services/lifecycle.service.js';
import { asyncHandler } from '../middleware/auth.js';

/**
 * Job runner endpoint (PRD §14): GitHub Actions (or any cron) POSTs here with
 * the shared job secret. Idempotency is handled inside the lifecycle pass.
 */
export function jobsRoutes(lifecycle: LifecycleService): Router {
  const router = Router();

  router.post(
    '/jobs/lifecycle/run',
    asyncHandler(async (req: Request, res: Response) => {
      const result = await lifecycle.runLifecyclePass({
        source: 'cron',
        jobSecret: req.header('x-job-secret'),
      });
      res.json(result);
    }),
  );

  return router;
}
