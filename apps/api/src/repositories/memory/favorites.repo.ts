import type { FavoriteSpace, FavoriteSpacesRepo } from '../data-layer.interface.js';

/** In-memory per-user Space stars (tests + memory mode). */
export class MemoryFavoriteSpacesRepo implements FavoriteSpacesRepo {
  private readonly rows = new Map<string, FavoriteSpace>();

  add(userId: string, spaceId: string, at: string): void {
    this.rows.set(`${userId}:${spaceId}`, { userId, spaceId, createdAt: at });
  }

  remove(userId: string, spaceId: string): boolean {
    return this.rows.delete(`${userId}:${spaceId}`);
  }

  listForUser(userId: string): FavoriteSpace[] {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
