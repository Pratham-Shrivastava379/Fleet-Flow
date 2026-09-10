import { apiRequest, tryRefresh } from "./httpClient";
import { setAccessToken, getAccessToken, clearAccessToken } from "./tokenStore";

// ---- DTOs (mirror backend/src/middleware/validate.js + services) ----

export type Role = "ADMIN" | "FLEET_MANAGER" | "DRIVER";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface FleetLastPosition {
  vehicleId: number;
  tripId: number;
  driverId: number;
  lat: number;
  lng: number;
  speedKmh: number;
  headingDeg: number;
  recordedAt: string;
  updatedAt: string;
}

export interface Vehicle {
  id: number;
  plate: string;
  model: string;
  fleetLastPosition?: FleetLastPosition | null;
}

export interface DriverBrief {
  id: number;
  name: string;
}

export interface ActiveTrip {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  vehicle: Vehicle | null;
  driver: DriverBrief | null;
  _count?: { pings: number };
}

export interface TripsResponse {
  items: ActiveTrip[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

// ---- Auth ----

export interface LoginResult {
  user: User;
  accessToken: string;
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await apiRequest<LoginResult>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  // The access token is held ONLY in memory (never localStorage).
  setAccessToken(res.accessToken);
  return res;
}

export async function logout(): Promise<void> {
  try {
    // The refresh token lived in the HttpOnly cookie; the server clears it.
    await apiRequest<void>("/api/auth/logout", { method: "POST" });
  } finally {
    clearAccessToken();
  }
}

export async function me(): Promise<User> {
  const res = await apiRequest<{ user: User }>("/api/auth/me");
  return res.user;
}

// ---- Fleet / live map ----

/** Phase 11: active trips with each vehicle's FleetLastPosition for the map's
 *  initial paint (blueprint §15.11). Live updates then come over the WS. */
export async function activeTrips(pageSize = 100): Promise<ActiveTrip[]> {
  const safePageSize = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
  const res = await apiRequest<TripsResponse>(
    `/api/trips?status=ACTIVE&page=1&pageSize=${safePageSize}`,
  );
  return res.items;
}

// ============================ Phase 12 ============================
// Blueprint §7.2: Alerts → Trips + CSV export → Vehicles → Geofences →
// Users (ADMIN) → Audit Log (ADMIN). Same REST/WS API as the app.

// ---- Alerts (§7.2 item  1) ----

export type AlertStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export interface Alert {
  id: number;
  tripId: number | null;
  type: string;
  status: AlertStatus;
  lat: number;
  lng: number;
  detail: string;
  createdAt: string;
  raisedBy?: { id: number; name: string; role: string } | null;
  acknowledgedBy?: { id: number; name: string; role: string } | null;
  acknowledgedAt?: string | null;
  resolvedBy?: { id: number; name: string; role: string } | null;
  resolvedAt?: string | null;
}

export interface AlertsResponse {
  items: Alert[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}
export async function alerts(
  params: {
    status?: string;
    type?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<AlertsResponse> {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.type) q.set("type", params.type);
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 50));
  return apiRequest<AlertsResponse>(`/api/alerts?${q.toString()}`);
}

export async function updateAlert(
  id: number,
  status: AlertStatus,
): Promise<Alert> {
  return apiRequest<Alert>(`/api/alerts/${id}`, {
    method: "PATCH",
    body: { status },
  });
}

// ---- Trips + CSV export (§7.2 items 2–3) ----

export interface Trip extends ActiveTrip {
  distanceKmh?: number | null;
  avgSpeedKmh?: number | null;
  maxSpeedKmh?: number | null;
  durationSeconds?: number | null;
}
export async function trips(
  params: {
    status?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<TripsResponse> {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 20));
  return apiRequest<TripsResponse>(`/api/trips?${q.toString()}`);
}

export type ExportType = "TRIPS_CSV" | "ALERTS_CSV" | "GEOFENCE_HISTORY";
export type ExportStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface ExportJobRow {
  id: number;
  type: ExportType;
  status: ExportStatus;
  params: Record<string, unknown>;
  resultUrl?: string | null;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

export async function createExport(
  type: ExportType,
  params: Record<string, unknown> = {},
): Promise<{ job: ExportJobRow }> {
  return apiRequest<{ job: ExportJobRow }>("/api/reports", {
    method: "POST",
    body: { type, params },
  });
}

export async function getExport(id: number): Promise<{ job: ExportJobRow }> {
  return apiRequest<{ job: ExportJobRow }>(`/api/reports/${id}`);
}

export async function recentExports(): Promise<{ items: ExportJobRow[] }> {
  return apiRequest<{ items: ExportJobRow[] }>("/api/reports?pageSize=20");
}

// ---- Vehicles (section 7.2 item 4, fleet vehicle management) ----

export type VehicleStatus = "ACTIVE" | "IN_MAINTENANCE" | "RETIRED";

export interface VehicleRow {
  id: number;
  plate: string;
  model: string;
  status: VehicleStatus;
  defaultDriverId?: number | null;
  maintenanceNote?: string | null;
  deletedAt?: string | null;
  fleetLastPosition?: FleetLastPosition | null;
}

export async function vehicles(): Promise<{ items: VehicleRow[] }> {
  return apiRequest<{ items: VehicleRow[] }>("/api/vehicles");
}

export async function createVehicle(body: {
  plate: string;
  model: string;
}): Promise<VehicleRow> {
  return apiRequest<VehicleRow>("/api/vehicles", { method: "POST", body });
}

export async function updateVehicle(
  id: number,
  body: Partial<{
    plate: string;
    model: string;
    status: VehicleStatus;
    defaultDriverId: number | null;
    maintenanceNote: string;
  }>,
): Promise<VehicleRow> {
  return apiRequest<VehicleRow>(`/api/vehicles/${id}`, {
    method: "PATCH",
    body,
  });
}

export async function deleteVehicle(id: number): Promise<void> {
  return apiRequest<void>(`/api/vehicles/${id}`, { method: "DELETE" });
}

// ---- Geofences (section 7.2 item 5, fence authoring) ----

export interface Geofence {
  id: number;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  active: boolean;
  alertOnEnter: boolean;
  alertOnExit: boolean;
  createdAt: string;
}

export async function geofences(): Promise<{ items: Geofence[] }> {
  return apiRequest<{ items: Geofence[] }>("/api/geofences");
}

export async function createGeofence(body: {
  name: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  alertOnEnter?: boolean;
  alertOnExit?: boolean;
}): Promise<Geofence> {
  return apiRequest<Geofence>("/api/geofences", { method: "POST", body });
}

export async function updateGeofence(
  id: number,
  body: Partial<{
    name: string;
    centerLat: number;
    centerLng: number;
    radiusM: number;
    active: boolean;
    alertOnEnter: boolean;
    alertOnExit: boolean;
  }>,
): Promise<Geofence> {
  return apiRequest<Geofence>(`/api/geofences/${id}`, {
    method: "PATCH",
    body,
  });
}

export async function deleteGeofence(
  id: number,
): Promise<{ id: number; active: false }> {
  return apiRequest<{ id: number; active: false }>(`/api/geofences/${id}`, {
    method: "DELETE",
  });
}

// ---- Geofence history (§4.2/§7.2 item 5: per-fence enter/exit compliance trail) ----

export interface GeofenceEventRow {
  id: number;
  eventType: "ENTER" | "EXIT";
  occurredAt: string;
  createdAt: string;
  vehicle: { id: number; plate: string; model: string } | null;
  trip: { id: number; driver: { id: number; name: string } | null } | null;
}

export interface GeofenceHistoryResponse {
  fence: Geofence & { active: boolean };
  items: GeofenceEventRow[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export async function geofenceHistory(
  id: number,
  params: {
    page?: number;
    pageSize?: number;
    vehicleId?: number;
    eventType?: "ENTER" | "EXIT";
    from?: string;
    to?: string;
  } = {},
): Promise<GeofenceHistoryResponse> {
  const q = new URLSearchParams();
  if (params.vehicleId) q.set("vehicleId", String(params.vehicleId));
  if (params.eventType) q.set("eventType", params.eventType);
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 20));
  return apiRequest<GeofenceHistoryResponse>(
    `/api/geofences/${id}/history?${q.toString()}`,
  );
}

export async function checkGeofence(
  lat: number,
  lng: number,
): Promise<{
  results: {
    id: number;
    name: string;
    radiusM: number;
    distanceM: number;
    inside: boolean;
  }[];
}> {
  return apiRequest("/api/geofences/check", {
    method: "POST",
    body: { lat, lng },
  });
}

// ---- User administration (ADMIN, section 7.2 item 6) ----

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: "ACTIVE" | "DEACTIVATED";
  createdAt: string;
}

export interface UsersResponse {
  items: AdminUser[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export async function adminUsers(
  params: {
    q?: string;
    role?: string;
    status?: string;
    includeDeactivated?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<UsersResponse> {
  const q = new URLSearchParams();
  if (params.q) q.set("q", params.q);
  if (params.role) q.set("role", params.role);
  if (params.status) q.set("status", params.status);
  if (params.includeDeactivated) q.set("includeDeactivated", "true");
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 20));
  return apiRequest<UsersResponse>(`/api/users-admin?${q.toString()}`);
}

export async function updateAdminUser(
  id: number,
  body: Partial<{ name: string; role: Role; deactivated: boolean }>,
): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/api/users-admin/${id}`, {
    method: "PATCH",
    body,
  });
}

export async function createDriver(body: {
  name: string;
  email: string;
  password: string;
}): Promise<AdminUser> {
  return apiRequest<AdminUser>("/api/users-admin", {
    method: "POST",
    body,
  });
}

// ---- Audit Log (ADMIN, section 7.2 item 7 / section 7.3) ----

export interface AuditEntry {
  id: number;
  actorId: number | null;
  action: string;
  target: string;
  detail: string;
  createdAt: string;
  actor?: { id: number; email: string; role: string } | null;
}

export interface AuditResponse {
  items: AuditEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export async function auditLogs(
  params: {
    action?: string;
    actorId?: number;
    q?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<AuditResponse> {
  const q = new URLSearchParams();
  if (params.action) q.set("action", params.action);
  if (params.actorId) q.set("actorId", String(params.actorId));
  if (params.q) q.set("q", params.q);
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 25));
  return apiRequest<AuditResponse>(`/api/audit-logs?${q.toString()}`);
}

/** Download a DONE export artifact as text (CSV). Requires auth; uses the same
 *  cookie-refresh path as apiRequest, but returns the raw text body. */
export async function downloadExport(id: number): Promise<string> {
  const headers: Record<string, string> = { "X-Client": "web" };
  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res = await fetch(`/api/reports/${id}/download`, {
    headers,
    credentials: "same-origin",
  });
  if (res.status === 401 && (await tryRefresh())) {
    headers["Authorization"] = `Bearer ${getAccessToken() ?? ""}`;
    res = await fetch(`/api/reports/${id}/download`, {
      headers,
      credentials: "same-origin",
    });
  }
  if (!res.ok) {
    let msg = `Export download failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* non-JSON */
    }
    throw new Error(msg);
  }
  return res.text();
}
