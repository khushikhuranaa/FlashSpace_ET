import { AppError } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';

/**
 * Cleanup engine (PRD §10): 7 days after archiving, revoke memberships,
 * hard-delete Space objects, then soft-delete DB rows so history stays
 * auditable. Partial failures are recorded and retried by the worker.
 */
export class CleanupService {
  constructor(
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
  ) {}

  async runCleanup(
    spaceId: string,
    archiveId: string,
  ): Promise<{ membershipsRevoked: number; objectsDeleted: number; status: string }> {
    const space = this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const archive = this.db.archives.findById(archiveId);
    if (!archive || archive.status !== 'VERIFIED') {
      throw new AppError('ARCHIVE_NOT_VERIFIED', 'Refusing cleanup without a verified archive');
    }

    let membershipsRevoked = 0;
    let objectsDeleted = 0;
    let hadFailure = false;

    // 1. Revoke every membership.
    try {
      membershipsRevoked = this.db.members.revokeAllForSpace(spaceId);
    } catch {
      hadFailure = true;
    }

    // 2. Hard-delete Space object storage.
    try {
      const prefix = `spaces/${spaceId}/`;
      const objects = await this.storage.listObjects(prefix);
      for (const obj of objects) {
        await this.storage.deleteObject(obj.key);
        objectsDeleted++;
      }
    } catch {
      hadFailure = true;
    }

    // 3. Soft-delete file rows, mark Space DELETED. Vault archive is retained.
    try {
      for (const f of this.db.files.listForSpace(spaceId)) {
        if (f.status !== 'DELETED') {
          this.db.files.update(f.id, { status: 'DELETED', deletedAt: new Date().toISOString() });
        }
      }
      this.db.spaces.update(spaceId, { status: 'DELETED' });
    } catch {
      hadFailure = true;
    }

    const status = hadFailure ? 'PARTIAL_FAILED' : 'SUCCEEDED';
    return { membershipsRevoked, objectsDeleted, status };
  }
}
