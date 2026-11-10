import type { AuthUser, StorageSummary } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { SpacesService } from './spaces.service.js';

/**
 * Storage accounting for the signed-in user. Every number is derived from live
 * rows: active file bytes per Space, verified archive sizes in the Vault, and
 * the configured per-Space quotas — nothing is hardcoded in the UI.
 */
export class StorageService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  summary(actor: AuthUser): StorageSummary {
    const spaces = this.spaces.listForUser(actor.id);
    const quotaBytes = this.env.spaceMaxBytes * this.env.maxActiveSpacesPerUser;

    const rows = spaces.map((space) => {
      const usedBytes = this.db.files.usedBytesForSpace(space.id);
      const archivedBytes = this.db.archives
        .listForSpace(space.id)
        .filter((a) => a.status === 'VERIFIED')
        .reduce((sum, a) => sum + a.sizeBytes, 0);
      return {
        spaceId: space.id,
        name: space.name,
        status: space.status,
        usedBytes,
        archivedBytes,
        archivedManually: space.archivedManually,
        owned: space.ownerId === actor.id,
      };
    });

    // Archived Vault storage belongs to the owner only (archives follow the owner).
    const archivedBytes = this.db.archives
      .listForOwner(actor.id)
      .filter((a) => a.status === 'VERIFIED')
      .reduce((sum, a) => sum + a.sizeBytes, 0);

    const usedBytes =
      rows.reduce((sum, r) => sum + r.usedBytes, 0) + archivedBytes;
    const freeBytes = Math.max(0, quotaBytes - usedBytes);

    return {
      quotaBytes,
      usedBytes,
      archivedBytes,
      freeBytes,
      spaceCount: spaces.length,
      archivedSpaceCount: spaces.filter((s) => s.status === 'ARCHIVED').length,
      spaces: rows.sort((a, b) => b.usedBytes - a.usedBytes),
    };
  }
}
