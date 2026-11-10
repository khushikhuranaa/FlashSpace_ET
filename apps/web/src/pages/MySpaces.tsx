import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AuthUser, SpaceDetail, StorageSummary } from '../types';
import { SpaceCard } from '../components/SpaceCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { fmtBytes } from '../lib/format';

type Tab = 'active' | 'archived';

export default function MySpaces({
  user,
  navigate,
}: {
  user: AuthUser;
  navigate: (to: string) => void;
}) {
  const toast = useToast().toast;
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'archive' | 'delete'; space: SpaceDetail } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [spaceList, summary] = await Promise.all([api.listSpaces(), api.storageSummary()]);
    setSpaces(spaceList.spaces.filter((s) => s.ownerId === user.id));
    setStorage(summary);
  }, [user.id]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load your Spaces'));
  }, [load]);

  const owned = useMemo(
    () => ({
      active: spaces.filter((s) => s.status !== 'ARCHIVED'),
      archived: spaces.filter((s) => s.status === 'ARCHIVED'),
    }),
    [spaces],
  );

  const activeBytes = storage ? Math.max(0, storage.usedBytes - storage.archivedBytes) : 0;
  const quota = storage?.quotaBytes ?? 0;
  const archivedBytes = storage?.archivedBytes ?? 0;
  const freeBytes = storage?.freeBytes ?? 0;
  const pct = (value: number) => (quota > 0 ? Math.min(100, (value / quota) * 100) : 0);

  const doArchive = async (space: SpaceDetail) => {
    setBusy(true);
    try {
      await api.archiveSpace(space.id);
      await load();
      toast(`"${space.name}" archived`, 'success');
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

  const list = owned[tab];

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">My Spaces</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Workspaces you created, their storage footprint, and archives.
          </p>
        </div>
        <button onClick={() => navigate('/dashboard')} className="btn-primary self-start px-3.5 py-2">
          <Icon name="plus" size={16} />
          Create New Space
        </button>
      </section>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}

      <section className="rounded-xl border border-line bg-white p-4 shadow-xs">
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2 font-display text-[13px] font-bold tracking-tight text-primary">
            <Icon name="hard-drive" size={18} className="text-slate-400" />
            Storage Usage
          </span>
          <span className="font-mono text-[11px] text-muted">
            {Math.round(pct(activeBytes + archivedBytes))}% used
          </span>
        </div>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full bg-flash-600"
            style={{ width: `${pct(activeBytes)}%`, minWidth: activeBytes > 0 ? 4 : 0 }}
          />
          <div
            className="h-full bg-purple-500"
            style={{ width: `${pct(archivedBytes)}%`, minWidth: archivedBytes > 0 ? 4 : 0 }}
          />
          <div className="h-full bg-slate-200" style={{ width: `${pct(freeBytes)}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Legend color="bg-flash-600" label="Space file storage" value={fmtBytes(activeBytes)} />
          <Legend color="bg-purple-500" label="Verified archive storage" value={fmtBytes(archivedBytes)} />
          <Legend color="bg-slate-200" label="Free / available" value={fmtBytes(freeBytes)} />
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
          {fmtBytes(activeBytes + archivedBytes)} of {fmtBytes(quota)} allocated across your Spaces.
        </p>
      </section>

      <section className="space-y-4">
        <div className="inline-flex gap-1 rounded-lg bg-slate-100/90 p-1 text-[12px] font-medium text-muted">
          {([
            ['active', `Active (${owned.active.length})`],
            ['archived', `Archived (${owned.archived.length})`],
          ] as [Tab, string][]).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={`rounded-md px-3 py-1 transition-colors ${
                tab === value ? 'bg-white font-semibold text-primary shadow-xs' : 'hover:text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {list.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {list.map((space) => (
              <SpaceCard
                key={space.id}
                space={space}
                onOpen={() => navigate(`/spaces/${space.id}`)}
                canManage
                onArchive={space.status !== 'ARCHIVED' ? () => setPending({ kind: 'archive', space }) : undefined}
                onDelete={() => setPending({ kind: 'delete', space })}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
            <Icon name="archive" size={40} className="mx-auto text-slate-300" />
            <p className="mt-3 text-[14px] font-medium text-primary">
              {tab === 'archived'
                ? 'Nothing archived yet'
                : owned.archived.length > 0
                  ? 'No active Spaces'
                  : 'You have not created a Space yet'}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              {tab === 'archived'
                ? 'Archived Spaces keep their ZIP in the Vault and stay downloadable.'
                : 'Create one from the dashboard and set its end time.'}
            </p>
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
              ? `"${pending.space.name}" will be packaged into your Vault and its live storage released.`
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

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color}`} />
      <div>
        <p className="text-[11px] leading-tight text-muted">{label}</p>
        <p className="text-[13px] font-semibold leading-tight text-primary">{value}</p>
      </div>
    </div>
  );
}
