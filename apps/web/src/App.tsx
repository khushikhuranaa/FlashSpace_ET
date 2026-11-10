import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api';
import type { AuthUser } from './types';
import { parseHash, type Route } from './lib/router';
import AppShell from './components/AppShell';
import { ToastProvider } from './components/ToastProvider';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MySpaces from './pages/MySpaces';
import SpaceDetail from './pages/SpaceDetail';
import Vault from './pages/Vault';
import Notifications from './pages/Notifications';
import Admin from './pages/Admin';
import ProfilePage from './pages/Profile';
import JoinPage from './pages/JoinPage';
import StorageInsights from './pages/StorageInsights';

const SIGNED_IN_HOME = '/dashboard';

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(!!getToken());
  const history = useRef<string[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Pages that mark notifications read can publish the new count so the badges
  // in the shell update without a full refresh.
  useEffect(() => {
    const onUnread = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      if (typeof detail === 'number') setUnreadCount(detail);
    };
    window.addEventListener('flashspace:unread', onUnread);
    return () => window.removeEventListener('flashspace:unread', onUnread);
  }, []);

  // Signed-in visitors never see the marketing page: `/` means the dashboard.
  useEffect(() => {
    if (user && route.page === 'landing') {
      window.location.hash = SIGNED_IN_HOME;
    }
  }, [user, route.page]);

  useEffect(() => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => {
        setUser(r.user);
        return r.user;
      })
      .then(() => api.notificationsUnread().then((n) => setUnreadCount(n.unread)))
      .catch(() => {
        api.logout();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [route.page]);

  /** Navigate and remember the target unless the caller is going back. */
  const go = (to: string, { remember = true }: { remember?: boolean } = {}) => {
    const target = to.startsWith('/') ? to : `/${to}`;
    if (remember) {
      const stack = history.current;
      if (stack[stack.length - 1] !== target) stack.push(target);
      if (stack.length > 40) stack.shift();
    }
    window.location.hash = target;
  };

  const navigate = (to: string) => go(to);

  const goBack = () => {
    const stack = history.current;
    if (stack.length <= 1) {
      go(user ? SIGNED_IN_HOME : '/', { remember: false });
      return;
    }
    stack.pop();
    const previous = stack[stack.length - 1] ?? (user ? SIGNED_IN_HOME : '/');
    go(previous, { remember: false });
  };

  const signOut = () => {
    api.logout();
    setUser(null);
    setUnreadCount(0);
    history.current = [];
    go('/', { remember: false });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface text-sm text-muted">
        Loading…
      </div>
    );
  }

  if (!user) {
    if (route.page === 'login') {
      return (
        <Login
          onAuthenticated={(u) => {
            setUser(u);
            history.current = [SIGNED_IN_HOME];
          }}
          navigate={navigate}
        />
      );
    }
    return <Landing onEnter={() => navigate('/login')} />;
  }

  const shell = (children: React.ReactNode) => (
    <AppShell
      user={user}
      route={route}
      navigate={navigate}
      goBack={goBack}
      canGoBack={history.current.length > 1}
      onSignOut={signOut}
      unread={unreadCount}
    >
      {children}
    </AppShell>
  );

  switch (route.page) {
    case 'spaces':
      return shell(
        <SpaceDetail
          id={route.param!}
          user={user}
          navigate={navigate}
          goBack={goBack}
          tab={route.sub}
        />,
      );
    case 'insights':
      return shell(<StorageInsights id={route.param!} user={user} goBack={goBack} />);
    case 'my-spaces':
      return shell(<MySpaces user={user} navigate={navigate} />);
    case 'profile':
      return shell(<ProfilePage user={user} onUserUpdated={setUser} />);
    case 'vault':
      return shell(<Vault navigate={navigate} />);
    case 'notifications':
      return shell(<Notifications navigate={navigate} />);
    case 'admin':
      return shell(<Admin />);
    case 'join':
      return shell(<JoinPage token={route.param!} user={user} navigate={navigate} goBack={goBack} />);
    case 'dashboard':
    default:
      return shell(<Dashboard user={user} navigate={navigate} />);
  }
}
