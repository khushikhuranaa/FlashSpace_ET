import type { SpaceAccess, SpaceAccessRepo } from '../data-layer.interface.js';

/** In-memory "recently accessed Spaces" store (tests + memory mode). */
export class MemorySpaceAccessRepo implements SpaceAccessRepo {
  private readonly rows = new Map<string, SpaceAccess>();

  touch(spaceId: string, userId: string, at: string): void {
    this.rows.set(`${userId}:${spaceId}`, { spaceId, userId, lastAccessedAt: at });
  }

  listForUser(userId: string, limit = 10): SpaceAccess[] {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
      .slice(0, limit);
  }
}
