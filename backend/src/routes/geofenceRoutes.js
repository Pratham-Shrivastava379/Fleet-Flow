import { Router } from "express";
import * as geofenceService from "../services/geofenceService.js";
import {
  validate,
  geofenceSchema,
  geofenceCheckSchema,
  geofenceUpdateSchema,
  geofenceParamsSchema,
  geofenceHistorySchema,
} from "../middleware/validate.js";
import { requireAuthDb, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuthDb);

router.get("/", async (req, res, next) => {
  try {
    res.json({ items: await geofenceService.listGeofences() });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireRole("ADMIN", "FLEET_MANAGER"), validate(geofenceSchema), async (req, res, next) => {
  try {
    res.status(201).json(await geofenceService.createGeofence(req.body));
  } catch (e) {
    next(e);
  }
});

// Phase 12 (§7.2 item 5): authoring also means editing/toggling existing
// fences from the dashboard (e.g. disabling one while keeping its history).
// Same whitelist as create: the service layer rejects unknown columns.
router.patch("/:id", requireRole("ADMIN", "FLEET_MANAGER"), validate(geofenceUpdateSchema), async (req, res, next) => {
  try {
    res.json(await geofenceService.updateGeofence(Number(req.params.id), req.body));
  } catch (e) {
    next(e);
  }
});

// "Delete" is a soft OFF: fences are historical trigger surfaces for
// GeofenceEvents (§7.2 item 5 keeps history), so the row stays and `active`
// flips false — it disappears from listings and from future ping evaluation.
router.delete("/:id", requireRole("ADMIN", "FLEET_MANAGER"), validate(geofenceParamsSchema), async (req, res, next) => {
  try {
    await geofenceService.deleteGeofence(Number(req.params.id));
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// GET /api/geofences/:id/history: the compliance
// trail for one fence — which vehicles entered/exited, when, on which trip.
// Fleet-operations surface only (drivers keep the read-only active-fence list
// for on-device awareness, never the audit trail). Works for soft-OFF'd fences
// so history survives a "delete" (§6.3) — a deactivated fence keeps its data.
router.get(
  "/:id/history",
  requireRole("ADMIN", "FLEET_MANAGER"),
  validate(geofenceHistorySchema),
  async (req, res, next) => {
    try {
      res.json(await geofenceService.listGeofenceHistory(Number(req.params.id), req.validated?.query ?? req.query));
    } catch (e) {
      next(e);
    }
  },
);

router.post("/check", validate(geofenceCheckSchema), async (req, res, next) => {
  try {
    res.json({ results: await geofenceService.checkGeofences(req.body.lat, req.body.lng) });
  } catch (e) {
    next(e);
  }
});

export default router;
