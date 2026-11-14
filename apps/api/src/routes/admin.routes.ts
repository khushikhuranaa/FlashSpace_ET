import { Router, type Request, type Response } from 'express';
import {
  AppError,
  adminUserQuerySchema,
} from '@flashspace/shared';
import type { LifecycleJob } from '@flashspace/shared';
import type { AdminService } from '../services/admin.service.js';
import type { ActivityService } from '../services/activity.service.js';
import { activityQuerySchema } from '@flashspace/shared';
import { asyncHandler, requireAdmin } from '../middleware/auth.js';
import { activityFilters, sendCsv } from './activity-http.js';

/**
 * Admin control panel API (Module 11).
 *
 * Every route is behind `requireAdmin`, which checks the *global* role resolved
 * server-side from the session. Hiding a menu item is never the control here.
 * Space OWNER/EDITOR/VIEWER roles grant nothing on these endpoints.
 */
export function adminRoutes(admin: AdminService, activity: ActivityService): Router {
  const router = Router();
  router.use(requireAdmin);

  const parseUserQuery = (req: Request) => {
    const parsed = adminUserQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid user query',
      );
    }
    return parsed.data;
  };

  const intParam = (value: unknown): number | undefined => {
    if (typeof value !== 'string' || !value) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new AppError('VALIDATION_ERROR', 'Invalid numeric query');
    return Math.trunc(n);
  };

  // -- dashboard -----------------------------------------------------------

  router.get(
    '/admin/stats',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.stats(req.user!.id));
    }),
  );

  router.get(
    '/admin/overview',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.overview(req.user!.id));
    }),
  );

  router.get(
    '/admin/health',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.health(req.user!.id));
    }),
  );

  // -- users ---------------------------------------------------------------

  router.get(
    '/admin/users',
    asyncHandler(async (req: Request, res: Response) => {
      const query = parseUserQuery(req);
      res.json(await admin.listUsers(req.user!.id, query));
    }),
  );

  router.get(
    '/admin/users/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.userDetail(req.user!.id, req.params.userId!));
    }),
  );

  router.post(
    '/admin/users/:userId/role',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      if (body.role !== 'USER' && body.role !== 'ADMIN') {
        throw new AppError('VALIDATION_ERROR', 'role must be USER or ADMIN');
      }
      if (body.confirm !== true) {
        throw new AppError('VALIDATION_ERROR', 'Role changes require explicit confirmation');
      }
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'reason must be a string');
      }
      res.json({
        user: await admin.changeRole(
          req.user!.id,
          req.params.userId!,
          body.role,
          typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined,
        ),
      });
    }),
  );

  // Kept for backwards compatibility with the original admin console.
  router.post(
    '/admin/users/:userId/promote',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ user: await admin.promoteToAdmin(req.user!.id, req.params.userId!) });
    }),
  );

  router.post(
    '/admin/users/:userId/suspend',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 5) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A suspension reason of at least 5 characters is required',
        );
      }
      if (reason.length > 1000) {
        throw new AppError('VALIDATION_ERROR', 'Reason cannot exceed 1000 characters');
      }
      if (body.confirm !== true) {
        throw new AppError('VALIDATION_ERROR', 'Suspension requires explicit confirmation');
      }
      res.json({ user: await admin.suspendAccount(req.user!.id, req.params.userId!, reason) });
    }),
  );

  router.post(
    '/admin/users/:userId/reactivate',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ user: await admin.reactivateAccount(req.user!.id, req.params.userId!) });
    }),
  );

  // -- lifecycle jobs ------------------------------------------------------

  router.get(
    '/admin/jobs',
    asyncHandler(async (req: Request, res: Response) => {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(status)) {
        throw new AppError('VALIDATION_ERROR', 'Unknown job status');
      }
      const jobType = typeof req.query.jobType === 'string' ? req.query.jobType : undefined;
      if (jobType && !['LIFECYCLE', 'ARCHIVE', 'CLEANUP'].includes(jobType)) {
        throw new AppError('VALIDATION_ERROR', 'Unknown job type');
      }
      res.json(
        await admin.listJobs(req.user!.id, {
          status: status as LifecycleJob['status'] | undefined,
          jobType: jobType as LifecycleJob['jobType'] | undefined,
          q: typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined,
          limit: intParam(req.query.limit),
          offset: intParam(req.query.offset),
        }),
      );
    }),
  );

  // Declared before `/admin/jobs/:jobId` so "failed" is not read as an id.
  router.get(
    '/admin/jobs/failed',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.listFailedJobs(req.user!.id));
    }),
  );

  router.get(
    '/admin/jobs/:jobId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.jobDetail(req.user!.id, req.params.jobId!));
    }),
  );

  router.post(
    '/admin/jobs/:jobId/retry',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.retryJob(req.user!.id, req.params.jobId!));
    }),
  );

  // -- archives + cleanup --------------------------------------------------

  router.post(
    '/admin/archives/:archiveId/retry',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ archive: await admin.retryArchive(req.user!.id, req.params.archiveId!) });
    }),
  );

  router.get(
    '/admin/archives',
    asyncHandler(async (req: Request, res: Response) => {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !['PENDING', 'CREATING', 'VERIFIED', 'FAILED'].includes(status)) {
        throw new AppError('VALIDATION_ERROR', 'Unknown archive status');
      }
      res.json(
        await admin.listArchives(
          req.user!.id,
          status as 'PENDING' | 'CREATING' | 'VERIFIED' | 'FAILED' | undefined,
        ),
      );
    }),
  );

  router.get(
    '/admin/cleanup',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await admin.cleanupStatus(req.user!.id));
    }),
  );

  // -- extensions ----------------------------------------------------------

  router.get(
    '/admin/extensions',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: await admin.listExtensions(req.user!.id) });
    }),
  );

  // -- audit + security events --------------------------------------------

  router.get(
    '/admin/audit',
    asyncHandler(async (req: Request, res: Response) => {
      const outlet = typeof req.query.outlet === 'string' ? req.query.outlet : 'ALL';
      if (!['SECURITY', 'ADMIN', 'ALL'].includes(outlet)) {
        throw new AppError('VALIDATION_ERROR', 'outlet must be SECURITY, ADMIN or ALL');
      }
      res.json(
        await admin.auditLog(req.user!.id, {
          outlet: outlet as 'SECURITY' | 'ADMIN' | 'ALL',
          action: typeof req.query.action === 'string' ? req.query.action.slice(0, 80) : undefined,
          adminId: typeof req.query.adminId === 'string' ? req.query.adminId.slice(0, 80) : undefined,
          limit: intParam(req.query.limit),
          offset: intParam(req.query.offset),
        }),
      );
    }),
  );

  router.get(
    '/admin/security-events',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(
        await admin.auditLog(req.user!.id, {
          outlet: 'SECURITY',
          limit: intParam(req.query.limit),
          offset: intParam(req.query.offset),
        }),
      );
    }),
  );

  router.get(
    '/admin/audit/export',
    asyncHandler(async (req: Request, res: Response) => {
      const outlet = typeof req.query.outlet === 'string' ? req.query.outlet : 'ALL';
      if (!['SECURITY', 'ADMIN', 'ALL'].includes(outlet)) {
        throw new AppError('VALIDATION_ERROR', 'outlet must be SECURITY, ADMIN or ALL');
      }
      sendCsv(
        res,
        await activity.exportAdminAudit(req.user!.id, outlet as 'SECURITY' | 'ADMIN' | 'ALL'),
      );
    }),
  );

  // -- platform activity ---------------------------------------------------

  router.get(
    '/admin/activity',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid activity query');
      }
      res.json(await activity.listPlatform(req.user!.id, activityFilters(req.query, parsed.data)));
    }),
  );

  router.get(
    '/admin/activity/export',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid activity query');
      }
      sendCsv(
        res,
        await activity.exportCsv(req.user!, { kind: 'platform' }, activityFilters(req.query, parsed.data)),
      );
    }),
  );

  // -- analytics -----------------------------------------------------------

  router.get(
    '/admin/analytics',
    asyncHandler(async (req: Request, res: Response) => {
      const days = intParam(req.query.days);
      res.json(await admin.analytics(req.user!.id, days ?? 14));
    }),
  );

  return router;
}
