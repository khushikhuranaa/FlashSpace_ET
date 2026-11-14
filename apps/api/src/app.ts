import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { loadEnv, type Env } from './config/env.js';
import { createDataLayer, type DataLayer } from './repositories/index.js';
import { checkPostgresHealth } from './repositories/postgres/pool.js';
import { createStorageAdapter, type StorageAdapter } from './storage/index.js';
import { AuthService } from './services/auth.service.js';
import { SpacesService } from './services/spaces.service.js';
import { FilesService } from './services/files.service.js';
import { ArchiveService } from './services/archive.service.js';
import { CleanupService } from './services/cleanup.service.js';
import { ExtensionService } from './services/extension.service.js';
import { LifecycleService } from './services/lifecycle.service.js';
import { AdminService } from './services/admin.service.js';
import { MembershipService } from './services/membership.service.js';
import { StorageService } from './services/storage.service.js';
import { ScanService } from './services/scan.service.js';
import { ArchivePlanService } from './services/archive-plan.service.js';
import { DuplicateService } from './services/duplicate.service.js';
import { DashboardService } from './services/dashboard.service.js';
import { SpaceManagementService } from './services/space-management.service.js';
import { FileManagerService } from './services/file-manager.service.js';
import { SearchService } from './services/search.service.js';
import { EmailService, VerificationTokensService } from './services/email.service.js';
import { ActivityService } from './services/activity.service.js';
import { activityRoutes } from './routes/activity.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { ProfileStore } from './supabase/profile-store.js';
import { SupabaseIdentityService, type TokenVerifier } from './services/identity.service.js';
import { AccountService } from './services/account.service.js';
import { spaceRoutes } from './routes/space.routes.js';
import { miscRoutes } from './routes/misc.routes.js';
import { storageRoutes } from './routes/storage.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { jobsRoutes } from './routes/jobs.routes.js';
import { scanRoutes } from './routes/scan.routes.js';
import { requestContext, errorMiddleware } from './middleware/error.js';
import { requireAuth, asyncHandler } from './middleware/auth.js';
import { securityHeaders, requireHttps } from './middleware/security-headers.js';
import { rateLimit, clientKey, credentialKey, credentialAccountKey } from './middleware/rate-limit.js';
import { MalwareScanService } from './services/malware-scan.service.js';
import { BackupService } from './services/backup.service.js';
import { AppError } from '@flashspace/shared';

export interface AppContext {
  env: Env;
  db: DataLayer;
  storage: StorageAdapter;
  services: {
    auth: AuthService;
    spaces: SpacesService;
    files: FilesService;
    archive: ArchiveService;
    cleanup: CleanupService;
    extensions: ExtensionService;
    lifecycle: LifecycleService;
    admin: AdminService;
    membership: MembershipService;
    storage: StorageService;
    scans: ScanService;
    archivePlans: ArchivePlanService;
    duplicates: DuplicateService;
    account: AccountService;
    dashboard: DashboardService;
    search: SearchService;
    spaceManagement: SpaceManagementService;
    fileManager: FileManagerService;
    email: EmailService;
    verificationTokens: VerificationTokensService;
    activity: ActivityService;
    /** Module 14: provider-independent malware scanning (NOT_CONFIGURED by default). */
    malwareScanner: MalwareScanService;
    /** Module 14: local backup / verify / isolated restore tooling. */
    backups: BackupService;
  };
  /** Local JWT in development, Supabase JWKS when AUTH_MODE=supabase. */
  identity: TokenVerifier;
}

export interface AppDependencies {
  /** Module 14 test seam: inject a scanner without changing the env contract. */
  scanner?: MalwareScanService;
}

export function createAppContext(
  envOverrides: Partial<Env> = {},
  deps: AppDependencies = {},
): AppContext {
  const env = loadEnv(envOverrides);
  const db = createDataLayer(env);
  const storageAdapter = createStorageAdapter(env);

  const auth = new AuthService(env, db.auth, db.sessions);
  const spaces = new SpacesService(env, db);
  // Module 14: scanning is wired in but reports NOT_CONFIGURED until a local
  // ClamAV install is present; uploads keep working under the documented policy.
  const malwareScanner = deps.scanner ?? new MalwareScanService(env);
  const backups = new BackupService(env);
  const files = new FilesService(env, db, storageAdapter, spaces, malwareScanner);
  const fileManager = new FileManagerService(env, db, storageAdapter, spaces, files);
  const archive = new ArchiveService(db, storageAdapter, spaces);
  const cleanup = new CleanupService(db, storageAdapter);
  const extensions = new ExtensionService(env, db, spaces);
  const lifecycle = new LifecycleService(env, db, storageAdapter, spaces, archive, cleanup);
  const membership = new MembershipService(env, db, spaces);
  const storage = new StorageService(env, db, spaces);
  const scans = new ScanService(db, storageAdapter, spaces);
  const archivePlans = new ArchivePlanService(db, storageAdapter, spaces, archive);
  const duplicates = new DuplicateService(db, spaces);
  const dashboard = new DashboardService(env, db, spaces, storage);
  const search = new SearchService(db, spaces);
  const spaceManagement = new SpaceManagementService(env, db, storageAdapter, spaces);

  // Module 1: identity is resolved by Supabase when configured, without
  // changing the local development path or any existing service.
  const profiles = new ProfileStore(env);
  const identity: TokenVerifier =
    env.authMode === 'supabase' ? new SupabaseIdentityService(env, db, profiles) : auth;
  const account = new AccountService(env, db, profiles);

  // Module 9: transactional email + hashed tokens.
  const email = new EmailService(db, env.webOrigin, {
    transport: env.emailTransport as 'smtp' | 'mock' ?? 'mock',
    smtpHost: env.smtpHost ?? undefined,
    smtpPort: env.smtpPort ?? undefined,
    smtpUser: env.smtpUser ?? undefined,
    smtpPassword: env.smtpPassword ?? undefined,
    smtpSecure: env.smtpSecure ?? undefined,
    smtpTlsServername: env.smtpTlsServername ?? undefined,
    fromEmail: env.emailFrom ?? 'flashspace@flashspace.local',
    fromName: env.emailFromName ?? 'FlashSpace',
    connectionTimeoutMs: env.emailConnectionTimeoutMs ?? 10_000,
    deliveryTimeoutMs: env.emailDeliveryTimeoutMs ?? 30_000,
    verificationExpiryMs: env.emailVerificationExpiryMs ?? 24 * 60 * 60 * 1000,
    resetExpiryMs: env.emailResetExpiryMs ?? 60 * 60 * 1000,
    invitationExpiryMs: env.emailInvitationExpiryMs ?? 7 * 24 * 60 * 60 * 1000,
    maxRetries: env.emailMaxRetries ?? 3,
    retryBaseDelayMs: env.emailRetryBaseDelayMs ?? 5_000,
    retryMaxDelayMs: env.emailRetryMaxDelayMs ?? 300_000,
  });
  const verificationTokens = new VerificationTokensService(db);
  membership.attachEmail(email);

  // Module 11: the admin service reuses the existing archive runner and the
  // email transport summary, so it never duplicates either subsystem.
  const admin = new AdminService(env, db, { archive, email });

  // Module 12: one read/write surface for activity and audit records.
  const activity = new ActivityService(db, spaces);

  return {
    env,
    db,
    storage: storageAdapter,
    services: {
      auth,
      spaces,
      files,
      archive,
      cleanup,
      extensions,
      lifecycle,
      admin,
      membership,
      storage,
      scans,
      archivePlans,
      duplicates,
      account,
      dashboard,
      search,
      spaceManagement,
      fileManager,
      email,
      verificationTokens,
      activity,
      malwareScanner,
      backups,
    },
    identity,
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  // Trusted-proxy hops are explicit config (TRUST_PROXY). With it unset, a
  // spoofed X-Forwarded-For cannot influence req.ip or req.secure.
  if (ctx.env.trustProxy !== false) app.set('trust proxy', ctx.env.trustProxy);
  app.use(requestContext);
  app.use(securityHeaders(ctx.env));
  app.use(requireHttps(ctx.env));
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      // Credentialed requests are never allowed, and production requires an
      // explicit https origin list (validated in loadEnv). The '*' development
      // wildcard reflects the caller origin for local tooling only.
      origin: ctx.env.webOrigin === '*' ? true : ctx.env.webOrigin.split(',').map((o) => o.trim()),
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
      maxAge: 600,
      optionsSuccessStatus: 204,
    }),
  );

  // Module 14: general rate limiting. Signed storage transfers are excluded so
  // legitimate large file workflows are not throttled by the API budget.
  if (ctx.env.rateLimitEnabled) {
    app.use(
      rateLimit({
        windowMs: ctx.env.rateLimitWindowMs,
        max: ctx.env.rateLimitGeneralMax,
        prefix: 'general',
        key: (req) =>
          req.path === '/health' || req.path.startsWith('/storage-') ? null : clientKey(req),
      }),
    );
  }

  // Local development mail preview. Disabled in production and whenever a real
  // transport is configured, so it can never leak message bodies on a live site.
  app.get(
    '/dev/outbox',
    asyncHandler(async (req: Request, res: Response) => {
      if (ctx.env.nodeEnv === 'production') {
        throw new AppError('NOT_FOUND', 'Not found');
      }
      const transport = ctx.services.email.isMockMode ? 'mock' : 'smtp';
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
      res.json({ transport, messages: transport === 'mock' ? ctx.services.email.listOutbox(limit) : [] });
    }),
  );

  app.get('/health', asyncHandler(async (_req, res) => {
    const scanner = await ctx.services.malwareScanner.status();
    const database = await checkPostgresHealth(ctx.env);
    res.json({
      ok: true,
      service: 'flashspace-api',
      time: new Date().toISOString(),
      database,
      security: {
        rateLimiting: ctx.env.rateLimitEnabled,
        httpsRequired: ctx.env.requireHttps,
        hsts: ctx.env.nodeEnv === 'production',
        malwareScanning: scanner,
      },
    });
  }));

  // Storage endpoints live outside requireAuth: access is via signed tokens.
  app.use(storageRoutes(ctx.env, ctx.storage));

  const { auth, spaces, files, extensions, archive, lifecycle, admin, membership, storage, scans, archivePlans, duplicates, account, dashboard, search, spaceManagement, fileManager, email, verificationTokens, activity } = ctx.services;

  // Module 14: credential endpoints are budgeted per IP *and* per account so
  // neither password guessing nor reset-email flooding scales with IP rotation.
  if (ctx.env.rateLimitEnabled) {
    app.use(
      [
        '/auth/login',
        '/auth/register',
        '/auth/reset-password/request',
        '/auth/reset-password/confirm',
        '/auth/verify-email/request',
      ],
      rateLimit({
        windowMs: ctx.env.rateLimitAuthWindowMs,
        max: ctx.env.rateLimitAuthMax,
        prefix: 'auth',
        key: credentialKey,
        message: 'Too many authentication attempts. Please wait before trying again.',
      }),
      // Independent account budget: an attacker rotating source IPs still
      // cannot exceed the per-email allowance.
      rateLimit({
        windowMs: ctx.env.rateLimitAuthWindowMs,
        max: ctx.env.rateLimitAuthMax,
        prefix: 'auth-account',
        key: credentialAccountKey,
        message: 'Too many authentication attempts. Please wait before trying again.',
      }),
    );
  }

  app.use(authRoutes(auth, ctx.identity, ctx.env, email, verificationTokens));
  // Job runner sits outside Bearer auth — it authenticates with its own secret.
  if (ctx.env.rateLimitEnabled) {
    app.use('/jobs', rateLimit({ windowMs: ctx.env.rateLimitWindowMs, max: 60, prefix: 'jobs', key: (req) => req.ip ?? null }));
  }
  app.use(jobsRoutes(lifecycle));

  // Unauthenticated invite link preview (spec §2.1): must be outside
  // requireAuth so visitors without a session can see the invitation.
  app.get('/join-links/:token/preview', asyncHandler(async (req, res) => {
    const token = req.params.token;
    if (!token) throw new AppError('VALIDATION_ERROR', 'Missing token');
    res.json({ space: await membership.previewInviteLink(null, token) });
  }));

  app.use(requireAuth(ctx.identity));

  // Module 14: per-user budgets for expensive or abuse-prone operations. These
  // run after identity resolution so the key is always the authenticated user,
  // never a client-supplied identifier.
  if (ctx.env.rateLimitEnabled) {
    app.use(
      '/spaces/:spaceId/files',
      rateLimit({ windowMs: ctx.env.rateLimitWindowMs, max: ctx.env.rateLimitUploadMax, prefix: 'upload' }),
    );
    app.use(
      [
        '/spaces/:spaceId/archive',
        '/spaces/:spaceId/scans',
        '/spaces/:spaceId/plans',
        '/plans/:planId/retry',
      ],
      rateLimit({
        windowMs: ctx.env.rateLimitWindowMs,
        max: ctx.env.rateLimitExpensiveMax,
        prefix: 'expensive',
      }),
    );
    app.use(
      ['/spaces/:spaceId/invitations', '/spaces/:spaceId/invite-link'],
      rateLimit({ windowMs: 60 * 60_000, max: ctx.env.rateLimitInviteMax, prefix: 'invite' }),
    );
  }

  app.use(accountRoutes(account, ctx.env));
  app.use(dashboardRoutes(dashboard, search));
  app.use(spaceRoutes(spaces, files, extensions, membership, archive, spaceManagement, fileManager, ctx.env, ctx.db, activity));
  app.use(activityRoutes(activity));
  app.use(scanRoutes(scans, archivePlans, duplicates));
  app.use(miscRoutes(ctx.db, extensions, archive, storage));
  app.use(adminRoutes(admin, activity));

  app.use(errorMiddleware);
  return app;
}

export function buildApp(
  envOverrides: Partial<Env> = {},
  deps: AppDependencies = {},
): { app: Express; ctx: AppContext } {
  const ctx = createAppContext(envOverrides, deps);
  return { app: createApp(ctx), ctx };
}
