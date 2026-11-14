import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';

/**
 * Server-side Supabase clients.
 *
 * Two distinct clients on purpose:
 *   - `createServiceClient` uses the service-role key. It bypasses RLS and may
 *     call the Auth admin API. It must never leave the server.
 *   - `createUserClient` uses the anon key plus the caller's access token, so
 *     PostgREST applies RLS as that user. Used when an operation should be
 *     constrained exactly like the browser.
 *
 * Neither client persists a session: the API is stateless and every request
 * carries its own bearer token.
 */

export function hasSupabaseConfig(env: Env): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

export function hasServiceRole(env: Env): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceKey);
}

const baseOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

export function createServiceClient(env: Env): SupabaseClient {
  if (!hasServiceRole(env)) {
    throw new AppError(
      'SUPABASE_NOT_CONFIGURED',
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the API for this operation',
    );
  }
  return createClient(env.supabaseUrl, env.supabaseServiceKey, baseOptions);
}

export function createUserClient(env: Env, accessToken: string): SupabaseClient {
  if (!hasSupabaseConfig(env)) {
    throw new AppError('SUPABASE_NOT_CONFIGURED', 'SUPABASE_URL and SUPABASE_ANON_KEY must be set on the API');
  }
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    ...baseOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
