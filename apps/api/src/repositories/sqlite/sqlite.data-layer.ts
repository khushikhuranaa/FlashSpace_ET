/**
 * SQLite data layer — the real, persistent database behind the API.
 *
 * Uses Node's built-in `node:sqlite` driver (no native build, no external
 * service) so `npm run dev` writes to a real database file that survives
 * restarts. It implements the exact same `DataLayer` contract as the in-memory
 * layer used by the tests, which is what makes them interchangeable.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// `node:sqlite` is a prefix-only builtin: it is absent from `module.builtinModules`
// (the list only contains `node:sqlite`, not `sqlite`), which makes bundler-based
// test runners try to resolve a bare `sqlite` specifier and fail. Loading it through
// `createRequire` keeps the import opaque to the toolchain while staying type-safe.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import type {
  ActivityLog,
  Archive,
  ArchiveStatus,
  CleanupRun,
  ExtensionRequest,
  FileRecord,
  Folder,
  JoinRequest,
  JobType,
  LifecycleJob,
  MemberRole,
  Notification,
  Profile,
  Space,
  SpaceInvitation,
  SpaceInviteLink,
  SpaceMember,
} from '@flashspace/shared';
import type {
  ScanJobRow,
  DuplicateGroupRow,
  DuplicateFileRow,
  ArchivePlanRow,
  ArchiveJobRow,
} from '../data-layer.interface.js';
import type {
  ActivityRepo,
  ArchivesRepo,
  AuthRepo,
  CleanupRunsRepo,
  DataLayer,
  DuplicateFilesRepo,
  DuplicateGroupsRepo,
  ExtensionRequestsRepo,
  FilesRepo,
  FoldersRepo,
  InvitationsRepo,
  InviteLinksRepo,
  JoinRequestsRepo,
  JobsRepo,
  LocalAccount,
  MembersRepo,
  NotificationBusLike,
  NotificationsRepo,
  ArchiveJobsRepo,
  ArchivePlansRepo,
  ScanJobsRepo,
  SpacesRepo,
} from '../data-layer.interface.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  expiry_at TEXT NOT NULL,
  status TEXT NOT NULL,
  warning_sent_at TEXT,
  archived_manually INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_owner_idx ON spaces(owner_id);
CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  joined_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user_idx ON members(user_id);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  email TEXT NOT NULL,
  intended_role TEXT NOT NULL,
  token_hash TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  invitation_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS extension_requests (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requested_days INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  folder_id TEXT,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT,
  sha256 TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS files_space_idx ON files(space_id);
CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT,
  file_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS archives_owner_idx ON archives(owner_id);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  space_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  invite_link_id TEXT,
  join_request_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  space_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  status TEXT NOT NULL,
  memberships_revoked INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  space_id TEXT,
  file_id TEXT,
  action TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Storage-insights tables (PRD §4). New in migration 002.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  duplicate_groups INTEGER NOT NULL DEFAULT 0,
  duplicate_file_count INTEGER NOT NULL DEFAULT 0,
  extra_copy_count INTEGER NOT NULL DEFAULT 0,
  potential_savings_bytes INTEGER NOT NULL DEFAULT 0,
  large_file_count INTEGER NOT NULL DEFAULT 0,
  near_duplicate_group_count INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT,
  failed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_jobs_space_idx ON scan_jobs(space_id);
CREATE INDEX IF NOT EXISTS scan_jobs_owner_idx ON scan_jobs(owner_id);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 1,
  extra_copy_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  potential_savings_bytes INTEGER NOT NULL DEFAULT 0,
  representative_name TEXT NOT NULL,
  UNIQUE(scan_id, content_hash)
);
CREATE INDEX IF NOT EXISTS duplicate_groups_scan_idx ON duplicate_groups(scan_id);

CREATE TABLE IF NOT EXISTS duplicate_files (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, file_id)
);
CREATE INDEX IF NOT EXISTS duplicate_files_group_idx ON duplicate_files(group_id);
CREATE INDEX IF NOT EXISTS duplicate_files_scan_idx ON duplicate_files(scan_id);

CREATE TABLE IF NOT EXISTS archive_plans (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scan_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  excluded_file_ids TEXT NOT NULL DEFAULT '',
  will_archive_file_count INTEGER NOT NULL DEFAULT 0,
  will_archive_bytes INTEGER NOT NULL DEFAULT 0,
  will_exclude_file_count INTEGER NOT NULL DEFAULT 0,
  will_exclude_bytes INTEGER NOT NULL DEFAULT 0,
  potential_savings_bytes INTEGER NOT NULL DEFAULT 0,
  explained INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  archive_job_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_plans_space_idx ON archive_plans(space_id);
CREATE INDEX IF NOT EXISTS archive_plans_owner_idx ON archive_plans(owner_id);

CREATE TABLE IF NOT EXISTS archive_jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES archive_plans(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  archive_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS archive_jobs_plan_idx ON archive_jobs(plan_id);
CREATE INDEX IF NOT EXISTS archive_jobs_owner_idx ON archive_jobs(owner_id);
`;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function mapProfile(r: Row): Profile {
  return {
    id: r.id as string,
    email: r.email as string,
    displayName: r.display_name as string,
    role: r.role as Profile['role'],
    avatarUrl: (r.avatar_url as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapSpace(r: Row): Space {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    name: r.name as string,
    purpose: r.purpose as string,
    description: (r.description as string) ?? '',
    startAt: r.start_at as string,
    expiryAt: r.expiry_at as string,
    status: r.status as Space['status'],
    warningSentAt: (r.warning_sent_at as string | null) ?? null,
    archivedManually: Number(r.archived_manually ?? 0) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapMember(r: Row): SpaceMember {
  return {
    spaceId: r.space_id as string,
    userId: r.user_id as string,
    role: r.role as MemberRole,
    status: r.status as SpaceMember['status'],
    joinedAt: (r.joined_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

function mapInvitation(r: Row): SpaceInvitation {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    inviterId: r.inviter_id as string,
    email: r.email as string,
    intendedRole: r.intended_role as MemberRole,
    tokenHash: (r.token_hash as string | null) ?? null,
    status: r.status as SpaceInvitation['status'],
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
  };
}

function mapInviteLink(r: Row): SpaceInviteLink {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    createdBy: r.created_by as string,
    token: r.token as string,
    role: r.role as MemberRole,
    createdAt: r.created_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

function mapJoinRequest(r: Row): JoinRequest {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    requesterId: r.requester_id as string,
    role: r.role as MemberRole,
    source: r.source as JoinRequest['source'],
    invitationId: (r.invitation_id as string | null) ?? null,
    status: r.status as JoinRequest['status'],
    createdAt: r.created_at as string,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
  };
}

function mapExtension(r: Row): ExtensionRequest {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    requesterId: r.requester_id as string,
    requestedDays: Number(r.requested_days),
    reason: r.reason as string,
    status: r.status as ExtensionRequest['status'],
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapFile(r: Row): FileRecord {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    folderId: (r.folder_id as string | null) ?? null,
    uploaderId: r.uploader_id as string,
    name: r.name as string,
    objectKey: r.object_key as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    etag: (r.etag as string | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    status: r.status as FileRecord['status'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    deletedAt: (r.deleted_at as string | null) ?? null,
  };
}

function mapArchive(r: Row): Archive {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    ownerId: r.owner_id as string,
    objectKey: r.object_key as string,
    sizeBytes: Number(r.size_bytes),
    checksum: (r.checksum as string | null) ?? null,
    fileCount: Number(r.file_count),
    status: r.status as ArchiveStatus,
    createdAt: r.created_at as string,
    verifiedAt: (r.verified_at as string | null) ?? null,
  };
}

function mapNotification(r: Row): Notification {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    spaceId: (r.space_id as string | null) ?? null,
    type: r.type as Notification['type'],
    title: r.title as string,
    body: r.body as string,
    inviteLinkId: (r.invite_link_id as string | null) ?? null,
    joinRequestId: (r.join_request_id as string | null) ?? null,
    readAt: (r.read_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapJob(r: Row): LifecycleJob {
  return {
    id: r.id as string,
    jobType: r.job_type as JobType,
    spaceId: (r.space_id as string | null) ?? null,
    idempotencyKey: r.idempotency_key as string,
    status: r.status as LifecycleJob['status'],
    attempts: Number(r.attempts),
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function mapCleanupRun(r: Row): CleanupRun {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    archiveId: r.archive_id as string,
    status: r.status as CleanupRun['status'],
    membershipsRevoked: Number(r.memberships_revoked),
    objectsDeleted: Number(r.objects_deleted),
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function mapActivity(r: Row): ActivityLog {
  return {
    id: Number(r.id),
    userId: (r.user_id as string | null) ?? null,
    spaceId: (r.space_id as string | null) ?? null,
    fileId: (r.file_id as string | null) ?? null,
    action: r.action as string,
    metadata: JSON.parse((r.metadata as string) || '{}') as Record<string, unknown>,
    createdAt: r.created_at as string,
  };
}

function mapScanJob(r: Row): ScanJobRow {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    ownerId: r.owner_id as string,
    status: r.status as string,
    totalFiles: Number(r.total_files),
    totalBytes: Number(r.total_bytes),
    duplicateGroups: Number(r.duplicate_groups),
    duplicateFileCount: Number(r.duplicate_file_count),
    extraCopyCount: Number(r.extra_copy_count),
    potentialSavingsBytes: Number(r.potential_savings_bytes),
    largeFileCount: Number(r.large_file_count),
    nearDuplicateGroupCount: Number(r.near_duplicate_group_count),
    scannedAt: (r.scanned_at as string | null) ?? null,
    failedAt: (r.failed_at as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapDuplicateGroup(r: Row): DuplicateGroupRow {
  return {
    id: r.id as string,
    scanId: r.scan_id as string,
    contentHash: r.content_hash as string,
    fileCount: Number(r.file_count),
    extraCopyCount: Number(r.extra_copy_count),
    totalBytes: Number(r.total_bytes),
    potentialSavingsBytes: Number(r.potential_savings_bytes),
    representativeName: r.representative_name as string,
  };
}

function mapDuplicateFile(r: Row): DuplicateFileRow {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    scanId: r.scan_id as string,
    fileId: r.file_id as string,
    name: r.name as string,
    objectKey: r.object_key as string,
    sizeBytes: Number(r.size_bytes),
    mimeType: r.mime_type as string,
    uploadedAt: r.uploaded_at as string,
    uploaderId: r.uploader_id as string,
    excluded: (r.excluded as number) === 1,
  };
}

function mapArchivePlan(r: Row): ArchivePlanRow {
  const raw = r.excluded_file_ids as string | null;
  const excludedFileIds = raw ? raw.split(',').filter(Boolean) : [];
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    ownerId: r.owner_id as string,
    scanId: (r.scan_id as string | null) ?? null,
    status: r.status as string,
    excludedFileIds,
    willArchiveFileCount: Number(r.will_archive_file_count),
    willArchiveBytes: Number(r.will_archive_bytes),
    willExcludeFileCount: Number(r.will_exclude_file_count),
    willExcludeBytes: Number(r.will_exclude_bytes),
    potentialSavingsBytes: Number(r.potential_savings_bytes),
    explained: (r.explained as number) === 1,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
    archiveJobId: (r.archive_job_id as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapArchiveJob(r: Row): ArchiveJobRow {
  return {
    id: r.id as string,
    planId: r.plan_id as string,
    spaceId: r.space_id as string,
    ownerId: r.owner_id as string,
    idempotencyKey: r.idempotency_key as string,
    status: r.status as string,
    attempts: Number(r.attempts),
    archiveId: (r.archive_id as string | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

/** Publishes notifications to in-process subscribers (SSE hooks, tests). */
class SqliteNotificationBus implements NotificationBusLike {
  private readonly listeners = new Map<string, Set<(n: Notification) => void>>();

  subscribe(userId: string, fn: (n: Notification) => void): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(fn);
    this.listeners.set(userId, set);
    return () => set.delete(fn);
  }

  publish(userId: string, notification: Notification): void {
    this.listeners.get(userId)?.forEach((fn) => fn(notification));
  }
}

export class SqliteDataLayer implements DataLayer {
  readonly file: string;
  private readonly db: DatabaseSyncType;

  readonly auth: AuthRepo;
  readonly spaces: SpacesRepo;
  readonly members: MembersRepo;
  readonly folders: FoldersRepo;
  readonly invitations: InvitationsRepo;
  readonly inviteLinks: InviteLinksRepo;
  readonly joinRequests: JoinRequestsRepo;
  readonly extensionRequests: ExtensionRequestsRepo;
  readonly files: FilesRepo;
  readonly archives: ArchivesRepo;
  readonly notifications: NotificationsRepo;
  readonly jobs: JobsRepo;
  readonly cleanupRuns: CleanupRunsRepo;
  readonly activity: ActivityRepo;
  readonly scanJobs: ScanJobsRepo;
  readonly duplicateGroups: DuplicateGroupsRepo;
  readonly duplicateFiles: DuplicateFilesRepo;
  readonly archivePlans: ArchivePlansRepo;
  readonly archiveJobs: ArchiveJobsRepo;
  readonly notificationBus = new SqliteNotificationBus();

  constructor(file = './data/flashspace.db') {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();

    const run = (sql: string, ...params: (string | number | null)[]) => {
      this.db.prepare(sql).run(...params);
    };
    const get = (sql: string, ...params: (string | number | null)[]): Row | undefined =>
      this.db.prepare(sql).get(...params) as Row | undefined;
    const all = (sql: string, ...params: (string | number | null)[]): Row[] =>
      this.db.prepare(sql).all(...params) as Row[];

    this.auth = {
      create(profile, passwordHash): Profile {
        run(
          'INSERT INTO profiles (id, email, display_name, role, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          profile.id,
          profile.email,
          profile.displayName,
          profile.role,
          profile.avatarUrl,
          profile.createdAt,
          profile.updatedAt,
        );
        run('INSERT INTO credentials (user_id, password_hash) VALUES (?,?)', profile.id, passwordHash);
        return profile;
      },
      findById: (id) => {
        const row = get('SELECT * FROM profiles WHERE id = ?', id);
        return row ? mapProfile(row) : undefined;
      },
      findByEmail: (email) => {
        const row = get('SELECT * FROM profiles WHERE email = ?', email.toLowerCase());
        return row ? mapProfile(row) : undefined;
      },
      getCredentials: (id): LocalAccount | undefined => {
        const row = get(
          'SELECT p.*, c.password_hash FROM profiles p JOIN credentials c ON c.user_id = p.id WHERE p.id = ?',
          id,
        );
        return row ? { profile: mapProfile(row), passwordHash: row.password_hash as string } : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM profiles WHERE id = ?', id);
        if (!current) return undefined;
        const next = {
          displayName: patch.displayName ?? (current.display_name as string),
          avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : (current.avatar_url as string | null),
          updatedAt: now(),
        };
        run(
          'UPDATE profiles SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?',
          next.displayName,
          next.avatarUrl,
          next.updatedAt,
          id,
        );
        // mapProfile reads snake_case columns, so translate the patch back.
        return mapProfile({
          ...current,
          display_name: next.displayName,
          avatar_url: next.avatarUrl,
          updated_at: next.updatedAt,
        });
      },
      promoteToAdmin: (id) => {
        run('UPDATE profiles SET role = ?, updated_at = ? WHERE id = ?', 'ADMIN', now(), id);
      },
      count: () => Number(get('SELECT COUNT(*) AS c FROM profiles')?.c ?? 0),
      all: () =>
        all('SELECT * FROM profiles ORDER BY created_at ASC').map(mapProfile),
    };

    this.spaces = {
      insert: (space) => {
        run(
          `INSERT INTO spaces (id, owner_id, name, purpose, description, start_at, expiry_at, status,
            warning_sent_at, archived_manually, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          space.id,
          space.ownerId,
          space.name,
          space.purpose,
          space.description,
          space.startAt,
          space.expiryAt,
          space.status,
          space.warningSentAt,
          space.archivedManually ? 1 : 0,
          space.createdAt,
          space.updatedAt,
        );
        return space;
      },
      findById: (id) => {
        const row = get('SELECT * FROM spaces WHERE id = ?', id);
        return row ? mapSpace(row) : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM spaces WHERE id = ?', id);
        if (!current) return undefined;
        const next: Space = { ...mapSpace(current), ...patch, updatedAt: now() };
        run(
          `UPDATE spaces SET owner_id=?, name=?, purpose=?, description=?, start_at=?, expiry_at=?,
            status=?, warning_sent_at=?, archived_manually=?, updated_at=? WHERE id=?`,
          next.ownerId,
          next.name,
          next.purpose,
          next.description,
          next.startAt,
          next.expiryAt,
          next.status,
          next.warningSentAt,
          next.archivedManually ? 1 : 0,
          next.updatedAt,
          id,
        );
        return next;
      },
      list: () => all('SELECT * FROM spaces ORDER BY created_at DESC').map(mapSpace),
      listForUser: (userId) =>
        all(
          `SELECT DISTINCT s.* FROM spaces s LEFT JOIN members m ON m.space_id = s.id
           WHERE s.owner_id = ? OR (m.user_id = ? AND m.status <> 'REVOKED')
           ORDER BY s.created_at DESC`,
          userId,
          userId,
        ).map(mapSpace),
    };

    this.members = {
      insert: (member) => {
        run(
          'INSERT INTO members (space_id, user_id, role, status, joined_at, revoked_at) VALUES (?,?,?,?,?,?)',
          member.spaceId,
          member.userId,
          member.role,
          member.status,
          member.joinedAt,
          member.revokedAt,
        );
        return member;
      },
      find: (spaceId, userId) => {
        const row = get('SELECT * FROM members WHERE space_id = ? AND user_id = ?', spaceId, userId);
        return row ? mapMember(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM members WHERE space_id = ? ORDER BY joined_at ASC', spaceId).map(mapMember),
      listForUser: (userId) =>
        all("SELECT * FROM members WHERE user_id = ? AND status <> 'REVOKED'", userId).map(mapMember),
      update: (spaceId, userId, patch) => {
        const current = get('SELECT * FROM members WHERE space_id = ? AND user_id = ?', spaceId, userId);
        if (!current) return undefined;
        const next: SpaceMember = { ...mapMember(current), ...patch };
        run(
          'UPDATE members SET role=?, status=?, joined_at=?, revoked_at=? WHERE space_id=? AND user_id=?',
          next.role,
          next.status,
          next.joinedAt,
          next.revokedAt,
          spaceId,
          userId,
        );
        return next;
      },
      revokeAllForSpace: (spaceId) => {
        const res = this.db
          .prepare("UPDATE members SET status='REVOKED', revoked_at=? WHERE space_id=? AND status<>'REVOKED'")
          .run(now(), spaceId);
        return Number(res.changes);
      },
      countByRole: (spaceId, role) =>
        Number(
          get(
            "SELECT COUNT(*) AS c FROM members WHERE space_id=? AND role=? AND status='ACTIVE'",
            spaceId,
            role,
          )?.c ?? 0,
        ),
    };

    this.folders = {
      insert: (folder) => {
        run(
          'INSERT INTO folders (id, space_id, parent_id, name, path, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          folder.id,
          folder.spaceId,
          folder.parentId,
          folder.name,
          folder.path,
          folder.createdAt,
          folder.updatedAt,
        );
        return folder;
      },
      findById: (id) => {
        const row = get('SELECT * FROM folders WHERE id = ?', id);
        return row
          ? ({
              id: row.id as string,
              spaceId: row.space_id as string,
              parentId: (row.parent_id as string | null) ?? null,
              name: row.name as string,
              path: row.path as string,
              createdAt: row.created_at as string,
              updatedAt: row.updated_at as string,
            } satisfies Folder)
          : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM folders WHERE space_id = ?', spaceId).map(
          (row) =>
            ({
              id: row.id as string,
              spaceId: row.space_id as string,
              parentId: (row.parent_id as string | null) ?? null,
              name: row.name as string,
              path: row.path as string,
              createdAt: row.created_at as string,
              updatedAt: row.updated_at as string,
            }) satisfies Folder,
        ),
      update: (id, patch) => {
        const current = get('SELECT * FROM folders WHERE id = ?', id);
        if (!current) return undefined;
        const next = {
          parentId: patch.parentId !== undefined ? patch.parentId : (current.parent_id as string | null),
          name: patch.name ?? (current.name as string),
          path: patch.path ?? (current.path as string),
          updatedAt: now(),
        };
        run(
          'UPDATE folders SET parent_id=?, name=?, path=?, updated_at=? WHERE id=?',
          next.parentId,
          next.name,
          next.path,
          next.updatedAt,
          id,
        );
        return this.folders.findById(id);
      },
    };

    this.invitations = {
      insert: (inv) => {
        run(
          `INSERT INTO invitations (id, space_id, inviter_id, email, intended_role, token_hash, status, expires_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          inv.id,
          inv.spaceId,
          inv.inviterId,
          inv.email.toLowerCase(),
          inv.intendedRole,
          inv.tokenHash,
          inv.status,
          inv.expiresAt,
          inv.createdAt,
        );
        return inv;
      },
      findById: (id) => {
        const row = get('SELECT * FROM invitations WHERE id = ?', id);
        return row ? mapInvitation(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM invitations WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(mapInvitation),
      findBySpaceAndEmail: (spaceId, email) => {
        const row = get(
          "SELECT * FROM invitations WHERE space_id = ? AND email = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1",
          spaceId,
          email.toLowerCase(),
        );
        return row ? mapInvitation(row) : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM invitations WHERE id = ?', id);
        if (!current) return undefined;
        const next: SpaceInvitation = { ...mapInvitation(current), ...patch };
        run(
          'UPDATE invitations SET intended_role=?, token_hash=?, status=?, expires_at=? WHERE id=?',
          next.intendedRole,
          next.tokenHash,
          next.status,
          next.expiresAt,
          id,
        );
        return next;
      },
    };

    this.inviteLinks = {
      insert: (link) => {
        run(
          'INSERT INTO invite_links (id, space_id, created_by, token, role, created_at, revoked_at) VALUES (?,?,?,?,?,?,?)',
          link.id,
          link.spaceId,
          link.createdBy,
          link.token,
          link.role,
          link.createdAt,
          link.revokedAt,
        );
        return link;
      },
      findById: (id) => {
        const row = get('SELECT * FROM invite_links WHERE id = ?', id);
        return row ? mapInviteLink(row) : undefined;
      },
      findByToken: (token) => {
        const row = get('SELECT * FROM invite_links WHERE token = ?', token);
        return row ? mapInviteLink(row) : undefined;
      },
      findActiveForSpace: (spaceId) => {
        const row = get(
          'SELECT * FROM invite_links WHERE space_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
          spaceId,
        );
        return row ? mapInviteLink(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM invite_links WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(mapInviteLink),
      update: (id, patch) => {
        const current = get('SELECT * FROM invite_links WHERE id = ?', id);
        if (!current) return undefined;
        const next: SpaceInviteLink = { ...mapInviteLink(current), ...patch };
        run('UPDATE invite_links SET role=?, revoked_at=? WHERE id=?', next.role, next.revokedAt, id);
        return next;
      },
    };

    this.joinRequests = {
      insert: (request) => {
        run(
          `INSERT INTO join_requests (id, space_id, requester_id, role, source, invitation_id, status, created_at, decided_by, decided_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          request.id,
          request.spaceId,
          request.requesterId,
          request.role,
          request.source,
          request.invitationId,
          request.status,
          request.createdAt,
          request.decidedBy,
          request.decidedAt,
        );
        return request;
      },
      findById: (id) => {
        const row = get('SELECT * FROM join_requests WHERE id = ?', id);
        return row ? mapJoinRequest(row) : undefined;
      },
      listForSpace: (spaceId, status) =>
        status
          ? all(
              'SELECT * FROM join_requests WHERE space_id = ? AND status = ? ORDER BY created_at DESC',
              spaceId,
              status,
            ).map(mapJoinRequest)
          : all('SELECT * FROM join_requests WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(mapJoinRequest),
      listForRequester: (requesterId) =>
        all('SELECT * FROM join_requests WHERE requester_id = ? ORDER BY created_at DESC', requesterId).map(
          mapJoinRequest,
        ),
      findPendingForUser: (spaceId, requesterId) => {
        const row = get(
          "SELECT * FROM join_requests WHERE space_id = ? AND requester_id = ? AND status = 'PENDING' LIMIT 1",
          spaceId,
          requesterId,
        );
        return row ? mapJoinRequest(row) : undefined;
      },
      findOpenForInvitation: (invitationId) => {
        const row = get(
          "SELECT * FROM join_requests WHERE invitation_id = ? AND status = 'PENDING' LIMIT 1",
          invitationId,
        );
        return row ? mapJoinRequest(row) : undefined;
      },
      listAll: () =>
        all('SELECT * FROM join_requests ORDER BY created_at DESC').map(mapJoinRequest),
      update: (id, patch) => {
        const current = get('SELECT * FROM join_requests WHERE id = ?', id);
        if (!current) return undefined;
        const next: JoinRequest = { ...mapJoinRequest(current), ...patch };
        run(
          'UPDATE join_requests SET role=?, status=?, decided_by=?, decided_at=? WHERE id=?',
          next.role,
          next.status,
          next.decidedBy,
          next.decidedAt,
          id,
        );
        return next;
      },
    };

    this.extensionRequests = {
      insert: (req) => {
        run(
          `INSERT INTO extension_requests (id, space_id, requester_id, requested_days, reason, status, decided_by, decided_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          req.id,
          req.spaceId,
          req.requesterId,
          req.requestedDays,
          req.reason,
          req.status,
          req.decidedBy,
          req.decidedAt,
          req.createdAt,
        );
        return req;
      },
      findById: (id) => {
        const row = get('SELECT * FROM extension_requests WHERE id = ?', id);
        return row ? mapExtension(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM extension_requests WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(
          mapExtension,
        ),
      listAll: () =>
        all('SELECT * FROM extension_requests ORDER BY created_at DESC').map(mapExtension),
      findPendingForSpace: (spaceId) => {
        const row = get(
          "SELECT * FROM extension_requests WHERE space_id = ? AND status = 'PENDING' LIMIT 1",
          spaceId,
        );
        return row ? mapExtension(row) : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM extension_requests WHERE id = ?', id);
        if (!current) return undefined;
        const next: ExtensionRequest = { ...mapExtension(current), ...patch };
        run(
          'UPDATE extension_requests SET status=?, decided_by=?, decided_at=?, requested_days=?, reason=? WHERE id=?',
          next.status,
          next.decidedBy,
          next.decidedAt,
          next.requestedDays,
          next.reason,
          id,
        );
        return next;
      },
    };

    this.files = {
      insert: (file) => {
        run(
          `INSERT INTO files (id, space_id, folder_id, uploader_id, name, object_key, mime_type, size_bytes,
            etag, sha256, status, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          file.id,
          file.spaceId,
          file.folderId,
          file.uploaderId,
          file.name,
          file.objectKey,
          file.mimeType,
          file.sizeBytes,
          file.etag,
          file.sha256,
          file.status,
          file.createdAt,
          file.updatedAt,
          file.deletedAt,
        );
        return file;
      },
      findById: (id) => {
        const row = get('SELECT * FROM files WHERE id = ?', id);
        return row ? mapFile(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM files WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(mapFile),
      listAll: () => all('SELECT * FROM files ORDER BY created_at DESC').map(mapFile),
      listActiveForSpace: (spaceId) =>
        all("SELECT * FROM files WHERE space_id = ? AND status <> 'DELETED' ORDER BY created_at DESC", spaceId).map(
          mapFile,
        ),
      findByObjectKey: (objectKey) => {
        const row = get('SELECT * FROM files WHERE object_key = ?', objectKey);
        return row ? mapFile(row) : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM files WHERE id = ?', id);
        if (!current) return undefined;
        const next: FileRecord = { ...mapFile(current), ...patch, updatedAt: now() };
        run(
          `UPDATE files SET name=?, folder_id=?, mime_type=?, size_bytes=?, etag=?, sha256=?, status=?,
            updated_at=?, deleted_at=? WHERE id=?`,
          next.name,
          next.folderId,
          next.mimeType,
          next.sizeBytes,
          next.etag,
          next.sha256,
          next.status,
          next.updatedAt,
          next.deletedAt,
          id,
        );
        return next;
      },
      usedBytesForSpace: (spaceId) =>
        Number(
          get(
            "SELECT COALESCE(SUM(size_bytes),0) AS total FROM files WHERE space_id = ? AND status <> 'DELETED'",
            spaceId,
          )?.total ?? 0,
        ),
    };

    this.archives = {
      insert: (archive) => {
        run(
          `INSERT INTO archives (id, space_id, owner_id, object_key, size_bytes, checksum, file_count, status, created_at, verified_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          archive.id,
          archive.spaceId,
          archive.ownerId,
          archive.objectKey,
          archive.sizeBytes,
          archive.checksum,
          archive.fileCount,
          archive.status,
          archive.createdAt,
          archive.verifiedAt,
        );
        return archive;
      },
      findById: (id) => {
        const row = get('SELECT * FROM archives WHERE id = ?', id);
        return row ? mapArchive(row) : undefined;
      },
      listForOwner: (ownerId) =>
        all('SELECT * FROM archives WHERE owner_id = ? ORDER BY created_at DESC', ownerId).map(mapArchive),
      listByStatus: (status) =>
        all('SELECT * FROM archives WHERE status = ? ORDER BY created_at DESC', status).map(mapArchive),
      listForSpace: (spaceId) =>
        all('SELECT * FROM archives WHERE space_id = ? ORDER BY created_at DESC', spaceId).map(mapArchive),
      listAll: () => all('SELECT * FROM archives ORDER BY created_at DESC').map(mapArchive),
      update: (id, patch) => {
        const current = get('SELECT * FROM archives WHERE id = ?', id);
        if (!current) return undefined;
        const next: Archive = { ...mapArchive(current), ...patch };
        run(
          'UPDATE archives SET object_key=?, size_bytes=?, checksum=?, file_count=?, status=?, verified_at=? WHERE id=?',
          next.objectKey,
          next.sizeBytes,
          next.checksum,
          next.fileCount,
          next.status,
          next.verifiedAt,
          id,
        );
        return next;
      },
    };

    this.notifications = {
      insert: (n) => {
        run(
          `INSERT INTO notifications (id, user_id, space_id, type, title, body, invite_link_id, join_request_id, read_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          n.id,
          n.userId,
          n.spaceId,
          n.type,
          n.title,
          n.body,
          n.inviteLinkId,
          n.joinRequestId,
          n.readAt,
          n.createdAt,
        );
        return n;
      },
      listForUser: (userId) =>
        all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', userId).map(mapNotification),
      findById: (id) => {
        const row = get('SELECT * FROM notifications WHERE id = ?', id);
        return row ? mapNotification(row) : undefined;
      },
      markRead: (id) => {
        const current = get('SELECT * FROM notifications WHERE id = ?', id);
        if (!current) return undefined;
        if (!current.read_at) run('UPDATE notifications SET read_at = ? WHERE id = ?', now(), id);
        const row = get('SELECT * FROM notifications WHERE id = ?', id);
        return row ? mapNotification(row) : undefined;
      },
      markAllRead: (userId) => {
        const res = this.db
          .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
          .run(now(), userId);
        return Number(res.changes);
      },
    };

    this.jobs = {
      insert: (job) => {
        run(
          `INSERT INTO jobs (id, job_type, space_id, idempotency_key, status, attempts, started_at, finished_at, error)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          job.id,
          job.jobType,
          job.spaceId,
          job.idempotencyKey,
          job.status,
          job.attempts,
          job.startedAt,
          job.finishedAt,
          job.error,
        );
        return job;
      },
      findById: (id) => {
        const row = get('SELECT * FROM jobs WHERE id = ?', id);
        return row ? mapJob(row) : undefined;
      },
      findByIdempotencyKey: (key) => {
        const row = get('SELECT * FROM jobs WHERE idempotency_key = ?', key);
        return row ? mapJob(row) : undefined;
      },
      claimNext: (jobType) => {
        const row = get(
          "SELECT * FROM jobs WHERE job_type = ? AND status = 'PENDING' ORDER BY started_at ASC LIMIT 1",
          jobType,
        );
        if (!row) return undefined;
        const job = mapJob(row);
        run(
          "UPDATE jobs SET status='RUNNING', attempts = ?, started_at = ? WHERE id = ?",
          job.attempts + 1,
          now(),
          job.id,
        );
        return this.jobs.findById(job.id);
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM jobs WHERE id = ?', id);
        if (!current) return undefined;
        const next: LifecycleJob = { ...mapJob(current), ...patch };
        run(
          'UPDATE jobs SET status=?, attempts=?, started_at=?, finished_at=?, error=? WHERE id=?',
          next.status,
          next.attempts,
          next.startedAt,
          next.finishedAt,
          next.error,
          id,
        );
        return next;
      },
      finish: (id, patch) => this.jobs.update(id, { ...patch, finishedAt: now() }),
      list: (limit = 50) =>
        all('SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?', limit).map(mapJob),
    };

    this.cleanupRuns = {
      insert: (runRecord) => {
        run(
          `INSERT INTO cleanup_runs (id, space_id, archive_id, status, memberships_revoked, objects_deleted, started_at, finished_at, error)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          runRecord.id,
          runRecord.spaceId,
          runRecord.archiveId,
          runRecord.status,
          runRecord.membershipsRevoked,
          runRecord.objectsDeleted,
          runRecord.startedAt,
          runRecord.finishedAt,
          runRecord.error,
        );
        return runRecord;
      },
      findById: (id) => {
        const row = get('SELECT * FROM cleanup_runs WHERE id = ?', id);
        return row ? mapCleanupRun(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM cleanup_runs WHERE space_id = ? ORDER BY started_at DESC', spaceId).map(mapCleanupRun),
    };

    this.activity = {
      append: (log) => {
        const res = this.db
          .prepare(
            'INSERT INTO activity (user_id, space_id, file_id, action, metadata, created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            log.userId,
            log.spaceId,
            log.fileId,
            log.action,
            JSON.stringify(log.metadata ?? {}),
            now(),
          );
        const row = get('SELECT * FROM activity WHERE id = ?', Number(res.lastInsertRowid));
        return mapActivity(row!);
      },
      listForSpace: (spaceId, limit = 100) =>
        all('SELECT * FROM activity WHERE space_id = ? ORDER BY id DESC LIMIT ?', spaceId, limit).map(mapActivity),
      listAll: (limit = 200) =>
        all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit).map(mapActivity),
    };

    // ---- Storage-insights repos (PRD §4) ----

    this.scanJobs = {
      insert: (job) => {
        run(
          `INSERT INTO scan_jobs
            (id, space_id, owner_id, status, total_files, total_bytes, duplicate_groups,
             duplicate_file_count, extra_copy_count, potential_savings_bytes, large_file_count,
             near_duplicate_group_count, scanned_at, failed_at, error_message, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          job.id,
          job.spaceId,
          job.ownerId,
          job.status,
          job.totalFiles,
          job.totalBytes,
          job.duplicateGroups,
          job.duplicateFileCount,
          job.extraCopyCount,
          job.potentialSavingsBytes,
          job.largeFileCount,
          job.nearDuplicateGroupCount,
          job.scannedAt,
          job.failedAt,
          job.errorMessage,
          job.createdAt,
          job.updatedAt,
        );
        return job;
      },
      findById: (id) => {
        const row = get('SELECT * FROM scan_jobs WHERE id = ?', id);
        return row ? mapScanJob(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM scan_jobs WHERE space_id = ? ORDER BY updated_at DESC', spaceId).map(mapScanJob),
      update: (id, patch) => {
        const current = get('SELECT * FROM scan_jobs WHERE id = ?', id);
        if (!current) return undefined;
        const next = { ...mapScanJob(current), ...patch, updatedAt: now() };
        run(
          `UPDATE scan_jobs SET status=?, total_files=?, total_bytes=?, duplicate_groups=?,
             duplicate_file_count=?, extra_copy_count=?, potential_savings_bytes=?,
             large_file_count=?, near_duplicate_group_count=?, scanned_at=?, failed_at=?,
             error_message=?, updated_at=? WHERE id=?`,
          next.status,
          next.totalFiles,
          next.totalBytes,
          next.duplicateGroups,
          next.duplicateFileCount,
          next.extraCopyCount,
          next.potentialSavingsBytes,
          next.largeFileCount,
          next.nearDuplicateGroupCount,
          next.scannedAt,
          next.failedAt,
          next.errorMessage,
          next.updatedAt,
          id,
        );
        return mapScanJob({ ...current, ...next });
      },
    };

    this.duplicateGroups = {
      insert: (group) => {
        run(
          `INSERT INTO duplicate_groups (id, scan_id, content_hash, file_count, extra_copy_count,
           total_bytes, potential_savings_bytes, representative_name)
           VALUES (?,?,?,?,?,?,?,?)`,
          group.id,
          group.scanId,
          group.contentHash,
          group.fileCount,
          group.extraCopyCount,
          group.totalBytes,
          group.potentialSavingsBytes,
          group.representativeName,
        );
        return group;
      },
      findById: (id) => {
        const row = get('SELECT * FROM duplicate_groups WHERE id = ?', id);
        return row ? mapDuplicateGroup(row) : undefined;
      },
      listForScan: (scanId) =>
        all('SELECT * FROM duplicate_groups WHERE scan_id = ? ORDER BY total_bytes DESC', scanId).map(mapDuplicateGroup),
      deleteForScan: (scanId) => {
        run('DELETE FROM duplicate_files WHERE scan_id = ?', scanId);
        run('DELETE FROM duplicate_groups WHERE scan_id = ?', scanId);
      },
    };

    this.duplicateFiles = {
      insert: (row) => {
        run(
          `INSERT INTO duplicate_files (id, group_id, scan_id, file_id, name, object_key,
           size_bytes, mime_type, uploaded_at, uploader_id, excluded)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          row.id,
          row.groupId,
          row.scanId,
          row.fileId,
          row.name,
          row.objectKey,
          row.sizeBytes,
          row.mimeType,
          row.uploadedAt,
          row.uploaderId,
          row.excluded ? 1 : 0,
        );
        return row;
      },
      findById: (id) => {
        const row = get('SELECT * FROM duplicate_files WHERE id = ?', id);
        return row ? mapDuplicateFile(row) : undefined;
      },
      listForGroup: (groupId) =>
        all('SELECT * FROM duplicate_files WHERE group_id = ?', groupId).map(mapDuplicateFile),
      listAll: () => all('SELECT * FROM duplicate_files').map(mapDuplicateFile),
      deleteForGroup: (groupId) => run('DELETE FROM duplicate_files WHERE group_id = ?', groupId),
      deleteForScan: (scanId) => run('DELETE FROM duplicate_files WHERE scan_id = ?', scanId),
    };

    this.archivePlans = {
      insert: (plan) => {
        run(
          `INSERT INTO archive_plans
            (id, space_id, owner_id, scan_id, status, excluded_file_ids,
             will_archive_file_count, will_archive_bytes, will_exclude_file_count,
             will_exclude_bytes, potential_savings_bytes, explained, confirmed_at,
             archive_job_id, error_message, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          plan.id,
          plan.spaceId,
          plan.ownerId,
          plan.scanId,
          plan.status,
          plan.excludedFileIds.join(','),
          plan.willArchiveFileCount,
          plan.willArchiveBytes,
          plan.willExcludeFileCount,
          plan.willExcludeBytes,
          plan.potentialSavingsBytes,
          plan.explained ? 1 : 0,
          plan.confirmedAt,
          plan.archiveJobId,
          plan.errorMessage,
          plan.createdAt,
          plan.updatedAt,
        );
        return plan;
      },
      findById: (id) => {
        const row = get('SELECT * FROM archive_plans WHERE id = ?', id);
        return row ? mapArchivePlan(row) : undefined;
      },
      listForSpace: (spaceId) =>
        all('SELECT * FROM archive_plans WHERE space_id = ? ORDER BY updated_at DESC', spaceId).map(mapArchivePlan),
      update: (id, patch) => {
        const current = get('SELECT * FROM archive_plans WHERE id = ?', id);
        if (!current) return undefined;
        const next = { ...mapArchivePlan(current), ...patch, updatedAt: now() };
        run(
          `UPDATE archive_plans SET status=?, scan_id=?, excluded_file_ids=?,
             will_archive_file_count=?, will_archive_bytes=?, will_exclude_file_count=?,
             will_exclude_bytes=?, potential_savings_bytes=?, explained=?,
             confirmed_at=?, archive_job_id=?, error_message=?, updated_at=?
           WHERE id=?`,
          next.status,
          next.scanId,
          Array.isArray(next.excludedFileIds) ? next.excludedFileIds.join(',') : next.excludedFileIds,
          next.willArchiveFileCount,
          next.willArchiveBytes,
          next.willExcludeFileCount,
          next.willExcludeBytes,
          next.potentialSavingsBytes,
          next.explained ? 1 : 0,
          next.confirmedAt,
          next.archiveJobId,
          next.errorMessage,
          next.updatedAt,
          id,
        );
        return mapArchivePlan({ ...current, ...next });
      },
      deleteForSpace: (spaceId) => {
        run('DELETE FROM archive_plans WHERE space_id = ?', spaceId);
      },
    };

    this.archiveJobs = {
      insert: (job) => {
        run(
          `INSERT INTO archive_jobs (id, plan_id, space_id, owner_id, idempotency_key,
           status, attempts, archive_id, started_at, finished_at, error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          job.id,
          job.planId,
          job.spaceId,
          job.ownerId,
          job.idempotencyKey,
          job.status,
          job.attempts,
          job.archiveId,
          job.startedAt,
          job.finishedAt,
          job.error,
        );
        return job;
      },
      findById: (id) => {
        const row = get('SELECT * FROM archive_jobs WHERE id = ?', id);
        return row ? mapArchiveJob(row) : undefined;
      },
      findByPlanId: (planId) => {
        const row = get('SELECT * FROM archive_jobs WHERE plan_id = ?', planId);
        return row ? mapArchiveJob(row) : undefined;
      },
      findByIdempotencyKey: (key) => {
        const row = get('SELECT * FROM archive_jobs WHERE idempotency_key = ?', key);
        return row ? mapArchiveJob(row) : undefined;
      },
      update: (id, patch) => {
        const current = get('SELECT * FROM archive_jobs WHERE id = ?', id);
        if (!current) return undefined;
        const next = { ...mapArchiveJob(current), ...patch };
        run(
          `UPDATE archive_jobs SET status=?, attempts=?, archive_id=?, finished_at=?, error=? WHERE id=?`,
          next.status,
          next.attempts,
          next.archiveId,
          next.finishedAt,
          next.error,
          id,
        );
        return mapArchiveJob({ ...current, ...next });
      },
    };
  }

  /**
   * Applies migration 002 to an existing database file.
   *
   * New tables are created by SCHEMA (IF NOT EXISTS). Columns added to tables
   * that already existed (`files.sha256`, `archives.checksum`) need an explicit
   * ALTER on databases created before this feature, so they are added here when
   * missing. Safe to run on every startup.
   */
  migrate(): void {
    const columns = (table: string): Set<string> => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    };

    const fileColumns = columns('files');
    if (!fileColumns.has('sha256')) {
      this.db.exec('ALTER TABLE files ADD COLUMN sha256 TEXT');
    }

    const archiveColumns = columns('archives');
    if (!archiveColumns.has('checksum')) {
      this.db.exec('ALTER TABLE archives ADD COLUMN checksum TEXT');
    }
  }

  /** Closes the underlying database file (tests + graceful shutdown). */
  close(): void {
    this.db.close();
  }
}
