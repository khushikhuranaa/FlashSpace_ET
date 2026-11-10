import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Archive, AuthUser, SpaceDetail, StorageSummary } from '../types';
import { SpaceCard } from '../components/SpaceCard';
import { StatCard } from '../components/StatCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { compactRemaining, fmtBytes, fmtDate, toDateTimeLocal } from '../lib/format';

type Filter = 'all' | 'ACTIVE' | 'WARNING' | 'ARCHIVED';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard({
  user,
  navigate,
}: {
  user: AuthUser;
  navigate: (to: string) => void;
}) {
  const toast = useToast().toast;
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'archive' | 'delete'; space: SpaceDetail } | null>(null);

  const load = useCallback(async () => {
    const [spaceList, summary, vault] = await Promise.all([
      api.listSpaces(),
      api.storageSummary(),
      api.vault(),
    ]);
    setSpaces(spaceList.spaces);
    setStorage(summary);
    setArchives(vault.archives);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load your Spaces'));
  }, [load]);

  const spaceById = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);

  const now = Date.now();
  const counts = useMemo(() => {
    const live = spaces.filter((s) => ['DRAFT', 'ACTIVE', 'WARNING', 'ARCHIVING'].includes(s.status));
    const expiring = spaces.filter(
      (s) =>
        s.status === 'WARNING' ||
        (['ACTIVE', 'DRAFT'].includes(s.status) && new Date(s.expiryAt).getTime() - now < 48 * 3_600_000),
    );
    return {
      all: spaces.length,
      active: live.length,
      expiring: expiring.length,
      archived: spaces.filter((s) => s.status === 'ARCHIVED').length,
    };
  }, [spaces, now]);

  const expiringSpaces = spaces.filter(
    (s) =>
      s.status === 'WARNING' ||
      (['ACTIVE', 'DRAFT'].includes(s.status) && new Date(s.expiryAt).getTime() - now < 48 * 3_600_000),
  );

  const visible = useMemo(() => {
    if (filter === 'all') return spaces;
    if (filter === 'WARNING') return expiringSpaces;
    return spaces.filter((s) => s.status === filter);
  }, [filter, spaces, expiringSpaces]);

  const doArchive = async (space: SpaceDetail) => {
    setBusy(true);
    try {
      await api.archiveSpace(space.id);
      await load();
      toast(`"${space.name}" archived to your Vault`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Archive failed', 'error');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const doDelete = async (space: SpaceDetail) => {
    setBusy(true);
    try {
      await api.deleteSpace(space.id);
      await load();
      toast(`"${space.name}" deleted`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const usedPercent = storage && storage.quotaBytes > 0
    ? Math.min(100, Math.round((storage.usedBytes / storage.quotaBytes) * 100))
    : 0;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">
            {greeting()}, {user.displayName.split(' ')[0]}
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Manage your temporary workspaces, countdowns, and archives.
          </p>
        </div>
        <button
          onClick={() => setShowForm((open) => !open)}
          className="btn-primary self-start px-3.5 py-2"
        >
          <Icon name={showForm ? 'x' : 'plus'} size={16} />
          {showForm ? 'Close form' : 'Create New Space'}
        </button>
      </section>

      {showForm && <CreateSpaceForm onCreated={(id) => navigate(`/spaces/${id}`)} onCancel={() => setShowForm(false)} />}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active Spaces"
          value={counts.active}
          hint="Ephemeral workspaces"
          icon="grid"
        />
        <StatCard
          label="Expiring Soon"
          value={counts.expiring}
          hint="Requires action (under 48h)"
          chip="Requires action"
        />
        <StatCard
          label="Ephemeral Storage"
          value={fmtBytes(storage?.usedBytes ?? 0)}
          hint={`of ${fmtBytes(storage?.quotaBytes ?? 0)} allocated`}
        >
          <div className="mt-2 space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-flash-600" style={{ width: `${usedPercent}%` }} />
            </div>
            <p className="font-mono text-[11px] text-muted">{usedPercent}% used</p>
          </div>
        </StatCard>
        <StatCard
          label="Vault Archives"
          value={`${archives.length} ZIP${archives.length === 1 ? '' : 's'}`}
          hint="Verified snapshots stored"
          icon="archive"
        />
      </section>

      {error && (
        <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <Icon name="alert-circle" size={16} />
          {error}
        </p>
      )}

      {expiringSpaces.length > 0 && (
        <section className="space-y-2">
          {expiringSpaces.map((space) => (
            <div
              key={space.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
            >
              <span className="flex items-center gap-2 text-[13px] text-amber-800">
                <Icon name="alert" size={15} />
                <strong className="font-semibold">{space.name}</strong>
                <span className="text-amber-700">
                  closes in {compactRemaining(space.expiryAt)} — request an extension before it archives.
                </span>
              </span>
              <button
                onClick={() => navigate(`/spaces/${space.id}/extensions`)}
                className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
              >
                Review
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-display text-base font-bold tracking-tight text-primary">
            Your Workspaces
          </h2>
          <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100/90 p-1 text-[12px] font-medium text-muted">
            {([
              ['all', `All (${counts.all})`],
              ['ACTIVE', `Active (${counts.active})`],
              ['WARNING', `Expiring (${counts.expiring})`],
              ['ARCHIVED', `Archived (${counts.archived})`],
            ] as [Filter, string][]).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  filter === value
                    ? 'bg-white font-semibold text-primary shadow-xs'
                    : 'hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {visible.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visible.map((space) => (
              <SpaceCard
                key={space.id}
                space={space}
                onOpen={() => navigate(`/spaces/${space.id}`)}
                canManage={space.role === 'OWNER'}
                onArchive={space.role === 'OWNER' && space.status !== 'ARCHIVED' ? () => setPending({ kind: 'archive', space }) : undefined}
                onDelete={space.role === 'OWNER' ? () => setPending({ kind: 'delete', space }) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
            <Icon name="folder" size={40} className="mx-auto text-slate-300" />
            <p className="mt-3 text-[14px] font-medium text-primary">
              {filter === 'ARCHIVED' ? 'No archived Spaces yet' : 'No Spaces here yet'}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              {filter === 'ARCHIVED'
                ? 'Archived Spaces appear here and in the Vault.'
                : 'Create a Space to give this work a deadline.'}
            </p>
            {filter !== 'ARCHIVED' && (
              <button onClick={() => setShowForm(true)} className="btn-primary mt-4">
                <Icon name="plus" size={16} />
                Create your first Space
              </button>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-base font-bold tracking-tight text-primary">Your Vault</h2>
          <button
            onClick={() => navigate('/vault')}
            className="flex items-center gap-1 text-[12px] font-medium text-flash-700 hover:underline"
          >
            Open Vault
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
        {archives.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-[13px] text-muted">
            No archives yet. When a Space closes or is archived, its verified ZIP appears here.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {archives.slice(0, 4).map((archive) => (
              <button
                key={archive.id}
                onClick={() => navigate('/vault')}
                className="flex items-center justify-between rounded-xl border border-line bg-white p-4 text-left shadow-xs transition-colors hover:border-slate-300"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-flash-500 to-purple-500 text-white">
                    <Icon name="archive" size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-primary">
                      {spaceById.get(archive.spaceId)?.name ?? 'Removed Space'}.zip
                    </span>
                    <span className="block text-[11px] text-muted">
                      {archive.fileCount} files · {fmtBytes(archive.sizeBytes)} · {fmtDate(archive.createdAt)}
                    </span>
                  </span>
                </span>
                <Icon name="chevron-right" size={16} className="flex-shrink-0 text-slate-400" />
              </button>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'delete' ? 'Delete this Space?' : 'Archive this Space?'}
        message={
          pending?.kind === 'delete'
            ? `"${pending.space.name}" will be removed from every listing. This cannot be undone.`
            : pending
              ? `"${pending.space.name}" will be packaged into your Vault and members lose write access immediately.`
              : ''
        }
        confirmLabel={pending?.kind === 'delete' ? 'Delete permanently' : 'Archive Space'}
        tone={pending?.kind === 'delete' ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={() => {
          if (!pending) return;
          void (pending.kind === 'delete' ? doDelete(pending.space) : doArchive(pending.space));
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function CreateSpaceForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const toast = useToast().toast;
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState(toDateTimeLocal(now.toISOString()));
  const [expiryAt, setExpiryAt] = useState(toDateTimeLocal(weekAhead.toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !purpose.trim()) {
      setError('A name and a purpose are required.');
      return;
    }
    if (new Date(expiryAt).getTime() <= new Date(startAt).getTime()) {
      setError('The expiry must be after the start time.');
      return;
    }
    setBusy(true);
    try {
      const { space } = await api.createSpace({
        name: name.trim(),
        purpose: purpose.trim(),
        description: description.trim(),
        startAt: new Date(startAt).toISOString(),
        expiryAt: new Date(expiryAt).toISOString(),
      });
      toast(`Space "${space.name}" created`, 'success');
      onCreated(space.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the Space');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-white p-6 shadow-xs">
      <h2 className="font-display text-lg font-bold text-primary">Create a Space</h2>
      <p className="mt-1 text-[13px] text-muted">
        Set a purpose and an end time. The Space archives itself when the countdown reaches zero.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Space name</span>
          <input
            className="input"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="VIBE HACK 2026"
          />
        </label>
        <label className="block">
          <span className="field-label">Purpose</span>
          <input
            className="input"
            required
            maxLength={300}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Weekend hackathon project"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="field-label">Description (optional)</span>
          <textarea
            className="input resize-none"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What will this Space hold?"
          />
        </label>
        <label className="block">
          <span className="field-label">Starts</span>
          <input
            className="input"
            type="datetime-local"
            required
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Expires</span>
          <input
            className="input"
            type="datetime-local"
            required
            value={expiryAt}
            onChange={(e) => setExpiryAt(e.target.value)}
          />
        </label>
      </div>

      <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-muted">
        <Icon name="shield" size={15} className="mt-0.5 flex-shrink-0 text-slate-400" />
        File size and per-Space quotas are enforced by the API. Members can be invited after the
        Space exists.
      </p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create Space'}
        </button>
      </div>
    </form>
  );
}
