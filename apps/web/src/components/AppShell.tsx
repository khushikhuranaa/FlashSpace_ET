import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AuthUser } from '../types';
import type { Route } from '../lib/router';
import { Icon, type IconName } from './Icon';

interface NavItem {
  page: string;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { page: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { page: 'my-spaces', label: 'My Spaces', icon: 'layers' },
  { page: 'vault', label: 'Vault', icon: 'archive' },
  { page: 'notifications', label: 'Notifications', icon: 'bell' },
];

const SPACE_TABS: { sub: string; label: string; icon: IconName }[] = [
  { sub: 'overview', label: 'Overview', icon: 'grid' },
  { sub: 'files', label: 'Files', icon: 'file' },
  { sub: 'members', label: 'Members', icon: 'users' },
  { sub: 'extensions', label: 'Extensions', icon: 'clock' },
  { sub: 'activity', label: 'Activity', icon: 'activity' },
  { sub: 'settings', label: 'Settings', icon: 'sliders' },
];

const PAGE_TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  'my-spaces': 'My Spaces',
  profile: 'Profile',
  vault: 'Vault',
  notifications: 'Notifications',
  admin: 'Admin',
  insights: 'Storage insights',
  login: 'Sign in',
  join: 'Join a Space',
};

interface SpaceMeta {
  name: string;
  role: string | null;
}

export default function AppShell({
  user,
  route,
  navigate,
  goBack,
  canGoBack,
  onSignOut,
  unread,
  children,
}: {
  user: AuthUser;
  route: Route;
  navigate: (to: string) => void;
  goBack: () => void;
  canGoBack: boolean;
  onSignOut: () => void;
  unread: number;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [space, setSpace] = useState<SpaceMeta | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = route.page === 'spaces' ? route.param : undefined;

  // The shell shows the current Space's name and the viewer's role, so it needs
  // the same access check the Space page uses. Failures fall back to no block.
  useEffect(() => {
    if (!spaceId) {
      setSpace(null);
      return;
    }
    let cancelled = false;
    api
      .getSpace(spaceId)
      .then((data) => {
        if (!cancelled) setSpace({ name: data.space.name, role: data.space.role });
      })
      .catch(() => {
        if (!cancelled) setSpace(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  // Close the profile menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [route.page, route.param, route.sub]);

  const go = (to: string) => {
    setDrawerOpen(false);
    navigate(to);
  };

  const initials = user.displayName
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const title = space?.name ?? PAGE_TITLES[route.page] ?? 'FlashSpace';
  const activeTab = route.sub ?? 'files';
  const isAdmin = user.role === 'ADMIN';

  const sidebar = (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-slate-200/80 px-4">
        <button
          onClick={() => go('dashboard')}
          className="flex items-center gap-2.5 rounded-lg text-left"
        >
          <span className="font-display text-[15px] font-bold tracking-tight text-primary">FlashSpace</span>
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <nav className="space-y-0.5" aria-label="Main">
          {NAV_ITEMS.map((item) => {
            const active = route.page === item.page;
            return (
              <button
                key={item.page}
                onClick={() => go(item.page)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                  active ? 'bg-flash-50 text-flash-700' : 'text-muted hover:bg-slate-50 hover:text-primary'
                }`}
              >
                {active && (
                  <span className="absolute left-1 top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-flash-600" />
                )}
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.page === 'notifications' && unread > 0 && (
                  <span className="ml-auto rounded-full bg-flash-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {spaceId && (
          <div>
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                Current Space
              </span>
              <span className="max-w-[92px] truncate font-mono text-[11px] text-slate-500">
                {space?.role ?? 'ADMIN'}
              </span>
            </div>
            <nav className="space-y-0.5" aria-label="Current Space">
              {SPACE_TABS.map((tab) => {
                const active = activeTab === tab.sub;
                return (
                  <button
                    key={tab.sub}
                    onClick={() => go(`/spaces/${spaceId}/${tab.sub}`)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                      active
                        ? 'bg-flash-50 font-semibold text-flash-700'
                        : 'text-muted hover:bg-slate-50 hover:text-primary'
                    }`}
                  >
                    <Icon name={tab.icon} size={18} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 space-y-2 border-t border-slate-200/80 px-3 py-3">
        {isAdmin && (
          <button
            onClick={() => go('admin')}
            aria-current={route.page === 'admin' ? 'page' : undefined}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
              route.page === 'admin'
                ? 'bg-flash-50 font-semibold text-flash-700'
                : 'text-muted hover:bg-slate-50 hover:text-primary'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Icon name="shield" size={18} />
              <span>Admin Portal</span>
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-muted">
              Admin
            </span>
          </button>
        )}
        <div className="flex items-center gap-2.5 border-t border-slate-200/80 px-2 pt-3">
          <button
            onClick={() => go('profile')}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 text-left transition-colors hover:bg-slate-50"
            aria-label="Open profile"
          >
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-flash-600 text-[11px] font-bold text-white">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-tight text-primary">
                {user.displayName}
              </span>
              <span className="block truncate text-[11px] leading-tight text-muted">{user.email}</span>
            </span>
          </button>
          <button
            onClick={onSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
          >
            <Icon name="log-out" size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-slate-200/80 lg:block">
        {sidebar}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 w-60 shadow-xl">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-xl lg:px-8">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-slate-100 hover:text-primary lg:hidden"
          >
            <Icon name="menu" size={20} />
          </button>
          {canGoBack && (
            <button
              onClick={goBack}
              title="Back"
              aria-label="Go back"
              className="rounded-lg p-2 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
            >
              <Icon name="arrow-left" size={18} />
            </button>
          )}

          <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-bold tracking-tight text-primary">
            {title}
          </h1>

          <button
            onClick={() => go('notifications')}
            title="Notifications"
            aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
            className="relative rounded-lg p-2 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
          >
            <Icon name="bell" size={20} />
            {unread > 0 && (
              <span className="absolute right-0.5 top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          <div className="h-5 w-px bg-slate-200" />

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-slate-100"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-flash-600 text-[11px] font-bold text-white">
                {initials}
              </span>
              <span className="hidden flex-col text-left sm:flex">
                <span className="text-[13px] font-medium leading-tight text-primary">
                  {user.displayName}
                </span>
                <span className="text-[11px] leading-tight text-muted">
                  {isAdmin ? 'Administrator' : 'Member'}
                </span>
              </span>
              <Icon name="chevron-down" size={14} />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              >
                <div className="px-3 py-2">
                  <p className="truncate text-[13px] font-semibold text-primary">{user.displayName}</p>
                  <p className="truncate text-[11px] text-muted">{user.email}</p>
                </div>
                <div className="my-1 h-px bg-slate-200" />
                <button
                  role="menuitem"
                  onClick={() => go('profile')}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-medium text-primary transition-colors hover:bg-slate-50"
                >
                  <Icon name="user" size={16} />
                  Profile
                </button>
                <button
                  role="menuitem"
                  onClick={onSignOut}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50"
                >
                  <Icon name="log-out" size={16} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
