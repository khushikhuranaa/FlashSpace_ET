import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  AdminAnalytics,
  AdminAuditEntry,
  AdminCleanupRow,
  AdminHealth,
  AdminJobRow,
  AdminOverview,
  AdminUserDetail,
  AdminUserRow,
  Archive,
  ExtensionRequest,
} from '../types';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/ui';
import { useToast } from '../components/ToastProvider';
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format';

type Tab =
  | 'overview'
  | 'users'
  | 'lifecycle'
  | 'failed'
  | 'archives'
  | 'cleanup'
  | 'extensions'
  | 'health'
  | 'activity'
  | 'security'
  | 'audit'
  | 'analytics';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'failed', label: 'Failed jobs' },
  { id: 'archives', label: 'Archives' },
  { id: 'cleanup', label: 'Cleanup' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'health', label: 'Health' },
  { id: 'activity', label: 'Platform activity' },
  { id: 'security', label: 'Security' },
  { id: 'audit', label: 'Audit log' },
  { id: 'analytics', label: 'Analytics' },
];

const PAGE_SIZE = 25;

export default function Admin() {
  const toast = useToast().toast;
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userQuery, setUserQuery] = useState({
    q: '',
    role: '' as '' | 'USER' | 'ADMIN',
    status: '' as '' | 'ACTIVE' | 'SUSPENDED',
    offset: 0,
  });
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null);

  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobQuery, setJobQuery] = useState({
    status: '' as '' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED',
    jobType: '' as '' | 'LIFECYCLE' | 'ARCHIVE' | 'CLEANUP',
    q: '',
    offset: 0,
  });
  const [failedJobs, setFailedJobs] = useState<AdminJobRow[]>([]);
  const [archives, setArchives] = useState<(Archive & { spaceName: string | null })[]>([]);
  const [archiveFilter, setArchiveFilter] = useState<'' | 'FAILED' | 'VERIFIED' | 'PENDING'>('');
  const [cleanup, setCleanup] = useState<{
    runs: AdminCleanupRow[];
    awaiting: { spaceId: string; spaceName: string; status: string; retentionEligibleAt: string }[];
    failed: number;
    partial: number;
  } | null>(null);
  const [requests, setRequests] = useState<ExtensionRequest[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [security, setSecurity] = useState<AdminAuditEntry[]>([]);
  const [platformActivity, setPlatformActivity] = useState<
    Awaited<ReturnType<typeof api.adminActivity>> | null
  >(null);
  const [activityFilters, setActivityFilters] = useState({
    category: '' as '' | 'SPACE' | 'FILE' | 'FOLDER' | 'MEMBERSHIP' | 'INVITATION' | 'EXTENSION' | 'ARCHIVE' | 'CLEANUP' | 'STORAGE' | 'ADMIN' | 'SECURITY',
    outcome: '' as '' | 'SUCCESS' | 'FAILURE',
    actorType: '' as '' | 'USER' | 'ADMIN' | 'SYSTEM',
    q: '',
    sort: 'newest' as 'newest' | 'oldest',
    offset: 0,
  });
  const [exporting, setExporting] = useState(false);

  const [dialog, setDialog] = useState<
    | { kind: 'suspend'; user: AdminUserRow }
    | { kind: 'role'; user: AdminUserRow; role: 'USER' | 'ADMIN' }
    | null
  >(null);
  const [dialogReason, setDialogReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const report = useCallback(
    (e: unknown, fallback: string) => {
      const message = e instanceof Error ? e.message : fallback;
      setError(message);
      toast(message, 'error');
    },
    [toast],
  );

  const loadOverview = useCallback(async () => {
    setOverview(await api.adminOverview());
  }, []);

  const loadUsers = useCallback(async () => {
    const page = await api.adminUsers({
      q: userQuery.q || undefined,
      role: userQuery.role || undefined,
      status: userQuery.status || undefined,
      limit: PAGE_SIZE,
      offset: userQuery.offset,
    });
    setUsers(page.users);
    setUserTotal(page.total);
  }, [userQuery]);

  const loadJobs = useCallback(async () => {
    const page = await api.adminJobList({
      status: jobQuery.status || undefined,
      jobType: jobQuery.jobType || undefined,
      q: jobQuery.q || undefined,
      limit: PAGE_SIZE,
      offset: jobQuery.offset,
    });
    setJobs(page.jobs);
    setJobTotal(page.total);
  }, [jobQuery]);

  const loadTab = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      switch (tab) {
        case 'overview':
          await loadOverview();
          break;
        case 'users':
          await loadUsers();
          break;
        case 'lifecycle':
          await loadJobs();
          break;
        case 'failed': {
          const res = await api.adminFailedJobs();
          setFailedJobs(res.jobs);
          break;
        }
        case 'archives': {
          const res = await api.adminArchives(archiveFilter || undefined);
          setArchives(res.archives);
          break;
        }
        case 'cleanup':
          setCleanup(await api.adminCleanup());
          break;
        case 'extensions': {
          const res = await api.adminExtensions();
          setRequests(res.requests);
          break;
        }
        case 'health':
          setHealth(await api.adminHealth());
          break;
        case 'security': {
          const res = await api.adminSecurityEvents({ limit: 50 });
          setSecurity(res.entries);
          break;
        }
        case 'activity': {
          setPlatformActivity(
            await api.adminActivity({
              q: activityFilters.q || undefined,
              category: activityFilters.category || undefined,
              outcome: activityFilters.outcome || undefined,
              actorType: activityFilters.actorType || undefined,
              sort: activityFilters.sort,
              limit: 50,
              offset: activityFilters.offset,
            }),
          );
          break;
        }
        case 'audit': {
          const res = await api.adminAudit({ outlet: 'ALL', limit: 50, offset: auditOffset });
          setAudit(res.entries);
          setAuditTotal(res.total);
          break;
        }
        case 'analytics':
          setAnalytics(await api.adminAnalytics(14));
          break;
      }
    } catch (e) {
      report(e, 'Could not load admin data');
    } finally {
      setLoading(false);
    }
  }, [tab, loadOverview, loadUsers, loadJobs, archiveFilter, auditOffset, activityFilters, report]);

  useEffect(() => {
    void loadTab();
  }, [loadTab]);

  const openUser = async (userId: string) => {
    setBusy(userId);
    try {
      setSelectedUser(await api.adminUser(userId));
    } catch (e) {
      report(e, 'Could not load the user');
    } finally {
      setBusy(null);
    }
  };

  const applyRole = async (user: AdminUserRow, role: 'USER' | 'ADMIN', reason: string) => {
    setBusy(user.id);
    try {
      await api.adminSetRole(user.id, role, reason || undefined);
      toast(`${user.displayName} is now ${role === 'ADMIN' ? 'an administrator' : 'a standard user'}`, 'success');
      setDialog(null);
      setDialogReason('');
      await loadTab();
    } catch (e) {
      report(e, 'Could not change the role');
    } finally {
      setBusy(null);
    }
  };

  const applySuspend = async (user: AdminUserRow, reason: string) => {
    setBusy(user.id);
    try {
      await api.adminSuspend(user.id, reason);
      toast(`${user.displayName} was suspended`, 'success');
      setDialog(null);
      setDialogReason('');
      await loadTab();
    } catch (e) {
      report(e, 'Could not suspend the account');
    } finally {
      setBusy(null);
    }
  };

  const reactivate = async (user: AdminUserRow) => {
    setBusy(user.id);
    try {
      await api.adminReactivate(user.id);
      toast(`${user.displayName} was reactivated`, 'success');
      await loadTab();
    } catch (e) {
      report(e, 'Could not reactivate the account');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (requestId: string, decision: 'APPROVED' | 'REJECTED') => {
    setBusy(requestId);
    try {
      await api.adminDecide(requestId, decision);
      toast(decision === 'APPROVED' ? 'Extension approved' : 'Extension rejected', 'success');
      await loadTab();
    } catch (e) {
      report(e, 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const retryJob = async (jobId: string) => {
    setBusy(jobId);
    try {
      await api.adminRetryJob(jobId);
      toast('Retry completed', 'success');
      await loadTab();
    } catch (e) {
      report(e, 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  const retryArchive = async (archiveId: string) => {
    setBusy(archiveId);
    try {
      await api.adminRetryArchive(archiveId);
      toast('Archive retried', 'success');
      await loadTab();
    } catch (e) {
      report(e, 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  const downloadFile = async (loader: () => Promise<{ blob: Blob; filename: string }>) => {
    setExporting(true);
    try {
      const { blob, filename } = await loader();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      report(e, 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const pending = useMemo(() => requests.filter((r) => r.status === 'PENDING'), [requests]);
  const lastRun = overview?.jobs.lastSuccessAt ?? null;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="page-title">
              Admin control panel
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {lastRun ? `Last worker success ${timeAgo(lastRun)}` : 'Runner configured'}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            Platform users, lifecycle jobs, storage health and the administrative audit trail.
          </p>
        </div>
        <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => void loadTab()}>
          Refresh
        </button>
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <div className="tab-list flex-wrap" role="tablist" aria-label="Admin sections">
        {TABS.map((value) => (
          <button
            key={value.id}
            role="tab"
            aria-selected={tab === value.id}
            onClick={() => setTab(value.id)}
            className={`tab ${tab === value.id ? 'tab-active' : ''}`}
          >
            {value.label}
            {value.id === 'extensions' && pending.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">
                {pending.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && <p className="text-[13px] text-muted">Loading…</p>}

      {tab === 'overview' && overview && (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total users" value={overview.users.total} hint={`${overview.users.admins} admins`} />
            <StatCard
              label="Active users"
              value={overview.users.active}
              hint={`${overview.users.suspended} suspended`}
              chip={overview.users.suspended > 0 ? 'action' : undefined}
            />
            <StatCard label="Spaces" value={overview.spaces.total} hint={`${overview.spaces.active} active`} />
            <StatCard
              label="Warning window"
              value={overview.spaces.warning}
              hint={`${overview.spaces.archiving} archiving`}
              chip={overview.spaces.warning > 0 ? 'action' : undefined}
            />
            <StatCard label="Temporary storage" value={fmtBytes(overview.storage.temporaryBytes)} hint={`${overview.storage.fileCount} files`} icon="hard-drive" />
            <StatCard label="Vault storage" value={fmtBytes(overview.storage.vaultBytes)} hint={`${overview.storage.verifiedArchives} verified archives`} icon="archive" />
            <StatCard
              label="Failed jobs"
              value={overview.jobs.failed}
              hint={`${overview.jobs.awaitingIntervention} awaiting intervention`}
              chip={overview.jobs.failed > 0 ? 'action' : undefined}
            />
            <StatCard
              label="Pending tickets"
              value={overview.queues.pendingExtensions + overview.queues.pendingJoinRequests}
              hint={`${overview.queues.pendingExtensions} extension(s) · ${overview.queues.pendingJoinRequests} join request(s)`}
            />
          </section>

          <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-base font-bold tracking-tight text-primary">Spaces by lifecycle state</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ['draft', overview.spaces.draft],
                  ['active', overview.spaces.active],
                  ['warning', overview.spaces.warning],
                  ['archiving', overview.spaces.archiving],
                  ['archived', overview.spaces.archived],
                  ['archive failed', overview.spaces.archiveFailed],
                  ['deleted', overview.spaces.deleted],
                ] as [string, number][]
              ).map(([label, count]) => (
                <span key={label} className="badge border border-line bg-slate-50 text-slate-700">
                  {label} · <span className="font-mono">{count}</span>
                </span>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MiniPanel title="Jobs" rows={[
              ['Pending', overview.jobs.pending],
              ['Running', overview.jobs.running],
              ['Succeeded', overview.jobs.succeeded],
              ['Failed', overview.jobs.failed],
            ]} />
            <MiniPanel title="Email delivery" rows={[
              ['Mode', overview.email.mode],
              ['Sent', overview.email.sent],
              ['Failed', overview.email.failed],
              ['Queued', overview.email.pending],
            ]} />
            <MiniPanel title="Queues" rows={[
              ['Extensions', overview.queues.pendingExtensions],
              ['Join requests', overview.queues.pendingJoinRequests],
              ['Invitations', overview.queues.pendingInvitations],
              ['Email retries', overview.queues.pendingEmailRetries],
            ]} />
          </section>
        </>
      )}

      {tab === 'users' && (
        <>
          <section className="rounded-xl border border-line bg-white p-3 shadow-xs">
            <div className="flex flex-wrap gap-2">
              <input
                className="input max-w-xs"
                placeholder="Search name, email or user ID"
                value={userQuery.q}
                onChange={(e) => setUserQuery((q) => ({ ...q, q: e.target.value, offset: 0 }))}
              />
              <select
                className="input w-auto"
                value={userQuery.role}
                onChange={(e) => setUserQuery((q) => ({ ...q, role: e.target.value as typeof q.role, offset: 0 }))}
              >
                <option value="">All roles</option>
                <option value="ADMIN">Admin</option>
                <option value="USER">User</option>
              </select>
              <select
                className="input w-auto"
                value={userQuery.status}
                onChange={(e) => setUserQuery((q) => ({ ...q, status: e.target.value as typeof q.status, offset: 0 }))}
              >
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">User</th>
                    <th className="px-5 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Spaces</th>
                    <th className="px-5 py-3 font-medium">Joined</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {users.map((profile) => (
                    <tr key={profile.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-flash-50 text-[11px] font-bold text-flash-700">
                            {profile.displayName.charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <span className="block font-medium text-primary">{profile.displayName}</span>
                            <span className="block text-[11px] text-muted">{profile.email}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`badge ${profile.role === 'ADMIN' ? 'bg-flash-50 text-flash-700' : 'bg-slate-100 text-slate-700'}`}>
                          {profile.role}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={profile.status ?? 'ACTIVE'} />
                      </td>
                      <td className="px-5 py-3 text-[12px] text-muted">
                        {profile.spaceCount} owned · {profile.membershipCount} member
                      </td>
                      <td className="px-5 py-3 text-[12px] text-muted">
                        {fmtDateTime(profile.createdAt)}
                        <span className="block text-[11px]">
                          {profile.lastActiveAt ? `active ${timeAgo(profile.lastActiveAt)}` : 'never signed in'}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            className="btn-secondary px-2 py-1 text-[11.5px]"
                            disabled={busy === profile.id}
                            onClick={() => void openUser(profile.id)}
                          >
                            View
                          </button>
                          <button
                            className="btn-secondary px-2 py-1 text-[11.5px]"
                            disabled={busy === profile.id}
                            onClick={() => {
                              setDialogReason('');
                              setDialog({ kind: 'role', user: profile, role: profile.role === 'ADMIN' ? 'USER' : 'ADMIN' });
                            }}
                          >
                            {profile.role === 'ADMIN' ? 'Demote' : 'Promote'}
                          </button>
                          {(profile.status ?? 'ACTIVE') === 'ACTIVE' ? (
                            <button
                              className="rounded-lg bg-red-50 px-2 py-1 text-[11.5px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                              disabled={busy === profile.id}
                              onClick={() => {
                                setDialogReason('');
                                setDialog({ kind: 'suspend', user: profile });
                              }}
                            >
                              Suspend
                            </button>
                          ) : (
                            <button
                              className="rounded-lg bg-emerald-50 px-2 py-1 text-[11.5px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                              disabled={busy === profile.id}
                              onClick={() => void reactivate(profile)}
                            >
                              Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-muted">
                        No users match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-line/70 md:hidden">
              {users.map((profile) => (
                <div key={profile.id} className="p-4">
                  <div className="flex items-start gap-2">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-flash-50 text-[11px] font-bold text-flash-700">
                      {profile.displayName.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-primary">{profile.displayName}</p>
                      <p className="truncate text-[11.5px] text-muted">{profile.email}</p>
                    </div>
                    <StatusBadge status={profile.status ?? 'ACTIVE'} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
                    <span className={`badge ${profile.role === 'ADMIN' ? 'bg-flash-50 text-flash-700' : 'bg-slate-100 text-slate-700'}`}>
                      {profile.role}
                    </span>
                    <span>{profile.spaceCount} owned · {profile.membershipCount} member</span>
                    <span>Joined {fmtDateTime(profile.createdAt)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button
                      className="btn-secondary px-2 py-1 text-[11.5px]"
                      disabled={busy === profile.id}
                      onClick={() => void openUser(profile.id)}
                    >
                      View
                    </button>
                    <button
                      className="btn-secondary px-2 py-1 text-[11.5px]"
                      disabled={busy === profile.id}
                      onClick={() => {
                        setDialogReason('');
                        setDialog({ kind: 'role', user: profile, role: profile.role === 'ADMIN' ? 'USER' : 'ADMIN' });
                      }}
                    >
                      {profile.role === 'ADMIN' ? 'Demote' : 'Promote'}
                    </button>
                    {(profile.status ?? 'ACTIVE') === 'ACTIVE' ? (
                      <button
                        className="rounded-lg bg-red-50 px-2 py-1 text-[11.5px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                        disabled={busy === profile.id}
                        onClick={() => {
                          setDialogReason('');
                          setDialog({ kind: 'suspend', user: profile });
                        }}
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        className="rounded-lg bg-emerald-50 px-2 py-1 text-[11.5px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        disabled={busy === profile.id}
                        onClick={() => void reactivate(profile)}
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {users.length === 0 && <p className="px-4 py-8 text-center text-[12px] text-muted">No users match these filters.</p>}
            </div>
            <Pagination
              total={userTotal}
              offset={userQuery.offset}
              onChange={(offset) => setUserQuery((q) => ({ ...q, offset }))}
            />
          </section>

          {selectedUser && (
            <UserDetailPanel detail={selectedUser} onClose={() => setSelectedUser(null)} />
          )}
        </>
      )}

      {tab === 'lifecycle' && (
        <section className="space-y-3">
          <div className="rounded-xl border border-line bg-white p-3 shadow-xs">
            <div className="flex flex-wrap gap-2">
              <input
                className="input max-w-xs"
                placeholder="Search job, Space or idempotency key"
                value={jobQuery.q}
                onChange={(e) => setJobQuery((q) => ({ ...q, q: e.target.value, offset: 0 }))}
              />
              <select
                className="input w-auto"
                value={jobQuery.status}
                onChange={(e) => setJobQuery((q) => ({ ...q, status: e.target.value as typeof q.status, offset: 0 }))}
              >
                <option value="">All statuses</option>
                {['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                className="input w-auto"
                value={jobQuery.jobType}
                onChange={(e) => setJobQuery((q) => ({ ...q, jobType: e.target.value as typeof q.jobType, offset: 0 }))}
              >
                <option value="">All types</option>
                {['LIFECYCLE', 'ARCHIVE', 'CLEANUP'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <JobTable jobs={jobs} busy={busy} onRetry={retryJob} />
          <Pagination
            total={jobTotal}
            offset={jobQuery.offset}
            onChange={(offset) => setJobQuery((q) => ({ ...q, offset }))}
          />
        </section>
      )}

      {tab === 'failed' && (
        <section className="space-y-3">
          <p className="text-[13px] text-muted">
            Failed jobs that can still be retried are shown with a retry action. Jobs at the
            {` ${jobs[0]?.maxAttempts ?? 3} `}attempt ceiling are reported as permanent failures.
          </p>
          <JobTable jobs={failedJobs} busy={busy} onRetry={retryJob} />
        </section>
      )}

      {tab === 'archives' && (
        <section className="space-y-3">
          <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1 shadow-xs">
            {(['', 'FAILED', 'VERIFIED', 'PENDING'] as const).map((value) => (
              <button
                key={value || 'all'}
                onClick={() => setArchiveFilter(value)}
                className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${
                  archiveFilter === value ? 'bg-flash-600 text-white' : 'text-muted hover:bg-slate-50'
                }`}
              >
                {value || 'All'}
              </button>
            ))}
          </div>
          <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Space</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Files</th>
                    <th className="px-5 py-3 font-medium">Size</th>
                    <th className="px-5 py-3 font-medium">Created</th>
                    <th className="px-5 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {archives.map((archive) => (
                    <tr key={archive.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3 text-primary">{archive.spaceName ?? archive.spaceId.slice(0, 8)}</td>
                      <td className="px-5 py-3">
                        <span className={`badge ${
                          archive.status === 'VERIFIED'
                            ? 'bg-emerald-50 text-emerald-700'
                            : archive.status === 'FAILED'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-slate-100 text-slate-700'
                        }`}>
                          {archive.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-[12px] text-muted">{archive.fileCount}</td>
                      <td className="px-5 py-3 text-[12px] text-muted">{fmtBytes(archive.sizeBytes)}</td>
                      <td className="px-5 py-3 text-[12px] text-muted">{fmtDateTime(archive.createdAt)}</td>
                      <td className="px-5 py-3 text-right">
                        {archive.status === 'FAILED' ? (
                          <button
                            className="btn-secondary px-2.5 py-1 text-[12px]"
                            disabled={busy === archive.id}
                            onClick={() => void retryArchive(archive.id)}
                          >
                            Retry
                          </button>
                        ) : (
                          <span className="text-[12px] text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {archives.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-muted">
                        No archives with this status.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      )}

      {tab === 'cleanup' && cleanup && (
        <section className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Awaiting cleanup" value={cleanup.awaiting.length} hint="Archived, retention reached" />
            <StatCard label="Failed runs" value={cleanup.failed} hint="Diagnose below" chip={cleanup.failed > 0 ? 'action' : undefined} />
            <StatCard label="Partial failures" value={cleanup.partial} hint="Some objects remain" />
          </div>
          <h2 className="font-display text-base font-bold tracking-tight text-primary">Spaces awaiting cleanup</h2>
          <SimpleTable
            headers={['Space', 'Status', 'Retention eligible']}
            rows={cleanup.awaiting.map((row) => [row.spaceName, row.status, fmtDateTime(row.retentionEligibleAt)])}
            empty="No Space is eligible for cleanup."
          />
          <h2 className="font-display text-base font-bold tracking-tight text-primary">Cleanup runs</h2>
          <SimpleTable
            headers={['Space', 'Status', 'Revoked', 'Objects', 'Remaining', 'Started']}
            rows={cleanup.runs.map((run) => [
              run.spaceName ?? run.spaceId.slice(0, 8),
              run.status,
              String(run.membershipsRevoked),
              String(run.objectsDeleted),
              fmtBytes(run.remainingBytes),
              fmtDateTime(run.startedAt),
            ])}
            empty="No cleanup has run yet."
          />
        </section>
      )}

      {tab === 'extensions' && (
        <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Extension requests</h2>
            <span className="text-[12px] text-muted">{pending.length} pending</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Space</th>
                  <th className="px-5 py-3 font-medium">Requested</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                  <th className="px-5 py-3 font-medium">Submitted</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {requests.map((request) => (
                  <tr key={request.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-mono text-[12px] text-primary">{request.spaceId.slice(0, 8)}…</td>
                    <td className="px-5 py-3 text-primary">{request.requestedDays} day(s)</td>
                    <td className="max-w-[280px] px-5 py-3">
                      <span className="block truncate text-muted" title={request.reason}>{request.reason}</span>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-muted">{timeAgo(request.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {request.status === 'PENDING' ? (
                        <span className="inline-flex gap-2">
                          <button
                            className="rounded-lg bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            disabled={busy === request.id}
                            onClick={() => void decide(request.id, 'APPROVED')}
                          >
                            Approve
                          </button>
                          <button
                            className="rounded-lg bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                            disabled={busy === request.id}
                            onClick={() => void decide(request.id, 'REJECTED')}
                          >
                            Reject
                          </button>
                        </span>
                      ) : (
                        <span className={`badge ${
                          request.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                        }`}>
                          {request.status}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {requests.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-muted">No extension requests.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'health' && health && (
        <section className="space-y-4">
          <div className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-base font-bold tracking-tight text-primary">System health</h2>
            <p className="mt-1 text-[12px] text-muted">
              {health.version} · uptime {Math.floor(health.uptimeSeconds / 60)} min · checked{' '}
              {fmtDateTime(health.generatedAt)}
            </p>
          </div>
          <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Check</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Detail</th>
                    <th className="px-5 py-3 font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {health.checks.map((check) => (
                    <tr key={check.name}>
                      <td className="px-5 py-3 capitalize text-primary">{check.name}</td>
                      <td className="px-5 py-3">
                        <span className={`badge ${
                          check.status === 'ok'
                            ? 'bg-emerald-50 text-emerald-700'
                            : check.status === 'error'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-amber-50 text-amber-800'
                        }`}>
                          {check.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-muted">{check.detail}</td>
                      <td className="px-5 py-3 text-[12px] text-muted">
                        {check.latencyMs === null ? '—' : `${check.latencyMs} ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      )}

      {tab === 'activity' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-white p-3 shadow-xs">
            <input
              className="input max-w-[220px]"
              placeholder="Search actor name or email"
              value={activityFilters.q}
              onChange={(e) => setActivityFilters((f) => ({ ...f, q: e.target.value, offset: 0 }))}
            />
            <select
              className="input w-auto"
              aria-label="Filter by category"
              value={activityFilters.category}
              onChange={(e) => setActivityFilters((f) => ({ ...f, category: e.target.value as typeof f.category, offset: 0 }))}
            >
              <option value="">All categories</option>
              {['SPACE', 'FILE', 'FOLDER', 'MEMBERSHIP', 'INVITATION', 'EXTENSION', 'ARCHIVE', 'CLEANUP', 'STORAGE', 'ADMIN', 'SECURITY'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              className="input w-auto"
              aria-label="Filter by actor type"
              value={activityFilters.actorType}
              onChange={(e) => setActivityFilters((f) => ({ ...f, actorType: e.target.value as typeof f.actorType, offset: 0 }))}
            >
              <option value="">All actors</option>
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
              <option value="SYSTEM">System</option>
            </select>
            <select
              className="input w-auto"
              aria-label="Filter by outcome"
              value={activityFilters.outcome}
              onChange={(e) => setActivityFilters((f) => ({ ...f, outcome: e.target.value as typeof f.outcome, offset: 0 }))}
            >
              <option value="">Any outcome</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </select>
            <button
              className="btn-secondary px-3 py-1.5 text-[12px]"
              onClick={() => setActivityFilters((f) => ({ ...f, sort: f.sort === 'newest' ? 'oldest' : 'newest', offset: 0 }))}
            >
              {activityFilters.sort === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
            <button
              className="btn-secondary ml-auto px-3 py-1.5 text-[12px]"
              disabled={exporting}
              onClick={() =>
                void downloadFile(() =>
                  api.downloadAdminActivity({
                    q: activityFilters.q || undefined,
                    category: activityFilters.category || undefined,
                    actorType: activityFilters.actorType || undefined,
                    outcome: activityFilters.outcome || undefined,
                    sort: activityFilters.sort,
                  }),
                )
              }
            >
              {exporting ? 'Preparing…' : 'Export CSV'}
            </button>
          </div>
          {platformActivity && (
            <>
              <SimpleTable
                headers={['When', 'Actor', 'Action', 'Category', 'Outcome', 'Target']}
                rows={platformActivity.entries.map((entry) => [
                  fmtDateTime(entry.createdAt),
                  entry.actorType === 'SYSTEM'
                    ? 'System worker'
                    : `${entry.actorName ?? (entry.userId ? entry.userId.slice(0, 8) : 'Unknown')}${entry.actorEmail ? ` · ${entry.actorEmail}` : ''}`,
                  entry.action,
                  entry.category,
                  entry.outcome,
                  `${entry.resourceType ?? '—'}:${entry.resourceId ? entry.resourceId.slice(0, 8) : '—'}`,
                ])}
                empty="No platform activity matches these filters."
              />
              <Pagination
                total={platformActivity.total}
                offset={platformActivity.offset}
                onChange={(offset) => setActivityFilters((f) => ({ ...f, offset }))}
                pageSize={50}
              />
            </>
          )}
        </section>
      )}

      {(tab === 'security' || tab === 'audit') && (
        <section className="space-y-3">
          <p className="text-[13px] text-muted">
            {tab === 'security'
              ? 'Security-relevant events: sign-in failures, role changes, suspensions and reactivations.'
              : 'Every sensitive administrative action is appended here. Records cannot be edited or deleted.'}
          </p>
          <AuditTable entries={tab === 'security' ? security : audit} />
          {tab === 'audit' && (
            <>
              <Pagination total={auditTotal} offset={auditOffset} onChange={setAuditOffset} />
              <button
                className="btn-secondary px-3 py-1.5 text-[12px]"
                disabled={exporting}
                onClick={() => void downloadFile(() => api.downloadAdminAudit('ALL'))}
              >
                {exporting ? 'Preparing…' : 'Export audit CSV'}
              </button>
            </>
          )}
        </section>
      )}

      {tab === 'analytics' && analytics && (
        <section className="space-y-4">
          <p className="text-[13px] text-muted">
            Last {analytics.days} days of persisted activity. Metrics this deployment cannot compute
            are listed rather than invented.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Registrations" value={analytics.totals.registrations} hint={`${analytics.days}-day window`} />
            <StatCard label="Spaces created" value={analytics.totals.spacesCreated} hint="In window" />
            <StatCard label="Archives verified" value={analytics.totals.archivesCompleted} hint={`${analytics.totals.archivesFailed} failed`} />
            <StatCard label="Extensions approved" value={analytics.totals.extensionsApproved} hint={`${analytics.totals.extensionsRejected} rejected`} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BucketChart title="User registrations" buckets={analytics.registrations} />
            <BucketChart title="Spaces created" buckets={analytics.spacesCreated} />
            <BucketChart title="Jobs succeeded" buckets={analytics.jobsSucceeded} />
            <BucketChart title="Jobs failed" buckets={analytics.jobsFailed} />
            <BucketChart title="Emails sent" buckets={analytics.emailsSent} />
            <BucketChart title="Emails failed" buckets={analytics.emailsFailed} />
          </div>
          {analytics.unavailable.length > 0 && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-muted">
              Not available from persisted data: {analytics.unavailable.join(', ')}.
            </p>
          )}
        </section>
      )}

      {dialog?.kind === 'suspend' && (
        <Dialog
          title={`Suspend ${dialog.user.displayName}`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                disabled={dialogReason.trim().length < 5 || busy === dialog.user.id}
                onClick={() => void applySuspend(dialog.user, dialogReason.trim())}
              >
                Suspend account
              </button>
            </>
          }
        >
          <p className="text-[13px] text-muted">
            The user can no longer sign in or use existing sessions. Their Spaces, files and Vault
            archives are preserved and ownership is not transferred.
          </p>
          <label className="mt-3 block text-[12px] font-medium text-primary" htmlFor="suspend-reason">
            Reason (required, min 5 characters)
          </label>
          <textarea
            id="suspend-reason"
            className="input mt-1 h-20 w-full"
            value={dialogReason}
            onChange={(e) => setDialogReason(e.target.value)}
          />
        </Dialog>
      )}

      {dialog?.kind === 'role' && (
        <Dialog
          title={`${dialog.role === 'ADMIN' ? 'Promote' : 'Demote'} ${dialog.user.displayName}`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="btn-primary px-3 py-1.5 text-[12px]"
                disabled={busy === dialog.user.id}
                onClick={() => void applyRole(dialog.user, dialog.role, dialogReason.trim())}
              >
                Confirm {dialog.role === 'ADMIN' ? 'promotion' : 'demotion'}
              </button>
            </>
          }
        >
          <p className="text-[13px] text-muted">
            This changes the <strong>global</strong> role only. Space OWNER/EDITOR/VIEWER roles are
            not modified. The last administrator cannot be demoted.
          </p>
          <label className="mt-3 block text-[12px] font-medium text-primary" htmlFor="role-reason">
            Reason (optional)
          </label>
          <input
            id="role-reason"
            className="input mt-1 w-full"
            value={dialogReason}
            onChange={(e) => setDialogReason(e.target.value)}
          />
        </Dialog>
      )}
    </div>
  );
}

// -- small presentational helpers -------------------------------------------

function MiniPanel({ title, rows }: { title: string; rows: [string, string | number][] }) {
  return (
    <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">{title}</h2>
      <dl className="mt-3 space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between text-[12.5px]">
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono text-primary">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Pagination({
  total,
  offset,
  onChange,
  pageSize = PAGE_SIZE,
}: {
  total: number;
  offset: number;
  onChange: (n: number) => void;
  pageSize?: number;
}) {
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[12px] text-muted">
      <span>
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <span className="flex gap-2">
        <button
          className="btn-secondary px-2.5 py-1 text-[12px]"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <button
          className="btn-secondary px-2.5 py-1 text-[12px]"
          disabled={offset + pageSize >= total}
          onClick={() => onChange(offset + pageSize)}
        >
          Next
        </button>
      </span>
    </div>
  );
}

function SimpleTable({ headers, rows, empty }: { headers: string[]; rows: string[][]; empty: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-5 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {rows.map((row, index) => (
              <tr key={index} className="hover:bg-slate-50">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-5 py-3 text-muted">{cell}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={headers.length} className="px-5 py-8 text-center text-muted">{empty}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JobTable({
  jobs,
  busy,
  onRetry,
}: {
  jobs: AdminJobRow[];
  busy: string | null;
  onRetry: (jobId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Job</th>
              <th className="px-5 py-3 font-medium">Space</th>
              <th className="px-5 py-3 font-medium">Attempts</th>
              <th className="px-5 py-3 font-medium">Last update</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-slate-50">
                <td className="px-5 py-3">
                  <span className="block font-mono text-[12px] text-primary">{job.jobType}</span>
                  <span className="block max-w-[240px] truncate font-mono text-[11px] text-muted">
                    {job.idempotencyKey}
                  </span>
                </td>
                <td className="px-5 py-3 text-[12px] text-muted">
                  {job.spaceName ?? (job.spaceId ? `${job.spaceId.slice(0, 8)}…` : '—')}
                </td>
                <td className="px-5 py-3 font-mono text-[12px] text-muted">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="px-5 py-3 text-[12px] text-muted">
                  {fmtDateTime(job.finishedAt ?? job.startedAt)}
                </td>
                <td className="px-5 py-3">
                  <span className={`badge ${
                    job.status === 'SUCCEEDED'
                      ? 'bg-emerald-50 text-emerald-700'
                      : job.status === 'FAILED'
                        ? 'bg-red-50 text-red-700'
                        : job.status === 'RUNNING'
                          ? 'bg-info-50 text-info-700'
                          : 'bg-slate-100 text-slate-700'
                  }`}>
                    {job.status}
                  </span>
                  {job.error && (
                    <span className="mt-1 block max-w-[240px] truncate text-[11px] text-red-600" title={job.error}>
                      {job.error}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  {job.retryable ? (
                    <button
                      className="btn-secondary px-2.5 py-1 text-[12px]"
                      disabled={busy === job.id}
                      onClick={() => onRetry(job.id)}
                    >
                      Retry
                    </button>
                  ) : (
                    <span className="text-[11.5px] text-muted">
                      {job.status === 'FAILED' ? 'Permanent' : '—'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-muted">
                  No jobs match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AuditTable({ entries }: { entries: AdminAuditEntry[] }) {
  return (
    <SimpleTable
      headers={['Action', 'Actor', 'Target', 'Outcome', 'When']}
      rows={entries.map((entry) => [
        entry.action,
        entry.adminName ?? entry.adminId.slice(0, 8),
        `${entry.targetType}:${entry.targetId.slice(0, 8)}`,
        entry.outcome,
        fmtDateTime(entry.createdAt),
      ])}
      empty="No records yet."
    />
  );
}

function BucketChart({ title, buckets }: { title: string; buckets: { date: string; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">{title}</h2>
      <div className="mt-3 flex h-24 items-end gap-1">
        {buckets.map((bucket) => (
          <div
            key={bucket.date}
            className="flex-1 rounded-t bg-flash-500/70"
            style={{ height: `${Math.max(2, (bucket.count / max) * 100)}%` }}
            title={`${bucket.date}: ${bucket.count}`}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        {buckets.length} day(s) · peak {max}
      </p>
    </section>
  );
}

function UserDetailPanel({ detail, onClose }: { detail: AdminUserDetail; onClose: () => void }) {
  return (
    <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-base font-bold tracking-tight text-primary">
              {detail.user.displayName}
            </h2>
            <button
              className="rounded-md p-1 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
              onClick={onClose}
              aria-label="Close user details"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-[12px] text-muted">{detail.user.email}</p>
          <p className="mt-1 text-[11.5px] text-muted">
            {detail.user.role} · {detail.user.status ?? 'ACTIVE'} · joined {fmtDateTime(detail.user.createdAt)}
            {detail.user.lastActiveAt ? ` · last active ${timeAgo(detail.user.lastActiveAt)}` : ' · never signed in'}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MiniPanel title="Counts" rows={[
          ['Spaces owned', detail.counts.spacesOwned],
          ['Memberships', detail.counts.memberships],
          ['Files uploaded', detail.counts.files],
        ]} />
        <div className="sm:col-span-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Spaces owned</h3>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {detail.spacesOwned.map((space) => (
              <li key={space.id} className="flex items-center justify-between">
                <span className="truncate text-primary">{space.name}</span>
                <StatusBadge status={space.status} />
              </li>
            ))}
            {detail.spacesOwned.length === 0 && <li className="text-muted">No Spaces owned.</li>}
          </ul>
        </div>
      </div>

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Recent activity</h3>
      <ul className="mt-2 space-y-1 text-[12.5px]">
        {detail.recentActivity.slice(0, 10).map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3">
            <span className="truncate text-primary">{entry.action}</span>
            <span className="text-[11px] text-muted">{fmtDateTime(entry.createdAt)}</span>
          </li>
        ))}
        {detail.recentActivity.length === 0 && <li className="text-muted">No recorded activity.</li>}
      </ul>

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
        Security events for this account
      </h3>
      <ul className="mt-2 space-y-1 text-[12.5px]">
        {detail.securityEvents.slice(0, 10).map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3">
            <span className="truncate text-primary">{entry.action}</span>
            <span className="text-[11px] text-muted">{fmtDateTime(entry.createdAt)}</span>
          </li>
        ))}
        {detail.securityEvents.length === 0 && <li className="text-muted">No security events.</li>}
      </ul>
    </section>
  );
}

function Dialog({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-5 shadow-xl">
        <h2 className="font-display text-base font-bold tracking-tight text-primary">{title}</h2>
        <div className="mt-2">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          {footer}
        </div>
        <button className="sr-only" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
