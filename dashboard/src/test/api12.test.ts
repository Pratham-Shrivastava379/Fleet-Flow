import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  alerts,
  activeTrips,
  updateAlert,
  trips,
  createExport,
  getExport,
  recentExports,
  downloadExport,
  vehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  geofences,
  createGeofence,
  updateGeofence,
  deleteGeofence,
  geofenceHistory,
  adminUsers,
  updateAdminUser,
  auditLogs,
} from "../api/api";
import { setAccessToken, clearAccessToken } from "../api/tokenStore";

/**
 * Phase 12 (§7.2): unit tests for the dashboard's API client — alerts triage,
 * trips + async CSV exports, vehicles, geofences, user administration, audit
 * log. Every function goes through apiRequest (X-Client: web + cookie refresh,
 * covered by httpClient.test.ts), so here we lock the contract: URL + method +
 * JSON body + response mapping per endpoint.
 */

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

const lastCall = () => calls[calls.length - 1];

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

describe("alerts (§7.2 item 1)", () => {
  it("builds the status/type filter query and returns items", async () => {
    handler = (url) => {
      expect(url).toContain("/api/alerts?");
      expect(url).toContain("status=OPEN");
      expect(url).toContain("type=SOS");
      expect(url).toContain("page=1");
      expect(url).toContain("pageSize=50");
      return jsonResponse(200, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
        pages: 0,
      });
    };
    const res = await alerts({ status: "OPEN", type: "SOS" });
    expect(res.items).toEqual([]);
  });

  it("PATCHes triage status with a JSON body", async () => {
    setAccessToken("tok");
    handler = () => jsonResponse(200, { id: 7, status: "ACKNOWLEDGED" });
    const res = await updateAlert(7, "ACKNOWLEDGED");
    const call = lastCall();
    expect(call.url).toBe("/api/alerts/7");
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(String(call.init.body))).toEqual({
      status: "ACKNOWLEDGED",
    });
    expect(res.status).toBe("ACKNOWLEDGED");
  });
});

describe("trips + CSV export (§7.2 items 2–3)", () => {
  it("lists trips with status filter", async () => {
    handler = (url) => {
      expect(url).toContain("/api/trips?");
      expect(url).toContain("status=COMPLETED");
      return jsonResponse(200, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pages: 0,
      });
    };
    const res = await trips({ status: "COMPLETED" });
    expect(res.total).toBe(0);
  });

  it("clamps the live-fleet page size to the API maximum", async () => {
    handler = (url) => {
      expect(url).toBe("/api/trips?status=ACTIVE&page=1&pageSize=100");
      return jsonResponse(200, {
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
        pages: 0,
      });
    };

    expect(await activeTrips(500)).toEqual([]);
  });

  it("enqueues an export (POST /api/reports) and returns the job", async () => {
    handler = (url, init) => {
      expect(url).toBe("/api/reports");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        type: "TRIPS_CSV",
        params: { status: "COMPLETED" },
      });
      return jsonResponse(202, {
        job: { id: 12, type: "TRIPS_CSV", status: "PENDING" },
      });
    };
    const { job } = await createExport("TRIPS_CSV", { status: "COMPLETED" });
    expect(job.id).toBe(12);
    expect(job.status).toBe("PENDING");
  });

  it("polls a job and lists the caller's recent exports", async () => {
    handler = (url) => {
      if (url === "/api/reports/12")
        return jsonResponse(200, {
          job: {
            id: 12,
            type: "TRIPS_CSV",
            status: "DONE",
            resultUrl: "/api/reports/12/download",
          },
        });
      expect(url).toBe("/api/reports?pageSize=20");
      return jsonResponse(200, { items: [] });
    };
    const { job } = await getExport(12);
    expect(job.status).toBe("DONE");
    const list = await recentExports();
    expect(list.items).toEqual([]);
  });

  it("downloadExport fetches the artifact as text with the Bearer token", async () => {
    setAccessToken("tok-dl");
    handler = (url, init) => {
      expect(url).toBe("/api/reports/12/download");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok-dl");
      return new Response("trip_id\n1\n", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    };
    const csv = await downloadExport(12);
    expect(csv).toContain("trip_id");
  });

  it("downloadExport refreshes on 401 and retries once", async () => {
    setAccessToken("stale");
    let refreshUsed = false;
    handler = (url, init) => {
      if (url === "/api/auth/refresh") {
        refreshUsed = true;
        return jsonResponse(200, { accessToken: "fresh" });
      }
      const headers = init.headers as Record<string, string>;
      if (headers["Authorization"] === "Bearer fresh")
        return new Response("a,b\n1,2\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      return jsonResponse(401, { error: "Invalid or expired access token" });
    };
    const csv = await downloadExport(12);
    expect(refreshUsed).toBe(true);
    expect(csv).toContain("a,b");
  });
});

describe("vehicles (§7.2 item 4)", () => {
  it("lists, creates and patches vehicles (incl. clearing default driver)", async () => {
    handler = (url, init) => {
      if (url === "/api/vehicles" && init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          plate: "KA-01",
          model: "Nexon",
        });
        return jsonResponse(201, { id: 3, plate: "KA-01", model: "Nexon" });
      }
      if (url === "/api/vehicles/3" && init.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({
          defaultDriverId: null,
        });
        return jsonResponse(200, { id: 3, defaultDriverId: null });
      }
      expect(url).toBe("/api/vehicles");
      return jsonResponse(200, { items: [] });
    };
    await vehicles();
    const created = await createVehicle({ plate: "KA-01", model: "Nexon" });
    expect(created.id).toBe(3);
    const patched = await updateVehicle(3, { defaultDriverId: null });
    expect(patched.defaultDriverId).toBeNull();
  });

  it("DELETE returns undefined on 204 (soft delete)", async () => {
    handler = () => new Response(null, { status: 204 });
    const res = await deleteVehicle(9);
    expect(res).toBeUndefined();
  });
});

describe("geofences (§7.2 item 5)", () => {
  it("creates, patches and soft-deletes a fence", async () => {
    handler = (url, init) => {
      if (url === "/api/geofences" && init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          name: "Depot",
          centerLat: 12.97,
          centerLng: 77.59,
          radiusM: 500,
          alertOnEnter: true,
        });
        return jsonResponse(201, { id: 5, name: "Depot", active: true });
      }
      if (url === "/api/geofences/5" && init.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ active: false });
        return jsonResponse(200, { id: 5, active: false });
      }
      if (url === "/api/geofences/5" && init.method === "DELETE") {
        return jsonResponse(200, { id: 5, active: false });
      }
      return jsonResponse(200, { items: [] });
    };
    await geofences();
    const g = await createGeofence({
      name: "Depot",
      centerLat: 12.97,
      centerLng: 77.59,
      radiusM: 500,
      alertOnEnter: true,
    });
    expect(g.id).toBe(5);
    await updateGeofence(5, { active: false });
    const gone = await deleteGeofence(5);
    expect(gone.active).toBe(false);
  });

  it("fetches a fence's enter/exit history with page + type filters", async () => {
    handler = (url) => {
      expect(url).toContain("/api/geofences/5/history?");
      expect(url).toContain("vehicleId=2");
      expect(url).toContain("eventType=ENTER");
      expect(url).toContain("page=2");
      expect(url).toContain("pageSize=10");
      return jsonResponse(200, {
        fence: {
          id: 5,
          name: "Depot",
          active: false,
          centerLat: 12.97,
          centerLng: 77.59,
          radiusM: 500,
          alertOnEnter: true,
          alertOnExit: false,
          createdAt: "2026-09-04T00:00:00Z",
        },
        items: [
          {
            id: 9,
            eventType: "ENTER",
            occurredAt: "2026-09-05T09:00:00Z",
            createdAt: "2026-09-05T09:00:00Z",
            vehicle: { id: 2, plate: "KA-01", model: "Nexon" },
            trip: { id: 4, driver: { id: 1, name: "Driver A" } },
          },
        ],
        page: 2,
        pageSize: 10,
        total: 11,
        pages: 2,
      });
    };
    const res = await geofenceHistory(5, {
      page: 2,
      pageSize: 10,
      vehicleId: 2,
      eventType: "ENTER",
    });
    expect(res.fence.name).toBe("Depot");
    expect(res.items[0].vehicle?.plate).toBe("KA-01");
    expect(res.items[0].trip?.driver?.name).toBe("Driver A");
    expect(res.total).toBe(11);
    expect(res.pages).toBe(2);
  });
});

describe("user administration + audit (§7.2 items 6–7)", () => {
  it("lists users with search/filters and PATCHes role/deactivation", async () => {
    handler = (url, init) => {
      if (url.startsWith("/api/users-admin?") && init.method === "GET") {
        expect(url).toContain("q=alice");
        expect(url).toContain("role=DRIVER");
        expect(url).toContain("includeDeactivated=true");
        return jsonResponse(200, {
          items: [],
          total: 0,
          page: 1,
          pageSize: 100,
          pages: 0,
        });
      }
      expect(url).toBe("/api/users-admin/4");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(String(init.body))).toEqual({ deactivated: true });
      return jsonResponse(200, { id: 4, status: "DEACTIVATED" });
    };
    const list = await adminUsers({
      q: "alice",
      role: "DRIVER",
      includeDeactivated: true,
      pageSize: 100,
    });
    expect(list.total).toBe(0);
    const user = await updateAdminUser(4, { deactivated: true });
    expect(user.status).toBe("DEACTIVATED");
  });

  it("queries the audit log with filters", async () => {
    handler = (url) => {
      expect(url).toContain("/api/audit-logs?");
      expect(url).toContain("action=USER_ROLE_CHANGED");
      expect(url).toContain("actorId=1");
      expect(url).toContain("pageSize=25");
      return jsonResponse(200, {
        items: [
          {
            id: 1,
            actorId: 1,
            action: "USER_ROLE_CHANGED",
            target: "user:2",
            detail: "DRIVER -> FLEET_MANAGER",
            createdAt: "2026-09-04T00:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      });
    };
    const res = await auditLogs({ action: "USER_ROLE_CHANGED", actorId: 1 });
    expect(res.items[0].action).toBe("USER_ROLE_CHANGED");
  });
});
