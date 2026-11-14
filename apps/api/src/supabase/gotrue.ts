import { createServiceClient } from './clients.js';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';

/**
 * Thin server-side calls to Supabase Auth (GoTrue).
 *
 * These are Supabase's own endpoints, called from Express because the API holds
 * the caller's access token. Nothing here re-implements authentication: no
 * custom reset tokens, no password storage.
 *
 * `PUT /auth/v1/user` is the documented "update the current user" endpoint and
 * is what supabase-js calls under the hood. Sending it directly is what lets the
 * API trigger Supabase's real email-change confirmation flow (the new address
 * receives a verification link) and its password update, while re-authenticating
 * the current password first.
 */

function base(env: Env): string {
  if (!env.supabaseUrl) throw new AppError('SUPABASE_NOT_CONFIGURED', 'SUPABASE_URL is not set');
  return env.supabaseUrl.replace(/\/$/, '');
}

async function userCall(
  env: Env,
  accessToken: string,
  init: { method: string; path?: string; body?: unknown },
): Promise<Response> {
  const res = await fetch(`${base(env)}/auth/v1${init.path ?? '/user'}`, {
    method: init.method,
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return res;
}

/** Verify the signed-in user's password (step-up auth for sensitive changes). */
export async function verifyPassword(env: Env, email: string, password: string): Promise<boolean> {
  const res = await fetch(`${base(env)}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.ok;
}

/**
 * Ask Supabase Auth to change the account email. Supabase sends its
 * "change email" confirmation to the NEW address; the profile row is updated
 * only by the `on_auth_user_updated` trigger once that link is confirmed.
 */
export async function requestEmailChange(env: Env, accessToken: string, newEmail: string): Promise<void> {
  const res = await userCall(env, accessToken, {
    method: 'PUT',
    body: { email: newEmail },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string; error_description?: string };
    const message = body.msg ?? body.message ?? body.error_description ?? 'Supabase rejected the email change';
    if (res.status === 429) {
      throw new AppError('RATE_LIMITED', 'Too many email changes. Supabase limits how often this can be attempted.');
    }
    if (/already|registered|exists/i.test(message)) {
      throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
    }
    throw new AppError('EMAIL_CHANGE_FAILED', message);
  }
}

/** Update the password through Supabase Auth (caller must have re-authenticated). */
export async function updatePassword(env: Env, accessToken: string, newPassword: string): Promise<void> {
  const res = await userCall(env, accessToken, { method: 'PUT', body: { password: newPassword } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string };
    throw new AppError('PASSWORD_UPDATE_FAILED', body.msg ?? body.message ?? 'Could not update the password');
  }
}

/**
 * Delete the auth user through the service-role admin API.
 *
 * Deleting the auth user revokes every refresh token for that account and
 * cascades the profile row (FK `on delete cascade`). Global session revocation
 * is therefore complete for this provider — unlike the local JWT mode, where a
 * signed token stays valid until it expires.
 */
export async function deleteAuthUser(env: Env, userId: string): Promise<void> {
  const client = createServiceClient(env);
  const { error } = await client.auth.admin.deleteUser(userId);
  if (error) throw new AppError('ACCOUNT_DELETE_FAILED', error.message);
}
