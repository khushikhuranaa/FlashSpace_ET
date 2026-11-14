import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  FileDetails,
  FileListItem,
  FileListResult,
  FilePreview,
  FileSort,
  FileTypeFilter,
  Folder,
  FolderStats,
} from '../types';
import type { UploadConfig } from '../api';
import { Icon } from '../components/Icon';
import { PromptDialog } from '../components/PromptDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { triggerDownload } from '../lib/download';

/**
 * Module 4 — file & folder manager.
 *
 * All authorization and classification is decided by the API: this component
 * only knows how to present the result and which controls the current role may
 * see. Uploads stream through the existing signed-URL protocol with real
 * progress, cancel and retry; previews use short-lived inline URLs.
 */

interface Props {
  spaceId: string;
  canEdit: boolean;
  readOnly: boolean;
  onChanged: () => void;
  onOpenVault: () => void;
}

interface UploadRow {
  id: string;
  file: File;
  folderId: string | null;
  progress: number;
  status: 'queued' | 'uploading' | 'confirming' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  fileId: string | null;
}

type Modal =
  | { kind: 'new-folder'; parentId: string | null }
  | { kind: 'rename-folder'; folder: Folder }
  | { kind: 'move-folder'; folder: Folder }
  | { kind: 'delete-folder'; folder: Folder }
  | { kind: 'rename-file'; file: FileListItem }
  | { kind: 'move-files'; ids: string[]; label: string }
  | { kind: 'delete-files'; ids: string[]; label: string }
  | null;

const SORTS: { value: FileSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
  { value: 'size-desc', label: 'Largest first' },
  { value: 'size-asc', label: 'Smallest first' },
];

const FILTERS: { value: FileTypeFilter; label: string; icon: string }[] = [
  { value: 'all', label: 'All', icon: 'layers' },
  { value: 'image', label: 'Images', icon: 'image' },
  { value: 'pdf', label: 'PDFs', icon: 'file' },
  { value: 'document', label: 'Documents', icon: 'file' },
  { value: 'text', label: 'Text', icon: 'file' },
  { value: 'other', label: 'Other', icon: 'file' },
];

function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError('STORAGE_ERROR', `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('STORAGE_ERROR', 'Upload failed — check your connection', 0));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(file);
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Cap concurrent uploads so a large drop does not saturate the connection.
const MAX_CONCURRENT_UPLOADS = 3;

/** Default fallback if the config endpoint is unreachable. Matches the backend
 *  default of 50 MB; the backend remains authoritative regardless. */
const FALLBACK_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function SpaceFiles({ spaceId, canEdit, readOnly, onChanged, onOpenVault }: Props) {
  const toast = useToast().toast;
  const [folderId, setFolderId] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [type, setType] = useState<FileTypeFilter>('all');
  const [sort, setSort] = useState<FileSort>('newest');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [data, setData] = useState<FileListResult | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [stats, setStats] = useState<FolderStats | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploads, _setUploads] = useState<Array<UploadRow>>([]);
  const uploadsRef = useRef<UploadRow[]>([]);
  const activeUploadsRef = useRef(0);
  const setUploads = (updater: (current: UploadRow[]) => UploadRow[]) => {
    _setUploads((current) => {
      const next = updater(current);
      uploadsRef.current = next;
      return next;
    });
  };
  const [dragOver, setDragOver] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ meta: FilePreview; text?: string } | null>(null);
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Fetched upload configuration; falls back to the hardcoded default so the UI
  // still works even when the config endpoint is unreachable.
  const [fetchedConfig, setFetchedConfig] = useState<UploadConfig | null>(null);
  const configRef = useRef<UploadConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .uploadConfig()
      .then(({ config }) => {
        configRef.current = config;
        if (!cancelled) setFetchedConfig(config);
      })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  const loadData = useCallback(async (offset?: number) => {
    // Read the config through a ref: resolving it must not change `loadData`
    // and trigger a second load of the same folder.
    const limit = (configRef.current ?? { defaultLimit: 50 }).defaultLimit;
    const result = await api.listFileManager(spaceId, {
      folderId,
      type,
      q: query || undefined,
      sort,
      includeDeleted: showDeleted && canEdit,
      limit,
      offset: offset ?? 0,
    });
    if (offset === undefined || offset === 0) {
      setData(result);
    } else {
      setData((current) => (current ? {
        ...current,
        files: [...current.files, ...result.files],
        total: result.total,
        limit: result.limit,
        offset: current.offset,
      } : result));
    }
    setSelected((current) => {
      const visible = new Set(result.files.map((f) => f.id));
      return new Set([...current].filter((id) => visible.has(id)));
    });
  }, [spaceId, folderId, type, query, sort, showDeleted, canEdit]);

  // The parent passes a fresh closure on every render. Keeping it in a ref
  // means a parent re-render cannot re-create `refresh`, which would re-run the
  // load effect and send another request (the Module 16 infinite-loop bug).
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const refresh = useCallback(async () => {
    try {
      const [folderList, folderStat] = await Promise.all([
        api.listFolders(spaceId),
        api.folderStats(spaceId, folderId),
      ]);
      setFolders(folderList.folders);
      setStats(folderStat.stats);
      await loadData();
      setError(null);
      onChangedRef.current?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load files');
    }
  }, [spaceId, folderId, loadData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!data || data.files.length >= data.total) return;
    await loadData(data.files.length);
  }, [data, loadData]);

  const breadcrumb = useMemo(() => {
    const chain: Folder[] = [];
    let cursor = folders.find((f) => f.id === folderId);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parentId ? folders.find((f) => f.id === cursor!.parentId) : undefined;
    }
    return chain;
  }, [folders, folderId]);

  const childFolders = useMemo(
    () =>
      folders
        .filter((f) => (f.parentId ?? null) === folderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, folderId],
  );

  const files = data?.files ?? [];
  const counts = data?.counts;
  const selectable = files.filter((f) => f.status === 'ACTIVE');
  const allSelected = selectable.length > 0 && selectable.every((f) => selected.has(f.id));

  const setSelectedIds = (ids: string[]) => setSelected(new Set(ids));

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // -- uploads -------------------------------------------------------------

  const updateUpload = (id: string, patch: Partial<UploadRow>) => {
    setUploads((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const startUpload = async (row: UploadRow) => {
    updateUpload(row.id, { status: 'uploading', progress: 0, error: null });
    activeUploadsRef.current += 1;
    let fileId: string | null = row.fileId;
    try {
      // Frontend size gate: reject files that exceed the per-file limit before
      // we even ask the backend to reserve quota. The backend still enforces its
      // own limit, so this is a UX improvement, not a security boundary.
      const maxBytes = (fetchedConfig ?? { maxUploadBytes: FALLBACK_MAX_UPLOAD_BYTES }).maxUploadBytes;
      if (row.file.size > maxBytes) {
        updateUpload(row.id, {
          status: 'failed',
          error: 'File is larger than the per-file size limit',
        });
        return;
      }
      const init = await api.initUpload(
        spaceId,
        row.file.name,
        row.file.type || 'application/octet-stream',
        row.file.size,
        row.folderId,
      );
      fileId = init.fileId;
      updateUpload(row.id, { fileId });
      await putWithProgress(
        init.url,
        row.file,
        (progress) => updateUpload(row.id, { progress }),
        (xhr) => xhrs.current.set(row.id, xhr),
      );
      updateUpload(row.id, { status: 'confirming', progress: 100 });
      await api.confirmUpload(spaceId, init.fileId);
      updateUpload(row.id, { status: 'done', progress: 100 });
      await refresh();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        // A cancelled upload must release its reservation and partial object.
        if (fileId) await api.cancelUpload(spaceId, fileId).catch(() => undefined);
        updateUpload(row.id, { status: 'cancelled', error: null });
        return;
      }
      // Never leave a PENDING row behind: it would count towards quota and fail
      // archiving later because no object was stored.
      if (fileId) await api.cancelUpload(spaceId, fileId).catch(() => undefined);
      updateUpload(row.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : 'Upload failed',
      });
    } finally {
      xhrs.current.delete(row.id);
      activeUploadsRef.current -= 1;
      // A slot just freed: start the next queued upload if there is one.
      const queued = uploadsRef.current.find((u) => u.status === 'queued');
      if (queued && activeUploadsRef.current < MAX_CONCURRENT_UPLOADS) {
        void startUpload(queued);
      }
    }
  };

  const enqueue = (list: FileList | File[] | null) => {
    if (!list) return;
    const filesToAdd = Array.from(list);
    if (filesToAdd.length === 0) return;
    const rows: UploadRow[] = filesToAdd.map((file) => ({
      id: crypto.randomUUID(),
      file,
      folderId,
      progress: 0,
      status: 'queued',
      error: null,
      fileId: null,
    }));
    setUploads((current) => [...rows, ...current]);
    // Start uploads one at a time up to the concurrency cap; the promise chain
    // in startUpload kicks off the next queued item when a slot frees up.
    for (const row of rows) {
      if (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS) {
        void startUpload(row);
      }
    }
  };

  /** Number of uploads currently in the uploading/confirming phase. */
  const activeUploadCount = () => activeUploadsRef.current;

  // Fetched upload configuration; falls back to the hardcoded default so the UI
  // still works even when the config endpoint is unreachable.
  // (fetchedConfig declared below, before it's used by loadData)

  const cancelUpload = (row: UploadRow) => {
    if (row.status === 'uploading' && xhrs.current.has(row.id)) {
      xhrs.current.get(row.id)?.abort();
      activeUploadsRef.current -= 1;
      return;
    }
    if (row.status === 'queued') {
      // No fileId yet: the init-upload was never called, so there is nothing to
      // cancel server-side. Just mark it cancelled locally.
      updateUpload(row.id, { status: 'cancelled' });
      return;
    }
    if (row.fileId && row.status === 'confirming') {
      void api.cancelUpload(spaceId, row.fileId).catch(() => undefined);
    }
    updateUpload(row.id, { status: 'cancelled' });
    activeUploadsRef.current -= 1;
  };

  // -- file actions --------------------------------------------------------

  const download = async (file: FileListItem) => {
    try {
      const { url } = await api.downloadFile(spaceId, file.id);
      triggerDownload(url, file.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'error');
    }
  };

  const openPreview = async (file: FileListItem) => {
    if (file.status !== 'ACTIVE') return;
    try {
      const { preview: meta } = await api.previewFile(spaceId, file.id);
      if (meta.kind === 'none') {
        setPreview({ meta });
        return;
      }
      let text: string | undefined;
      if (meta.kind === 'text') {
        const res = await fetch(meta.url);
        if (!res.ok) throw new Error('Could not load the text preview');
        const blob = await res.blob();
        text = await blob.slice(0, meta.maxTextBytes).text();
      }
      setPreview({ meta, text });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Preview failed', 'error');
    }
  };

  const openDetails = async (file: FileListItem) => {
    try {
      setDetails((await api.fileDetails(spaceId, file.id)).file);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load file details', 'error');
    }
  };

  const bulkDownload = async (ids: string[]) => {
    setBusy(true);
    try {
      const { blob, filename } = await api.bulkDownloadFiles(spaceId, ids);
      downloadBlob(blob, filename);
      toast(`ZIP with ${ids.length} file${ids.length === 1 ? '' : 's'} ready`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'ZIP download failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runModal = async (value?: string) => {
    if (!modal) return;
    setBusy(true);
    try {
      if (modal.kind === 'new-folder') {
        await api.createFolder(spaceId, value!, modal.parentId);
        toast('Folder created', 'success');
      } else if (modal.kind === 'rename-folder') {
        await api.renameFolder(spaceId, modal.folder.id, value!);
        toast('Folder renamed', 'success');
      } else if (modal.kind === 'move-folder') {
        await api.moveFolder(spaceId, modal.folder.id, value === 'root' ? null : value!);
        toast('Folder moved', 'success');
      } else if (modal.kind === 'delete-folder') {
        const result = await api.deleteFolder(spaceId, modal.folder.id, true);
        toast(
          `Folder deleted · ${result.filesDeleted} file(s) and ${result.foldersDeleted} folder(s)`,
          'success',
        );
        if (folderId === modal.folder.id) setFolderId(null);
      } else if (modal.kind === 'rename-file') {
        await api.renameFile(spaceId, modal.file.id, value!);
        toast('File renamed', 'success');
      } else if (modal.kind === 'move-files') {
        const result = await api.bulkMoveFiles(spaceId, modal.ids, value === 'root' ? null : value!);
        toast(
          result.failed.length
            ? `Moved ${result.succeeded.length}, ${result.failed.length} failed`
            : `Moved ${result.succeeded.length} file(s)`,
          result.failed.length ? 'error' : 'success',
        );
      } else if (modal.kind === 'delete-files') {
        const result = await api.bulkDeleteFiles(spaceId, modal.ids);
        toast(
          result.failed.length
            ? `Deleted ${result.succeeded.length}, ${result.failed.length} failed`
            : `Deleted ${result.succeeded.length} file(s)`,
          result.failed.length ? 'error' : 'success',
        );
        setSelected(new Set());
      }
      setModal(null);
      setDetails(null);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: FileListItem) => {
    try {
      await api.restoreFile(spaceId, file.id);
      toast('File restored', 'success');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not restore this file', 'error');
    }
  };

  const folderOptions = (exclude?: Folder) =>
    folders
      .filter((f) => !exclude || !(f.id === exclude.id || f.path.startsWith(exclude.path)))
      .sort((a, b) => a.path.localeCompare(b.path));

  const folderDepth = (folder: Folder) => Math.max(0, folder.path.split('/').filter(Boolean).length - 1);

  if (error && !data) {
    return <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>;
  }

  return (
    <section className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
          <button
            onClick={() => setFolderId(null)}
            className={`rounded px-2 py-1 transition-colors ${
              folderId === null ? 'font-medium text-primary' : 'text-muted hover:bg-slate-100'
            }`}
          >
            All files
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <Icon name="chevron-right" size={12} className="text-slate-400" />
              <button
                onClick={() => setFolderId(folder.id)}
                className={`rounded px-2 py-1 transition-colors hover:bg-slate-100 ${
                  folderId === folder.id ? 'font-medium text-primary' : 'text-muted'
                }`}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setModal({ kind: 'new-folder', parentId: folderId })}>
              <Icon name="folder" size={14} />
              New folder
            </button>
            <button
              className="btn-primary px-3 py-1.5 text-[12px]"
              onClick={() => fileInput.current?.click()}
              disabled={readOnly}
            >
              <Icon name="upload" size={14} />
              Upload files
            </button>
          </div>
        )}
      </div>

      {/* search / filter / sort */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search by name or folder…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <select className="input w-auto" value={sort} onChange={(event) => setSort(event.target.value as FileSort)}>
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-lg border border-line">
          <button
            className={`px-2.5 py-2 text-[12px] ${view === 'list' ? 'bg-slate-100 text-primary' : 'bg-white text-muted'}`}
            onClick={() => setView('list')}
            title="List view"
            aria-label="List view"
          >
            <Icon name="list" size={14} />
          </button>
          <button
            className={`px-2.5 py-2 text-[12px] ${view === 'grid' ? 'bg-slate-100 text-primary' : 'bg-white text-muted'}`}
            onClick={() => setView('grid')}
            title="Grid view"
            aria-label="Grid view"
          >
            <Icon name="grid" size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setType(filter.value)}
            className={`badge border ${
              type === filter.value
                ? 'border-flash-200 bg-flash-50 text-flash-700'
                : 'border-line bg-white text-muted hover:bg-slate-50'
            }`}
          >
            {filter.label}
            {counts && <span className="ml-1 font-mono opacity-70">{counts[filter.value]}</span>}
          </button>
        ))}
        {canEdit && (
          <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={showDeleted} onChange={(event) => setShowDeleted(event.target.checked)} />
            Show deleted
          </label>
        )}
      </div>

      {/* upload dropzone + queue */}
      {canEdit && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            if (!readOnly) enqueue(event.dataTransfer.files);
          }}
          onClick={() => !readOnly && fileInput.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
            dragOver ? 'border-flash-500 bg-flash-50' : 'border-line bg-white hover:border-flash-400 hover:bg-flash-50/40'
          } ${readOnly ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              enqueue(event.target.files);
              event.target.value = '';
            }}
          />
          <Icon name="upload" size={26} className="mx-auto text-slate-300" />
          <p className="mt-1.5 text-[13px] font-semibold text-primary">
            {readOnly ? 'This Space is read-only' : 'Drop files here or click to upload'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            Uploading to {breadcrumb.length ? breadcrumb[breadcrumb.length - 1]!.path : 'the Space root'}
          </p>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="text-[12px] font-semibold text-primary">
              Uploads ({uploads.filter((u) => u.status === 'uploading' || u.status === 'queued' || u.status === 'confirming').length} active)
            </span>
            <button
              className="text-[11px] text-muted hover:text-primary"
              onClick={() => setUploads((current) => current.filter((u) => u.status !== 'done' && u.status !== 'cancelled'))}
            >
              Clear finished
            </button>
          </div>
          {uploads.map((row) => (
            <div key={row.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0">
              <Icon name="file" size={14} className="flex-shrink-0 text-flash-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-primary">{row.file.name}</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full transition-all ${
                      row.status === 'failed' ? 'bg-red-500' : row.status === 'done' ? 'bg-emerald-500' : 'bg-flash-500'
                    }`}
                    style={{ width: `${row.progress}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  {row.status === 'failed'
                    ? row.error
                    : row.status === 'done'
                      ? 'Uploaded'
                      : row.status === 'cancelled'
                        ? 'Cancelled'
                        : row.status === 'confirming'
                          ? 'Verifying…'
                          : `${row.progress}% of ${fmtBytes(row.file.size)}`}
                </p>
              </div>
              {row.status === 'failed' && (
                <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void startUpload({ ...row, fileId: null })}>
                  Retry
                </button>
              )}
              {(row.status === 'uploading' || row.status === 'queued' || row.status === 'confirming' || row.status === 'failed') && (
                <button className="text-muted hover:text-red-600" onClick={() => cancelUpload(row)} title="Cancel upload" aria-label="Cancel upload">
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* selection toolbar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-flash-200 bg-flash-50 px-3 py-2 text-[12px]">
          <span className="font-semibold text-flash-800">{selected.size} selected</span>
          <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void bulkDownload([...selected])} disabled={busy}>
            <Icon name="download" size={13} /> Download ZIP
          </button>
          {canEdit && (
            <>
              <button
                className="btn-secondary px-2 py-1 text-[11px]"
                onClick={() => setModal({ kind: 'move-files', ids: [...selected], label: `${selected.size} files` })}
              >
                <Icon name="folder" size={13} /> Move
              </button>
              <button
                className="btn-danger px-2 py-1 text-[11px]"
                onClick={() => setModal({ kind: 'delete-files', ids: [...selected], label: `${selected.size} files` })}
              >
                <Icon name="trash" size={13} /> Delete
              </button>
            </>
          )}
          <button className="ml-auto text-[11px] text-muted hover:text-primary" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {stats && (
        <p className="text-[11px] text-muted">
          {stats.fileCount} file{stats.fileCount === 1 ? '' : 's'} · {stats.folderCount} folder
          {stats.folderCount === 1 ? '' : 's'} · {fmtBytes(stats.usedBytes)}
          {folderId ? ' in this folder and below' : ' in this Space'}
        </p>
      )}

      {data && data.total > 0 && (
        <p className="text-[11px] text-muted">
          Showing {data.files.length} of {data.total} file{data.total === 1 ? '' : 's'}
        </p>
      )}

      {data && data.files.length > 0 && data.files.length < data.total && (
        <div className="flex justify-center py-3">
          <button
            className="btn-secondary"
            onClick={() => void loadMore()}
            disabled={busy}
          >
            Load more ({data.total - data.files.length} remaining)
          </button>
        </div>
      )}

      {/* listing */}
      {view === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
          {folders.length > 0 && folderId === null && (
            <div className="border-b border-line/70 bg-slate-50/60 px-4 py-2 text-[11px] uppercase tracking-wider text-muted">
              Folders
            </div>
          )}
          {childFolders.map((folder) => (
            <div
              key={folder.id}
              className="group flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5 transition-colors hover:bg-slate-50"
            >
              <button onClick={() => setFolderId(folder.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon name="folder" size={16} className="flex-shrink-0 text-slate-400" />
                <span className="truncate text-[13px] font-medium text-primary">{folder.name}</span>
                <span className="truncate font-mono text-[11px] text-muted">{folder.path}</span>
              </button>
              {canEdit && (
                <span className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button className="rounded p-1 text-muted hover:bg-white hover:text-primary" title="Rename folder" onClick={() => setModal({ kind: 'rename-folder', folder })}>
                    <Icon name="pencil" size={13} />
                  </button>
                  <button className="rounded p-1 text-muted hover:bg-white hover:text-primary" title="Move folder" onClick={() => setModal({ kind: 'move-folder', folder })}>
                    <Icon name="folder" size={13} />
                  </button>
                  <button className="rounded p-1 text-muted hover:bg-white hover:text-red-600" title="Delete folder" onClick={() => setModal({ kind: 'delete-folder', folder })}>
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              )}
            </div>
          ))}

          {files.length > 0 && (
            <div className="flex items-center gap-2 border-b border-line/70 px-4 py-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelectedIds(allSelected ? [] : selectable.map((f) => f.id))}
                aria-label="Select all files"
              />
              <span>Select all</span>
            </div>
          )}

          {files.map((file) => (
            <div
              key={file.id}
              className={`flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5 last:border-b-0 ${
                selected.has(file.id) ? 'bg-flash-50/60' : 'hover:bg-slate-50'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(file.id)}
                  disabled={file.status !== 'ACTIVE'}
                  onChange={() => toggleSelected(file.id)}
                  aria-label={`Select ${file.name}`}
                />
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void openPreview(file)}>
                  <Icon name={file.previewKind === 'image' ? 'image' : 'file'} size={16} className="flex-shrink-0 text-flash-600" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-primary">
                      {file.name}
                      {file.status === 'DELETED' && <span className="badge bg-red-50 text-red-700">deleted</span>}
                      {file.status === 'PENDING' && <span className="badge bg-amber-50 text-amber-700">pending</span>}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {fmtBytes(file.sizeBytes)} · {fmtDate(file.createdAt)}
                      {file.folderPath ? ` · ${file.folderPath}` : ''}
                      {file.uploaderName ? ` · ${file.uploaderName}` : ''}
                    </span>
                  </span>
                </button>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {file.status === 'DELETED' ? (
                  canEdit && (
                    <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void restore(file)}>
                      <Icon name="refresh" size={12} /> Restore
                    </button>
                  )
                ) : (
                  <>
                    <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void download(file)} title="Download">
                      <Icon name="download" size={12} />
                    </button>
                    <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void openDetails(file)} title="Details">
                      <Icon name="list" size={12} />
                    </button>
                    {canEdit && (
                      <>
                        <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => setModal({ kind: 'rename-file', file })} title="Rename">
                          <Icon name="pencil" size={12} />
                        </button>
                        <button
                          className="btn-secondary px-2 py-1 text-[11px]"
                          onClick={() => setModal({ kind: 'move-files', ids: [file.id], label: file.name })}
                          title="Move"
                        >
                          <Icon name="folder" size={12} />
                        </button>
                        <button
                          className="btn-danger px-2 py-1 text-[11px]"
                          onClick={() => setModal({ kind: 'delete-files', ids: [file.id], label: file.name })}
                          title="Delete"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {files.length === 0 && childFolders.length === 0 && (
            <div className="px-5 py-10 text-center">
              <Icon name="folder" size={32} className="mx-auto text-slate-300" />
              <p className="mt-2 text-[13px] font-medium text-primary">
                {query || type !== 'all' ? 'No files match this filter' : 'Nothing here yet'}
              </p>
              <p className="mt-1 text-[12px] text-muted">
                {canEdit ? 'Upload a file or create a folder to get started.' : 'The owner has not added files here.'}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {childFolders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setFolderId(folder.id)}
              className="flex items-center gap-2 rounded-xl border border-line bg-white p-3 text-left shadow-xs hover:border-flash-300"
            >
              <Icon name="folder" size={20} className="text-slate-400" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-primary">{folder.name}</span>
                <span className="block truncate text-[11px] text-muted">{folder.path}</span>
              </span>
            </button>
          ))}
          {files.map((file) => (
            <button
              key={file.id}
              onClick={() => void openPreview(file)}
              className={`rounded-xl border bg-white p-3 text-left shadow-xs transition-colors hover:border-flash-300 ${
                selected.has(file.id) ? 'border-flash-400 ring-1 ring-flash-200' : 'border-line'
              }`}
            >
              <span className="flex items-center justify-between">
                <Icon name={file.previewKind === 'image' ? 'image' : 'file'} size={20} className="text-flash-600" />
                <input
                  type="checkbox"
                  checked={selected.has(file.id)}
                  disabled={file.status !== 'ACTIVE'}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleSelected(file.id)}
                  aria-label={`Select ${file.name}`}
                />
              </span>
              <span className="mt-2 block truncate text-[13px] font-medium text-primary">{file.name}</span>
              <span className="block truncate text-[11px] text-muted">
                {fmtBytes(file.sizeBytes)} · {fmtDate(file.createdAt)}
              </span>
            </button>
          ))}
          {files.length === 0 && childFolders.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-line bg-white px-4 py-8 text-center text-[12px] text-muted">
              Nothing here yet.
            </p>
          )}
        </div>
      )}

      {/* dialogs */}
      <PromptDialog
        open={modal?.kind === 'new-folder' || modal?.kind === 'rename-folder' || modal?.kind === 'rename-file'}
        title={
          modal?.kind === 'new-folder'
            ? 'New folder'
            : modal?.kind === 'rename-folder'
              ? 'Rename folder'
              : 'Rename file'
        }
        label={modal?.kind === 'rename-file' ? 'File name' : 'Folder name'}
        initialValue={
          modal?.kind === 'rename-file'
            ? modal.file.name
            : modal?.kind === 'rename-folder'
              ? modal.folder.name
              : ''
        }
        placeholder={modal?.kind === 'rename-file' ? 'report.pdf' : 'design-assets'}
        confirmLabel={modal?.kind === 'new-folder' ? 'Create folder' : 'Save'}
        busy={busy}
        onCancel={() => setModal(null)}
        onSubmit={(value) => void runModal(value)}
      />

      <ConfirmDialog
        open={modal?.kind === 'delete-files' || modal?.kind === 'delete-folder'}
        title={modal?.kind === 'delete-folder' ? 'Delete this folder?' : 'Delete the selected files?'}
        message={
          modal?.kind === 'delete-folder'
            ? `"${modal.folder.name}" and everything inside it will be removed. Files are soft-deleted so an administrator can still recover them, and the Space's storage is reclaimed by the cleanup job.`
            : modal?.kind === 'delete-files'
              ? `${modal.label} will be removed from this Space. Files are soft-deleted and can be restored while their stored object still exists.`
              : ''
        }
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setModal(null)}
        onConfirm={() => void runModal()}
      />

      {(modal?.kind === 'move-files' || modal?.kind === 'move-folder') && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-line bg-white p-6 shadow-xl">
            <h2 className="font-display text-[17px] font-bold text-primary">
              Move {modal.kind === 'move-folder' ? modal.folder.name : modal.label}
            </h2>
            <p className="mt-1 text-[12px] text-muted">
              {modal.kind === 'move-folder'
                ? 'Pick a destination. A folder cannot be moved inside itself.'
                : 'Choose the folder that should contain the selected files.'}
            </p>
            <select
              className="input mt-4"
              defaultValue=""
              onChange={(event) => {
                void runModal(event.target.value);
              }}
              disabled={busy}
              aria-label="Destination folder"
            >
              {/* No preselected destination: moving to the root must fire a
                  change even when the item already lives at the root. */}
              <option value="" disabled>
                Choose a destination…
              </option>
              <option value="root">Space root</option>
              {folderOptions(modal.kind === 'move-folder' ? modal.folder : undefined).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {'— '.repeat(folderDepth(folder))}
                  {folder.name}
                </option>
              ))}
            </select>
            <div className="mt-5 flex justify-end">
              <button className="btn-secondary" onClick={() => setModal(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* preview */}
      {preview && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-primary">{preview.meta.name}</p>
                <p className="text-[11px] text-muted">
                  {fmtBytes(preview.meta.sizeBytes)} · {preview.meta.mimeType}
                </p>
              </div>
              <button className="text-muted hover:text-primary" onClick={() => setPreview(null)} aria-label="Close preview">
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="min-h-[240px] overflow-auto bg-slate-50 p-4">
              {preview.meta.kind === 'image' && (
                <img src={preview.meta.url} alt={preview.meta.name} className="mx-auto max-h-[70vh] rounded-lg object-contain" />
              )}
              {preview.meta.kind === 'pdf' && (
                <iframe title={preview.meta.name} src={preview.meta.url} className="h-[70vh] w-full rounded-lg border border-line bg-white" />
              )}
              {preview.meta.kind === 'text' && (
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-white p-4 font-mono text-[12px] text-primary">
                  {preview.text ?? 'Loading…'}
                </pre>
              )}
              {preview.meta.kind === 'none' && (
                <div className="py-10 text-center">
                  <Icon name="file" size={36} className="mx-auto text-slate-300" />
                  <p className="mt-2 text-[13px] font-medium text-primary">No preview for this file type</p>
                  <p className="mt-1 text-[12px] text-muted">
                    Office documents and archives are downloaded and opened locally rather than previewed.
                  </p>
                </div>
              )}
            </div>
            {preview.meta.kind === 'text' && preview.text && preview.text.length >= preview.meta.maxTextBytes && (
              <p className="border-t border-line px-4 py-2 text-[11px] text-amber-700">
                Preview truncated at {fmtBytes(preview.meta.maxTextBytes)}. Download the file to see it in full.
              </p>
            )}
          </div>
        </div>
      )}

      {/* details */}
      {details && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetails(null);
          }}
        >
          <div className="w-full max-w-lg rounded-xl border border-line bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 truncate font-display text-[16px] font-bold text-primary">{details.name}</h2>
              <button className="text-muted hover:text-primary" onClick={() => setDetails(null)} aria-label="Close details">
                <Icon name="x" size={18} />
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
              {[
                ['Location', details.folderPath ?? 'Space root'],
                ['Full path', details.fullPath],
                ['Type', details.mimeType],
                ['Size', fmtBytes(details.sizeBytes)],
                ['Status', details.status],
                ['Uploaded by', details.uploaderName ?? 'Unknown'],
                ['Uploaded', fmtDateTime(details.createdAt)],
                ['Storage', details.storageStatus],
                ['SHA-256', details.sha256 ?? '—'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-words font-medium text-primary">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => void download(details)}>
                <Icon name="download" size={14} /> Download
              </button>
              <button className="btn-primary" onClick={() => setDetails(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {readOnly && (
        <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-muted">
          <Icon name="lock" size={14} />
          This Space is archived and read-only. Download the ZIP from the Vault.
          <button onClick={onOpenVault} className="font-medium text-flash-700 hover:underline">
            Open Vault
          </button>
        </p>
      )}
    </section>
  );
}
