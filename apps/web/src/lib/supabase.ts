import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client (Module 1).
 *
 * The publishable/anon key is public by design; RLS decides what it may read.
 * The service-role key never appears in this bundle — only the API holds it.
 *
 * Session handling is entirely Supabase's: `persistSession` stores the session
 * in the SDK's own storage, `autoRefreshToken` rotates the access token before
 * it expires, and `detectSessionInUrl` completes the email-verification and
 * password-recovery redirects. We never hand-roll token storage.
 */

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const mode = (import.meta.env.VITE_AUTH_MODE ?? 'local').trim();

export const isSupabaseConfigured = Boolean(url && anonKey);

/** True only when both the keys exist and the app is told to use Supabase. */
export const isSupabaseMode = isSupabaseConfigured && mode === 'supabase';

/** Why Supabase mode is off, for the setup banner in the UI. */
export const supabaseConfigIssue: string | null = isSupabaseMode
  ? null
  : mode === 'supabase'
    ? 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing from apps/web/.env'
    : null;

/**
 * "Keep me signed in" controls which browser store Supabase persists to.
 * Remembered sessions survive a browser restart (localStorage); otherwise the
 * session is scoped to the tab (sessionStorage). Either way the session format
 * and token lifecycle belong to the Supabase SDK.
 */
const REMEMBER_KEY = 'flashspace.remember';

export function setRememberDevice(remember: boolean): void {
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  } catch {
    /* storage disabled: fall back to default persistence */
  }
}

function rememberDevice(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== '0';
  } catch {
    return true;
  }
}

const rememberStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      (rememberDevice() ? localStorage : sessionStorage).setItem(key, value);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const supabase: SupabaseClient | null = isSupabaseMode
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'flashspace.auth',
        storage: rememberStorage,
      },
    })
  : null;

/** Where Supabase should send the user after a confirmation / recovery link. */
export function authRedirectTo(path: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return `${window.location.origin}${window.location.pathname}#${path}`;
}

/**
 * Start Google sign-in through Supabase (Supabase mode only).
 *
 * Supabase owns the provider redirect and the PKCE verifier; the browser just
 * follows the URL the SDK returns. The provider sends the user back to
 * `#/auth/callback`, where the SDK completes the exchange and the app hydrates
 * the FlashSpace profile from the API. Account linking is handled by Supabase:
 * a Google identity whose verified email matches an existing account is linked
 * to it instead of creating a duplicate user.
 *
 * Returns an error message when the redirect could not be started; on success
 * the browser navigates away and this promise never resolves visibly.
 */
export async function startGoogleOAuth(remember: boolean): Promise<string | null> {
  if (!supabase) {
    return 'Google sign-in needs a configured Supabase project (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_AUTH_MODE=supabase).';
  }
  setRememberDevice(remember);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: authRedirectTo('/auth/callback'),
      // Let people pick the Google account they actually want to use.
      queryParams: { prompt: 'select_account' },
    },
  });
  return error ? error.message : null;
}
