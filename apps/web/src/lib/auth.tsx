import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  getToken,
  hasStoredSession,
  restoreSession,
  setSession,
  setTokenProvider,
} from '../api';
import type { AuthUser } from '../types';
import { isSupabaseMode, supabase } from './supabase';

/**
 * Authentication state (Module 1.5).
 *
 * Supabase is the session authority when configured: the SDK persists the
 * session, refreshes the access token, and emits auth events. This provider
 * only mirrors that state into React and hydrates the application user from the
 * API (`/auth/me`), which is the only place roles are resolved.
 *
 * Local development mode keeps working unchanged so existing pages and tests
 * still run without a cloud project.
 */

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** True when the signed-in account has a verified email address. */
  emailVerified: boolean;
  /** Set when the email belongs to a legacy local account that must be linked. */
  legacyAccountConflict: boolean;
  supabaseEnabled: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Called after a successful client-side Supabase sign-in. */
  completeSignIn: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [emailVerified, setEmailVerified] = useState(false);
  const [legacyAccountConflict, setLegacyAccountConflict] = useState(false);

  // In Supabase mode every API call uses the SDK session token, which the SDK
  // refreshes for us. Local mode keeps its own development token.
  useEffect(() => {
    const client = supabase;
    if (!client) return;
    setTokenProvider(async () => {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    });
  }, []);

  const hydrate = useCallback(async () => {
    if (!isSupabaseMode && !getToken()) {
      if (!hasStoredSession()) {
        setUser(null);
        setEmailVerified(false);
        setLoading(false);
        return;
      }
      // Reload: exchange the rotating refresh token for a short-lived access
      // token before asking who we are.
      const restored = await restoreSession();
      if (!restored) {
        setUser(null);
        setEmailVerified(false);
        setLoading(false);
        return;
      }
    }
    try {
      const me = await api.me();
      setUser(me.user);
      setLegacyAccountConflict(false);
      if (isSupabaseMode) {
        const account = await api.accountMe().catch(() => null);
        setEmailVerified(account?.account.emailVerified ?? false);
      } else {
        setEmailVerified(Boolean(me.user.emailVerifiedAt));
      }
    } catch (err) {
      setUser(null);
      if (err instanceof ApiError && err.code === 'LEGACY_ACCOUNT_EXISTS') {
        setLegacyAccountConflict(true);
      } else if (!isSupabaseMode) {
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      void hydrate();
      return;
    }
    let cancelled = false;

    // Restore an existing session on load (refresh-safe).
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (!data.session) {
        setLoading(false);
        setUser(null);
        return;
      }
      void hydrate();
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null);
        setEmailVerified(false);
        setLoading(false);
        return;
      }
      if (event === 'TOKEN_REFRESHED') return; // the SDK already swapped the token
      // Never await Supabase calls inside this callback: it runs while the SDK
      // holds its lock, so defer the hydration to the next tick.
      setTimeout(() => {
        void hydrate();
      }, 0);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [hydrate]);

  const signOut = useCallback(async () => {
    // Revokes the refresh token server-side, then clears the local session.
    if (supabase) await supabase.auth.signOut();
    else await api.logout();
    setSession(null);
    setUser(null);
    setEmailVerified(false);
    setLegacyAccountConflict(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      emailVerified,
      legacyAccountConflict,
      supabaseEnabled: isSupabaseMode,
      refresh: hydrate,
      signOut,
      completeSignIn: hydrate,
    }),
    [user, loading, emailVerified, legacyAccountConflict, hydrate, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
