import { stringify } from "csv-stringify/sync";
import { tmpdir } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "../config.js";
import { prisma } from "../prisma.js";
import { record } from "./auditService.js";

/**
 * Phase 12 (blueprint §4.2/§7.2 item 3/§6.2): async CSV export.
 *
 * Contract: the REST path (`POST /api/trips/export` or `POST /api/reports`,
 * same router) only enqueues an `exports` BullMQ job and returns 202 `{job}`;
 * the exports worker runs `runExportJob` here, which generates the CSV and
 * marks the job DONE with a download URL. The dashboard polls
 * `GET /api/reports/:jobId` until status DONE, then downloads `resultUrl`
 * (§7.2 item 3: "download link appears when ready, polled").
 *
 * Storage seam (§13.2): `deliver()` is where an S3-compatible upload +
 * presigned GET URL lands in production. In dev/demo it writes a local file
 * under the OS temp dir and returns a backend download path
 * (`GET /api/reports/:jobId/download`) — the same stub-for-provider-until-
 * configured approach documented for FCM/SMS (Phase 7). Server restarts clear
 * the temp dir, so completed artifacts are best-effort: DONE jobs keep their
 * row, but a download after a restart fails with an explicit 410 (not a
 * silent 404).
 */

// Phase 12 §13.2 storage seam: local file by default; the containerized stack
// points EXPORT_ARTIFACT_DIR at a shared volume so the API can read artifacts
// the worker wrote (separate container filesystems otherwise).
const EXPORTS_DIR = config.exportArtifactDir || path.join(tmpdir(), "fleetflow-exports");

/** Columns per export type (§6.2 ExportJobType enum). */
const CSV_COLUMNS = {
  TRIPS_CSV: [
    { id: "trip_id" },
    { id: "driver_id" },
    { id: "driver_name" },
    { id: "vehicle_plate" },
    { id: "status" },
    { id: "started_at" },
    { id: "finished_at" },
    { id: "distance_km" },
    { id: "avg_speed_kmh" },
    { id: "max_speed_kmh" },
    { id: "duration_seconds" },
    { id: "ping_count" },
  ],
  ALERTS_CSV: [
    { id: "alert_id" },
    { id: "type" },
    { id: "status" },
    { id: "trip_id" },
    { id: "lat" },
    { id: "lng" },
    { id: "detail" },
    { id: "created_at" },
    { id: "acknowledged_at" },
    { id: "resolved_at" },
  ],
  GEOFENCE_HISTORY: [
    { id: "event_id" },
    { id: "geofence_id" },
    { id: "geofence_name" },
    { id: "event_type" },
    { id: "vehicle_id" },
    { id: "trip_id" },
    { id: "occurred_at" },
  ],
};

const isoOrNull = (d) => (d ? new Date(d).toISOString() : "");

/** CSV-injection guard + null/undefined → empty string. A manager-exported CSV
 *  is re-opened elsewhere, so a leading = + - @ must not be read as a formula
 *  (blueprint §7.3 export robustness). Applies to free-text/extracted cells. */
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

/** Fetch the trip rows for a TRIPS_CSV export. params: { status?, from?, to? }
 *  (zod-validated upstream in exportRequestSchema); from/to bound startedAt. */
async function tripRows(params = {}) {
  const where = {};
  if (params.status) where.status = params.status;
  if (params.from || params.to) {
    where.startedAt = {};
    if (params.from) where.startedAt.gte = new Date(params.from);
    if (params.to) where.startedAt.lte = new Date(params.to);
  }
  const trips = await prisma.trip.findMany({
    where,
    include: {
      driver: { select: { name: true } },
      vehicle: { select: { plate: true } },
      _count: { select: { pings: true } },
    },
    orderBy: { startedAt: "desc" },
  });
  return trips.map((t) => ({
    trip_id: t.id,
    driver_id: t.driverId,
    driver_name: csvCell(t.driver?.name ?? ""),
    vehicle_plate: csvCell(t.vehicle?.plate ?? ""),
    status: t.status,
    started_at: isoOrNull(t.startedAt),
    finished_at: isoOrNull(t.finishedAt),
    distance_km: t.distanceKmh ?? "",
    avg_speed_kmh: t.avgSpeedKmh ?? "",
    max_speed_kmh: t.maxSpeedKmh ?? "",
    duration_seconds: t.durationSeconds ?? "",
    ping_count: t._count?.pings ?? 0,
  }));
}

async function alertRows(params = {}) {
  const where = {};
  if (params.status) where.status = params.status;
  const alerts = await prisma.alert.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return alerts.map((a) => ({
    alert_id: a.id,
    type: a.type,
    status: a.status,
    trip_id: a.tripId ?? "",
    lat: a.lat,
    lng: a.lng,
    detail: csvCell(a.detail),
    created_at: isoOrNull(a.createdAt),
    acknowledged_at: isoOrNull(a.acknowledgedAt),
    resolved_at: isoOrNull(a.resolvedAt),
  }));
}

async function geofenceHistoryRows(params = {}) {
  const where = {};
  if (params.geofenceId) where.geofenceId = params.geofenceId;
  const events = await prisma.geofenceEvent.findMany({
    where,
    include: { geofence: { select: { name: true } } },
    orderBy: { occurredAt: "desc" },
  });
  return events.map((e) => ({
    event_id: e.id,
    geofence_id: e.geofenceId,
    geofence_name: csvCell(e.geofence?.name ?? ""),
    event_type: e.eventType,
    vehicle_id: e.vehicleId,
    trip_id: e.tripId ?? "",
    occurred_at: isoOrNull(e.occurredAt),
  }));
}

/** Local artifact path for a job (download route reads it back). */
export function exportArtifactPath(jobId) {
  return path.join(EXPORTS_DIR, `export-${jobId}.csv`);
}

/** Storage seam (§13.2): write the artifact and return the result URL. In
 *  production this becomes an S3-compatible upload returning a presigned GET
 *  URL — no other code changes. */
async function deliver(jobId, csv) {
  await mkdir(EXPORTS_DIR, { recursive: true });
  await writeFile(exportArtifactPath(jobId), csv, "utf8");
  return `/api/reports/${jobId}/download`;
}

/** Read a DONE job's artifact back (used by the download route). */
export async function readArtifact(jobId) {
  return readFile(exportArtifactPath(jobId), "utf8");
}

/** Generate the CSV payload for one job. Exported for unit tests. */
export async function generateCsv(type, params = {}) {
  const rowsFor = {
    TRIPS_CSV: tripRows,
    ALERTS_CSV: alertRows,
    GEOFENCE_HISTORY: geofenceHistoryRows,
  };
  const rows = await rowsFor[type](params);
  // csv-stringify v6 sync: `columns` gives the ordered header (key/header per
  // column), `header: true` emits it as the first record. Returns the full CSV
  // text (header + rows).
  const cols = CSV_COLUMNS[type].map((c) => ({ key: c.id, header: c.id }));
  return stringify(rows, { columns: cols, header: true });
}

/**
 * Worker entry: run one export job (§4.4 reports job). Marks status
 * PENDING → RUNNING → DONE/FAILED; every transition is observable in the
 * dashboard's poll. Already-DONE jobs are no-ops (BullMQ retries are safe).
 */
export async function runExportJob({ exportJobId }) {
  const job = await prisma.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job) throw new Error(`ExportJob ${exportJobId} not found`);
  if (job.status === "DONE") return job;
  await prisma.exportJob.update({ where: { id: job.id }, data: { status: "RUNNING" } });
  try {
    const csv = await generateCsv(job.type, job.params ?? {});
    const resultUrl = await deliver(job.id, csv);
    const done = await prisma.exportJob.update({
      where: { id: job.id },
      data: { status: "DONE", resultUrl, completedAt: new Date() },
    });
    await record({
      actorId: null,
      action: "EXPORT_COMPLETED",
      target: `export:${job.id}`,
      detail: `${job.type} generated`,
    });
    return done;
  } catch (err) {
    await prisma.exportJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: String(err?.message ?? err).slice(0, 500), completedAt: new Date() },
    });
    await record({
      actorId: null,
      action: "EXPORT_FAILED",
      target: `export:${job.id}`,
      detail: String(err?.message ?? err).slice(0, 200),
    });
    throw err;
  }
}

/** Test/artifact hygiene helper. */
export async function removeArtifact(jobId) {
  await rm(exportArtifactPath(jobId), { force: true });
}
