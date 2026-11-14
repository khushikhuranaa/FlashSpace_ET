import { useState } from 'react';
import { Icon } from '../components/Icon';
import { isValidEmail } from '../lib/password';
import { api } from '../api';
import { authRedirectTo, isSupabaseMode, supabase } from '../lib/supabase';
import { AuthShell } from './Register';

/**
 * Forgot password (Module 1.3).
 *
 * Sends Supabase's real recovery email. The response never reveals whether an
 * account exists — that is both Supabase's behaviour and ours.
 */
export default function ForgotPassword({ navigate }: { navigate: (to: string) => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidEmail(email)) return setError('Enter a valid email address');

    setBusy(true);
    try {
      if (isSupabaseMode && supabase) {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
          redirectTo: authRedirectTo('/reset-password'),
        });
        if (resetError && /rate limit|too many/i.test(resetError.message)) {
          setError('Too many reset requests. Try again later.');
          return;
        }
        // Any other provider error is still reported as success so the page
        // cannot be used to enumerate registered addresses.
        if (resetError) console.warn('[auth] reset request failed', resetError.message);
      } else {
        // Local auth: the API owns the token and sends the link by email.
        await api.requestPasswordReset(email.trim().toLowerCase());
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the recovery link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell onBack={() => navigate('/login')}>
      <h1 className="font-display text-xl font-bold text-primary">Reset your password</h1>
      <p className="mt-1 text-[13px] text-muted">
        Enter your account email and we will send a recovery link.
      </p>

      {sent ? (
        <div className="mt-6 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
            <Icon name="mail" size={16} className="mt-0.5 shrink-0" />
            <span>
              If an account exists for that address, a recovery link is on its way. The link expires after a short
              time and can only be used once.
            </span>
          </p>
          {isSupabaseMode ? (
            <p className="text-[12px] text-muted">
              Nothing arrived? Supabase's built-in mailer is rate limited during development — wait a few minutes and
              try again, or configure custom SMTP.
            </p>
          ) : (
            <p className="text-[12px] text-muted">
              Running locally with the mock mail transport?{' '}
              <a
                href={`${import.meta.env.VITE_API_URL ?? '/api'}/dev/outbox`}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-flash-700 hover:underline"
              >
                Open the local outbox
              </a>{' '}
              to see the message and its link.
            </p>
          )}
          <button onClick={() => navigate('/login')} className="btn-primary w-full py-2.5">
            Back to sign in
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <label className="block">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@team.dev"
              autoComplete="email"
              required
            />
          </label>

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
            {busy ? 'Sending…' : 'Send recovery link'}
          </button>
        </form>
      )}

      <p className="mt-4 text-center text-[13px] text-muted">
        Remembered it?{' '}
        <button onClick={() => navigate('/login')} className="font-medium text-flash-600 hover:underline">
          Sign in
        </button>
      </p>
    </AuthShell>
  );
}
