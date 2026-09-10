import { Router } from "express";
import * as tripService from "../services/tripService.js";
import { validate, tripStartSchema, pingSchema, pingBatchSchema, tripQuerySchema } from "../middleware/validate.js";
import { requireAuthDb } from "../middleware/auth.js";
import { HttpError } from "../middleware/errorHandler.js";
// Phase 12: /api/trips/export alias target (§15.12/§4.2 async export jobs).
import exportRoutes from "./exportRoutes.js";

const router = Router();
router.use(requireAuthDb);

router.get("/", validate(tripQuerySchema), async (req, res, next) => {
  try {
    res.json(await tripService.listTrips(req.user, req.query));
  } catch (e) {
    next(e);
  }
});

// Phase 12 (§15.12): §4.2 spells the export endpoint /api/trips/export while
// the ExportJob router lives at /api/reports + /api/exports. Mounted with
// `use` (NOT as a route handler): a use-mount strips the "/export" prefix so
// the sub-router sees "/" — POST creates a job, GET lists the caller's jobs —
// while keeping the sub-router's own role checks + validation. (Passing the
// router to router.get/post would leave "/export" on req.url, the sub-router
// would match nothing and every request would 404.)
// MUST stay registered BEFORE GET /:tripId (Express matches in order, and
// "export" would otherwise be parsed as a tripId).
router.use("/export", exportRoutes);

router.post("/", validate(tripStartSchema), async (req, res, next) => {
  try {
    // Driver-flow prevention: trip creation is a
    // driver action. FLEET_MANAGER/ADMIN accounts reach this module legitimately
    // (fleet list + trip detail), so the gate lives on the mutating route, not
    // the router — 403 mirrors the RBAC convention used by /users-admin. The
    // fresh DB role decides, not the (possibly stale) JWT claim.
    if (req.userDb?.role !== "DRIVER") throw new HttpError(403, "Only drivers can start trips");
    res.status(201).json(await tripService.startTrip(req.user.id, req.body.vehicleId));
  } catch (e) {
    next(e);
  }
});

router.get("/:tripId", async (req, res, next) => {
  try {
    const tripId = Number(req.params.tripId);
    if (!Number.isInteger(tripId) || tripId <= 0) throw new HttpError(422, "Invalid tripId");
    res.json(await tripService.getTrip(req.user, tripId));
  } catch (e) {
    next(e);
  }
});

router.get("/:tripId/stats", async (req, res, next) => {
  try {
    const tripId = Number(req.params.tripId);
    if (!Number.isInteger(tripId) || tripId <= 0) throw new HttpError(422, "Invalid tripId");
    res.json(await tripService.getTripStats(req.user, tripId));
  } catch (e) {
    next(e);
  }
});

router.post("/:tripId/pings", validate(pingSchema), async (req, res, next) => {
  try {
    const { idempotencyKey, lat, lng, speedKmh, headingDeg, accuracyM, recordedAt } = req.body;
    const result = await tripService.addPing(req.user, Number(req.params.tripId), {
      idempotencyKey,
      lat,
      lng,
      speedKmh,
      headingDeg,
      accuracyM,
      recordedAt,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) {
    next(e);
  }
});

// Phase 10 (blueprint §3.6/§4.2): batch offline sync — up to MAX_PING_BATCH
// pings per call, per-item idempotency, one geofence-eval job + one
// location_batch WS event for the whole request.
router.post("/:tripId/pings/batch", validate(pingBatchSchema), async (req, res, next) => {
  try {
    const result = await tripService.addPingBatch(req.user, Number(req.params.tripId), req.body.pings);
    res.status(result.status).json({
      accepted: result.accepted,
      duplicates: result.duplicates,
      failed: result.failed,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/:tripId/finish", async (req, res, next) => {
  try {
    const tripId = Number(req.params.tripId);
    if (!Number.isInteger(tripId) || tripId <= 0) throw new HttpError(422, "Invalid tripId");
    res.json(await tripService.finishTrip(req.user, tripId));
  } catch (e) {
    next(e);
  }
});

export default router;
