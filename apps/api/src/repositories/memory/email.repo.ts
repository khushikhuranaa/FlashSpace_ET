import type {
  EmailJobsRepo,
  EmailJobRow,
  HashedTokenRow,
  VerificationTokensRepo,
} from '../data-layer.interface.js';

/** In-memory email delivery records (Module 9), used by tests and memory mode. */
export class MemoryEmailJobsRepo implements EmailJobsRepo {
  private readonly jobs = new Map<string, EmailJobRow>();

  insert(job: EmailJobRow): EmailJobRow {
    this.jobs.set(job.id, job);
    return job;
  }

  findById(id: string): EmailJobRow | undefined {
    return this.jobs.get(id);
  }

  findByEntity(entityType: string, entityId: string): EmailJobRow | undefined {
    return [...this.jobs.values()]
      .filter((j) => j.entityType === entityType && j.entityId === entityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  listFailed(limit = 100): EmailJobRow[] {
    return this.byStatus(['FAILED'], limit);
  }

  listPending(limit = 100): EmailJobRow[] {
    return this.byStatus(['PENDING', 'RETRY_SCHEDULED', 'PROCESSING'], limit);
  }

  listAll(limit = 200): EmailJobRow[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<EmailJobRow>): EmailJobRow | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const next = { ...job, ...patch };
    this.jobs.set(id, next);
    return next;
  }

  private byStatus(statuses: string[], limit: number): EmailJobRow[] {
    return [...this.jobs.values()]
      .filter((j) => statuses.includes(j.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

/** In-memory hashed verification/reset tokens (Module 9). */
export class MemoryVerificationTokensRepo implements VerificationTokensRepo {
  private readonly tokens = new Map<string, HashedTokenRow>();

  insert(row: HashedTokenRow): HashedTokenRow {
    this.tokens.set(row.id, { ...row });
    return row;
  }

  findByPurposeAndUserId(purpose: string, userId: string): HashedTokenRow | undefined {
    return [...this.tokens.values()]
      .filter((t) => t.purpose === purpose && t.userId === userId && !t.usedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  findByTokenHash(tokenHash: string, purpose: string): HashedTokenRow | undefined {
    return [...this.tokens.values()].find((t) => t.tokenHash === tokenHash && t.purpose === purpose);
  }

  markUsed(id: string): HashedTokenRow | undefined {
    const token = this.tokens.get(id);
    if (!token || token.usedAt) return undefined;
    const next = { ...token, usedAt: new Date().toISOString() };
    this.tokens.set(id, next);
    return next;
  }

  destroy(id: string): boolean {
    return this.tokens.delete(id);
  }
}
