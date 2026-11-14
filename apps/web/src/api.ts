import type {
  AdminStats,
  AdminOverview,
  AdminHealth,
  AdminJobRow,
  AdminJobDetail,
  AdminCleanupRow,
  AdminAuditPage,
  AdminAnalytics,
  AdminUserPage,
  AdminUserDetail,
  Archive,
  MemberRole,
  AuthUser,
  ExtensionRequest,
  FileRecord,
  FileListItem,
  FileListResult,
  FileDetails,
  FilePreview,
  FileSort,
  FileTypeFilter,
  Folder,
  FolderStats,
  BulkFileResult,
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
  SpaceSort,
  SpaceStorageBreakdown,
  SpaceTemplate,
  DuplicateSpaceResult,
  StorageSummary,
  StorageInsights,
  ScanJob,
  DuplicateGroup,
  DuplicateFile,
  NearDuplicateGroup,
  ArchivePlan,
  PlanReview,
  DashboardSummary,
  SearchCategory,
  SearchResults,
  ArchiveDetail,
  ArchiveFile,
  ArchiveFileListing,
  ArchiveVerification,
  VerificationCheck,
  VaultFilteredResult,
  ActivityPage,
  ActivityCategory,
  ActivityActorType,
  ActivityOutcome,
} from './types';

/** Server-side activity filters shared by the Space, account and admin views. */
export interface ActivityFilters {
  q?: string;
  action?: string;
  category?: ActivityCategory;
  actorType?: ActivityActorType;
  outcome?: ActivityOutcome;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  sort?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
}

function activityQueryString(filters: ActivityFilters = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  return query.toString();
}

/** Authenticated CSV download that preserves the server filename. */
async function downloadCsv(path: string, fallback: string): Promise<{ blob: Blob; filename: string }> {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'Export failed', res.status);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? fallback };
}

export interface AccountPreferences {
  notifyInApp: boolean;
  notifyEmail: boolean;
  productUpdates: boolean;
  [key: string]: unknown;
}

export interface AccountView {
  id: string;
  email: string;
  displayName: string;
  role: string;
  avatarPath: string | null;
  avatarUrl: string | null;
  preferences: AccountPreferences;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  accountStatus: string;
  createdAt: string;
  updatedAt: string;
  legacyLink: { legacyProfileId: string; status: string } | null;
}

export interface UploadConfig {
  maxUploadBytes: number;
  maxSpaceBytes: number;
  blockedExtensions: string[];
  defaultLimit: number;
  maxLimit: number;
}

export interface AuthConfig {
  mode: 'local' | 'supabase';
  localAuthEnabled: boolean;
  supabase: { configured: boolean; projectUrl: string | null };
  features: {
    emailVerification: boolean;
    passwordRecovery: boolean;
    cloudProfiles: boolean;
    avatarStorage: boolean;
    mfa?: boolean;
  };
}

const API = import.meta.env.VITE_API_URL ?? '/api';

/**
 * Access-token plumbing.
 *
 * Local development mode keeps its token in localStorage. Supabase mode swaps
 * the provider for `supabase.auth.getSession()`, so the browser only ever holds
 * the session the Supabase SDK manages (and refreshes) for us.
 */
// Access tokens live in memory only; the rotating refresh token is the single
// persistent credential. A page reload exchanges it for a fresh access token.
let localToken: string | null = null;
let localRefreshToken: string | null = localStorage.getItem('flashspace.refresh');
let tokenProvider: () => Promise<string | null> = async () => localToken;
let refreshing: Promise<string | null> | null = null;

export function setToken(token: string | null): void {
  localToken = token;
}

export function setSession(session: { token: string; refreshToken: string } | null): void {
  if (!session) {
    localToken = null;
    localRefreshToken = null;
    localStorage.removeItem('flashspace.refresh');
    localStorage.removeItem('flashspace.token');
    return;
  }
  localToken = session.token;
  localRefreshToken = session.refreshToken;
  localStorage.setItem('flashspace.refresh', session.refreshToken);
  // Remove the legacy 7-day token if a previous build stored it.
  localStorage.removeItem('flashspace.token');
}

export function hasStoredSession(): boolean {
  return Boolean(localRefreshToken);
}

/** Exchange the stored refresh token for a new access token (single-flight). */
export async function restoreSession(): Promise<string | null> {
  if (refreshing) return refreshing;
  if (!localRefreshToken) return null;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: localRefreshToken }),
      });
      if (!res.ok) {
        setSession(null);
        return null;
      }
      const body = (await res.json()) as {
        token: string;
        refreshToken: string;
      };
      setSession({ token: body.token, refreshToken: body.refreshToken });
      return body.token;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Install the Supabase session as the token source (supabase mode only). */
export function setTokenProvider(provider: () => Promise<string | null>): void {
  tokenProvider = provider;
}

export function getToken(): string | null {
  return localToken;
}

export async function getAccessToken(): Promise<string | null> {
  return tokenProvider();
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

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await tokenProvider();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !retried && !path.startsWith('/auth/refresh')) {
    // The access token expired after 15 minutes: rotate once and replay.
    const refreshed = await restoreSession();
    if (refreshed) return call<T>(path, init, true);
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    if (res.status === 401) setSession(null);
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'Request failed', res.status);
  }
  return body as T;
}

export const api = {
  // auth
  async register(email: string, password: string, displayName: string) {
    const r = await call<{ user: AuthUser; token: string; refreshToken: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
    setSession(r);
    return r;
  },
  async login(email: string, password: string) {
    const r = await call<{ user: AuthUser; token: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setSession(r);
    return r;
  },
  async logout() {
    try {
      await call<void>('/auth/logout', { method: 'POST' });
    } catch {
      // A revoked or expired session still needs a local cleanup.
    } finally {
      setSession(null);
    }
  },
  sessions: () =>
    call<{
      sessions: Array<{
        id: string;
        createdAt: string;
        lastUsedAt: string;
        expiresAt: string;
        revokedAt: string | null;
        current: boolean;
        userAgent: string | null;
        ip: string | null;
      }>;
    }>('/auth/sessions'),
  revokeSession: (sessionId: string) =>
    call<void>(`/auth/sessions/${sessionId}`, { method: 'DELETE' }),
  logoutAll: () => call<{ revoked: number }>('/auth/logout-all', { method: 'POST' }),
  me: () => call<{ user: AuthUser }>('/auth/me'),
  /** Local auth: hashed, single-use links delivered by the configured mail transport. */
  requestPasswordReset: (email: string) =>
    call<{ ok: true; message: string }>('/auth/reset-password/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  confirmPasswordReset: (token: string, newPassword: string) =>
    call<{ ok: true; message: string }>('/auth/reset-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
  requestEmailVerification: () =>
    call<{ ok: true; message: string }>('/auth/verify-email/request', { method: 'POST' }),
  confirmEmailVerification: (token: string) =>
    call<{ ok: true; message: string }>(`/auth/verify-email/${encodeURIComponent(token)}`, {
      method: 'POST',
    }),
  /** Local development only: rendered mock emails (no provider configured). */
  devOutbox: () => call<{ messages: Array<Record<string, unknown>> }>('/dev/outbox'),
  updateProfile: (patch: { displayName?: string; avatarUrl?: string | null }) =>
    call<{ user: AuthUser }>('/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),

  // spaces
  listSpaces: (params: {
    status?: string;
    ownership?: 'all' | 'owned' | 'shared';
    q?: string;
    purpose?: string;
    sort?: SpaceSort;
    favorite?: boolean;
    limit?: number;
    offset?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.ownership) query.set('ownership', params.ownership);
    if (params.q) query.set('q', params.q);
    if (params.purpose) query.set('purpose', params.purpose);
    if (params.sort) query.set('sort', params.sort);
    if (params.favorite) query.set('favorite', 'true');
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString();
    return call<{ spaces: SpaceDetail[]; total: number }>(`/spaces${suffix ? `?${suffix}` : ''}`);
  },
  getSpace: (id: string) => call<{ space: SpaceDetail }>(`/spaces/${id}`),
  createSpace: (input: {
    name: string;
    purpose: string;
    description?: string;
    startAt: string;
    expiryAt: string;
    templateId?: string;
  }) => call<{ space: Space }>('/spaces', { method: 'POST', body: JSON.stringify(input) }),
  /** Owner-only settings, including invitation controls. */
  updateSpaceSettings: (id: string, patch: {
    name?: string;
    purpose?: string;
    description?: string;
    expiryAt?: string;
    invitationsEnabled?: boolean;
    defaultInviteRole?: 'EDITOR' | 'VIEWER';
  }) => call<{ space: SpaceDetail }>(`/spaces/${id}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  spaceStorage: (id: string) =>
    call<{ storage: SpaceStorageBreakdown }>(`/spaces/${id}/storage`).then((r) => r.storage),
  favoriteSpace: (id: string) => call<{ favorite: boolean }>(`/spaces/${id}/favorite`, { method: 'POST' }),
  unfavoriteSpace: (id: string) => call<{ favorite: boolean }>(`/spaces/${id}/favorite`, { method: 'DELETE' }),
  favoriteSpaces: () => call<{ spaces: SpaceDetail[] }>('/spaces/favorites'),
  recentSpaces: () => call<{ spaces: SpaceDetail[] }>('/spaces/recent'),
  duplicateSpace: (id: string, input: { name?: string; expiryAt?: string; copyFiles?: boolean }) =>
    call<DuplicateSpaceResult>(`/spaces/${id}/duplicate`, { method: 'POST', body: JSON.stringify(input) }),
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
  // -- Activity & audit (Module 12) ---------------------------------------
  // The endpoint keeps `activity` as its response key for older clients; the
  // Activity page consumes the shared `ActivityPage` shape (`entries`).
  spaceActivity: async (id: string, filters: ActivityFilters = {}) => {
    const page = await call<{ activity: ActivityPage['entries']; total: number; limit: number; offset: number }>(
      `/spaces/${id}/activity?${activityQueryString(filters)}`,
    );
    return {
      entries: page.activity,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    } satisfies ActivityPage;
  },
  downloadSpaceActivity: (id: string, filters: ActivityFilters = {}) =>
    downloadCsv(`/spaces/${id}/activity/export?${activityQueryString(filters)}`, 'space-activity.csv'),
  myActivity: (filters: ActivityFilters = {}) =>
    call<ActivityPage>(`/me/activity?${activityQueryString(filters)}`),
  downloadMyActivity: (filters: ActivityFilters = {}) =>
    downloadCsv(`/me/activity/export?${activityQueryString(filters)}`, 'account-activity.csv'),
  adminActivity: (filters: ActivityFilters = {}) =>
    call<ActivityPage>(`/admin/activity?${activityQueryString(filters)}`),
  downloadAdminActivity: (filters: ActivityFilters = {}) =>
    downloadCsv(`/admin/activity/export?${activityQueryString(filters)}`, 'platform-activity.csv'),
  downloadAdminAudit: (outlet: 'ADMIN' | 'SECURITY' | 'ALL' = 'ALL') =>
    downloadCsv(`/admin/audit/export?outlet=${outlet}`, 'audit.csv'),

  // folders
  listFolders: (id: string) => call<{ folders: Folder[] }>(`/spaces/${id}/folders`),
  createFolder: (id: string, name: string, parentId?: string | null) =>
    call<{ folder: Folder }>(`/spaces/${id}/folders`, {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),
  renameFolder: (id: string, folderId: string, name: string) =>
    call<{ folder: Folder }>(`/spaces/${id}/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  moveFolder: (id: string, folderId: string, parentId: string | null) =>
    call<{ folder: Folder }>(`/spaces/${id}/folders/${folderId}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId }),
    }),
  deleteFolder: (id: string, folderId: string, recursive: boolean) =>
    call<{ filesDeleted: number; foldersDeleted: number }>(
      `/spaces/${id}/folders/${folderId}${recursive ? '?recursive=true' : ''}`,
      { method: 'DELETE' },
    ),
  folderStats: (id: string, folderId: string | null) =>
    call<{ stats: FolderStats }>(`/spaces/${id}/folders/stats${folderId ? `?folderId=${folderId}` : ''}`),

  // files
  listFiles: (id: string) => call<{ files: FileRecord[] }>(`/spaces/${id}/files`),
  /** Module 4 browsing: folder scope, type filter, search, sort, counts, pagination. */
  listFileManager: (
    id: string,
    params: { folderId?: string | null; type?: FileTypeFilter; q?: string; sort?: FileSort; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.folderId !== undefined) query.set('folderId', params.folderId ?? 'root');
    if (params.type) query.set('type', params.type);
    if (params.q) query.set('q', params.q);
    if (params.sort) query.set('sort', params.sort);
    if (params.includeDeleted) query.set('includeDeleted', 'true');
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return call<FileListResult>(`/spaces/${id}/files${suffix}`);
  },
  fileDetails: (id: string, fileId: string) => call<{ file: FileDetails }>(`/spaces/${id}/files/${fileId}`),
  previewFile: (id: string, fileId: string) =>
    call<{ preview: FilePreview }>(`/spaces/${id}/files/${fileId}/preview`, { method: 'POST' }),
  moveFile: (id: string, fileId: string, folderId: string | null) =>
    call<{ file: FileRecord }>(`/spaces/${id}/files/${fileId}/move`, {
      method: 'POST',
      body: JSON.stringify({ folderId }),
    }),
  restoreFile: (id: string, fileId: string) =>
    call<{ file: FileRecord }>(`/spaces/${id}/files/${fileId}/restore`, { method: 'POST' }),
  cancelUpload: (id: string, fileId: string) =>
    call<void>(`/spaces/${id}/files/${fileId}/upload`, { method: 'DELETE' }),
  bulkDeleteFiles: (id: string, fileIds: string[]) =>
    call<BulkFileResult>(`/spaces/${id}/files/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),
  bulkMoveFiles: (id: string, fileIds: string[], folderId: string | null) =>
    call<BulkFileResult>(`/spaces/${id}/files/bulk-move`, {
      method: 'POST',
      body: JSON.stringify({ fileIds, folderId }),
    }),
  /** Authenticated ZIP download: returns a blob plus the server's filename. */
  bulkDownloadFiles: async (id: string, fileIds: string[]): Promise<{ blob: Blob; filename: string }> => {
    const token = await tokenProvider();
    const res = await fetch(`${API}/spaces/${id}/files/bulk-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ fileIds }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = (body as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'ZIP download failed', res.status);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await res.blob(), filename: match?.[1] ?? 'files.zip' };
  },
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
  vault: (params?: { q?: string; status?: string; sort?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.q) q.set('q', params.q);
    if (params?.status) q.set('status', params.status);
    if (params?.sort) q.set('sort', params.sort);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return call<VaultFilteredResult>(`/vault/archives${suffix}`);
  },
  getArchive: (id: string) => call<ArchiveDetail>(`/vault/archives/${id}`),
  getArchiveFiles: (id: string) => call<ArchiveFileListing>(`/vault/archives/${id}/files`),
  verifyArchive: (id: string) => call<ArchiveVerification>(`/vault/archives/${id}/verify`, { method: 'POST' }),
  downloadArchive: (id: string) => call<{ url: string; expiresAt: string }>(`/vault/archives/${id}/download`, { method: 'POST' }),
  downloadManifest: (id: string) => call<{ url: string; expiresAt: string }>(`/vault/archives/${id}/manifest`, { method: 'POST' }),
  exportCsv: (params?: { q?: string; status?: string; sort?: string }) => {
    const q = new URLSearchParams();
    if (params?.q) q.set('q', params.q);
    if (params?.status) q.set('status', params.status);
    if (params?.sort) q.set('sort', params.sort);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return fetch(`${API}/vault/archives/export-csv${suffix}`).then((r) => {
      if (!r.ok) throw new ApiError('EXPORT_FAILED', 'CSV export failed', r.status);
      return r.blob();
    });
  },
  // storage
  storageSummary: () => call<{ storage: StorageSummary }>('/storage/summary').then((r) => r.storage),
  leaveSpace: (id: string) => call<void>(`/spaces/${id}/leave`, { method: 'POST' }),
  resendInvitation: (invitationId: string) => call<{ resent: boolean }>(`/invitations/${invitationId}/resend`, { method: 'POST' }),
  validateInvitation: (token: string) =>
    call<{
      invitation: {
        id: string;
        spaceId: string;
        email: string;
        intendedRole: MemberRole;
        status: string;
        expiresAt: string;
        createdAt: string;
      };
      invitationSpaceName: string;
      invitationSpacePurpose: string;
      invitationSpaceDescription: string;
      inviterDisplayName: string;
      memberCount: number;
      alreadyMember: boolean;
    }>('/invitations/validate', { method: 'POST', body: JSON.stringify({ token }) }),
  acceptInvitation: (token: string) =>
    call<{ invitation: { id: string; status: string; intendedRole: MemberRole } }>('/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  declineInvitation: (token: string) =>
    call<{ invitation: { id: string; status: string } }>('/invitations/decline', { method: 'POST', body: JSON.stringify({ token }) }),
  /** Notification-driven invitation decision (resolved server-side by email). */
  decideSpaceInvitation: (spaceId: string, decision: 'ACCEPT' | 'DECLINE') =>
    call<{ invitation: { id: string; status: string }; member?: unknown }>(
      `/spaces/${spaceId}/invitations/decision`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    ),

  // -- Module 2: dashboard + global search --------------------------------
  /** One authenticated dashboard payload; every section comes from live rows. */
  dashboardSummary: () => call<DashboardSummary>('/dashboard/summary'),
  search: (params: {
    q: string;
    category?: SearchCategory;
    spaceId?: string;
    type?: string;
    limit?: number;
  }) => {
    const query = new URLSearchParams({ q: params.q });
    if (params.category) query.set('category', params.category);
    if (params.spaceId) query.set('spaceId', params.spaceId);
    if (params.type) query.set('type', params.type);
    if (params.limit) query.set('limit', String(params.limit));
    return call<SearchResults>(`/search?${query.toString()}`);
  },

  // -- Module 11: admin control panel ---------------------------------------
  adminStats: () => call<AdminStats>('/admin/stats'),
  adminOverview: () => call<AdminOverview>('/admin/overview'),
  adminHealth: () => call<AdminHealth>('/admin/health'),
  adminUsers: (params: {
    q?: string;
    role?: 'USER' | 'ADMIN';
    status?: 'ACTIVE' | 'SUSPENDED';
    sort?: 'created-asc' | 'created-desc' | 'name-asc' | 'name-desc' | 'activity-desc';
    limit?: number;
    offset?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.role) query.set('role', params.role);
    if (params.status) query.set('status', params.status);
    if (params.sort) query.set('sort', params.sort);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return call<AdminUserPage>(`/admin/users${suffix}`);
  },
  adminUser: (userId: string) => call<AdminUserDetail>(`/admin/users/${userId}`),
  adminSetRole: (userId: string, role: 'USER' | 'ADMIN', reason?: string) =>
    call<{ user: Profile }>(`/admin/users/${userId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role, confirm: true, ...(reason ? { reason } : {}) }),
    }),
  adminPromote: (userId: string) => call<{ user: Profile }>(`/admin/users/${userId}/promote`, { method: 'POST' }),
  adminSuspend: (userId: string, reason: string) =>
    call<{ user: Profile }>(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason, confirm: true }),
    }),
  adminReactivate: (userId: string) =>
    call<{ user: Profile }>(`/admin/users/${userId}/reactivate`, { method: 'POST' }),
  adminJobList: (params: {
    status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    jobType?: 'LIFECYCLE' | 'ARCHIVE' | 'CLEANUP';
    q?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.jobType) query.set('jobType', params.jobType);
    if (params.q) query.set('q', params.q);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return call<{ jobs: AdminJobRow[]; total: number; limit: number; offset: number }>(
      `/admin/jobs${suffix}`,
    );
  },
  adminJob: (jobId: string) => call<AdminJobDetail>(`/admin/jobs/${jobId}`),
  adminFailedJobs: () => call<{ jobs: AdminJobRow[]; total: number }>('/admin/jobs/failed'),
  adminRetryJob: (jobId: string) =>
    call<AdminJobDetail>(`/admin/jobs/${jobId}/retry`, { method: 'POST' }),
  adminJobs: () => call<{ jobs: AdminJobRow[]; total: number; limit: number; offset: number }>('/admin/jobs'),
  adminArchives: (status?: string) =>
    call<{ archives: (Archive & { spaceName: string | null })[]; total: number }>(
      `/admin/archives${status ? `?status=${status}` : ''}`,
    ),
  adminRetryArchive: (archiveId: string) => call<{ archive: Archive }>(`/admin/archives/${archiveId}/retry`, { method: 'POST' }),
  adminCleanup: () =>
    call<{
      runs: AdminCleanupRow[];
      awaiting: { spaceId: string; spaceName: string; status: string; retentionEligibleAt: string }[];
      failed: number;
      partial: number;
    }>('/admin/cleanup'),
  adminExtensions: () => call<{ requests: ExtensionRequest[] }>('/admin/extensions'),
  adminDecide: (requestId: string, decision: 'APPROVED' | 'REJECTED') =>
    call<{ request: ExtensionRequest }>(`/admin/extensions/${requestId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  adminAudit: (params: { outlet?: 'SECURITY' | 'ADMIN' | 'ALL'; action?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.outlet) query.set('outlet', params.outlet);
    if (params.action) query.set('action', params.action);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return call<AdminAuditPage>(`/admin/audit${suffix}`);
  },
  adminSecurityEvents: (params: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return call<AdminAuditPage>(`/admin/security-events${suffix}`);
  },
  adminAnalytics: (days = 14) => call<AdminAnalytics>(`/admin/analytics?days=${days}`),
  // notifications
  notificationsUnread: () =>
    call<{ unread: number }>('/notifications/unread'),

  // -- Module 1: account management ----------------------------------------
  /** Provider capabilities, so the UI can explain what is available. */
  uploadConfig: () => call<{ config: UploadConfig }>('/upload-config'),
  authConfig: () => call<AuthConfig>('/auth/config'),
  accountMe: () => call<{ account: AccountView }>('/users/me'),
  updateAccount: (patch: { displayName?: string; preferences?: Partial<AccountPreferences> }) =>
    call<{ account: AccountView }>('/users/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  async uploadAvatar(file: Blob & { type: string }) {
    const token = await getAccessToken();
    const res = await fetch(`${API}/users/me/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'Could not upload the image', res.status);
    }
    return body as { account: AccountView };
  },
  removeAvatar: () => call<{ account: AccountView }>('/users/me/avatar', { method: 'DELETE' }),
  changeEmail: (newEmail: string) =>
    call<{ pending: string }>('/users/me/change-email', {
      method: 'POST',
      body: JSON.stringify({ newEmail }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<{ ok: true }>('/users/me/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  async exportAccount(): Promise<Blob> {
    const token = await getAccessToken();
    const res = await fetch(`${API}/users/me/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError('EXPORT_FAILED', 'Could not export your data', res.status);
    return res.blob();
  },
  deleteAccount: (password: string) =>
    call<void>('/users/me', { method: 'DELETE', body: JSON.stringify({ password }) }),
  linkLegacyAccount: (email: string, password: string) =>
    call<{ linked: true; legacyProfileId: string }>('/users/me/link-legacy', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

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
