import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AuthUser } from '../types';
import type { Route } from '../lib/router';
import { Icon, type IconName } from './Icon';
import { GlobalSearch } from './GlobalSearch';

interface NavItem {
  page: string;
  label: string;
  icon: IconName;
}

/** Navigation is grouped by intent, with one icon per destination. */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: 'grid' },
      { page: 'my-spaces', label: 'My Spaces', icon: 'layers' },
    ],
  },
  {
    label: 'Storage',
    items: [
      { page: 'insights', label: 'Storage Insights', icon: 'scan' },
      { page: 'vault', label: 'Vault', icon: 'archive' },
    ],
  },
  {
    label: 'Activity',
    items: [{ page: 'notifications', label: 'Notifications', icon: 'bell' }],
  },
  {
    label: 'Account',
    items: [
      { page: 'profile', label: 'Profile', icon: 'user' },
      { page: 'settings', label: 'Settings', icon: 'sliders' },
    ],
  },
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
  settings: 'Account settings',
  register: 'Create account',
  'forgot-password': 'Reset password',
  'reset-password': 'Choose a new password',
  verify: 'Email verification',
  vault: 'Vault',
  notifications: 'Notifications',
  admin: 'Admin',
  insights: 'Storage insights',
  login: 'Sign in',
  join: 'Join a Space',
};

const SIDEBAR_KEY = 'flashspace.sidebar.collapsed';

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [space, setSpace] = useState<SpaceMeta | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = route.page === 'spaces' || route.page === 'insights' ? route.param : undefined;

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

  // Global search shortcut (⌘K / Ctrl+K).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // The mobile drawer locks the page and closes on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [route.page, route.param, route.sub]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      return next;
    });
  };

  const go = (to: string) => {
    setDrawerOpen(false);
    navigate(to);
  };

  /**
   * Storage Insights is scoped to a Space. Inside a Space it opens that Space;
   * elsewhere it opens the most recently used Space, and falls back to My
   * Spaces when the account has none yet.
   */
  const openInsights = async () => {
    if (spaceId) {
      go(`/spaces/${spaceId}/insights`);
      return;
    }
    try {
      const { spaces } = await api.listSpaces();
      const target = spaces.find((s) => s.status !== 'ARCHIVED') ?? spaces[0];
      go(target ? `/insights/${target.id}` : '/my-spaces');
    } catch {
      go('/my-spaces');
    }
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

  const isActive = (page: string): boolean => {
    if (route.page === page) return true;
    // A Space (and its tabs) belongs to My Spaces; insights belong to
    // Storage Insights. Without this, opening a Space left the sidebar with no
    // active item at all.
    if (page === 'my-spaces') return route.page === 'spaces' || route.page === 'join';
    if (page === 'insights') return route.page === 'insights';
    return false;
  };

  const crumbs = ((): { label: string; to?: string }[] => {
    const dashboard = { label: 'Dashboard', to: '/dashboard' };
    switch (route.page) {
      case 'dashboard':
        return [{ label: 'Dashboard' }];
      case 'my-spaces':
        return [dashboard, { label: 'My Spaces' }];
      case 'vault':
        return [dashboard, { label: 'Vault' }];
      case 'notifications':
        return [dashboard, { label: 'Notifications' }];
      case 'profile':
        return [dashboard, { label: 'Profile' }];
      case 'settings':
        return [dashboard, { label: 'Account settings' }];
      case 'admin':
        return [dashboard, { label: 'Admin' }];
      case 'insights':
        return [
          dashboard,
          { label: 'My Spaces', to: '/my-spaces' },
          { label: space?.name ?? 'Space' },
          { label: 'Storage insights' },
        ];
      case 'spaces':
        return [
          dashboard,
          { label: 'My Spaces', to: '/my-spaces' },
          { label: space?.name ?? 'Space' },
          { label: SPACE_TABS.find((tab) => tab.sub === activeTab)?.label ?? 'Overview' },
        ];
      default:
        return [dashboard];
    }
  })();

  const sidebar = (isDrawer: boolean) => {
    const compact = collapsed && !isDrawer;
    return (
      <div className="flex h-full flex-col bg-white">
        <div
          className={`flex h-14 flex-shrink-0 items-center border-b border-slate-200/80 ${
            compact ? 'justify-center px-2' : 'justify-between px-4'
          }`}
        >
          <button
            onClick={() => go('dashboard')}
            className="flex items-center gap-2.5 rounded-lg text-left"
            aria-label="FlashSpace dashboard"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-flash-600 text-[12px] font-bold text-white">
              F
            </span>
            {!compact && (
              <span className="font-display text-[15px] font-bold tracking-tight text-primary">FlashSpace</span>
            )}
          </button>
          {!compact && (
            <button
              onClick={isDrawer ? () => setDrawerOpen(false) : toggleCollapsed}
              title={isDrawer ? 'Close navigation' : 'Collapse sidebar'}
              aria-label={isDrawer ? 'Close navigation' : 'Collapse sidebar'}
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
            >
              <Icon name={isDrawer ? 'x' : 'arrow-left'} size={16} />
            </button>
          )}
        </div>

        <div className={`flex-1 space-y-6 overflow-y-auto py-4 ${compact ? 'px-2' : 'px-3'}`}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              {!compact && <p className="section-label mb-1.5">{group.label}</p>}
              <nav className="space-y-0.5" aria-label={group.label}>
                {group.items.map((item) => {
                  const active = isActive(item.page);
                  return (
                    <button
                      key={item.page}
                      onClick={() => (item.page === 'insights' ? void openInsights() : go(item.page))}
                      aria-current={active ? 'page' : undefined}
                      aria-label={item.label}
                      title={compact ? item.label : undefined}
                      className={`sidebar-link ${compact ? 'justify-center px-2' : ''} ${
                        active ? 'sidebar-link-active' : ''
                      }`}
                    >
                      <Icon name={item.icon} size={18} />
                      {!compact && <span>{item.label}</span>}
                      {!compact && item.page === 'notifications' && unread > 0 && (
                        <span className="ml-auto rounded-full bg-flash-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                          {unread > 9 ? '9+' : unread}
                        </span>
                      )}
                      {compact && item.page === 'notifications' && unread > 0 && (
                        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger-600" />
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>
          ))}

          {isAdmin && (
            <div>
              {!compact && <p className="section-label mb-1.5">Admin</p>}
              <nav className="space-y-0.5" aria-label="Admin">
                <button
                  onClick={() => go('admin')}
                  aria-current={route.page === 'admin' ? 'page' : undefined}
                  aria-label="Admin control panel"
                  title={compact ? 'Admin' : undefined}
                  className={`sidebar-link ${compact ? 'justify-center px-2' : ''} ${
                    route.page === 'admin' ? 'sidebar-link-active' : ''
                  }`}
                >
                  <Icon name="shield" size={18} />
                  {!compact && <span>Admin panel</span>}
                </button>
              </nav>
            </div>
          )}

          {spaceId && (
            <div>
              {!compact && (
                <div className="flex items-center justify-between px-3 pb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    Current Space
                  </span>
                  <span className="max-w-[92px] truncate font-mono text-[11px] text-slate-500">
                    {space?.role ?? 'ADMIN'}
                  </span>
                </div>
              )}
              <nav className="space-y-0.5" aria-label="Current Space">
                {SPACE_TABS.map((tab) => {
                  const active = activeTab === tab.sub;
                  return (
                    <button
                      key={tab.sub}
                      onClick={() => go(`/spaces/${spaceId}/${tab.sub}`)}
                      aria-current={active ? 'page' : undefined}
                      aria-label={tab.label}
                      title={compact ? tab.label : undefined}
                      className={`flex w-full items-center rounded-lg py-1.5 text-[13px] transition-colors ${
                        compact ? 'justify-center px-2' : 'gap-2.5 px-3'
                      } ${
                        active
                          ? 'bg-flash-50 font-semibold text-flash-700'
                          : 'text-muted hover:bg-slate-50 hover:text-primary'
                      }`}
                    >
                      <Icon name={tab.icon} size={18} />
                      {!compact && <span>{tab.label}</span>}
                    </button>
                  );
                })}
              </nav>
            </div>
          )}
        </div>

        <div className={`flex-shrink-0 space-y-2 border-t border-line py-3 ${compact ? 'px-2' : 'px-3'}`}>
          <div className={`flex items-center gap-2.5 ${compact ? 'justify-center' : 'border-t border-slate-200/80 px-2 pt-3'}`}>
            <button
              onClick={() => go('profile')}
              className={`flex min-w-0 items-center gap-2.5 rounded-lg py-1 text-left transition-colors hover:bg-slate-50 ${
                compact ? '' : 'flex-1'
              }`}
              aria-label="Open profile"
            >
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-flash-600 text-[11px] font-bold text-white">
                {initials}
              </span>
              {!compact && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold leading-tight text-primary">
                    {user.displayName}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-muted">{user.email}</span>
                </span>
              )}
            </button>
            {!compact && (
              <button
                onClick={onSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="rounded-lg p-1.5 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
              >
                <Icon name="log-out" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-surface">
      {/* Keyboard users can jump straight past the navigation. */}
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden border-r border-slate-200/80 transition-[width] duration-200 lg:block ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        {sidebar(false)}
      </aside>

      {collapsed && (
        <button
          onClick={toggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="fixed left-16 top-14 z-40 hidden -translate-x-1/2 rounded-full border border-slate-200 bg-white p-1 text-muted shadow-sm transition-colors hover:text-primary lg:block"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      )}

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="absolute inset-y-0 left-0 w-64 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            {sidebar(true)}
          </aside>
        </div>
      )}

      <div className={`transition-[padding] duration-200 ${collapsed ? 'lg:pl-16' : 'lg:pl-60'}`}>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200/80 bg-white/90 px-3 backdrop-blur-xl lg:px-8">
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
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-slate-300 hover:text-primary"
          >
            <Icon name="search" size={15} />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-slate-200 px-1 font-mono text-[10px] sm:inline">⌘K</kbd>
          </button>

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
                <span className="max-w-[140px] truncate text-[13px] font-medium leading-tight text-primary">
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
                className="absolute right-0 top-11 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              >
                <div className="px-3 py-2">
                  <p className="truncate text-[13px] font-semibold text-primary">{user.displayName}</p>
                  <p className="truncate text-[11px] text-muted">{user.email}</p>
                  <p className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">
                    {user.role}
                  </p>
                </div>
                <div className="my-1 h-px bg-slate-200" />
                <button
                  role="menuitem"
                  onClick={() => go('profile')}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-medium text-primary transition-colors hover:bg-slate-50"
                >
                  <Icon name="user" size={16} />
                  View profile
                </button>
                <button
                  role="menuitem"
                  onClick={() => go('settings')}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-medium text-primary transition-colors hover:bg-slate-50"
                >
                  <Icon name="sliders" size={16} />
                  Account settings
                </button>
                <div className="my-1 h-px bg-slate-200" />
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

        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-shell px-4 py-4 sm:px-5 lg:px-8">
          <nav aria-label="Breadcrumb" className="mb-3 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
                {index > 0 && <Icon name="chevron-right" size={12} className="flex-shrink-0 text-slate-300" />}
                {crumb.to && index < crumbs.length - 1 ? (
                  <button
                    onClick={() => navigate(crumb.to!)}
                    className="truncate transition-colors hover:text-primary hover:underline"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span
                    aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                    className={`truncate ${index === crumbs.length - 1 ? 'font-medium text-primary' : ''}`}
                  >
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <div className="pb-6">{children}</div>
        </main>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} navigate={navigate} />
    </div>
  );
}
