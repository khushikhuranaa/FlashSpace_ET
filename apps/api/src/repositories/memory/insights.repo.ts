/** In-memory stubs for the storage-insights repositories.
 *  Real persistence lives in SqliteDataLayer; these exist so the in-memory
 *  data layer still satisfies the DataLayer contract in tests.
 */
import type {
  ArchiveJobRow,
  ArchivePlanRow,
  DataLayer,
  DuplicateFileRow,
  DuplicateGroupRow,
  ScanJobRow,
} from '../data-layer.interface.js';

function newId(): string {
  return `mem-${Math.random().toString(36).slice(2, 10)}`;
}

function clone<T extends object>(row: T): T {
  return { ...row };
}

export class MemoryScanJobsRepo {
  readonly rows = new Map<string, ScanJobRow>();
  insert(job: ScanJobRow): ScanJobRow {
    const copy = clone(job);
    this.rows.set(copy.id, copy);
    return copy;
  }
  findById(id: string): ScanJobRow | undefined {
    return this.rows.get(id);
  }
  listForSpace(spaceId: string): ScanJobRow[] {
    return [...this.rows.values()].filter((r) => r.spaceId === spaceId).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  update(id: string, patch: Partial<ScanJobRow>): ScanJobRow | undefined {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return next;
  }
}

export class MemoryDuplicateGroupsRepo {
  readonly rows = new Map<string, DuplicateGroupRow>();
  insert(group: DuplicateGroupRow): DuplicateGroupRow {
    const copy = clone(group);
    this.rows.set(copy.id, copy);
    return copy;
  }
  findById(id: string): DuplicateGroupRow | undefined {
    return this.rows.get(id);
  }
  listForScan(scanId: string): DuplicateGroupRow[] {
    return [...this.rows.values()].filter((r) => r.scanId === scanId).sort(
      (a, b) => b.totalBytes - a.totalBytes,
    );
  }
  deleteForScan(scanId: string): void {
    for (const r of [...this.rows.values()]) {
      if (r.scanId === scanId) this.rows.delete(r.id);
    }
  }
}

export class MemoryDuplicateFilesRepo {
  readonly rows = new Map<string, DuplicateFileRow>();
  insert(row: DuplicateFileRow): DuplicateFileRow {
    const copy = clone(row);
    this.rows.set(copy.id, copy);
    return copy;
  }
  findById(id: string): DuplicateFileRow | undefined {
    return this.rows.get(id);
  }
  listForGroup(groupId: string): DuplicateFileRow[] {
    return [...this.rows.values()].filter((r) => r.groupId === groupId);
  }
  listAll(): DuplicateFileRow[] {
    return [...this.rows.values()];
  }
  deleteForGroup(groupId: string): void {
    for (const r of [...this.rows.values()]) {
      if (r.groupId === groupId) this.rows.delete(r.id);
    }
  }
  deleteForScan(scanId: string): void {
    for (const r of [...this.rows.values()]) {
      if (r.scanId === scanId) this.rows.delete(r.id);
    }
  }
}

export class MemoryArchivePlansRepo {
  readonly rows = new Map<string, ArchivePlanRow>();
  insert(plan: ArchivePlanRow): ArchivePlanRow {
    const copy = clone(plan);
    this.rows.set(copy.id, copy);
    return copy;
  }
  findById(id: string): ArchivePlanRow | undefined {
    return this.rows.get(id);
  }
  listForSpace(spaceId: string): ArchivePlanRow[] {
    return [...this.rows.values()].filter((r) => r.spaceId === spaceId).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  update(id: string, patch: Partial<ArchivePlanRow>): ArchivePlanRow | undefined {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return next;
  }
  deleteForSpace(spaceId: string): void {
    for (const r of [...this.rows.values()]) {
      if (r.spaceId === spaceId) this.rows.delete(r.id);
    }
  }
}

export class MemoryArchiveJobsRepo {
  readonly rows = new Map<string, ArchiveJobRow>();
  insert(job: ArchiveJobRow): ArchiveJobRow {
    const copy = clone(job);
    this.rows.set(copy.id, copy);
    return copy;
  }
  findById(id: string): ArchiveJobRow | undefined {
    return this.rows.get(id);
  }
  findByPlanId(planId: string): ArchiveJobRow | undefined {
    return [...this.rows.values()].find((r) => r.planId === planId);
  }
  findByIdempotencyKey(key: string): ArchiveJobRow | undefined {
    return [...this.rows.values()].find((r) => r.idempotencyKey === key);
  }
  update(id: string, patch: Partial<ArchiveJobRow>): ArchiveJobRow | undefined {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    return next;
  }
}
