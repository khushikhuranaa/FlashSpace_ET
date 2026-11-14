/** Central environment config. Never import process.env directly elsewhere. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` files into process.env without overriding values the platform,
 * the shell or the test runner already set.
 *
 * The repo documents `apps/api/.env`, but Node only reads env files with an
 * explicit `--env-file` flag, so local runs previously ignored the file and
 * silently fell back to defaults. Platform-provided variables always win, and
 * tests stay hermetic because Vitest sets VITEST.
 */
function loadEnvFiles(): void {
  if (process.env.VITEST) return;
  // src/config and dist/config are both two levels below apps/api.
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    resolve(appRoot, '.env.local'),
    resolve(appRoot, '.env'),
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '.env'),
  ];
  for (const file of new Set(files)) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      let value = match[2] ?? '';
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted) {
        value = value.slice(1, -1);
      } else {
        const comment = value.search(/\s#/);
        if (comment >= 0) value = value.slice(0, comment);
        value = value.trim();
      }
      // Earlier files (and real environment variables) take precedence.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnvFiles();

export type AuthMode = 'local' | 'supabase';
/** memory = tests, sqlite = real local database, postgres = cloud deployment. */
export type RepoMode = 'memory' | 'sqlite' | 'postgres';
export type StorageMode = 'local' | 'supabase';
export type ExtensionPolicy = 'ADMIN' | 'AUTO';

export interface Env {
  port: number;
  nodeEnv: string;
  /** Apply pending Postgres migrations during boot (Render/single-instance). */
  runMigrationsOnBoot: boolean;
  authMode: AuthMode;
  repoMode: RepoMode;
  storageMode: StorageMode;

  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  /**
   * Legacy shared HS256 secret (Project Settings → API → JWT Secret). Only
   * needed for projects that have not moved to asymmetric signing keys; the
   * default path verifies tokens against the project's public JWKS.
   */
  supabaseJwtSecret: string;
  databaseUrl: string;
  /** Postgres pool size (PG_POOL_MAX, default 10). */
  pgPoolMax: number;
  /** Time to wait for a pooled connection before failing (PG_CONNECT_TIMEOUT_MS). */
  pgConnectTimeoutMs: number;
  /** Close idle clients after this long (PG_IDLE_TIMEOUT_MS). */
  pgIdleTimeoutMs: number;
  /** Server-side statement timeout (PG_STATEMENT_TIMEOUT_MS). */
  pgStatementTimeoutMs: number;

  /** Private Storage bucket holding profile pictures. */
  avatarsBucket: string;
  /** Private bucket for temporary Space files (Module 15). */
  supabaseFilesBucket: string;
  /** Private bucket for permanent Vault archives. */
  supabaseVaultBucket: string;
  /** Private bucket for in-flight archive ZIPs. */
  supabaseTempBucket: string;
  /** Maximum accepted avatar size in bytes (mirrored by the bucket limit). */
  maxAvatarBytes: number;

  localStorageDir: string;
  /** Path of the SQLite database file used when repoMode is 'sqlite'. */
  sqliteFile: string;
  /** Base URL used to build signed storage URLs (local storage adapter). */
  signedUrlBase: string;
  /** Public URL of the web app, used to build shareable invite links. */
  webAppUrl: string;
  /** CORS origin allowed for the web app. */
  webOrigin: string;

  /** Express `trust proxy` value: number of trusted hops, or false. */
  trustProxy: number | false;
  /** Redirect plain HTTP to HTTPS (defaults on in production). */
  requireHttps: boolean;
  /** HSTS max-age in seconds (only sent on secure requests in production). */
  hstsMaxAgeSeconds: number;

  // Module 14: rate limiting.
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitGeneralMax: number;
  rateLimitAuthWindowMs: number;
  rateLimitAuthMax: number;
  rateLimitUploadMax: number;
  rateLimitExpensiveMax: number;
  rateLimitInviteMax: number;

  // Module 14: malware scanning (provider-independent; NOT_CONFIGURED by default).
  malwareScanPolicy: 'off' | 'advisory' | 'enforce';
  malwareScanMaxBytes: number;

  // Module 14: local backups.
  backupDir: string;
  backupRetention: number;

  localAuthSecret: string;
  jobSecret: string;

  fileMaxBytes: number;
  spaceMaxBytes: number;
  /** Extensions rejected at upload time (executables, installers, scripts). */
  uploadBlockedExtensions: string[];
  maxActiveSpacesPerUser: number;
  maxExtensionDays: number;
  warningWindowHours: number;
  extensionPolicy: ExtensionPolicy;

  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string;

  // Module 9: email delivery config.
  emailTransport: 'smtp' | 'mock' | null;
  smtpSecure: boolean;
  smtpTlsServername: string | null;
  emailFrom: string;
  emailFromName: string;
  emailConnectionTimeoutMs: number;
  emailDeliveryTimeoutMs: number;
  emailVerificationExpiryMs: number;
  emailResetExpiryMs: number;
  emailInvitationExpiryMs: number;
  emailMaxRetries: number;
  emailRetryBaseDelayMs: number;
  emailRetryMaxDelayMs: number;

  // Module 9: feature flags (default on in local mode, off when delegating to
  // an external auth provider that already sends these emails).
  emailVerificationMode: boolean;
  passwordResetMode: boolean;
}

/**
 * Values that are convenient for local demos but unsafe anywhere real: with
 * these secrets anyone can forge a session token for any user (including an
 * ADMIN) or trigger the lifecycle job endpoint. Production must override both.
 */
const DEV_AUTH_SECRET = 'dev-only-insecure-secret';
const DEV_JOB_SECRET = 'dev-only-job-secret';

/** Placeholder fragments that must never reach production. */
const PLACEHOLDER_SECRET = /(dev-only|insecure|change-?me|placeholder|example|your-?secret|password|test-secret|sample)/i;

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function trustProxy(v: string | undefined): number | false {
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return 1;
  const hops = Number(v);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}

/**
 * A production secret must be long enough to resist offline guessing and must
 * not be a human-readable placeholder. Rejecting weak values here is what stops
 * a "production" boot that signs forgeable admin tokens.
 */
export function assertStrongSecret(name: string, value: string): void {
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters when NODE_ENV=production`);
  }
  if (PLACEHOLDER_SECRET.test(value)) {
    throw new Error(`${name} looks like a placeholder value; generate a random secret`);
  }
  if (new Set(value).size < 8) {
    throw new Error(`${name} has too little entropy; generate a random secret`);
  }
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isTest = nodeEnv === 'test';
  const env: Env = {
    port: num(process.env.PORT, 4000),
    nodeEnv,
    runMigrationsOnBoot: bool(process.env.RUN_MIGRATIONS_ON_BOOT, false),
    authMode: (process.env.AUTH_MODE as AuthMode) ?? 'local',
    repoMode: (process.env.REPO_MODE as RepoMode) ?? 'sqlite',
    storageMode: (process.env.STORAGE_MODE as StorageMode) ?? 'local',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
    databaseUrl: process.env.DATABASE_URL ?? '',
    pgPoolMax: num(process.env.PG_POOL_MAX, 10),
    pgConnectTimeoutMs: num(process.env.PG_CONNECT_TIMEOUT_MS, 5_000),
    pgIdleTimeoutMs: num(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
    pgStatementTimeoutMs: num(process.env.PG_STATEMENT_TIMEOUT_MS, 30_000),
    avatarsBucket: process.env.AVATARS_BUCKET ?? 'avatars',
    supabaseFilesBucket: process.env.SUPABASE_FILES_BUCKET ?? 'space-files',
    supabaseVaultBucket: process.env.SUPABASE_VAULT_BUCKET ?? 'vault-archives',
    supabaseTempBucket: process.env.SUPABASE_TEMP_BUCKET ?? 'archive-temp',
    maxAvatarBytes: num(process.env.MAX_AVATAR_BYTES, 2 * 1024 * 1024),
    localStorageDir: process.env.LOCAL_STORAGE_DIR ?? './data/local-storage',
    sqliteFile: process.env.SQLITE_FILE ?? './data/flashspace.db',
    signedUrlBase: process.env.SIGNED_URL_BASE ?? '',
    webOrigin: process.env.WEB_ORIGIN ?? '*',
    trustProxy: trustProxy(process.env.TRUST_PROXY),
    requireHttps: bool(process.env.REQUIRE_HTTPS, nodeEnv === 'production'),
    hstsMaxAgeSeconds: num(process.env.HSTS_MAX_AGE_SECONDS, 15_552_000),

    // Limits are generous in the test environment so parallel suites are not
    // throttled; the limiter itself stays enabled and individual tests pass
    // explicit overrides to prove enforcement.
    rateLimitEnabled: bool(process.env.RATE_LIMIT_ENABLED, true),
    rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitGeneralMax: num(process.env.RATE_LIMIT_GENERAL_MAX, isTest ? 100_000 : 300),
    rateLimitAuthWindowMs: num(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60_000),
    rateLimitAuthMax: num(process.env.RATE_LIMIT_AUTH_MAX, isTest ? 100_000 : 20),
    rateLimitUploadMax: num(process.env.RATE_LIMIT_UPLOAD_MAX, isTest ? 100_000 : 60),
    rateLimitExpensiveMax: num(process.env.RATE_LIMIT_EXPENSIVE_MAX, isTest ? 100_000 : 30),
    rateLimitInviteMax: num(process.env.RATE_LIMIT_INVITE_MAX, isTest ? 100_000 : 30),

    malwareScanPolicy:
      (process.env.MALWARE_SCAN_POLICY as 'off' | 'advisory' | 'enforce' | undefined) ?? 'advisory',
    malwareScanMaxBytes: num(process.env.MALWARE_SCAN_MAX_BYTES, 25 * 1024 * 1024),

    backupDir: process.env.BACKUP_DIR ?? './data/backups',
    backupRetention: num(process.env.BACKUP_RETENTION, 7),
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:5173',
    localAuthSecret: process.env.LOCAL_AUTH_SECRET ?? DEV_AUTH_SECRET,
    jobSecret: process.env.JOB_SECRET ?? DEV_JOB_SECRET,
    fileMaxBytes: num(process.env.FILE_MAX_BYTES, 50 * 1024 * 1024),
    spaceMaxBytes: num(process.env.SPACE_MAX_BYTES, 250 * 1024 * 1024),
    uploadBlockedExtensions: (
      process.env.UPLOAD_BLOCKED_EXTENSIONS ??
      'exe,dll,com,scr,msi,msix,bat,cmd,ps1,psm1,vbs,vbe,wsf,wsh,jar,apk,app,dmg,iso,pkg,deb,rpm,sh,bash,zsh,csh'
    )
      .split(',')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean),
    maxActiveSpacesPerUser: num(process.env.MAX_ACTIVE_SPACES_PER_USER, 20),
    maxExtensionDays: num(process.env.MAX_EXTENSION_DAYS, 14),
    warningWindowHours: num(process.env.WARNING_WINDOW_HOURS, 24),
    extensionPolicy: (process.env.EXTENSION_POLICY as ExtensionPolicy) ?? 'ADMIN',
    smtpHost: process.env.SMTP_HOST || null,
    smtpPort: num(process.env.SMTP_PORT, 1025),
    smtpUser: process.env.SMTP_USER || null,
    smtpPassword: process.env.SMTP_PASSWORD || null,
    smtpFrom: process.env.SMTP_FROM ?? 'flashspace@localhost',

    // Module 9: email delivery config (defaults to mock mode).
    emailTransport: (process.env.EMAIL_TRANSPORT as 'smtp' | 'mock' | null) ?? 'mock',
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpTlsServername: process.env.SMTP_TLS_SERVERNAME || null,
    emailFrom: process.env.EMAIL_FROM ?? 'flashspace@flashspace.local',
    emailFromName: process.env.EMAIL_FROM_NAME ?? 'FlashSpace',
    emailConnectionTimeoutMs: num(process.env.EMAIL_CONNECTION_TIMEOUT_MS, 10_000),
    emailDeliveryTimeoutMs: num(process.env.EMAIL_DELIVERY_TIMEOUT_MS, 30_000),
    emailVerificationExpiryMs: num(process.env.EMAIL_VERIFICATION_EXPIRY_MS, 24 * 60 * 60 * 1000),
    emailResetExpiryMs: num(process.env.EMAIL_RESET_EXPIRY_MS, 60 * 60 * 1000),
    emailInvitationExpiryMs: num(process.env.EMAIL_INVITATION_EXPIRY_MS, 7 * 24 * 60 * 60 * 1000),
    emailMaxRetries: num(process.env.EMAIL_MAX_RETRIES, 3),
    emailRetryBaseDelayMs: num(process.env.EMAIL_RETRY_BASE_DELAY_MS, 5_000),
    emailRetryMaxDelayMs: num(process.env.EMAIL_RETRY_MAX_DELAY_MS, 300_000),
    emailVerificationMode: process.env.EMAIL_VERIFICATION_MODE !== 'false',
    passwordResetMode: process.env.PASSWORD_RESET_MODE !== 'false',
    ...overrides,
  };

  // `requireHttps` must follow the *effective* NODE_ENV (including overrides),
  // not just the process environment, so production boots in redirect mode by
  // default while tests can opt out explicitly.
  if (overrides.requireHttps === undefined && process.env.REQUIRE_HTTPS === undefined) {
    env.requireHttps = env.nodeEnv === 'production';
  }

  // Supabase mode cannot work half-configured: the API needs the project URL to
  // resolve JWKS, the anon key for user-scoped calls and the service-role key
  // for profile administration. Report it at boot instead of at first request.
  if (env.authMode === 'supabase') {
    const missing = [
      !env.supabaseUrl && 'SUPABASE_URL',
      !env.supabaseAnonKey && 'SUPABASE_ANON_KEY',
      !env.supabaseServiceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`AUTH_MODE=supabase requires ${missing.join(', ')} on the API`);
    }
  }

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
    assertStrongSecret('LOCAL_AUTH_SECRET', env.localAuthSecret);
    assertStrongSecret('JOB_SECRET', env.jobSecret);
    if (env.localAuthSecret === env.jobSecret) {
      throw new Error('LOCAL_AUTH_SECRET and JOB_SECRET must be different values in production');
    }
    if (env.webOrigin === '*') {
      throw new Error('WEB_ORIGIN must list the web app origin(s) when NODE_ENV=production');
    }
    const insecureOrigins = env.webOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .filter((origin) => !/^https:\/\//i.test(origin) && !/^http:\/\/localhost(?::\d+)?$/i.test(origin));
    if (insecureOrigins.length) {
      throw new Error(
        `WEB_ORIGIN must use https:// in production (offending: ${insecureOrigins.join(', ')})`,
      );
    }
  }

  // Production must not persist to a single-file SQLite database by accident: the
  // file is lost on redeploy and cannot be shared between instances. A deliberate
  // single-instance deployment may opt in explicitly.
  if (
    env.nodeEnv === 'production' &&
    env.repoMode === 'sqlite' &&
    process.env.ALLOW_SQLITE_IN_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'REPO_MODE=sqlite is the local development database; set REPO_MODE=postgres for production ' +
        '(or ALLOW_SQLITE_IN_PRODUCTION=true for a deliberate single-instance deployment)',
    );
  }

  // The Postgres layer needs a connection string; failing at boot beats failing
  // on the first request.
  if (env.repoMode === 'postgres' && !env.databaseUrl) {
    throw new Error('REPO_MODE=postgres requires DATABASE_URL');
  }

  if (!['off', 'advisory', 'enforce'].includes(env.malwareScanPolicy)) {
    throw new Error('MALWARE_SCAN_POLICY must be one of off, advisory, enforce');
  }

  return env;
}
