/** In-process notification fan-out for the PostgreSQL DataLayer. */
import type { Notification } from '@flashspace/shared';
import type { NotificationBusLike } from '../data-layer.interface.js';

/**
 * PostgreSQL stores notifications durably; live delivery remains an in-process
 * concern, exactly as it is for SQLite. A multi-instance deployment would put a
 * real broker behind this interface instead of pretending the bus is shared.
 */
export class PostgresNotificationBus implements NotificationBusLike {
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
