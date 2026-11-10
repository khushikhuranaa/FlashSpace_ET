import express, { type Express } from 'express';
import cors from 'cors';
import { loadEnv, type Env } from './config/env.js';
import { createDataLayer, type DataLayer } from './repositories/index.js';
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
import { authRoutes } from './routes/auth.routes.js';
import { spaceRoutes } from './routes/space.routes.js';
import { miscRoutes } from './routes/misc.routes.js';
import { storageRoutes } from './routes/storage.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { jobsRoutes } from './routes/jobs.routes.js';
import { scanRoutes } from './routes/scan.routes.js';
import { requestContext, errorMiddleware } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';

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
  };
}

export function createAppContext(envOverrides: Partial<Env> = {}): AppContext {
  const env = loadEnv(envOverrides);
  const db = createDataLayer(env);
  const storageAdapter = createStorageAdapter(env);

  const auth = new AuthService(env, db.auth);
  const spaces = new SpacesService(env, db);
  const files = new FilesService(env, db, storageAdapter, spaces);
  const archive = new ArchiveService(db, storageAdapter, spaces);
  const cleanup = new CleanupService(db, storageAdapter);
  const extensions = new ExtensionService(env, db, spaces);
  const lifecycle = new LifecycleService(env, db, storageAdapter, spaces, archive, cleanup);
  const admin = new AdminService(env, db, archive);
  const membership = new MembershipService(env, db, spaces);
  const storage = new StorageService(env, db, spaces);
  const scans = new ScanService(db, storageAdapter, spaces);
  const archivePlans = new ArchivePlanService(db, storageAdapter, spaces, archive);
  const duplicates = new DuplicateService(db, spaces);

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
    },
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      origin: ctx.env.webOrigin === '*' ? true : ctx.env.webOrigin.split(','),
      credentials: false,
    }),
  );
  app.use(requestContext);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'flashspace-api', time: new Date().toISOString() });
  });

  // Storage endpoints live outside requireAuth: access is via signed tokens.
  app.use(storageRoutes(ctx.env, ctx.storage));

  const { auth, spaces, files, extensions, archive, lifecycle, admin, membership, storage, scans, archivePlans, duplicates } = ctx.services;
  app.use(authRoutes(auth));
  // Job runner sits outside Bearer auth — it authenticates with its own secret.
  app.use(jobsRoutes(lifecycle));
  app.use(requireAuth(auth));
  app.use(spaceRoutes(spaces, files, extensions, membership, archive));
  app.use(scanRoutes(scans, archivePlans, duplicates));
  app.use(miscRoutes(ctx.db, extensions, archive, storage));
  app.use(adminRoutes(admin));

  app.use(errorMiddleware);
  return app;
}

export function buildApp(envOverrides: Partial<Env> = {}): { app: Express; ctx: AppContext } {
  const ctx = createAppContext(envOverrides);
  return { app: createApp(ctx), ctx };
}
