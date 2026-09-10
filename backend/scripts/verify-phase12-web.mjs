/**
 * Phase 12 live E2E check (run against a REAL stack: API + worker + Postgres +
 * Redis). Verifies every web-dashboard screen's primary workflow end to end:
 *
 *  1. Alerts (§7.2 item 1): driver raises SOS → manager sees it → manager
 *     acknowledges → acknowledgedBy/At stamped → ALERT_ACKNOWLEDGED audit row
 *  2. Trips + CSV export (§7.2 items 2–3): POST /api/reports (202 PENDING) →
 *     worker completes it → poll until DONE → download the CSV artifact
 *  3. Vehicles (§7.2 item 4): create → assign default driver + maintenance
 *     note → soft-delete → gone from the listing
 *  4. Geofences (§7.2 item 5): create via the same contract the map tool uses
 *     → edit (radius) → soft-OFF via DELETE → history/events preserved, listing
 *     excludes it
 *  5. Users (§7.2 item 6, ADMIN): directory lists with status → deactivate
 *     (login blocked, sessions revoked) → reactivate → role change (audited)
 *     → last-admin protected (409)
 *  6. Audit (§7.2 item 7): action/actor/free-text filters return matching rows
 *  7. RBAC fences: driver cannot triage alerts (403); manager cannot mutate
 *     users (403)
 *
 * Usage: node scripts/verify-phase12-web.mjs   (API + worker on :3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { rm } from "node:fs/promises";
import { exportArtifactPath } from "../src/services/exportService.js";

const prisma = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "P12-web-check!";
let failures = 0;

function check(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jfetch(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 / non-JSON */
  }
  return { status: res.status, json };
}

const webHeaders = () => ({ "X-Client": "web" });
const auth = (token) => ({ Authorization: `Bearer ${token}`, ...webHeaders() });

/** Poll GET /api/reports/:id until it leaves PENDING/RUNNING (worker-backed). */
async function waitForExport(token, id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await jfetch(`/api/reports/${id}`, { headers: auth(token) });
    if (res.status === 200 && res.json?.job?.status !== "PENDING" && res.json?.job?.status !== "RUNNING") {
      return res.json.job;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  // Fixture hygiene: a previously interrupted/crashed run can leave its p12-*
  // users behind; a stale leftover ADMIN would skew the last-admin check below
  // (the directory would list TWO admins and the demote of a leftover would
  // legitimately succeed with 200). Purge stale fixtures first — FK-safe order.
  const stale = await prisma.user.findMany({ where: { email: { startsWith: "p12-" } }, select: { id: true } });
  if (stale.length) {
    const ids = stale.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.exportJob.deleteMany({ where: { requestedBy: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    console.log(`purged ${ids.length} stale p12-* fixture user(s) from an earlier run`);
  }

  const suffix = crypto.randomBytes(3).toString("hex");
  const adminEmail = `p12-admin-${suffix}@fleetflow.test`;
  const mgrEmail = `p12-mgr-${suffix}@fleetflow.test`;
  const drvEmail = `p12-drv-${suffix}@fleetflow.test`;
  const hash = await bcrypt.hash(PASS, 4);

  const admin = await prisma.user.create({
    data: { email: adminEmail, name: "P12 Admin", role: "ADMIN", passwordHash: hash },
  });
  const manager = await prisma.user.create({
    data: { email: mgrEmail, name: "P12 Manager", role: "FLEET_MANAGER", passwordHash: hash },
  });
  const driver = await prisma.user.create({
    data: { email: drvEmail, name: "P12 Driver", role: "DRIVER", passwordHash: hash },
  });

  let vehicle;
  let trip;
  let alertId = null;
  let fenceId = null;
  let exportJobId = null;
  try {
    // ---- Logins ----
    const adminLogin = await jfetch("/api/auth/login", {
      method: "POST",
      headers: webHeaders(),
      body: { email: adminEmail, password: PASS },
    });
    const mgrLogin = await jfetch("/api/auth/login", {
      method: "POST",
      headers: webHeaders(),
      body: { email: mgrEmail, password: PASS },
    });
    const drvLogin = await jfetch("/api/auth/login", { method: "POST", body: { email: drvEmail, password: PASS } });
    check(
      "admin/manager/driver logins succeed",
      adminLogin.status === 200 && mgrLogin.status === 200 && drvLogin.status === 200,
    );
    const adminToken = adminLogin.json.accessToken;
    const mgrToken = mgrLogin.json.accessToken;
    const drvToken = drvLogin.json.accessToken;

    // ---- 1. Alerts: SOS → visible → acknowledged with actor metadata (§7.2 item 1) ----
    console.log("\n[1] Alerts inbox — SOS → triage");
    vehicle = await prisma.vehicle.create({ data: { plate: `P12-${suffix.toUpperCase()}`, model: "eProbe" } });
    trip = await prisma.trip.create({
      data: { driverId: driver.id, vehicleId: vehicle.id, status: "ACTIVE", startedAt: new Date() },
    });
    const sos = await jfetch("/api/alerts", {
      method: "POST",
      headers: auth(drvToken),
      body: { tripId: trip.id, type: "SOS", lat: 12.9716, lng: 77.5946, detail: "=cmd|'/c calc'!A0" },
    });
    alertId = sos.json?.id ?? null;
    check("driver raises SOS (201)", sos.status === 201 && sos.json?.raisedById === driver.id, `status=${sos.status}`);

    const inbox = await jfetch("/api/alerts?status=OPEN", { headers: auth(mgrToken) });
    const mine = inbox.json?.items?.find((a) => a.id === alertId);
    check("manager sees the OPEN alert with raisedBy", !!mine && mine.raisedBy?.id === driver.id);
    check(
      "driver cannot triage (403)",
      (
        await jfetch(`/api/alerts/${alertId}`, {
          method: "PATCH",
          headers: auth(drvToken),
          body: { status: "ACKNOWLEDGED" },
        })
      ).status === 403,
    );

    const ack = await jfetch(`/api/alerts/${alertId}`, {
      method: "PATCH",
      headers: auth(mgrToken),
      body: { status: "ACKNOWLEDGED" },
    });
    check(
      "manager acknowledges (actor+timestamp stamped)",
      ack.status === 200 && ack.json?.acknowledgedById === manager.id && !!ack.json?.acknowledgedAt,
      `status=${ack.status}`,
    );
    const auditAck = await jfetch("/api/audit-logs?action=ALERT_ACKNOWLEDGED", { headers: auth(adminToken) });
    check(
      "ALERT_ACKNOWLEDGED audit row exists",
      auditAck.status === 200 && auditAck.json?.items?.some((e) => e.target === `alert:${alertId}`),
      `status=${auditAck.status}`,
    );

    // ---- 2. Trips + CSV export: enqueue → worker DONE → download (§7.2 items 2–3) ----
    console.log("\n[2] Trips — async CSV export + download");
    // Give the trip a ping set so the export has distance/ping columns populated.
    await prisma.locationPing.createMany({
      data: [0, 1, 2].map((i) => ({
        tripId: trip.id,
        idempotencyKey: `p12v-${trip.id}-${i}`,
        lat: 12.97 + i * 0.001,
        lng: 77.59 + i * 0.001,
        speedKmh: 40 + i,
        recordedAt: new Date(Date.now() + i * 1000),
      })),
    });
    const created = await jfetch("/api/reports", {
      method: "POST",
      headers: auth(adminToken),
      body: { type: "TRIPS_CSV", params: {} },
    });
    exportJobId = created.json?.job?.id ?? null;
    check(
      "export enqueued (202 PENDING)",
      created.status === 202 && created.json?.job?.status === "PENDING",
      `status=${created.status}`,
    );
    const done = await waitForExport(adminToken, exportJobId);
    check(
      "worker completes the export (DONE)",
      !!done && done.status === "DONE",
      `status=${done?.status ?? "timeout"}`,
    );
    if (done?.resultUrl) {
      // The artifact is CSV text, not JSON — read it as text (jfetch would parse JSON).
      const dl = await fetch(BASE + done.resultUrl, { headers: auth(adminToken) });
      const csv = await dl.text();
      check(
        "CSV downloads with header + our trip row",
        dl.status === 200 && csv.includes("trip_id") && csv.includes(String(trip.id)),
        `status=${dl.status}`,
      );
    }
    const recent = await jfetch("/api/reports", { headers: auth(adminToken) });
    check(
      "recent exports list shows the job",
      recent.status === 200 && recent.json?.items?.some((j) => j.id === exportJobId),
    );

    // ---- 3. Vehicles: assign driver, maintenance note, soft-delete (§7.2 item 4) ----
    console.log("\n[3] Vehicles — assign / maintain / soft-delete");
    const createdV = await jfetch("/api/vehicles", {
      method: "POST",
      headers: auth(adminToken),
      body: { plate: `P12B-${suffix.toUpperCase()}`, model: "Tata Nexon" },
    });
    const vid = createdV.json?.id ?? null;
    check("vehicle created (201)", createdV.status === 201, `status=${createdV.status}`);
    const patchedV = await jfetch(`/api/vehicles/${vid}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { defaultDriverId: driver.id, maintenanceNote: "Oil change due", status: "ACTIVE" },
    });
    check(
      "PATCH sets defaultDriver + maintenanceNote",
      patchedV.status === 200 &&
        patchedV.json?.defaultDriver?.id === driver.id &&
        patchedV.json?.maintenanceNote === "Oil change due",
      `status=${patchedV.status}`,
    );
    const vList = await jfetch("/api/vehicles", { headers: auth(adminToken) });
    check(
      "listing shows the default driver",
      vList.status === 200 && vList.json?.items?.some((v) => v.id === vid && v.defaultDriver?.id === driver.id),
    );
    const delV = await jfetch(`/api/vehicles/${vid}`, { method: "DELETE", headers: auth(adminToken) });
    check("soft-delete returns 204", delV.status === 204, `status=${delV.status}`);
    const vList2 = await jfetch("/api/vehicles", { headers: auth(adminToken) });
    check("soft-deleted vehicle gone from listing", !vList2.json?.items?.some((v) => v.id === vid));

    // ---- 4. Geofences: create via the map-tool contract, edit, soft-OFF (§7.2 item 5) ----
    console.log("\n[4] Geofences — author / edit / soft-OFF (history kept)");
    const fence = await jfetch("/api/geofences", {
      method: "POST",
      headers: auth(adminToken),
      body: { name: "P12 Yard", centerLat: 12.9716, centerLng: 77.5946, radiusM: 120, alertOnEnter: true },
    });
    fenceId = fence.json?.id ?? null;
    check("fence created (201)", fence.status === 201, `status=${fence.status}`);
    await prisma.geofenceEvent.create({
      data: { geofenceId: fenceId, vehicleId: vehicle.id, tripId: trip.id, eventType: "ENTER", occurredAt: new Date() },
    });
    const editF = await jfetch(`/api/geofences/${fenceId}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { radiusM: 250, alertOnExit: true },
    });
    check(
      "PATCH edits radius + flags",
      editF.status === 200 && editF.json?.radiusM === 250 && editF.json?.alertOnExit === true,
      `status=${editF.status}`,
    );
    const delF = await jfetch(`/api/geofences/${fenceId}`, { method: "DELETE", headers: auth(adminToken) });
    check("DELETE soft-OFFs (204)", delF.status === 204, `status=${delF.status}`);
    const fList = await jfetch("/api/geofences", { headers: auth(adminToken) });
    check("fence gone from the active listing", !fList.json?.items?.some((g) => g.id === fenceId));
    const kept = await prisma.geofence.findUnique({ where: { id: fenceId } });
    check(
      "row kept (active=false) + history preserved",
      !!kept && kept.active === false && (await prisma.geofenceEvent.count({ where: { geofenceId: fenceId } })) === 1,
    );

    // ---- 4b. Per-fence history (§4.2/§7.2 item 5 compliance trail) ----
    console.log("\n[4b] Geofence history — enter/exit trail endpoint");
    const hist = await jfetch(`/api/geofences/${fenceId}/history`, { headers: auth(mgrToken) });
    check(
      "history returns the soft-OFF fence + its crossing with vehicle/trip context",
      hist.status === 200 &&
        hist.json?.fence?.active === false &&
        hist.json?.total === 1 &&
        hist.json?.items?.[0]?.eventType === "ENTER" &&
        hist.json?.items?.[0]?.vehicle?.id === vehicle.id &&
        hist.json?.items?.[0]?.trip?.id === trip.id,
      `status=${hist.status}`,
    );
    const histDriver = await jfetch(`/api/geofences/${fenceId}/history`, { headers: auth(drvToken) });
    check("history is a fleet-ops view — drivers get 403", histDriver.status === 403, `status=${histDriver.status}`);

    // ---- 5. Users: deactivate → login blocked → reactivate → role change (§7.2 item 6) ----
    console.log("\n[5] Users (ADMIN) — deactivate / reactivate / role change");
    const directory = await jfetch("/api/users-admin", { headers: auth(adminToken) });
    const drvRow = directory.json?.items?.find((u) => u.email === drvEmail);
    check("directory lists the driver as ACTIVE", !!drvRow && drvRow.status === "ACTIVE");
    check(
      "manager can read but not mutate",
      (
        await jfetch(`/api/users-admin/${drvRow.id}`, {
          method: "PATCH",
          headers: auth(mgrToken),
          body: { name: "Nope" },
        })
      ).status === 403,
    );

    const deact = await jfetch(`/api/users-admin/${drvRow.id}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { deactivated: true },
    });
    check(
      "deactivate succeeds (DEACTIVATED)",
      deact.status === 200 && deact.json?.status === "DEACTIVATED",
      `status=${deact.status}`,
    );
    const blocked = await jfetch("/api/auth/login", { method: "POST", body: { email: drvEmail, password: PASS } });
    check("deactivated driver login blocked (401)", blocked.status === 401, `status=${blocked.status}`);
    const react = await jfetch(`/api/users-admin/${drvRow.id}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { deactivated: false },
    });
    check(
      "reactivate restores the SAME account",
      react.status === 200 && react.json?.status === "ACTIVE" && react.json?.role === "DRIVER",
      `status=${react.status}`,
    );

    const role = await jfetch(`/api/users-admin/${drvRow.id}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { role: "FLEET_MANAGER" },
    });
    check("role change succeeds", role.status === 200 && role.json?.role === "FLEET_MANAGER", `status=${role.status}`);
    const roleAudit = await jfetch("/api/audit-logs?action=USER_ROLE_CHANGED", { headers: auth(adminToken) });
    check(
      "USER_ROLE_CHANGED audited with before/after",
      roleAudit.status === 200 &&
        roleAudit.json?.items?.some(
          (e) => e.target === `user:${drvRow.id}` && String(e.detail).includes("DRIVER -> FLEET_MANAGER"),
        ),
    );

    // Last-admin guard is COUNT-based. This script runs against a REAL stack
    // whose DB may legitimately hold other ADMINs (e.g. the dev seed's
    // admin@fleetflow.dev). Branch on that fact instead of assuming an
    // empty directory — the deterministic 409-on-last-admin case is covered
    // by tests/rbac.test.js against an isolated database.
    const otherAdmins = await prisma.user.count({ where: { role: "ADMIN", id: { not: admin.id } } });
    const demote = await jfetch(`/api/users-admin/${admin.id}`, {
      method: "PATCH",
      headers: auth(adminToken),
      body: { role: "FLEET_MANAGER" },
    });
    if (otherAdmins === 0) {
      check("last admin protected from demotion (409)", demote.status === 409, `status=${demote.status}`);
    } else {
      check(
        `demote allowed while ${otherAdmins} other admin(s) exist (count-based guard; deterministic 409 covered by rbac.test.js)`,
        demote.status === 200,
        `status=${demote.status}`,
      );
      // The demotion must take effect immediately, so this token is no longer
      // authorized to restore itself through the ADMIN endpoint. Restore the
      // disposable fixture directly (the script already owns its DB setup and
      // cleanup), then keep using the same signed token to prove fresh DB-role
      // authorization sees ADMIN again during the audit-filter checks below.
      const restored = await prisma.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });
      check("fixture role restored to ADMIN", restored.role === "ADMIN");
    }

    // ---- 6. Audit log filters (§7.2 item 7) ----
    console.log("\n[6] Audit — filters");
    const byQ = await jfetch("/api/audit-logs?q=alert:", { headers: auth(adminToken) });
    check(
      "free-text filter q=alert: returns matching rows",
      byQ.status === 200 && byQ.json?.items?.length > 0 && byQ.json?.items?.every((e) => e.target.includes("alert:")),
      `status=${byQ.status}`,
    );
    const byActor = await jfetch(`/api/audit-logs?actorId=${admin.id}`, { headers: auth(adminToken) });
    check(
      "actor filter returns that actor's rows only",
      byActor.status === 200 && byActor.json?.items?.every((e) => e.actorId === admin.id),
    );
    const forbidden = await jfetch("/api/audit-logs", { headers: auth(mgrToken) });
    check("audit log is ADMIN-only (403)", forbidden.status === 403, `status=${forbidden.status}`);

    console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  } finally {
    // Best-effort cleanup (FK-safe order), mirroring backend tests.
    try {
      if (exportJobId) await rm(exportArtifactPath(exportJobId), { force: true });
      if (alertId) await prisma.alert.deleteMany({ where: { id: alertId } });
      if (fenceId) await prisma.geofenceEvent.deleteMany({ where: { geofenceId: fenceId } });
      await prisma.geofence.deleteMany({ where: { name: "P12 Yard" } });
      if (trip) {
        await prisma.locationPing.deleteMany({ where: { tripId: trip.id } });
        await prisma.trip.deleteMany({ where: { id: trip.id } });
      }
      if (vehicle) {
        await prisma.fleetLastPosition.deleteMany({ where: { vehicleId: vehicle.id } });
        await prisma.vehicle.deleteMany({ where: { id: vehicle.id } });
      }
      await prisma.vehicle.deleteMany({ where: { plate: { startsWith: "P12B-" } } });
      await prisma.exportJob.deleteMany({ where: { requestedBy: admin.id } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: [admin.id, manager.id, driver.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, manager.id, driver.id] } } });
    } catch (e) {
      console.log("cleanup warning:", e.message);
    }
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
