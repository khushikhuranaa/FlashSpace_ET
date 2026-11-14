import { activityCategoryFor } from '@flashspace/shared';
import type {
  ActivityInput,
  ActivityLog,
  ActivityPage,
  ActivityQuery,
  CleanupRun,
  LifecycleJob,
  Notification,
} from '@flashspace/shared';
import type {
  ActivityRepo,
  CleanupRunsRepo,
  JobsRepo,
  NotificationBusLike,
} from '../data-layer.interface.js';

/** In-memory job/cleanup/notification/activity stores. */

export class MemoryJobsRepo implements JobsRepo {
  private readonly jobs = new Map<string, LifecycleJob>();

  insert(job: LifecycleJob): LifecycleJob {
    this.jobs.set(job.id, job);
    return job;
  }

  findById(id: string): LifecycleJob | undefined {
    return this.jobs.get(id);
  }

  findByIdempotencyKey(key: string): LifecycleJob | undefined {
    return [...this.jobs.values()].find((j) => j.idempotencyKey === key);
  }

  /** Claims the latest unfinished job of a type (single-worker assumption). */
  claimNext(jobType: LifecycleJob['jobType']): LifecycleJob | undefined {
    const pending = [...this.jobs.values()]
      .filter((j) => j.jobType === jobType && j.status === 'PENDING')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const job = pending[0];
    if (!job) return undefined;
    const claimed: LifecycleJob = {
      ...job,
      status: 'RUNNING',
      attempts: job.attempts + 1,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, claimed);
    return claimed;
  }

  update(id: string, patch: Partial<LifecycleJob>): LifecycleJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const next = { ...job, ...patch };
    this.jobs.set(id, next);
    return next;
  }

  finish(id: string, patch: Partial<LifecycleJob>): LifecycleJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const next: LifecycleJob = {
      ...job,
      ...patch,
      finishedAt: new Date().toISOString(),
    };
    this.jobs.set(id, next);
    return next;
  }

  list(limit = 50): LifecycleJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }
}

export class MemoryCleanupRunsRepo implements CleanupRunsRepo {
  private readonly runs = new Map<string, CleanupRun>();

  insert(run: CleanupRun): CleanupRun {
    this.runs.set(run.id, run);
    return run;
  }

  findById(id: string): CleanupRun | undefined {
    return this.runs.get(id);
  }

  listForSpace(spaceId: string): CleanupRun[] {
    return [...this.runs.values()].filter((r) => r.spaceId === spaceId);
  }

  listAll(limit = 100): CleanupRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<CleanupRun>): CleanupRun | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.runs.set(id, next);
    return next;
  }
}

export class MemoryActivityRepo implements ActivityRepo {
  private seq = 0;
  private readonly logs: ActivityLog[] = [];

  append(input: ActivityInput): ActivityLog {
    if (input.eventKey) {
      const existing = this.logs.find((l) => l.eventKey === input.eventKey);
      if (existing) return existing;
    }
    const entry: ActivityLog = {
      id: ++this.seq,
      userId: input.userId ?? null,
      spaceId: input.spaceId ?? null,
      fileId: input.fileId ?? null,
      action: input.action,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      actorType: input.actorType ?? (input.userId ? 'USER' : 'SYSTEM'),
      outcome: input.outcome ?? 'SUCCESS',
      category: input.category ?? activityCategoryFor(input.action),
      // Infer a safe resource reference from the ids a caller already passed.
      resourceType:
        input.resourceType ?? (input.fileId ? 'file' : input.spaceId ? 'space' : null),
      resourceId: input.resourceId ?? input.fileId ?? input.spaceId ?? null,
      reason: input.reason ?? null,
      correlationId: input.correlationId ?? null,
      eventKey: input.eventKey ?? null,
    };
    this.logs.push(entry);
    return entry;
  }

  findById(id: number): ActivityLog | undefined {
    return this.logs.find((l) => l.id === id);
  }

  listForSpace(spaceId: string, limit = 100): ActivityLog[] {
    return this.logs
      .filter((l) => l.spaceId === spaceId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  listForUser(userId: string, limit = 100): ActivityLog[] {
    return this.logs
      .filter((l) => l.userId === userId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  listAll(limit = 200): ActivityLog[] {
    return [...this.logs].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  query(q: ActivityQuery): ActivityPage {
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const spaceScope = q.spaceIds ? new Set(q.spaceIds) : null;
    const actorScope = q.userIds ? new Set(q.userIds) : null;
    const from = q.from ? new Date(q.from).getTime() : null;
    const to = q.to ? new Date(q.to).getTime() : null;

    const matches = this.logs.filter((l) => {
      if (spaceScope) {
        if (q.spaceId) {
          if (l.spaceId !== q.spaceId) return false;
        } else if (!l.spaceId || !spaceScope.has(l.spaceId)) return false;
      } else if (q.spaceId && l.spaceId !== q.spaceId) return false;
      if (q.userId && l.userId !== q.userId) return false;
      if (actorScope && (!l.userId || !actorScope.has(l.userId))) return false;
      if (q.actorType && l.actorType !== q.actorType) return false;
      if (q.category && l.category !== q.category) return false;
      if (q.action && l.action !== q.action) return false;
      if (q.outcome && l.outcome !== q.outcome) return false;
      if (q.resourceType && l.resourceType !== q.resourceType) return false;
      if (q.resourceId && l.resourceId !== q.resourceId) return false;
      const at = new Date(l.createdAt).getTime();
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;
      return true;
    });

    matches.sort((a, b) => (q.sort === 'oldest' ? a.id - b.id : b.id - a.id));
    return { entries: matches.slice(offset, offset + limit), total: matches.length, limit, offset };
  }
}

/** Simple in-process notification fan-out used by the web app (SSE later). */
export class NotificationBus implements NotificationBusLike {
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
