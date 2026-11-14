import { useState } from 'react';
import { api, ApiError } from '../api';
import { PasswordField } from '../components/PasswordField';
import { GoogleButton } from '../components/GoogleButton';
import { Icon } from '../components/Icon';
import { isValidEmail, passwordStrength } from '../lib/password';
import { authRedirectTo, isSupabaseMode, supabase } from '../lib/supabase';
import type { AuthUser } from '../types';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Registration (Module 1.1).
 *
 * Supabase Auth creates the account; the profile row is created by the
 * `on_auth_user_created` trigger, so there is exactly one profile per auth user
 * and no way to self-assign ADMIN from the sign-up form.
 */
export default function Register({
  onAuthenticated,
  navigate,
}: {
  onAuthenticated?: (user: AuthUser) => void;
  navigate: (to: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingVerification, setAwaitingVerification] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const timer = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) clearInterval(timer);
        return s - 1;
      });
    }, 1000);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) return setError('Enter a display name');
    if (!isValidEmail(email)) return setError('Enter a valid email address');
    if (password !== confirm) return setError('Passwords do not match');
    const check = passwordStrength(password, email);
    if (check.problems.length > 0) return setError(check.problems[0]!);

    setBusy(true);
    try {
      if (isSupabaseMode && supabase) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: { display_name: displayName.trim() },
            emailRedirectTo: authRedirectTo('/verify'),
          },
        });
        if (signUpError) throw signUpError;

        if (data.session) {
          // Email confirmation is disabled on the project: the user is in.
          onAuthenticated?.({
            id: data.user?.id ?? '',
            email: data.user?.email ?? email,
            displayName: displayName.trim(),
            role: 'USER',
          });
          navigate('/dashboard');
          return;
        }
        // Confirmation required. Supabase intentionally returns a user object
        // for an existing address too, so show one non-revealing message.
        setAwaitingVerification(email.trim().toLowerCase());
        return;
      }

      const result = await api.register(email, password, displayName);
      onAuthenticated?.(result.user);
      navigate('/dashboard');
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong';
      setError(
        /already registered|already exists/i.test(message)
          ? 'An account with that email already exists. Sign in instead.'
          : /rate limit|too many/i.test(message)
            ? 'Too many attempts. Please wait a minute and try again.'
            : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!supabase || !awaitingVerification || cooldown > 0) return;
    setResent(false);
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: awaitingVerification,
      options: { emailRedirectTo: authRedirectTo('/verify') },
    });
    if (resendError) {
      setError(/rate limit|too many/i.test(resendError.message)
        ? 'Supabase is rate-limiting verification emails. Try again in a few minutes.'
        : resendError.message);
      return;
    }
    setResent(true);
    startCooldown();
  };

  if (awaitingVerification) {
    return (
      <AuthShell onBack={() => navigate('/')}>
        <div className="text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-flash-50 text-flash-600">
            <Icon name="mail" size={20} />
          </div>
          <h1 className="mt-3 font-display text-xl font-bold text-primary">Check your inbox</h1>
          <p className="mt-2 text-[13px] text-muted">
            We sent a verification link to <span className="font-medium text-primary">{awaitingVerification}</span>.
            Open it to activate your account.
          </p>
          <p className="mt-2 text-[12px] text-muted">
            Supabase's built-in mailer is rate limited; if nothing arrives within a few minutes, resend below.
          </p>
          {resent && <p className="mt-2 text-[12px] text-emerald-600">Verification email sent again.</p>}
          {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
          <div className="mt-5 flex items-center justify-center gap-3">
            <button onClick={resend} disabled={cooldown > 0} className="btn-secondary px-4 py-2 text-[13px]">
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
            </button>
            <button onClick={() => navigate('/login')} className="btn-primary px-4 py-2 text-[13px]">
              Go to sign in
            </button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell onBack={() => navigate('/')}>
      <h1 className="font-display text-xl font-bold text-primary">Create your account</h1>
      <p className="mt-1 text-[13px] text-muted">
        {isSupabaseMode
          ? 'We will email you a link to verify your address.'
          : 'Create your FlashSpace account.'}
      </p>

      {isSupabaseMode && (
        <div className="mt-5">
          <GoogleButton disabled={busy} onError={setError} />
          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted">
            <span className="h-px flex-1 bg-line" />
            or use your email
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
        <label className="block">
          <span className="field-label">Display name</span>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Ada Lovelace"
            autoComplete="name"
            required
            maxLength={80}
          />
        </label>

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
            aria-invalid={email.length > 0 && !isValidEmail(email)}
          />
          {email.length > 0 && !isValidEmail(email) && (
            <span className="mt-1 block text-[11px] text-red-600">Enter a valid email address</span>
          )}
        </label>

        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          email={email}
          autoComplete="new-password"
          showStrength
        />

        <PasswordField
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          placeholder="Repeat your password"
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
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-center text-[13px] text-muted">
        Already have an account?{' '}
        <button onClick={() => navigate('/login')} className="font-medium text-flash-600 hover:underline">
          Sign in
        </button>
      </p>
    </AuthShell>
  );
}

const BRAND_MARK = (
  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-flash-50" aria-hidden="true">
    <svg
      className="h-4 w-4 text-flash-600"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.5 19a3.5 3.5 0 0 0 5 0H6.5a3.5 3.5 0 0 0 3.5 3.42V7.75a3.5 3.5 0 0 0-2.27-3.27L5 2h14z" />
      <path d="M9.5 11.5 12 14l2.5-2.5" />
    </svg>
  </span>
);

export function AuthShell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface px-4 py-12">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-1/3 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-flash-50/80 via-flash-100/30 to-white/40 blur-3xl" />
      </div>
      <div className="relative z-10 w-full max-w-md">
        <button onClick={onBack} className="mb-6 flex items-center gap-2.5 rounded-lg">
          {BRAND_MARK}
          <span className="font-display text-lg font-bold tracking-tight text-primary">FlashSpace</span>
        </button>
        <div className="rounded-xl border border-line bg-white p-7 shadow-xs">{children}</div>
        <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-muted">
          <a href="#/privacy" className="rounded hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500">
            Privacy Policy
          </a>
          <a href="#/terms" className="rounded hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-flash-500">
            Terms of Service
          </a>
        </div>
      </div>
    </div>
  );
}


