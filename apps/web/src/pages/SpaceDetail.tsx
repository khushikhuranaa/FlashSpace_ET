import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type {
  AuthUser,
  ExtensionRequest,
  JoinRequestView,
  MembersPayload,
  PendingInviteView,
  DuplicateSpaceResult,
  SpaceStorageBreakdown,
  SpaceDetail as SpaceDetailType,
} from '../types';
import { Icon } from '../components/Icon';
import { StatCard } from '../components/StatCard';
import { SpaceFiles } from '../components/SpaceFiles';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/ui';
import { useToast } from '../components/ToastProvider';
import {
  compactRemaining,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  remainingUntil,
  timeAgo,
  toDateTimeLocal,
} from '../lib/format';

const TABS = ['overview', 'files', 'members', 'extensions', 'activity', 'settings'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  files: 'Files',
  members: 'Members',
  extensions: 'Extensions',
  activity: 'Audit log',
  settings: 'Settings',
};

type PendingAction =
  | { kind: 'archive' }
  | { kind: 'delete' }
  | { kind: 'revoke'; userId: string; name: string };

export default function SpaceDetail({
  id,
  user,
  navigate,
  goBack,
  tab,
}: {
  id: string;
  user: AuthUser;
  navigate: (to: string) => void;
  goBack: () => void;
  tab?: string;
}) {
  const toast = useToast().toast;
  const [space, setSpace] = useState<SpaceDetailType | null>(null);
  const [storage, setStorage] = useState<SpaceStorageBreakdown | null>(null);
  // Kept for the tab badge and overview counters only; the files tab owns its
  // own listing state inside `SpaceFiles`.
  const [membersPayload, setMembersPayload] = useState<MembersPayload | null>(null);
  const [extensions, setExtensions] = useState<ExtensionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER');
  const [extDays, setExtDays] = useState(3);
  const [extReason, setExtReason] = useState('');
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const activeTab: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'files';

  const load = useCallback(async () => {
    // These four reads are independent. The old sequential chain also fetched
    // the full file list and the legacy activity feed, neither of which this
    // page renders (SpaceFiles owns its own listing and the Audit log panel
    // owns paginated activity). Those two requests are gone.
    const [s, members, extensionList, storageBreakdown] = await Promise.all([
      api.getSpace(id),
      api.listMembers(id),
      api.listExtensions(id),
      api.spaceStorage(id).catch(() => null),
    ]);
    setSpace(s.space);
    setMembersPayload(members);
    setExtensions(extensionList.requests);
    // Real backend accounting for the Space; never derived from the browser.
    setStorage(storageBreakdown);
  }, [id]);

  useEffect(() => {
    setError(null);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load this Space'));
  }, [load]);

  // Stable identity: SpaceFiles keeps this in a ref, but an inline arrow here
  // still re-renders every child on each parent update for no reason.
  const refreshSpace = useCallback(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const writable = space?.role === 'OWNER' || space?.role === 'EDITOR';
  const writableStatus = Boolean(space && ['DRAFT', 'ACTIVE', 'WARNING'].includes(space.status));
  const isOwner = space?.role === 'OWNER';
  const canEdit = writable && writableStatus;
  const readOnlyArchive = Boolean(space && ['ARCHIVED', 'ARCHIVING', 'ARCHIVE_FAILED'].includes(space.status));

  const go = (next: Tab) => navigate(`/spaces/${id}/${next}`);

  const toggleFavorite = async () => {
    if (!space) return;
    const next = !space.favorite;
    setSpace({ ...space, favorite: next });
    try {
      if (next) await api.favoriteSpace(space.id);
      else await api.unfavoriteSpace(space.id);
      toast(next ? 'Added to favourites' : 'Removed from favourites', 'success');
    } catch (e) {
      setSpace({ ...space, favorite: !next });
      toast(e instanceof Error ? e.message : 'Could not update favourites', 'error');
    }
  };

  const members = membersPayload?.members ?? [];
  const pendingInvites: PendingInviteView[] = membersPayload?.pending ?? [];
  const joinRequests: JoinRequestView[] = membersPayload?.joinRequests ?? [];
  const inviteLink = membersPayload?.inviteLink ?? null;

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.invite(id, inviteEmail, inviteRole);
      const email = inviteEmail;
      setInviteEmail('');
      await load();
      toast(`Invitation processed for ${email}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Invite failed', 'error');
    }
  };

  const requestExtension = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.requestExtension(id, extDays, extReason);
      setExtReason('');
      await load();
      toast('Extension request submitted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Request failed', 'error');
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied', 'success');
    } catch {
      toast('Could not copy — select the link and copy it manually', 'error');
    }
  };

  const runPending = async () => {
    if (!pending || !space) return;
    setBusy(true);
    try {
      if (pending.kind === 'archive') {
        await api.archiveSpace(id);
        toast('Space archived to your Vault', 'success');
        navigate(`/spaces/${id}`);
      } else if (pending.kind === 'delete') {
        await api.deleteSpace(id);
        toast('Space deleted', 'success');
        navigate('/dashboard');
      } else {
        await api.revokeMember(id, pending.userId);
        await load();
        toast(`${pending.name} removed from the Space`, 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
      // Reflect the backend's real state (e.g. a failed archive marks the Space).
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  if (error && !space) {
    return (
      <div className="card">
        <p className="text-[13px] text-red-600">{error}</p>
        <div className="mt-3 flex gap-2">
          <button className="btn-secondary" onClick={goBack}>
            Back
          </button>
          <button className="btn-secondary" onClick={() => navigate('/my-spaces')}>
            My Spaces
          </button>
        </div>
      </div>
    );
  }
  if (!space) {
    return <div className="text-[13px] text-muted">Loading Space…</div>;
  }

  const remaining = remainingUntil(space.expiryAt, now);
  const activeMembers = members.filter((m) => m.status === 'ACTIVE').length;
  const warn = space.status === 'WARNING' || (writableStatus && remaining.ms < 48 * 3_600_000);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <button onClick={() => navigate('/my-spaces')} className="hover:text-primary">
          My Spaces
        </button>
        <Icon name="chevron-right" size={14} className="text-slate-400" />
        <span className="font-medium text-primary">{space.name}</span>
      </div>

      <section className="rounded-xl border border-line bg-white p-6 shadow-xs">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-bold tracking-tight text-primary">{space.name}</h1>
              <StatusBadge status={space.status} />
              <span className="badge bg-flash-50 text-flash-700">you: {space.role ?? 'ADMIN'}</span>
              <button
                onClick={() => void toggleFavorite()}
                aria-pressed={Boolean(space.favorite)}
                aria-label={space.favorite ? 'Remove from favourites' : 'Add to favourites'}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  space.favorite
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-line bg-white text-muted hover:text-amber-600'
                }`}
              >
                <Icon name={space.favorite ? 'star-filled' : 'star'} size={13} />
                {space.favorite ? 'Favourited' : 'Favourite'}
              </button>
            </div>
            <p className="mt-2 text-[13px] text-muted">{space.purpose}</p>
            {space.description && <p className="mt-1 text-[13px] text-slate-500">{space.description}</p>}

            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <Meta label="Start time" value={fmtDateTime(space.startAt)} />
              <Meta label="End time" value={fmtDateTime(space.expiryAt)} />
              <Meta label="Storage" value={fmtBytes(space.storageUsedBytes)} mono />
              <Meta label="Collaborators" value={`${activeMembers} active`} />
              <Meta label="Access level" value={space.role === 'OWNER' ? 'Owner' : space.role ?? 'Admin'} />
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 lg:items-end">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Time remaining</p>
              <p
                className={`font-mono text-[15px] font-semibold ${
                  readOnlyArchive
                    ? 'text-flash-600'
                    : remaining.expired
                      ? 'text-red-600'
                      : remaining.ms < 3_600_000
                        ? 'animate-countdown-pulse text-red-600'
                        : remaining.ms < 86_400_000
                          ? 'text-amber-600'
                          : 'text-primary'
                }`}
              >
                {space.status === 'ARCHIVE_FAILED'
                  ? 'Not archived'
                  : readOnlyArchive
                    ? 'Archived'
                    : space.status === 'DRAFT'
                    ? `Starts ${fmtDate(space.startAt)}`
                      : remaining.expired
                        ? 'Expired'
                        : `${remaining.days}d ${remaining.hours}h ${remaining.minutes}m ${remaining.seconds}s`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isOwner && writableStatus && (
                <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => navigate(`/insights/${id}`)}>
                  <Icon name="scan" size={14} />
                  Storage insights
                </button>
              )}
              {isOwner && writableStatus && (
                <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setPending({ kind: 'archive' })}>
                  <Icon name="archive" size={14} />
                  Archive
                </button>
              )}
              {isOwner && (
                <button className="btn-danger px-3 py-1.5 text-[12px]" onClick={() => setPending({ kind: 'delete' })}>
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>

        {space.status === 'ARCHIVE_FAILED' && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-red-700">
              <Icon name="alert-circle" size={15} />
              Archiving failed for this Space
            </p>
            <p className="mt-1 text-[12px] text-red-600">
              Your files are preserved. An administrator can retry the archive from the admin
              console; this Space stays read-only until then.
            </p>
          </div>
        )}

        {warn && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-amber-800">
              <Icon name="alert" size={15} />
              This Space is expiring soon
            </p>
            <p className="mt-1 text-[12px] text-amber-700">
              Closes in {compactRemaining(space.expiryAt, now)}. Files are archived and members lose
              access when the countdown ends.
            </p>
            {writableStatus && (
              <button
                onClick={() => go('extensions')}
                className="mt-2 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100"
              >
                Request an extension
              </button>
            )}
          </div>
        )}
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <div className="tab-list" role="tablist" aria-label="Space sections">
        {TABS.map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={activeTab === value}
            onClick={() => go(value)}
            className={`tab flex-1 justify-center ${activeTab === value ? 'tab-active' : ''}`}
          >
            {TAB_LABEL[value]}
            {value === 'files' && (
              <span className="ml-1.5 font-mono opacity-70">{storage?.fileCount ?? 0}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <section className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Files" value={storage?.fileCount ?? 0} hint="Active objects in this Space" icon="file" />
            <StatCard label="Members" value={activeMembers} hint={`${joinRequests.filter((r) => r.status === 'PENDING').length} pending request(s)`} icon="users" />
            <StatCard
              label="Time remaining"
              value={readOnlyArchive ? 'Archived' : remaining.expired ? 'Expired' : `${remaining.days}d ${remaining.hours}h`}
              hint={readOnlyArchive ? 'ZIP available in the Vault' : `Ends ${fmtDateTime(space.expiryAt)}`}
              icon="clock"
            />
          </div>
          <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Space details</h2>
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Meta label="Purpose" value={space.purpose} />
              <Meta label="Owner" value={space.ownerName ?? (space.ownerId === user.id ? user.displayName : '—')} />
              <Meta label="Created" value={fmtDateTime(space.createdAt)} />
              <Meta label="Members" value={`${activeMembers} active`} />
              <Meta label="Starts" value={fmtDateTime(space.startAt)} />
              <Meta label="Expires" value={fmtDateTime(space.expiryAt)} />
              <Meta label="Storage used" value={fmtBytes(space.storageUsedBytes)} mono />
              <Meta label="Last opened" value={space.lastAccessedAt ? timeAgo(space.lastAccessedAt) : 'Just now'} />
            </div>
            {space.description && (
              <p className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-slate-600">
                {space.description}
              </p>
            )}
          </div>

          {storage && (
            <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Storage</h2>
                <span className="font-mono text-[11px] text-muted">{storage.percentUsed}% of quota</span>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-flash-600" style={{ width: `${storage.percentUsed}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Meta label="Used" value={fmtBytes(storage.usedBytes)} mono />
                <Meta label="Available" value={fmtBytes(storage.freeBytes)} mono />
                <Meta label="Files" value={String(storage.fileCount)} />
                <Meta label="Folders" value={String(storage.folderCount)} />
              </div>
              {storage.archivedBytes > 0 && (
                <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
                  {fmtBytes(storage.archivedBytes)} preserved in verified archives (not counted against live storage).
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">
              What happens at the end
            </h2>
            <ol className="mt-3 space-y-2 text-[13px] text-muted">
              <li className="flex gap-2">
                <Icon name="alert" size={15} className="mt-0.5 flex-shrink-0 text-amber-500" />
                Members are warned before the deadline and can request an extension.
              </li>
              <li className="flex gap-2">
                <Icon name="archive" size={15} className="mt-0.5 flex-shrink-0 text-flash-600" />
                The folder tree is packaged into a ZIP and verified against the file list.
              </li>
              <li className="flex gap-2">
                <Icon name="hard-drive" size={15} className="mt-0.5 flex-shrink-0 text-slate-500" />
                Temporary storage is cleaned up; the archive stays in the Vault.
              </li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => go('files')} className="btn-secondary">
                <Icon name="file" size={15} />
                Browse files
              </button>
              {isOwner && writableStatus && (
                <button onClick={() => navigate(`/insights/${id}`)} className="btn-secondary">
                  <Icon name="scan" size={15} />
                  Storage insights
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {activeTab === 'files' && (
        <SpaceFiles
          spaceId={id}
          canEdit={canEdit}
          readOnly={readOnlyArchive}
          onChanged={refreshSpace}
          onOpenVault={() => navigate('/vault')}
        />
      )}

      {activeTab === 'members' && (
        <section className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">
                Current members
              </h2>
              <span className="text-[12px] text-muted">
                {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">User</th>
                    <th className="px-5 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Joined</th>
                    {isOwner && <th className="px-5 py-3 text-right font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {members.map((member) => (
                    <tr key={member.userId} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-flash-50 text-[11px] font-bold text-flash-700">
                            {member.displayName.charAt(0).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-primary">{member.displayName}</span>
                            <span className="block truncate text-[11px] text-muted">{member.email}</span>
                          </span>
                          {member.userId === user.id && (
                            <span className="badge bg-slate-100 text-slate-600">you</span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`badge ${member.role === 'OWNER' ? 'bg-flash-50 text-flash-700' : 'bg-slate-100 text-slate-700'}`}>
                          {member.role}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`badge ${
                            member.status === 'ACTIVE'
                              ? 'bg-emerald-50 text-emerald-700'
                              : member.status === 'INVITED'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {member.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-[12px] text-muted">
                        {member.joinedAt ? fmtDate(member.joinedAt) : '—'}
                      </td>
                      {isOwner && (
                        <td className="px-5 py-3 text-right">
                          {member.role !== 'OWNER' && member.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1.5">
                              <select
                                className="rounded-lg border border-line bg-white px-2 py-1 text-[12px] outline-none"
                                value={member.role}
                                disabled={!canEdit}
                                onChange={async (event) => {
                                  try {
                                    await api.changeRole(id, member.userId, event.target.value as 'EDITOR' | 'VIEWER');
                                    await load();
                                    toast('Role updated', 'success');
                                  } catch (e) {
                                    toast(e instanceof Error ? e.message : 'Could not change role', 'error');
                                  }
                                }}
                              >
                                <option value="EDITOR">EDITOR</option>
                                <option value="VIEWER">VIEWER</option>
                              </select>
                              <button
                                className="btn-danger px-2 py-1 text-[12px]"
                                disabled={!canEdit}
                                onClick={() => setPending({ kind: 'revoke', userId: member.userId, name: member.displayName })}
                              >
                                Remove
                              </button>
                            </span>
                          ) : (
                            <span className="text-[12px] text-slate-400">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: the five-column table cannot be read at 390px, so each
                member becomes a compact card with the same actions. */}
            <div className="divide-y divide-line/70 sm:hidden">
              {members.map((member) => (
                <div key={member.userId} className="space-y-2.5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-flash-50 text-[11px] font-bold text-flash-700">
                      {member.displayName.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-primary">{member.displayName}</span>
                        {member.userId === user.id && (
                          <span className="badge bg-slate-100 text-slate-600">you</span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted">{member.email}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className={`badge ${member.role === 'OWNER' ? 'bg-flash-50 text-flash-700' : 'bg-slate-100 text-slate-700'}`}>
                      {member.role}
                    </span>
                    <span
                      className={`badge ${
                        member.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700'
                          : member.status === 'INVITED'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {member.status}
                    </span>
                    <span>Joined {member.joinedAt ? fmtDate(member.joinedAt) : '—'}</span>
                  </div>
                  {isOwner && member.role !== 'OWNER' && member.status === 'ACTIVE' && (
                    <div className="flex items-center gap-2">
                      <select
                        className="input h-8 w-auto text-[12px]"
                        value={member.role}
                        disabled={!canEdit}
                        onChange={async (event) => {
                          try {
                            await api.changeRole(id, member.userId, event.target.value as 'EDITOR' | 'VIEWER');
                            await load();
                            toast('Role updated', 'success');
                          } catch (e) {
                            toast(e instanceof Error ? e.message : 'Could not change role', 'error');
                          }
                        }}
                      >
                        <option value="EDITOR">EDITOR</option>
                        <option value="VIEWER">VIEWER</option>
                      </select>
                      <button
                        className="btn-danger px-2 py-1 text-[12px]"
                        disabled={!canEdit}
                        onClick={() => setPending({ kind: 'revoke', userId: member.userId, name: member.displayName })}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {canEdit && (
            <div className="grid gap-4 md:grid-cols-2">
              <form onSubmit={invite} className="rounded-xl border border-line bg-white p-5 shadow-xs">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                  <Icon name="mail" size={16} className="text-flash-600" />
                  Invite via email
                </h3>
                <p className="mt-1 text-[12px] text-muted">
                  The invitation is delivered to the registered account for that address.
                </p>
                <div className="mt-3 space-y-2">
                  <input
                    className="input"
                    type="email"
                    required
                    placeholder="teammate@company.com"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <select
                      className="input"
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value as 'EDITOR' | 'VIEWER')}
                    >
                      <option value="VIEWER">VIEWER — read only</option>
                      <option value="EDITOR">EDITOR — can upload</option>
                    </select>
                    <button className="btn-primary flex-shrink-0" type="submit">
                      Send
                    </button>
                  </div>
                </div>
              </form>

              <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                  <Icon name="link" size={16} className="text-flash-600" />
                  Invite via link
                </h3>
                <p className="mt-1 text-[12px] text-muted">
                  Anyone signed in can use the link to request to join this Space.
                </p>
                {inviteLink ? (
                  <div className="mt-3 space-y-2">
                    <div className="break-all rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] text-muted">
                      {inviteLink.url}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-secondary px-2.5 py-1 text-[12px]" onClick={() => void copyLink(inviteLink.url)}>
                        <Icon name="copy" size={14} />
                        Copy link
                      </button>
                      <button
                        className="btn-danger px-2.5 py-1 text-[12px]"
                        onClick={async () => {
                          try {
                            await api.revokeInviteLink(id);
                            await load();
                            toast('Invite link revoked', 'success');
                          } catch (e) {
                            toast(e instanceof Error ? e.message : 'Could not revoke link', 'error');
                          }
                        }}
                      >
                        Revoke link
                      </button>
                    </div>
                    <p className="text-[11px] text-muted">
                      Grants {inviteLink.role} · created {fmtDate(inviteLink.createdAt)}
                    </p>
                  </div>
                ) : (
                  <button
                    className="btn-primary mt-3"
                    onClick={async () => {
                      try {
                        const result = await api.createInviteLink(id, 'VIEWER');
                        setMembersPayload((prev) => (prev ? { ...prev, inviteLink: result.inviteLink } : prev));
                        toast('Invite link generated', 'success');
                      } catch (e) {
                        toast(e instanceof Error ? e.message : 'Could not create link', 'error');
                      }
                    }}
                  >
                    <Icon name="link" size={15} />
                    Generate invite link
                  </button>
                )}
              </div>
            </div>
          )}

          {(pendingInvites.length > 0 || joinRequests.length > 0) && canEdit && (
            <div className="space-y-4">
              {joinRequests.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
                  <div className="border-b border-line px-5 py-3">
                    <h3 className="font-display text-[14px] font-bold tracking-tight text-primary">
                      Join requests
                    </h3>
                  </div>
                  <div className="divide-y divide-line/70">
                    {joinRequests.map((request) => (
                      <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-primary">
                            {request.requesterDisplayName}
                            <span className="ml-1.5 text-[11px] font-normal text-muted">
                              {request.requesterEmail} · {request.role}
                            </span>
                          </p>
                          <p className="text-[11px] text-muted">
                            {request.source === 'LINK' ? 'Requested via invite link' : 'Invited by email'} ·{' '}
                            {timeAgo(request.createdAt)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`badge ${
                              request.status === 'PENDING'
                                ? 'bg-amber-50 text-amber-700'
                                : request.status === 'ACCEPTED'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {request.status}
                          </span>
                          {request.status === 'PENDING' && (
                            <>
                              <button
                                className="rounded-lg bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100"
                                onClick={async () => {
                                  try {
                                    await api.decideJoinRequest(request.id, 'ACCEPT');
                                    await load();
                                    toast(`${request.requesterDisplayName} joined`, 'success');
                                  } catch (e) {
                                    toast(e instanceof Error ? e.message : 'Could not accept', 'error');
                                  }
                                }}
                              >
                                Accept
                              </button>
                              <button
                                className="rounded-lg bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-600 hover:bg-red-100"
                                onClick={async () => {
                                  try {
                                    await api.decideJoinRequest(request.id, 'DECLINE');
                                    await load();
                                    toast('Request declined', 'success');
                                  } catch (e) {
                                    toast(e instanceof Error ? e.message : 'Could not decline', 'error');
                                  }
                                }}
                              >
                                Decline
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pendingInvites.length > 0 && (
                <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
                  <h3 className="font-display text-[14px] font-bold tracking-tight text-primary">
                    Pending email invitations
                  </h3>
                  <ul className="mt-3 space-y-2">
                    {pendingInvites.map((invite) => (
                      <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-[13px] text-primary">
                          {invite.email ?? 'Unknown recipient'}
                          <span className="ml-1.5 text-[11px] text-muted">· {invite.role}</span>
                        </span>
                        <span className="text-[11px] text-muted">{fmtDateTime(invite.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {activeTab === 'extensions' && (
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">
              Extension requests
            </h2>
            <ul className="mt-3 space-y-2">
              {extensions.map((request) => (
                <li key={request.id} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-primary">
                      {request.requestedDays} day(s)
                    </span>
                    <span
                      className={`badge ${
                        request.status === 'PENDING'
                          ? 'bg-amber-50 text-amber-700'
                          : request.status === 'APPROVED'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {request.status}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted">{request.reason}</p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Submitted {timeAgo(request.createdAt)}
                    {request.decidedAt ? ` · decided ${timeAgo(request.decidedAt)}` : ''}
                  </p>
                </li>
              ))}
              {extensions.length === 0 && (
                <li className="py-6 text-center text-[13px] text-muted">No requests yet.</li>
              )}
            </ul>
          </div>

          {writableStatus ? (
            <form onSubmit={requestExtension} className="rounded-xl border border-line bg-white p-5 shadow-xs">
              <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">
                Request an extension
              </h2>
              <p className="mt-1 text-[12px] text-muted">
                An administrator approves or rejects the request. Only one request can be pending at a time.
              </p>
              <label className="mt-3 block">
                <span className="field-label">Extra days</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={14}
                  required
                  value={extDays}
                  onChange={(event) => setExtDays(Number(event.target.value))}
                />
              </label>
              <label className="mt-3 block">
                <span className="field-label">Reason</span>
                <textarea
                  className="input resize-none"
                  rows={3}
                  required
                  maxLength={1000}
                  placeholder="Why does the team need more time?"
                  value={extReason}
                  onChange={(event) => setExtReason(event.target.value)}
                />
              </label>
              <button className="btn-primary mt-3" type="submit">
                Submit request
              </button>
            </form>
          ) : (
            <div className="rounded-xl border border-line bg-white p-5 text-[13px] text-muted shadow-xs">
              Extensions are only available while the Space is live. Archived Spaces keep their
              original end date.
            </div>
          )}
        </section>
      )}

      {activeTab === 'activity' && <SpaceActivityPanel spaceId={id} />}

      {activeTab === 'settings' && space && (
        isOwner && writableStatus ? (
          <SpaceSettingsForm
            key={space.updatedAt}
            space={space}
            onSaved={() => void load()}
            onOpenSpace={(newId) => navigate(`/spaces/${newId}`)}
          />
        ) : (
          // Editors and viewers never get editable inputs: settings are owner-only
          // on the server, so the UI must not offer controls that would 403.
          <SpaceSettingsReadOnly space={space} writableStatus={writableStatus} />
        )
      )}

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'delete' ? 'Delete permanently?'
            : pending?.kind === 'archive'
              ? 'Archive this Space?'
              : 'Remove this member?'
        }
        message={
          pending?.kind === 'archive'
            ? `"${space.name}" will be packaged into your Vault. Members lose write access immediately and the Space becomes read-only.`
            : pending?.kind === 'delete'
              ? `"${space.name}" will be removed from every listing. This cannot be undone.`
              : pending?.kind === 'revoke'
                  ? `${pending.name} will immediately lose access to this Space.`
                  : ''
        }
        confirmLabel={
          pending?.kind === 'delete'
            ? 'Delete Space'
            : pending?.kind === 'archive'
                ? 'Archive Space'
                : 'Remove member'
        }
        tone={pending?.kind === 'archive' ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className={`block text-[12px] font-medium text-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function SpaceSettingsForm({
  space,
  onSaved,
  onOpenSpace,
}: {
  space: SpaceDetailType;
  onSaved: () => void;
  onOpenSpace: (spaceId: string) => void;
}) {
  const toast = useToast().toast;
  const isOwner = space.role === 'OWNER';
  const [name, setName] = useState(space.name);
  const [purpose, setPurpose] = useState(space.purpose);
  const [description, setDescription] = useState(space.description);
  const [expiry, setExpiry] = useState(toDateTimeLocal(space.expiryAt));
  const [invitationsEnabled, setInvitationsEnabled] = useState(space.invitationsEnabled !== false);
  const [defaultInviteRole, setDefaultInviteRole] = useState<'EDITOR' | 'VIEWER'>(
    space.defaultInviteRole === 'EDITOR' ? 'EDITOR' : 'VIEWER',
  );
  const [busy, setBusy] = useState(false);

  const [dupOpen, setDupOpen] = useState(false);
  const [dupName, setDupName] = useState(`${space.name} (copy)`);
  const [dupExpiry, setDupExpiry] = useState(
    toDateTimeLocal(new Date(Date.now() + 7 * 86_400_000).toISOString()),
  );
  const [copyFiles, setCopyFiles] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicated, setDuplicated] = useState<DuplicateSpaceResult | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 3) {
      toast('Space name must be at least 3 characters', 'error');
      return;
    }
    if (new Date(expiry).getTime() <= new Date(space.startAt).getTime()) {
      toast('The end time must be after the start time', 'error');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        purpose: purpose.trim(),
        description: description.trim(),
        expiryAt: new Date(expiry).toISOString(),
      };
      // Owner-only endpoint (`PATCH /spaces/:id/settings`). Editors and viewers
      // never reach this form.
      await api.updateSpaceSettings(space.id, {
        ...payload,
        invitationsEnabled,
        defaultInviteRole,
      });
      toast('Space settings saved', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runDuplicate = async () => {
    if (new Date(dupExpiry).getTime() <= Date.now()) {
      toast('The new end time must be in the future', 'error');
      return;
    }
    setDuplicating(true);
    try {
      const result = await api.duplicateSpace(space.id, {
        name: dupName.trim() || undefined,
        expiryAt: new Date(dupExpiry).toISOString(),
        copyFiles,
      });
      setDuplicated(result);
      setDupOpen(false);
      toast(`"${result.space.name}" created with you as OWNER`, 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not duplicate this Space', 'error');
    } finally {
      setDuplicating(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="rounded-xl border border-line bg-white p-5 shadow-xs">
        <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Space settings</h2>
        <p className="mt-1 text-[12px] text-muted">
          Changes are recorded in the audit log. The start time cannot be moved.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Name</span>
            <input
              className="input"
              required
              minLength={3}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-muted">{name.trim().length}/120</span>
          </label>
          <label className="block">
            <span className="field-label">Purpose</span>
            <input
              className="input"
              required
              maxLength={120}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">Description</span>
            <textarea
              className="input resize-none"
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-muted">{description.length}/2000</span>
          </label>
          <label className="block">
            <span className="field-label">End time</span>
            <input
              className="input"
              type="datetime-local"
              required
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <div className="rounded-lg bg-slate-50 p-3 text-[12px] text-muted">
            Starts {fmtDateTime(space.startAt)}. Moving the end time changes the countdown immediately and
            re-arms the lifecycle warning if the new deadline is outside the warning window.
          </div>
        </div>

        {isOwner && (
          <div className="mt-5 rounded-lg border border-line p-4">
            <h3 className="font-display text-[13px] font-bold tracking-tight text-primary">Invitations</h3>
            <p className="mt-1 text-[12px] text-muted">
              Control whether this Space can be joined through invites while it is live.
            </p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex items-center gap-2 text-[12px] font-medium text-primary">
                <input
                  type="checkbox"
                  checked={invitationsEnabled}
                  onChange={(e) => setInvitationsEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Allow invitations
              </label>
              <label className="block sm:w-52">
                <span className="field-label">Default role for links</span>
                <select
                  className="input"
                  value={defaultInviteRole}
                  onChange={(e) => setDefaultInviteRole(e.target.value as 'EDITOR' | 'VIEWER')}
                  disabled={!invitationsEnabled}
                >
                  <option value="VIEWER">VIEWER — read only</option>
                  <option value="EDITOR">EDITOR — can upload and edit</option>
                </select>
              </label>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              OWNER can never be granted through an invitation.
            </p>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      {isOwner && (
        <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
          <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Duplicate this Space</h2>
          <p className="mt-1 text-[12px] text-muted">
            Creates a brand-new Space with you as OWNER, a fresh lifecycle and a new deadline. Members,
            invitations and archives are never copied.
          </p>
          {duplicated ? (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-4">
              <p className="text-[13px] font-medium text-primary">
                “{duplicated.space.name}” created
              </p>
              <p className="mt-1 text-[12px] text-slate-600">
                {duplicated.foldersCopied} folder(s) and {duplicated.filesCopied} file(s) copied
                {duplicated.filesSkipped > 0 ? `, ${duplicated.filesSkipped} skipped` : ''}. Expires{' '}
                {fmtDateTime(duplicated.space.expiryAt)}.
              </p>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary px-3 py-1.5 text-[12px]" onClick={() => onOpenSpace(duplicated.space.id)}>
                  <Icon name="external-link" size={14} />
                  Open Space
                </button>
                <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setDuplicated(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : dupOpen ? (
            <div className="mt-3 space-y-3 rounded-lg border border-line bg-slate-50/60 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="field-label">New name</span>
                  <input
                    className="input"
                    maxLength={120}
                    value={dupName}
                    onChange={(e) => setDupName(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="field-label">New end time</span>
                  <input
                    className="input"
                    type="datetime-local"
                    value={dupExpiry}
                    onChange={(e) => setDupExpiry(e.target.value)}
                  />
                </label>
              </div>
              <label className="flex items-start gap-2 text-[12px] text-slate-600">
                <input
                  type="checkbox"
                  checked={copyFiles}
                  onChange={(e) => setCopyFiles(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  Copy file contents as independent objects (uses this Space's storage quota). Leave
                  unchecked to copy only the folder structure.
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setDupOpen(false)} disabled={duplicating}>
                  Cancel
                </button>
                <button className="btn-primary px-3 py-1.5 text-[12px]" onClick={() => void runDuplicate()} disabled={duplicating}>
                  {duplicating ? 'Duplicating…' : 'Create duplicate'}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn-secondary mt-3 px-3 py-1.5 text-[12px]" onClick={() => setDupOpen(true)}>
              <Icon name="copy" size={14} />
              Duplicate Space
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Space activity (Module 12): server-side filters, pagination and an
 * authorised CSV export. The API enforces the caller's Space role, so this
 * panel renders nothing privileged that the server would refuse.
 */
function SpaceActivityPanel({ spaceId }: { spaceId: string }) {
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.spaceActivity>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    category: '' as '' | 'SPACE' | 'FILE' | 'FOLDER' | 'MEMBERSHIP' | 'INVITATION' | 'EXTENSION' | 'ARCHIVE' | 'CLEANUP' | 'STORAGE' | 'ADMIN' | 'SECURITY',
    outcome: '' as '' | 'SUCCESS' | 'FAILURE',
    actorType: '' as '' | 'USER' | 'ADMIN' | 'SYSTEM',
    from: '',
    sort: 'newest' as 'newest' | 'oldest',
    offset: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPage(
        await api.spaceActivity(spaceId, {
          category: filters.category || undefined,
          outcome: filters.outcome || undefined,
          actorType: filters.actorType || undefined,
          from: filters.from ? new Date(filters.from).toISOString() : undefined,
          sort: filters.sort,
          limit: 25,
          offset: filters.offset,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, [spaceId, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadSpaceActivity(spaceId, {
        category: filters.category || undefined,
        outcome: filters.outcome || undefined,
        actorType: filters.actorType || undefined,
        from: filters.from ? new Date(filters.from).toISOString() : undefined,
        sort: filters.sort,
      });
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

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-white p-3 shadow-xs">
        <label className="block text-[11px] font-medium text-muted">
          Category
          <select
            className="input mt-1 w-auto"
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as typeof f.category, offset: 0 }))}
          >
            <option value="">All</option>
            {['SPACE', 'FILE', 'FOLDER', 'MEMBERSHIP', 'INVITATION', 'EXTENSION', 'ARCHIVE', 'CLEANUP', 'STORAGE'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="block text-[11px] font-medium text-muted">
          Outcome
          <select
            className="input mt-1 w-auto"
            value={filters.outcome}
            onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value as typeof f.outcome, offset: 0 }))}
          >
            <option value="">Any</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
          </select>
        </label>
        <label className="block text-[11px] font-medium text-muted">
          Actor
          <select
            className="input mt-1 w-auto"
            value={filters.actorType}
            onChange={(e) => setFilters((f) => ({ ...f, actorType: e.target.value as typeof f.actorType, offset: 0 }))}
          >
            <option value="">Anyone</option>
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
            <option value="SYSTEM">System</option>
          </select>
        </label>
        <label className="block text-[11px] font-medium text-muted">
          From
          <input
            type="date"
            className="input mt-1 w-auto"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value, offset: 0 }))}
          />
        </label>
        <button
          className="btn-secondary px-3 py-1.5 text-[12px]"
          onClick={() => setFilters((f) => ({ ...f, sort: f.sort === 'newest' ? 'oldest' : 'newest', offset: 0 }))}
        >
          {filters.sort === 'newest' ? 'Newest first' : 'Oldest first'}
        </button>
        <button className="btn-secondary ml-auto px-3 py-1.5 text-[12px]" onClick={() => void exportCsv()} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
        <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Activity</h2>
        {loading ? (
          <div className="mt-4 space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-10 w-full rounded-lg" />)}
          </div>
        ) : (page?.entries.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-[13px] text-muted">No activity matches these filters.</p>
        ) : (
          <ol className="mt-4 divide-y divide-slate-100">
            {page!.entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 py-2.5">
                <span
                  className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                    entry.outcome === 'FAILURE' ? 'bg-red-500' : 'bg-flash-600'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-primary">
                    {entry.action.replace(/_/g, ' ').toLowerCase()}
                    <span className="ml-2 text-[11px] text-muted">{entry.category}</span>
                  </p>
                  <p className="text-[11px] text-muted">
                    {entry.actorType === 'SYSTEM'
                      ? 'FlashGuard worker'
                      : entry.actorName ?? (entry.userId ? entry.userId.slice(0, 8) : 'Unknown')}
                    {' · '}
                    {fmtDateTime(entry.createdAt)} · {timeAgo(entry.createdAt)}
                  </p>
                  {entry.reason && <p className="text-[11px] text-red-600">{entry.reason}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {page && page.total > 25 && (
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
            <span>
              {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}
            </span>
            <span className="flex gap-2">
              <button
                className="btn-secondary px-2.5 py-1 text-[12px]"
                disabled={page.offset === 0}
                onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - 25) }))}
              >
                Previous
              </button>
              <button
                className="btn-secondary px-2.5 py-1 text-[12px]"
                disabled={page.offset + page.limit >= page.total}
                onClick={() => setFilters((f) => ({ ...f, offset: f.offset + 25 }))}
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Read-only settings view for editors, viewers and archived Spaces. */
function SpaceSettingsReadOnly({
  space,
  writableStatus,
}: {
  space: SpaceDetailType;
  writableStatus: boolean;
}) {
  const reason = !writableStatus
    ? 'This Space is read-only because archiving has started.'
    : space.role === 'EDITOR'
      ? 'Editors can manage files and folders, but only the owner can change Space settings.'
      : space.role === 'VIEWER'
        ? 'You have view access to this Space. Only the owner can change its settings.'
        : 'You are viewing this Space as an administrator. Only the owner can change its settings.';

  return (
    <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Space settings</h2>
          <p className="mt-1 text-[12px] text-muted">{reason}</p>
        </div>
        <span className="badge bg-slate-100 text-slate-600">Read only</span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ReadOnlyField label="Name" value={space.name} />
        <ReadOnlyField label="Purpose" value={space.purpose} />
        <ReadOnlyField label="Description" value={space.description || '—'} full />
        <ReadOnlyField label="Starts" value={fmtDateTime(space.startAt)} />
        <ReadOnlyField label="Ends" value={fmtDateTime(space.expiryAt)} />
        <ReadOnlyField
          label="Invitations"
          value={
            space.invitationsEnabled === false
              ? 'Disabled'
              : `Enabled · default role ${space.defaultInviteRole ?? 'VIEWER'}`
          }
        />
        <ReadOnlyField label="Your role" value={space.role ?? 'ADMIN'} />
      </div>
    </section>
  );
}

function ReadOnlyField({
  label,
  value,
  full = false,
}: {
  label: string;
  value: string;
  full?: boolean;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <span className="field-label">{label}</span>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-primary">{value}</p>
    </div>
  );
}
