import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type AppDependencies } from '../src/app.js';
import { assertStrongSecret, loadEnv, type Env } from '../src/config/env.js';
import { hashPassword, needsRehash, verifyPassword } from '../src/utils/password.js';
import { signJwt, verifyJwt } from '../src/utils/jwt.js';
import { redact, redactError, redactString } from '../src/utils/redact.js';
import { defaultRateLimitStore } from '../src/middleware/rate-limit.js';
import { signStorageToken } from '../src/storage/signed-tokens.js';
import { MalwareScanService, type MalwareScanner } from '../src/services/malware-scan.service.js';
import { BackupService } from '../src/services/backup.service.js';

/**
 * Module 14 — security & production hardening.
 *
 * Everything here runs against the real Express app with the in-memory
 * repository and a temporary storage directory, so these are behavioural tests,
 * not mocks of the code under test. The only injected seam is the malware
 * scanner (no ClamAV install is assumed).
 */

const tempDirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flashspace-sec-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const strongSecret = (): string => randomBytes(24).toString('hex');

function prodEnv(overrides: Partial<Env> = {}): Partial<Env> {
  return {
    nodeEnv: 'production',
    webOrigin: 'https://app.flashspace.test',
    localAuthSecret: strongSecret(),
    jobSecret: strongSecret(),
    requireHttps: false,
    ...overrides,
  };
}

let counter = 0;
const uniqueEmail = (): string => `sec${++counter}.${Date.now()}@flashspace.test`;

async function makeApp(overrides: Partial<Env> = {}, deps: AppDependencies = {}): Promise<{
  app: Express;
  ctx: ReturnType<typeof buildApp>['ctx'];
}> {
  defaultRateLimitStore.reset();
  const localStorageDir = overrides.localStorageDir ?? (await tmpDir('storage'));
  return buildApp(
    {
      repoMode: 'memory',
      authMode: 'local',
      nodeEnv: 'test',
      webOrigin: '*',
      localStorageDir,
      ...overrides,
    },
    deps,
  );
}

interface Actor {
  token: string;
  id: string;
}

async function register(app: Express, email = uniqueEmail()): Promise<Actor> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'password123', displayName: 'Security Tester' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function createSpace(app: Express, actor: Actor): Promise<string> {
  const now = Date.now();
  const res = await request(app)
    .post('/spaces')
    .set(auth(actor))
    .send({
      name: 'Security Space',
      purpose: 'Project Collaboration',
      startAt: new Date(now - 60_000).toISOString(),
      expiryAt: new Date(now + 86_400_000).toISOString(),
    });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

async function uploadFile(
  app: Express,
  actor: Actor,
  spaceId: string,
  content = Buffer.from('hello security'),
): Promise<{ status: number; fileId: string; body: Record<string, unknown> }> {
  const init = await request(app)
    .post(`/spaces/${spaceId}/files/init-upload`)
    .set(auth(actor))
    .send({ name: 'notes.txt', mimeType: 'text/plain', sizeBytes: content.length });
  expect(init.status).toBe(201);
  const put = await request(app).put(init.body.url as string).send(content);
  expect(put.status).toBe(200);
  const confirm = await request(app)
    .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
    .set(auth(actor));
  return { status: confirm.status, fileId: init.body.fileId as string, body: confirm.body };
}

// ---------------------------------------------------------------------------
// 14.1 Production secrets & environment validation
// ---------------------------------------------------------------------------

describe('production secret validation', () => {
  it('refuses to boot without LOCAL_AUTH_SECRET', () => {
    expect(() => loadEnv(prodEnv({ localAuthSecret: '' }))).toThrow(/LOCAL_AUTH_SECRET/);
  });

  it('rejects the development default secret', () => {
    expect(() => loadEnv(prodEnv({ localAuthSecret: 'dev-only-insecure-secret' }))).toThrow(
      /LOCAL_AUTH_SECRET/,
    );
  });

  it('rejects short secrets', () => {
    expect(() => loadEnv(prodEnv({ localAuthSecret: 'short-secret-value' }))).toThrow(/32 characters/);
  });

  it('rejects placeholder and low-entropy secrets', () => {
    expect(() => loadEnv(prodEnv({ localAuthSecret: 'change-me-please-'.repeat(3) }))).toThrow(
      /placeholder|entropy/,
    );
    expect(() => loadEnv(prodEnv({ localAuthSecret: 'a'.repeat(40) }))).toThrow(/entropy/);
    expect(() => assertStrongSecret('JOB_SECRET', 'example-secret-value-for-docs-1234')).toThrow(
      /placeholder/,
    );
  });

  it('rejects reusing one secret for auth and jobs', () => {
    const shared = strongSecret();
    expect(() => loadEnv(prodEnv({ localAuthSecret: shared, jobSecret: shared }))).toThrow(
      /must be different/,
    );
  });

  it('rejects wildcard CORS and non-https origins in production', () => {
    expect(() => loadEnv(prodEnv({ webOrigin: '*' }))).toThrow(/WEB_ORIGIN/);
    expect(() => loadEnv(prodEnv({ webOrigin: 'http://app.flashspace.test' }))).toThrow(/https/);
  });

  it('accepts strong, distinct secrets with an https origin', () => {
    const env = loadEnv({
      nodeEnv: 'production',
      // A valid production config persists to Postgres; SQLite is rejected.
      repoMode: 'postgres',
      databaseUrl: 'postgres://user:pass@db.flashspace.test:5432/flashspace',
      webOrigin: 'https://app.flashspace.test',
      localAuthSecret: strongSecret(),
      jobSecret: strongSecret(),
    });
    expect(env.nodeEnv).toBe('production');
    expect(env.requireHttps).toBe(true);
    expect(env.localAuthSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('refuses to run production on the local SQLite file', () => {
    expect(() =>
      loadEnv({
        nodeEnv: 'production',
        repoMode: 'sqlite',
        webOrigin: 'https://app.flashspace.test',
        localAuthSecret: strongSecret(),
        jobSecret: strongSecret(),
      }),
    ).toThrow(/REPO_MODE=sqlite/);
  });

  it('rejects REPO_MODE=postgres without a DATABASE_URL', () => {
    expect(() => loadEnv({ repoMode: 'postgres', databaseUrl: '' })).toThrow(/DATABASE_URL/);
  });

  it('keeps development defaults usable outside production', () => {
    const env = loadEnv({ nodeEnv: 'development' });
    expect(env.localAuthSecret).toBe('dev-only-insecure-secret');
    expect(env.requireHttps).toBe(false);
  });

  it('rejects an unknown malware scan policy', () => {
    expect(() => loadEnv({ malwareScanPolicy: 'maybe' as Env['malwareScanPolicy'] })).toThrow(
      /MALWARE_SCAN_POLICY/,
    );
  });
});

// ---------------------------------------------------------------------------
// 14.2 Password hashing
// ---------------------------------------------------------------------------

describe('password hashing', () => {
  it('stores a versioned scrypt hash with a unique salt, never plaintext', () => {
    const a = hashPassword('correct horse battery staple');
    const b = hashPassword('correct horse battery staple');
    expect(a).not.toContain('correct horse');
    expect(a.startsWith('scrypt$v2$')).toBe(true);
    expect(a).not.toBe(b); // unique salt per hash
  });

  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('s3cret-password');
    expect(verifyPassword('s3cret-password', stored)).toBe(true);
    expect(verifyPassword('s3cret-password ', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('still verifies legacy scrypt hashes and flags them for rehash', () => {
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('legacy-pass', salt, 64).toString('hex')}`;
    expect(verifyPassword('legacy-pass', legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(hashPassword('legacy-pass'))).toBe(false);
  });

  it('rejects malformed or tampered hash records', () => {
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'scrypt$v2$999999999$8$1$aa$bb')).toBe(false);
    expect(verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
  });

  it('upgrades a legacy hash transparently on successful login', async () => {
    const { app, ctx } = await makeApp();
    const actor = await register(app);
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('password123', salt, 64).toString('hex')}`;
    await ctx.db.auth.setPasswordHash(actor.id, legacy);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: (await ctx.db.auth.findById(actor.id))!.email, password: 'password123' });
    expect(login.status).toBe(200);

    const stored = await ctx.db.auth.getCredentials(actor.id);
    expect(stored?.passwordHash.startsWith('scrypt$v2$')).toBe(true);
    expect(needsRehash(stored!.passwordHash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14.3 JWT verification
// ---------------------------------------------------------------------------

const JWT_TEST_SECRET = 'jwt-security-test-secret-value-123456';

/** Build an arbitrary token so header/payload checks can be exercised. */
function forge(
  payload: Record<string, unknown>,
  secret: string,
  algorithm = 'HS256',
  header: Record<string, unknown> = { alg: algorithm, typ: 'JWT' },
): string {
  const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
  const encodedHeader = b64(JSON.stringify(header));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${encodedHeader}.${body}`).digest('base64url');
  return `${encodedHeader}.${body}.${sig}`;
}

describe('JWT verification', () => {
  it('accepts a freshly signed token', () => {
    const token = signJwt({ sub: 'user-1', email: 'a@b.test' }, JWT_TEST_SECRET, 60);
    const payload = verifyJwt(token, JWT_TEST_SECRET);
    expect(payload?.sub).toBe('user-1');
  });

  it('rejects a tampered signature and a tampered payload', () => {
    const token = signJwt({ sub: 'user-1', email: 'a@b.test' }, JWT_TEST_SECRET, 60);
    const [h, c, s] = token.split('.') as [string, string, string];
    expect(verifyJwt(`${h}.${c}.${s.slice(0, -2)}xx`, JWT_TEST_SECRET)).toBeNull();
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.sub = 'admin-1';
    const forgedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(verifyJwt(`${h}.${forgedClaims}.${s}`, JWT_TEST_SECRET)).toBeNull();
  });

  it('rejects tokens whose header does not pin HS256', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = forge({ sub: 'user-1', iat: now, exp: now + 60 }, JWT_TEST_SECRET, 'none');
    expect(verifyJwt(token, JWT_TEST_SECRET)).toBeNull();
  });

  it('rejects expired tokens and tokens from the future', () => {
    const expired = signJwt({ sub: 'user-1', email: 'a@b.test' }, JWT_TEST_SECRET, -10);
    expect(verifyJwt(expired, JWT_TEST_SECRET)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const future = forge({ sub: 'user-1', iat: now + 3_600, exp: now + 7_200 }, JWT_TEST_SECRET);
    expect(verifyJwt(future, JWT_TEST_SECRET)).toBeNull();
  });

  it('rejects tokens without a subject and malformed tokens', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyJwt(forge({ iat: now, exp: now + 60 }, JWT_TEST_SECRET), JWT_TEST_SECRET)).toBeNull();
    expect(verifyJwt('not-a-jwt', JWT_TEST_SECRET)).toBeNull();
    expect(verifyJwt(`${'a'.repeat(9000)}.b.c`, JWT_TEST_SECRET)).toBeNull();
  });

  it('enforces issuer and audience when configured', () => {
    const token = signJwt({ sub: 'user-1', email: 'a@b.test' }, JWT_TEST_SECRET, 60, {
      iss: 'https://issuer.test',
      aud: 'flashspace',
    });
    expect(verifyJwt(token, JWT_TEST_SECRET, { issuer: 'https://issuer.test', audience: 'flashspace' })).not.toBeNull();
    expect(verifyJwt(token, JWT_TEST_SECRET, { issuer: 'https://other.test' })).toBeNull();
    expect(verifyJwt(token, JWT_TEST_SECRET, { audience: 'other' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14.4 Rate limiting
// ---------------------------------------------------------------------------

describe('authentication rate limiting', () => {
  it('throttles repeated login attempts and returns Retry-After', async () => {
    const { app } = await makeApp({ rateLimitAuthMax: 2, rateLimitAuthWindowMs: 60_000 });
    const email = uniqueEmail();

    const first = await request(app).post('/auth/login').send({ email, password: 'wrong-password' });
    const second = await request(app).post('/auth/login').send({ email, password: 'wrong-password' });
    const third = await request(app).post('/auth/login').send({ email, password: 'wrong-password' });

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(third.headers['ratelimit-limit']).toBe('2');
  });

  it('enforces the account budget when the source IP rotates', async () => {
    const { app } = await makeApp({ rateLimitAuthMax: 2, trustProxy: 1 });
    const email = uniqueEmail();
    const attempt = (ip: string) =>
      request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong-password' });

    expect((await attempt('198.51.100.1')).status).toBe(401);
    expect((await attempt('198.51.100.2')).status).toBe(401);
    const third = await attempt('198.51.100.3');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('throttles password reset requests per account', async () => {
    const { app } = await makeApp({ rateLimitAuthMax: 2 });
    const email = uniqueEmail();
    expect((await request(app).post('/auth/reset-password/request').send({ email })).status).toBe(200);
    expect((await request(app).post('/auth/reset-password/request').send({ email })).status).toBe(200);
    const limited = await request(app).post('/auth/reset-password/request').send({ email });
    expect(limited.status).toBe(429);
  });

  it('reports rate-limit state on ordinary requests', async () => {
    const { app } = await makeApp({ rateLimitGeneralMax: 1_000 });
    const res = await request(app).get('/auth/config');
    expect(res.headers['ratelimit-limit']).toBe('1000');
    expect(Number(res.headers['ratelimit-remaining'])).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// 14.5 / 14.6 Headers, CORS, HTTPS
// ---------------------------------------------------------------------------

describe('security headers, CORS and HTTPS', () => {
  it('sets hardening headers on every API response', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    // No HSTS on plain HTTP.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS only when the request is actually secure', async () => {
    const { app } = await makeApp({ ...prodEnv({ trustProxy: 1, requireHttps: false }) });
    const secure = await request(app).get('/health').set('X-Forwarded-Proto', 'https');
    expect(secure.headers['strict-transport-security']).toContain('max-age=');
  });

  it('redirects plain HTTP to HTTPS in production but not for health checks', async () => {
    const { app } = await makeApp({ ...prodEnv({ requireHttps: true, trustProxy: false }) });
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    const redirect = await request(app).get('/auth/config');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toMatch(/^https:\/\//);
  });

  it('allows only configured CORS origins and supports preflight', async () => {
    const origin = 'https://app.flashspace.test';
    const { app } = await makeApp({ webOrigin: origin });
    const allowed = await request(app).get('/health').set('Origin', origin);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);

    const denied = await request(app).get('/health').set('Origin', 'https://evil.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await request(app)
      .options('/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(preflight.status).toBe(204);
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
  });
});

// ---------------------------------------------------------------------------
// 14.7 Zod request validation
// ---------------------------------------------------------------------------

describe('request validation', () => {
  let app: Express;
  let ctx: ReturnType<typeof buildApp>['ctx'];

  beforeEach(async () => {
    ({ app, ctx } = await makeApp());
  });

  it('rejects malformed emails and unknown registration fields', async () => {
    const bad = await request(app)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const extra = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail(), password: 'password123', role: 'ADMIN' });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body.error.details)).toContain('role');
  });

  it('enforces password length and required fields', async () => {
    const short = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail(), password: 'short' });
    expect(short.status).toBe(400);
    expect((await request(app).post('/auth/login').send({ email: uniqueEmail() })).status).toBe(400);
  });

  it('bounds free-text lengths', async () => {
    const longName = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail(), password: 'password123', displayName: 'x'.repeat(200) });
    expect(longName.status).toBe(400);

    const actor = await register(app);
    const longDescription = await request(app)
      .post('/spaces')
      .set(auth(actor))
      .send({
        name: 'Space',
        purpose: 'Purpose',
        description: 'x'.repeat(5_000),
        startAt: new Date().toISOString(),
        expiryAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(longDescription.status).toBe(400);
  });

  it('validates datetimes, enums and numeric ranges', async () => {
    const actor = await register(app);
    const badDates = await request(app)
      .post('/spaces')
      .set(auth(actor))
      .send({ name: 'S', purpose: 'P', startAt: 'nope', expiryAt: 'nope' });
    expect(badDates.status).toBe(400);

    const spaceId = await createSpace(app, actor);
    const badRole = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set(auth(actor))
      .send({ email: 'invitee@flashspace.test', role: 'OWNER' });
    expect(badRole.status).toBe(400);

    const badSize = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set(auth(actor))
      .send({ name: 'x.txt', mimeType: 'text/plain', sizeBytes: -5 });
    expect(badSize.status).toBe(400);
    expect(ctx.env.repoMode).toBe('memory');
  });
});

// ---------------------------------------------------------------------------
// 14.8 / 14.9 File & signed-URL security
// ---------------------------------------------------------------------------

describe('file and storage security', () => {
  it('rejects an oversized upload body before buffering it all', async () => {
    const { app, ctx } = await makeApp({ fileMaxBytes: 1_024 });
    const signed = await ctx.storage.createSignedUploadUrl('spaces/s/oversize.bin', 900);
    const res = await request(app).put(new URL(signed.url, 'http://localhost').pathname + '?' + new URL(signed.url, 'http://localhost').searchParams.toString()).send(Buffer.alloc(8_192, 1));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    await expect(ctx.storage.headObject('spaces/s/oversize.bin')).rejects.toBeTruthy();
  });

  it('requires a valid, unexpired GET token for downloads', async () => {
    const { app, ctx } = await makeApp();
    expect((await request(app).get('/storage-download')).status).toBe(401);

    const expired = signStorageToken({ method: 'GET', key: 'spaces/a/x.txt', expiresInSeconds: -5 }, ctx.env.localAuthSecret);
    expect((await request(app).get(`/storage-download?token=${encodeURIComponent(expired.token)}`)).status).toBe(401);

    const putToken = signStorageToken({ method: 'PUT', key: 'spaces/a/x.txt', expiresInSeconds: 60 }, ctx.env.localAuthSecret);
    // A PUT token must never authorise a read.
    expect((await request(app).get(`/storage-download?token=${encodeURIComponent(putToken.token)}`)).status).toBe(401);
  });

  it('neutralises path traversal in object keys', async () => {
    const { ctx } = await makeApp();
    const root = path.resolve(ctx.env.localStorageDir);
    await ctx.storage.putObject('../../etc/passwd', Buffer.from('not really'));
    const inside = await fs.stat(path.join(root, 'etc', 'passwd'));
    expect(inside.isFile()).toBe(true);
    const outside = path.join(root, '..', '..', 'etc', 'passwd');
    await expect(fs.stat(outside)).rejects.toBeTruthy();
  });

  it('prevents cross-Space downloads', async () => {
    const { app } = await makeApp();
    const owner = await register(app);
    const outsider = await register(app);
    const spaceId = await createSpace(app, owner);
    const uploaded = await uploadFile(app, owner, spaceId);
    expect(uploaded.status).toBe(200);

    const stolen = await request(app)
      .post(`/spaces/${spaceId}/files/${uploaded.fileId}/download`)
      .set(auth(outsider));
    expect([403, 404]).toContain(stolen.status);
  });

  it('validates MIME signatures against the stored bytes', async () => {
    const { app } = await makeApp();
    const actor = await register(app);
    const spaceId = await createSpace(app, actor);
    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set(auth(actor))
      .send({ name: 'image.png', mimeType: 'image/png', sizeBytes: 9 });
    expect(init.status).toBe(201);
    await request(app).put(init.body.url as string).send(Buffer.from('not-a-png'));
    const confirm = await request(app)
      .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
      .set(auth(actor));
    expect(confirm.status).toBe(400);
    expect(confirm.body.error.code).toBe('MIME_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// 14.10 SQL injection / query allowlists
// ---------------------------------------------------------------------------

describe('query hardening', () => {
  it('rejects unknown sort columns instead of interpolating them', async () => {
    const { app } = await makeApp();
    const actor = await register(app);
    const res = await request(app)
      .get('/spaces?sort=' + encodeURIComponent('name; DROP TABLE spaces'))
      .set(auth(actor));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // The table is intact and the account still works.
    expect((await request(app).get('/spaces').set(auth(actor))).status).toBe(200);
  });

  it('bounds pagination input', async () => {
    const { app } = await makeApp();
    const actor = await register(app);
    const negative = await request(app).get('/spaces?offset=-1').set(auth(actor));
    expect(negative.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 14.12 Error handling & redaction
// ---------------------------------------------------------------------------

describe('error handling and redaction', () => {
  it('never returns internal details for malformed JSON', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/node_modules|at Object|sqlite|stack/i);
    expect([400, 500]).toContain(res.status);
  });

  it('redacts secrets in objects, strings and errors', () => {
    const redacted = redact({
      password: 'hunter2',
      nested: { apiKey: 'sk_live_abcdefgh1234', note: 'Authorization: Bearer abc.def.ghi' },
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturePart',
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk_live_abcdefgh1234');
    expect(json).not.toContain('signaturePart');
    expect(json).toContain('[REDACTED]');

    expect(redactString('GET /storage-download?token=secritvalue&x=1')).not.toContain('secritvalue');
    expect(redactString('postgres://user:supersecret@db.host:5432/postgres')).not.toContain('supersecret');

    const err = redactError(new Error('connect failed postgres://u:pw123456@host/db'));
    expect(err.message).not.toContain('pw123456');
    expect(err.stack?.join('\n')).not.toContain('pw123456');
  });
});

// ---------------------------------------------------------------------------
// 14.13 Malware scanning
// ---------------------------------------------------------------------------

const fakeScanner = (status: 'CLEAN' | 'INFECTED'): MalwareScanner => ({
  name: 'fake-scanner',
  available: async () => true,
  scanFile: async () => ({ status, detail: status === 'INFECTED' ? 'EICAR-Test-File' : undefined }),
});

describe('malware scanning', () => {
  it('reports NOT_CONFIGURED when no scanner is installed', async () => {
    const env = loadEnv({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test', malwareScanPolicy: 'advisory' });
    const service = new MalwareScanService(env, []);
    expect((await service.status()).configured).toBe(false);
    const result = await service.scanBuffer(Buffer.from('data'));
    expect(result.status).toBe('NOT_CONFIGURED');
  });

  it('skips scanning when the policy is off', async () => {
    const env = loadEnv({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test', malwareScanPolicy: 'off' });
    const service = new MalwareScanService(env, [fakeScanner('INFECTED')]);
    expect((await service.scanBuffer(Buffer.from('data'))).status).toBe('SKIPPED');
  });

  it('surfaces an infected result from the configured scanner', async () => {
    const env = loadEnv({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test', malwareScanPolicy: 'enforce' });
    const service = new MalwareScanService(env, [fakeScanner('INFECTED')]);
    const result = await service.scanBuffer(Buffer.from('data'));
    expect(result.status).toBe('INFECTED');
    expect(result.scanner).toBe('fake-scanner');
  });

  it('quarantines an infected upload under the enforce policy', async () => {
    const scanEnv = loadEnv({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test', malwareScanPolicy: 'enforce' });
    const { app, ctx } = await makeApp(
      { malwareScanPolicy: 'enforce' },
      { scanner: new MalwareScanService(scanEnv, [fakeScanner('INFECTED')]) },
    );
    const actor = await register(app);
    const spaceId = await createSpace(app, actor);
    const uploaded = await uploadFile(app, actor, spaceId);
    expect(uploaded.status).toBe(422);
    expect(uploaded.body.error.code).toBe('MALWARE_DETECTED');

    const listed = await request(app).get(`/spaces/${spaceId}/files`).set(auth(actor));
    const names = JSON.stringify(listed.body);
    expect(names).not.toContain('notes.txt');
    const file = await ctx.db.files.findById(uploaded.fileId);
    expect(file?.status).toBe('DELETED');
  });

  it('allows the upload and records the result under the advisory policy', async () => {
    const scanEnv = loadEnv({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test', malwareScanPolicy: 'advisory' });
    const { app } = await makeApp(
      { malwareScanPolicy: 'advisory' },
      { scanner: new MalwareScanService(scanEnv, [fakeScanner('CLEAN')]) },
    );
    const actor = await register(app);
    const spaceId = await createSpace(app, actor);
    const uploaded = await uploadFile(app, actor, spaceId);
    expect(uploaded.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 14.14 Backups and restore
// ---------------------------------------------------------------------------

describe('backup and restore', () => {
  async function backupEnv(retention = 3) {
    const root = await tmpDir('backup');
    const sqliteFile = path.join(root, 'flashspace.db');
    const localStorageDir = path.join(root, 'storage');
    const backupDir = path.join(root, 'backups');
    await fs.writeFile(sqliteFile, 'sqlite-bytes');
    await fs.mkdir(path.join(localStorageDir, 'spaces', 'a'), { recursive: true });
    await fs.writeFile(path.join(localStorageDir, 'spaces', 'a', 'file.txt'), 'payload');
    const env = loadEnv({
      nodeEnv: 'test',
      repoMode: 'sqlite',
      storageMode: 'local',
      sqliteFile,
      localStorageDir,
      backupDir,
      backupRetention: retention,
    });
    return { env, root, localStorageDir, backupDir, sqliteFile };
  }

  it('creates a verifiable backup with checksums', async () => {
    const { env, backupDir } = await backupEnv();
    const service = new BackupService(env);
    const backup = await service.create('test');
    expect(backup.files).toBeGreaterThanOrEqual(2);

    const manifest = JSON.parse(await fs.readFile(path.join(backup.dir, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    expect(manifest.database).toBeTruthy();
    expect(manifest.storage.files).toBe(1);

    const verified = await service.verify(backup.id);
    expect(verified.ok).toBe(true);
    expect(verified.checked).toBeGreaterThanOrEqual(2);
    expect(await fs.stat(backupDir)).toBeTruthy();
    expect((await service.list()).length).toBe(1);
  });

  it('detects tampering and refuses to restore a corrupt backup', async () => {
    const { env } = await backupEnv();
    const service = new BackupService(env);
    const backup = await service.create();
    const stored = path.join(backup.dir, 'storage', 'spaces', 'a', 'file.txt');
    await fs.writeFile(stored, 'tampered');

    const verified = await service.verify(backup.id);
    expect(verified.ok).toBe(false);
    expect(verified.failures.length).toBeGreaterThan(0);
    expect(verified.failures.join(' ')).toMatch(/checksum|size/);
    await expect(service.restore(backup.id, path.join(env.backupDir, 'restored'))).rejects.toThrow(
      /integrity/,
    );
  });

  it('restores database and files into an isolated directory', async () => {
    const { env, root } = await backupEnv();
    const service = new BackupService(env);
    const backup = await service.create();
    const target = path.join(root, 'restore-target');
    const restored = await service.restore(backup.id, target);

    expect(restored.files).toBe(1);
    expect(await fs.readFile(path.join(target, 'storage', 'spaces', 'a', 'file.txt'), 'utf8')).toBe(
      'payload',
    );
    expect(await fs.readFile(restored.databasePath!, 'utf8')).toBe('sqlite-bytes');
  });

  it('prunes old backups according to retention', async () => {
    const { env } = await backupEnv(2);
    const service = new BackupService(env);
    await service.create('one');
    await service.create('two');
    await service.create('three');
    const remaining = await service.list();
    expect(remaining.length).toBe(2);
    expect(remaining.some((backup) => backup.id.startsWith('one'))).toBe(false);
  });

  it('rejects traversal-style backup ids', async () => {
    const { env } = await backupEnv();
    const service = new BackupService(env);
    await expect(service.verify('../etc')).rejects.toThrow(/Invalid backup id/);
  });
});
