import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { AuthShell } from './Register';

/**
 * OAuth / email-link return page.
 *
 * Supabase appends a one-time `code` (PKCE) or token fragment to the redirect
 * URL; the SDK exchanges it when the client is created. This page only waits
 * for that session, hydrates the FlashSpace profile and forwards the user —
 * it never creates a session of its own.
 */
export default function AuthCallback({ navigate }: { navigate: (to: string) => void }) {
  const { completeSignIn } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      if (!supabase) {
        setError('Supabase is not configured for this build.');
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const providerError = params.get('error_description') ?? params.get('error');
      if (providerError) {
        if (!cancelled) setError(providerError);
        return;
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sessionError) {
        setError(sessionError.message);
        return;
      }
      if (!data.session) {
        setError('That sign-in link is invalid or has expired. Start again from the sign-in page.');
        return;
      }

      // Drop the consumed code from the address bar so a refresh cannot replay
      // the exchange (Supabase rejects a reused code).
      window.history.replaceState({}, '', `${window.location.pathname}#/dashboard`);
      await completeSignIn().catch(() => undefined);
      if (!cancelled) navigate('/dashboard');
    };

    void finish();
    return () => {
      cancelled = true;
    };
  }, [completeSignIn, navigate]);

  return (
    <AuthShell onBack={() => navigate('/login')}>
      <div className="text-center">
        {error ? (
          <>
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
              <Icon name="alert-circle" size={20} />
            </span>
            <h1 className="mt-4 font-display text-xl font-bold text-primary">Sign-in could not finish</h1>
            <p className="mt-2 text-[13px] text-muted">{error}</p>
            <button onClick={() => navigate('/login')} className="btn-primary mt-6 w-full py-2.5">
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-flash-50 text-flash-600">
              <Icon name="refresh" size={20} />
            </span>
            <h1 className="mt-4 font-display text-xl font-bold text-primary">Finishing sign-in…</h1>
            <p className="mt-2 text-[13px] text-muted">
              Confirming your account. You will be taken to your dashboard in a moment.
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}
