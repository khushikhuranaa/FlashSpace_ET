import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import type { SpaceJoinPreview } from '../types';
import type { SpaceInvitation } from '@flashspace/shared';

interface InvitationResponse {
  id: string;
  spaceId: string;
  email: string;
  intendedRole: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}
import { Icon } from '../components/Icon';
import { useToast } from '../components/ToastProvider';

const API = import.meta.env.VITE_API_URL ?? '/api';

export default function JoinPage({
  token,
  user,
  navigate,
  goBack,
}: {
  token: string;
  user: { displayName: string; email: string };
  navigate: (to: string) => void;
  goBack: () => void;
}) {
  const toast = useToast().toast;
  const [preview, setPreview] = useState<SpaceJoinPreview | null>(null);
  const [invitation, setInvitation] = useState<InvitationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [invitationStatus, setInvitationStatus] = useState<'unknown' | 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked' | 'already-accepted'>('unknown');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // First try the API method which handles both invite links and email invitations
        try {
          const result = await api.validateInvitation(token);
          if (!cancelled) {
            setInvitation(result.invitation);
            setPreview({
              spaceId: result.invitation.spaceId,
              name: result.invitationSpaceName,
              purpose: result.invitationSpacePurpose,
              description: result.invitationSpaceDescription,
              ownerDisplayName: result.inviterDisplayName,
              memberCount: result.memberCount,
              role: result.invitation.intendedRole,
              alreadyMember: result.alreadyMember,
              hasPendingRequest: false,
            });

            // Determine status
            if (result.invitation.status === 'ACCEPTED') {
              setInvitationStatus('already-accepted');
            } else if (result.invitation.status === 'EXPIRED') {
              setInvitationStatus('expired');
            } else if (result.invitation.status === 'REVOKED') {
              setInvitationStatus('revoked');
            } else {
              setInvitationStatus('pending');
            }
          }
        } catch (e) {
          // If validation fails, try the invite link preview as fallback
          const previewRes = await fetch(`${API}/join-links/${token}/preview`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          });

          if (previewRes.ok) {
            const body = await previewRes.json();
            if (!cancelled) {
              setPreview(body.space);
              setInvitationStatus('pending');
            }
          } else {
            if (!cancelled) {
              setError('This invite link is invalid or has been revoked');
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'This invite link is not valid');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = async () => {
    setBusy(true);
    try {
      await api.acceptInvitation(token);
      toast('Invitation accepted! Welcome to the Space.', 'success');
      setInvitationStatus('accepted');
      // After acceptance, navigate to the Space
      if (preview) {
        navigate(`/spaces/${preview.spaceId}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not accept invitation';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    setBusy(true);
    try {
      await api.declineInvitation(token);
      toast('Invitation declined', 'success');
      setInvitationStatus('declined');
      goBack();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not decline invitation';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="text-[13px] text-muted">Loading invite…</div>;

  // Handle already accepted invitation
  if (invitationStatus === 'already-accepted' && preview) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-line bg-white p-6 text-center shadow-xs">
        <Icon name="check-circle" size={48} className="mx-auto text-emerald-500" />
        <h1 className="mt-4 font-display text-xl font-bold tracking-tight text-primary">Welcome to {preview.name}</h1>
        <p className="mt-2 text-[13px] text-muted">
          You've already accepted this invitation.
        </p>
        <button
          className="btn-primary mt-4"
          onClick={() => navigate(`/spaces/${preview.spaceId}`)}
        >
          Open Space
        </button>
        <button className="btn-secondary mt-3" onClick={goBack}>
          Back
        </button>
      </div>
    );
  }

  // Handle expired invitation
  if (invitationStatus === 'expired' && preview) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-line bg-white p-6 text-center shadow-xs">
        <Icon name="clock" size={48} className="mx-auto text-amber-500" />
        <h1 className="mt-4 font-display text-xl font-bold tracking-tight text-primary">Invitation Expired</h1>
        <p className="mt-2 text-[13px] text-muted">
          This invitation for {preview.name} has expired.
        </p>
        <p className="mt-1 text-[12px] text-slate-500">
          Ask the Space owner to send a new invitation.
        </p>
        <button className="btn-secondary mt-4" onClick={goBack}>
          Back
        </button>
      </div>
    );
  }

  // Handle revoked invitation
  if (invitationStatus === 'revoked' && preview) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-line bg-white p-6 text-center shadow-xs">
        <Icon name="x" size={48} className="mx-auto text-red-500" />
        <h1 className="mt-4 font-display text-xl font-bold tracking-tight text-primary">Invitation Revoked</h1>
        <p className="mt-2 text-[13px] text-muted">
          This invitation for {preview.name} has been revoked.
        </p>
        <p className="mt-1 text-[12px] text-slate-500">
          The Space owner cancelled this invitation.
        </p>
        <button className="btn-secondary mt-4" onClick={goBack}>
          Back
        </button>
      </div>
    );
  }

  // Handle invalid token
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

  // Show the invitation preview
  if (preview) {
    const showActions = invitationStatus === 'pending' && user.email;

    return (
      <div className="mx-auto max-w-lg space-y-4">
        <button onClick={goBack} className="flex items-center gap-1 text-[13px] text-muted hover:text-primary">
          <Icon name="arrow-left" size={16} />
          Back
        </button>

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
          ) : (
            <>
              {!user.email ? (
                <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
                  <p className="font-medium">Sign in or create an account to accept</p>
                  <p className="mt-1 text-[12px]">You need to be signed in to accept this invitation.</p>
                  <div className="mt-3 flex flex-col gap-2">
                    <button
                      className="btn-primary w-full"
                      onClick={() => navigate('/login?redirect=/join/' + token)}
                    >
                      Sign in
                    </button>
                    <button
                      className="btn-secondary w-full"
                      onClick={() => navigate('/register?redirect=/join/' + token)}
                    >
                      Create account
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
                    <p className="font-medium">You're signed in as {user.email}</p>
                    <p className="mt-1 text-[12px] text-muted">
                      Accepting will give you {preview.role} access to this Space.
                    </p>
                  </div>

                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      className="btn-primary w-full"
                      onClick={() => void handleAccept()}
                      disabled={busy}
                    >
                      <Icon name="check" size={16} />
                      {busy ? 'Accepting…' : 'Accept invitation'}
                    </button>
                    <button
                      className="btn-secondary w-full"
                      onClick={() => void handleDecline()}
                      disabled={busy}
                    >
                      Decline invitation
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {error && <p className="mt-3 text-[12px] text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4 text-[12px]">
            <button onClick={() => navigate('/dashboard')} className="font-medium text-flash-700 hover:underline">
              Go to dashboard
            </button>
          </div>
        </div>

        {invitationStatus === 'accepted' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-[13px] shadow-xs">
            <p className="flex items-center gap-2 font-medium text-emerald-700">
              <Icon name="check-circle" size={16} />
              Invitation accepted!
            </p>
            <p className="mt-1 text-muted">
              Redirecting to the Space…
            </p>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-primary">{value}</span>
    </div>
  );
}
