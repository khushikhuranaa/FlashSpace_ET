import { useState } from 'react';
import { api } from '../api';
import type { AuthUser } from '../types';
import { Icon } from '../components/Icon';

export default function Login({
  onAuthenticated,
  navigate,
}: {
  onAuthenticated: (u: AuthUser) => void;
  navigate: (to: string) => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password, displayName || email.split('@')[0]!);
      onAuthenticated(r.user);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError(null);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface px-4 py-12">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-1/3 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-flash-100/70 via-purple-100/30 to-blue-50/40 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <button
          onClick={() => navigate('/')}
          className="mb-6 flex items-center gap-2.5 rounded-lg"
        >
          <span className="font-display text-lg font-bold tracking-tight text-primary">FlashSpace</span>
        </button>

        <div className="rounded-xl border border-line bg-white p-7 shadow-xs">
          <h1 className="font-display text-xl font-bold text-primary">
            {mode === 'login' ? 'Sign in to FlashSpace' : 'Create your account'}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {mode === 'login'
              ? 'Continue to your Spaces and archives.'
              : 'The first account on a fresh install becomes an administrator.'}
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === 'register' && (
              <label className="block">
                <span className="field-label">Display name</span>
                <input
                  className="input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                />
              </label>
            )}
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
            <label className="block">
              <span className="field-label">Password</span>
              <input
                className="input"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </label>

            {error && (
              <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
                <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="mt-4 text-center text-[13px] text-muted">
            {mode === 'login' ? 'No account yet? ' : 'Already have an account? '}
            <button onClick={switchMode} className="font-medium text-flash-600 hover:underline">
              {mode === 'login' ? 'Register' : 'Sign in'}
            </button>
          </p>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          Sessions are issued by the FlashSpace API. Credentials are never stored on this device.
        </p>
      </div>
    </div>
  );
}
