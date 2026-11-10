import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Archive, SpaceDetail } from '../types';
import { StatCard } from '../components/StatCard';
import { useToast } from '../components/ToastProvider';
import { Icon } from '../components/Icon';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { triggerDownload } from '../lib/download';

export default function Vault({ navigate }: { navigate: (to: string) => void }) {
  const toast = useToast().toast;
  const [archives, setArchives] = useState<Archive[]>([]);
  const [spaces, setSpaces] = useState<SpaceDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [vault, spaceList] = await Promise.all([api.vault(), api.listSpaces()]);
    setArchives(vault.archives);
    setSpaces(spaceList.spaces);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load the Vault'));
  }, [load]);

  const spaceIndex = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);
  const spaceName = useMemo(
    () => (archive: Archive) => spaceIndex.get(archive.spaceId)?.name ?? 'Removed Space',
    [spaceIndex],
  );

  const verified = archives.filter((a) => a.status === 'VERIFIED');
  const coldBytes = verified.reduce((sum, a) => sum + a.sizeBytes, 0);
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
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const exportIndex = () => {
    if (archives.length === 0) {
      toast('There are no archives to export', 'info');
      return;
    }
    const rows = [
      ['Archive', 'Source Space', 'Status', 'Files', 'Size (bytes)', 'Created', 'Verified'],
      ...archives.map((a) => [
        `${spaceName(a)}.zip`,
        spaceName(a),
        a.status,
        String(a.fileCount),
        String(a.sizeBytes),
        a.createdAt,
        a.verifiedAt ?? '',
      ]),
    ];
    const csv = rows
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'flashspace-vault-index.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Vault index exported', 'success');
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">
            Vault Archives
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Verified ZIP snapshots stored when a Space expires or is deleted.
          </p>
        </div>
        <button onClick={exportIndex} className="btn-primary self-start px-3.5 py-2">
          <Icon name="download" size={16} />
          Export index (CSV)
        </button>
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total archived" value={archives.length} hint={`${verified.length} verified ZIP${verified.length === 1 ? '' : 's'}`} icon="archive" />
        <StatCard label="Cold storage" value={fmtBytes(coldBytes)} hint="Verified archive bytes" icon="hard-drive" />
        <StatCard label="Archived this month" value={thisMonth} hint="Since the 1st" icon="calendar" />
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
        {archives.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Icon name="archive" size={40} className="mx-auto text-slate-300" />
            <p className="mt-3 text-[14px] font-medium text-primary">Your Vault is empty</p>
            <p className="mt-1 text-[12px] text-muted">
              When a Space expires or is archived, its verified ZIP lands here.
            </p>
            <button onClick={() => navigate('/dashboard')} className="btn-secondary mt-4">
              Back to dashboard
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-slate-50 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Archive</th>
                  <th className="px-5 py-3 font-medium">Source Space</th>
                  <th className="px-5 py-3 font-medium">Archived</th>
                  <th className="px-5 py-3 font-medium">Files &amp; size</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
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
                          <Icon name="archive" size={16} className="flex-shrink-0 text-flash-600" />
                          <span className="min-w-0">
                            <span className="block max-w-[220px] truncate font-medium text-primary">
                              {name}
                            </span>
                            <span className="block font-mono text-[11px] text-muted">
                              {archive.checksum ? `sha256 ${archive.checksum.slice(0, 12)}…` : 'checksum pending'}
                            </span>
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
                        <span className="block font-medium text-primary">
                          {archive.fileCount} file{archive.fileCount === 1 ? '' : 's'}
                        </span>
                        <span className="block text-[11px] text-muted">{fmtBytes(archive.sizeBytes)}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`badge ${
                            verifiedArchive
                              ? 'bg-emerald-50 text-emerald-700'
                              : archive.status === 'FAILED'
                                ? 'bg-red-50 text-red-700'
                                : 'bg-blue-50 text-blue-700'
                          }`}
                        >
                          {archive.status}
                        </span>
                        {archive.verifiedAt && (
                          <span className="mt-1 block text-[11px] text-muted">
                            {fmtDateTime(archive.verifiedAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => void download(archive)}
                          disabled={!verifiedArchive || downloading === archive.id}
                          className="btn-secondary px-3 py-1.5 text-[12px]"
                          title={verifiedArchive ? 'Download ZIP' : 'Only verified archives can be downloaded'}
                        >
                          <Icon name="download" size={14} />
                          {downloading === archive.id ? 'Starting…' : 'Download'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
