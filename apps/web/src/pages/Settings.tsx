import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AccountView } from '../api';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import TotpSettings from '../components/TotpSettings';
import { useToast } from '../components/ToastProvider';
import { passwordStrength } from '../lib/password';
import { fmtDateTime, timeAgo } from '../lib/format';
import { isSupabaseMode } from '../lib/supabase';
import type { AuthUser } from '../types';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * Account settings (Module 1.6).
 *
 * Every control performs a real operation against Supabase Auth / Postgres /
 * Storage through the API. When the project runs without Supabase keys the page
 * says so instead of pretending: only the local display name can be edited.
 */
export default function Settings({
  user,
  navigate,
  onSignedOut,
}: {
  user: AuthUser;
  navigate: (to: string) => void;
  onSignedOut: () => void | Promise<void>;
}) {
  const toast = useToast().toast;
  const fileInput = useRef<HTMLInputElement>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [cloudAvailable, setCloudAvailable] = useState(false);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [prefs, setPrefs] = useState({ notifyInApp: true, notifyEmail: true, productUpdates: false });
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [changingEmail, setChangingEmail] = useState(false);
  const [emailPending, setEmailPending] = useState<string | null>(null);

  const [legacyPassword, setLegacyPassword] = useState('');
  const [linking, setLinking] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { account: a } = await api.accountMe();
      setAccount(a);
      setCloudAvailable(true);
      setDisplayName(a.displayName);
      setPrefs({
        notifyInApp: a.preferences.notifyInApp,
        notifyEmail: a.preferences.notifyEmail,
        productUpdates: a.preferences.productUpdates,
      });
    } catch {
      // Local auth mode (or Supabase not configured): the cloud account
      // endpoints are unavailable, so show the reduced form.
      setCloudAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      if (cloudAvailable) {
        const { account: updated } = await api.updateAccount({
          displayName: displayName.trim(),
          preferences: prefs,
        });
        setAccount(updated);
        toast('Profile updated', 'success');
      } else {
        await api.updateProfile({ displayName: displayName.trim() });
        toast('Display name updated', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save changes', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const pickAvatar = (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      toast('Choose a PNG, JPEG, WebP or GIF image', 'error');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast('Image must be smaller than 2 MB', 'error');
      return;
    }
    setUploading(true);
    api
      .uploadAvatar(file)
      .then(({ account: updated }) => {
        setAccount(updated);
        toast('Profile picture updated', 'success');
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'Upload failed', 'error'))
      .finally(() => {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = '';
      });
  };

  const removeAvatar = async () => {
    try {
      const { account: updated } = await api.removeAvatar();
      setAccount(updated);
      toast('Profile picture removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the picture', 'error');
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast('New passwords do not match', 'error');
      return;
    }
    const check = passwordStrength(newPassword);
    if (check.problems.length > 0) {
      toast(check.problems[0]!, 'error');
      return;
    }
    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (!isSupabaseMode) {
        // The local API revokes every session on a password change, including
        // this one. Leave the stale signed-in shell immediately and explain
        // why the next screen asks for credentials again.
        sessionStorage.setItem(
          'flashspace.reauth-notice',
          'Your password was changed, so every session was signed out. Sign in again with your new password.',
        );
        await onSignedOut();
        navigate('/login');
        return;
      }
      toast('Password updated', 'success');
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'REAUTH_REQUIRED'
          ? 'Your current password is incorrect'
          : err instanceof Error
            ? err.message
            : 'Could not update the password',
        'error',
      );
    } finally {
      setChangingPassword(false);
    }
  };

  const changeEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setChangingEmail(true);
    try {
      const { pending } = await api.changeEmail(newEmail.trim().toLowerCase());
      setEmailPending(pending);
      setNewEmail('');
      if (!isSupabaseMode) await load();
      toast(
        isSupabaseMode ? 'Confirmation sent to the new address' : 'Sign-in email updated',
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the email change', 'error');
    } finally {
      setChangingEmail(false);
    }
  };

  const linkLegacy = async (event: React.FormEvent) => {
    event.preventDefault();
    setLinking(true);
    try {
      await api.linkLegacyAccount(user.email, legacyPassword);
      setLegacyPassword('');
      await load();
      toast('Existing account linked', 'success');
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED'
          ? 'Verify your email address first'
          : err instanceof Error
            ? err.message
            : 'Could not link the account',
        'error',
      );
    } finally {
      setLinking(false);
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const blob = await api.exportAccount();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `flashspace-account-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast('Export downloaded', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not export your data', 'error');
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount(deletePassword);
      toast('Your account has been deleted', 'success');
      setDeleteOpen(false);
      onSignedOut();
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'OWNED_SPACES_SHARED'
          ? err.message
          : err instanceof ApiError && err.code === 'REAUTH_REQUIRED'
            ? 'Your password is incorrect'
            : err instanceof Error
              ? err.message
              : 'Could not delete the account',
        'error',
      );
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-2xl text-sm text-muted">Loading account…</div>;
  }

  const initials = (account?.displayName ?? user.displayName)
    .split(' ')
    .map((p) => p.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Account settings</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Identity, security and the data tied to your FlashSpace account.
          </p>
        </div>
        <button onClick={() => navigate('/profile')} className="btn-secondary px-3 py-1.5 text-[12px]">
          View profile
        </button>
      </div>

      {!cloudAvailable && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {isSupabaseMode
            ? 'Cloud account features are unavailable — the API could not reach Supabase. Check the API logs and .env.'
            : 'Local development account: password, email, export and deletion work against SQLite. Profile pictures need Supabase Storage and stay disabled for now.'}
        </p>
      )}

      {/* Profile picture + identity */}
      <Section title="Profile" description="How you appear across FlashSpace.">
        <div className="flex items-center gap-4">
          {account?.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt="Your profile picture"
              className="h-16 w-16 rounded-full object-cover ring-1 ring-line"
            />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-flash-600 text-2xl font-bold text-white">
              {initials || <Icon name="user" size={24} />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-primary">{account?.displayName ?? user.displayName}</p>
            <p className="truncate text-[12px] text-muted">{account?.email ?? user.email}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {account
                ? account.emailVerified
                  ? 'Email verified'
                  : 'Email not verified'
                : 'Verification requires Supabase Auth'}
            </p>
          </div>
          {cloudAvailable && isSupabaseMode && (
            <div className="flex shrink-0 items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={AVATAR_TYPES.join(',')}
                className="hidden"
                onChange={(e) => pickAvatar(e.target.files?.[0])}
              />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="btn-secondary px-3 py-1.5 text-[12px]"
              >
                {uploading ? 'Uploading…' : account?.avatarPath ? 'Replace' : 'Upload'}
              </button>
              {account?.avatarPath && (
                <button onClick={removeAvatar} className="px-2 py-1.5 text-[12px] font-medium text-red-600 hover:underline">
                  Remove
                </button>
              )}
            </div>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-[12px]">
          <div>
            <dt className="text-muted">Application role</dt>
            <dd className="mt-0.5 font-medium text-primary">{account?.role ?? user.role}</dd>
          </div>
          <div>
            <dt className="text-muted">Member since</dt>
            <dd className="mt-0.5 font-medium text-primary">
              {account ? new Date(account.createdAt).toLocaleDateString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Account status</dt>
            <dd className="mt-0.5 font-medium text-primary">{account?.accountStatus ?? 'ACTIVE'}</dd>
          </div>
          <div>
            <dt className="text-muted">Email verified</dt>
            <dd className="mt-0.5 font-medium text-primary">
              {account?.emailVerified ? new Date(account.emailVerifiedAt!).toLocaleDateString() : 'Not verified'}
            </dd>
          </div>
        </dl>

        <form onSubmit={saveProfile} className="mt-5 space-y-4 border-t border-line pt-5">
          <label className="block">
            <span className="field-label">Display name</span>
            <input
              className="input"
              value={displayName}
              maxLength={80}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>

          {cloudAvailable && isSupabaseMode && (
            <fieldset className="space-y-2">
              <legend className="field-label">Email notifications</legend>
              {(
                [
                  ['notifyInApp', 'In-app notifications', 'Lifecycle warnings and membership updates in FlashSpace.'],
                  ['notifyEmail', 'Email notifications', 'Send important account and Space events to your inbox.'],
                  ['productUpdates', 'Product updates', 'Occasional news about new FlashSpace capabilities.'],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 rounded border-line text-flash-600 focus:ring-flash-500"
                    checked={prefs[key]}
                    onChange={(e) => setPrefs((p) => ({ ...p, [key]: e.target.checked }))}
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-primary">{label}</span>
                    <span className="block text-[11px] text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <button type="submit" disabled={savingProfile} className="btn-primary px-4 py-2 text-[13px]">
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </Section>

      {cloudAvailable && (
        <>
          {isSupabaseMode && (
            <Section
              title="Two-factor authentication"
              description="Require a rotating code from an authenticator app in addition to your password."
            >
              <TotpSettings />
            </Section>
          )}

          <Section
            title="Change password"
            description={
              isSupabaseMode
                ? 'You must confirm your current password first.'
                : 'Confirm your current password. Changing it signs you out on every device, including this one.'
            }
          >
            <form onSubmit={changePassword} className="space-y-4">
              <PasswordField
                label="Current password"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
                placeholder="Your current password"
              />
              <PasswordField
                label="New password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                showStrength
              />
              <PasswordField
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                placeholder="Repeat the new password"
              />
              {confirmPassword.length > 0 && confirmPassword !== newPassword && (
                <p className="text-[11px] text-red-600">Passwords do not match</p>
              )}
              <button type="submit" disabled={changingPassword} className="btn-primary px-4 py-2 text-[13px]">
                {changingPassword ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </Section>

          <Section
            title="Change email"
            description={
              isSupabaseMode
                ? 'Supabase sends a confirmation link to the new address; the change only applies once you open it.'
                : 'Local development: the new address takes effect immediately and must be unique.'
            }
          >
            <form onSubmit={changeEmail} className="space-y-3">
              <label className="block">
                <span className="field-label">Current email</span>
                <input className="input bg-slate-50" value={account?.email ?? user.email} readOnly />
              </label>
              <label className="block">
                <span className="field-label">New email</span>
                <input
                  className="input"
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="new@team.dev"
                  autoComplete="email"
                />
              </label>
              {emailPending && (
                <p className="rounded-lg bg-flash-50 px-3 py-2 text-[12px] text-flash-800">
                  {isSupabaseMode
                    ? `Confirmation sent to ${emailPending}. Your email stays unchanged until you confirm it.`
                    : `Your sign-in email is now ${emailPending}.`}
                </p>
              )}
              <button
                type="submit"
                disabled={changingEmail || !newEmail.trim()}
                className="btn-primary px-4 py-2 text-[13px]"
              >
                {changingEmail ? 'Saving…' : isSupabaseMode ? 'Send confirmation' : 'Change email'}
              </button>
            </form>
          </Section>

          {isSupabaseMode && (
          <Section
            title="Existing FlashSpace account"
            description="Registered before Supabase? Link your old account so its Spaces and files can migrate."
          >
            {account?.legacyLink ? (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                Linked to existing account {account.legacyLink.legacyProfileId.slice(0, 8)}… ({account.legacyLink.status}).
                Space ownership migration runs as a separate, verified step.
              </p>
            ) : (
              <form onSubmit={linkLegacy} className="space-y-3">
                <p className="text-[12px] text-muted">
                  Your Supabase email must be verified and must match the old account. You will need the old password —
                  this proves you own both accounts.
                </p>
                <PasswordField
                  label="Existing account password"
                  value={legacyPassword}
                  onChange={setLegacyPassword}
                  autoComplete="current-password"
                  placeholder="Password of the old FlashSpace account"
                />
                <button
                  type="submit"
                  disabled={linking || !legacyPassword}
                  className="btn-secondary px-4 py-2 text-[13px]"
                >
                  {linking ? 'Linking…' : 'Link existing account'}
                </button>
              </form>
            )}
          </Section>
          )}

          <Section
            title="Activity history"
            description="Your recent actions across Spaces. Only you can see this list."
          >
            <PersonalActivity />
          </Section>

          <Section title="Export your data" description="A JSON file with your profile, preferences and personal records.">
            <button onClick={exportData} disabled={exporting} className="btn-secondary px-4 py-2 text-[13px]">
              {exporting ? 'Preparing…' : 'Download JSON export'}
            </button>
            <p className="mt-2 text-[11px] text-muted">
              Passwords, tokens and verification secrets are never included.
            </p>
          </Section>

          <Section title="Delete account" description="Permanently removes your account, profile and sessions.">
            <div className="rounded-lg border border-red-200 bg-red-50/60 p-4">
              <p className="text-[12px] text-red-800">
                Spaces you own are deleted and your memberships revoked. Deletion is refused while a Space you own still
                has other active members — transfer or delete it first.
              </p>
              <button
                onClick={() => setDeleteOpen(true)}
                className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-red-700"
              >
                Delete my account
              </button>
            </div>
          </Section>
        </>
      )}

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl border border-line bg-white p-5 shadow-lg">
            <h2 className="font-display text-base font-bold text-primary">Delete your account?</h2>
            <p className="mt-1 text-[12px] text-muted">
              This cannot be undone. Enter your password to confirm.
            </p>
            <div className="mt-4">
              <PasswordField
                label="Password"
                value={deletePassword}
                onChange={setDeletePassword}
                autoComplete="current-password"
                placeholder="Your password"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletePassword('');
                }}
                className="btn-secondary px-4 py-2 text-[13px]"
              >
                Cancel
              </button>
              <button
                onClick={deleteAccount}
                disabled={deleting || !deletePassword}
                className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The account's own activity history (Module 12), read-only and self-scoped. */
function PersonalActivity() {
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.myActivity>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(10);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .myActivity({ limit })
      .then((result) => {
        if (!cancelled) setPage(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your activity');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadMyActivity({});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="skeleton h-24 w-full rounded-lg" />;
  if (error) return <p className="text-[12px] text-red-700">{error}</p>;
  if (!page || page.entries.length === 0) {
    return <p className="text-[13px] text-muted">No personal activity recorded yet.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100">
        {page.entries.map((entry) => (
          <li key={entry.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] text-primary">
                {entry.action.replace(/_/g, ' ').toLowerCase()}
              </p>
              <p className="text-[11px] text-muted">
                {entry.category} · {fmtDateTime(entry.createdAt)} · {timeAgo(entry.createdAt)}
              </p>
            </div>
            <span
              className={`badge flex-shrink-0 ${
                entry.outcome === 'FAILURE' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              {entry.outcome}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {page.total > limit && (
          <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setLimit(50)}>
            Show more ({page.total})
          </button>
        )}
        <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => void exportCsv()} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-6 shadow-xs">
      <h2 className="font-display text-base font-bold text-primary">{title}</h2>
      <p className="mt-0.5 text-[12px] text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
