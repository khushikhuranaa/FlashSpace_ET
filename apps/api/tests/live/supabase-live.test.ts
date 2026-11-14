import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildApp } from '../../src/app.js';

/**
 * Module 1 — LIVE Supabase integration suite.
 *
 * This is the suite that proves the real integration. It is skipped unless a
 * real project is configured, so it never fakes a pass:
 *
 *   SUPABASE_TEST_LIVE=1 \
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   DATABASE_URL=postgres://... \
 *   npx vitest run tests/live
 *
 * Assumes `003_auth_identity.sql` has been applied (profiles, triggers, RLS,
 * avatars bucket). Creates one throwaway account and deletes it afterwards.
 */

const live =
  process.env.SUPABASE_TEST_LIVE === '1' &&
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);

const URL_ = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// Smallest valid PNG (1x1, transparent) used for the avatar round-trip.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!live)('Supabase live integration — Module 1', () => {
  const email = `module1-live-${Date.now()}@flashspace.test`;
  const password = 'Live-Test-Passw0rd!';
  let admin: SupabaseClient;
  let user: SupabaseClient;
  let accessToken = '';
  let userId = '';
  let created = false;

  beforeAll(async () => {
    admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const signUp = await anon.auth.signUp({
      email,
      password,
      options: { data: { display_name: 'Live Test' } },
    });
    if (signUp.error) throw signUp.error;
    userId = signUp.data.user!.id;
    created = true;

    if (signUp.data.session) {
      accessToken = signUp.data.session.access_token;
    } else {
      // "Confirm email" is ON: confirm through the admin API so the suite can
      // exercise the signed-in surfaces too.
      await admin.auth.admin.updateUserById(userId, { email_confirm: true });
      const signedIn = await anon.auth.signInWithPassword({ email, password });
      if (signedIn.error) throw signedIn.error;
      accessToken = signedIn.data.session!.access_token;
    }

    user = createClient(URL_, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }, 60_000);

  afterAll(async () => {
    if (created) {
      await admin.storage.from(process.env.AVATARS_BUCKET ?? 'avatars').remove([`${userId}/`]);
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  }, 60_000);

  it('creates exactly one profile row for the auth user', async () => {
    const { data, error } = await admin
      .from('profiles')
      .select('id, auth_user_id, email, display_name, role, account_status')
      .eq('auth_user_id', userId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.email).toBe(email);
    expect(data![0]!.role).toBe('USER'); // never ADMIN from registration
  });

  it('accepts a real Supabase token on protected endpoints', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.role).toBe('USER');
  });

  it('rejects a request without a token', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/users/me');
    expect(res.status).toBe(401);
  });

  it('RLS hides other users’ profiles from the user-scoped client', async () => {
    const { data, error } = await user.from('profiles').select('id, email').neq('auth_user_id', userId).limit(5);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('RLS blocks a user from granting themselves ADMIN', async () => {
    const { error } = await user.from('profiles').update({ role: 'ADMIN' }).eq('auth_user_id', userId);
    expect(error).not.toBeNull(); // privilege trigger refuses the column change
  });

  it('reads and updates its own profile through the API', async () => {
    const { app } = buildApp();
    const before = await request(app).get('/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(before.status).toBe(200);
    expect(before.body.account.email).toBe(email);
    expect(before.body.account.account_status ?? before.body.account.accountStatus).toBe('ACTIVE');

    const updated = await request(app)
      .patch('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ displayName: 'Live Renamed', preferences: { notifyEmail: false } });
    expect(updated.status).toBe(200);
    expect(updated.body.account.displayName).toBe('Live Renamed');
    expect(updated.body.account.preferences.notifyEmail).toBe(false);

    const persisted = await admin.from('profiles').select('display_name').eq('auth_user_id', userId).single();
    expect(persisted.data!.display_name).toBe('Live Renamed');
  });

  it('uploads an avatar to Storage and records its path', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'image/png')
      .send(PNG_1X1);
    expect(res.status).toBe(201);
    expect(res.body.account.avatarPath).toContain(userId);

    const listed = await admin.storage.from(process.env.AVATARS_BUCKET ?? 'avatars').list(userId);
    expect((listed.data ?? []).length).toBeGreaterThan(0);
  });

  it('rejects a non-image payload disguised as an image', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('this is not a png'));
    expect(res.status).toBe(415);
  });

  it('exports personal data without credentials or tokens', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/users/me/export').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(email);
    expect(body).not.toMatch(/passwordHash|password_hash|access_token|refresh_token|service_role/i);
  });

  it('changes the password only after re-authentication', async () => {
    const { app } = buildApp();
    const wrong = await request(app)
      .post('/users/me/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'definitely-wrong', newPassword: 'Another-Passw0rd!' });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .post('/users/me/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: 'Another-Passw0rd!' });
    expect(ok.status).toBe(200);
  });

  it('deletes the account and revokes the session', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'Another-Passw0rd!' });
    expect(res.status).toBe(204);
    created = false;

    const afterDelete = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(afterDelete.status).toBe(401);
  });
});
