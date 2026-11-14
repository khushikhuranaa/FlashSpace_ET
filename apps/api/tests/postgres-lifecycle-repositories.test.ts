import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Archive, CleanupRun, LifecycleJob, LifecycleTransition, Profile, Space } from '@flashspace/shared';
import { loadEnv } from '../src/config/env.js';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';
import {
  createPostgresCoreRepositories,
  type PostgresCoreRepositories,
} from '../src/repositories/postgres/core.js';
import type { ArchiveJobRow, ArchivePlanRow, DuplicateFileRow, DuplicateGroupRow, ScanJobRow } from '../src/repositories/data-layer.interface.js';
import { migrateDatabase } from '../src/repositories/postgres/migrate.js';
import {
  createDisposableDatabase,
  postgresTestUrl,
  type DisposableDatabase,
} from './helpers/postgres.js';

const baseUrl = postgresTestUrl();
const describePg = baseUrl ? describe : describe.skip;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const T3 = '2026-01-04T00:00:00.000Z';

function profile(id: string, email: string): Profile {
  return {
    id,
    email,
    displayName: `User ${id}`,
    role: 'USER',
    avatarUrl: null,
    createdAt: T0,
    updatedAt: T0,
    status: 'ACTIVE',
  };
}

function space(id: string, ownerId: string): Space {
  return {
    id,
    ownerId,
    name: `Space ${id}`,
    purpose: 'Testing',
    description: '',
    startAt: T0,
    expiryAt: T3,
    status: 'ACTIVE',
    warningSentAt: null,
    archivedManually: false,
    invitationsEnabled: true,
    defaultInviteRole: 'VIEWER',
    createdAt: T0,
    updatedAt: T0,
  };
}

function archive(id: string, spaceId: string, ownerId: string, patch: Partial<Archive> = {}): Archive {
  return {
    id,
    spaceId,
    ownerId,
    objectKey: `vault/${spaceId}/${id}.zip`,
    sizeBytes: 100,
    checksum: null,
    fileCount: 1,
    status: 'PENDING',
    createdAt: T0,
    verifiedAt: null,
    ...patch,
  };
}

function job(id: string, spaceId: string | null, patch: Partial<LifecycleJob> = {}): LifecycleJob {
  return {
    id,
    jobType: 'LIFECYCLE',
    spaceId,
    idempotencyKey: `key-${id}`,
    status: 'PENDING',
    attempts: 0,
    startedAt: T0,
    finishedAt: null,
    error: null,
    ...patch,
  };
}

function scan(id: string, spaceId: string, ownerId: string): ScanJobRow {
  return {
    id,
    spaceId,
    ownerId,
    status: 'PENDING',
    totalFiles: 0,
    totalBytes: 0,
    duplicateGroups: 0,
    duplicateFileCount: 0,
    extraCopyCount: 0,
    potentialSavingsBytes: 0,
    largeFileCount: 0,
    nearDuplicateGroupCount: 0,
    scannedAt: null,
    failedAt: null,
    errorMessage: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

function group(id: string, scanId: string, patch: Partial<DuplicateGroupRow> = {}): DuplicateGroupRow {
  return {
    id,
    scanId,
    contentHash: `hash-${id}`,
    fileCount: 2,
    extraCopyCount: 1,
    totalBytes: 20,
    potentialSavingsBytes: 10,
    representativeName: 'a.txt',
    ...patch,
  };
}

describePg('postgres lifecycle and storage repositories', () => {
  let db: DisposableDatabase;
  let pool: Pool;
  let repos: PostgresCoreRepositories;

  beforeAll(async () => {
    db = await createDisposableDatabase(baseUrl!);
    await migrateDatabase(db.url);
    pool = new Pool({ connectionString: db.url, max: 6 });
    repos = createPostgresCoreRepositories(
      loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
      pool,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  beforeEach(async () => {
    await pool.query('truncate table profiles cascade');
    await repos.auth.create(profile('owner', 'owner@example.test'), 'h');
    await repos.auth.create(profile('member', 'member@example.test'), 'h');
    await repos.spaces.insert(space('s1', 'owner'));
  });

  async function seedArchive(id = 'a1') {
    await repos.archives.insert(archive(id, 's1', 'owner'));
  }

  async function seedFile(id = 'file1') {
    await repos.files.insert({
      id,
      spaceId: 's1',
      folderId: null,
      uploaderId: 'owner',
      name: `${id}.txt`,
      objectKey: `s1/${id}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 10,
      etag: null,
      sha256: null,
      status: 'ACTIVE',
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    });
  }

  describe('archives', () => {
    it('persists verification metadata and lists by owner, status, Space and all', async () => {
      await seedArchive('a1');
      await repos.archives.insert(archive('a2', 's1', 'owner', { createdAt: T1, status: 'VERIFIED' }));

      expect(await repos.archives.findById('a1')).toMatchObject({
        objectKey: 'vault/s1/a1.zip',
        checksum: null,
        status: 'PENDING',
      });
      expect((await repos.archives.listForOwner('owner')).map((a) => a.id)).toEqual(['a2', 'a1']);
      expect((await repos.archives.listByStatus('VERIFIED')).map((a) => a.id)).toEqual(['a2']);
      expect((await repos.archives.listForSpace('s1')).map((a) => a.id)).toEqual(['a2', 'a1']);
      expect((await repos.archives.listAll()).map((a) => a.id)).toEqual(['a2', 'a1']);

      const verified = await repos.archives.update('a1', {
        status: 'VERIFIED',
        checksum: 'sha256-abc',
        sizeBytes: 250,
        fileCount: 3,
        verifiedAt: T2,
      });
      expect(verified).toMatchObject({
        status: 'VERIFIED',
        checksum: 'sha256-abc',
        sizeBytes: 250,
        fileCount: 3,
        verifiedAt: T2,
      });
      expect(verified?.objectKey).toBe('vault/s1/a1.zip');
      expect(await repos.archives.update('missing', { status: 'FAILED' })).toBeUndefined();

      await expect(
        repos.archives.insert(archive('a3', 's1', 'ghost')),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
      await expect(repos.archives.insert(archive('a1', 's1', 'owner'))).rejects.toMatchObject({
        code: 'DUPLICATE',
      });
    });
  });

  describe('lifecycle jobs', () => {
    it('claims pending jobs atomically, tracks attempts and finishes', async () => {
      await repos.jobs.insert(job('j1', 's1', { startedAt: T0 }));
      await repos.jobs.insert(job('j2', 's1', { startedAt: T1 }));
      await repos.jobs.insert(job('j3', null, { jobType: 'CLEANUP', idempotencyKey: 'cleanup', startedAt: T2 }));

      expect((await repos.jobs.findById('j1'))?.status).toBe('PENDING');
      expect((await repos.jobs.findByIdempotencyKey('key-j1'))?.id).toBe('j1');
      expect((await repos.jobs.list()).map((j) => j.id)).toEqual(['j3', 'j2', 'j1']);

      const [first, second] = await Promise.all([
        repos.jobs.claimNext('LIFECYCLE'),
        repos.jobs.claimNext('LIFECYCLE'),
      ]);
      expect(new Set([first?.id, second?.id]).size).toBe(2);
      expect([first?.id, second?.id].sort()).toEqual(['j1', 'j2']);
      expect(first?.attempts).toBe(1);
      expect(first?.status).toBe('RUNNING');

      expect(await repos.jobs.claimNext('LIFECYCLE')).toBeUndefined();
      const cleanup = await repos.jobs.claimNext('CLEANUP');
      expect(cleanup?.id).toBe('j3');

      const finished = await repos.jobs.finish('j1', { status: 'SUCCEEDED' });
      expect(finished?.status).toBe('SUCCEEDED');
      expect(finished?.finishedAt).not.toBeNull();
      expect(await repos.jobs.update('missing', { status: 'FAILED' })).toBeUndefined();

      await expect(
        repos.jobs.insert(job('j4', 's1', { idempotencyKey: 'key-j1' })),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.jobs.insert(job('j5', 'missing')),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('cleanup runs', () => {
    it('records progress and completion for a Space archive', async () => {
      await seedArchive('a1');
      const run: CleanupRun = {
        id: 'c1',
        spaceId: 's1',
        archiveId: 'a1',
        status: 'RUNNING',
        membershipsRevoked: 0,
        objectsDeleted: 0,
        startedAt: T0,
        finishedAt: null,
        error: null,
      };
      await repos.cleanupRuns.insert(run);
      await repos.cleanupRuns.insert({
        ...run,
        id: 'c2',
        startedAt: T1,
        status: 'SUCCEEDED',
        finishedAt: T1,
      });

      expect(await repos.cleanupRuns.findById('c1')).toMatchObject({ status: 'RUNNING' });
      expect((await repos.cleanupRuns.listForSpace('s1')).map((c) => c.id)).toEqual(['c2', 'c1']);
      expect((await repos.cleanupRuns.listAll(1)).map((c) => c.id)).toEqual(['c2']);

      const finished = await repos.cleanupRuns.update('c1', {
        status: 'SUCCEEDED',
        membershipsRevoked: 3,
        objectsDeleted: 7,
        finishedAt: T2,
      });
      expect(finished).toMatchObject({
        status: 'SUCCEEDED',
        membershipsRevoked: 3,
        objectsDeleted: 7,
        finishedAt: T2,
      });
      expect(await repos.cleanupRuns.update('missing', { status: 'FAILED' })).toBeUndefined();

      await expect(
        repos.cleanupRuns.insert({ ...run, id: 'bad', archiveId: 'missing' }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('favorite Spaces', () => {
    it('is idempotent, per-user and orderable by star time', async () => {
      await repos.spaces.insert(space('s2', 'owner'));
      await repos.favoriteSpaces.add('member', 's1', T0);
      await repos.favoriteSpaces.add('member', 's1', T1); // duplicate: no second row
      await repos.favoriteSpaces.add('member', 's2', T2);
      await repos.favoriteSpaces.add('owner', 's1', T0);

      const favorites = await repos.favoriteSpaces.listForUser('member');
      expect(favorites.map((f) => f.spaceId)).toEqual(['s2', 's1']);
      expect(favorites.find((f) => f.spaceId === 's1')?.createdAt).toBe(T0);
      expect((await repos.favoriteSpaces.listForUser('owner')).map((f) => f.spaceId)).toEqual(['s1']);

      expect(await repos.favoriteSpaces.remove('member', 's2')).toBe(true);
      expect(await repos.favoriteSpaces.remove('member', 's2')).toBe(false);
      expect((await repos.favoriteSpaces.listForUser('member')).map((f) => f.spaceId)).toEqual([
        's1',
      ]);

      await expect(
        repos.favoriteSpaces.add('member', 'missing', T3),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('lifecycle transitions', () => {
    it('appends history and returns newest first with a limit', async () => {
      const base: LifecycleTransition = {
        id: 't1',
        spaceId: 's1',
        actorId: 'owner',
        previousStatus: 'ACTIVE',
        newStatus: 'WARNING',
        reason: 'warning window',
        timestamp: T0,
      };
      await repos.lifecycleTransitions.insert(base);
      await repos.lifecycleTransitions.insert({ ...base, id: 't2', timestamp: T1, newStatus: 'ARCHIVING' });
      await repos.lifecycleTransitions.insert({
        ...base,
        id: 't3',
        timestamp: T2,
        actorId: null,
        previousStatus: 'ARCHIVING',
        newStatus: 'ARCHIVED',
      });

      const history = await repos.lifecycleTransitions.listForSpace('s1');
      expect(history.map((t) => t.id)).toEqual(['t3', 't2', 't1']);
      expect(history[0]).toMatchObject({ actorId: null, newStatus: 'ARCHIVED', timestamp: T2 });
      expect((await repos.lifecycleTransitions.listForSpace('s1', 1)).map((t) => t.id)).toEqual([
        't3',
      ]);
      expect(await repos.lifecycleTransitions.listForSpace('s2')).toEqual([]);

      await expect(
        repos.lifecycleTransitions.insert({ ...base, id: 'bad', spaceId: 'missing' }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('scan jobs and duplicate relationships', () => {
    it('updates scan progress and enforces one group per scan/content hash', async () => {
      await repos.scanJobs.insert(scan('scan1', 's1', 'owner'));
      expect(await repos.scanJobs.findById('scan1')).toMatchObject({ status: 'PENDING' });

      const completed = await repos.scanJobs.update('scan1', {
        status: 'VERIFIED',
        totalFiles: 10,
        totalBytes: 1000,
        duplicateGroups: 1,
        duplicateFileCount: 2,
        extraCopyCount: 1,
        potentialSavingsBytes: 100,
        scannedAt: T2,
        updatedAt: T3,
      });
      expect(completed).toMatchObject({
        status: 'VERIFIED',
        totalFiles: 10,
        duplicateGroups: 1,
        scannedAt: T2,
      });
      expect(completed?.updatedAt).not.toBe(T3); // server timestamp wins, like SQLite
      expect((await repos.scanJobs.listForSpace('s1')).map((s) => s.id)).toEqual(['scan1']);
      expect(await repos.scanJobs.update('missing', { status: 'FAILED' })).toBeUndefined();

      await repos.duplicateGroups.insert(group('g1', 'scan1', { totalBytes: 50 }));
      await repos.duplicateGroups.insert(group('g2', 'scan1', { contentHash: 'other', totalBytes: 90 }));
      expect((await repos.duplicateGroups.listForScan('scan1')).map((g) => g.id)).toEqual([
        'g2',
        'g1',
      ]);
      expect(await repos.duplicateGroups.findById('g1')).toMatchObject({ fileCount: 2 });
      await expect(
        repos.duplicateGroups.insert(group('g3', 'scan1', { contentHash: 'hash-g1' })),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });

      await seedFile('file1');
      await seedFile('file2');
      const duplicateFile: DuplicateFileRow = {
        id: 'd1',
        groupId: 'g1',
        scanId: 'scan1',
        fileId: 'file1',
        name: 'file1.txt',
        objectKey: 's1/file1.txt',
        sizeBytes: 10,
        mimeType: 'text/plain',
        uploadedAt: T0,
        uploaderId: 'owner',
        excluded: false,
      };
      await repos.duplicateFiles.insert(duplicateFile);
      await repos.duplicateFiles.insert({
        ...duplicateFile,
        id: 'd2',
        fileId: 'file2',
        objectKey: 's1/file2.txt',
        excluded: true,
      });

      expect((await repos.duplicateFiles.listForGroup('g1')).map((f) => f.id).sort()).toEqual([
        'd1',
        'd2',
      ]);
      expect((await repos.duplicateFiles.listAll()).map((f) => f.id).sort()).toEqual(['d1', 'd2']);
      expect((await repos.duplicateFiles.findById('d2'))?.excluded).toBe(true);
      await expect(
        repos.duplicateFiles.insert({ ...duplicateFile, id: 'd3' }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.duplicateFiles.insert({ ...duplicateFile, id: 'd4', fileId: 'missing' }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });

      await repos.duplicateFiles.deleteForGroup('g1');
      expect(await repos.duplicateFiles.listForGroup('g1')).toEqual([]);
      await repos.duplicateGroups.deleteForScan('scan1');
      expect(await repos.duplicateGroups.listForScan('scan1')).toEqual([]);
    });
  });

  describe('archive plans and jobs', () => {
    it('links plans to jobs, maintains payload fields and supports entity lookup', async () => {
      await seedArchive('a1');
      await repos.scanJobs.insert(scan('scan1', 's1', 'owner'));
      const plan: ArchivePlanRow = {
        id: 'p1',
        spaceId: 's1',
        ownerId: 'owner',
        scanId: 'scan1',
        status: 'PENDING',
        excludedFileIds: ['file1', 'file2'],
        willArchiveFileCount: 3,
        willArchiveBytes: 300,
        willExcludeFileCount: 2,
        willExcludeBytes: 20,
        potentialSavingsBytes: 20,
        explained: false,
        confirmedAt: null,
        archiveJobId: null,
        errorMessage: null,
        createdAt: T0,
        updatedAt: T0,
      };
      await repos.archivePlans.insert(plan);
      expect(await repos.archivePlans.findById('p1')).toMatchObject({
        excludedFileIds: ['file1', 'file2'],
        explained: false,
        scanId: 'scan1',
      });

      const archiveJob: ArchiveJobRow = {
        id: 'aj1',
        planId: 'p1',
        spaceId: 's1',
        ownerId: 'owner',
        idempotencyKey: 'plan-p1',
        status: 'PENDING',
        attempts: 0,
        archiveId: null,
        startedAt: T0,
        finishedAt: null,
        error: null,
      };
      await repos.archiveJobs.insert(archiveJob);
      const confirmed = await repos.archivePlans.update('p1', {
        status: 'CONFIRMED',
        explained: true,
        confirmedAt: T2,
        archiveJobId: 'aj1',
        excludedFileIds: ['file2'],
      });
      expect(confirmed).toMatchObject({
        status: 'CONFIRMED',
        explained: true,
        confirmedAt: T2,
        archiveJobId: 'aj1',
        excludedFileIds: ['file2'],
      });
      expect((await repos.archivePlans.listForSpace('s1')).map((p) => p.id)).toEqual(['p1']);
      expect(await repos.archivePlans.update('missing', { status: 'FAILED' })).toBeUndefined();

      expect((await repos.archiveJobs.findById('aj1'))?.planId).toBe('p1');
      expect((await repos.archiveJobs.findByPlanId('p1'))?.id).toBe('aj1');
      expect((await repos.archiveJobs.findByIdempotencyKey('plan-p1'))?.id).toBe('aj1');
      expect((await repos.archiveJobs.findByEntity('plan', 'p1'))?.id).toBe('aj1');
      expect((await repos.archiveJobs.findByEntity('space', 's1'))?.id).toBe('aj1');
      expect((await repos.archiveJobs.findByEntity('job', 'aj1'))?.id).toBe('aj1');

      const finished = await repos.archiveJobs.update('aj1', {
        status: 'SUCCEEDED',
        attempts: 1,
        archiveId: 'a1',
        finishedAt: T2,
      });
      expect(finished).toMatchObject({ status: 'SUCCEEDED', archiveId: 'a1', attempts: 1 });
      expect(await repos.archiveJobs.update('missing', { status: 'FAILED' })).toBeUndefined();

      await expect(
        repos.archiveJobs.insert({ ...archiveJob, id: 'aj2' }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });

      await repos.archivePlans.deleteForSpace('s1');
      expect(await repos.archivePlans.listForSpace('s1')).toEqual([]);
      expect(await repos.archiveJobs.findById('aj1')).toBeUndefined();
    });
  });

  it('persists lifecycle and storage data across a pool restart', async () => {
    await seedArchive('persist-a');
    await repos.favoriteSpaces.add('owner', 's1', T1);
    await repos.scanJobs.insert(scan('persist-scan', 's1', 'owner'));

    const restartPool = new Pool({ connectionString: db.url, max: 2 });
    try {
      const reopened = createPostgresCoreRepositories(
        loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
        restartPool,
      );
      expect((await reopened.archives.findById('persist-a'))?.status).toBe('PENDING');
      expect((await reopened.favoriteSpaces.listForUser('owner')).map((f) => f.spaceId)).toEqual([
        's1',
      ]);
      expect((await reopened.scanJobs.findById('persist-scan'))?.status).toBe('PENDING');
    } finally {
      await restartPool.end();
    }
  });
});

describe('lifecycle repositories SQLite parity', () => {
  it('matches SQLite for archives, favourites, transitions, scans and archive plans', async () => {
    if (!baseUrl) return;
    const db = await createDisposableDatabase(baseUrl);
    let pool: Pool | null = null;
    const sqlite = new SqliteDataLayer(':memory:');
    try {
      await migrateDatabase(db.url);
      pool = new Pool({ connectionString: db.url, max: 2 });
      const pg = createPostgresCoreRepositories(
        loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
        pool,
      );

      for (const layer of [sqlite, pg]) {
        await layer.auth.create(profile('owner', 'parity@example.test'), 'h');
        await layer.spaces.insert(space('s1', 'owner'));
        await layer.archives.insert(archive('a1', 's1', 'owner'));
        await layer.favoriteSpaces.add('owner', 's1', T0);
        await layer.lifecycleTransitions.insert({
          id: 't1',
          spaceId: 's1',
          actorId: null,
          previousStatus: 'ACTIVE',
          newStatus: 'WARNING',
          reason: 'parity',
          timestamp: T0,
        });
        await layer.scanJobs.insert(scan('scan1', 's1', 'owner'));
        await layer.archivePlans.insert({
          id: 'p1',
          spaceId: 's1',
          ownerId: 'owner',
          scanId: 'scan1',
          status: 'PENDING',
          excludedFileIds: ['a', 'b'],
          willArchiveFileCount: 2,
          willArchiveBytes: 20,
          willExcludeFileCount: 0,
          willExcludeBytes: 0,
          potentialSavingsBytes: 0,
          explained: false,
          confirmedAt: null,
          archiveJobId: null,
          errorMessage: null,
          createdAt: T0,
          updatedAt: T0,
        });
        await layer.jobs.insert(job('j1', 's1'));
      }

      expect((await sqlite.archives.listForOwner('owner')).map((a) => a.id)).toEqual(
        (await pg.archives.listForOwner('owner')).map((a) => a.id),
      );
      expect((await sqlite.favoriteSpaces.listForUser('owner')).map((f) => f.spaceId)).toEqual(
        (await pg.favoriteSpaces.listForUser('owner')).map((f) => f.spaceId),
      );
      expect((await sqlite.lifecycleTransitions.listForSpace('s1')).map((t) => t.id)).toEqual(
        (await pg.lifecycleTransitions.listForSpace('s1')).map((t) => t.id),
      );
      expect((await sqlite.scanJobs.listForSpace('s1')).map((s) => s.id)).toEqual(
        (await pg.scanJobs.listForSpace('s1')).map((s) => s.id),
      );
      expect((await sqlite.archivePlans.listForSpace('s1')).map((p) => p.excludedFileIds)).toEqual(
        (await pg.archivePlans.listForSpace('s1')).map((p) => p.excludedFileIds),
      );
      expect((await sqlite.jobs.list()).map((j) => j.id)).toEqual(
        (await pg.jobs.list()).map((j) => j.id),
      );
    } finally {
      await pool?.end();
      await db.drop();
    }
  });
});
