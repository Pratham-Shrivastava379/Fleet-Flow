import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiRequest, AuthError, tryRefresh } from "../api/httpClient";
import {
  setAccessToken,
  getAccessToken,
  clearAccessToken,
} from "../api/tokenStore";

type FetchHandler = (
  url: string,
  init: RequestInit,
) => Promise<Response> | Response;
let handler: FetchHandler | null = null;
const calls: { url: string; init: RequestInit }[] = [];

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  clearAccessToken();
  calls.length = 0;
  handler = null;
  vi.stubGlobal(
    "fetch",
    (url: string | URL | Request, init: RequestInit = {}) => {
      const u =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      calls.push({ url: u, init });
      return handler!(u, init);
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpClient (web auth contract)", () => {
  it("sends X-Client: web + Bearer token; body flows through", async () => {
    setAccessToken("tok-9");
    handler = (url, init) => {
      expect(url).toBe("/api/trips");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Client"]).toBe("web");
      expect(headers["Authorization"]).toBe("Bearer tok-9");
      return jsonResponse(200, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 500,
        pages: 0,
      });
    };
    const res = await apiRequest<{ total: number }>("/api/trips");
    expect(res.total).toBe(0);
    clearAccessToken();
  });

  it("on 401 refreshes via the cookie (no token in refresh body) and retries once", async () => {
    setAccessToken("stale");
    handler = (url, init) => {
      if (url === "/api/secure") {
        const headers = init.headers as Record<string, string>;
        if (headers["Authorization"] === "Bearer fresh") {
          return jsonResponse(200, { ok: true });
        }
        return jsonResponse(401, { error: "Invalid or expired access token" });
      }
      if (url === "/api/auth/refresh") {
        // refresh carries ONLY the HttpOnly cookie + X-Client: web
        const headers = init.headers as Record<string, string>;
        expect(headers["X-Client"]).toBe("web");
        expect(JSON.parse(String(init.body))).toEqual({});
        return jsonResponse(200, { accessToken: "fresh", user: { id: 1 } });
      }
      throw new Error("unexpected " + url);
    };
    const res = await apiRequest<{ ok: boolean }>("/api/secure");
    expect(res.ok).toBe(true);
    expect(getAccessToken()).toBe("fresh");
    // exactly: original + refresh + retried
    expect(calls.map((c) => c.url)).toEqual([
      "/api/secure",
      "/api/auth/refresh",
      "/api/secure",
    ]);
    clearAccessToken();
  });

  it("throws AuthError and clears the token when refresh also fails", async () => {
    setAccessToken("stale");
    handler = (url) => {
      if (url === "/api/auth/refresh")
        return jsonResponse(401, { error: "Missing refresh token" });
      return jsonResponse(401, { error: "nope" });
    };
    await expect(apiRequest("/api/secure")).rejects.toBeInstanceOf(AuthError);
    expect(getAccessToken()).toBeNull();
  });

  it("tryRefresh returns false when the cookie is missing/expired", async () => {
    handler = () => jsonResponse(401, { error: "Missing refresh token" });
    expect(await tryRefresh()).toBe(false);
    expect(getAccessToken()).toBeNull();
  });
});
