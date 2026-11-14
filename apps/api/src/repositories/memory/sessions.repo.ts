import type { AuthSession, SessionsRepo } from '../data-layer.interface.js';

/** In-memory refresh sessions for tests and ephemeral development. */
export class MemorySessionsRepo implements SessionsRepo {
  private readonly rows = new Map<string, AuthSession>();

  insert(session: AuthSession): AuthSession {
    this.rows.set(session.id, session);
    return session;
  }

  findById(id: string): AuthSession | undefined {
    return this.rows.get(id);
  }

  findByRefreshHash(hash: string): AuthSession | undefined {
    return [...this.rows.values()].find((s) => s.refreshTokenHash === hash);
  }

  update(id: string, patch: Partial<AuthSession>): AuthSession | undefined {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    return next;
  }

  listForUser(userId: string): AuthSession[] {
    return [...this.rows.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  revokeAllForUser(userId: string, at: string, exceptId?: string): number {
    let count = 0;
    for (const [id, session] of this.rows) {
      if (session.userId !== userId || session.revokedAt) continue;
      if (exceptId && id === exceptId) continue;
      this.rows.set(id, { ...session, revokedAt: at });
      count += 1;
    }
    return count;
  }
}
