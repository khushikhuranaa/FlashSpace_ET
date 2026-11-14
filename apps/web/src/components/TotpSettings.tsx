import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useToast } from './ToastProvider';
import { supabase } from '../lib/supabase';

interface TotpFactor {
  id: string;
  friendlyName: string | null;
  createdAt: string;
}

interface Enrolment {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * TOTP two-factor authentication (Supabase mode only).
 *
 * Supabase Auth owns the factor lifecycle: enrolling returns the otpauth QR
 * payload, verifying proves the authenticator app can produce a code, and the
 * session then requires AAL2 at sign-in (handled by the login page). Nothing
 * here stores secrets in the app — only Supabase's encrypted factor record.
 */
export default function TotpSettings() {
  const toast = useToast().toast;
  const [factors, setFactors] = useState<TotpFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      setError(listError.message);
    } else {
      setFactors(
        data.totp
          .filter((factor) => factor.status === 'verified')
          .map((factor) => ({
            id: factor.id,
            friendlyName: factor.friendly_name ?? null,
            createdAt: factor.created_at,
          })),
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startEnrolment = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      // Clear half-finished factors first: Supabase rejects more than one
      // unverified factor per method and they are useless afterwards.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const factor of existing?.totp ?? []) {
        if (factor.status !== 'verified') {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      });
      if (enrollError) {
        setError(enrollError.message);
        return;
      }
      setEnrolment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start two-factor setup');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrolment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase || !enrolment) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the six-digit code shown in your authenticator app');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: enrolment.factorId,
      });
      if (challengeError) {
        setError(challengeError.message);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: enrolment.factorId,
        challengeId: challenge.id,
        code: trimmed,
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      setEnrolment(null);
      setCode('');
      await refresh();
      toast('Two-factor authentication enabled', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the code');
    } finally {
      setBusy(false);
    }
  };

  const cancelEnrolment = async () => {
    const pending = enrolment;
    setEnrolment(null);
    setCode('');
    setError(null);
    if (pending && supabase) {
      await supabase.auth.mfa.unenroll({ factorId: pending.factorId }).catch(() => undefined);
    }
  };

  const disable = async (factorId: string) => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });
      if (unenrollError) {
        setError(unenrollError.message);
        return;
      }
      await refresh();
      toast('Two-factor authentication disabled', 'success');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="text-[12px] text-muted">Checking two-factor status…</p>;
  }

  if (enrolment) {
    return (
      <div className="space-y-4">
        <p className="text-[12px] text-muted">
          Scan this code with an authenticator app (1Password, Google Authenticator, Authy), then enter the
          six-digit code it shows.
        </p>
        <div className="flex justify-center rounded-lg border border-line bg-white p-4">
          {/* Supabase returns the otpauth QR as an inline SVG string. */}
          <div className="h-44 w-44" dangerouslySetInnerHTML={{ __html: enrolment.qrCode }} />
        </div>
        <div>
          <p className="field-label">Manual setup key</p>
          <code className="mt-1 block break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[12px] text-primary">
            {enrolment.secret}
          </code>
        </div>
        <form onSubmit={confirmEnrolment} className="space-y-3">
          <label className="block">
            <span className="field-label">Authentication code</span>
            <input
              className="input tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
            />
          </label>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-[13px]">
              {busy ? 'Verifying…' : 'Enable two-factor'}
            </button>
            <button
              type="button"
              onClick={() => void cancelEnrolment()}
              disabled={busy}
              className="btn-secondary px-3 py-2 text-[13px]"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {factors.length === 0 ? (
        <p className="text-[12px] text-muted">
          No authenticator app is linked. Adding one means every sign-in asks for a rotating six-digit code.
        </p>
      ) : (
        <ul className="space-y-2">
          {factors.map((factor) => (
            <li
              key={factor.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="shield" size={16} className="shrink-0 text-flash-600" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-primary">
                    {factor.friendlyName ?? 'Authenticator app'}
                  </span>
                  <span className="block text-[11px] text-muted">
                    Added {new Date(factor.createdAt).toLocaleDateString()}
                  </span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => void disable(factor.id)}
                disabled={busy}
                className="shrink-0 px-2 py-1 text-[12px] font-medium text-red-600 hover:underline"
              >
                Disable
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-[12px] text-red-600">{error}</p>}

      {factors.length === 0 && (
        <button
          type="button"
          onClick={() => void startEnrolment()}
          disabled={busy}
          className="btn-secondary px-4 py-2 text-[13px]"
        >
          {busy ? 'Starting…' : 'Set up two-factor authentication'}
        </button>
      )}
    </div>
  );
}
