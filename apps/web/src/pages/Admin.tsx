import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminStats, ExtensionRequest, LifecycleJob, Profile } from '../types';
import { StatCard } from '../components/StatCard';
import { Icon } from '../components/Icon';
import { useToast } from '../components/ToastProvider';
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format';

type Tab = 'overview' | 'users' | 'extensions' | 'jobs';

export default function Admin() {
  const toast = useToast().toast;
  const [tab, setTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [requests, setRequests] = useState<ExtensionRequest[]>([]);
  const [jobs, setJobs] = useState<LifecycleJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, u, r, j] = await Promise.all([
      api.adminStats(),
      api.adminUsers(),
      api.adminExtensions(),
      api.adminJobs(),
    ]);
    setStats(s);
    setUsers(u.users);
    setRequests(r.requests);
    setJobs(j.jobs);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load admin data'));
  }, [load]);

  const decide = async (id: string, decision: 'APPROVED' | 'REJECTED') => {
    setBusyId(id);
    try {
      await api.adminDecide(id, decision);
      await load();
      toast(decision === 'APPROVED' ? 'Extension approved' : 'Extension rejected', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Decision failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (profile: Profile) => {
    setBusyId(profile.id);
    try {
      await api.adminPromote(profile.id);
      await load();
      toast(`${profile.displayName} is now an administrator`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not promote user', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pending = requests.filter((r) => r.status === 'PENDING');
  const latestJob = jobs[0];

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">
              Admin &amp; Lifecycle Management
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {latestJob ? `Last job ${timeAgo(latestJob.startedAt)}` : 'Runner configured'}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            Platform health, extension decisions and the lifecycle job history.
          </p>
        </div>
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1 shadow-xs">
        {(['overview', 'users', 'extensions', 'jobs'] as Tab[]).map((value) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            aria-pressed={tab === value}
            className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium capitalize transition-colors ${
              tab === value ? 'bg-flash-600 text-white' : 'text-muted hover:bg-slate-50 hover:text-primary'
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {tab === 'overview' && stats && (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total users" value={stats.users} hint="Registered accounts" />
            <StatCard label="Active Spaces" value={stats.activeSpaces} hint={`${stats.spaces} total Spaces`} />
            <StatCard
              label="Warning window"
              value={stats.warningWindow}
              hint="Inside the expiry warning"
              chip={stats.warningWindow > 0 ? 'action' : undefined}
            />
            <StatCard
              label="Pending tickets"
              value={pending.length}
              hint={`${stats.pendingJoinRequests} join request(s)`}
            />
            <StatCard
              label="Archival pipeline"
              value={`${stats.archivalPipeline}%`}
              hint={`${stats.verifiedArchives} verified · ${stats.failedArchives} failed`}
            />
            <StatCard label="Total files" value={stats.totalFiles} hint="Active objects" icon="file" />
            <StatCard label="Live storage" value={fmtBytes(stats.totalStorageBytes)} hint="Across all Spaces" icon="hard-drive" />
            <StatCard label="Vault storage" value={fmtBytes(stats.archivedBytes)} hint="Verified archives" icon="archive" />
          </section>

          <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
            <h2 className="font-display text-base font-bold tracking-tight text-primary">Spaces by status</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(stats.spacesByStatus).map(([status, count]) => (
                <span key={status} className="badge border border-line bg-slate-50 text-slate-700">
                  {status.toLowerCase()} · <span className="font-mono">{count}</span>
                </span>
              ))}
              {Object.keys(stats.spacesByStatus).length === 0 && (
                <span className="text-[13px] text-muted">No Spaces yet.</span>
              )}
            </div>
          </section>

          <PendingExtensions
            requests={pending}
            busyId={busyId}
            onDecide={decide}
          />

          <section>
            <h2 className="mb-3 font-display text-base font-bold tracking-tight text-primary">
              Lifecycle job history
            </h2>
            <JobTable jobs={jobs.slice(0, 10)} />
          </section>
        </>
      )}

      {tab === 'users' && (
        <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Joined</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
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
                      <span
                        className={`badge ${
                          profile.role === 'ADMIN'
                            ? 'bg-flash-50 text-flash-700'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {profile.role}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-muted">{fmtDateTime(profile.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {profile.role !== 'ADMIN' && (
                        <button
                          className="btn-secondary px-3 py-1.5 text-[12px]"
                          disabled={busyId === profile.id}
                          onClick={() => void promote(profile)}
                        >
                          <Icon name="shield" size={14} />
                          Promote
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-muted">
                      No users registered yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'extensions' && (
        <PendingExtensions
          requests={requests.filter((r) => r.status === 'PENDING')}
          all={requests}
          busyId={busyId}
          onDecide={decide}
        />
      )}

      {tab === 'jobs' && <JobTable jobs={jobs} />}
    </div>
  );
}

function PendingExtensions({
  requests,
  all,
  busyId,
  onDecide,
}: {
  requests: ExtensionRequest[];
  all?: ExtensionRequest[];
  busyId: string | null;
  onDecide: (id: string, decision: 'APPROVED' | 'REJECTED') => void;
}) {
  const rows = all ?? requests;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">
          Extension requests
        </h2>
        <span className="text-[12px] text-muted">
          {requests.length} pending
        </span>
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
            {rows.map((request) => (
              <tr key={request.id} className="hover:bg-slate-50">
                <td className="px-5 py-3 font-mono text-[12px] text-primary">
                  {request.spaceId.slice(0, 8)}…
                </td>
                <td className="px-5 py-3 text-primary">{request.requestedDays} day(s)</td>
                <td className="max-w-[280px] px-5 py-3">
                  <span className="block truncate text-muted" title={request.reason}>
                    {request.reason}
                  </span>
                </td>
                <td className="px-5 py-3 text-[12px] text-muted">{timeAgo(request.createdAt)}</td>
                <td className="px-5 py-3 text-right">
                  {request.status === 'PENDING' ? (
                    <span className="inline-flex gap-2">
                      <button
                        className="rounded-lg bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        disabled={busyId === request.id}
                        onClick={() => onDecide(request.id, 'APPROVED')}
                      >
                        Approve
                      </button>
                      <button
                        className="rounded-lg bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                        disabled={busyId === request.id}
                        onClick={() => onDecide(request.id, 'REJECTED')}
                      >
                        Reject
                      </button>
                    </span>
                  ) : (
                    <span
                      className={`badge ${
                        request.status === 'APPROVED'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {request.status}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted">
                  No extension requests.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JobTable({ jobs }: { jobs: LifecycleJob[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Job</th>
              <th className="px-5 py-3 font-medium">Space</th>
              <th className="px-5 py-3 font-medium">Started</th>
              <th className="px-5 py-3 font-medium">Attempts</th>
              <th className="px-5 py-3 font-medium">Status</th>
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
                <td className="px-5 py-3 font-mono text-[12px] text-muted">
                  {job.spaceId ? `${job.spaceId.slice(0, 8)}…` : '—'}
                </td>
                <td className="px-5 py-3 text-[12px] text-muted">{fmtDateTime(job.startedAt)}</td>
                <td className="px-5 py-3 font-mono text-[12px] text-muted">{job.attempts}</td>
                <td className="px-5 py-3">
                  <span
                    className={`badge ${
                      job.status === 'SUCCEEDED'
                        ? 'bg-emerald-50 text-emerald-700'
                        : job.status === 'FAILED'
                          ? 'bg-red-50 text-red-700'
                          : job.status === 'RUNNING'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-slate-100 text-slate-700'
                    }`}
                    title={job.error ?? undefined}
                  >
                    {job.status}
                  </span>
                  {job.error && (
                    <span className="mt-1 block max-w-[240px] truncate text-[11px] text-red-600" title={job.error}>
                      {job.error}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted">
                  No jobs yet — the lifecycle runner will populate this history.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
