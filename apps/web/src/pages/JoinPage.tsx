import { useEffect, useState } from 'react';
import { getToken } from '../api';
import type { SpaceJoinPreview, JoinRequestView } from '../types';
import { Icon } from '../components/Icon';
import { useToast } from '../components/ToastProvider';

const API = import.meta.env.VITE_API_URL ?? '/api';

export default function JoinPage({
  token,
  navigate,
  goBack,
}: {
  token: string;
  user: { displayName: string };
  navigate: (to: string) => void;
  goBack: () => void;
}) {
  const toast = useToast().toast;
  const [preview, setPreview] = useState<SpaceJoinPreview | null>(null);
  const [request, setRequest] = useState<JoinRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/join-links/${token}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (!res.ok) throw new Error('This invite link is invalid or has been revoked');
        const body = await res.json();
        if (!cancelled) setPreview(body.space);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'This invite link is not valid');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const requestJoin = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API}/join-links/${token}/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not request to join');
      }
      const body = await res.json();
      setRequest(body.request);
      toast('Join request sent to the owner', 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not request to join';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="text-[13px] text-muted">Loading invite…</div>;

  if (error && !preview) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-line bg-white p-6 text-center shadow-xs">
        <Icon name="alert-circle" size={32} className="mx-auto text-red-500" />
        <p className="mt-3 text-[14px] font-medium text-primary">{error}</p>
        <button className="btn-secondary mt-4" onClick={goBack}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <button onClick={goBack} className="flex items-center gap-1 text-[13px] text-muted hover:text-primary">
        <Icon name="arrow-left" size={16} />
        Back
      </button>

      {preview && (
        <div className="rounded-xl border border-line bg-white p-6 shadow-xs">
          <span className="badge bg-flash-50 text-flash-700">Invitation</span>
          <h1 className="mt-3 font-display text-xl font-bold tracking-tight text-primary">{preview.name}</h1>
          <p className="mt-1 text-[13px] text-muted">{preview.purpose}</p>
          {preview.description && <p className="mt-1 text-[13px] text-slate-500">{preview.description}</p>}

          <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-4 text-[13px]">
            <Row label="Owner" value={preview.ownerDisplayName} />
            <Row label="Members" value={String(preview.memberCount)} />
            <Row label="Role if accepted" value={preview.role} />
          </div>

          {preview.alreadyMember ? (
            <p className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700">
              <Icon name="check-circle" size={16} />
              You are already a member of this Space.
            </p>
          ) : preview.hasPendingRequest || request ? (
            <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
              <p className="flex items-center gap-2 font-medium">
                <Icon name="clock" size={16} />
                Your request is pending
              </p>
              <p className="mt-1 text-[12px]">The owner will accept or decline it.</p>
            </div>
          ) : (
            <button className="btn-primary mt-4 w-full" onClick={() => void requestJoin()} disabled={busy}>
              <Icon name="user-plus" size={16} />
              {busy ? 'Sending…' : 'Request to join'}
            </button>
          )}

          {error && <p className="mt-3 text-[12px] text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4 text-[12px]">
            <button onClick={() => navigate('/dashboard')} className="font-medium text-flash-700 hover:underline">
              Go to dashboard
            </button>
          </div>
        </div>
      )}

      {request && (
        <div className="rounded-lg border border-line bg-white p-4 text-[13px] shadow-xs">
          <p className="flex items-center gap-2 font-medium text-primary">
            <Icon name="check-circle" size={16} className="text-emerald-600" />
            Request submitted
          </p>
          <p className="mt-1 text-muted">
            {request.requesterDisplayName} · {request.role} · {request.spaceName}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-primary">{value}</span>
    </div>
  );
}
