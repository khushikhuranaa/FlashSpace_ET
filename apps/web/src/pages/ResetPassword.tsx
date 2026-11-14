import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { passwordStrength } from '../lib/password';
import { isSupabaseMode, supabase } from '../lib/supabase';
import { AuthShell } from './Register';

type LinkState = 'checking' | 'valid' | 'invalid';

/** Recovery links arrive as `?code=…` (PKCE). Give the SDK a moment to exchange it. */
async function waitForRecoverySession(): Promise<boolean> {
  if (!supabase) return false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data } = await supabase.auth.getSession();
    if (data.session) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Reset password (Module 1.3). The recovery link is validated by Supabase; an
 * expired or already-used link simply has no session, which is reported here
 * instead of failing silently.
 */
export default function ResetPassword({ navigate }: { navigate: (to: string) => void }) {
  const [linkState, setLinkState] = useState<LinkState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [localToken, setLocalToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Hash routing puts parameters after the fragment: #/reset-password?token=…
    const hash = window.location.hash;
    const params = new URLSearchParams(
      hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : window.location.search,
    );
    const linkError = params.get('error_description') ?? params.get('error');
    if (!isSupabaseMode) {
      const token = params.get('token');
      if (!token) {
        setError('Open the recovery link from your email to choose a new password.');
        setLinkState('invalid');
        return;
      }
      setLocalToken(token);
      setLinkState('valid');
      return;
    }
    if (!supabase) {
      setLinkState('invalid');
      return;
    }
    if (linkError) {
      setError(linkError.replace(/\+/g, ' '));
      setLinkState('invalid');
      return;
    }
    void waitForRecoverySession().then((ok) => {
      if (!cancelled) setLinkState(ok ? 'valid' : 'invalid');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match');
    const check = passwordStrength(password);
    if (check.problems.length > 0) return setError(check.problems[0]!);

    if (!isSupabaseMode) {
      if (!localToken) return setError('This recovery link is missing its token');
      setBusy(true);
      try {
        await api.confirmPasswordReset(localToken, password);
        setDone(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the password');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!supabase) return;
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(
          /session|expired|invalid/i.test(updateError.message)
            ? 'This recovery link has expired. Request a new one.'
            : /rate limit|too many/i.test(updateError.message)
              ? 'Too many attempts. Please wait and try again.'
              : updateError.message,
        );
        return;
      }
      setDone(true);
      // The recovery session is a normal session; signing out forces a fresh
      // sign-in with the new password.
      await supabase.auth.signOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell onBack={() => navigate('/forgot-password')}>
      <h1 className="font-display text-xl font-bold text-primary">Choose a new password</h1>

      {linkState === 'checking' && <p className="mt-4 text-[13px] text-muted">Validating your recovery link…</p>}

      {linkState === 'invalid' && (
        <div className="mt-4 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
            <span>
              This recovery link is invalid or has expired. Recovery links can only be used once and expire quickly.
            </span>
          </p>
          <button onClick={() => navigate('/forgot-password')} className="btn-primary w-full py-2.5">
            Request a new link
          </button>
        </div>
      )}

      {linkState === 'valid' && !done && (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" showStrength />
          <PasswordField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            placeholder="Repeat your new password"
          />
          {confirm.length > 0 && confirm !== password && (
            <p className="text-[11px] text-red-600">Passwords do not match</p>
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
            {busy ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}

      {done && (
        <div className="mt-4 space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
            <Icon name="check" size={16} className="mt-0.5 shrink-0" />
            <span>Your password has been updated. Sign in with your new password.</span>
          </p>
          <button onClick={() => navigate('/login')} className="btn-primary w-full py-2.5">
            Go to sign in
          </button>
        </div>
      )}
    </AuthShell>
  );
}
