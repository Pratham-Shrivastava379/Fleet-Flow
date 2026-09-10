import { Router } from "express";
import * as vehicleService from "../services/vehicleService.js";
import { listVehicles, listVehiclesForDriver } from "../services/vehicleService.js";
import { validate, vehicleSchema, vehicleUpdateSchema } from "../middleware/validate.js";
import { requireAuthDb, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuthDb);

// Role-aware read (§2 RBAC): managers/admins see the whole (non-deleted)
// fleet; drivers get only the vehicles usable for the driver workflow —
// available for a new trip plus the one currently assigned to them. Enforcement
// is server-side here; the app's list is UX on top of this contract.
router.get("/", async (req, res, next) => {
  try {
    if (req.user.role === "DRIVER") {
      res.json({ items: await listVehiclesForDriver(req.user.id) });
    } else {
      res.json({ items: await listVehicles() });
    }
  } catch (e) {
    next(e);
  }
});

router.post("/", requireRole("ADMIN", "FLEET_MANAGER"), validate(vehicleSchema), async (req, res, next) => {
  try {
    res.status(201).json(await vehicleService.createVehicle(req.body));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireRole("ADMIN", "FLEET_MANAGER"), validate(vehicleUpdateSchema), async (req, res, next) => {
  try {
    res.json(await vehicleService.updateVehicle(Number(req.params.id), req.body));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireRole("ADMIN", "FLEET_MANAGER"), async (req, res, next) => {
  try {
    await vehicleService.deleteVehicle(Number(req.params.id));
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
