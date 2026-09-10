/**
 * In-memory access-token store (blueprint §5.4).
 *
 * The browser SPA never persists the access token anywhere JS-accessible
 * storage (no localStorage / sessionStorage / cookies) - only in a module-level
 * variable, so an XSS exfiltration has nothing to steal. Anything more
 * persistent (the refresh token) lives server-side in an HttpOnly cookie that
 * JS cannot read.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/** True when nothing about this token is stored in any browser storage. */
export function usesBrowserStorage(): boolean {
  // Never reference window.localStorage/sessionStorage anywhere in this module.
  return false;
}
