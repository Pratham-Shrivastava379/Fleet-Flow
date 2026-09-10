import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "../api/api";
import { AuthError } from "../api/httpClient";
import type { Role, User } from "../api/api";

interface AuthContextValue {
  user: User | null;
  /** True once the bootstrap check (me / refresh-via-cookie) has completed. */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  ready: false,
  login: async () => undefined,
  logout: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // On mount, try to restore the session. api.me() transparently attempts a
  // refresh via the HttpOnly cookie when the access token is invalid/absent
  // (apiRequest's 401 handler) - so a "remembered" browser session (cookie)
  // logs straight in. If that fails, we're unauthenticated.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await api.me();
        if (!cancelled) setUser(u);
      } catch (err) {
        // AuthError (refresh failed) => signed out. Other errors (network)
        // => stay signed out too; the login screen shows on demand.
        if (err instanceof AuthError) {
          /* expected: no valid session */
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, logout }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/** Gate a screen to authenticated fleet roles (ADR: dashboard is the
 *  manager/admin surface; §7). DRIVER accounts cannot use the dashboard. */
export function RequireRole({
  roles,
  children,
}: {
  roles: Role[];
  children: ReactNode;
}) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="auth-loading">Loading…</div>;
  if (!user || !roles.includes(user.role)) {
    return (
      <div className="auth-denied">
        Access denied — sign in as a fleet manager or admin.
      </div>
    );
  }
  return <>{children}</>;
}
