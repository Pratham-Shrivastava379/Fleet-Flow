import { z } from "zod";

export const ROLES = ["ADMIN", "FLEET_MANAGER", "DRIVER"];
export const TRIP_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"];
export const ALERT_TYPES = ["SOS", "HARSH_BRAKING", "OVERSPEED", "GEOFENCE_ENTER", "GEOFENCE_EXIT", "CRASH_DETECTED"];
export const ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"];

// Phase 10: max pings per batch-sync request (client chunks around this).
export const MAX_PING_BATCH = 500;

export const registerSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(72),
    name: z.string().min(2).max(80),
    // role intentionally absent: registration always creates DRIVER (Phase 2)
  }),
};

export const forgotPasswordSchema = {
  body: z.object({ email: z.string().email() }),
};

export const resetPasswordSchema = {
  body: z.object({
    token: z.string().min(16),
    password: z.string().min(8).max(72),
  }),
};

export const inviteSchema = {
  body: z.object({
    email: z.string().email(),
    role: z.enum(["FLEET_MANAGER", "ADMIN"]),
    // §5: non-production opt-in for local CLI relay — the raw invite token is
    // echoed back ONLY when this flag is set AND the server is not production.
    includeInviteToken: z.boolean().optional(),
  }),
};

export const acceptInviteSchema = {
  body: z.object({
    inviteToken: z.string().min(16),
    password: z.string().min(8).max(72),
    name: z.string().min(2).max(80),
  }),
};

export const loginSchema = {
  body: z.object({ email: z.string().email(), password: z.string().min(1) }),
};

export const refreshSchema = {
  // Phase 11 (§5.4): for web clients (`X-Client: web`) the refresh token comes
  // from the HttpOnly cookie, not the body — so body is optional. The route
  // returns 401 "Missing refresh token" when neither source provides one
  // (web: no cookie; mobile: no body token — a 401 is more correct than a 422).
  body: z.object({ refreshToken: z.string().min(10).optional() }),
};

export const VEHICLE_STATUSES = ["ACTIVE", "IN_MAINTENANCE", "RETIRED"];

export const vehicleSchema = {
  body: z.object({ plate: z.string().min(3).max(20), model: z.string().min(1).max(60) }),
};

export const vehicleUpdateSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      plate: z.string().min(3).max(20).optional(),
      model: z.string().min(1).max(60).optional(),
      status: z.enum(VEHICLE_STATUSES).optional(),
      // Phase 12 (§7.2 item 4): the "assign driver" affordance + maintenance
      // note. null clears the assignment/note.
      defaultDriverId: z.number().int().positive().nullable().optional(),
      maintenanceNote: z.string().max(2000).nullable().optional(),
    })
    .refine(
      (b) =>
        b.model !== undefined ||
        b.status !== undefined ||
        b.plate !== undefined ||
        b.defaultDriverId !== undefined ||
        b.maintenanceNote !== undefined,
      { message: "At least one of plate/model/status/defaultDriverId/maintenanceNote must be provided" },
    ),
};

export const tripStartSchema = {
  body: z.object({ vehicleId: z.number().int().positive() }),
};

export const pingSchema = {
  params: z.object({ tripId: z.coerce.number().int().positive() }),
  body: z.object({
    idempotencyKey: z.string().uuid(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKmh: z.number().min(0).max(300).default(0),
    headingDeg: z.number().min(0).max(360).default(0),
    accuracyM: z.number().min(0).max(10000).default(0),
    recordedAt: z.coerce.date(),
  }),
};

/**
 * Phase 10 (blueprint §3.6/§4.2): offline batch sync. Same per-item contract as
 * pingSchema; the array itself is capped (MAX_PING_BATCH) — the client chunks.
 */
export const pingBatchSchema = {
  params: z.object({ tripId: z.coerce.number().int().positive() }),
  body: z.object({
    pings: z.array(pingSchema.body).min(1).max(MAX_PING_BATCH),
  }),
};

export const tripQuerySchema = {
  query: z.object({
    status: z.enum(TRIP_STATUSES).optional(),
    driverId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
};

export const alertCreateSchema = {
  body: z.object({
    tripId: z.number().int().positive().optional(),
    type: z.enum(ALERT_TYPES),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    detail: z.string().max(500).optional(),
  }),
};

export const alertUpdateSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED"]) }),
};

export const geofenceSchema = {
  body: z.object({
    name: z.string().min(1).max(80),
    centerLat: z.number().min(-90).max(90),
    centerLng: z.number().min(-180).max(180),
    radiusM: z.number().min(10).max(100000),
    // Phase 5: whether a crossing should also raise a GEOFENCE_ENTER/EXIT
    // Alert. GeofenceEvent audit rows are written for every crossing either
    // way (blueprint §6.3 — audit trail and paging are separate concerns).
    alertOnEnter: z.boolean().optional(),
    alertOnExit: z.boolean().optional(),
  }),
};

export const geofenceUpdateSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: z.string().min(1).max(80).optional(),
      centerLat: z.number().min(-90).max(90).optional(),
      centerLng: z.number().min(-180).max(180).optional(),
      radiusM: z.number().min(10).max(100000).optional(),
      active: z.boolean().optional(),
      alertOnEnter: z.boolean().optional(),
      alertOnExit: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message:
        "At least one of name, centerLat, centerLng, radiusM, active, alertOnEnter, alertOnExit must be provided",
    }),
};

export const geofenceParamsSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }),
};

/**
 * GET /api/geofences/:id/history (blueprint §4.2 — "which vehicles
 * entered/exited, for compliance reporting"): paginated GeofenceEvent listing
 * for one fence, filterable by vehicle / event type / occurredAt window.
 * Drivers get the read-only fence list for on-device awareness (§3.5) but the
 * compliance trail is a fleet-operations view (ADMIN/FLEET_MANAGER only).
 */
export const geofenceHistorySchema = {
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    vehicleId: z.coerce.number().int().positive().optional(),
    eventType: z.enum(["ENTER", "EXIT"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  }),
};

export const geofenceCheckSchema = {
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
};

export const notificationPrefsSchema = {
  body: z.object({
    prefs: z
      .array(z.object({ type: z.enum(ALERT_TYPES), enabled: z.boolean() }))
      .min(1)
      .max(ALERT_TYPES.length),
  }),
};

export const deviceTokenSchema = {
  body: z.object({
    token: z.string().min(32).max(512),
    platform: z.enum(["ANDROID", "IOS", "WEB"]).default("ANDROID"),
  }),
};

export const AuditAction = z.enum([
  "INVITE_SENT",
  "INVITE_ACCEPTED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "ROLE_CHANGED",
  "TRIP_REAPED",
  // Phase 12 (§7.2 items 6–7): user administration + export lifecycle.
  "USER_CREATED",
  "USER_UPDATED",
  "USER_ROLE_CHANGED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "EXPORT_REQUESTED",
  "EXPORT_COMPLETED",
  "EXPORT_FAILED",
  // Phase 12 (§11.5): alert triage transitions.
  "ALERT_ACKNOWLEDGED",
  "ALERT_RESOLVED",
]);

export const auditQuerySchema = {
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    // Phase 12 (§7.3): the dashboard audit viewer filters by action/actor and
    // free-text searches the target/detail columns.
    action: AuditAction.optional(),
    actorId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().min(1).max(200).optional(),
  }),
};

// ---- Phase 12: exports (§4.2/§7.2 item 3/§6.2 ExportJob) ----

export const exportRequestSchema = {
  body: z.object({
    type: z.enum(["TRIPS_CSV", "ALERTS_CSV", "GEOFENCE_HISTORY"]),
    params: z
      .object({
        // Whitelisted against the export service's filters: status values must be
        // REAL enum spellings (an export with a bogus status would silently
        // return zero rows). TRIPS_CSV filters on trip status (ACTIVE/COMPLETED/
        // CANCELLED); ALERTS_CSV filters on alert status (OPEN/ACKNOWLEDGED/
        // RESOLVED). from/to bind startedAt (§7.2 item 3 date filters); geofenceId
        // filters the GEOFENCE_HISTORY export.
        status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED", "OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        geofenceId: z.coerce.number().int().positive().optional(),
      })
      .optional(),
  }),
};

export const exportJobParamsSchema = {
  params: z.object({ jobId: z.coerce.number().int().positive() }),
};

/** Validates against zod schemas (body/params/query). 422 with details on failure.
 *  Parsed data lands on `req.validated.<part>` (Phase 12 routes read from there);
 *  req.body/query also still carry the data for the pre-existing routes. */
export function validate(schemas) {
  return (req, res, next) => {
    const errors = [];
    const validated = {};
    for (const part of ["body", "params", "query"]) {
      const schema = schemas[part];
      if (!schema) continue;
      const parsed = schema.safeParse(req[part] ?? {});
      if (parsed.success) {
        validated[part] = parsed.data;
        // Don't overwrite req.query's getter (Express 5 compat) — merge in place
        if (part === "query") Object.assign(req.query, parsed.data);
        else req[part] = parsed.data;
      } else {
        errors.push(...parsed.error.issues.map((i) => ({ path: `${part}.${i.path.join(".")}`, message: i.message })));
      }
    }
    if (errors.length) {
      return res.status(422).json({ error: "ValidationError", details: errors });
    }
    req.validated = validated;
    next();
  };
}
