import { useEffect, useRef, useState } from 'react';
import type { SpaceDetail, SpaceStatus } from '../types';
import { elapsedPercent, fmtBytes, fmtDate } from '../lib/format';
import { Icon } from './Icon';

const BADGE: Record<SpaceStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 border border-slate-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  WARNING: 'bg-amber-50 text-amber-700 border border-amber-200',
  ARCHIVING: 'bg-flash-50 text-flash-700 border border-flash-200',
  ARCHIVED: 'bg-flash-50 text-flash-700 border border-flash-200',
  ARCHIVE_FAILED: 'bg-red-50 text-red-700 border border-red-200',
  DELETED: 'bg-slate-100 text-slate-500 border border-slate-200',
};

function statusLabel(space: SpaceDetail): string {
  switch (space.status) {
    case 'ARCHIVED':
      return 'Archived';
    case 'ARCHIVING':
      return 'Archiving';
    case 'ARCHIVE_FAILED':
      return 'Archive failed';
    case 'DRAFT':
      return `Starts ${fmtDate(space.startAt)}`;
    default: {
      const ms = new Date(space.expiryAt).getTime() - Date.now();
      if (ms <= 0) return 'Expired';
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      return `Expires in ${days}d ${hours}h`;
    }
  }
}

export function SpaceCard({
  space,
  onOpen,
  onArchive,
  onDelete,
  onToggleFavorite,
  canManage = false,
}: {
  space: SpaceDetail;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  /** Star toggle; the Space itself stays exactly as accessible as before. */
  onToggleFavorite?: () => void;
  canManage?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const archived = space.status === 'ARCHIVED' || space.status === 'ARCHIVING';

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const percent = Math.min(100, Math.round(elapsedPercent(space.startAt, space.expiryAt)));
  const barColor = percent > 85 ? 'bg-red-500' : percent > 60 ? 'bg-amber-500' : 'bg-flash-600';
  const activeMembers = space.members.filter((m) => m.status === 'ACTIVE').length;
  const showMenu = canManage && (onArchive || onDelete);

  return (
    <div className="relative flex flex-col justify-between gap-4 rounded-xl border border-line bg-white p-5 shadow-xs transition-colors hover:border-slate-300">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button
            onClick={onOpen}
            className="min-w-0 truncate rounded font-display text-[15px] font-semibold tracking-tight text-primary transition-colors hover:text-flash-700"
          >
            {space.name}
          </button>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {onToggleFavorite && (
              <button
                onClick={onToggleFavorite}
                aria-label={space.favorite ? `Remove ${space.name} from favourites` : `Add ${space.name} to favourites`}
                aria-pressed={Boolean(space.favorite)}
                title={space.favorite ? 'Remove from favourites' : 'Add to favourites'}
                className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                  space.favorite ? 'text-amber-500 hover:bg-amber-50' : 'text-slate-300 hover:bg-slate-100 hover:text-amber-500'
                }`}
              >
                <Icon name={space.favorite ? 'star-filled' : 'star'} size={15} />
              </button>
            )}
            <span className={`badge shrink-0 ${BADGE[space.status]}`}>{statusLabel(space)}</span>
            {showMenu && (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-slate-100 hover:text-primary"
                >
                  <Icon name="more-vertical" size={16} />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-7 z-20 w-40 rounded-lg border border-line bg-white py-1 shadow-lg"
                  >
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpen();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary hover:bg-slate-50"
                    >
                      <Icon name="external-link" size={14} />
                      Open Space
                    </button>
                    {!archived && onArchive && (
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onArchive();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary hover:bg-slate-50"
                      >
                        <Icon name="archive" size={14} />
                        Archive Space
                      </button>
                    )}
                    {onDelete && (
                      <>
                        <div className="my-1 h-px bg-line" />
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            onDelete();
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-red-600 hover:bg-red-50"
                        >
                          <Icon name="trash" size={14} />
                          Delete Space
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <p className="line-clamp-2 min-h-[36px] text-[13px] leading-relaxed text-muted">
          {space.purpose || space.description || 'No description'}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          {space.ownerName && <span>Owner: {space.ownerName}</span>}
          <span className="text-slate-300">·</span>
          <span>Created {fmtDate(space.createdAt)}</span>
          {space.lastAccessedAt && (
            <>
              <span className="text-slate-300">·</span>
              <span>Last opened {fmtDate(space.lastAccessedAt)}</span>
            </>
          )}
        </div>

        {!archived && (
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-[11px] text-muted">
              <span>Auto-archive {fmtDate(space.expiryAt)}</span>
              <span className="font-mono font-medium">{percent}% elapsed</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <Icon name="users" size={13} />
            {activeMembers}
          </span>
          <span className="text-slate-300">·</span>
          <span className="font-mono">{fmtBytes(space.storageUsedBytes)}</span>
          {space.role && (
            <>
              <span className="text-slate-300">·</span>
              <span className="uppercase tracking-wide">{space.role.toLowerCase()}</span>
            </>
          )}
        </div>
        <button onClick={onOpen} className="btn-primary px-3 py-1.5 text-[12px]">
          Open Space
        </button>
      </div>
    </div>
  );
}
