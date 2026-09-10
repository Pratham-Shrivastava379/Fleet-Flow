import { describe, it, expect, beforeEach } from "vitest";
import {
  setAccessToken,
  getAccessToken,
  clearAccessToken,
} from "../api/tokenStore";

/** Records every touch of browser storage — the suite asserts there are NONE,
 *  which is the Phase 11 security invariant (token in memory only). */
function installStorageSpies() {
  const touches: string[] = [];
  const mkStorage = (name: string) => {
    const target: Record<string, string> = {};
    return new Proxy(target, {
      get(t, prop) {
        touches.push(`${name}.get(${String(prop)})`);
        return prop in t ? t[prop as string] : undefined;
      },
      set(t, prop, value) {
        touches.push(`${name}.set(${String(prop)})`);
        t[prop as string] = value;
        return true;
      },
      deleteProperty(t, prop) {
        touches.push(`${name}.delete(${String(prop)})`);
        delete t[prop as string];
        return true;
      },
    });
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: mkStorage("localStorage"),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: mkStorage("sessionStorage"),
  });
  return touches;
}

describe("tokenStore (in-memory access token)", () => {
  let touches: string[];
  beforeEach(() => {
    clearAccessToken();
    touches = installStorageSpies();
  });

  it("stores and clears the token in memory only", () => {
    expect(getAccessToken()).toBeNull();
    setAccessToken("tok-123");
    expect(getAccessToken()).toBe("tok-123");
    clearAccessToken();
    expect(getAccessToken()).toBeNull();
  });

  it("never touches localStorage or sessionStorage", () => {
    setAccessToken("tok-abc");
    expect(getAccessToken()).toBe("tok-abc");
    clearAccessToken();
    expect(touches).toEqual([]);
  });
});
