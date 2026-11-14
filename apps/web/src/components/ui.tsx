import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Shared UI primitives (Module 13).
 *
 * Every page composes these instead of re-declaring card headers, badges,
 * empty states or dialogs, so spacing, focus behaviour and status colours stay
 * identical across the application.
 */

// -- page header --------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="page-title">{title}</h1>
          {badge}
        </div>
        {description && <p className="page-subtitle">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// -- status -------------------------------------------------------------------

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const STATUS_TONES: Record<string, StatusTone> = {
  ACTIVE: 'success',
  AVAILABLE: 'success',
  APPROVED: 'success',
  ACCEPTED: 'success',
  VERIFIED: 'success',
  SUCCEEDED: 'success',
  COMPLETED: 'success',
  WARNING: 'warning',
  PENDING: 'warning',
  RUNNING: 'info',
  CREATING: 'info',
  ARCHIVING: 'info',
  DRAFT: 'neutral',
  ARCHIVED: 'neutral',
  DELETED: 'neutral',
  REVOKED: 'neutral',
  EXPIRED: 'neutral',
  WITHDRAWN: 'neutral',
  FAILED: 'danger',
  ARCHIVE_FAILED: 'danger',
  PARTIAL_FAILED: 'danger',
  REJECTED: 'danger',
  DECLINED: 'danger',
  SUSPENDED: 'danger',
  UNAVAILABLE: 'danger',
};

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'badge-neutral',
};

const DOT_CLASS: Record<StatusTone, string> = {
  success: 'status-dot-success',
  warning: 'status-dot-warning',
  danger: 'status-dot-danger',
  info: 'status-dot-info',
  neutral: 'status-dot-neutral',
};

/** Readable label for a backend status value (`ARCHIVE_FAILED` → `Archive failed`). */
export function statusLabel(status: string): string {
  const lower = status.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Status pill. Colour is paired with a dot and the text label, so status is
 * still clear without colour perception (accessibility requirement).
 */
export function StatusBadge({
  status,
  tone,
  label,
}: {
  status: string;
  tone?: StatusTone;
  label?: string;
}) {
  const resolved = tone ?? STATUS_TONES[status.toUpperCase()] ?? 'neutral';
  return (
    <span className={TONE_CLASS[resolved]}>
      <span className={DOT_CLASS[resolved]} aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}

// -- empty + loading ----------------------------------------------------------

export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon name={icon} size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {description && <p className="empty-text">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingRows({ rows = 3, className = 'h-10' }: { rows?: number; className?: string }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className={`skeleton w-full rounded-lg ${className}`} />
      ))}
    </div>
  );
}

// -- modal --------------------------------------------------------------------

/**
 * Accessible modal: labelled by its title, closes on Escape and backdrop click,
 * moves focus into the panel on open, restores it on close, and locks page
 * scroll. Mobile uses a bottom sheet so actions stay reachable.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  dismissable = true,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  dismissable?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first focusable control inside the panel.
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-autofocus-skip]), [href]',
    );
    focusable?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
      restoreRef.current?.focus?.();
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissable) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && <p className="modal-body">{description}</p>}
          </div>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="btn-icon -mr-1 -mt-1 h-8 w-8"
              data-autofocus-skip
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        {children && <div className="mt-3">{children}</div>}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}

// -- misc ---------------------------------------------------------------------

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const dims = size === 'sm' ? 'h-6 w-6 text-[10px]' : size === 'lg' ? 'h-10 w-10 text-[13px]' : 'h-8 w-8 text-[11px]';
  return (
    <span
      className={`flex flex-shrink-0 items-center justify-center rounded-full bg-flash-100 font-semibold text-flash-700 ${dims}`}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Toolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-card border border-line bg-white p-2.5 shadow-xs ${className}`}>
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {description && <p className="mt-0.5 text-support text-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
