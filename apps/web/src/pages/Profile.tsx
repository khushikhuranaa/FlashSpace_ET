import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Archive, AuthUser, SpaceDetail, StorageSummary } from '../types';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { fmtBytes } from '../lib/format';

export default function ProfilePage({
  user,
  onUserUpdated,
}: {
  user: AuthUser;
  onUserUpdated: (user: AuthUser) => void;
}) {
  const toast = useToast().toast;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [spaceList, vault, summary] = await Promise.all([
      api.listSpaces(),
      api.vault(),
      api.storageSummary(),
    ]);
    setSpaces(spaceList.spaces.filter((s) => s.ownerId === user.id));
    setArchives(vault.archives);
    setStorage(summary);
  }, [user.id]);

  useEffect(() => {
    load().catch(() => {
      /* counters fall back to zeros; the form still works */
    });
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      toast('Display name cannot be empty', 'error');
      return;
    }
    setBusy(true);
    try {
      const { user: updated } = await api.updateProfile({ displayName: name });
      onUserUpdated(updated);
      toast('Display name updated', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update profile', 'error');
    } finally {
      setBusy(false);
    }
  };

  const initials = user.displayName
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">Profile</h1>
        <p className="mt-0.5 text-[13px] text-muted">Your identity and a snapshot of what you own.</p>
      </div>

      <div className="rounded-xl border border-line bg-white p-6 shadow-xs">
        <div className="flex items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-flash-600 text-2xl font-bold text-white">
            {initials}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-display text-xl font-bold text-primary">{user.displayName}</h2>
            <p className="truncate text-[13px] text-muted">{user.email}</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <Metric label="Role" value={user.role === 'ADMIN' ? 'Administrator' : 'Member'} />
          <Metric label="Spaces owned" value={String(spaces.length)} />
          <Metric label="Vault archives" value={String(archives.length)} />
          <Metric label="Storage used" value={fmtBytes(storage?.usedBytes ?? 0)} />
        </div>

        <form onSubmit={save} className="mt-6 border-t border-line pt-6">
          <label className="block">
            <span className="field-label">Display name</span>
            <div className="flex gap-2">
              <input
                className="input"
                value={displayName}
                maxLength={80}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || displayName.trim() === user.displayName}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </label>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Icon name="lock" size={13} />
            Email and password are managed by the API; 1–80 characters for the display name.
          </p>
        </form>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-bold text-primary">{value}</p>
    </div>
  );
}
