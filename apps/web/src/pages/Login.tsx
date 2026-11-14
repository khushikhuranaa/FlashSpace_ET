import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { GoogleButton } from '../components/GoogleButton';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { isValidEmail } from '../lib/password';
import { isSupabaseMode, setRememberDevice, supabase, supabaseConfigIssue } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { AuthUser } from '../types';
import { AuthShell } from './Register';

/**
 * Sign in (Module 1.2).
 *
 * Supabase Auth issues and persists the session; "remember me" only chooses
 * whether that session survives the tab. Invalid credentials, unverified
 * addresses and provider rate limits are reported distinctly.
 */
export default function Login({
  onAuthenticated,
  navigate,
}: {
  onAuthenticated?: (u: AuthUser) => void;
  navigate: (to: string) => void;
}) {
  const { completeSignIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Set when the account has a verified TOTP factor: the password step passed
  // but Supabase still requires a code (AAL2) before the session is usable.
  const [mfa, setMfa] = useState<{ factorId: string; challengeId: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Read the re-authentication message after the password-change redirect.
  // Doing this in an effect keeps the read side-effect free under StrictMode.
  useEffect(() => {
    const message = sessionStorage.getItem('flashspace.reauth-notice');
    if (!message) return;
    setNotice(message);
    sessionStorage.removeItem('flashspace.reauth-notice');
  }, []);

  /**
   * Returns true when the signed-in user still needs a TOTP code.
   *
   * `nextLevel === 'aal2'` means a verified factor exists and the password-only
   * session (aal1) is not enough. The challenge is created here so the code
   * screen only has to verify it.
   */
  const startMfaChallenge = async (): Promise<boolean> => {
    if (!supabase) return false;
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!level || level.nextLevel !== 'aal2' || level.currentLevel === 'aal2') return false;
    const { data: list, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      setError(listError.message);
      return true;
    }
    const factor = list.totp.find((f) => f.status === 'verified');
    if (!factor) return false;
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factor.id,
    });
    if (challengeError) {
      setError(challengeError.message);
      return true;
    }
    setMfa({ factorId: factor.id, challengeId: challenge.id });
    return true;
  };

  const verifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !mfa) return;
    const code = mfaCode.trim();
    if (!/^\d{6}$/.test(code)) return setError('Enter the six-digit code from your authenticator app');
    setBusy(true);
    setError(null);
    try {
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfa.factorId,
        challengeId: mfa.challengeId,
        code,
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      setMfa(null);
      setMfaCode('');
      await completeSignIn();
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the code');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNeedsVerification(false);
    if (!isValidEmail(email)) return setError('Enter a valid email address');
    if (!password) return setError('Enter your password');

    setBusy(true);
    try {
      if (isSupabaseMode && supabase) {
        setRememberDevice(remember);
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (signInError) {
          const msg = signInError.message;
          if (/email not confirmed|not confirmed/i.test(msg)) {
            setNeedsVerification(true);
            setError('Verify your email address before signing in.');
          } else if (/invalid login credentials|invalid_grant/i.test(msg)) {
            setError('Incorrect email or password');
          } else if (/rate limit|too many/i.test(msg) || signInError.status === 429) {
            setError('Too many sign-in attempts. Wait a minute before trying again.');
          } else {
            setError(msg);
          }
          return;
        }
        if (data.user && !data.user.email_confirmed_at) {
          setNeedsVerification(true);
          setError('Verify your email address before signing in.');
          return;
        }
        if (await startMfaChallenge()) return;
        await completeSignIn();
        onAuthenticated?.({
          id: data.user?.id ?? '',
          email: data.user?.email ?? email,
          displayName: (data.user?.user_metadata?.display_name as string) ?? email.split('@')[0]!,
          role: 'USER',
        });
        navigate('/dashboard');
        return;
      }

      const r = await api.login(email, password);
      await completeSignIn();
      onAuthenticated?.(r.user);
      navigate('/dashboard');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong',
      );
    } finally {
      setBusy(false);
    }
  };

  if (mfa) {
    return (
      <AuthShell
        onBack={() => {
          setMfa(null);
          setMfaCode('');
          setError(null);
        }}
      >
        <h1 className="font-display text-xl font-bold text-primary">Two-factor authentication</h1>
        <p className="mt-1 text-[13px] text-muted">
          Enter the six-digit code from your authenticator app to finish signing in.
        </p>
        <form onSubmit={verifyMfa} className="mt-6 space-y-4" noValidate>
          <label className="block">
            <span className="field-label">Authentication code</span>
            <input
              className="input tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
            />
          </label>
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <p className="flex items-start gap-2">
                <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            </div>
          )}
          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
            {busy ? 'Verifying…' : 'Verify and continue'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell onBack={() => navigate('/')}>
      <h1 className="font-display text-xl font-bold text-primary">Sign in to FlashSpace</h1>
      <p className="mt-1 text-[13px] text-muted">Continue to your Spaces and archives.</p>

      {notice && (
        <p className="mt-3 rounded-lg bg-flash-50 px-3 py-2 text-[12px] text-flash-800">{notice}</p>
      )}

      {supabaseConfigIssue && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">{supabaseConfigIssue}</p>
      )}

      {isSupabaseMode && (
        <div className="mt-5">
          <GoogleButton remember={remember} disabled={busy} onError={setError} />
          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted">
            <span className="h-px flex-1 bg-line" />
            or use your email
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
        <label className="block">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@team.dev"
            autoComplete="email"
          />
        </label>

        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder="Your password"
          showStrength={false}
        />

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-line text-flash-600 focus:ring-flash-500"
            />
            Keep me signed in
          </label>
          <button
            type="button"
            onClick={() => navigate('/forgot-password')}
            className="text-[12px] font-medium text-flash-600 hover:underline"
          >
            Forgot password?
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
            <p className="flex items-start gap-2">
              <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
            {needsVerification && (
              <button
                onClick={() => navigate('/verify')}
                className="mt-1 pl-6 text-[12px] font-medium text-red-800 underline"
              >
                Open the verification page
              </button>
            )}
          </div>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-4 text-center text-[13px] text-muted">
        No account yet?{' '}
        <button onClick={() => navigate('/register')} className="font-medium text-flash-600 hover:underline">
          Register
        </button>
      </p>
    </AuthShell>
  );
}
