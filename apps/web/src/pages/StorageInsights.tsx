import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  ArchivePlan,
  AuthUser,
  DuplicateGroup,
  FileRecord,
  NearDuplicateGroup,
  SpaceDetail,
  StorageInsights as Insights,
} from '../types';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  RUNNING: 'bg-blue-100 text-blue-700',
  VERIFIED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
};

function Icon({ path, className = 'h-4 w-4' }: { path: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  back: 'M19 12H5',
  scan: 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  copy: 'M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  check: 'M20 6 9 17l-5-5',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  x: 'M18 6 6 18M6 6l12 12',
};

export default function StorageInsights({
  id,
  user,
  goBack,
}: {
  id: string;
  user: AuthUser;
  goBack: () => void;
}) {
  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [plan, setPlan] = useState<ArchivePlan | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isOwner = space?.role === 'OWNER';

  const load = useCallback(async () => {
    try {
      setError(null);
      const [spaceRes, insightsRes, filesRes, plansRes] = await Promise.all([
        api.getSpace(id),
        api.insights(id),
        api.listFiles(id),
        api.listPlans(id),
      ]);
      setSpace(spaceRes.space);
      setInsights(insightsRes.insights);
      setFiles(filesRes.files);
      const active = plansRes.plans.find(
        (p) => p.status === 'PENDING' || p.status === 'CONFIRMED' || p.status === 'ARCHIVING',
      );
      setPlan(active ?? plansRes.plans[0] ?? null);
      if (active) {
        setExcluded(new Set(active.excludedFileIds));
        setAcknowledged(active.explained);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load storage insights');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.runScan(id);
      setInsights(res.insights);
      setNotice('Scan complete. Results below come from the files actually stored in this Space.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const toggleExclude = async (fileId: string) => {
    setNotice(null);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
    try {
      await api.toggleDuplicateExclusion(id, fileId);
    } catch {
      // The plan is authoritative; a failed view-level toggle is non-fatal.
    }
  };

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const buildPlan = async () => {
    setError(null);
    setNotice(null);
    if (!acknowledged) {
      setError('Confirm that you understand what exclusion means before continuing.');
      return;
    }
    try {
      const excludedFileIds = Array.from(excluded);
      const res = await api.createPlan(id, {
        scanId: insights?.scan.id || undefined,
        excludedFileIds,
        explained: true,
      });
      setPlan(res.plan);
      setNotice(
        `Plan ready: ${res.plan.willArchiveFileCount} file(s) will be archived, ${res.plan.willExcludeFileCount} excluded.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the archive plan');
    }
  };

  const confirmPlan = async () => {
    if (!plan) return;
    setConfirming(true);
    setError(null);
    setNotice(null);
    try {
      const review = await api.confirmPlan(plan.id);
      setPlan(review.plan);
      if (review.plan.status === 'VERIFIED') {
        setNotice('Archive created and verified. It is now available in your Vault.');
        await load();
      } else if (review.plan.status === 'FAILED') {
        setError(review.plan.errorMessage ?? 'Archive failed. The Space and its files are preserved.');
      } else {
        setNotice(`Archive status: ${review.plan.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Archive failed. The Space and its files are preserved.');
      await load();
    } finally {
      setConfirming(false);
    }
  };

  const cancelPlan = async () => {
    if (!plan) return;
    try {
      const res = await api.cancelPlan(plan.id);
      setPlan(res.plan);
      setNotice('Plan cancelled. Nothing was archived or deleted.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the plan');
    }
  };

  const daysLeft = space ? Math.max(0, Math.ceil((new Date(space.expiryAt).getTime() - Date.now()) / 86400000)) : 0;
  const selectedFiles = useMemo(() => files.filter((f) => !excluded.has(f.id)), [files, excluded]);
  const excludedFiles = useMemo(() => files.filter((f) => excluded.has(f.id)), [files, excluded]);

  if (loading) {
    return <div className="text-slate-500">Loading storage insights…</div>;
  }

  if (error && !space) {
    return (
      <div className="card">
        <p className="text-red-600">{error}</p>
        <button className="btn-secondary mt-3" onClick={goBack}>
          Back
        </button>
      </div>
    );
  }

  const scanStatus = insights?.scan.status ?? 'PENDING';

  return (
    <div>
      <button
        className="mb-4 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        onClick={goBack}
      >
        <Icon path={ICONS.back} />
        Back
      </button>

      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">{space?.name ?? 'Space'}</h1>
              <span className={`badge ${STATUS_STYLES[scanStatus] ?? 'bg-slate-100 text-slate-600'}`}>
                scan: {scanStatus}
              </span>
              {space && <span className="badge bg-slate-100 text-slate-600">{space.status}</span>}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              Review what this Space stores before it expires. The default archive always contains every file.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Last scan: {fmtDateTime(insights?.scan.scannedAt ?? null)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="text-right">
              <div className={`text-2xl font-extrabold ${daysLeft <= 2 ? 'text-amber-600' : 'text-slate-800'}`}>
                {daysLeft}
              </div>
              <div className="text-xs uppercase tracking-wide text-slate-400">days to expiry</div>
              <div className="mt-1 text-xs text-slate-500">{fmtDateTime(space?.expiryAt ?? null)}</div>
            </div>
            {isOwner && (
              <button className="btn-primary flex items-center gap-1.5" onClick={() => void runScan()} disabled={scanning}>
                <Icon path={ICONS.scan} />
                {scanning ? 'Scanning…' : 'Run storage scan'}
              </button>
            )}
          </div>
        </div>
      </div>

      {notice && <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {insights && (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Files scanned" value={String(insights.totalFiles)} />
            <Stat label="Storage used" value={fmtBytes(insights.totalBytes)} />
            <Stat label="Exact duplicate groups" value={String(insights.duplicateGroupCount)} />
            <Stat label="Files in duplicate groups" value={String(insights.duplicateFileCount)} />
            <Stat label="Extra copies" value={String(insights.extraCopyCount)} />
            <Stat
              label="Potential savings"
              value={fmtBytes(insights.potentialSavingsBytes)}
              hint="Only if extra copies are removed. Nothing has been deleted."
            />
          </div>

          {insights.scan.status === 'FAILED' && (
            <div className="card mt-4 border-red-200">
              <div className="flex items-center gap-2 font-semibold text-red-700">
                <Icon path={ICONS.alert} />
                Scan failed
              </div>
              <p className="mt-1 text-sm text-red-600">
                {insights.scan.errorMessage ?? 'The files could not be read.'} No duplicate results are shown for a
                failed scan.
              </p>
            </div>
          )}

          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Exact duplicates</h2>
            {insights.exactDuplicates.length === 0 ? (
              <div className="card mt-2 text-sm text-slate-500">
                No exact duplicates found. Files are compared by content hash (SHA-256), not by name.
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                {insights.exactDuplicates.map((group) => (
                  <DuplicateGroupCard
                    key={group.id}
                    group={group}
                    open={openGroups.has(group.id)}
                    onToggle={() => toggleGroup(group.id)}
                    excluded={excluded}
                    onToggleExclude={toggleExclude}
                    canEdit={isOwner}
                  />
                ))}
              </div>
            )}
          </section>

          {insights.nearDuplicates.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Possible versions</h2>
              <p className="mt-1 text-xs text-slate-500">
                Similar names with different content. These are not exact duplicates and are never removed
                automatically.
              </p>
              <div className="card mt-2 divide-y divide-slate-100 p-0">
                {insights.nearDuplicates.map((group) => (
                  <NearGroup key={group.id} group={group} />
                ))}
              </div>
            </section>
          )}

          {insights.largeFiles.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Large files</h2>
              <p className="mt-1 text-xs text-slate-500">
                At or above {fmtBytes(insights.largeFileThresholdBytes)}. Large files are always kept in the archive.
              </p>
              <div className="card mt-2 divide-y divide-slate-100 p-0">
                {insights.largeFiles.map((f) => (
                  <div key={f.fileId} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon path={ICONS.file} className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate text-sm font-medium">{f.path || f.name}</span>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">{fmtBytes(f.sizeBytes)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {insights.unscannedFiles.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Files that could not be scanned</h2>
              <div className="card mt-2 divide-y divide-slate-100 p-0">
                {insights.unscannedFiles.map((f, i) => (
                  <div key={`${f.fileId}-${i}`} className="px-5 py-3">
                    <p className="text-sm font-medium">{f.path || f.name || 'Unknown file'}</p>
                    <p className="text-xs text-red-600">{f.error}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {isOwner && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Archive plan</h2>
              <div className="card mt-2 space-y-3">
                <div className="rounded-lg bg-slate-50 p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Will archive</span>
                    <span className="font-medium">{selectedFiles.length} file(s)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Will exclude</span>
                    <span className="font-medium">{excludedFiles.length} file(s)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Size to archive</span>
                    <span className="font-medium">{fmtBytes(selectedFiles.reduce((s, f) => s + f.sizeBytes, 0))}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    With no exclusions the archive contains every file, including duplicates. Excluding a file only
                    keeps it out of the ZIP — it does not delete the file.
                  </p>
                </div>

                {excludedFiles.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Excluded files</p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {excludedFiles.map((f) => (
                        <li key={f.id} className="flex items-center justify-between rounded bg-amber-50 px-3 py-1.5">
                          <span className="truncate">{f.name}</span>
                          <button
                            className="ml-3 shrink-0 text-xs text-flash-700 hover:underline"
                            onClick={() => void toggleExclude(f.id)}
                          >
                            Undo
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  <span>
                    I understand that excluded files stay in storage but will not be part of the archive, and that
                    archiving with no exclusions keeps everything.
                  </span>
                </label>

                <div className="flex flex-wrap gap-2">
                  {(!plan || plan.status === 'CANCELLED' || plan.status === 'FAILED') && (
                    <button className="btn-secondary" onClick={() => void buildPlan()}>
                      Prepare archive
                    </button>
                  )}
                  {plan && (plan.status === 'PENDING' || plan.status === 'CONFIRMED') && (
                    <>
                      <button
                        className="btn-primary flex items-center gap-1.5"
                        onClick={() => void confirmPlan()}
                        disabled={confirming}
                      >
                        <Icon path={ICONS.archive} />
                        {confirming ? 'Archiving…' : 'Confirm and archive'}
                      </button>
                      <button className="btn-danger flex items-center gap-1.5" onClick={() => void cancelPlan()}>
                        <Icon path={ICONS.x} />
                        Cancel plan
                      </button>
                    </>
                  )}
                  {plan && plan.status === 'VERIFIED' && (
                    <p className="flex items-center gap-1.5 text-sm text-emerald-700">
                      <Icon path={ICONS.check} />
                      Archived and verified — available in your Vault.
                    </p>
                  )}
                  {plan && plan.status === 'FAILED' && (
                    <p className="flex items-center gap-1.5 text-sm text-red-700">
                      <Icon path={ICONS.alert} />
                      {plan.errorMessage ?? 'Archiving failed. Your files are preserved.'}
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-800">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function DuplicateGroupCard({
  group,
  open,
  onToggle,
  excluded,
  onToggleExclude,
  canEdit,
}: {
  group: DuplicateGroup;
  open: boolean;
  onToggle: () => void;
  excluded: Set<string>;
  onToggleExclude: (fileId: string) => void | Promise<void>;
  canEdit: boolean;
}) {
  return (
    <div className="card p-0">
      <button className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left" onClick={onToggle}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {group.fileCount} identical copies of {group.representativeName}
          </p>
          <p className="text-xs text-slate-500">
            {group.extraCopyCount} extra cop{group.extraCopyCount === 1 ? 'y' : 'ies'} ·{' '}
            {fmtBytes(group.potentialSavingsBytes)} potential savings · hash {group.contentHash.slice(0, 12)}…
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-400">{open ? 'Hide' : 'Review'}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100">
          {group.files.map((f) => {
            const isExcluded = excluded.has(f.fileId);
            return (
              <div key={f.fileId} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon path={ICONS.copy} className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{f.path || f.name}</p>
                    {f.path !== f.name && <p className="truncate text-xs text-slate-500">{f.name}</p>}
                    <p className="text-xs text-slate-400">
                      {fmtBytes(f.sizeBytes)} · uploaded {new Date(f.uploadedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {canEdit && (
                  <button
                    className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      isExcluded
                        ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                    onClick={() => void onToggleExclude(f.fileId)}
                  >
                    {isExcluded ? 'Excluded from archive' : 'Exclude from archive'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NearGroup({ group }: { group: NearDuplicateGroup }) {
  return (
    <div className="px-5 py-3">
      <p className="text-sm font-medium">
        {group.fileCount} possible versions of {group.baseName}
      </p>
      <ul className="mt-1 space-y-1">
        {group.files.map((f) => (
          <li key={f.fileId} className="flex items-center justify-between text-xs text-slate-500">
            <span className="truncate">{f.path || f.name}</span>
            <span className="ml-3 shrink-0">{fmtBytes(f.sizeBytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
