import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AccountView } from '../api';
import type {
  Archive,
  AuthUser,
  DashboardSummary,
  SpaceDetail,
  StorageSummary,
} from '../types';
import { SpaceCard } from '../components/SpaceCard';
import { StatCard } from '../components/StatCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import {
  compactRemaining,
  fmtBytes,
  fmtDate,
  timeAgo,
  toDateTimeLocal,
} from '../lib/format';

type Filter = 'all' | 'ACTIVE' | 'WARNING' | 'ARCHIVED';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const ACTION_LABELS: Record<string, string> = {
  SPACE_CREATED: 'Space created',
  SPACE_UPDATED: 'Space details updated',
  SPACE_FINALIZED: 'Space finalized',
  SPACE_WARNING_SENT: 'Expiry warning sent',
  SPACE_ARCHIVED: 'Space archived',
  SPACE_EXTENDED: 'Deadline extended',
  FILE_UPLOADED: 'File uploaded',
  FILE_DELETED: 'File deleted',
  FILE_RENAMED: 'File renamed',
  FOLDER_CREATED: 'Folder created',
  MEMBER_JOINED: 'Member joined',
  MEMBER_ROLE_CHANGED: 'Member role changed',
  MEMBER_REVOKED: 'Member removed',
  INVITATION_CREATED: 'Invitation sent',
  ARCHIVE_COMPLETED: 'Archive completed',
  ARCHIVE_VERIFIED: 'Archive verified',
};

function actionLabel(action: string): string {
  return (
    ACTION_LABELS[action] ??
    action
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
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
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'archive' | 'delete'; space: SpaceDetail } | null>(null);

  const load = useCallback(async () => {
    // Spaces drive the workspace grid; the summary carries every dashboard
    // section. Both come from the same authenticated, server-authorized APIs.
    const [spaceList, dashboard, vault] = await Promise.all([
      api.listSpaces(),
      api.dashboardSummary(),
      api.vault(),
    ]);
    setSpaces(spaceList.spaces);
    setSummary(dashboard);
    setStorage(dashboard.storage);
    setArchives(vault.archives);
    // Avatar/email come from the account API when the provider supports it.
    api
      .accountMe()
      .then((r) => setAccount(r.account))
      .catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load your dashboard'))
      .finally(() => setLoading(false));
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh the dashboard');
    } finally {
      setRefreshing(false);
    }
  };

  const spaceById = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);
  const counts = summary?.counts ?? { total: 0, active: 0, expiring: 0, archived: 0 };

  const visible = useMemo(() => {
    if (filter === 'all') return spaces;
    if (filter === 'WARNING') return spaces.filter((s) => summary?.expiring.some((e) => e.id === s.id));
    return spaces.filter((s) => s.status === filter);
  }, [filter, spaces, summary]);

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

  const usedBytes = storage?.usedBytes ?? 0;
  const quotaBytes = storage?.quotaBytes ?? 0;
  const archivedBytes = storage?.archivedBytes ?? 0;
  const activeBytes = Math.max(0, usedBytes - archivedBytes);
  const freeBytes = storage?.freeBytes ?? Math.max(0, quotaBytes - usedBytes);
  const usedPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;
  const archivedPercent = quotaBytes > 0 ? Math.min(100, (archivedBytes / quotaBytes) * 100) : 0;
  const activePercent = quotaBytes > 0 ? Math.min(100 - archivedPercent, (activeBytes / quotaBytes) * 100) : 0;

  const initials = user.displayName
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="space-y-6">
      {/* ---- Personalized welcome ---------------------------------------- */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          {account?.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              className="h-11 w-11 flex-shrink-0 rounded-full object-cover ring-1 ring-line"
            />
          ) : (
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-flash-600 text-[13px] font-bold text-white">
              {initials}
            </span>
          )}
          <div className="min-w-0">
            {loading ? (
              <div className="space-y-2">
                <div className="skeleton h-6 w-56 rounded" />
                <div className="skeleton h-3.5 w-72 rounded" />
              </div>
            ) : (
              <>
                <h1 className="page-title">
                  {greeting()}, {user.displayName.split(' ')[0]}
                </h1>
                <p className="mt-0.5 text-[13px] text-muted">
                  Here is what is happening across the workspaces you can access.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={refresh}
            disabled={refreshing}
            className="btn-secondary px-3 py-2 text-[13px]"
            title="Refresh dashboard data"
          >
            <Icon name="refresh" size={15} className={refreshing ? 'animate-spin' : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={() => navigate('/vault')} className="btn-secondary px-3 py-2 text-[13px]">
            <Icon name="archive" size={15} />
            Vault
          </button>
          <button onClick={() => navigate('/my-spaces')} className="btn-secondary px-3 py-2 text-[13px]">
            <Icon name="layers" size={15} />
            My Spaces
          </button>
          <button onClick={() => setShowForm((open) => !open)} className="btn-primary px-3.5 py-2">
            <Icon name={showForm ? 'x' : 'plus'} size={16} />
            {showForm ? 'Close form' : 'Create Space'}
          </button>
        </div>
      </section>

      {showForm && (
        <CreateSpaceForm onCreated={(id) => navigate(`/spaces/${id}`)} onCancel={() => setShowForm(false)} />
      )}

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <span className="flex items-center gap-2">
            <Icon name="alert-circle" size={16} />
            {error}
          </span>
          <button onClick={refresh} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {/* ---- Statistics --------------------------------------------------- */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" aria-label="Account statistics">
        {loading ? (
          Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-line bg-white p-4 shadow-xs">
              <div className="skeleton h-3 w-16 rounded" />
              <div className="skeleton mt-3 h-6 w-12 rounded" />
              <div className="skeleton mt-2 h-3 w-20 rounded" />
            </div>
          ))
        ) : (
          <>
            <StatCard label="Total Spaces" value={counts.total} hint="Owned and shared" icon="layers" />
            <StatCard label="Active Spaces" value={counts.active} hint="In the ACTIVE state" icon="grid" />
            <StatCard
              label="Expiring Soon"
              value={counts.expiring}
              hint="Inside the warning window"
              chip={counts.expiring > 0 ? 'Requires action' : undefined}
              icon="clock"
            />
            <StatCard label="Archived" value={counts.archived} hint="Sealed in your Vault" icon="archive" />
            <StatCard
              label="Storage Used"
              value={fmtBytes(usedBytes)}
              hint={`${usedPercent}% of ${fmtBytes(quotaBytes)}`}
            />
            <StatCard
              label="Storage Available"
              value={fmtBytes(freeBytes)}
              hint={freeBytes === 0 ? 'Quota reached' : 'Remaining in your quota'}
            />
          </>
        )}
      </section>

      {summary && summary.errors.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Some dashboard sections could not be loaded ({summary.errors.join(', ')}). Everything else below is live data.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ---- Storage chart --------------------------------------------- */}
        <section className="rounded-xl border border-line bg-white p-4 shadow-xs xl:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Storage</h2>
            <span className="font-mono text-[11px] text-muted">{usedPercent}% used</span>
          </div>

          {loading ? (
            <div className="skeleton mt-4 h-3 w-full rounded-full" />
          ) : quotaBytes === 0 ? (
            <p className="mt-4 text-[12px] text-muted">No quota is configured for this account.</p>
          ) : (
            <>
              <div
                className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
                role="img"
                aria-label={`${fmtBytes(usedBytes)} of ${fmtBytes(quotaBytes)} used`}
              >
                <div className="h-full bg-flash-600" style={{ width: `${activePercent}%` }} />
                <div className="h-full bg-flash-600" style={{ width: `${archivedPercent}%` }} />
              </div>
              <dl className="mt-4 space-y-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-muted">
                    <span className="h-2 w-2 rounded-full bg-flash-600" /> Live files
                  </dt>
                  <dd className="font-mono text-primary">{fmtBytes(activeBytes)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-muted">
                    <span className="h-2 w-2 rounded-full bg-flash-600" /> Vault archives
                  </dt>
                  <dd className="font-mono text-primary">{fmtBytes(archivedBytes)}</dd>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <dt className="text-muted">Available of {fmtBytes(quotaBytes)}</dt>
                  <dd className="font-mono font-semibold text-primary">{fmtBytes(freeBytes)}</dd>
                </div>
              </dl>
            </>
          )}
        </section>

        {/* ---- Recent activity ------------------------------------------- */}
        <section className="rounded-xl border border-line bg-white p-4 shadow-xs xl:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Recent activity</h2>
            <Icon name="activity" size={15} className="text-slate-400" />
          </div>
          {loading ? (
            <div className="mt-3 space-y-2">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="skeleton h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : (summary?.activity.length ?? 0) === 0 ? (
            <p className="mt-4 text-[12px] text-muted">
              No activity yet. Creating a Space, uploading a file or inviting a member appears here.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {summary!.activity.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => item.spaceId && navigate(`/spaces/${item.spaceId}/activity`)}
                    disabled={!item.spaceId}
                    className="flex w-full items-start gap-2.5 py-2 text-left disabled:cursor-default"
                  >
                    <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-flash-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-primary">
                        {actionLabel(item.action)}
                        {item.spaceName ? <span className="text-muted"> · {item.spaceName}</span> : null}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {item.actorName ? `${item.actorName} · ` : ''}
                        {timeAgo(item.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- Expiry reminders ------------------------------------------ */}
        <section className="rounded-xl border border-line bg-white p-4 shadow-xs xl:col-span-1">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Closing soon</h2>
            <Icon name="clock" size={15} className="text-slate-400" />
          </div>
          {loading ? (
            <div className="mt-3 space-y-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="skeleton h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : (summary?.expiring.length ?? 0) === 0 ? (
            <p className="mt-4 text-[12px] text-muted">
              Nothing is inside the {`warning window`} right now. Spaces you own or belong to show here as their
              deadline approaches.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {summary!.expiring.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => navigate(`/spaces/${item.id}/extensions`)}
                    className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left transition-colors hover:bg-amber-100"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-amber-900">{item.name}</span>
                      <span className="flex-shrink-0 rounded-full bg-white px-2 py-0.5 font-mono text-[10px] uppercase text-amber-700">
                        {item.status}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-amber-800">
                      {item.remainingMs <= 0
                        ? 'Deadline passed — archiving is due'
                        : `Closes in ${compactRemaining(item.expiryAt)} · ${fmtDate(item.expiryAt)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ---- Recent uploads -------------------------------------------- */}
        <section className="rounded-xl border border-line bg-white p-4 shadow-xs xl:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Recent uploads</h2>
            <Icon name="upload" size={15} className="text-slate-400" />
          </div>
          {loading ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="skeleton h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : (summary?.recentUploads.length ?? 0) === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center">
              <Icon name="upload" size={22} className="mx-auto text-slate-300" />
              <p className="mt-2 text-[12px] text-muted">
                No uploads yet in the Spaces you can access. Open a Space and upload a file to see it here.
              </p>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {summary!.recentUploads.map((file) => (
                <li key={file.id}>
                  <button
                    onClick={() => navigate(`/spaces/${file.spaceId}/files`)}
                    className="flex w-full items-center gap-3 py-2 text-left"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Icon name="file" size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-primary">{file.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {file.spaceName}
                        {file.uploaderName ? ` · ${file.uploaderName}` : ''} · {timeAgo(file.uploadedAt)}
                      </span>
                    </span>
                    <span className="flex-shrink-0 font-mono text-[10px] text-slate-400">
                      {fmtBytes(file.sizeBytes)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- Recently accessed + invitations --------------------------- */}
        <div className="space-y-4">
          <section className="rounded-xl border border-line bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Recently accessed</h2>
              <Icon name="clock" size={15} className="text-slate-400" />
            </div>
            {loading ? (
              <div className="mt-3 space-y-2">
                {[0, 1].map((row) => (
                  <div key={row} className="skeleton h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : (summary?.recentSpaces.length ?? 0) === 0 ? (
              <p className="mt-4 text-[12px] text-muted">
                Spaces you open are listed here with the time you last worked in them.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {summary!.recentSpaces.map((space) => (
                  <li key={space.id}>
                    <button
                      onClick={() => navigate(`/spaces/${space.id}`)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-slate-50"
                    >
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-flash-50 text-[10px] font-bold text-flash-700">
                        {space.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-primary">{space.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {space.ownerName ?? 'Unknown owner'} · {space.memberCount} member
                          {space.memberCount === 1 ? '' : 's'} · {timeAgo(space.lastAccessedAt ?? space.expiryAt)}
                        </span>
                      </span>
                      <span className="flex-shrink-0 font-mono text-[10px] uppercase text-slate-400">
                        {space.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-line bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[15px] font-bold tracking-tight text-primary">Invitations</h2>
              <Icon name="mail" size={15} className="text-slate-400" />
            </div>
            {loading ? (
              <div className="mt-3 space-y-2">
                {[0, 1].map((row) => (
                  <div key={row} className="skeleton h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : (summary?.invitations.length ?? 0) === 0 ? (
              <p className="mt-4 text-[12px] text-muted">
                No pending invitations. Invitations addressed to your email, and join requests awaiting a decision,
                appear here.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {summary!.invitations.map((invite) => (
                  <li key={`${invite.kind}-${invite.id}`} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-primary">{invite.spaceName}</span>
                      <span className="flex-shrink-0 rounded-full bg-flash-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-flash-700">
                        {invite.role}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {invite.inviterName ? `From ${invite.inviterName} · ` : ''}
                      {invite.kind === 'EMAIL' ? 'Email invitation' : 'Join request awaiting approval'}
                      {invite.expiresAt ? ` · expires ${fmtDate(invite.expiresAt)}` : ''}
                    </p>
                    <button
                      onClick={() => navigate('/notifications')}
                      className="mt-1 text-[11px] font-medium text-flash-700 hover:underline"
                    >
                      Open in notifications
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* ---- Workspaces --------------------------------------------------- */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-display text-base font-bold tracking-tight text-primary">Your Workspaces</h2>
          <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100/90 p-1 text-[12px] font-medium text-muted">
            {([
              ['all', `All (${counts.total})`],
              ['ACTIVE', `Active (${counts.active})`],
              ['WARNING', `Expiring (${counts.expiring})`],
              ['ARCHIVED', `Archived (${counts.archived})`],
            ] as [Filter, string][]).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  filter === value ? 'bg-white font-semibold text-primary shadow-xs' : 'hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {[0, 1].map((row) => (
              <div key={row} className="skeleton h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : visible.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visible.map((space) => (
              <SpaceCard
                key={space.id}
                space={space}
                onOpen={() => navigate(`/spaces/${space.id}`)}
                canManage={space.role === 'OWNER'}
                onArchive={
                  space.role === 'OWNER' && space.status !== 'ARCHIVED'
                    ? () => setPending({ kind: 'archive', space })
                    : undefined
                }
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

      {/* ---- Vault preview ------------------------------------------------ */}
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
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-flash-500 to-flash-700 text-white">
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
        File size and per-Space quotas are enforced by the API. Members can be invited after the Space exists.
      </p>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

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
