import { Router } from "express";
import * as alertService from "../services/alertService.js";
import { validate, alertCreateSchema, alertUpdateSchema } from "../middleware/validate.js";
import { requireAuthDb, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuthDb);

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const status = ["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(req.query.status) ? req.query.status : undefined;
    // Phase 12 (§7.2 item 1): type filter chips.
    const type = ["SOS", "HARSH_BRAKING", "OVERSPEED", "GEOFENCE_ENTER", "GEOFENCE_EXIT", "CRASH_DETECTED"].includes(
      req.query.type,
    )
      ? req.query.type
      : undefined;
    // §2 RBAC: pass the caller so the service scopes a DRIVER's listing to
    // their own trips (managers/admins get the full operational inbox).
    res.json(await alertService.listAlerts({ status, type, page, pageSize, user: req.user }));
  } catch (e) {
    next(e);
  }
});

// Any authenticated user can raise an alert (drivers raise SOS from the app).
router.post("/", validate(alertCreateSchema), async (req, res, next) => {
  try {
    res.status(201).json(await alertService.createAlert(req.user, req.body));
  } catch (e) {
    next(e);
  }
});

// Only managers/admins triage alerts (actor stamped for §6.2 triage metadata).
// requireAuthDb loads the fresh user row so triage metadata (acknowledgedBy/
// resolvedBy, §6.2) is stamped correctly even if the caller's role changed
// mid-access-token-lifetime.
router.patch(
  "/:id",
  requireAuthDb,
  requireRole("ADMIN", "FLEET_MANAGER"),
  validate(alertUpdateSchema),
  async (req, res, next) => {
    try {
      res.json(await alertService.updateAlertStatus(Number(req.params.id), req.body.status, req.userDb));
    } catch (e) {
      next(e);
    }
  },
);

export default router;
