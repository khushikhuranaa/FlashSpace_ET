import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Archive, ArchiveDetail, ArchiveFile, ArchiveFileListing, ArchiveVerification, SpaceDetail } from '../types';
import { StatCard } from '../components/StatCard';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { triggerDownload } from '../lib/download';
import { StatusBadge } from '../components/ui';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CREATING', label: 'Creating' },
];

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'size-asc', label: 'Smallest first' },
  { value: 'size-desc', label: 'Largest first' },
];

export default function Vault({ navigate }: { navigate: (to: string) => void }) {
  const toast = useToast().toast;
  const [archives, setArchives] = useState<Archive[]>([]);
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState('newest');
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [files, setFiles] = useState<ArchiveFile[]>([]);
  const [manifestVerified, setManifestVerified] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ArchiveVerification | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vault, spaceList] = await Promise.all([api.vault({ q, status: statusFilter || undefined, sort, limit, offset }), api.listSpaces()]);
      setArchives(vault.archives);
      setTotal(vault.total);
      setSpaces(spaceList.spaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Vault');
    } finally {
      setLoading(false);
    }
  }, [q, statusFilter, sort, limit, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const spaceIndex = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);
  const spaceName = useMemo(
    () => (archive: Archive) => spaceIndex.get(archive.spaceId)?.name ?? 'Removed Space',
    [spaceIndex],
  );

  const verified = archives.filter((a) => a.status === 'VERIFIED');
  const coldBytes = verified.reduce((sum, a) => sum + a.sizeBytes, 0);
  const failed = archives.filter((a) => a.status === 'FAILED');
  const thisMonth = archives.filter((a) => {
    const d = new Date(a.createdAt);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const download = async (archive: Archive) => {
    setDownloading(archive.id);
    try {
      const { url } = await api.downloadArchive(archive.id);
      triggerDownload(url, `${spaceName(archive)}.zip`);
      toast('Download started', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const downloadManifest = async (archive: Archive) => {
    setDownloading(archive.id);
    try {
      const { url } = await api.downloadManifest(archive.id);
      triggerDownload(url, `${spaceName(archive)}-manifest.json`);
      toast('Manifest downloaded', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Manifest download failed', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const fetchDetail = async (archiveId: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      const d = await api.getArchive(archiveId);
      setDetail(d);
      setVerifyResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load archive details');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const fetchFiles = async (archiveId: string) => {
    setFilesLoading(true);
    try {
      const listing = await api.getArchiveFiles(archiveId);
      setFiles(listing.files);
      setManifestVerified(listing.manifestVerified);
    } catch (e) {
      setFiles([]);
      setManifestVerified(false);
      toast(e instanceof Error ? e.message : 'Could not load file listing', 'error');
    } finally {
      setFilesLoading(false);
    }
  };

  const verify = async (archiveId: string) => {
    setVerifyLoading(true);
    try {
      const result = await api.verifyArchive(archiveId);
      setVerifyResult(result);
      if (result.verified) toast('Archive verified successfully', 'success');
      else toast('Archive verification failed — see checks below', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Verification failed', 'error');
    } finally {
      setVerifyLoading(false);
    }
  };

  const exportCsv = async () => {
    if (archives.length === 0) {
      toast('There are no archives to export', 'info');
      return;
    }
    setExporting(true);
    try {
      const blob = await api.exportCsv({ q, status: statusFilter || undefined, sort });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, 'flashspace-vault-export.csv');
      URL.revokeObjectURL(url);
      toast('Vault exported as CSV', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'CSV export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const hasMore = offset + limit < total;
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: archives.length };
    for (const a of archives) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return counts;
  }, [archives]);

  if (loading && archives.length === 0) {
    return <div className="text-slate-500">Loading Vault…</div>;
  }

  if (error && archives.length === 0 && !detail) {
    return (
      <div className="card">
        <p className="text-red-600">{error}</p>
        <button className="btn-secondary mt-3" onClick={() => void load()}>
          Retry
        </button>
        <button className="btn-secondary mt-3 ml-2" onClick={() => navigate('/my-spaces')}>
          My Spaces
        </button>
        <button className="btn-secondary mt-3" onClick={() => navigate('/dashboard')}>
          Dashboard
        </button>
      </div>
    );
  }

  // Detail view mode
  if (detail && archives.length > 0 && offset === 0) {
    return (
      <div className="space-y-6">
        <button
          className="flex items-center gap-1.5 text-sm font-medium text-flash-700 hover:text-flash-800 transition-colors"
          onClick={() => setDetail(null)}
        >
          <Icon name="arrow-left" className="h-4 w-4" />
          Back to Vault
        </button>

        {detailLoading ? (
          <div className="text-slate-500">Loading archive details…</div>
        ) : detail && (
          <>
            <section className="card">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="font-display text-xl font-bold tracking-tight text-primary">{detail.spaceName ?? 'Removed Space'}</h1>
                  <p className="mt-0.5 text-sm text-muted">
                    Source Space {detail.spaceStatus ? `· ${detail.spaceStatus}` : '· No longer available'}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2 text-right">
                  <span className="text-2xl font-extrabold">{fmtBytes(detail.archive.sizeBytes)}</span>
                  <span className="text-xs text-muted">compressed ZIP</span>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted">Archive ID</dt>
                  <dd className="font-mono text-[11px] break-all">{detail.archive.id}</dd>
                </div>
                <div>
                  <dt className="text-muted">Created</dt>
                  <dd>{fmtDateTime(detail.archive.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Files</dt>
                  <dd>{detail.archive.fileCount} file{detail.archive.fileCount === 1 ? '' : 's'}</dd>
                </div>
                <div>
                  <dt className="text-muted">Status</dt>
                  <dd>
                    <StatusBadge status={detail.archive.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Verified at</dt>
                  <dd>{detail.archive.verifiedAt ? fmtDateTime(detail.archive.verifiedAt) : 'Not verified'}</dd>
                </div>
                <div>
                  <dt className="text-muted">Checksum</dt>
                  <dd className="font-mono text-[11px] break-all">
                    {detail.archive.checksum ? `sha256 ${detail.archive.checksum.slice(0, 16)}…` : 'Not recorded'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Owner</dt>
                  <dd>{detail.ownerName ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt className="text-muted">Storage</dt>
                  <dd>{detail.archive.objectKey ? 'Present in storage' : 'Missing from storage'}</dd>
                </div>
              </dl>
            </section>

            <section className="card">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">File listing</h2>
                <div className="flex gap-2">
                  <button
                    className="btn-secondary text-[12px] px-3 py-1.5"
                    onClick={() => void download(detail.archive)}
                    disabled={detail.archive.status !== 'VERIFIED'}
                    title={detail.archive.status !== 'VERIFIED' ? 'Only verified archives can be downloaded' : 'Download ZIP'}
                  >
                    <Icon name="download" className="h-4 w-4" />
                    Download ZIP
                  </button>
                  <button
                    className="btn-secondary text-[12px] px-3 py-1.5"
                    onClick={() => void downloadManifest(detail.archive)}
                  >
                    <Icon name="file" className="h-4 w-4" />
                    Download manifest
                  </button>
                  {detail.archive.status === 'VERIFIED' && (
                    <button
                      className="btn-secondary text-[12px] px-3 py-1.5"
                      onClick={() => void verify(detail.archive.id)}
                      disabled={verifyLoading}
                    >
                      <Icon name="shield" className="h-4 w-4" />
                      {verifyLoading ? 'Verifying…' : 'Re-verify'}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted">
                Files listed from the stored manifest. The manifest is the authoritative index of archive contents.
              </p>
              {verifyResult && (
                <div className="mt-4 card p-4 bg-slate-50">
                  <h3 className="text-sm font-semibold mb-2">
                    <span role="status" className="inline-flex items-center gap-1.5">
                      <Icon
                        name={verifyResult.verified ? 'check-circle' : 'alert-circle'}
                        size={14}
                        className={verifyResult.verified ? 'text-success-600' : 'text-danger-600'}
                      />
                      {verifyResult.verified ? 'Verification passed' : 'Verification failed'}
                    </span>
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {verifyResult.checks.map((c) => (
                      <li key={c.name} className={c.passed ? 'text-slate-600' : 'text-red-600'}>
                        <span className="font-medium mr-1">{c.name}:</span>
                        {c.passed ? 'passed' : (c.message ?? 'failed')}
                        {c.details ? ` —${c.details}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-3 rounded-lg border border-line divide-y divide-line/70 overflow-hidden">
                {filesLoading ? (
                  <div className="px-4 py-3 text-sm text-muted">Loading file listing…</div>
                ) : files.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-muted">
                    {manifestVerified ? 'No files listed in manifest' : 'Manifest not available or unreadable'}
                  </div>
                ) : (
                  files.map((f) => (
                    <div key={f.fileId} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="font-medium truncate">{f.path || f.name}</span>
                          {f.folderPath && f.folderPath !== f.path && (
                            <span className="ml-2 text-muted text-[11px]">{f.folderPath}</span>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <span className="text-muted">{fmtBytes(f.sizeBytes)}</span>
                          <span className="ml-2 text-[11px] text-muted">{f.mimeType}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Download manifest</h2>
              <p className="mt-1 text-sm text-slate-600">
                The manifest is a JSON index of every file in this archive, including paths, sizes, MIME types,
                and upload timestamps. Download it to inspect archive contents without downloading the full ZIP.
              </p>
              <button
                className="btn-secondary mt-3"
                onClick={() => void downloadManifest(detail.archive)}
              >
                <Icon name="file" className="h-4 w-4" />
                Download manifest JSON
              </button>
            </section>

            <section className="card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Re-verify archive</h2>
              <p className="mt-1 text-sm text-slate-600">
                Re-running verification checks the stored ZIP object exists, its size matches the recorded metadata,
                the SHA-256 checksum matches, and the manifest is present and consistent with the file count.
              </p>
              <button
                className="btn-secondary mt-3"
                onClick={() => void verify(detail.archive.id)}
                disabled={verifyLoading}
              >
                <Icon name="shield" className="h-4 w-4" />
                {verifyLoading ? 'Verifying…' : 'Run verification'}
              </button>
              {verifyResult && (
                <div className="mt-4 card p-4 bg-slate-50">
                  <h3 className="text-sm font-semibold mb-2">
                    <span role="status" className="inline-flex items-center gap-1.5">
                      <Icon
                        name={verifyResult.verified ? 'check-circle' : 'alert-circle'}
                        size={14}
                        className={verifyResult.verified ? 'text-success-600' : 'text-danger-600'}
                      />
                      {verifyResult.verified ? 'Verification passed' : 'Verification failed'}
                    </span>
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {verifyResult.checks.map((c) => (
                      <li key={c.name} className={c.passed ? 'text-slate-600' : 'text-red-600'}>
                        <span className="font-medium mr-1">{c.name}:</span>
                        {c.passed ? 'passed' : (c.message ?? 'failed')}
                        {c.details ? ` —${c.details}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">
            Vault Archives
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Verified ZIP snapshots stored when a Space expires or is archived. Only you (or an admin) can access these.
          </p>
        </div>
        <button
          className="btn-primary self-start px-3.5 py-2"
          onClick={() => void exportCsv()}
          disabled={exporting || archives.length === 0}
        >
          <Icon name="download" className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Total archived" value={archives.length} hint={`${verified.length} verified · ${failed.length} failed`} icon="archive" />
        <StatCard label="Cold storage" value={fmtBytes(coldBytes)} hint="Verified archive bytes" icon="hard-drive" />
        <StatCard label="Failed archives" value={failed.length} hint="Requires attention or admin retry" icon="alert" />
        <StatCard label="Archived this month" value={thisMonth} hint="Since the 1st" icon="calendar" />
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            placeholder="Search Space name…"
            className="input flex-1 min-w-[160px]"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
          />
          <select
            className="input w-auto min-w-[130px]"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="input w-auto min-w-[140px]"
            value={sort}
            onChange={(e) => { setSort(e.target.value); setOffset(0); }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="text-xs text-muted ml-auto">
            {total} archive{total === 1 ? '' : 's'} · showing {Math.min(limit, total - offset)} · {hasMore ? 'load more below' : 'all loaded'}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          {!hasMore && archives.length > 0 && (
            <button
              className="btn-secondary text-[12px] px-3 py-1.5"
              onClick={() => setOffset(0)}
            >
              Reset filters
            </button>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
        {archives.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Icon name="archive" className="h-10 w-10 mx-auto text-slate-300" />
            <p className="mt-3 text-[14px] font-medium text-primary">Your Vault is empty</p>
            <p className="mt-1 text-[12px] text-muted">
              When a Space expires or is archived, its verified ZIP lands here.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              <button onClick={() => navigate('/my-spaces')} className="btn-secondary">
                My Spaces
              </button>
              <button onClick={() => navigate('/dashboard')} className="btn-secondary">
                Dashboard
              </button>
            </div>
          </div>
        ) : (
          <>
          <div className="hidden overflow-x-auto min-[1400px]:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Archive</th>
                  <th className="px-5 py-3 font-medium">Source Space</th>
                  <th className="px-5 py-3 font-medium">Archived</th>
                  <th className="px-5 py-3 font-medium">Files &amp; size</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Checksum</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {archives.map((archive) => {
                  const verifiedArchive = archive.status === 'VERIFIED';
                  const name = `${spaceName(archive)}.zip`;
                  const source = spaceIndex.get(archive.spaceId);
                  return (
                    <tr key={archive.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <Icon name="archive" className="h-4 w-4 flex-shrink-0 text-flash-600" />
                          <span className="min-w-0">
                            <span className="block max-w-[220px] truncate font-medium text-primary">{name}</span>
                            <span className="block font-mono text-[11px] text-muted">{archive.spaceId.slice(0, 8)}…</span>
                          </span>
                        </span>
                      </td>
                      <td className="max-w-[220px] px-5 py-3 text-muted">
                        <button
                          onClick={() => navigate(`/spaces/${archive.spaceId}`)}
                          className="block max-w-full truncate text-left hover:text-flash-700 hover:underline"
                          title={source?.name ?? 'Removed Space'}
                        >
                          {source?.purpose ?? spaceName(archive)}
                        </button>
                      </td>
                      <td className="px-5 py-3 text-muted">{fmtDate(archive.createdAt)}</td>
                      <td className="px-5 py-3">
                        <span className="block font-medium text-primary">{archive.fileCount} file{archive.fileCount === 1 ? '' : 's'}</span>
                        <span className="block text-[11px] text-muted">{fmtBytes(archive.sizeBytes)}</span>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={archive.status} />
                        {archive.verifiedAt && (
                          <span className="mt-1 block text-[11px] text-muted">{fmtDateTime(archive.verifiedAt)}</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-mono text-[11px] text-muted break-all">
                          {archive.checksum ? `sha256 ${archive.checksum.slice(0, 12)}…` : 'pending'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            className="btn-secondary px-3 py-1.5 text-[12px]"
                            onClick={() => void fetchDetail(archive.id)}
                            title="View details and file listing"
                          >
                            <Icon name="file" className="h-3.5 w-3.5" />
                            Details
                          </button>
                          <button
                            className="btn-secondary px-3 py-1.5 text-[12px]"
                            onClick={() => void downloadManifest(archive)}
                            title="Download manifest JSON"
                          >
                            <Icon name="file" className="h-3.5 w-3.5" />
                            Manifest
                          </button>
                          <button
                            className="btn-secondary px-3 py-1.5 text-[12px]"
                            onClick={() => void download(archive)}
                            disabled={!verifiedArchive || downloading === archive.id}
                            title={verifiedArchive ? 'Download ZIP' : 'Only verified archives can be downloaded'}
                          >
                            <Icon name="download" className="h-3.5 w-3.5" />
                            {downloading === archive.id ? 'Starting…' : 'Download'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  className="btn-secondary"
                  onClick={() => setOffset((o) => o + limit)}
                >
                  Load more ({Math.min(limit, total - offset - limit)} remaining)
                </button>
              </div>
            )}
          </div>

          {/* Mobile: archive metadata and actions as readable cards. */}
          <div className="divide-y divide-line/70 min-[1400px]:hidden">
            {archives.map((archive) => {
              const verifiedArchive = archive.status === 'VERIFIED';
              const name = `${spaceName(archive)}.zip`;
              const source = spaceIndex.get(archive.spaceId);
              return (
                <div key={archive.id} className="space-y-3 px-4 py-4">
                  <div className="flex items-start gap-2">
                    <Icon name="archive" className="mt-0.5 h-4 w-4 flex-shrink-0 text-flash-600" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-primary">{name}</p>
                      <p className="font-mono text-[11px] text-muted">{archive.spaceId.slice(0, 8)}…</p>
                    </div>
                    <StatusBadge status={archive.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-muted">
                    <div>
                      <dt className="uppercase tracking-wide">Source</dt>
                      <dd className="truncate text-secondary" title={source?.name ?? 'Removed Space'}>
                        {source?.purpose ?? spaceName(archive)}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide">Archived</dt>
                      <dd className="text-secondary">{fmtDate(archive.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide">Files &amp; size</dt>
                      <dd className="text-secondary">
                        {archive.fileCount} file{archive.fileCount === 1 ? '' : 's'} · {fmtBytes(archive.sizeBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide">Checksum</dt>
                      <dd className="truncate font-mono text-secondary">
                        {archive.checksum ? `sha256 ${archive.checksum.slice(0, 12)}…` : 'pending'}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary px-3 py-1.5 text-[12px]"
                      onClick={() => void fetchDetail(archive.id)}
                      title="View details and file listing"
                    >
                      <Icon name="file" className="h-3.5 w-3.5" />
                      Details
                    </button>
                    <button
                      className="btn-secondary px-3 py-1.5 text-[12px]"
                      onClick={() => void downloadManifest(archive)}
                      title="Download manifest JSON"
                    >
                      <Icon name="file" className="h-3.5 w-3.5" />
                      Manifest
                    </button>
                    <button
                      className="btn-secondary px-3 py-1.5 text-[12px]"
                      onClick={() => void download(archive)}
                      disabled={!verifiedArchive || downloading === archive.id}
                      title={verifiedArchive ? 'Download ZIP' : 'Only verified archives can be downloaded'}
                    >
                      <Icon name="download" className="h-3.5 w-3.5" />
                      {downloading === archive.id ? 'Starting…' : 'Download'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </section>

      {failed.length > 0 && (
        <section className="card border-red-200">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700 mb-3">Failed or unavailable archives</h2>
          <p className="text-sm text-red-600 mb-3">
            {failed.length} archive{failed.length === 1 ? '' : 's'} could not be verified. These cannot be downloaded.
            An administrator can retry failed archives from the admin console.
          </p>
          <div className="space-y-2">
            {failed.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-red-50">
                <div className="min-w-0">
                  <span className="font-medium truncate">{spaceName(a)}</span>
                  <span className="ml-2 text-[11px] text-muted">{a.id.slice(0, 8)}…</span>
                </div>
                <div className="shrink-0 text-right text-sm text-red-700">{fmtDate(a.createdAt)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card border-slate-100">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">About your Vault</h2>
        <ul className="text-sm text-slate-600 space-y-1 list-disc list-inside">
          <li>Archives belong to the Space owner and survive Space cleanup and deletion.</li>
          <li>Only verified archives can be downloaded or re-verified.</li>
          <li>The manifest is the authoritative file index for each archive.</li>
          <li>Failed archives cannot be downloaded until an administrator retries them.</li>
          <li>CSV exports include only archives you are authorized to access.</li>
        </ul>
      </section>
    </div>
  );
}
