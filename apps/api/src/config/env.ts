/** Central environment config. Never import process.env directly elsewhere. */

export type AuthMode = 'local' | 'supabase';
/** memory = tests, sqlite = real local database, postgres = cloud deployment. */
export type RepoMode = 'memory' | 'sqlite' | 'postgres';
export type StorageMode = 'local' | 'supabase';
export type ExtensionPolicy = 'ADMIN' | 'AUTO';

export interface Env {
  port: number;
  nodeEnv: string;
  authMode: AuthMode;
  repoMode: RepoMode;
  storageMode: StorageMode;

  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  databaseUrl: string;

  localStorageDir: string;
  /** Path of the SQLite database file used when repoMode is 'sqlite'. */
  sqliteFile: string;
  /** Base URL used to build signed storage URLs (local storage adapter). */
  signedUrlBase: string;
  /** Public URL of the web app, used to build shareable invite links. */
  webAppUrl: string;
  /** CORS origin allowed for the web app. */
  webOrigin: string;

  localAuthSecret: string;
  jobSecret: string;

  fileMaxBytes: number;
  spaceMaxBytes: number;
  maxActiveSpacesPerUser: number;
  maxExtensionDays: number;
  warningWindowHours: number;
  extensionPolicy: ExtensionPolicy;

  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string;
}

/**
 * Values that are convenient for local demos but unsafe anywhere real: with
 * these secrets anyone can forge a session token for any user (including an
 * ADMIN) or trigger the lifecycle job endpoint. Production must override both.
 */
const DEV_AUTH_SECRET = 'dev-only-insecure-secret';
const DEV_JOB_SECRET = 'dev-only-job-secret';

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    port: num(process.env.PORT, 4000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    authMode: (process.env.AUTH_MODE as AuthMode) ?? 'local',
    repoMode: (process.env.REPO_MODE as RepoMode) ?? 'sqlite',
    storageMode: (process.env.STORAGE_MODE as StorageMode) ?? 'local',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? '',
    localStorageDir: process.env.LOCAL_STORAGE_DIR ?? './data/local-storage',
    sqliteFile: process.env.SQLITE_FILE ?? './data/flashspace.db',
    signedUrlBase: process.env.SIGNED_URL_BASE ?? '',
    webOrigin: process.env.WEB_ORIGIN ?? '*',
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:5173',
    localAuthSecret: process.env.LOCAL_AUTH_SECRET ?? DEV_AUTH_SECRET,
    jobSecret: process.env.JOB_SECRET ?? DEV_JOB_SECRET,
    fileMaxBytes: num(process.env.FILE_MAX_BYTES, 50 * 1024 * 1024),
    spaceMaxBytes: num(process.env.SPACE_MAX_BYTES, 250 * 1024 * 1024),
    maxActiveSpacesPerUser: num(process.env.MAX_ACTIVE_SPACES_PER_USER, 20),
    maxExtensionDays: num(process.env.MAX_EXTENSION_DAYS, 14),
    warningWindowHours: num(process.env.WARNING_WINDOW_HOURS, 24),
    extensionPolicy: (process.env.EXTENSION_POLICY as ExtensionPolicy) ?? 'ADMIN',
    smtpHost: process.env.SMTP_HOST || null,
    smtpPort: num(process.env.SMTP_PORT, 1025),
    smtpUser: process.env.SMTP_USER || null,
    smtpPassword: process.env.SMTP_PASSWORD || null,
    smtpFrom: process.env.SMTP_FROM ?? 'flashspace@localhost',
    ...overrides,
  };

  // Fail fast instead of silently shipping forgeable credentials. The old
  // behaviour booted a "production" API that accepted tokens signed with a
  // publicly known string.
  if (env.nodeEnv === 'production') {
    if (!env.localAuthSecret || env.localAuthSecret === DEV_AUTH_SECRET) {
      throw new Error(
        'LOCAL_AUTH_SECRET must be set to a strong random value when NODE_ENV=production',
      );
    }
    if (!env.jobSecret || env.jobSecret === DEV_JOB_SECRET) {
      throw new Error('JOB_SECRET must be set to a strong random value when NODE_ENV=production');
    }
    if (env.webOrigin === '*') {
      throw new Error('WEB_ORIGIN must list the web app origin(s) when NODE_ENV=production');
    }
  }

  return env;
}
