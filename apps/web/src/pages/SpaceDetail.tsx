import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadViaSignedUrl } from '../api';
import type {
  AuthUser,
  ExtensionRequest,
  FileRecord,
  Folder,
  JoinRequestView,
  MembersPayload,
  PendingInviteView,
  SpaceDetail as SpaceDetailType,
} from '../types';
import { Icon } from '../components/Icon';
import { StatCard } from '../components/StatCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PromptDialog } from '../components/PromptDialog';
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
import { triggerDownload } from '../lib/download';

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

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 border border-slate-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  WARNING: 'bg-amber-50 text-amber-700 border border-amber-200',
  ARCHIVING: 'bg-blue-50 text-blue-700 border border-blue-200',
  ARCHIVED: 'bg-purple-50 text-purple-700 border border-purple-200',
  ARCHIVE_FAILED: 'bg-red-50 text-red-700 border border-red-200',
  DELETED: 'bg-slate-100 text-slate-500 border border-slate-200',
};

type PendingAction =
  | { kind: 'archive' }
  | { kind: 'delete' }
  | { kind: 'revoke'; userId: string; name: string }
  | { kind: 'delete-file'; file: FileRecord };

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
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [membersPayload, setMembersPayload] = useState<MembersPayload | null>(null);
  const [extensions, setExtensions] = useState<ExtensionRequest[]>([]);
  const [activity, setActivity] = useState<{ id: number; action: string; createdAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER');
  const [extDays, setExtDays] = useState(3);
  const [extReason, setExtReason] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [prompt, setPrompt] = useState<{ kind: 'folder' } | { kind: 'rename'; file: FileRecord } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const activeTab: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'files';

  const load = useCallback(async () => {
    const s = await api.getSpace(id);
    setSpace(s.space);
    setFiles((await api.listFiles(id)).files);
    setFolders((await api.listFolders(id)).folders);
    setMembersPayload(await api.listMembers(id));
    setExtensions((await api.listExtensions(id)).requests);
    setActivity((await api.activity(id)).activity);
  }, [id]);

  useEffect(() => {
    setError(null);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load this Space'));
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

  const breadcrumb: Folder[] = useMemo(() => {
    const chain: Folder[] = [];
    let cursor = folders.find((f) => f.id === currentFolderId);
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentId ? folders.find((f) => f.id === cursor!.parentId) : undefined;
    }
    return chain;
  }, [folders, currentFolderId]);

  const childFolders = useMemo(
    () => folders.filter((f) => f.parentId === currentFolderId).sort((a, b) => a.name.localeCompare(b.name)),
    [folders, currentFolderId],
  );
  const visibleFiles = useMemo(
    () => files.filter((f) => (f.folderId ?? null) === currentFolderId),
    [files, currentFolderId],
  );

  const members = membersPayload?.members ?? [];
  const pendingInvites: PendingInviteView[] = membersPayload?.pending ?? [];
  const joinRequests: JoinRequestView[] = membersPayload?.joinRequests ?? [];
  const inviteLink = membersPayload?.inviteLink ?? null;

  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        let fileId: string | null = null;
        try {
          const init = await api.initUpload(
            id,
            file.name,
            file.type || 'application/octet-stream',
            file.size,
            currentFolderId,
          );
          fileId = init.fileId;
          await uploadViaSignedUrl(init.url, file);
          await api.confirmUpload(id, init.fileId);
        } catch (err) {
          // Do not leave a PENDING row behind: it would count towards storage and
          // break archiving later because its object was never stored.
          if (fileId) await api.deleteFile(id, fileId).catch(() => undefined);
          throw err;
        }
      }
      await load();
      toast(`${list.length} file${list.length === 1 ? '' : 's'} uploaded`, 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      setError(message);
      toast(message, 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const createFolder = async (name: string) => {
    setBusy(true);
    try {
      await api.createFolder(id, name, currentFolderId);
      await load();
      setPrompt(null);
      toast('Folder created', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the folder', 'error');
    } finally {
      setBusy(false);
    }
  };

  const renameFile = async (file: FileRecord, name: string) => {
    setBusy(true);
    try {
      await api.renameFile(id, file.id, name);
      await load();
      setPrompt(null);
      toast('File renamed', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Rename failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const download = async (fileId: string) => {
    try {
      const { url } = await api.downloadFile(id, fileId);
      triggerDownload(url, files.find((f) => f.id === fileId)?.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'error');
    }
  };

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
      } else if (pending.kind === 'revoke') {
        await api.revokeMember(id, pending.userId);
        await load();
        toast(`${pending.name} removed from the Space`, 'success');
      } else {
        await api.deleteFile(id, pending.file.id);
        await load();
        toast('File deleted', 'success');
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
        <button className="btn-secondary mt-3" onClick={goBack}>
          Back
        </button>
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
        <button onClick={() => navigate('/dashboard')} className="hover:text-primary">
          Spaces
        </button>
        <Icon name="chevron-right" size={14} className="text-slate-400" />
        <span className="font-medium text-primary">{space.name}</span>
      </div>

      <section className="rounded-xl border border-line bg-white p-6 shadow-xs">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-bold tracking-tight text-primary">{space.name}</h1>
              <span className={`badge ${STATUS_STYLES[space.status] ?? ''}`}>{space.status}</span>
              <span className="badge bg-flash-50 text-flash-700">you: {space.role ?? 'ADMIN'}</span>
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
                    ? 'text-purple-600'
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

      <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1 shadow-xs">
        {TABS.map((value) => (
          <button
            key={value}
            onClick={() => go(value)}
            aria-pressed={activeTab === value}
            className={`flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
              activeTab === value ? 'bg-flash-600 text-white' : 'text-muted hover:bg-slate-50 hover:text-primary'
            }`}
          >
            {TAB_LABEL[value]}
            {value === 'files' && (
              <span className="ml-1.5 font-mono opacity-70">{files.length}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <section className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Files" value={files.length} hint="Active objects in this Space" icon="file" />
            <StatCard label="Members" value={activeMembers} hint={`${joinRequests.filter((r) => r.status === 'PENDING').length} pending request(s)`} icon="users" />
            <StatCard
              label="Time remaining"
              value={readOnlyArchive ? 'Archived' : remaining.expired ? 'Expired' : `${remaining.days}d ${remaining.hours}h`}
              hint={readOnlyArchive ? 'ZIP available in the Vault' : `Ends ${fmtDateTime(space.expiryAt)}`}
              icon="clock"
            />
          </div>
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
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 text-[13px]">
              <button
                onClick={() => setCurrentFolderId(null)}
                className={`rounded px-2 py-1 transition-colors ${
                  currentFolderId === null ? 'font-medium text-primary' : 'text-muted hover:bg-slate-100'
                }`}
              >
                All files
              </button>
              {breadcrumb.map((folder) => (
                <span key={folder.id} className="flex items-center gap-1">
                  <Icon name="chevron-right" size={12} className="text-slate-400" />
                  <button
                    onClick={() => setCurrentFolderId(folder.id)}
                    className="rounded px-2 py-1 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
                  >
                    {folder.name}
                  </button>
                </span>
              ))}
            </div>
            {canEdit && (
              <div className="flex gap-2">
                <button className="btn-secondary px-3 py-1.5 text-[12px]" onClick={() => setPrompt({ kind: 'folder' })}>
                  <Icon name="folder" size={14} />
                  New folder
                </button>
                <button
                  className="btn-primary px-3 py-1.5 text-[12px]"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                >
                  <Icon name="upload" size={14} />
                  {uploading ? 'Uploading…' : 'Upload files'}
                </button>
              </div>
            )}
          </div>

          {canEdit ? (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void onUpload(event.dataTransfer.files);
              }}
              onClick={() => fileInput.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                dragOver ? 'border-flash-500 bg-flash-50' : 'border-line bg-white hover:border-flash-400 hover:bg-flash-50/40'
              }`}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => void onUpload(event.target.files)}
              />
              <Icon name="upload" size={36} className="mx-auto text-slate-300" />
              <p className="mt-2 text-[14px] font-semibold text-primary">
                {uploading ? 'Uploading…' : 'Drop files here or click to upload'}
              </p>
              <p className="mt-1 text-[12px] text-muted">
                Uploading to {breadcrumb.length ? breadcrumb[breadcrumb.length - 1]!.path : 'the Space root'}
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-muted">
              <Icon name="lock" size={14} />
              {readOnlyArchive
                ? 'This Space is archived and read-only. Download the ZIP from the Vault.'
                : 'You have view-only access to this Space.'}
              {readOnlyArchive && (
                <button onClick={() => navigate('/vault')} className="font-medium text-flash-700 hover:underline">
                  Open Vault
                </button>
              )}
            </p>
          )}

          <div className="overflow-hidden rounded-xl border border-line bg-white shadow-xs">
            {childFolders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => setCurrentFolderId(folder.id)}
                className="flex w-full items-center justify-between gap-3 border-b border-line/70 px-5 py-3 text-left transition-colors hover:bg-slate-50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon name="folder" size={16} className="flex-shrink-0 text-slate-400" />
                  <span className="truncate text-[13px] font-medium text-primary">{folder.name}</span>
                </span>
                <span className="flex-shrink-0 font-mono text-[11px] text-muted">{folder.path}</span>
              </button>
            ))}

            {visibleFiles.map((file) => (
              <div
                key={file.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon name="file" size={16} className="flex-shrink-0 text-flash-600" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-primary">
                      {file.name}
                      {file.status !== 'ACTIVE' && (
                        <span className="badge bg-amber-50 text-amber-700">{file.status}</span>
                      )}
                    </p>
                    <p className="text-[11px] text-muted">
                      {fmtBytes(file.sizeBytes)} · uploaded {fmtDate(file.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    className="btn-secondary px-2.5 py-1 text-[12px]"
                    onClick={() => void download(file.id)}
                    disabled={readOnlyArchive || file.status !== 'ACTIVE'}
                    title={
                      readOnlyArchive
                        ? 'Archived Spaces are read-only'
                        : file.status !== 'ACTIVE'
                          ? 'This upload never completed'
                          : 'Download file'
                    }
                  >
                    <Icon name="download" size={14} />
                    Download
                  </button>
                  {canEdit && (
                    <>
                      <button
                        className="btn-secondary px-2.5 py-1 text-[12px]"
                        onClick={() => setPrompt({ kind: 'rename', file })}
                      >
                        <Icon name="pencil" size={14} />
                        Rename
                      </button>
                      <button
                        className="btn-danger px-2.5 py-1 text-[12px]"
                        onClick={() => setPending({ kind: 'delete-file', file })}
                      >
                        <Icon name="trash" size={14} />
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {visibleFiles.length === 0 && childFolders.length === 0 && (
              <div className="px-5 py-10 text-center">
                <Icon name="folder" size={36} className="mx-auto text-slate-300" />
                <p className="mt-2 text-[13px] font-medium text-primary">No files in this folder yet</p>
                <p className="mt-1 text-[12px] text-muted">
                  {canEdit ? 'Upload something to get started.' : 'The owner has not uploaded files here.'}
                </p>
              </div>
            )}
          </div>
        </section>
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
            <div className="overflow-x-auto">
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

      {activeTab === 'activity' && (
        <section className="rounded-xl border border-line bg-white p-5 shadow-xs">
          <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted">No activity recorded yet.</p>
          ) : (
            <ol className="mt-4 space-y-4">
              {activity.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-flash-600" />
                  <div className="min-w-0">
                    <p className="text-[13px] text-primary">
                      {entry.action.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="text-[11px] text-muted">
                      {fmtDateTime(entry.createdAt)} · {timeAgo(entry.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {activeTab === 'settings' && (
        canEdit && space ? (
          <SpaceSettingsForm key={space.updatedAt} space={space} onSaved={() => void load()} />
        ) : (
          <div className="rounded-xl border border-line bg-white p-5 text-[13px] text-muted shadow-xs">
            {writableStatus
              ? 'Only owners and editors can change Space settings.'
              : 'This Space is read-only. Settings cannot be changed after archiving starts.'}
          </div>
        )
      )}

      <PromptDialog
        open={prompt !== null}
        title={prompt?.kind === 'rename' ? 'Rename file' : 'New folder'}
        label={prompt?.kind === 'rename' ? 'File name' : 'Folder name'}
        initialValue={prompt?.kind === 'rename' ? prompt.file.name : ''}
        placeholder={prompt?.kind === 'rename' ? 'report.pdf' : 'design-assets'}
        maxLength={prompt?.kind === 'rename' ? 255 : 120}
        confirmLabel={prompt?.kind === 'rename' ? 'Rename' : 'Create folder'}
        busy={busy}
        onCancel={() => setPrompt(null)}
        onSubmit={(value) => {
          if (!prompt) return;
          if (prompt.kind === 'rename') void renameFile(prompt.file, value);
          else void createFolder(value);
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'delete' || pending?.kind === 'delete-file'
            ? 'Delete permanently?'
            : pending?.kind === 'archive'
              ? 'Archive this Space?'
              : 'Remove this member?'
        }
        message={
          pending?.kind === 'archive'
            ? `"${space.name}" will be packaged into your Vault. Members lose write access immediately and the Space becomes read-only.`
            : pending?.kind === 'delete'
              ? `"${space.name}" will be removed from every listing. This cannot be undone.`
              : pending?.kind === 'delete-file'
                ? `"${pending.file.name}" will be removed from this Space. This cannot be undone.`
                : pending?.kind === 'revoke'
                  ? `${pending.name} will immediately lose access to this Space.`
                  : ''
        }
        confirmLabel={
          pending?.kind === 'delete'
            ? 'Delete Space'
            : pending?.kind === 'delete-file'
              ? 'Delete file'
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
}: {
  space: SpaceDetailType;
  onSaved: () => void;
}) {
  const toast = useToast().toast;
  const [name, setName] = useState(space.name);
  const [purpose, setPurpose] = useState(space.purpose);
  const [description, setDescription] = useState(space.description);
  const [expiry, setExpiry] = useState(toDateTimeLocal(space.expiryAt));
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (new Date(expiry).getTime() <= new Date(space.startAt).getTime()) {
      toast('The end time must be after the start time', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.updateSpace(space.id, {
        name: name.trim(),
        purpose: purpose.trim(),
        description: description.trim(),
        expiryAt: new Date(expiry).toISOString(),
      });
      toast('Space settings saved', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-white p-5 shadow-xs">
      <h2 className="font-display text-[14px] font-bold tracking-tight text-primary">Space settings</h2>
      <p className="mt-1 text-[12px] text-muted">
        Changes are recorded in the audit log. The start time cannot be moved.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Name</span>
          <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label">Purpose</span>
          <input className="input" required maxLength={300} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
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
          Starts {fmtDateTime(space.startAt)}. Moving the end time changes the countdown immediately;
          members are notified by the lifecycle runner.
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
