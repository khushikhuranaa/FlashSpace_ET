import type {
  AdminStats,
  Archive,
  AuthUser,
  ExtensionRequest,
  FileRecord,
  Folder,
  JoinRequestView,
  LifecycleJob,
  MembersPayload,
  Notification,
  Profile,
  Space,
  SpaceDetail,
  SpaceInviteLink,
  SpaceMember,
  SpaceStatus,
  SpaceJoinPreview,
  StorageSummary,
  StorageInsights,
  ScanJob,
  DuplicateGroup,
  DuplicateFile,
  NearDuplicateGroup,
  ArchivePlan,
  PlanReview,
} from './types';

const API = import.meta.env.VITE_API_URL ?? '/api';

let authToken: string | null = localStorage.getItem('flashspace.token');

export function setToken(token: string | null): void {
  authToken = token;
  if (token) localStorage.setItem('flashspace.token', token);
  else localStorage.removeItem('flashspace.token');
}

export function getToken(): string | null {
  return authToken;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'Request failed', res.status);
  }
  return body as T;
}

export const api = {
  // auth
  async register(email: string, password: string, displayName: string) {
    const r = await call<{ user: AuthUser; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
    setToken(r.token);
    return r;
  },
  async login(email: string, password: string) {
    const r = await call<{ user: AuthUser; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(r.token);
    return r;
  },
  logout() {
    setToken(null);
  },
  me: () => call<{ user: AuthUser }>('/auth/me'),
  updateProfile: (patch: { displayName?: string; avatarUrl?: string | null }) =>
    call<{ user: AuthUser }>('/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),

  // spaces
  listSpaces: () => call<{ spaces: SpaceDetail[] }>('/spaces'),
  getSpace: (id: string) => call<{ space: SpaceDetail }>(`/spaces/${id}`),
  createSpace: (input: { name: string; purpose: string; description?: string; startAt: string; expiryAt: string }) =>
    call<{ space: Space }>('/spaces', { method: 'POST', body: JSON.stringify(input) }),
  updateSpace: (id: string, patch: { name?: string; purpose?: string; description?: string; expiryAt?: string }) =>
    call<{ space: Space }>(`/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSpace: (id: string) => call<void>(`/spaces/${id}`, { method: 'DELETE' }),
  archiveSpace: (id: string) => call<{ archive: Archive }>(`/spaces/${id}/archive`, { method: 'POST' }),
  listMembers: (id: string) => call<MembersPayload>(`/spaces/${id}/members`),
  invite: (id: string, email: string, role: 'EDITOR' | 'VIEWER') =>
    call<{ delivered: boolean }>(`/spaces/${id}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  createInviteLink: (id: string, role?: 'EDITOR' | 'VIEWER') =>
    call<{ inviteLink: SpaceInviteLink & { url: string } }>(`/spaces/${id}/invite-link`, { method: 'POST', body: JSON.stringify({ role }) }),
  revokeInviteLink: (id: string) => call<void>(`/spaces/${id}/invite-link`, { method: 'DELETE' }),
  listJoinRequests: (id: string) => call<{ requests: JoinRequestView[] }>(`/spaces/${id}/join-requests`),
  decideJoinRequest: (requestId: string, decision: 'ACCEPT' | 'DECLINE') =>
    call<{ request: JoinRequestView }>(`/join-requests/${requestId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  changeRole: (id: string, userId: string, role: 'EDITOR' | 'VIEWER') =>
    call<{ member: SpaceMember }>(`/spaces/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  revokeMember: (id: string, userId: string) => call<void>(`/spaces/${id}/members/${userId}`, { method: 'DELETE' }),
  activity: (id: string) => call<{ activity: { id: number; action: string; createdAt: string; userId: string | null; metadata: Record<string, unknown> }[] }>(`/spaces/${id}/activity`),

  // folders
  listFolders: (id: string) => call<{ folders: Folder[] }>(`/spaces/${id}/folders`),
  createFolder: (id: string, name: string, parentId?: string | null) =>
    call<{ folder: Folder }>(`/spaces/${id}/folders`, {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),

  // files
  listFiles: (id: string) => call<{ files: FileRecord[] }>(`/spaces/${id}/files`),
  initUpload: (id: string, name: string, mimeType: string, sizeBytes: number, folderId?: string | null) =>
    call<{ fileId: string; objectKey: string; url: string; expiresAt: string }>(`/spaces/${id}/files/init-upload`, {
      method: 'POST',
      body: JSON.stringify({ name, mimeType, sizeBytes, folderId: folderId ?? null }),
    }),
  confirmUpload: (id: string, fileId: string) =>
    call<{ file: FileRecord }>(`/spaces/${id}/files/${fileId}/confirm-upload`, { method: 'POST' }),
  downloadFile: (id: string, fileId: string) =>
    call<{ url: string; expiresAt: string }>(`/spaces/${id}/files/${fileId}/download`, { method: 'POST' }),
  renameFile: (id: string, fileId: string, name: string) =>
    call<{ file: FileRecord }>(`/spaces/${id}/files/${fileId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFile: (id: string, fileId: string) => call<void>(`/spaces/${id}/files/${fileId}`, { method: 'DELETE' }),

  // extensions
  requestExtension: (id: string, requestedDays: number, reason: string) =>
    call<{ request: ExtensionRequest }>(`/spaces/${id}/extensions`, {
      method: 'POST',
      body: JSON.stringify({ requestedDays, reason }),
    }),
  listExtensions: (id: string) => call<{ requests: ExtensionRequest[] }>(`/spaces/${id}/extensions`),

  // notifications + vault
  notifications: () => call<{ notifications: Notification[] }>('/notifications'),
  markRead: (id: string) => call<{ notification: Notification }>(`/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => call<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
  vault: () => call<{ archives: Archive[] }>('/vault/archives'),
  downloadArchive: (id: string) => call<{ url: string; expiresAt: string }>(`/vault/archives/${id}/download`, { method: 'POST' }),
  // storage
  storageSummary: () => call<{ storage: StorageSummary }>('/storage/summary').then((r) => r.storage),

  // admin
  adminStats: () => call<AdminStats>('/admin/stats'),
  adminUsers: () => call<{ users: Profile[] }>('/admin/users'),
  adminPromote: (userId: string) => call<{ user: Profile }>(`/admin/users/${userId}/promote`, { method: 'POST' }),
  adminJobs: () => call<{ jobs: LifecycleJob[] }>('/admin/jobs'),
  adminExtensions: () => call<{ requests: ExtensionRequest[] }>('/admin/extensions'),
  adminDecide: (requestId: string, decision: 'APPROVED' | 'REJECTED') =>
    call<{ request: ExtensionRequest }>(`/admin/extensions/${requestId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  adminRetryArchive: (archiveId: string) => call<{ archive: Archive }>(`/admin/archives/${archiveId}/retry`, { method: 'POST' }),
  // notifications
  notificationsUnread: () =>
    call<{ unread: number }>('/notifications/unread'),

  // -- Smart Storage Insights ----------------------------------------------
  /** Run a fresh scan (Space owner only). */
  runScan: (id: string) =>
    call<{ insights: StorageInsights }>(`/spaces/${id}/scans`, { method: 'POST' }),
  /** Latest scan report for a Space (real backend data, never mocked). */
  insights: (id: string) =>
    call<{ insights: StorageInsights }>(`/spaces/${id}/insights`),
  duplicates: (id: string) =>
    call<{
      scan: ScanJob | null;
      exactGroups: DuplicateGroup[];
      nearGroups: NearDuplicateGroup[];
      totalFiles: number;
      totalBytes: number;
      duplicateFileCount: number;
      extraCopyCount: number;
      potentialSavingsBytes: number;
    }>(`/spaces/${id}/duplicates`),
  toggleDuplicateExclusion: (id: string, fileId: string) =>
    call<{ file: DuplicateFile }>(`/spaces/${id}/duplicates/${fileId}/exclusion`, { method: 'POST' }),

  // -- Archive plans -------------------------------------------------------
  createPlan: (id: string, input: { scanId?: string; excludedFileIds?: string[]; explained: boolean }) =>
    call<{ plan: ArchivePlan }>(`/spaces/${id}/plans`, { method: 'POST', body: JSON.stringify(input) }),
  listPlans: (id: string) => call<{ plans: ArchivePlan[] }>(`/spaces/${id}/plans`),
  getPlan: (planId: string) => call<PlanReview>(`/plans/${planId}`),
  confirmPlan: (planId: string) => call<PlanReview>(`/plans/${planId}/confirm`, { method: 'POST' }),
  cancelPlan: (planId: string) => call<{ plan: ArchivePlan }>(`/plans/${planId}/cancel`, { method: 'POST' }),
};

export async function uploadViaSignedUrl(url: string, file: File): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body: file });
  if (!res.ok) throw new ApiError('STORAGE_ERROR', 'Upload failed', res.status);
}
