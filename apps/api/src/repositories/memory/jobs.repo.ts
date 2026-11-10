import type {
  ActivityLog,
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
}

export class MemoryActivityRepo implements ActivityRepo {
  private seq = 0;
  private readonly logs: ActivityLog[] = [];

  append(log: Omit<ActivityLog, 'id' | 'createdAt'>): ActivityLog {
    const entry: ActivityLog = {
      ...log,
      id: ++this.seq,
      createdAt: new Date().toISOString(),
    };
    this.logs.push(entry);
    return entry;
  }

  listForSpace(spaceId: string, limit = 100): ActivityLog[] {
    return this.logs
      .filter((l) => l.spaceId === spaceId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  listAll(limit = 200): ActivityLog[] {
    return [...this.logs].sort((a, b) => b.id - a.id).slice(0, limit);
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
