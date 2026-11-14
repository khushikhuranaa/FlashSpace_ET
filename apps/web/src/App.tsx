import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { parseHash, type Route } from './lib/router';
import { AuthProvider, useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import { ToastProvider } from './components/ToastProvider';
import AuthCallback from './pages/AuthCallback';
import Landing from './pages/Landing';
import { PrivacyPolicy, TermsOfService } from './pages/Legal';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import Dashboard from './pages/Dashboard';
import MySpaces from './pages/MySpaces';
import SpaceDetail from './pages/SpaceDetail';
import Vault from './pages/Vault';
import Notifications from './pages/Notifications';
import Admin from './pages/Admin';
import ProfilePage from './pages/Profile';
import Settings from './pages/Settings';
import JoinPage from './pages/JoinPage';
import StorageInsights from './pages/StorageInsights';

const SIGNED_IN_HOME = '/dashboard';

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </ToastProvider>
  );
}

function Root() {
  const { user, loading, signOut, refresh } = useAuth();
  const [route, setRoute] = useState<Route>(parseHash);
  const [unreadCount, setUnreadCount] = useState(0);
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

  // Badge count is derived from the API for the signed-in user only. Pages
  // that change the count publish `flashspace:unread`, so navigating between
  // pages does not need to refetch it every time.
  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    api
      .notificationsUnread()
      .then((n) => setUnreadCount(n.unread))
      .catch(() => undefined);
  }, [user]);

  // Signed-in visitors never see the marketing page: `/` means the dashboard.
  useEffect(() => {
    if (user && route.page === 'landing') {
      window.location.hash = SIGNED_IN_HOME;
    }
  }, [user, route.page]);

  // Auth pages belong to signed-out visitors only. A signed-in user who lands
  // on /login (old bookmark, back button, shared link) otherwise falls through
  // to the dashboard with an auth-page header, so send them home instead.
  useEffect(() => {
    if (!user) return;
    const authPages = ['login', 'register', 'forgot-password', 'reset-password', 'verify'];
    if (authPages.includes(route.page)) {
      window.location.hash = SIGNED_IN_HOME;
    }
  }, [user, route.page]);

  // Admin is a server-enforced role, but a typed URL must not even render the
  // panel for a normal member: send them to their dashboard instead.
  useEffect(() => {
    if (user && route.page === 'admin' && user.role !== 'ADMIN') {
      window.location.hash = SIGNED_IN_HOME;
    }
  }, [user, route.page]);

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

  const handleSignOut = async () => {
    await signOut();
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

  // Provider callbacks are public: they must work with or without a session.
  if (route.page === 'auth' && route.param === 'callback') {
    return <AuthCallback navigate={navigate} />;
  }

  switch (route.page) {
    // Public legal pages: required by Google's OAuth consent-screen review.
    case 'privacy':
      return <PrivacyPolicy />;
    case 'terms':
      return <TermsOfService />;
    case 'register':
      return <Register navigate={navigate} onAuthenticated={() => void refresh()} />;
    case 'forgot-password':
      return <ForgotPassword navigate={navigate} />;
    case 'reset-password':
      return <ResetPassword navigate={navigate} />;
    case 'verify':
      return <VerifyEmail navigate={navigate} />;
    default:
      break;
  }

  if (!user) {
    if (route.page === 'login') {
      return <Login navigate={navigate} onAuthenticated={() => void refresh()} />;
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
      onSignOut={() => void handleSignOut()}
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
      return shell(<ProfilePage user={user} onUserUpdated={() => undefined} navigate={navigate} />);
    case 'settings':
      return shell(<Settings user={user} navigate={navigate} onSignedOut={handleSignOut} />);
    case 'vault':
      return shell(<Vault navigate={navigate} />);
    case 'notifications':
      return shell(<Notifications navigate={navigate} />);
    case 'admin':
      return user.role === 'ADMIN' ? shell(<Admin />) : shell(<Dashboard user={user} navigate={navigate} />);
    case 'join':
      return shell(<JoinPage token={route.param!} user={user} navigate={navigate} goBack={goBack} />);
    case 'dashboard':
    default:
      return shell(<Dashboard user={user} navigate={navigate} />);
  }
}
