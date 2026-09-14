import { clearAccessToken, getAccessToken, setAccessToken } from "./tokenStore";

/** Web clients always identify as `web` so the backend uses cookie-based
 *  refresh-token delivery. */
const WEB_CLIENT_HEADERS = { "X-Client": "web" };

/** Thrown when a request fails authorization permanently (refresh failed). */
export class AuthError extends Error {
  constructor() {
    super("Authentication expired");
    this.name = "AuthError";
  }
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

interface ApiErrorBody {
  error?: string;
  details?: unknown;
}

/**
 * Small typed fetch wrapper.
 *
 * - Always sets `X-Client: web` (cookie-based refresh).
 * - `credentials: "same-origin"` so the HttpOnly refresh cookie is sent (the
 *   Vite proxy makes /api same-origin in dev).
 * - Attaches the in-memory access token when present.
 * - On a 401 it attempts ONE silent refresh via the HttpOnly cookie; if that
 *   succeeds it retries the original request, otherwise it clears the token
 *   and re-throws as AuthError (the UI logs the user out).
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { ...WEB_CLIENT_HEADERS };

  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const run = async (): Promise<Response> =>
    fetch(path, {
      method: options.method ?? "GET",
      headers,
      credentials: "same-origin",
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

  let res = await run();
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getAccessToken() ?? ""}`;
      res = await run();
    } else {
      clearAccessToken();
      throw new AuthError();
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body - keep default message */
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST /api/auth/refresh. On success updates the in-memory token; returns true. */
export async function tryRefresh(): Promise<boolean> {
  try {
    // The refresh token is NOT in the body for web - it is in the HttpOnly
    // cookie, sent automatically with credentials. We only need the response's
    // new access token.
    const data = (await rawRefreshJson()) as { accessToken?: string };
    if (data?.accessToken) {
      setAccessToken(data.accessToken);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function rawRefreshJson(): Promise<unknown> {
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...WEB_CLIENT_HEADERS },
    credentials: "same-origin",
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("refresh failed");
  return res.json();
}
