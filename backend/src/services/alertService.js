import { prisma } from "../prisma.js";
import { publishFleetEvent, fleetEventTopics } from "../lib/events.js";
import { notificationsQueue } from "../jobs/queues.js";
import * as audit from "./auditService.js";
import { getContextLogger, getRequestId } from "../lib/logger.js";

/** Topics for an alert: fleet-wide + the driver/vehicle of its trip (if any). */
async function alertTopics(alert) {
  if (!alert.tripId) return fleetEventTopics();
  const trip = await prisma.trip.findUnique({
    where: { id: alert.tripId },
    select: { driverId: true, vehicleId: true },
  });
  return fleetEventTopics({ driverId: trip?.driverId ?? null, vehicleId: trip?.vehicleId ?? null });
}

export async function createAlert(user, data) {
  if (data.tripId) {
    const trip = await prisma.trip.findUnique({ where: { id: data.tripId } });
    if (!trip) throw Object.assign(new Error("Trip not found"), { status: 404, publicMessage: "Trip not found" });
    if (user.role === "DRIVER" && trip.driverId !== user.id) {
      throw Object.assign(new Error("forbidden"), { status: 403, publicMessage: "Not your trip" });
    }
  }
  const alert = await prisma.alert.create({
    data: {
      ...data,
      // Phase 12 (§6.2 triage metadata): who raised it (driver SOS / system
      // geofence alerts pass null — geofenceEval calls this without a user).
      raisedById: user?.id ?? null,
    },
  });
  // SOS etc. reach managers instantly (via fleet:events Redis fan-out, §4.3)
  publishFleetEvent({ type: "alert", payload: alert, topics: await alertTopics(alert) });
  // Phase 7: push/SMS dispatch happens in the background worker (§307) —
  // enqueue is fire-and-forget; a failed enqueue must not fail the alert.
  // Phase 13: carry the requestId onto the job so the worker's dispatch log
  // line + trace span tie back to the request that raised the alert (§11.1).
  notificationsQueue
    .add(
      "dispatch",
      { alertId: alert.id, requestId: getRequestId() || null },
      { removeOnComplete: 100, removeOnFail: 100 },
    )
    .catch((err) =>
      getContextLogger({ module: "notifications" }).warn({ err: err?.message }, "enqueue failed (best-effort)"),
    );
  return alert;
}

/**
 * §2 RBAC: alert listing is role-aware. Managers/admins see the operational
 * inbox (all alerts, per the matrix "view … alerts"); a DRIVER sees only the
 * alerts on their own trips (SOS confirmations, geofence events on their
 * route) — object-level scoping done server-side, matching the trips listing.
 */
export async function listAlerts({ status, type, page = 1, pageSize = 50, user }) {
  const where = {};
  if (status) where.status = status;
  if (type) where.type = type; // Phase 12 (§7.2 item 1): filter chips (SOS / GEOFENCE_ENTER / …).
  if (user && user.role === "DRIVER") where.trip = { driverId: user.id };
  const [items, total] = await prisma.$transaction([
    prisma.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // Phase 12 (§7.2 item 1): the inbox shows who raised/triaged each alert.
      include: {
        raisedBy: { select: { id: true, name: true, role: true } },
        acknowledgedBy: { select: { id: true, name: true, role: true } },
        resolvedBy: { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.alert.count({ where }),
  ]);
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize) };
}

/**
 * Phase 12 (§6.2 target Alert shape): triage transitions stamp WHO did it and
 * WHEN, so the dashboard inbox and the audit view agree on accountability.
 * Re-acknowledging is a no-op (first actor wins); resolving always stamps the
 * resolver. Status fan-out behavior (alert_updated WS event) is unchanged.
 */
export async function updateAlertStatus(id, status, actor) {
  const existing = await prisma.alert.findUnique({ where: { id } });
  if (!existing) {
    throw Object.assign(new Error("Alert not found"), { status: 404, publicMessage: "Alert not found" });
  }
  const data = { status };
  if (status === "ACKNOWLEDGED" && !existing.acknowledgedAt) {
    data.acknowledgedAt = new Date();
    data.acknowledgedById = actor?.id ?? null;
  }
  if (status === "RESOLVED") {
    data.resolvedAt = new Date();
    data.resolvedById = actor?.id ?? null;
    // Auto-acknowledge semantics: resolving implies it was seen. Only sets
    // these when never acknowledged, so the original ack actor is preserved.
    if (!existing.acknowledgedAt) {
      data.acknowledgedAt = data.resolvedAt;
      data.acknowledgedById = actor?.id ?? null;
    }
  }
  const alert = await prisma.alert.update({ where: { id }, data });
  // Phase 12 (§11.5): alert status changes are audit-worthy — the audit view
  // must show who triaged what and when. Fire-and-forget safe (record() never
  // throws), like every other audit call.
  await audit.record({
    actorId: actor?.id ?? null,
    action: status === "ACKNOWLEDGED" ? "ALERT_ACKNOWLEDGED" : "ALERT_RESOLVED",
    target: `alert:${id}`,
    detail: `alert ${status} by ${actor?.email ?? "system"}`,
  });
  // Phase 6: all connected managers see triage state converge (§4.3).
  publishFleetEvent({
    type: "alert_updated",
    payload: alert,
    topics: await alertTopics(alert),
  });
  return alert;
}
