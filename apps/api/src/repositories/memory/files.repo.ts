import type { Archive, FileRecord, Notification } from '@flashspace/shared';
import type { ArchivesRepo, FilesRepo, NotificationsRepo } from '../data-layer.interface.js';

/** In-memory file + archive repositories mirroring the Postgres schema. */

export class MemoryFilesRepo implements FilesRepo {
  private readonly files = new Map<string, FileRecord>();

  insert(file: FileRecord): FileRecord {
    this.files.set(file.id, file);
    return file;
  }

  findById(id: string): FileRecord | undefined {
    return this.files.get(id);
  }

  listForSpace(spaceId: string): FileRecord[] {
    return [...this.files.values()].filter((f) => f.spaceId === spaceId);
  }

  listAll(): FileRecord[] {
    return [...this.files.values()];
  }

  listActiveForSpace(spaceId: string): FileRecord[] {
    return this.listForSpace(spaceId).filter((f) => f.status !== 'DELETED');
  }

  findByObjectKey(objectKey: string): FileRecord | undefined {
    return [...this.files.values()].find((f) => f.objectKey === objectKey);
  }

  update(id: string, patch: Partial<FileRecord>): FileRecord | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    const next = { ...file, ...patch, updatedAt: new Date().toISOString() };
    this.files.set(id, next);
    return next;
  }

  /** Sum of active file sizes for quota checks. */
  usedBytesForSpace(spaceId: string): number {
    return this.listActiveForSpace(spaceId).reduce((sum, f) => sum + f.sizeBytes, 0);
  }
}

export class MemoryArchivesRepo implements ArchivesRepo {
  private readonly archives = new Map<string, Archive>();

  insert(archive: Archive): Archive {
    this.archives.set(archive.id, archive);
    return archive;
  }

  findById(id: string): Archive | undefined {
    return this.archives.get(id);
  }

  listForOwner(ownerId: string): Archive[] {
    return [...this.archives.values()]
      .filter((a) => a.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listByStatus(status: Archive['status']): Archive[] {
    return [...this.archives.values()].filter((a) => a.status === status);
  }

  listAll(): Archive[] {
    return [...this.archives.values()];
  }

  listForSpace(spaceId: string): Archive[] {
    return [...this.archives.values()].filter((a) => a.spaceId === spaceId);
  }

  update(id: string, patch: Partial<Archive>): Archive | undefined {
    const archive = this.archives.get(id);
    if (!archive) return undefined;
    const next = { ...archive, ...patch };
    this.archives.set(id, next);
    return next;
  }
}

export class MemoryNotificationsRepo implements NotificationsRepo {
  private readonly notifications = new Map<string, Notification>();

  insert(n: Notification): Notification {
    this.notifications.set(n.id, n);
    return n;
  }

  listForUser(userId: string): Notification[] {
    return [...this.notifications.values()]
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findById(id: string): Notification | undefined {
    return this.notifications.get(id);
  }

  markRead(id: string): Notification | undefined {
    const n = this.notifications.get(id);
    if (!n) return undefined;
    const next = { ...n, readAt: n.readAt ?? new Date().toISOString() };
    this.notifications.set(id, next);
    return next;
  }

  markAllRead(userId: string): number {
    let count = 0;
    for (const [id, n] of this.notifications) {
      if (n.userId === userId && !n.readAt) {
        this.notifications.set(id, { ...n, readAt: new Date().toISOString() });
        count++;
      }
    }
    return count;
  }
}
