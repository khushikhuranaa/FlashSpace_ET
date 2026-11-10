import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Notification } from '../types';
import { Icon, type IconName } from '../components/Icon';
import { useToast } from '../components/ToastProvider';
import { timeAgo } from '../lib/format';

const META: Record<string, { icon: IconName; tint: string }> = {
  SPACE_CREATED: { icon: 'plus', tint: 'bg-flash-50 text-flash-700' },
  SPACE_WARNING: { icon: 'clock', tint: 'bg-amber-50 text-amber-600' },
  SPACE_ARCHIVED: { icon: 'archive', tint: 'bg-purple-50 text-purple-600' },
  SPACE_DELETED: { icon: 'trash', tint: 'bg-red-50 text-red-600' },
  MEMBER_INVITED: { icon: 'mail', tint: 'bg-flash-50 text-flash-700' },
  MEMBER_ROLE_CHANGED: { icon: 'users', tint: 'bg-slate-100 text-slate-600' },
  EXTENSION_DECIDED: { icon: 'calendar', tint: 'bg-blue-50 text-blue-600' },
  ARCHIVE_FAILED: { icon: 'alert-circle', tint: 'bg-red-50 text-red-600' },
  JOIN_REQUEST: { icon: 'user-plus', tint: 'bg-emerald-50 text-emerald-600' },
  JOIN_ACCEPTED: { icon: 'check-circle', tint: 'bg-emerald-50 text-emerald-600' },
  JOIN_DECLINED: { icon: 'x', tint: 'bg-red-50 text-red-600' },
  SCAN_READY: { icon: 'scan', tint: 'bg-flash-50 text-flash-700' },
  SCAN_FAILED: { icon: 'alert', tint: 'bg-red-50 text-red-600' },
  PLAN_CREATED: { icon: 'list', tint: 'bg-slate-100 text-slate-600' },
  PLAN_CANCELLED: { icon: 'x', tint: 'bg-slate-100 text-slate-600' },
  ARCHIVE_PLAN_CONFIRMED: { icon: 'archive', tint: 'bg-purple-50 text-purple-600' },
  ARCHIVE_PLAN_FAILED: { icon: 'alert', tint: 'bg-red-50 text-red-600' },
  DUPLICATE_FILES_REMOVED: { icon: 'trash', tint: 'bg-slate-100 text-slate-600' },
  REMINDER_SENT: { icon: 'bell', tint: 'bg-amber-50 text-amber-600' },
};

export default function Notifications({ navigate }: { navigate: (to: string) => void }) {
  const toast = useToast().toast;
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { notifications } = await api.notifications();
    setItems(notifications);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load notifications'));
  }, [load]);

  const unread = items.filter((n) => !n.readAt).length;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('flashspace:unread', { detail: unread }));
  }, [unread]);

  const markRead = async (notification: Notification) => {
    if (notification.readAt) return;
    try {
      await api.markRead(notification.id);
      setItems((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n)),
      );
    } catch {
      /* non-critical: the badge will reconcile on the next navigation */
    }
  };

  const markAll = async () => {
    try {
      await api.markAllRead();
      await load();
      toast('All notifications marked as read', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not mark notifications', 'error');
    }
  };

  const decide = async (notification: Notification, decision: 'ACCEPT' | 'DECLINE') => {
    if (!notification.joinRequestId) return;
    setBusyId(notification.id);
    try {
      await api.decideJoinRequest(notification.joinRequestId, decision);
      await api.markRead(notification.id).catch(() => undefined);
      await load();
      toast(decision === 'ACCEPT' ? 'Request accepted' : 'Request declined', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the request', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-tight text-primary">Notifications</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            {items.length === 0
              ? 'Activity from your workspaces.'
              : `${items.length} event${items.length === 1 ? '' : 's'} · ${unread} unread`}
          </p>
        </div>
        <button onClick={() => void markAll()} className="btn-secondary self-start px-3 py-2" disabled={unread === 0}>
          <Icon name="check" size={16} />
          Mark all as read
        </button>
      </section>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
          <Icon name="bell" size={40} className="mx-auto text-slate-300" />
          <p className="mt-3 text-[14px] font-medium text-primary">No notifications yet</p>
          <p className="mt-1 text-[12px] text-muted">
            Create a Space, upload a file or invite a collaborator to see activity here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((notification) => {
            const meta = META[notification.type] ?? { icon: 'bell' as IconName, tint: 'bg-slate-100 text-slate-600' };
            const actionable =
              (notification.type === 'JOIN_REQUEST' || notification.type === 'MEMBER_INVITED') &&
              Boolean(notification.joinRequestId);
            return (
              <div
                key={notification.id}
                onClick={() => void markRead(notification)}
                className={`flex items-start gap-3 rounded-xl border p-4 shadow-xs transition-colors ${
                  notification.readAt
                    ? 'border-line bg-white'
                    : 'border-flash-200 bg-flash-50/40'
                }`}
              >
                <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${meta.tint}`}>
                  <Icon name={meta.icon} size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[13px] font-semibold text-primary">{notification.title}</p>
                    <span className="flex-shrink-0 text-[11px] text-muted">
                      {timeAgo(notification.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{notification.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {notification.spaceId && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void markRead(notification);
                          navigate(`/spaces/${notification.spaceId}`);
                        }}
                        className="text-[12px] font-medium text-flash-700 hover:underline"
                      >
                        Open Space
                      </button>
                    )}
                    {actionable && (
                      <>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void decide(notification, 'ACCEPT');
                          }}
                          disabled={busyId === notification.id}
                          className="rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void decide(notification, 'DECLINE');
                          }}
                          disabled={busyId === notification.id}
                          className="rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50"
                        >
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {!notification.readAt && (
                  <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-flash-600" aria-label="Unread" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
