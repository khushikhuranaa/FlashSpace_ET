import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { authRedirectTo, isSupabaseMode, supabase } from '../lib/supabase';
import { AuthShell } from './Register';

type Status = 'checking' | 'verified' | 'pending' | 'invalid';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Email verification callback (Module 1.4).
 *
 * Supabase exchanges the link's code for a session before this renders; we then
 * read the authoritative `email_confirmed_at` from the user record. Expired and
 * already-used links are surfaced explicitly, with a resend path.
 */
export default function VerifyEmail({ navigate }: { navigate: (to: string) => void }) {
  const [status, setStatus] = useState<Status>('checking');
  const [email, setEmail] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const linkError = params.get('error_description') ?? params.get('error');

    const run = async () => {
      if (!isSupabaseMode) {
        // Local auth: the API issues and verifies hashed, single-use tokens.
        const hash = window.location.hash;
        const token = new URLSearchParams(
          hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : window.location.search,
        ).get('token');
        if (token) {
          try {
            await api.confirmEmailVerification(token);
            if (!cancelled) setStatus('verified');
          } catch (err) {
            if (!cancelled) {
              setStatus('invalid');
              setMessage(err instanceof Error ? err.message : 'This verification link is invalid or expired.');
            }
          }
          return;
        }
        try {
          const { user } = await api.me();
          if (cancelled) return;
          setEmail(user.email);
          setStatus(user.emailVerifiedAt ? 'verified' : 'pending');
        } catch {
          if (!cancelled) {
            setStatus('invalid');
            setMessage('Sign in, then open this page again to verify your address.');
          }
        }
        return;
      }
      if (!supabase) {
        setStatus('invalid');
        setMessage('Email verification requires Supabase Auth to be configured.');
        return;
      }
      if (linkError) {
        setStatus('invalid');
        setMessage(linkError.replace(/\+/g, ' '));
        return;
      }
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!data.user) {
        setStatus('pending');
        return;
      }
      setEmail(data.user.email ?? null);
      setStatus(data.user.email_confirmed_at ? 'verified' : 'pending');
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const timer = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) clearInterval(timer);
        return s - 1;
      });
    }, 1000);
  };

  const resend = useCallback(async () => {
    if (cooldown > 0 || busy) return;
    if (!isSupabaseMode) {
      setBusy(true);
      setResent(false);
      try {
        await api.requestEmailVerification();
        setResent(true);
        startCooldown();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Could not send the verification email');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!supabase || !email) return;
    setBusy(true);
    setResent(false);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: authRedirectTo('/verify') },
      });
      if (error) {
        setMessage(
          /rate limit|too many/i.test(error.message)
            ? 'Supabase is rate-limiting verification emails. Try again in a few minutes.'
            : error.message,
        );
        return;
      }
      setResent(true);
      startCooldown();
    } finally {
      setBusy(false);
    }
  }, [email, cooldown, busy]);

  return (
    <AuthShell onBack={() => navigate('/login')}>
      <h1 className="font-display text-xl font-bold text-primary">Email verification</h1>

      {status === 'checking' && <p className="mt-4 text-[13px] text-muted">Checking your verification link…</p>}

      {status === 'verified' && (
        <div className="mt-4 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
            <Icon name="check" size={16} className="mt-0.5 shrink-0" />
            <span>
              Your email{email ? ` (${email})` : ''} is verified. You can now use every account feature.
            </span>
          </p>
          <button onClick={() => navigate('/dashboard')} className="btn-primary w-full py-2.5">
            Continue to FlashSpace
          </button>
        </div>
      )}

      {(status === 'pending' || status === 'invalid') && (
        <div className="mt-4 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
            <span>
              {status === 'invalid'
                ? message ?? 'This verification link is invalid or has expired.'
                : 'We have not seen a confirmation for this address yet. Open the link from your inbox, or resend it.'}
            </span>
          </p>
          {message && status === 'pending' && <p className="text-[12px] text-red-600">{message}</p>}
          {resent && <p className="text-[12px] text-emerald-600">Verification email sent again.</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={resend}
              disabled={busy || cooldown > 0 || !email}
              className="btn-secondary px-4 py-2 text-[13px]"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : busy ? 'Sending…' : 'Resend email'}
            </button>
            <button onClick={() => navigate('/login')} className="btn-primary px-4 py-2 text-[13px]">
              Sign in
            </button>
          </div>
          {!email && (
            <p className="text-[12px] text-muted">
              Sign in first so we know which address to resend to — then open this page again.
            </p>
          )}
        </div>
      )}
    </AuthShell>
  );
}
