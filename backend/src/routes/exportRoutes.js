import { Router } from "express";
import { requireAuthDb, requireRole } from "../middleware/auth.js";
import { validate, exportRequestSchema, exportJobParamsSchema } from "../middleware/validate.js";
import { HttpError } from "../middleware/errorHandler.js";
import { prisma } from "../prisma.js";
import { exportsQueue } from "../jobs/queues.js";
import { readArtifact } from "../services/exportService.js";
import * as audit from "../services/auditService.js";
import { getContextLogger } from "../lib/logger.js";

/**
 * Phase 12 (blueprint §4.2/§7.2 item 3/§6.2): async CSV exports.
 *
 * `POST /` enqueues an `exports` BullMQ job and returns 202 with the job row —
 * generation never runs on the request path (§4.1: "the REST layer stays
 * thin"; §4.4 decouples slow work). The dashboard polls `GET /:jobId` until
 * DONE and then follows `resultUrl` (the download route below). Mounted at
 * BOTH `/api/reports` (§4.2's path) and `/api/exports` (§6.2's table name) —
 * same router, same contract, so either client spelling works.
 *
 * Enqueue is fire-and-forget (same pattern as geofence-eval/notifications):
 * a Redis/queue outage must not fail the request — the job row stays PENDING
 * and can be retried/re-requested.
 */

const router = Router();

/** Enqueue an export (ADMIN or FLEET_MANAGER — the dashboard's export UI). */
async function createExport(req, res, next) {
  try {
    const job = await prisma.exportJob.create({
      data: {
        requestedBy: req.user.id,
        type: req.validated.body.type,
        params: req.validated.body.params ?? {},
      },
    });
    await audit.record({
      actorId: req.user.id,
      action: "EXPORT_REQUESTED",
      target: `export:${job.id}`,
      detail: `${job.type} requested via dashboard`,
    });
    exportsQueue
      .add("generate", { exportJobId: job.id }, { removeOnComplete: 100, removeOnFail: 100 })
      .catch((err) =>
        getContextLogger({ module: "exports" }).warn({ err: err?.message }, "enqueue failed (job stays PENDING)"),
      );
    res.status(202).json({ job });
  } catch (err) {
    next(err);
  }
}

router.post("/", requireAuthDb, requireRole("ADMIN", "FLEET_MANAGER"), validate(exportRequestSchema), createExport);

/** Poll one job (§7.2 item 3: "download link appears when ready, polled"). */
router.get(
  "/:jobId",
  requireAuthDb,
  requireRole("ADMIN", "FLEET_MANAGER"),
  validate(exportJobParamsSchema),
  async (req, res, next) => {
    try {
      const job = await prisma.exportJob.findUnique({ where: { id: req.validated.params.jobId } });
      if (!job) throw new HttpError(404, "Export job not found");
      res.json({ job });
    } catch (err) {
      next(err);
    }
  },
);

/** List the caller's recent jobs (dashboard export history panel). */
router.get("/", requireAuthDb, requireRole("ADMIN", "FLEET_MANAGER"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const [items, total] = await prisma.$transaction([
      prisma.exportJob.findMany({
        where: { requestedBy: req.user.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.exportJob.count({ where: { requestedBy: req.user.id } }),
    ]);
    res.json({ items, page, pageSize, total, pages: Math.ceil(total / pageSize) });
  } catch (err) {
    next(err);
  }
});

/** Download the generated artifact (dev: local file; prod: S3 presigned URL
 *  served by the storage seam in exportService.deliver — see that file). */
router.get(
  "/:jobId/download",
  requireAuthDb,
  requireRole("ADMIN", "FLEET_MANAGER"),
  validate(exportJobParamsSchema),
  async (req, res, next) => {
    try {
      const job = await prisma.exportJob.findUnique({ where: { id: req.validated.params.jobId } });
      if (!job) throw new HttpError(404, "Export job not found");
      if (job.status !== "DONE") throw new HttpError(409, `Export job is ${job.status}, not DONE`);
      let csv;
      try {
        csv = await readArtifact(job.id);
      } catch {
        // e.g. backend restarted and the temp artifact dir was cleared, or prod
        // storage retention expired the object — explicit, not a silent 404.
        throw new HttpError(410, "Export artifact no longer available — re-run the export");
      }
      const filename = `fleetflow-${job.type.toLowerCase()}-${job.id}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
